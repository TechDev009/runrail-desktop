import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine } from "../src/app/engines"
import { forkAt, nextPrompt } from "../src/app/fork"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, patchRuntime, runtimeOf, set, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { loadHistory, type TimelineItem } from "../src/thread/reducer"

/** Fork from any message. */

const user = (key: string, text: string, fields: Partial<Extract<TimelineItem, { kind: "user" }>> = {}): TimelineItem => ({ kind: "user", key, text, attachments: 0, state: "sent", at: 1, ...fields })
const reply = (key: string): TimelineItem => ({ kind: "assistant", key, text: "ok", streaming: false, at: 1 })

test("a reply forks before the next message that started a turn, past steers", () => {
  const items = [user("k1", "one"), reply("a1"), user("s1", "nudge", { steer: true }), reply("a2"), user("k2", "two"), reply("a3")]
  expect(nextPrompt(items, "a1")?.key).toBe("k2")
  expect(nextPrompt(items, "a3")).toBeUndefined()
  expect(nextPrompt(items, "missing")).toBeUndefined()
})

describe("forking", () => {
  let calls: { method: string; params: Record<string, unknown> }[]
  let refuse: string | undefined

  const history = [
    { kind: "user", id: "u1", seq: 0, at: 1, text: "plan it", turnId: "turn-1" },
    { kind: "assistant", id: "a1", seq: 3, at: 2, text: "planned", turnId: "turn-1" },
    { kind: "user", id: "u2", seq: 5, at: 3, text: "build it", turnId: "turn-2" },
    { kind: "assistant", id: "a2", seq: 8, at: 4, text: "built", turnId: "turn-2" },
  ]

  beforeEach(() => {
    const host = createFakeHost({})
    calls = []
    refuse = undefined
    setHost({
      ...host,
      rpc: async (engineId, method, params = {}) => {
        calls.push({ method, params })
        if (method === "session.conversation.read" && params.source !== "live") return { items: history, truncated: false, lastSeq: 8 }
        if (method === "thread.copy") {
          if (refuse !== undefined) throw Object.assign(new Error(refuse), { code: refuse })
          return { copied: true }
        }
        return host.rpc(engineId, method, params)
      },
    })
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" }, dialog: undefined })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  })

  async function threadWithHistory() {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai", title: "Ship the parser" })
    await ensureEngine(thread.id)
    patchRuntime(thread.id, (current) => ({ timeline: loadHistory(current.timeline, history, false) }))
    const key = (kind: string, text: string) => runtimeOf(thread.id).timeline.items.find((item) => item.kind === kind && "text" in item && item.text === text)!.key
    return { thread, key }
  }

  const copies = () => calls.filter((call) => call.method === "thread.copy").map((call) => call.params)

  test("from a message: the fork holds what came before it, opens, and has the message to change", async () => {
    const { thread, key } = await threadWithHistory()
    await forkAt(thread.id, key("user", "build it"))
    const [copy] = copies()
    expect(copy).toMatchObject({ from: thread.id, beforeSeq: 5 })
    const fork = threadById(copy!.to as string)
    expect(fork).toMatchObject({ title: "Ship the parser (fork)", projectId: "p1", backend: "native", model: "gpt-5.5" })
    expect(fork?.parentThreadId).toBeUndefined()
    expect(get().layout.activeThreadId).toBe(fork!.id)
    expect(get().drafts[fork!.id]).toBe("build it")
    expect(threadById(thread.id)?.archived).toBeUndefined()
  })

  test("from an earlier reply: the fork holds that reply's turn; from the latest, the whole conversation", async () => {
    const { thread, key } = await threadWithHistory()
    await forkAt(thread.id, key("assistant", "planned"))
    await forkAt(thread.id, key("assistant", "built"))
    expect(copies().map((copy) => copy.beforeSeq)).toEqual([5, undefined])
    expect(Object.keys(get().drafts)).toEqual([])
  })

  test("a fork of a fork is not named twice", async () => {
    const { thread, key } = await threadWithHistory()
    set((state) => ({ threads: state.threads.map((item) => (item.id === thread.id ? { ...item, title: "Ship the parser (fork)" } : item)) }))
    await forkAt(thread.id, key("assistant", "planned"))
    expect(threadById(copies()[0]!.to as string)?.title).toBe("Ship the parser (fork)")
  })

  test("a copy the engine refuses takes the fork away and says why", async () => {
    const { thread, key } = await threadWithHistory()
    refuse = "CONTROL_TRANSCRIPT_INVALID"
    const threads = get().threads.length
    await forkAt(thread.id, key("user", "build it"))
    expect(get().threads.length).toBe(threads)
    expect(get().toasts.at(-1)?.text).toStartWith("Could not fork")
  })

  test("the turn still running is not forked from; earlier messages are", async () => {
    const { thread, key } = await threadWithHistory()
    patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, status: "running", activeTurnId: "turn-2" } }))
    await forkAt(thread.id, key("assistant", "built"))
    expect(copies()).toEqual([])
    expect(get().toasts.at(-1)?.text).toContain("Wait for the turn to finish")
    await forkAt(thread.id, key("user", "build it"))
    expect(copies().map((copy) => copy.beforeSeq)).toEqual([5])
  })
})
