import { beforeEach, describe, expect, test } from "bun:test"
import { forgetThread, markAllRead, markThreadRead, MAX_INBOX, notify, unreadCount, useInbox } from "../src/app/inbox"

beforeEach(() => useInbox.setState({ items: [], open: false }))

describe("the notifications inbox", () => {
  test("keeps the latest word from each thread, newest first", () => {
    notify("approval", "a", "Fix tests", 1)
    notify("finished", "b", "Docs", 2)
    notify("finished", "a", "Fix tests", 3)
    expect(useInbox.getState().items.map((item) => [item.threadId, item.kind])).toEqual([
      ["a", "finished"],
      ["b", "finished"],
    ])
    expect(unreadCount(useInbox.getState())).toBe(2)
  })

  test("opening a thread reads its entry; mark all read reads the rest", () => {
    notify("failed", "a", "One", 1)
    notify("stopped", "b", "Two", 2)
    markThreadRead("a")
    expect(useInbox.getState().items.filter((item) => !item.read).map((item) => item.threadId)).toEqual(["b"])
    markAllRead()
    expect(unreadCount(useInbox.getState())).toBe(0)
  })

  test("holds a bounded number of entries and drops a deleted thread's", () => {
    for (let index = 0; index < MAX_INBOX + 5; index += 1) notify("finished", `t${String(index)}`, "Run", index)
    expect(useInbox.getState().items).toHaveLength(MAX_INBOX)
    forgetThread(`t${String(MAX_INBOX + 4)}`)
    expect(useInbox.getState().items.some((item) => item.threadId === `t${String(MAX_INBOX + 4)}`)).toBe(false)
  })
})
