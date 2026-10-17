import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, type ApprovalItem, type ToolItem, type TurnEndItem } from "../src/thread/reducer"
import { ApprovalCard, ToolRow, TurnEndRow } from "../src/ui/thread/rows"

let seq = -1
function event(type: string, fields: Record<string, unknown>): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

describe("a turn the user stopped", () => {
  test("says Stopped once, in its own line, and marks the work it cut short quietly", () => {
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "edit" }),
      event("tool.started", { turnId: "t1", callId: "c1", name: "write_file", presentation: { kind: "write", title: "a.ts", path: "a.ts" } }),
      event("approval.required", { turnId: "t1", approvalId: "ap1", action: "write a.ts", capability: "write" }),
      event("session.failed", { error: { code: "TURN_CANCELLED", message: "cancelled" }, snapshot: { version: 1, id: "s", backend: "runrail", cwd: "/tmp", status: "failed", createdAt: 0, updatedAt: 0, lastSeq: 3, capabilities: [] } }),
    ])
    const tool = timeline.items.find((item): item is ToolItem => item.kind === "tool")!
    const approval = timeline.items.find((item): item is ApprovalItem => item.kind === "approval")!
    const end = timeline.items.find((item): item is TurnEndItem => item.kind === "turn-end")!
    const html = [
      renderToStaticMarkup(<ToolRow item={tool} />),
      renderToStaticMarkup(<ApprovalCard item={approval} threadId="t" gate={tool} primary={false} />),
      renderToStaticMarkup(<TurnEndRow item={end} />),
    ].join("\n")
    // The question the stop cut short was never answered: not "Denied", not a second "Stopped".
    expect(html).toContain("Not answered")
    expect(html).not.toContain("Denied")
    // A turn stopped within a second says "Stopped", with no "after 0s".
    expect(html.match(/turn-end-text">Stopped/g)).toHaveLength(1)
    expect(html).not.toContain("0s")
    // The cut-short call is tagged, not flagged: no red status and no alert.
    expect(html).toContain("status-stopped")
    expect(html).not.toContain("status-failed")
    expect(html).not.toContain('role="alert"')
  })

  test("a denial still reads as one", () => {
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t2", prompt: "edit" }),
      event("tool.started", { turnId: "t2", callId: "c2", name: "write_file", presentation: { kind: "write", title: "b.ts", path: "b.ts" } }),
      event("approval.required", { turnId: "t2", approvalId: "ap2", action: "write b.ts", capability: "write" }),
      event("approval.resolved", { turnId: "t2", approvalId: "ap2", approved: false }),
      event("tool.completed", { turnId: "t2", callId: "c2", name: "write_file", ok: false, error: { code: "APPROVAL_DENIED", message: "approval denied for write_file: not that file" } }),
    ])
    const tool = timeline.items.find((item): item is ToolItem => item.kind === "tool")!
    const approval = timeline.items.find((item): item is ApprovalItem => item.kind === "approval")!
    const html = renderToStaticMarkup(<ApprovalCard item={approval} threadId="t" gate={tool} primary={false} />) + renderToStaticMarkup(<ToolRow item={tool} />)
    expect(html).toContain("Denied")
    expect(html).toContain("status-failed")
  })

  test("a call the coding tool's own reviewer refused says who refused it, not that the person did", () => {
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t3", prompt: "push" }),
      event("tool.started", { turnId: "t3", callId: "c3", name: "command", presentation: { kind: "shell", title: "git push", command: "git push" } }),
      event("tool.completed", { turnId: "t3", callId: "c3", name: "command", ok: false, error: { code: "REVIEW_DENIED", message: "Codex's reviewer denied this call" } }),
    ])
    const tool = timeline.items.find((item): item is ToolItem => item.kind === "tool")!
    const html = renderToStaticMarkup(<ToolRow item={tool} />)
    expect(html).toContain("Denied")
    expect(html).toContain("Codex&#x27;s reviewer denied this call.")
    expect(html).not.toContain("You denied")
  })

  test("a question the coding tool asks in its reply instead is not a failure", () => {
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t4", prompt: "plan" }),
      event("tool.started", { turnId: "t4", callId: "c4", name: "AskUserQuestion", presentation: { kind: "other", title: "Ask: Which library?" } }),
      event("tool.completed", { turnId: "t4", callId: "c4", name: "AskUserQuestion", ok: false, error: { code: "QUESTION_IN_REPLY", message: "Runrail can't show Claude Code's questions yet, so Claude Code asks them in its reply instead" } }),
    ])
    const tool = timeline.items.find((item): item is ToolItem => item.kind === "tool")!
    const html = renderToStaticMarkup(<ToolRow item={tool} />)
    expect(html).toContain("Ask: Which library?")
    expect(html).toContain("Asked in reply")
    expect(html).toContain("status-stopped")
    expect(html).not.toContain("status-failed")
    expect(html).toContain("so Claude Code asks them in its reply instead")
  })
})
