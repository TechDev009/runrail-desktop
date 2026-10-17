import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, type ApprovalItem, type ToolItem } from "../src/thread/reducer"
import { buildRows } from "../src/ui/thread/Timeline"
import { ApprovalCard, proposedPlan } from "../src/ui/thread/rows"

let seq = -1
function event(type: string, fields: Record<string, unknown>): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

const plan = "## Plan\n\n1. Add the migration\n2. Backfill the column"

function proposed(extra: () => readonly StreamFrame[] = () => []) {
  return applyFrames(emptyTimeline(), [
    event("turn.started", { turnId: "t1", prompt: "plan it" }),
    event("tool.started", { turnId: "t1", callId: "c1", name: "ExitPlanMode", presentation: { kind: "plan", title: "Proposed plan", content: plan } }),
    event("approval.required", { turnId: "t1", approvalId: "ap1", callId: "c1", action: "ExitPlanMode", capability: "plan", reason: "Claude Code wants to use ExitPlanMode" }),
    ...extra(),
  ])
}

describe("a plan Claude Code asks to carry out", () => {
  test("the approval shows the plan itself", () => {
    const timeline = proposed()
    const gate = timeline.items.find((item): item is ToolItem => item.kind === "tool")!
    const approval = timeline.items.find((item): item is ApprovalItem => item.kind === "approval")!
    expect(proposedPlan(gate)).toBe(plan)
    const html = renderToStaticMarkup(<ApprovalCard item={approval} threadId="t" gate={gate} primary={false} />)
    expect(html).toContain("approval-plan")
    expect(html).toContain("Backfill the column")
  })

  test("the plan stays in the thread once decided, unlike a step list", () => {
    const timeline = proposed(() => [event("approval.resolved", { approvalId: "ap1", approved: true }), event("tool.completed", { turnId: "t1", callId: "c1", status: "completed" }), event("turn.completed", { turnId: "t1" })])
    const rows = buildRows(timeline.items, false, false, false)
    expect(rows.some((row) => row.type === "tool" && row.item.name === "ExitPlanMode")).toBe(true)
    expect(proposedPlan({ presentation: { kind: "plan", title: "Update plan", plan: [{ text: "a", status: "pending" }] } })).toBeUndefined()
  })
})
