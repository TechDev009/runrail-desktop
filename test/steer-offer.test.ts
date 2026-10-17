import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, resetPeeks, steer } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, patchRuntime, runtimeOf, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { ContractSchema } from "../src/protocol/schemas"
import { steersMidTurn } from "../src/ui/thread/Composer"

const contract = (status?: string) => ContractSchema.parse({ capabilities: ["session.usage", ...(status === undefined ? [] : ["turn.steer.live"])], capabilityStatus: status === undefined ? {} : { "turn.steer.live": status } })

describe("where Steer is offered", () => {
  test("the engine says per backend whether a turn takes guidance mid-turn", () => {
    for (const backend of ["native", "claude-code", "codex"]) expect(steersMidTurn(backend, contract("available"))).toBe(true)
    for (const backend of ["pi", "copilot", "gemini"]) expect(steersMidTurn(backend, contract("unavailable"))).toBe(false)
  })

  test("an engine from before that offers it on Runrail's own loop only", () => {
    expect(steersMidTurn("native", contract())).toBe(true)
    expect(steersMidTurn(undefined)).toBe(true)
    for (const backend of ["codex", "claude-code", "pi", "copilot", "replay"]) expect(steersMidTurn(backend, contract())).toBe(false)
  })
})

describe("a steer the running turn cannot take", () => {
  let steers: Record<string, unknown>[]
  let enqueued: unknown[]
  let answer: unknown

  beforeEach(() => {
    const host = createFakeHost({})
    steers = []
    enqueued = []
    answer = { steered: false, events: [] }
    setHost({
      ...host,
      rpc: async (engineId, method, params) => {
        if (method === "turn.steer") {
          steers.push(params ?? {})
          return answer
        }
        if (method === "turn.enqueue") {
          enqueued.push(params?.message)
          return {}
        }
        return host.rpc(engineId, method, params)
      },
    })
    resetPeeks()
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  })

  async function running(backend: "claude-code" | "native") {
    const thread = createThread({ projectId: "p1", backend, ...(backend === "native" ? { model: "claude-opus-5-5", connectionId: "anthropic" } : {}) })
    await ensureEngine(thread.id)
    patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, activeTurnId: "t1", status: "running" }, queue: [{ id: "q1", text: "queued before", attachments: [] }] }))
    return thread.id
  }

  test("goes back first in the queue, asked for the running turn only", async () => {
    const threadId = await running("claude-code")
    await steer(threadId, { text: "add BANANA" })
    expect(steers).toEqual([{ message: "add BANANA", idempotencyKey: expect.any(String), liveOnly: true }])
    expect(runtimeOf(threadId).queue.map((item) => item.text)).toEqual(["add BANANA", "queued before"])
    expect(runtimeOf(threadId).timeline.items.some((item) => item.kind === "user" && item.steer === true)).toBe(false)
    expect(enqueued).toEqual([])
  })

  test("taken by the turn, it stays in the timeline as a steer and the queue is untouched", async () => {
    answer = { steered: true, events: [] }
    const threadId = await running("claude-code")
    await steer(threadId, { text: "add BANANA" })
    expect(runtimeOf(threadId).queue.map((item) => item.text)).toEqual(["queued before"])
    expect(runtimeOf(threadId).timeline.items.filter((item) => item.kind === "user" && item.steer === true).map((item) => (item.kind === "user" ? item.text : ""))).toEqual(["add BANANA"])
  })

  test("a picture sent with no words still reaches the running turn", async () => {
    answer = { steered: true, events: [] }
    const threadId = await running("claude-code")
    await steer(threadId, { text: "", attachments: [{ id: "a1", kind: "image", name: "shot.png", path: ".runrail/attachments/shot.png", mediaType: "image/png" }] })
    expect(steers).toEqual([{ message: { text: "", attachments: [{ path: ".runrail/attachments/shot.png", kind: "image", mediaType: "image/png" }] }, idempotencyKey: expect.any(String), liveOnly: true }])
  })

  test("refused just as the turn ended, it is sent at once as the next turn", async () => {
    const threadId = await running("claude-code")
    patchRuntime(threadId, (current) => ({ timeline: { ...current.timeline, activeTurnId: undefined, status: "idle" }, queue: [] }))
    await steer(threadId, { text: "add BANANA" })
    expect(runtimeOf(threadId).queue).toEqual([])
    for (let tries = 0; tries < 100 && enqueued.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(enqueued).toEqual(["add BANANA"])
  })
})
