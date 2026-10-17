import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { resetDiagnostics, useDiagnostics } from "../src/app/diagnostics"
import { engineIdFor, ensureEngine, resetPeeks, send } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, runtimeOf, set } from "../src/app/store"
import { setHost, type EngineInfo, type EngineStartInput } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/**
 * History first: a thread's history is read through the system engine and
 * drawn while the thread's own engine starts. The host is the preview host with a 2,000-item
 * history, an engine start held until the test lets it go, and a record of sent turns.
 */

const PROJECT = "p1"
let release: () => void
let started: Promise<EngineInfo> | undefined
let enqueued: string[]
let peeks: number
let engineRead: ((answer: { items: unknown[]; lastSeq: number; truncated?: boolean }) => unknown) | undefined

beforeEach(() => {
  const host = createFakeHost({ long: true })
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  release = open
  started = undefined
  enqueued = []
  peeks = 0
  engineRead = undefined
  setHost({
    ...host,
    engineStart: (input: EngineStartInput) => {
      started = gate.then(() => host.engineStart(input))
      return started
    },
    rpc: async (engineId, method, params) => {
      if (method === "turn.enqueue") {
        enqueued.push(engineId)
        return {}
      }
      if (method === "conversation.peek") peeks += 1
      const answer = await host.rpc(engineId, method, params)
      if (method === "session.conversation.read" && params?.source === "auto" && engineRead !== undefined) return engineRead(answer as { items: unknown[]; lastSeq: number })
      return answer
    },
  })
  resetPeeks()
  resetDiagnostics()
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
})

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

const steps = () => useDiagnostics.getState().opens[0]?.steps.map(([name]) => name) ?? []

describe("history first", () => {
  test("the peeked history is drawn before the engine is ready, and kept when the engine reads the same", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    const opening = ensureEngine(thread.id)
    await until(() => runtimeOf(thread.id).timeline.items.length > 0)
    expect(runtimeOf(thread.id).engine).toBe("starting")
    expect(runtimeOf(thread.id).historyLoaded).toBe(false)
    const peeked = runtimeOf(thread.id).timeline
    release()
    expect(await opening).toBe(engineIdFor(thread.id))
    expect(runtimeOf(thread.id).historyLoaded).toBe(true)
    expect(runtimeOf(thread.id).timeline.items).toBe(peeked.items)
    expect(steps()).toContain("history (kept the peek)")
  })

  test("the engine's history replaces the peek when it differs", async () => {
    engineRead = (answer) => ({ ...answer, items: answer.items.slice(-4), lastSeq: answer.lastSeq + 3 })
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    const opening = ensureEngine(thread.id)
    await until(() => runtimeOf(thread.id).timeline.items.length > 0)
    const peeked = runtimeOf(thread.id).timeline.items.length
    release()
    await opening
    expect(runtimeOf(thread.id).timeline.items.length).toBeLessThan(peeked)
    expect(steps()).toContain("history (replaced the peek)")
  })

  test("a message sent while the engine starts waits for it, then goes once", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    const opening = ensureEngine(thread.id)
    await until(() => runtimeOf(thread.id).timeline.items.length > 0)
    send(thread.id, { text: "carry on" })
    expect(runtimeOf(thread.id).queue).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(enqueued).toEqual([])
    release()
    await opening
    await until(() => enqueued.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(enqueued).toEqual([engineIdFor(thread.id)])
    expect(runtimeOf(thread.id).queue).toEqual([])
  })

  test("a thread whose history is already on screen is not peeked again", async () => {
    const thread = createThread({ projectId: PROJECT, backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    release()
    await ensureEngine(thread.id)
    expect(peeks).toBe(1)
    resetDiagnostics()
    // A second start, after the engine stopped, neither peeks nor reads the history again.
    set((state) => ({ runtime: { ...state.runtime, [thread.id]: { ...runtimeOf(thread.id), engine: "stopped" } } }))
    await ensureEngine(thread.id)
    expect(peeks).toBe(1)
    expect(steps().some((step) => step.startsWith("history"))).toBe(false)
  })
})
