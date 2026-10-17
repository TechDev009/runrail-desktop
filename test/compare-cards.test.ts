import { describe, expect, test } from "bun:test"
import type { TimelineItem } from "../src/thread/reducer"
import { appliedRun, lastElapsed } from "../src/ui/views/Compare"

const user = (at: number, extra: Partial<Extract<TimelineItem, { kind: "user" }>> = {}): TimelineItem => ({ kind: "user", key: `u${String(at)}`, text: "go", attachments: 0, state: "sent", at, ...extra })
const assistant = (at: number): TimelineItem => ({ kind: "assistant", key: `a${String(at)}`, text: "done", streaming: false, at }) as TimelineItem
const tool = (at: number, endedAt: number): TimelineItem => ({ kind: "tool", key: `t${String(at)}`, callId: "c", name: "read_file", presentation: { kind: "read", title: "a" }, status: "ok", at, endedAt }) as TimelineItem

describe("a compare card's time", () => {
  test("is the last turn's own length when the turn ended in this window", () => {
    expect(lastElapsed([user(0), assistant(5_000), { kind: "turn-end", key: "e", turnId: "t", status: "completed", startedAt: 1_000, endedAt: 9_000 }])).toBe(8_000)
  })

  test("is worked out from the messages when the thread came back from history", () => {
    // Last message at 10s; a tool ran until 25s; the answer came at 24s.
    expect(lastElapsed([user(0), assistant(4_000), user(10_000), tool(12_000, 25_000), assistant(24_000)])).toBe(15_000)
    // A steer is part of the turn, not its start.
    expect(lastElapsed([user(10_000), tool(12_000, 13_000), user(14_000, { steer: true }), assistant(20_000)])).toBe(10_000)
    // Nothing after the message yet: no time to show.
    expect(lastElapsed([user(10_000)])).toBeUndefined()
    expect(lastElapsed(undefined)).toBeUndefined()
  })
})

describe("a compare card's Applied state", () => {
  test("stays after the view closes, until the run works again", () => {
    expect(appliedRun({ group: { id: "g", label: "x", appliedAt: 2_000 }, updatedAt: 1_500 })).toBe(true)
    expect(appliedRun({ group: { id: "g", label: "x", appliedAt: 2_000 }, updatedAt: 3_000 })).toBe(false)
    expect(appliedRun({ group: { id: "g", label: "x" }, updatedAt: 1_500 })).toBe(false)
    expect(appliedRun({ updatedAt: 1_500 })).toBe(false)
  })
})
