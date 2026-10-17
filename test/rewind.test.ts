import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, threadCapability } from "../src/app/engines"
import { defaultState, type ThreadMeta } from "../src/app/persist"
import { changeLabel, checkoutSharers, messageSeq, openRewind, runRewind } from "../src/app/rewind"
import { addProject, createThread, get, patchRuntime, runtimeOf, set, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { loadHistory, type TimelineItem } from "../src/thread/reducer"

/** Going back to before a message, and Edit. */

const user = (key: string, text: string, fields: Partial<Extract<TimelineItem, { kind: "user" }>> = {}): TimelineItem => ({ kind: "user", key, text, attachments: 0, state: "sent", at: 1, ...fields })
const reply = (key: string): TimelineItem => ({ kind: "assistant", key, text: "ok", streaming: false, at: 1 })

describe("finding a message in the history", () => {
  const timeline = [user("k1", "first"), reply("a1"), user("k2", "second"), user("s1", "nudge", { steer: true }), reply("a2"), user("k3", "third", { state: "sending" })]
  const history = [
    { kind: "user", id: "u1", seq: 0, at: 1, text: "first" },
    { kind: "assistant", id: "a1", seq: 2, at: 1, text: "ok" },
    { kind: "user", id: "u2", seq: 4, at: 1, text: "second", turnId: "turn-2" },
    { kind: "user", id: "u3", seq: 6, at: 1, text: "nudge", steer: true },
  ]

  test("by its place counted from the newest, past steers and messages still being sent", () => {
    expect(messageSeq(timeline, "k2", history)).toBe(4)
    expect(messageSeq(timeline, "k1", history)).toBe(0)
    expect(messageSeq(timeline, "k3", history)).toBeUndefined()
    expect(messageSeq(timeline, "s1", history)).toBeUndefined()
  })

  test("a history that starts later still finds the newer messages, and words that differ find nothing", () => {
    expect(messageSeq(timeline, "k2", history.slice(2))).toBe(4)
    expect(messageSeq(timeline, "k1", history.slice(2))).toBeUndefined()
    expect(messageSeq([user("k1", "first"), user("k2", "edited elsewhere")], "k2", history)).toBeUndefined()
  })
})

describe("who else worked in the checkout", () => {
  const thread = (id: string, fields: Partial<ThreadMeta>): ThreadMeta => ({ id, projectId: "p1", title: id, titled: true, createdAt: 1, updatedAt: 1, backend: "native", mode: "agent", permission: "ask", ...fields })
  test("threads in the same folder, or the same worktree, that ran since then", () => {
    const self = thread("me", {})
    const ran = { updatedAt: 500, lastStatus: "completed" } as const
    const threads = [
      self,
      thread("same folder", ran),
      thread("before", { ...ran, updatedAt: 50 }),
      thread("a kept copy", { updatedAt: 500, archived: true }),
      thread("own worktree", { ...ran, worktree: { id: "w1", path: "/wt", cwd: "/wt", branch: "b" } }),
      thread("other project", { ...ran, projectId: "p2" }),
    ]
    expect(checkoutSharers(threads, self, 100)).toEqual(["same folder"])
    const inWorktree = thread("me2", { worktree: { id: "w1", path: "/wt", cwd: "/wt", branch: "b" } })
    expect(checkoutSharers([...threads, inWorktree], inWorktree, 100)).toEqual(["own worktree"])
  })

  test("each change says what going back does to it", () => {
    expect(["modified", "added", "deleted"].map((change) => changeLabel(change as "modified"))).toEqual(["changed since, goes back", "new since, deleted", "deleted since, comes back"])
  })
})

describe("going back", () => {
  let calls: { method: string; params: Record<string, unknown> }[]
  let rewound: boolean
  let refuse: string | undefined

  const before = [
    { kind: "user", id: "u1", seq: 0, at: 1, text: "plan it", turnId: "turn-1" },
    { kind: "assistant", id: "a1", seq: 3, at: 2, text: "planned", turnId: "turn-1" },
    { kind: "user", id: "u2", seq: 5, at: 3, text: "build it", turnId: "turn-2" },
    { kind: "assistant", id: "a2", seq: 8, at: 4, text: "built", turnId: "turn-2" },
  ]
  const after = [...before.slice(0, 2), { kind: "notice", id: "n1", seq: 9, at: 5, level: "info", code: "session.rewound" }]

  beforeEach(() => {
    const host = createFakeHost({})
    calls = []
    rewound = false
    refuse = undefined
    setHost({
      ...host,
      rpc: async (engineId, method, params = {}) => {
        calls.push({ method, params })
        if (method === "session.conversation.read" && params.source !== "live") return { items: rewound ? after : before, truncated: false, lastSeq: 9 }
        if (method === "session.checkpoint.changes") return { checkpoint: { n: 2, at: 2 }, files: [{ path: "src/a.ts", change: "modified" }, { path: "src/new.ts", change: "added" }] }
        if (method === "thread.copy") return { copied: true }
        if (method === "session.rewind") {
          if (refuse !== undefined) throw Object.assign(new Error(refuse), { code: refuse })
          rewound = true
          return { removed: 3, restored: ["src/new.ts"], failed: [{ path: "src/a.ts", reason: "could not be written" }] }
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
    patchRuntime(thread.id, (current) => ({ timeline: loadHistory(current.timeline, before, false) }))
    const message = runtimeOf(thread.id).timeline.items.find((item) => item.kind === "user" && item.text === "build it")!
    return { thread, key: message.key }
  }

  test("the confirmation lists the changed files, then the thread goes back, a copy is kept, and Edit puts the words back", async () => {
    const { thread, key } = await threadWithHistory()
    expect(threadCapability(thread.id, "session.rewind")).toBe(true)
    await openRewind(thread.id, key, true)
    const dialog = get().dialog
    if (dialog?.kind !== "rewind") throw new Error("no rewind dialog")
    expect(dialog.plan).toMatchObject({ userSeq: 5, edit: true, text: "build it", files: [{ path: "src/a.ts", change: "modified" }, { path: "src/new.ts", change: "added" }] })

    // A message the timeline drew live, not from history, goes with the turns that follow it.
    patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, items: [...current.timeline.items, user("p.1", "drawn live")] } }))
    await runRewind(dialog.plan, ["src/new.ts"])
    const order = calls.map((call) => call.method).filter((method) => method === "thread.copy" || method === "session.rewind")
    expect(order).toEqual(["thread.copy", "session.rewind"])
    expect(calls.find((call) => call.method === "session.rewind")?.params).toEqual({ userSeq: 5, files: ["src/new.ts"] })
    const copyId = calls.find((call) => call.method === "thread.copy")?.params.to as string
    expect(threadById(copyId)).toMatchObject({ title: "Ship the parser (before rewind)", archived: true })
    expect(runtimeOf(thread.id).timeline.items.map((item) => item.kind)).toEqual(["user", "assistant", "turn-end", "notice"])
    expect(get().drafts[thread.id]).toBe("build it")
    expect(get().toasts.map((toast) => [toast.level, toast.text, toast.action?.label])).toEqual([
      ["error", "1 file could not be put back: src/a.ts", undefined],
      ["success", "Back to before your message. Edit it and send.", "Open copy"],
    ])
  })

  test("Edit puts back what this app session attached, and says when some could not come back", async () => {
    const { thread, key } = await threadWithHistory()
    const shot = { path: "/code/app/.runrail/attachments/shot.png", kind: "image" as const, name: "shot.png", mediaType: "image/png" }
    patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, items: current.timeline.items.map((item) => (item.key === key && item.kind === "user" ? { ...item, attachments: 1, sent: [shot] } : item)) } }))
    await openRewind(thread.id, key, true)
    const dialog = get().dialog
    if (dialog?.kind !== "rewind") throw new Error("no rewind dialog")
    expect(dialog.plan).toMatchObject({ attachments: [shot], attachmentsUnknown: 0 })
    await runRewind(dialog.plan, [])
    expect(get().editAttachments[thread.id]).toEqual([{ id: expect.any(String), ...shot }])
    expect(get().toasts.some((toast) => toast.text.includes("could not be put back. Attach"))).toBe(false)
  })

  test("after a restart a message knows only how many attachments it had, so Edit says they did not come back", async () => {
    const { thread, key } = await threadWithHistory()
    patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, items: current.timeline.items.map((item) => (item.key === key && item.kind === "user" ? { ...item, attachments: 2 } : item)) } }))
    await openRewind(thread.id, key, true)
    const dialog = get().dialog
    if (dialog?.kind !== "rewind") throw new Error("no rewind dialog")
    await runRewind(dialog.plan, [])
    expect(get().editAttachments[thread.id]).toBeUndefined()
    expect(get().toasts.map((toast) => toast.text)).toContain("2 attachments from before Runrail restarted could not be put back. Attach again before sending.")
  })

  test("a rewind the engine refuses takes its copy away and says why", async () => {
    const { thread, key } = await threadWithHistory()
    await openRewind(thread.id, key, false)
    const dialog = get().dialog
    if (dialog?.kind !== "rewind") throw new Error("no rewind dialog")
    refuse = "CONTROL_REWIND_UNAVAILABLE"
    const threads = get().threads.length
    await runRewind(dialog.plan, [])
    expect(get().threads.length).toBe(threads)
    expect(get().toasts.at(-1)?.text).toContain("cannot go back to it")
  })

  test("a thread in the middle of a turn is not taken back", async () => {
    const { thread, key } = await threadWithHistory()
    patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, status: "running" } }))
    await openRewind(thread.id, key, false)
    expect(get().dialog).toBeUndefined()
    expect(calls.some((call) => call.method === "session.checkpoint.changes")).toBe(false)
    expect(get().toasts.at(-1)?.text).toContain("before going back")
  })
})
