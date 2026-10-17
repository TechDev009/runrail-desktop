import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged, listConnections } from "../src/app/connections"
import { engineIdFor, ensureEngine, launchSelection, send, setModel, setSelection, stopEngine } from "../src/app/engines"
import { defaultState, type Prefs, type ThreadMeta } from "../src/app/persist"
import { addProject, createThread, draftSelection, get, patchRuntime, patchThread, runtimeOf, set, setPrefs, sitsOnDefault, startingModel, startSelection, threadById } from "../src/app/store"
import { applyWinner, continueInNewThread, groupThreads, startBestOf, threadHasHistory } from "../src/app/workflows"
import { setHost, type EngineStartInput } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { PreviewScenario } from "../src/host/fakeConnections"

/**
 * What a thread is bound to - a model through a connection, or a coding tool - from the moment it
 * is created to the moment it sends. The host is the in-memory preview host; a turn is recorded
 * where it would be sent and never runs.
 */

const PROJECT = "p1"
let starts: EngineStartInput[]
let turns: string[]
/** How many engines had started when each turn was sent. */
let turnAfter: number[]

function use(scenario: PreviewScenario = {}): void {
  const host = createFakeHost(scenario)
  // Each host keeps its own lists, so a late call from an earlier test cannot land in a later one.
  const started: EngineStartInput[] = []
  const enqueued: string[] = []
  const after: number[] = []
  starts = started
  turns = enqueued
  turnAfter = after
  setHost({
    ...host,
    engineStart: (input) => {
      started.push(input)
      return host.engineStart(input)
    },
    rpc: async (engineId, method, params) => {
      if (method !== "turn.enqueue") return host.rpc(engineId, method, params)
      enqueued.push(engineId)
      after.push(started.length)
      return {}
    },
  })
}

beforeEach(() => {
  use()
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
})

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

function threadStarts(thread: ThreadMeta): EngineStartInput[] {
  return starts.filter((input) => input.engineId === engineIdFor(thread.id))
}

function sent(thread: ThreadMeta): { state?: string; errorCode?: string } | undefined {
  const item = runtimeOf(thread.id).timeline.items.find((entry) => entry.kind === "user")
  return item as { state?: string; errorCode?: string } | undefined
}

async function settled(thread: ThreadMeta): Promise<void> {
  await until(() => sent(thread)?.state === "failed" || turns.includes(engineIdFor(thread.id)))
}

function prefs(patch: Partial<Prefs>): Prefs {
  return { ...get().prefs, ...patch }
}

describe("what a new thread starts on", () => {
  test("the default model when there is one, else the last model used", () => {
    expect(startingModel(prefs({}))).toBeUndefined()
    const recentModels = [
      { model: "gpt-5.5", connectionId: "openai" },
      { model: "claude-opus-5-5", connectionId: "anthropic" },
    ]
    expect(startingModel(prefs({ recentModels }))).toEqual({ model: "gpt-5.5", connectionId: "openai" })
    expect(startingModel(prefs({ recentModels, defaultModel: "claude-haiku-4-5", defaultConnectionId: "anthropic" }))).toEqual({ model: "claude-haiku-4-5", connectionId: "anthropic" })
    // A default model with no connection is not a default.
    expect(startingModel(prefs({ recentModels, defaultModel: "claude-haiku-4-5" }))).toEqual({ model: "gpt-5.5", connectionId: "openai" })
  })

  test("a coding tool, when that is the default", () => {
    expect(startSelection(prefs({ defaultBackend: "codex", defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toEqual({ backend: "codex" })
    // The tool's own model, when one was picked; a connected model is never handed to a tool.
    expect(startSelection(prefs({ defaultBackend: "claude-code", defaultToolModel: "opus", defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toEqual({ backend: "claude-code", model: "opus" })
    expect(startSelection(prefs({ defaultBackend: "pi", defaultToolModel: "radius/auto" }))).toEqual({ backend: "pi", model: "radius/auto" })
    expect(startSelection(prefs({ defaultBackend: "copilot" }))).toEqual({ backend: "copilot" })
    expect(startSelection(prefs({ defaultToolModel: "opus", defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toEqual({ backend: "native", model: "gpt-5.5", connectionId: "openai" })
    expect(startSelection(prefs({ defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toEqual({ backend: "native", model: "gpt-5.5", connectionId: "openai" })
    expect(startSelection(prefs({}))).toEqual({ backend: "native" })
  })

  test("never a recorded session", () => {
    expect(startSelection(prefs({ defaultBackend: "replay", defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toEqual({ backend: "native", model: "gpt-5.5", connectionId: "openai" })
  })
})

describe("the new-thread draft", () => {
  const recentModels = [{ model: "gpt-5.5", connectionId: "openai" }]

  test("opens on the default model, the last model used, or the default coding tool", () => {
    expect(draftSelection(prefs({ defaultModel: "claude-haiku-4-5", defaultConnectionId: "anthropic", recentModels }))).toEqual({ backend: "native", model: "claude-haiku-4-5", connectionId: "anthropic" })
    expect(draftSelection(prefs({ recentModels }))).toEqual({ backend: "native", model: "gpt-5.5", connectionId: "openai" })
    expect(draftSelection(prefs({}))).toEqual({ backend: "native" })
    expect(draftSelection(prefs({ defaultBackend: "codex", defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toEqual({ backend: "codex" })
    expect(draftSelection(prefs({ defaultBackend: "codex", defaultToolModel: "codex-large" }))).toEqual({ backend: "codex", model: "codex-large" })
  })

  test("keeps a recorded session when developer mode made it the default", () => {
    expect(draftSelection(prefs({ defaultBackend: "replay", recentModels }))).toEqual({ backend: "replay" })
  })

  test("sits on the default only when it names the same thing", () => {
    const model = prefs({ defaultModel: "gpt-5.5", defaultConnectionId: "openai" })
    expect(sitsOnDefault({ backend: "native", model: "gpt-5.5", connectionId: "openai" }, model)).toBe(true)
    expect(sitsOnDefault({ backend: "native", model: "gpt-5.5-mini", connectionId: "openai" }, model)).toBe(false)
    expect(sitsOnDefault({ backend: "native", model: "gpt-5.5", connectionId: "relay" }, model)).toBe(false)
    expect(sitsOnDefault({ backend: "codex" }, model)).toBe(false)
    expect(sitsOnDefault({ backend: "codex" }, prefs({ defaultBackend: "codex", defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))).toBe(true)
    const tool = prefs({ defaultBackend: "claude-code", defaultToolModel: "opus" })
    expect(sitsOnDefault({ backend: "claude-code", model: "opus" }, tool)).toBe(true)
    expect(sitsOnDefault({ backend: "claude-code", model: "sonnet" }, tool)).toBe(false)
    expect(sitsOnDefault({ backend: "claude-code" }, tool)).toBe(false)
    expect(sitsOnDefault({ backend: "pi" }, prefs({ defaultBackend: "pi" }))).toBe(true)
    expect(sitsOnDefault({ backend: "pi" }, prefs({ defaultBackend: "pi", defaultToolModel: "radius/auto" }))).toBe(false)
  })

  test("the scripted model picked by hand is not replaced by the last model used", () => {
    // Picking it clears the default model, and the draft then holds no model either: nothing to follow.
    expect(sitsOnDefault({ backend: "native" }, prefs({ recentModels }))).toBe(true)
    // A default model cleared from under a draft that still names one is followed.
    expect(sitsOnDefault({ backend: "native", model: "gpt-5.5", connectionId: "openai" }, prefs({ recentModels: [] }))).toBe(false)
  })
})

describe("creating a thread", () => {
  beforeEach(() => setPrefs({ defaultModel: "gpt-5.5", defaultConnectionId: "openai" }))

  test("a caller that names nothing gets the default model", () => {
    expect(createThread({ projectId: PROJECT })).toMatchObject({ backend: "native", model: "gpt-5.5", connectionId: "openai" })
  })

  test("a caller that names what it runs on is taken at its word", () => {
    const unbound = createThread({ projectId: PROJECT, backend: "native" })
    expect(unbound.model).toBeUndefined()
    expect(unbound.connectionId).toBeUndefined()
    expect(createThread({ projectId: PROJECT, backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })).toMatchObject({ model: "claude-opus-5-5", connectionId: "anthropic" })
  })

  test("a coding tool thread keeps the tool's own model and the tool connection it runs as", () => {
    const tool = createThread({ projectId: PROJECT, backend: "claude-code", model: "opus", connectionId: "claude-code-2" })
    expect(tool).toMatchObject({ backend: "claude-code", model: "opus", connectionId: "claude-code-2" })
    expect(createThread({ projectId: PROJECT, backend: "claude-code", model: "opus" }).connectionId).toBeUndefined()
    expect(createThread({ projectId: PROJECT, backend: "codex" }).model).toBeUndefined()
    // Pi and Copilot take a model too; a recorded session takes none.
    expect(createThread({ projectId: PROJECT, backend: "pi", model: "radius/auto" }).model).toBe("radius/auto")
    expect(createThread({ projectId: PROJECT, backend: "copilot", model: "gpt-typed" }).model).toBe("gpt-typed")
    expect(createThread({ projectId: PROJECT, backend: "replay", model: "anything" }).model).toBeUndefined()
    setPrefs({ defaultBackend: "pi" })
    const byDefault = createThread({ projectId: PROJECT })
    expect(byDefault.backend).toBe("pi")
    expect(byDefault.model).toBeUndefined()
  })

  test("a default coding tool starts on the model picked for it, never on a connected model", () => {
    setPrefs({ defaultBackend: "codex" })
    const plain = createThread({ projectId: PROJECT })
    expect(plain.backend).toBe("codex")
    expect(plain.model).toBeUndefined()
    setPrefs({ defaultBackend: "claude-code", defaultToolModel: "sonnet" })
    const picked = createThread({ projectId: PROJECT })
    expect(picked).toMatchObject({ backend: "claude-code", model: "sonnet" })
    expect(picked.connectionId).toBeUndefined()
  })

  test("the engine is launched with a model only together with its connection, or for a coding tool that takes one", () => {
    expect(launchSelection({ backend: "native", model: "gpt-5.5", connectionId: "openai" })).toEqual({ model: "gpt-5.5", connectionId: "openai" })
    expect(launchSelection({ backend: "native", model: "gpt-5.5" })).toEqual({})
    expect(launchSelection({ backend: "codex", model: "codex-large" })).toEqual({ model: "codex-large" })
    // On a coding tool the connection is the tool connection it runs as, and goes to the engine as one.
    expect(launchSelection({ backend: "codex", model: "codex-large", connectionId: "codex-1" })).toEqual({ model: "codex-large", toolConnectionId: "codex-1" })
    expect(launchSelection({ backend: "claude-code", connectionId: "claude-code-2" })).toEqual({ toolConnectionId: "claude-code-2" })
    expect(launchSelection({ backend: "claude-code" })).toEqual({})
    expect(launchSelection({ backend: "pi", model: "radius/auto", connectionId: "pi-1" })).toEqual({ model: "radius/auto", toolConnectionId: "pi-1" })
    expect(launchSelection({ backend: "copilot", model: "gpt-typed" })).toEqual({ model: "gpt-typed" })
    expect(launchSelection({ backend: "replay", model: "anything" })).toEqual({})
  })
})

describe("changing what a thread runs on", () => {
  test("another model stays in the thread", () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai" })
    setModel(thread.id, { model: "claude-opus-5-5", connectionId: "anthropic" }, "high")
    expect(threadById(thread.id)).toMatchObject({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic", thinking: "high" })
    expect(runtimeOf(thread.id).timeline.items).toContainEqual(expect.objectContaining({ kind: "notice", code: "model.changed", message: "Switched from GPT-5.5 via Runrail to Opus 5.5 via Runrail." }))
    // No engine was running, so none was started for the change.
    expect(threadStarts(thread)).toEqual([])
  })

  test("a running engine restarts on the new model in the same session", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    setModel(thread.id, { model: "gpt-5.5-mini", connectionId: "openai" })
    await until(() => threadStarts(thread).length === 2 && runtimeOf(thread.id).engine === "ready")
    expect(threadStarts(thread).map((input) => [input.sessionId, input.model, input.connectionId])).toEqual([
      [thread.id, "gpt-5.5", "openai"],
      [thread.id, "gpt-5.5-mini", "openai"],
    ])
    await stopEngine(thread.id)
  })

  test("a message sent while the engine restarts for a new level goes to the new engine", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai", thinking: "medium" })
    const first = await ensureEngine(thread.id)
    setModel(thread.id, undefined, "low")
    setModel(thread.id, undefined, "high")
    send(thread.id, { text: "right away" })
    await until(() => turns.length === 1 && runtimeOf(thread.id).engine === "ready")
    // Two quick changes before the new engine starts: it starts once, on the last one, and the message waits for it.
    expect(threadStarts(thread).map((input) => input.thinking)).toEqual(["medium", "high"])
    expect([turns, turnAfter]).toEqual([[first], [2]])
    expect(sent(thread)?.errorCode).toBeUndefined()

    // A change once the new engine is starting gets one more restart, so the engine runs on it.
    setModel(thread.id, undefined, "low")
    await until(() => runtimeOf(thread.id).engine === "starting")
    setModel(thread.id, undefined, "minimal")
    await until(() => threadStarts(thread).length === 4 && runtimeOf(thread.id).engine === "ready")
    expect(threadStarts(thread).map((input) => input.thinking)).toEqual(["medium", "high", "low", "minimal"])
    await stopEngine(thread.id)
  })

  test("an empty thread moves to a coding tool in place, and back", () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai" })
    setSelection(thread.id, { backend: "codex" })
    const moved = threadById(thread.id)
    expect(moved?.backend).toBe("codex")
    expect(moved?.model).toBeUndefined()
    expect(moved?.connectionId).toBeUndefined()
    setSelection(thread.id, { backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    expect(threadById(thread.id)).toMatchObject({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    // To a coding tool's model: the model goes along, the connection does not.
    setSelection(thread.id, { backend: "claude-code", model: "opus" })
    expect(threadById(thread.id)).toMatchObject({ backend: "claude-code", model: "opus" })
    expect(threadById(thread.id)?.connectionId).toBeUndefined()
    setSelection(thread.id, { backend: "pi" })
    expect(threadById(thread.id)).toMatchObject({ backend: "pi" })
    expect(threadById(thread.id)?.model).toBeUndefined()
  })

  test("a coding tool thread changes model in place: the engine restarts in the same session", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "claude-code", model: "opus", thinking: "high" })
    await ensureEngine(thread.id)
    setModel(thread.id, { model: "sonnet" })
    await until(() => threadStarts(thread).length === 2 && runtimeOf(thread.id).engine === "ready")
    setModel(thread.id, { model: undefined })
    await until(() => threadStarts(thread).length === 3 && runtimeOf(thread.id).engine === "ready")
    expect(threadStarts(thread).map((input) => [input.backend, input.sessionId, input.model, input.connectionId, input.thinking])).toEqual([
      ["claude-code", thread.id, "opus", undefined, "high"],
      ["claude-code", thread.id, "sonnet", undefined, "high"],
      ["claude-code", thread.id, undefined, undefined, "high"],
    ])
    await stopEngine(thread.id)
  })

  test("a thread has history once something was said, queued, or imported", () => {
    const fresh = createThread({ projectId: PROJECT, backend: "native" })
    expect(threadHasHistory(fresh.id)).toBe(false)
    expect(threadHasHistory("no-such-thread")).toBe(false)
    patchRuntime(fresh.id, { queue: [{ id: "q1", text: "later", attachments: [] }] })
    expect(threadHasHistory(fresh.id)).toBe(true)
    const ran = createThread({ projectId: PROJECT, backend: "native" })
    patchThread(ran.id, { lastStatus: "completed" })
    expect(threadHasHistory(ran.id)).toBe(true)
    const imported = createThread({ projectId: PROJECT, backend: "native", importedFrom: { source: "codex", id: "s1" } })
    expect(threadHasHistory(imported.id)).toBe(true)
  })
})

describe("continuing in a new thread", () => {
  test("keeps the folder, mode, permissions, and reasoning, and moves the unsent message", () => {
    setPrefs({ defaultModel: "gpt-5.5", defaultConnectionId: "openai" })
    const worktree = { id: "wt1", path: "/w/wt1", cwd: "/w/wt1", branch: "runrail/wt1" }
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai", thinking: "high", mode: "plan", permission: "auto-edit", title: "Fix the login form", worktree })
    set({ drafts: { [thread.id]: "and then the tests", other: "untouched" } })

    const next = continueInNewThread(thread.id, { backend: "claude-code" })
    expect(next).toMatchObject({ projectId: PROJECT, backend: "claude-code", thinking: "high", mode: "plan", permission: "auto-edit", title: "Fix the login form (continued)", titled: true, worktree, parentThreadId: thread.id })
    expect(next?.model).toBeUndefined()
    expect(get().drafts).toEqual({ other: "untouched", [next?.id ?? ""]: "and then the tests" })
    expect(get().layout.activeThreadId).toBe(next?.id)
    // The thread left behind is as it was.
    expect(threadById(thread.id)).toMatchObject({ backend: "native", model: "gpt-5.5", connectionId: "openai", title: "Fix the login form" })
  })

  test("from a coding tool to a model binds the model", () => {
    const thread = createThread({ projectId: PROJECT, backend: "codex", title: "Spike" })
    expect(continueInNewThread(thread.id, { backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })).toMatchObject({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
  })

  test("to a coding tool's model takes the model and the tool connection, never the old thread's", () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai", title: "Spike" })
    const next = continueInNewThread(thread.id, { backend: "codex", model: "codex-large", connectionId: "codex-1" })
    expect(next).toMatchObject({ backend: "codex", model: "codex-large", connectionId: "codex-1" })
    expect(continueInNewThread(thread.id, { backend: "codex", model: "codex-large" })?.connectionId).toBeUndefined()
  })

  test("the title says continued once, and stays within its limit", () => {
    const first = createThread({ projectId: PROJECT, backend: "native", title: "Spike" })
    const second = continueInNewThread(first.id, { backend: "codex" })
    const third = continueInNewThread(second?.id ?? "", { backend: "pi" })
    expect(third?.title).toBe("Spike (continued)")
    const long = createThread({ projectId: PROJECT, backend: "native", title: "x".repeat(256) })
    const cut = continueInNewThread(long.id, { backend: "codex" })
    expect(cut?.title).toHaveLength(256)
    expect(cut?.title.endsWith(" (continued)")).toBe(true)
  })

  test("the new thread's engine continues the earlier thread, and the thread says where it moved", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai", title: "Spike" })
    await ensureEngine(thread.id)
    const next = continueInNewThread(thread.id, { backend: "claude-code" })!
    await ensureEngine(next.id)
    expect(threadStarts(next)[0]?.continueFrom).toBe(thread.id)
    // A thread that continues nothing names nothing.
    expect(threadStarts(thread)[0]?.continueFrom).toBeUndefined()
    expect(runtimeOf(next.id).timeline.items.some((item) => item.kind === "notice" && item.code === "session.continued")).toBe(true)
    await stopEngine(next.id)
    await stopEngine(thread.id)
  })

  test("a thread that is gone continues nowhere", () => {
    expect(continueInNewThread("no-such-thread", { backend: "codex" })).toBeUndefined()
    expect(get().threads).toEqual([])
  })
})

describe("sending", () => {
  test("a thread with no model is refused before anything starts", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native" })
    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(sent(thread)).toMatchObject({ state: "failed", errorCode: "MODEL_NOT_SET" })
    expect(runtimeOf(thread.id).lastError).toBe("Pick a model to send")
    expect(threadStarts(thread)).toEqual([])
    expect(turns).toEqual([])
  })

  test("developer mode sends with no model, on the scripted test model", async () => {
    setPrefs({ developer: true })
    const thread = createThread({ projectId: PROJECT, backend: "native" })
    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(turns).toEqual([engineIdFor(thread.id)])
    expect(threadStarts(thread)).toHaveLength(1)
    expect(threadStarts(thread)[0]?.model).toBeUndefined()
    expect(threadStarts(thread)[0]?.connectionId).toBeUndefined()
    await stopEngine(thread.id)
  })

  test("a model on a ready connection starts the engine on that model", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai" })
    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(turns).toEqual([engineIdFor(thread.id)])
    expect(threadStarts(thread)).toMatchObject([{ backend: "native", model: "gpt-5.5", connectionId: "openai", sessionId: thread.id }])
    await stopEngine(thread.id)
  })

  test("a coding tool starts with no model and no connection", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "claude-code" })
    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(turns).toEqual([engineIdFor(thread.id)])
    expect(threadStarts(thread)).toHaveLength(1)
    expect(threadStarts(thread)[0]).toMatchObject({ backend: "claude-code" })
    expect(threadStarts(thread)[0]?.model).toBeUndefined()
    expect(threadStarts(thread)[0]?.connectionId).toBeUndefined()
    await stopEngine(thread.id)
  })

  test("a coding tool with a model picked starts on that model, with its reasoning level and no connection", async () => {
    // No connection is ready here at all: a coding tool signs in by itself.
    use({ seed: "empty" })
    connectionsChanged()
    await listConnections()
    const thread = createThread({ projectId: PROJECT, backend: "codex", model: "codex-large", thinking: "low" })
    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(turns).toEqual([engineIdFor(thread.id)])
    expect(threadStarts(thread)).toMatchObject([{ backend: "codex", model: "codex-large", thinking: "low", sessionId: thread.id, behavior: { effort: "low" } }])
    expect(threadStarts(thread)[0]?.connectionId).toBeUndefined()
    await stopEngine(thread.id)
  })

  test("a thread whose connection was removed still opens, and is refused when it sends", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "gone" })
    await ensureEngine(thread.id)
    expect(runtimeOf(thread.id).engine).toBe("ready")
    // The first start named the connection; the engine refused it; the second start named no model.
    expect(threadStarts(thread).map((input) => input.connectionId)).toEqual(["gone", undefined])
    expect(threadStarts(thread)[1]?.model).toBeUndefined()

    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(sent(thread)).toMatchObject({ state: "failed", errorCode: "CONNECTION_REMOVED" })
    expect(turns).toEqual([])
    await stopEngine(thread.id)
  })

  test("once the connections are read, a removed one is not asked for at all", async () => {
    await listConnections()
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "gone" })
    await ensureEngine(thread.id)
    expect(threadStarts(thread).map((input) => input.connectionId)).toEqual([undefined])
    await stopEngine(thread.id)
  })

  test("a connection that needs attention is refused with its own reason", async () => {
    use({ seed: "mixed" })
    await listConnections()
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "llama-4", connectionId: "groq" })
    send(thread.id, { text: "hello" })
    await settled(thread)
    expect(sent(thread)).toMatchObject({ state: "failed", errorCode: "CONNECTION_NOT_READY" })
    expect(turns).toEqual([])
    expect(threadStarts(thread)).toEqual([])
  })
})

describe("a best-of run", () => {
  test("each run gets exactly what it was given", async () => {
    setPrefs({ defaultModel: "gpt-5.5", defaultConnectionId: "openai" })
    const groupId = await startBestOf({
      projectId: PROJECT,
      prompt: "add a readme line",
      runs: [{ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" }, { backend: "claude-code" }, { backend: "native" }],
    })
    const runs = [...groupThreads(groupId)].sort((a, b) => a.title.localeCompare(b.title))
    expect(runs.map((run) => [run.title, run.backend, run.model, run.connectionId])).toEqual([
      ["add a readme line (1)", "native", "claude-opus-5-5", "anthropic"],
      ["add a readme line (2)", "claude-code", undefined, undefined],
      // A run given no model is not quietly put on the default one.
      ["add a readme line (3)", "native", undefined, undefined],
    ])
    expect(new Set(runs.map((run) => run.worktree?.id)).size).toBe(3)
    expect(get().view).toEqual({ kind: "compare", groupId })
    for (const run of runs) await settled(run)
    expect(sent(runs[2] as ThreadMeta)).toMatchObject({ state: "failed", errorCode: "MODEL_NOT_SET" })
    expect(turns.sort()).toEqual([engineIdFor((runs[0] as ThreadMeta).id), engineIdFor((runs[1] as ThreadMeta).id)].sort())

    // The run that goes in is marked on the thread itself, so the comparison remembers it.
    await applyWinner((runs[0] as ThreadMeta).id, false)
    expect(threadById((runs[0] as ThreadMeta).id)?.group?.appliedAt).toBeNumber()
    expect(threadById((runs[1] as ThreadMeta).id)?.group?.appliedAt).toBeUndefined()
    for (const run of runs) await stopEngine(run.id)
  })
})
