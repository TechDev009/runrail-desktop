import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { noteBackgroundFrames, backgroundOf, useBackground } from "../src/app/background"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, parseFrames, type ToolItem } from "../src/thread/reducer"
import { AgentTranscript, ReasoningRow, ToolRow } from "../src/ui/thread/rows"
import { AgentActivitySummary, buildRows } from "../src/ui/thread/Timeline"

const event = (seq: number, type: string, fields: Record<string, unknown>): StreamFrame => ({ kind: "event", data: { version: 1, sessionId: "s", seq, at: 100 + seq, type, ...fields } })
const live = (liveSeq: number, type: string, fields: Record<string, unknown>): StreamFrame => ({ kind: "live", data: { version: 1, sessionId: "s", liveSeq, at: 100 + liveSeq, type, ...fields } })

describe("agent visibility", () => {
  test("completion and agent messages stay visible after turn work folds", () => {
    const timeline = applyFrames(emptyTimeline(), [
      event(0, "turn.started", { turnId: "root", prompt: "Check parser" }),
      live(1, "agent.spawned", { turnId: "root", callId: "parser", title: "Parser agent" }),
      live(2, "lineage", { parentCallId: "parser", callId: "message" }),
      event(1, "tool.started", { turnId: "root", callId: "message", name: "SendMessage", input: {}, presentation: { kind: "other", title: "Message agent: Lexer", content: "Parser checks passed" } }),
      event(2, "tool.completed", { turnId: "root", callId: "message", name: "SendMessage", ok: true }),
      live(3, "agent.completed", { callId: "parser", ok: true }),
      live(4, "agent.completed", { callId: "parser", ok: true }),
      event(3, "turn.completed", { turnId: "root" }),
    ])
    const notices = buildRows(timeline.items, true, false, false).flatMap((row) => row.type === "item" && row.item.kind === "notice" ? [row.item] : [])
    expect(notices.map((notice) => notice.message)).toEqual(["Parser agent sent a message to Lexer: Parser checks passed", "Parser agent completed its work."])
    expect(timeline.items.filter((item) => item.kind === "notice" && item.code === "agent.completed")).toHaveLength(1)
  })
  test("child reasoning never merges with its parent's block and closes with the child", () => {
    let timeline = applyFrames(emptyTimeline(), [
      live(1, "reasoning.delta", { turnId: "root", text: "Parent thought" }),
      live(2, "reasoning.delta", { turnId: "root", parentCallId: "task-a", text: "Child thought" }),
      live(3, "agent.completed", { callId: "task-a", ok: true }),
    ])
    expect(timeline.items.filter((item) => item.kind === "reasoning")).toEqual([
      expect.objectContaining({ text: "Parent thought", streaming: true }),
      expect.objectContaining({ text: "Child thought", parentCallId: "task-a", streaming: false }),
    ])
    timeline = applyFrames(timeline, [live(4, "reasoning.delta", { turnId: "root", parentCallId: "task-a", text: "New child turn" })])
    expect(timeline.items.at(-1)).toMatchObject({ text: "New child turn", streaming: true })
  })

  test("interleaved child messages keep their lineage and appear inside their agent", () => {
    const timeline = applyFrames(emptyTimeline(), [
      event(0, "turn.started", { turnId: "root", prompt: "go" }),
      live(1, "agent.spawned", { turnId: "root", callId: "task-a", title: "Parser" }),
      live(2, "agent.spawned", { turnId: "root", callId: "task-b", title: "Lexer" }),
      live(3, "lineage", { parentCallId: "task-a", eventSeq: 1 }),
      event(1, "assistant.delta", { turnId: "child-a", text: "Checking " }),
      event(2, "assistant.delta", { turnId: "child-b", text: "Lexer report" }),
      live(4, "lineage", { parentCallId: "task-b", eventSeq: 2 }),
      live(5, "lineage", { parentCallId: "task-a", eventSeq: 3 }),
      event(3, "assistant.delta", { turnId: "child-a", text: "parser" }),
      live(6, "reasoning.delta", { turnId: "child-a", parentCallId: "task-a", text: "Look at grammar" }),
    ])
    const messages = timeline.items.filter((item) => item.kind === "assistant")
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ text: "Checking parser", parentCallId: "task-a" })
    expect(messages[1]).toMatchObject({ text: "Lexer report", parentCallId: "task-b" })
    const rows = buildRows(timeline.items, true, false, false, "root")
    expect(rows.some((row) => row.type === "item" && row.item.kind === "assistant")).toBe(false)
    const row = rows.find((item) => item.type === "tool" && item.item.callId === "task-a")
    expect(row?.type === "tool" ? row.children?.map((item) => item.kind) : []).toEqual(["assistant", "reasoning"])
    const html = renderToStaticMarkup(<AgentTranscript items={row?.type === "tool" ? row.children ?? [] : []} parentCallId="task-a" />)
    expect(html).toContain("Checking parser")
    expect(html).toContain("Thinking")
    expect(html).not.toContain("Lexer report")
  })

  test("a spawn call returning does not end the agent and completion settles stale Tasks entries", () => {
    useBackground.setState({}, true)
    const start = live(100, "background.state", { entry: { id: "agent-1", kind: "agent", callId: "spawn-1", label: "Parser", status: "running", stoppable: false, hasOutput: false } })
    const spawned = live(101, "agent.spawned", { turnId: "root", callId: "spawn-1", title: "Parser" })
    const timeline = applyFrames(emptyTimeline(), [start, spawned, event(0, "tool.completed", { turnId: "root", callId: "spawn-1", name: "collabAgentToolCall", ok: true })])
    expect(timeline.items.find((item) => item.kind === "tool")).toMatchObject({ status: "ok", agentStatus: "running" })
    noteBackgroundFrames("agent-test", parseFrames([start]))
    const done = live(102, "agent.completed", { callId: "spawn-1", ok: true })
    noteBackgroundFrames("agent-test", parseFrames([done, start]))
    expect(backgroundOf("agent-test").entries[0]?.status).toBe("completed")
    expect(applyFrames(timeline, [done]).items.find((item) => item.kind === "tool")).toMatchObject({ agentStatus: "ok" })
  })

  test("routine failures stay collapsed and rate limits and reviewer denials open", () => {
    const tool: ToolItem = { kind: "tool", key: "t", callId: "t", name: "command", presentation: { kind: "shell", title: "Run rg missing" }, status: "failed", errorCode: "CODEX_TOOL_FAILED", errorMessage: "No matches", at: 1 }
    expect(renderToStaticMarkup(<ToolRow item={tool} />)).toContain('aria-expanded="false"')
    expect(renderToStaticMarkup(<ToolRow item={{ ...tool, errorCode: "HARNESS_RATE_LIMITED" }} />)).toContain('aria-expanded="true"')
    expect(renderToStaticMarkup(<ToolRow item={{ ...tool, errorCode: "REVIEW_DENIED" }} />)).toContain('aria-expanded="true"')
    expect(renderToStaticMarkup(<ReasoningRow item={{ kind: "reasoning", key: "r", text: "Done thinking", streaming: false, at: 1 }} />)).toContain('aria-expanded="false"')
  })

  test("the thread reports spawned and running agents with a Tasks action", () => {
    const html = renderToStaticMarkup(<AgentActivitySummary threadId="t" agents={[{ id: "a", kind: "agent", status: "running", label: "Parser" }, { id: "b", kind: "agent", status: "completed", label: "Lexer" }]} />)
    expect(html).toContain("2 agents")
    expect(html).toContain("1 running")
    expect(html).toContain('aria-label="Open agents: 2 spawned, 1 running"')
  })
})
