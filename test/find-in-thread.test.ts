import { describe, expect, test } from "bun:test"
import { findMatches, MAX_MATCHES, searchText, stepMatch } from "../src/thread/find"
import type { TimelineItem, ToolItem } from "../src/thread/reducer"
import { SHORTCUTS } from "../src/ui/shell/shortcuts"
import { toolTitle } from "../src/ui/thread/rows"
import { buildRows, rowIndex } from "../src/ui/thread/Timeline"

/** Find in thread. */

const user = (key: string, text: string): TimelineItem => ({ kind: "user", key, text, state: "sent", attachments: 0, at: 0 }) as TimelineItem
const said = (key: string, text: string, turnId = "t1"): TimelineItem => ({ kind: "assistant", key, turnId, text, streaming: false, at: 1 }) as TimelineItem
const tool = (key: string, title: string, output?: string): ToolItem =>
  ({ kind: "tool", key, callId: key, turnId: "t1", name: "run_command", presentation: { kind: "shell", title }, status: "completed", ...(output === undefined ? {} : { output }), at: 1 }) as unknown as ToolItem
const end = (turnId = "t1"): TimelineItem => ({ kind: "turn-end", key: `end:${turnId}`, turnId, status: "completed", startedAt: 0, endedAt: 1_000 }) as TimelineItem

describe("matching", () => {
  test("each occurrence counts, in timeline order, ignoring case", () => {
    const items = [user("u", "Fix the Parser"), tool("x", "Run bun test", "parser.test.ts passed\nparser ok"), said("a", "The parser is fixed. parser!"), end()]
    expect(findMatches(items, "PARSER")).toEqual([
      { key: "u", nth: 0 },
      { key: "x", nth: 0 },
      { key: "x", nth: 1 },
      { key: "a", nth: 0 },
      { key: "a", nth: 1 },
    ])
    expect(findMatches(items, "  ")).toEqual([])
    expect(findMatches(items, "nowhere")).toEqual([])
  })

  test("tool titles, as the row draws them, and output are read; the end of a turn is not", () => {
    expect(searchText(tool("x", "Run bun test", "3 pass"))).toBe("Run bun test\n3 pass")
    expect(findMatches([tool("x", "Edit src/a.ts")], "edited src", toolTitle)).toEqual([{ key: "x", nth: 0 }])
    expect(searchText(end())).toBe("")
  })

  test("counting stops at the limit", () => {
    expect(findMatches([said("a", "a".repeat(MAX_MATCHES + 50))], "a")).toHaveLength(MAX_MATCHES)
  })

  test("stepping goes round the ends", () => {
    expect([stepMatch(3, 2, 1), stepMatch(3, 0, -1), stepMatch(3, 1, 1), stepMatch(0, 0, 1)]).toEqual([0, 2, 2, 0])
  })
})

test("a match is found in its row, and in the folded turn that holds it", () => {
  const items = [user("u", "go"), said("a1", "Looking around."), tool("x", "Run git status"), said("a2", "Done."), end()]
  const rows = buildRows(items, false, false, false)
  const where = rowIndex(rows)
  expect(where.get("u")).toEqual({ index: 0 })
  expect(where.get("x")).toEqual({ index: 1, turnId: "t1" })
  expect(where.get("a1")).toEqual({ index: 1, turnId: "t1" })
  expect(where.get("a2")).toEqual({ index: 2 })
  expect(where.has("missing")).toBe(false)
})

test("mod+f finds in the thread, and no other shortcut takes it", () => {
  expect(SHORTCUTS.filter((shortcut) => shortcut.keys === "mod+f").map((shortcut) => shortcut.id)).toEqual(["find"])
})
