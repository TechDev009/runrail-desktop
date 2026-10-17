import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { compactThread, ensureEngine, refreshThreadUsage, send, threadCapability, threadStatus } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, set, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Compact, offered where the engine can compact, holds new messages until it is done. */

let calls: { method: string; params: unknown }[]
let gate: Promise<void> | undefined

beforeEach(() => {
  const host = createFakeHost({})
  const seen: typeof calls = []
  calls = seen
  gate = undefined
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      seen.push({ method, params })
      if (method === "session.compact" && gate !== undefined) await gate
      return host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
})

const texts = () => get().toasts.map((toast) => `${toast.level}: ${toast.text}`)

describe("compacting a thread", () => {
  test("is offered on Runrail's loop, Claude Code, and Codex, by what the engine says", async () => {
    const offered = []
    for (const backend of ["native", "claude-code", "codex", "gemini"] as const) {
      const thread = createThread({ projectId: "p1", backend, model: "m" })
      expect(threadCapability(thread.id, "session.compact")).toBe(false)
      await ensureEngine(thread.id)
      offered.push(threadCapability(thread.id, "session.compact"))
    }
    expect(offered).toEqual([true, true, true, false])
  })

  test("a message sent meanwhile waits in the queue and goes once compaction ends", async () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    let release: () => void = () => undefined
    gate = new Promise((resolve) => {
      release = resolve
    })
    const compacting = compactThread(thread.id)
    expect(get().runtime[thread.id]?.compacting).toBe(true)
    expect(threadStatus(threadById(thread.id)!, get().runtime[thread.id])).toBe("running")
    send(thread.id, { text: "next step" })
    expect(get().runtime[thread.id]?.queue.map((item) => item.text)).toEqual(["next step"])
    expect(calls.some((call) => call.method === "turn.enqueue")).toBe(false)
    release()
    await compacting
    expect(get().runtime[thread.id]?.compacting).toBe(false)
    expect(get().runtime[thread.id]?.queue).toEqual([])
    expect(calls.some((call) => call.method === "turn.enqueue")).toBe(true)
    // Runrail's own loop leaves no notice in the timeline, so it says how it went.
    expect(texts()).toEqual(["info: Nothing to compact yet"])
  })

  test("a coding tool's refusal is shown in its words", async () => {
    const thread = createThread({ projectId: "p1", backend: "codex", model: "gpt-5.5" })
    await ensureEngine(thread.id)
    await compactThread(thread.id)
    expect(texts()).toEqual(["error: Compaction failed: the conversation has nothing to compact yet"])
  })

  test("opening the card asks a running engine for its readings, and never starts one", async () => {
    const thread = createThread({ projectId: "p1", backend: "claude-code", model: "opus" })
    refreshThreadUsage(thread.id)
    expect(calls.some((call) => call.method === "session.usage.read")).toBe(false)
    await ensureEngine(thread.id)
    refreshThreadUsage(thread.id)
    expect(calls.filter((call) => call.method === "session.usage.read")).toHaveLength(1)
  })
})
