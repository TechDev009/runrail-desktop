import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, stopCause, type ApprovalItem, type TurnEndItem } from "../src/thread/reducer"
import { QuestionCard } from "../src/ui/thread/QuestionCard"
import { ApprovalCard, failureLine, notSent, TurnEndRow } from "../src/ui/thread/rows"

let seq = -1
function event(type: string, fields: Record<string, unknown>): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq * 2_000, type, ...fields } }
}

describe("a failure says why, in words for the person", () => {
  test("a message the engine refused carries its reason; an older engine's stock words give way to the code", () => {
    expect(notSent({ errorCode: "COMMAND_AGENT_FAILED", errorMessage: "Codex refused the request: thread not loaded" })).toBe("Not sent: Codex refused the request: thread not loaded")
    expect(notSent({ errorCode: "COMMAND_AGENT_FAILED", errorMessage: "control operation failed" })).toBe("Not sent (COMMAND_AGENT_FAILED)")
    expect(notSent({})).toBe("Not sent")
  })

  test("a stop the person did not ask for says what stopped it", () => {
    expect(stopCause("timeout")).toBe("timeout")
    expect(stopCause("provider timeout")).toBe("timeout")
    expect(stopCause("closed")).toBe("closed")
    expect(stopCause("consumer closed")).toBe("closed")
    for (const reason of [undefined, "user", "cancelled", "interrupted", "user stopped"]) expect(stopCause(reason)).toBeUndefined()
    const timeline = applyFrames(emptyTimeline(), [event("turn.started", { turnId: "t1", prompt: "go" }), event("session.stopped", { reason: "timeout" })])
    const end = timeline.items.find((item): item is TurnEndItem => item.kind === "turn-end")!
    expect(end).toMatchObject({ status: "stopped", stopCause: "timeout" })
    expect(renderToStaticMarkup(<TurnEndRow item={end} />)).toContain("Stopped after 2s: ran out of time")
  })

  test("a completed turn names the model that handled it", () => {
    const html = renderToStaticMarkup(
      <TurnEndRow item={{ kind: "turn-end", key: "end", turnId: "t1", status: "completed", startedAt: 0, endedAt: 1_000, backend: "codex", model: "gpt-5.5" }} />,
    )
    expect(html).toContain("GPT-5.5 via Codex")
  })

  test("a subagent's failure reads as a tool's does: a denial with the person's feedback, a stop with nothing more", () => {
    expect(failureLine({ errorCode: "APPROVAL_DENIED", errorMessage: "approval denied for Task: use the docs agent" })).toBe("You denied this: use the docs agent")
    expect(failureLine({ errorCode: "HARNESS_TOOL_FAILED", errorMessage: "Subagent ran out of turns" })).toBe("Subagent ran out of turns")
    expect(failureLine({ errorCode: "INTERRUPTED", errorMessage: "turn interrupted" })).toBeUndefined()
    expect(failureLine({ errorCode: "HARNESS_TOOL_FAILED" })).toBeUndefined()
  })

  test("a request the coding tool took back reads as withdrawn, not denied", () => {
    const questions = [{ id: "q1", question: "Which library?", options: [{ label: "Luxon" }], other: true }]
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "go" }),
      event("approval.required", { turnId: "t1", approvalId: "ap1", action: "rm -rf build", capability: "process.exec" }),
      event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: false, withdrawn: true, reason: "Claude Code withdrew the request" }),
      event("approval.required", { turnId: "t1", approvalId: "ap2", action: "question", capability: "user.input", questions }),
      event("approval.resolved", { turnId: "t1", approvalId: "ap2", approved: false, withdrawn: true, reason: "Codex no longer needs an answer" }),
      event("approval.required", { turnId: "t1", approvalId: "ap3", action: "rm -rf dist", capability: "process.exec" }),
      event("approval.resolved", { turnId: "t1", approvalId: "ap3", approved: false }),
    ])
    const [command, question, denied] = timeline.items.filter((item): item is ApprovalItem => item.kind === "approval")
    expect(renderToStaticMarkup(<ApprovalCard item={command!} threadId="t" primary={false} />)).toContain("Withdrawn")
    expect(renderToStaticMarkup(<QuestionCard item={question!} threadId="t" primary={false} />)).toContain("No longer needed")
    expect(renderToStaticMarkup(<ApprovalCard item={denied!} threadId="t" primary={false} />)).toContain("Denied")
  })
})
