import { expect, test } from "bun:test"
import type { TimelineItem } from "../src/thread/reducer"
import { buildRows } from "../src/ui/thread/Timeline"

const end = { kind: "turn-end", key: "e", turnId: "t", status: "completed", startedAt: 0, endedAt: 1_000 } as unknown as TimelineItem
const passed = { kind: "notice", key: "n", level: "info", code: "verification.passed", name: "check", at: 1 } as unknown as TimelineItem
const failed = { kind: "notice", key: "f", level: "error", code: "verification.failed", name: "check", at: 1 } as unknown as TimelineItem

test("a passed check joins its turn's end line, before or after it", () => {
  for (const items of [[end, passed], [passed, end]]) {
    const rows = buildRows(items, false, false, false)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: "item", item: { kind: "turn-end" }, checks: "Checks passed" })
  }
})

test("a failed check, or one with no turn end beside it, keeps its own row", () => {
  expect(buildRows([end, failed], false, false, false)).toHaveLength(2)
  expect(buildRows([passed], false, false, false)).toMatchObject([{ type: "item", item: { kind: "notice" } }])
})
