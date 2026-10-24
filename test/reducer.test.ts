import { describe, expect, test } from "bun:test"
import {
  addPendingUser,
  applyFrames,
  beginEpoch,
  displayPrompt,
  emptyTimeline,
  isBusy,
  latestPlan,
  loadHistory,
  markEngineExited,
  markUser,
  pendingApprovals,
  type NoticeItem,
  type Timeline,
  type TurnEndItem,
} from "../src/thread/reducer"
import type { StreamFrame } from "../src/host/types"
import { noticeCopy } from "../src/ui/thread/rows"


let seq = 0
let liveSeq = 0
function event(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}
function live(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  liveSeq += 1
  return { kind: "live", data: { version: 1, sessionId: "s", liveSeq, at: 1_000 + liveSeq, type, ...fields } }
}
function reset(): void {
  seq = -1
  liveSeq = 0
}
function kinds(timeline: Timeline): string[] {
  return timeline.items.map((item) => item.kind)
}

describe("timeline reducer", () => {
  test("keeps the model and backend on each turn end", () => {
    reset()
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "hello", backend: "codex", model: "gpt-5.5" }),
      event("session.stopped", { reason: "done" }),
    ])
    expect(timeline.items.find((item) => item.kind === "turn-end")).toMatchObject({ backend: "codex", model: "gpt-5.5" })
  })

  test("uses the launch selection when an older engine omits turn metadata", () => {
    reset()
    const timeline = applyFrames(emptyTimeline(), [event("turn.started", { turnId: "t1", prompt: "hello" }), event("session.stopped", {})], {
      backend: "claude-code",
      model: "opus",
    })
    expect(timeline.items.find((item) => item.kind === "turn-end")).toMatchObject({ backend: "claude-code", model: "opus" })
  })

  test("keeps model switch notices in the timeline when history is reloaded", () => {
    reset()
    const notice: NoticeItem = { kind: "notice", key: "local.model", level: "info", code: "model.changed", message: "Switched models.", at: 2 }
    const timeline = loadHistory({ ...emptyTimeline(), items: [notice], index: new Map([[notice.key, 0]]) }, [], false)
    expect(timeline.items).toContainEqual(notice)
    expect(noticeCopy(notice)).toBe("Switched models.")
  })

  test("streams assistant deltas into one message and finalizes it", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "hello" }),
      event("assistant.delta", { turnId: "t1", text: "Hel" }),
      event("assistant.delta", { turnId: "t1", text: "lo" }),
    ])
    expect(kinds(timeline)).toEqual(["user", "assistant"])
    const streaming = timeline.items[1]
    expect(streaming?.kind === "assistant" && streaming.streaming).toBe(true)
    expect(streaming?.kind === "assistant" ? streaming.text : "").toBe("Hello")
    expect(isBusy(timeline)).toBe(true)
    timeline = applyFrames(timeline, [
      event("assistant.message", { turnId: "t1", text: "" }),
      event("session.completed", { snapshot: { id: "s", backend: "native", status: "idle" } }),
    ])
    const final = timeline.items[1]
    expect(final?.kind === "assistant" && !final.streaming && final.text === "Hello").toBe(true)
    expect(kinds(timeline)).toEqual(["user", "assistant", "turn-end"])
    expect(isBusy(timeline)).toBe(false)
  })

  test("claims the optimistic user message instead of duplicating it", () => {
    reset()
    const pending = addPendingUser(emptyTimeline(), { text: "fix the bug", attachments: 0 })
    const timeline = applyFrames(pending.timeline, [event("turn.started", { turnId: "t1", prompt: "fix the bug\n\n[Runrail attachment: a.png]" })])
    expect(kinds(timeline)).toEqual(["user"])
    const user = timeline.items[0]
    expect(user?.kind === "user" && user.state === "sent" && user.turnId === "t1").toBe(true)
  })

  test("a message the engine took shows as sent even when no turn announced it; a failed one stays failed", () => {
    const pending = addPendingUser(emptyTimeline(), { text: "hi", attachments: 0 })
    const sent = markUser(pending.timeline, pending.key, "sent")
    expect(sent.items[0]).toMatchObject({ kind: "user", state: "sent" })
    const failed = markUser(pending.timeline, pending.key, "failed", "CONTROL_FAILED")
    expect(markUser(failed, pending.key, "sent").items[0]).toMatchObject({ state: "failed" })
  })

  test("tool lifecycle keeps a bounded output tail and closes on turn end", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "run" }),
      event("assistant.delta", { turnId: "t1", text: "Running." }),
      event("tool.started", { turnId: "t1", callId: "c1", name: "run_command", presentation: { kind: "shell", title: "bun test", command: "bun test" } }),
      event("tool.delta", { turnId: "t1", callId: "c1", text: "x".repeat(40_000) }),
      event("tool.started", { turnId: "t1", callId: "c2", name: "read_file", presentation: { kind: "read", title: "a.ts", path: "a.ts" } }),
    ])
    const assistant = timeline.items[1]
    expect(assistant?.kind === "assistant" && !assistant.streaming).toBe(true)
    const shell = timeline.items[2]
    expect(shell?.kind === "tool" ? shell.output?.length : 0).toBe(32 * 1024)
    timeline = applyFrames(timeline, [
      event("tool.completed", { turnId: "t1", callId: "c1", name: "run_command", ok: true, output: { stdout: "pass", stderr: "" } }),
      event("session.stopped", {}),
    ])
    const done = timeline.items[2]
    const interrupted = timeline.items[3]
    expect(done?.kind === "tool" && done.status === "ok" && done.output === "pass").toBe(true)
    expect(interrupted?.kind === "tool" && interrupted.status === "failed" && interrupted.errorCode === "INTERRUPTED").toBe(true)
    const end = timeline.items.at(-1)
    expect(end?.kind === "turn-end" && end.status === "stopped").toBe(true)
  })

  test("a turn the user stopped ends as stopped, not as a failure", () => {
    reset()
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "edit" }),
      event("session.failed", { error: { code: "TURN_CANCELLED", message: "native turn cancelled" } }),
    ])
    expect(timeline.status).toBe("stopped")
    expect(kinds(timeline)).not.toContain("notice")
    const end = timeline.items.at(-1)
    expect(end?.kind === "turn-end" && end.status === "stopped").toBe(true)
  })

  test("approvals link to the running call and resolve", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "edit" }),
      event("tool.started", { turnId: "t1", callId: "c1", name: "write_file", presentation: { kind: "write", title: "a.ts", path: "a.ts" } }),
      event("approval.required", { turnId: "t1", approvalId: "ap1", action: "write a.ts", capability: "write" }),
    ])
    expect(timeline.status).toBe("waiting")
    const pending = pendingApprovals(timeline)
    expect(pending.length).toBe(1)
    expect(pending[0]?.callKey).toBe(timeline.calls.get("c1"))
    timeline = applyFrames(timeline, [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: true })])
    expect(pendingApprovals(timeline).length).toBe(0)
    expect(timeline.status).toBe("running")
  })

  test("drops duplicates and rejects unknown events without rendering them", () => {
    reset()
    const first = event("turn.started", { turnId: "t1", prompt: "hi" })
    let timeline = applyFrames(emptyTimeline(), [first])
    timeline = applyFrames(timeline, [first, { kind: "event", data: { seq: 99, at: 1, type: "mystery" } }, { kind: "live", data: { liveSeq: 5, type: "nope" } }])
    expect(kinds(timeline)).toEqual(["user"])
    expect(timeline.counters.duplicates).toBe(1)
    expect(timeline.counters.rejected).toBe(2)
  })

  test("live frames build reasoning, plan and subagent rows", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "plan" }),
      live("reasoning.delta", { turnId: "t1", itemId: "r", text: "think" }),
      live("reasoning.delta", { turnId: "t1", itemId: "r", text: "ing" }),
      live("plan.updated", { turnId: "t1", steps: [{ text: "one", status: "in_progress" }] }),
      live("plan.updated", { turnId: "t1", steps: [{ text: "one", status: "completed" }, { text: "two", status: "pending" }] }),
      live("agent.spawned", { turnId: "t1", callId: "a1", title: "Explore tests", agentType: "explore" }),
      live("agent.spawned", { turnId: "t1", callId: "a2", parentCallId: "a1", title: "Nested" }),
      live("agent.completed", { turnId: "t1", callId: "a1", ok: true }),
    ])
    expect(kinds(timeline)).toEqual(["user", "reasoning", "plan", "tool", "tool", "notice"])
    const reasoning = timeline.items[1]
    expect(reasoning?.kind === "reasoning" ? reasoning.text : "").toBe("thinking")
    expect(latestPlan(timeline)?.steps.length).toBe(2)
    const nested = timeline.items[4]
    expect(nested?.kind === "tool" ? nested.parentCallId : undefined).toBe("a1")
    timeline = applyFrames(timeline, [event("assistant.delta", { turnId: "t1", text: "done" })])
    const closed = timeline.items[1]
    expect(closed?.kind === "reasoning" && !closed.streaming).toBe(true)
  })

  test("a refused reasoning level is one notice row; an unknown code or level is rejected", () => {
    reset()
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "go" }),
      live("model.notice", { turnId: "t1", code: "THINKING_REFUSED", thinking: "high" }),
      live("model.notice", { turnId: "t1", code: "OTHER", thinking: "high" }),
      live("model.notice", { turnId: "t1", code: "THINKING_REFUSED", thinking: "persistent" }),
    ])
    expect(kinds(timeline)).toEqual(["user", "notice"])
    expect(timeline.items[1]).toMatchObject({ kind: "notice", level: "info", code: "thinking.refused", name: "high" })
    expect(timeline.counters.rejected).toBe(2)
  })

  test("a refused request is one notice in the engine's words; a reload shows the recorded one once", () => {
    reset()
    const message = "Runrail refused a Codex request to run a command: it came from a Codex thread that is not this session's or one of its sub-agents."
    const refused = live("request.refused", { turnId: "t1", source: "codex", message })
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "go" }),
      refused,
      live("request.refused", { source: "claude-code", message: "Runrail refused a Claude Code request." }),
      live("request.refused", { turnId: "t1", source: "gemini", message }),
      live("request.refused", { turnId: "t1", source: "codex", message: "" }),
      live("request.refused", { turnId: "t1", source: "codex", message: "x".repeat(1_025) }),
    ])
    expect(kinds(timeline)).toEqual(["user", "notice", "notice"])
    expect(timeline.items[1]).toMatchObject({ kind: "notice", level: "info", code: "request.refused", name: "codex", message })
    expect(timeline.items[2]).toMatchObject({ code: "request.refused", name: "claude-code" })
    expect(noticeCopy(timeline.items[1] as NoticeItem)).toBe(message)
    expect(timeline.counters.rejected).toBe(3)

    // The engine recorded the same refusal: its record replaces the live row, and the frame sent again is a duplicate.
    timeline = loadHistory(timeline, [
      { id: "1", seq: 0, at: 1, turnId: "t1", kind: "user", text: "go" },
      { id: "2", seq: 0, at: 2, turnId: "t1", kind: "notice", level: "info", code: "request.refused", name: "codex", message },
    ], false, true)
    timeline = applyFrames(timeline, [refused])
    expect(kinds(timeline)).toEqual(["user", "notice"])
    expect(timeline.items[1]).toMatchObject({ code: "request.refused", name: "codex", message })
    expect(timeline.counters.duplicates).toBe(1)
  })

  test("Claude Code's retries of one request count up in one row, and the recorded row reads the same", () => {
    reset()
    const retry = (attempt: number, fields: Record<string, unknown> = {}) => live("api.retry", { turnId: "t1", source: "claude-code", attempt, maxRetries: 10, delayMs: 600 * attempt, status: 529, error: "overloaded", ...fields })
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "go" }),
      retry(1),
      retry(2),
      retry(3, { status: 1_000, error: "Some Words" }),
      event("assistant.delta", { turnId: "t1", text: "ok" }),
      retry(1, { maxRetries: 1, delayMs: 0, status: undefined, error: "unknown", waitedMs: 30_000 }),
      live("api.retry", { turnId: "t1", source: "codex", attempt: 2, maxRetries: 10, delayMs: 0 }),
    ])
    expect(kinds(timeline)).toEqual(["user", "notice", "assistant", "notice"])
    const [first, second] = [timeline.items[1] as NoticeItem, timeline.items[3] as NoticeItem]
    expect(first).toMatchObject({ code: "api.retry", name: "claude-code", retry: { attempt: 3, maxRetries: 10, delayMs: 1_800 } })
    expect(first.retry).not.toHaveProperty("status")
    expect(noticeCopy(first)).toBe("Claude Code retried after 2s, attempt 3 of 10: the request got no answer.")
    expect(noticeCopy({ ...first, retry: { attempt: 2, maxRetries: 10, delayMs: 1_200, status: 529, error: "overloaded" } })).toBe("Claude Code retried after 1s, attempt 2 of 10: the API was overloaded (status 529).")
    expect(noticeCopy(second)).toBe("Claude Code retried at once, attempt 1 of 1: the API sent nothing for 30s.")
    expect(timeline.counters.rejected).toBe(1)

    timeline = loadHistory(timeline, [
      { id: "1", seq: 0, at: 1, turnId: "t1", kind: "user", text: "go" },
      { id: "2", seq: 1, at: 2, turnId: "t1", kind: "notice", level: "info", code: "api.retry", name: "claude-code", retry: { attempt: 2, maxRetries: 10, delayMs: 1_200, status: 529, error: "overloaded" } },
    ], false, true)
    expect(timeline.items[1]).toMatchObject({ code: "api.retry", retry: { attempt: 2, status: 529, error: "overloaded" } })
    // A retry after the reload still counts up in the recorded row.
    timeline = applyFrames(timeline, [retry(3)])
    expect(kinds(timeline)).toEqual(["user", "notice"])
    expect(timeline.items[1]).toMatchObject({ retry: { attempt: 3 } })
  })

  test("a steer read back from history keeps its tag", () => {
    const timeline = loadHistory(emptyTimeline(), [
      { id: "1", seq: 0, at: 1, kind: "user", text: "fix it" },
      { id: "2", seq: 1, at: 2, kind: "user", text: "use tabs", steer: true },
    ], false)
    expect(timeline.items.map((item) => (item.kind === "user" ? [item.text, item.steer === true] : item.kind))).toEqual([["fix it", false], ["use tabs", true]])
  })

  test("history and live epochs never collide", () => {
    reset()
    let timeline = loadHistory(
      emptyTimeline(),
      [
        { id: "1", seq: 0, at: 1, kind: "user", text: "old\n\n[Runrail attachment: x]" },
        { id: "2", seq: 1, at: 2, kind: "tool", callId: "c1", name: "run_command", presentation: { kind: "shell", title: "ls" }, status: "running" },
        { id: "3", seq: 2, at: 3, kind: "notice", level: "info", code: "stopped" },
        { id: "4", seq: 3, at: 4, kind: "unknown" },
      ],
      false,
    )
    expect(kinds(timeline)).toEqual(["user", "tool", "notice"])
    const tool = timeline.items[1]
    expect(tool?.kind === "tool" && tool.status === "failed").toBe(true)
    expect(timeline.items[0]?.kind === "user" ? timeline.items[0].text : "").toBe("old")
    timeline = beginEpoch(timeline)
    timeline = applyFrames(timeline, [event("turn.started", { turnId: "t9", prompt: "new" })])
    expect(kinds(timeline)).toEqual(["user", "tool", "notice", "user"])
    expect(new Set(timeline.items.map((item) => item.key)).size).toBe(4)
  })

  test("history from an engine still in its turn keeps the open work live", () => {
    reset()
    const items = [
      { id: "1", seq: 0, at: 1, turnId: "t1", kind: "user", text: "first" },
      { id: "2", seq: 1, at: 2, turnId: "t1", kind: "tool", callId: "c0", name: "run_command", presentation: { kind: "shell", title: "ls" }, status: "running" },
      { id: "3", seq: 2, at: 3, turnId: "t2", kind: "user", text: "write it" },
      { id: "4", seq: 3, at: 4, turnId: "t2", kind: "tool", callId: "c1", name: "write_file", presentation: { kind: "write", title: "NOTES.md" }, status: "running" },
      { id: "5", seq: 4, at: 5, turnId: "t2", kind: "approval", approvalId: "a1", action: "write_file", capability: "fs.write", status: "pending" },
    ]
    const stale = loadHistory(emptyTimeline(), items, false)
    expect(isBusy(stale)).toBe(false)
    expect(stale.items[4]?.kind === "approval" && stale.items[4].status === "rejected").toBe(true)

    let timeline = beginEpoch(loadHistory(emptyTimeline(), items, false, true))
    expect(timeline.status).toBe("waiting")
    expect(timeline.activeTurnId).toBe("t2")
    expect(timeline.turnStartedAt).toBe(3)
    const earlier = timeline.items[1]
    expect(earlier?.kind === "tool" && earlier.status === "failed").toBe(true)
    const gate = timeline.items[3]
    const approval = timeline.items[4]
    expect(gate?.kind === "tool" && gate.status === "running").toBe(true)
    expect(approval?.kind === "approval" && approval.status === "pending" && approval.callKey === gate?.key).toBe(true)

    timeline = applyFrames(timeline, [event("approval.resolved", { turnId: "t2", approvalId: "a1", approved: true })])
    const resolved = timeline.items[4]
    expect(resolved?.kind === "approval" && resolved.status === "approved").toBe(true)
    expect(timeline.status).toBe("running")
  })

  test("engine exit fails running work and a failed send is marked", () => {
    reset()
    const pending = addPendingUser(emptyTimeline(), { text: "go", attachments: 0 })
    let timeline = markUser(pending.timeline, pending.key, "failed", "ENGINE_UNAVAILABLE")
    const user = timeline.items[0]
    expect(user?.kind === "user" && user.state === "failed" && user.errorCode === "ENGINE_UNAVAILABLE").toBe(true)
    timeline = applyFrames(timeline, [
      event("turn.started", { turnId: "t1", prompt: "again" }),
      event("tool.started", { turnId: "t1", callId: "c1", name: "run_command" }),
    ])
    timeline = markEngineExited(timeline, 5_000)
    expect(isBusy(timeline)).toBe(false)
    expect(timeline.items.at(-1)?.kind).toBe("notice")
  })

  test("displayPrompt strips appended attachment bodies", () => {
    expect(displayPrompt("look\n\n[Runrail reference: a.ts]\n...")).toBe("look")
    expect(displayPrompt("plain")).toBe("plain")
  })

  test("history keeps the route that handled each turn after a model switch", () => {
    const items = [
      { id: "u1", seq: 0, at: 1_000, turnId: "t1", kind: "user", text: "first" },
      { id: "a1", seq: 1, at: 2_000, turnId: "t1", kind: "assistant", text: "done", partial: false },
      { id: "u2", seq: 2, at: 3_000, turnId: "t2", kind: "user", text: "second" },
      { id: "a2", seq: 3, at: 4_000, turnId: "t2", kind: "assistant", text: "done", partial: false },
    ]
    const timeline = loadHistory(emptyTimeline(), items, false, false, { backend: "claude-code", model: "claude-opus-5-5" }, [
      { turnId: "t1", backend: "codex", model: "gpt-5.5" },
      { turnId: "t2", backend: "claude-code", model: "claude-opus-5-5" },
    ])
    const ends = timeline.items.filter((item): item is TurnEndItem => item.kind === "turn-end")
    expect(ends.map((item) => ({ turnId: item.turnId, backend: item.backend, model: item.model }))).toEqual([
      { turnId: "t1", backend: "codex", model: "gpt-5.5" },
      { turnId: "t2", backend: "claude-code", model: "claude-opus-5-5" },
    ])
  })
})

describe("a finished turn's check result", () => {
  test("goes above a queued message sent the moment the turn ended, and after its answer", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "alpha" }),
      event("assistant.message", { turnId: "t1", text: "ALPHA" }),
      event("session.completed", { snapshot: { id: "s", backend: "codex", status: "idle" } }),
    ])
    timeline = addPendingUser(timeline, { text: "beta", attachments: 0 }).timeline
    timeline = applyFrames(timeline, [event("verification.completed", { ok: true, name: "check", report: {} })])
    const kinds = timeline.items.map((item) => item.kind === "notice" ? `notice:${item.code ?? ""}` : item.kind)
    expect(kinds.slice(-4)).toEqual(["assistant", "turn-end", "notice:verification.passed", "user"])
    expect(timeline.items.every((item, position) => timeline.index.get(item.key) === position)).toBe(true)
  })

  test("inside a running turn stays where it arrives", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [event("turn.started", { turnId: "t2", prompt: "go" })])
    timeline = addPendingUser(timeline, { text: "steer", attachments: 0, steer: true }).timeline
    timeline = applyFrames(timeline, [event("verification.completed", { turnId: "t2", ok: false, name: "check", report: {} })])
    expect(timeline.items[timeline.items.length - 1]).toMatchObject({ kind: "notice", code: "verification.failed" })
  })
})

describe("history turns", () => {
  test("a finished turn gets a turn end so it folds, and an interrupted or stopped one does not", () => {
    const items = [
      { id: "1", seq: 0, at: 1_000, turnId: "t1", kind: "user", text: "fix it" },
      { id: "2", seq: 1, at: 2_000, turnId: "t1", kind: "tool", callId: "c1", name: "read_file", presentation: { kind: "read", title: "a.ts" }, status: "ok" },
      { id: "3", seq: 2, at: 9_000, turnId: "t1", kind: "assistant", text: "Fixed." },
      { id: "4", seq: 3, at: 10_000, turnId: "t2", kind: "user", text: "and this" },
      { id: "5", seq: 4, at: 11_000, turnId: "t2", kind: "notice", level: "info", code: "TURN_CANCELLED" },
      { id: "6", seq: 5, at: 12_000, turnId: "t3", kind: "user", text: "again" },
      { id: "7", seq: 6, at: 13_000, turnId: "t3", kind: "tool", callId: "c2", name: "run_command", presentation: { kind: "shell", title: "ls" }, status: "running" },
    ]
    const timeline = loadHistory(emptyTimeline(), items, false)
    const ends = timeline.items.filter((item) => item.kind === "turn-end")
    expect(ends).toEqual([{ kind: "turn-end", key: "h.end.t1", turnId: "t1", status: "completed", startedAt: 1_000, endedAt: 9_000 }])
    expect(timeline.items.findIndex((item) => item.kind === "turn-end")).toBe(3)
    // History turn ends never count as a turn that just ended.
    expect(timeline.lastTurnEnd).toBeUndefined()
  })
})

describe("a coding tool's own reviewer", () => {
  const reviewed = (fields: Record<string, unknown>) => live("approval.reviewed", { turnId: "t1", reviewer: "codex", action: "command", capability: "process.exec", ...fields })

  test("one row per review that its decision updates; a late start never takes the decision back", () => {
    reset()
    const timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "fetch it" }),
      reviewed({ reviewId: "codex-r1", decision: "reviewing", detail: "curl https://example.com" }),
      live("reviewer.notice", { turnId: "t1", reviewer: "codex", notice: "warning", message: "Checking the request" }),
      reviewed({ reviewId: "codex-r1", decision: "approved", risk: "low", rationale: "Reads a public page." }),
      reviewed({ reviewId: "codex-r1", decision: "reviewing" }),
      reviewed({ reviewId: "claude-denied-toolu_1", reviewer: "claude-code", decision: "denied", source: "reviewer", detail: "git push --force", risk: "extreme" }),
      reviewed({ reviewId: "codex-r2", reviewer: "gemini", decision: "approved" }),
      event("session.stopped", {}),
    ])
    expect(kinds(timeline)).toEqual(["user", "review", "notice", "review", "turn-end"])
    expect(timeline.items[1]).toMatchObject({ kind: "review", reviewId: "codex-r1", decision: "approved", risk: "low", detail: "curl https://example.com", rationale: "Reads a public page.", at: 1_001 })
    expect(timeline.items[2]).toMatchObject({ kind: "notice", level: "info", code: "reviewer.warning", name: "codex", message: "Checking the request" })
    // A risk level the desktop does not know is dropped, not the row.
    expect(timeline.items[3]).toMatchObject({ kind: "review", reviewer: "claude-code", decision: "denied", source: "reviewer" })
    expect(timeline.items[3]).not.toHaveProperty("risk")
    expect(timeline.counters.rejected).toBe(1)
  })

  test("a review open when its turn ends reads as stopped; an open turn's review from history stays live", () => {
    reset()
    const ended = applyFrames(emptyTimeline(), [event("turn.started", { turnId: "t1", prompt: "go" }), reviewed({ reviewId: "codex-r1", decision: "reviewing" }), event("session.stopped", {})])
    expect(ended.items[1]).toMatchObject({ kind: "review", decision: "aborted" })

    const items = [
      { id: "1", seq: 0, at: 1, turnId: "t2", kind: "user", text: "write it" },
      { id: "2", seq: 1, at: 2, turnId: "t2", kind: "review", reviewId: "codex-r9", reviewer: "codex", decision: "reviewing", action: "file_change", capability: "filesystem.write", detail: "a.ts" },
      { id: "3", seq: 2, at: 3, turnId: "t2", kind: "notice", level: "info", code: "reviewer.unavailable", name: "claude-code", message: "kept" },
    ]
    expect(loadHistory(emptyTimeline(), items, false).items[1]).toMatchObject({ decision: "aborted" })
    let timeline = beginEpoch(loadHistory(emptyTimeline(), items, false, true))
    expect(timeline.items[1]).toMatchObject({ decision: "reviewing" })
    expect(timeline.items[2]).toMatchObject({ code: "reviewer.unavailable", name: "claude-code", message: "kept" })
    timeline = applyFrames(timeline, [live("approval.reviewed", { turnId: "t2", reviewId: "codex-r9", reviewer: "codex", decision: "denied", action: "file_change", capability: "filesystem.write", risk: "high" })])
    expect(kinds(timeline)).toEqual(["user", "review", "notice"])
    expect(timeline.items[1]).toMatchObject({ decision: "denied", risk: "high", detail: "a.ts" })
  })

  test("reviews arrive as the engine's live frames, and a reload keeps each one once", () => {
    reset()
    // The engine's shape: no event seq, only the live cursor and the event seq it came after.
    const frame = (type: string, fields: Record<string, unknown>): StreamFrame => {
      const sent = live(type, fields)
      return { kind: "live", data: { ...(sent.data as Record<string, unknown>), afterSeq: 1 } }
    }
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "fetch it" }),
      frame("reviewer.notice", { turnId: "t1", reviewer: "codex", notice: "warning", message: "Checking the request" }),
      reviewed({ reviewId: "codex-r1", decision: "reviewing", detail: "curl https://example.com" }),
    ])
    expect(kinds(timeline)).toEqual(["user", "notice", "review"])
    expect(timeline.counters).toMatchObject({ live: 2, rejected: 0 })
    // The protocol's own event union has no review, so one sent as an event is not shown.
    expect(applyFrames(timeline, [event("approval.reviewed", { turnId: "t1", reviewId: "codex-r2", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec" })]).counters.rejected).toBe(1)

    const history = [
      { id: "1", seq: 0, at: 1, turnId: "t1", kind: "user", text: "fetch it" },
      { id: "2", seq: 1, at: 2, turnId: "t1", kind: "notice", level: "info", code: "reviewer.warning", name: "codex", message: "Checking the request" },
      { id: "3", seq: 1, at: 3, turnId: "t1", kind: "review", reviewId: "codex-r1", reviewer: "codex", decision: "reviewing", action: "command", capability: "process.exec", detail: "curl https://example.com" },
    ]
    timeline = loadHistory(timeline, history, false, true)
    expect(timeline.lastLiveSeq).toBe(2)
    // A replay of what the history already holds is dropped; the decision updates the row history rebuilt.
    timeline = applyFrames(timeline, [
      { kind: "live", data: { version: 1, sessionId: "s", liveSeq: 1, at: 1_001, afterSeq: 1, type: "reviewer.notice", reviewer: "codex", notice: "warning", message: "Checking the request" } },
      { kind: "live", data: { version: 1, sessionId: "s", liveSeq: 2, at: 1_002, afterSeq: 1, type: "approval.reviewed", turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "reviewing", action: "command", capability: "process.exec" } },
      reviewed({ reviewId: "codex-r1", decision: "approved", risk: "low", rationale: "Reads a public page." }),
    ])
    expect(kinds(timeline)).toEqual(["user", "notice", "review"])
    expect(timeline.items[2]).toMatchObject({ key: "h.3", decision: "approved", risk: "low", detail: "curl https://example.com", at: 3 })
    expect(timeline.counters.duplicates).toBe(2)
  })
})

describe("a long timeline", () => {
  test("cutting the oldest rows also forgets the calls, approvals, reasoning and lineage that pointed at them", () => {
    reset()
    let timeline = applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: "go" }),
      live("lineage", { parentCallId: "p0", callId: "c1" }),
      event("tool.started", { turnId: "t1", callId: "c1", name: "run_command" }),
      event("approval.required", { turnId: "t1", approvalId: "a1", action: "rm -rf build", capability: "shell" }),
      live("reasoning.delta", { turnId: "t1", itemId: "r1", text: "thinking" }),
    ])
    expect([timeline.calls.has("c1"), timeline.approvals.has("a1"), timeline.reasoning.size, timeline.lineage.has("c1")]).toEqual([true, true, 1, true])
    const filler = Array.from({ length: 20_000 }, () => live("api.retry", { turnId: "t1", source: "claude-code", attempt: 1, maxRetries: 10, delayMs: 0 }))
    timeline = applyFrames(timeline, filler)
    expect(timeline.items).toHaveLength(20_000)
    expect(timeline.historyTruncated).toBe(true)
    expect([timeline.calls.has("c1"), timeline.approvals.has("a1"), timeline.reasoning.size, timeline.lineage.has("c1")]).toEqual([false, false, 0, false])
    expect(timeline.index.size).toBe(20_000)
    // A call that starts after the cut is tracked as before.
    timeline = applyFrames(timeline, [event("tool.started", { turnId: "t1", callId: "c2", name: "run_command" })])
    expect(timeline.items[timeline.index.get(timeline.calls.get("c2") ?? "") ?? -1]).toMatchObject({ kind: "tool", callId: "c2" })
  })

  test("a batch shares the maps it does not change and never changes the timeline it started from", () => {
    reset()
    const before = applyFrames(emptyTimeline(), [event("turn.started", { turnId: "t1", prompt: "go" }), event("assistant.delta", { turnId: "t1", text: "Hel" })])
    const streamed = applyFrames(before, [event("assistant.delta", { turnId: "t1", text: "lo" })])
    expect(streamed.calls).toBe(before.calls)
    expect(streamed.index).toBe(before.index)
    expect(streamed.items).not.toBe(before.items)
    expect(before.items.find((item) => item.kind === "assistant")).toMatchObject({ text: "Hel", streaming: true })
    expect(streamed.items.find((item) => item.kind === "assistant")).toMatchObject({ text: "Hello", streaming: true })
    const called = applyFrames(streamed, [event("tool.started", { turnId: "t1", callId: "c1", name: "run_command" })])
    expect(called.calls.has("c1")).toBe(true)
    expect([streamed.calls.has("c1"), streamed.items.length, streamed.index.size]).toEqual([false, 2, 2])
    expect(streamed.items.find((item) => item.kind === "assistant")).toMatchObject({ streaming: true })
  })
})
