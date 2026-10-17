import { describe, expect, test } from "bun:test"
import { parseState } from "../src/app/persist"
import { parsePreviewScenario, type PreviewScenario } from "../src/host/fakeConnections"
import { createFakeHost } from "../src/host/fakeHost"
import { parseQuests } from "../src/app/quests"
import { officeQuestFile, officeScripts, officeState, type OfficeRole, type OfficeScript } from "../src/host/fakeOffice"
import type { StreamFrame } from "../src/host/types"
import { AgentEventSchema, LiveFrameSchema, type AgentEvent } from "../src/protocol/schemas"

/**
 * `?preview=office`: its seed loads through the parser saved state goes through, every scripted
 * thread is in it, and a scripted turn plays its role on the preview engine. Without `office`, the
 * preview runs as before.
 */

const ID = /^[A-Za-z0-9._-]+$/
const OFFICE = parsePreviewScenario("office")
const STRESS = parsePreviewScenario("office,stress")

function scriptFor(role: OfficeRole): readonly [string, OfficeScript] {
  const entry = [...officeScripts(OFFICE)].find(([, script]) => script.role === role)
  if (entry === undefined) throw new Error(`the office has no ${role} thread`)
  return entry
}

/** Starts a thread's engine on a new preview host and keeps every frame it streams. */
async function engineFor(scenario: PreviewScenario, threadId: string) {
  const host = createFakeHost(scenario)
  const frames: StreamFrame[] = []
  host.onBatch((_engineId, batch) => frames.push(...batch))
  const engineId = `e-${threadId}`
  const start = async (): Promise<void> => {
    await host.engineStart({ engineId, workspace: "/Users/preview/code/office", backend: "claude-code", sessionId: threadId })
    await host.streamStart(engineId, -1, 0)
  }
  await start()
  return { host, frames, engineId, start }
}

function events(frames: readonly StreamFrame[]): AgentEvent[] {
  return frames.flatMap((frame) => {
    if (frame.kind !== "event") return []
    const parsed = AgentEventSchema.safeParse(frame.data)
    return parsed.success ? [parsed.data] : []
  })
}

function last(frames: readonly StreamFrame[]): AgentEvent | undefined {
  const seen = events(frames)
  return seen[seen.length - 1]
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(done()).toBe(true)
}

describe("the office preview's setup", () => {
  test("is picked with office, and stress counts only alongside it", () => {
    expect(OFFICE).toEqual({ office: true })
    expect(STRESS).toEqual({ office: true, stress: true })
    expect(parsePreviewScenario(" Stress, OFFICE ,long")).toEqual({ long: true, office: true, stress: true })
    expect(officeScripts(parsePreviewScenario("stress")).size).toBe(0)
    expect(officeScripts(parsePreviewScenario("mixed,long")).size).toBe(0)
  })

  test("the office seed loads whole, with the idle thread open and the tray's prefs on", () => {
    const seed = officeState(OFFICE)
    const state = parseState(seed)
    expect(state.projects.map((project) => project.name)).toEqual(["runrail", "nifra", "mobile-app", "website"])
    expect(state.projects).toEqual(seed.projects)
    expect(state.threads).toHaveLength(12)
    // The seed is plain data; parseState is what types it.
    expect<unknown>(state.threads).toEqual(seed.threads)
    expect(state.prefs).toMatchObject({ sounds: true, notifications: true, quietMinutes: 2 })
    const open = state.threads.find((thread) => thread.id === state.layout.activeThreadId)
    expect(open).toMatchObject({ lastStatus: "completed" })
    expect(open?.unread).toBeUndefined()
    expect(officeScripts(OFFICE).has(open?.id ?? "")).toBe(false)
  })

  test("the stress seed loads forty threads in six projects, twelve scripted to keep working", () => {
    const state = parseState(officeState(STRESS))
    expect(state.projects).toHaveLength(6)
    expect(state.threads).toHaveLength(40)
    expect(state.layout.activeThreadId).toBeUndefined()
    const scripts = officeScripts(STRESS)
    expect(scripts.size).toBe(12)
    for (const script of scripts.values()) {
      expect(script.role).toBe("work")
      if (script.role === "work") expect(Math.abs(script.durationMs - 30 * 60_000)).toBeLessThanOrEqual(2 * 60_000)
    }
    const resting = state.threads.filter((thread) => !scripts.has(thread.id)).map((thread) => `${thread.lastStatus ?? "none"}${thread.unread === true ? " unread" : ""}`)
    expect(new Set(resting)).toEqual(new Set(["completed", "failed unread", "completed unread", "stopped", "idle"]))
  })

  test("every scripted thread is in its seed, in a project that exists, and every id is one the app keeps", () => {
    for (const scenario of [OFFICE, STRESS]) {
      const seed = officeState(scenario)
      const projects = new Set(seed.projects.map((project) => project.id))
      for (const [threadId, script] of officeScripts(scenario)) {
        const thread = seed.threads.find((item) => item.id === threadId)
        expect(thread).toBeDefined()
        expect(projects.has(thread?.projectId ?? "")).toBe(true)
        expect(script.prompt.length).toBeGreaterThan(20)
      }
      for (const item of [...seed.projects, ...seed.threads]) expect(item.id).toMatch(ID)
    }
  })

  test("the office has three approvals in three projects, a failure, a quiet run, two workers, and a delegator", () => {
    const seed = officeState(OFFICE)
    const scripts = [...officeScripts(OFFICE)]
    expect(scripts.map(([, script]) => script.role).sort()).toEqual(["approval", "approval", "approval", "delegate", "fail", "quiet", "work", "work"])
    const approvals = scripts.filter(([, script]) => script.role === "approval")
    expect(new Set(approvals.map(([threadId]) => seed.threads.find((thread) => thread.id === threadId)?.projectId)).size).toBe(3)
    const sendTimes = approvals.map(([, script]) => script.startAfterMs)
    expect(sendTimes).toEqual([...sendTimes].sort((a, b) => a - b))
    expect(Math.max(...sendTimes)).toBeLessThan(60_000)
    const workMs = scripts.flatMap(([, script]) => (script.role === "work" ? [script.durationMs] : [])).sort((a, b) => a - b)
    expect(workMs).toEqual([3 * 60_000, 20 * 60_000])
  })

  test("the office host loads its seed every time and keeps saves off the usual preview's storage", async () => {
    const writes: string[] = []
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null, setItem: (key: string) => void writes.push(key) }, configurable: true, writable: true })
    try {
      const host = createFakeHost(OFFICE)
      expect(parseState(await host.stateLoad()).threads).toHaveLength(12)
      await host.stateSave({ version: 1, projects: [], threads: [], prefs: {}, layout: {} })
      expect(parseState(await host.stateLoad()).threads).toHaveLength(12)
      expect(writes).toEqual([])
      await createFakeHost({}).stateSave({ version: 1 })
      expect(writes).toEqual(["runrail.preview.state"])
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage")
    }
  })
})

describe("a scripted turn on the preview engine", () => {
  test("a fail thread's first turn fails on its test run; later turns, and a restarted engine's, run as usual", async () => {
    const [threadId, script] = scriptFor("fail")
    const { host, frames, engineId, start } = await engineFor(OFFICE, threadId)
    await host.rpc(engineId, "turn.enqueue", { message: script.prompt })
    const turn = events(frames)
    expect(turn.find((event) => event.type === "tool.completed" && !event.ok)).toMatchObject({ name: "run_command", error: { code: "TOOL_FAILED" } })
    expect(last(frames)).toMatchObject({ type: "session.failed", error: { code: "TURN_FAILED", message: "bun test exited with status 1" } })
    expect(turn.some((event) => event.type === "session.completed")).toBe(false)
    // Every frame the script sent is one the timeline takes.
    for (const frame of frames) expect((frame.kind === "event" ? AgentEventSchema : LiveFrameSchema).safeParse(frame.data).success).toBe(true)

    await host.rpc(engineId, "turn.enqueue", { message: "hello" })
    expect(last(frames)?.type).toBe("session.completed")

    await host.engineStop(engineId)
    await start()
    const before = frames.length
    await host.rpc(engineId, "turn.enqueue", { message: "hello" })
    expect(events(frames.slice(before)).some((event) => event.type === "session.failed")).toBe(false)
    expect(last(frames)?.type).toBe("session.completed")
  }, 15_000)

  test("a quiet thread starts its command, then sends nothing until it is stopped", async () => {
    const [threadId, script] = scriptFor("quiet")
    const { host, frames, engineId } = await engineFor(OFFICE, threadId)
    const turn = host.rpc(engineId, "turn.enqueue", { message: script.prompt })
    await until(() => events(frames).some((event) => event.type === "tool.started"))
    expect(events(frames).find((event) => event.type === "tool.started")).toMatchObject({ name: "run_command", presentation: { kind: "shell", command: "bun run e2e" } })
    const heard = frames.length
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(frames.length).toBe(heard)
    await host.rpc(engineId, "turn.cancel", { reason: "user" })
    await turn
    expect(last(frames)?.type).toBe("session.stopped")
  }, 10_000)

  test("without office, the same thread runs the usual flow", async () => {
    const [threadId] = scriptFor("fail")
    const { host, frames, engineId } = await engineFor({}, threadId)
    await host.rpc(engineId, "turn.enqueue", { message: "hello" })
    expect(events(frames).some((event) => event.type === "session.failed")).toBe(false)
    expect(last(frames)?.type).toBe("session.completed")
  })
})

test("the open project's quest file is one the strict parser takes, and other projects have none", () => {
  const state = officeState({ office: true })
  const open = state.projects.find((project) => project.id === state.layout.activeProjectId)
  const result = parseQuests(officeQuestFile(open?.path ?? "") ?? "")
  expect(result.ok && result.season.quests.map((quest) => quest.counts)).toEqual(["diff-reviewed", "request-answered", "pr-opened"])
  for (const project of state.projects.filter((other) => other !== open)) expect(officeQuestFile(project.path)).toBeUndefined()
})
