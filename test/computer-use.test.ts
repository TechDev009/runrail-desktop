import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { allowComputerApp, disallowComputerApp, initComputerActivity, loadComputerSetup, noteComputerFrames, takesComputer, useComputerActivity, useComputerSetup } from "../src/app/computerAgent"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, send, setComputerUse } from "../src/app/engines"
import { defaultState, parseState, type ThreadMeta } from "../src/app/persist"
import { addProject, createThread, get, set } from "../src/app/store"
import { setHost, toHostError, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { EngineStartInput, StreamFrame } from "../src/host/types"

/**
 * Computer use on the desktop: a request announced by the engine is claimed once,
 * checked against the thread's own switch, carried out by the host on an allowed app, and answered.
 */

setDefaultTimeout(20_000)

const PROJECT = "p1"
const ENGINE = "engine-1"

async function until(done: () => boolean, tries = 3_000): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

function reset(): void {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  useComputerSetup.setState({}, true)
  useComputerActivity.setState({}, true)
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
}

test("only Codex and Claude Code take the computer tools", () => {
  expect(takesComputer("codex")).toBe(true)
  expect(takesComputer("claude-code")).toBe(true)
  expect(takesComputer("native")).toBe(false)
  expect(takesComputer("opencode")).toBe(false)
})

test("a thread's computer switch is saved, and anything but on is dropped", () => {
  const project = { id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 }
  const thread = { id: "t1", projectId: PROJECT, title: "T", titled: true, createdAt: 1, updatedAt: 1, mode: "agent", permission: "ask", backend: "codex" }
  const saved = (computer: unknown): ThreadMeta | undefined => parseState({ ...defaultState(), projects: [project], threads: [{ ...thread, computer }] }).threads[0]
  expect(saved(true)?.computer).toBe(true)
  expect(saved(false)?.computer).toBeUndefined()
  expect(saved("yes")?.computer).toBeUndefined()
})

describe("requests from the engine", () => {
  let tasks: Map<string, Record<string, unknown>>
  let takes: string[]
  let acts: { action: string; params: Readonly<Record<string, unknown>> }[]
  let answers: { requestId: string; answer: { ok: boolean; code?: string; result?: { text: string } } }[]
  let counter = 0

  beforeEach(() => {
    const host = createFakeHost({ computer: "allowed" })
    tasks = new Map()
    takes = []
    acts = []
    answers = []
    const wrapped: Host = {
      ...host,
      rpc: async (engineId, method, params) => {
        const body = params as { requestId: string; answer?: never }
        if (method === "computer.take") {
          takes.push(body.requestId)
          const task = tasks.get(body.requestId)
          tasks.delete(body.requestId)
          if (task === undefined) throw new Error("COMPUTER_REQUEST_NOT_FOUND")
          return task
        }
        if (method === "computer.respond") {
          answers.push({ requestId: body.requestId, answer: body.answer as never })
          return { ok: true }
        }
        return host.rpc(engineId, method, params)
      },
      computerAct: async (action, params) => {
        acts.push({ action, params })
        return host.computerAct(action, params)
      },
    }
    setHost(wrapped)
    reset()
  })

  function request(action: string, params: Record<string, unknown> = {}): { frame: StreamFrame; requestId: string } {
    counter += 1
    const requestId = `cu-${counter.toString(16).padStart(32, "0")}`
    tasks.set(requestId, { requestId, action, params, expiresAt: Date.now() + 30_000 })
    return { requestId, frame: { kind: "live", data: { type: "computer.request", liveSeq: counter, requestId, action } } }
  }

  async function answered(count: number): Promise<void> {
    await until(() => answers.length >= count, 400)
    expect(answers).toHaveLength(count)
  }

  test("a request is claimed once, done by the host, and answered with what the app shows", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "codex" })
    setComputerUse(thread.id, true)
    const { frame, requestId } = request("click", { app: "Notes", x: 10, y: 20 })
    noteComputerFrames(thread.id, ENGINE, [frame, frame])
    noteComputerFrames(thread.id, ENGINE, [frame])
    await answered(1)
    expect(takes).toEqual([requestId])
    expect(acts).toEqual([{ action: "click", params: { app: "Notes", x: 10, y: 20 } }])
    expect(answers[0]).toMatchObject({ requestId, answer: { ok: true } })
    expect(answers[0]?.answer.result?.text).toContain("Clicked at 10, 20 in Notes")
    expect(useComputerActivity.getState()[thread.id]).toEqual({ app: "Notes", action: "click" })
  })

  test("a thread with computer use off is refused without touching the screen", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "codex" })
    const { frame, requestId } = request("screenshot", { app: "Notes" })
    noteComputerFrames(thread.id, ENGINE, [frame])
    await answered(1)
    expect(acts).toEqual([])
    expect(answers[0]).toMatchObject({ requestId, answer: { ok: false, code: "COMPUTER_OFF" } })
  })

  test("an app the person did not allow is refused by the host", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "claude-code" })
    setComputerUse(thread.id, true)
    const { frame } = request("type", { app: "Safari", text: "hello" })
    noteComputerFrames(thread.id, ENGINE, [frame])
    await answered(1)
    expect(answers[0]?.answer).toMatchObject({ ok: false, code: "COMPUTER_DENIED" })
  })

  test("a malformed or unknown frame is ignored", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "codex" })
    setComputerUse(thread.id, true)
    noteComputerFrames(thread.id, ENGINE, [
      { kind: "live", data: { type: "computer.request", liveSeq: 1, requestId: "cu-nothex", action: "click" } },
      { kind: "live", data: { type: "computer.request", liveSeq: 2, requestId: `cu-${"f".repeat(32)}`, action: "drag" } },
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(takes).toEqual([])
  })
})

describe("the apps agents may use", () => {
  beforeEach(() => {
    setHost(createFakeHost({}))
    reset()
  })

  test("are read with the system's access, added, and removed", async () => {
    await loadComputerSetup()
    expect(useComputerSetup.getState()).toEqual({ access: { supported: true, screen: true, accessibility: true }, allowed: [] })
    await allowComputerApp("com.apple.Notes")
    expect(useComputerSetup.getState().allowed).toEqual([{ bundleId: "com.apple.Notes", name: "Notes" }])
    await disallowComputerApp("com.apple.Notes")
    expect(useComputerSetup.getState().allowed).toEqual([])
  })

  test("a terminal is never allowed, and the list stays as it was", async () => {
    await loadComputerSetup()
    const refused = await allowComputerApp("com.apple.Terminal").catch((error: unknown) => toHostError(error))
    expect(refused).toMatchObject({ code: "COMPUTER_APP_REFUSED" })
    expect(useComputerSetup.getState().allowed).toEqual([])
  })
})

describe("a thread with computer use", () => {
  let stop: () => void = () => undefined
  let starts: EngineStartInput[] = []

  beforeEach(() => {
    stop()
    starts = []
    const host = createFakeHost({ computer: "allowed" })
    const start = host.engineStart.bind(host)
    host.engineStart = (input) => {
      starts.push(input)
      return start(input)
    }
    setHost(host)
    connectionsChanged()
    reset()
    const engines = initEngines()
    const activity = initComputerActivity()
    stop = () => {
      activity()
      engines()
    }
  })

  test("starts its engine with the tools only when the switch is on and the tool takes them", async () => {
    const off = createThread({ projectId: PROJECT, backend: "codex", model: "gpt-5.5" })
    await ensureEngine(off.id)
    expect(starts.at(-1)?.computerTools).toBeUndefined()
    const native = createThread({ projectId: PROJECT, backend: "native", model: "gpt-5.5", connectionId: "openai" })
    setComputerUse(native.id, true)
    await ensureEngine(native.id)
    expect(starts.at(-1)?.computerTools).toBeUndefined()
    const on = createThread({ projectId: PROJECT, backend: "codex", model: "gpt-5.5" })
    setComputerUse(on.id, true)
    await ensureEngine(on.id)
    expect(starts.at(-1)?.computerTools).toBe(true)
  })

  test("uses an allowed app in a turn, and the strip clears when the turn ends", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "codex", model: "gpt-5.5", permission: "full" })
    setComputerUse(thread.id, true)
    await ensureEngine(thread.id)
    send(thread.id, { text: "add groceries to notes" })
    await until(() => JSON.stringify(get().runtime[thread.id]?.timeline ?? []).includes("Added the note in Notes"))
    await until(() => useComputerActivity.getState()[thread.id] === undefined)
  })
})
