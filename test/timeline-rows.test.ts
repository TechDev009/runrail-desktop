import { describe, expect, test } from "bun:test"
import type { TimelineItem, ToolItem } from "../src/thread/reducer"
import { buildRows, rowIndex, type Row } from "../src/ui/thread/Timeline"
import { reasoningLabel, reviewTitle, stepsSummary, toolTitle } from "../src/ui/thread/rows"

const user = (key: string): TimelineItem => ({ kind: "user", key, text: "go", state: "sent", attachments: 0, at: 0 }) as unknown as TimelineItem
const said = (key: string, text: string, turnId = "t1"): TimelineItem => ({ kind: "assistant", key, turnId, text, streaming: false, at: 1 }) as TimelineItem
const tool = (key: string, kind: string, extra: Partial<ToolItem> = {}): ToolItem =>
  ({ kind: "tool", key, callId: key, turnId: "t1", name: kind, presentation: { kind, title: kind === "shell" ? "Run git status" : `List ${key}` }, status: "completed", at: 1, ...extra }) as unknown as ToolItem
const end = (status = "completed", turnId = "t1"): TimelineItem => ({ kind: "turn-end", key: `end:${turnId}`, turnId, status, startedAt: 0, endedAt: 47_000 }) as TimelineItem
const plan = (key: string, done: number): ToolItem =>
  tool(key, "plan", { presentation: { kind: "plan", title: "Update plan", plan: [{ text: "a", status: done > 0 ? "completed" : "in_progress" }, { text: "b", status: done > 1 ? "completed" : "pending" }] } } as unknown as Partial<ToolItem>)

const shapes = (rows: readonly Row[]): string[] => rows.map((row) => (row.type === "item" ? row.item.kind : row.type))

describe("timeline rows", () => {
  test("a finished turn folds its work above the answer, which stays in view", () => {
    const rows = buildRows([user("u"), said("a1", "Looking around."), tool("x", "shell"), tool("y", "shell"), said("a2", "Done."), end()], false, false, false)
    expect(shapes(rows)).toEqual(["user", "work", "assistant", "turn-end"])
    const work = rows[1] as Row & { type: "work" }
    expect(work).toMatchObject({ steps: 2, took: 47_000 })
    expect(shapes(work.rows)).toEqual(["assistant", "steps"])
    expect(rows[3]).toMatchObject({ folded: true })
  })

  test("browser actions keep their own rows; reads and web lookups still group", () => {
    const items = [user("u"), tool("a", "web", { name: "browser_open" }), tool("b", "web", { name: "mcp__runrail_browser__browser_click" }), tool("c", "web", { name: "web_fetch" }), tool("d", "read")]
    const rows = buildRows(items, false, false, true)
    expect(shapes(rows)).toEqual(["user", "tool", "tool", "steps", "footer"])
    expect((rows[3] as Row & { type: "steps" }).items.map((item) => item.key)).toEqual(["c", "d"])
  })

  test("consecutive commands, reads and edits fold into one run; commentary ends it", () => {
    const items = [user("u"), tool("a", "shell"), tool("b", "read"), tool("c", "edit"), tool("d", "shell"), said("n", "Now the tests."), tool("e", "shell"), tool("f", "shell")]
    const rows = buildRows(items, false, false, true)
    expect(shapes(rows)).toEqual(["user", "steps", "assistant", "steps", "footer"])
    expect((rows[1] as Row & { type: "steps" }).items.map((item) => item.key)).toEqual(["a", "b", "c", "d"])
  })

  test("a push, a PR, a subagent, a proposed plan and a failure to act on keep their own rows; approvals stay marked", () => {
    const push = tool("p", "shell", { presentation: { kind: "shell", title: "Run git push", intent: "push" } } as Partial<ToolItem>)
    const pr = tool("q", "shell", { presentation: { kind: "shell", title: "Run gh pr create", intent: "pr" } } as Partial<ToolItem>)
    const auth = tool("x", "shell", { status: "failed", errorCode: "AUTH_REQUIRED" })
    const agent = tool("g", "agent", { agent: { title: "Scan" } })
    const approved = { kind: "approval", key: "ap", approvalId: "1", action: "bun test", capability: "process", status: "approved", callKey: "b", at: 1 } as TimelineItem
    const proposal = tool("o", "plan", { presentation: { kind: "plan", title: "Propose plan", content: "1. Do it" } } as Partial<ToolItem>)
    const items = [user("u"), tool("a", "shell"), tool("b", "shell"), approved, push, tool("c", "read"), tool("d", "read"), pr, auth, agent, proposal, tool("e", "shell")]
    const rows = buildRows(items, false, false, true)
    expect(shapes(rows)).toEqual(["user", "steps", "tool", "steps", "tool", "tool", "tool", "tool", "tool", "footer"])
    expect([...(rows[1] as Row & { type: "steps" }).approved]).toEqual(["b"])
  })

  test("find opens the run and the fold an item sits in", () => {
    const rows = buildRows([user("u"), tool("a", "shell"), tool("b", "read"), said("s", "Done."), end()], false, false, false)
    expect(rowIndex(rows).get("b")).toEqual({ index: 1, turnId: "t1", group: "x:a" })
  })

  test("a run says what it did, with the latest result of each check", () => {
    const check = (key: string, intent: string, status: string): ToolItem => tool(key, "shell", { status, presentation: { kind: "shell", title: "Run bun test", intent } } as unknown as Partial<ToolItem>)
    const items = [
      check("t1", "test", "failed"),
      tool("r", "read"),
      tool("s1", "search"),
      tool("s2", "list"),
      tool("e1", "edit", { presentation: { kind: "edit", title: "Edit a.ts", path: "a.ts", additions: 3, deletions: 1 } } as Partial<ToolItem>),
      tool("e2", "edit", { presentation: { kind: "edit", title: "Edit a.ts", path: "a.ts", additions: 2, deletions: 0 } } as Partial<ToolItem>),
      check("t2", "test", "completed"),
      check("b", "build", "failed"),
      tool("x", "shell", { status: "failed" }),
      tool("stop", "shell", { status: "failed", errorCode: "INTERRUPTED" }),
      tool("m", "mcp"),
    ]
    expect(stepsSummary(items)).toEqual({
      text: "Ran 5 commands, read 1 file, searched twice, edited 1 file, used 1 tool",
      outcomes: [{ label: "tests passed", ok: true }, { label: "build failed", ok: false }],
      failed: 1,
      additions: 5,
      deletions: 1,
      kinds: ["shell", "read", "search", "list", "edit", "mcp"],
    })
    expect(stepsSummary([tool("s", "search")]).text).toBe("Searched once")
  })

  test("a running turn shows its work and finished turns fold it", () => {
    expect(shapes(buildRows([user("u"), tool("x", "shell"), said("a", "so far")], false, false, true))).toEqual(["user", "tool", "assistant", "footer"])
    expect(shapes(buildRows([user("u"), tool("x", "shell"), said("a", "partial"), end("failed")], false, false, false))).toEqual(["user", "work", "assistant", "turn-end"])
    expect(shapes(buildRows([user("u"), tool("x", "shell"), end("stopped")], false, false, false))).toEqual(["user", "work", "turn-end"])
  })

  test("errors and check results stay out of the fold", () => {
    const failed = { kind: "notice", key: "n", level: "error", code: "TOOL_FAILED", at: 1 } as TimelineItem
    expect(shapes(buildRows([user("u"), tool("x", "shell"), failed, said("a", "Done."), end()], false, false, false))).toEqual(["user", "work", "notice", "assistant", "turn-end"])
  })

  test("a turn's plan shows once, with its latest steps, and not while that turn runs", () => {
    const items = [user("u"), plan("p1", 0), tool("x", "shell"), plan("p2", 2)]
    const settled = buildRows(items, false, false, false)
    expect(shapes(settled)).toEqual(["user", "plan", "tool"])
    expect(settled[1]).toMatchObject({ item: { steps: [{ status: "completed" }, { status: "completed" }] } })
    expect(shapes(buildRows(items, false, false, true, "t1"))).toEqual(["user", "tool", "footer"])
  })

  test("an answered approval marks its call instead of adding a line; a waiting one stands in for its call", () => {
    const approved = { kind: "approval", key: "ap", approvalId: "1", action: "git status", capability: "process", status: "approved", callKey: "x", at: 1 } as TimelineItem
    const rows = buildRows([user("u"), tool("x", "shell"), approved], false, false, true)
    expect(shapes(rows)).toEqual(["user", "tool", "footer"])
    expect(rows[1]).toMatchObject({ approved: true })
    const pending = { ...approved, status: "pending" } as TimelineItem
    expect(shapes(buildRows([user("u"), tool("x", "shell", { status: "running" }), pending], false, false, false))).toEqual(["user", "approval"])
  })

  test("tool titles follow the call: running, done, or failed", () => {
    expect(toolTitle(tool("x", "shell", { status: "running" }))).toBe("Running git status")
    expect(toolTitle(tool("x", "shell"))).toBe("Ran git status")
    expect(toolTitle(tool("x", "shell", { status: "failed" }))).toBe("Run git status")
    expect(toolTitle(tool("src", "list"))).toBe("Listed src")
  })

  test("a thought under a second says only that it thought", () => {
    expect(reasoningLabel({ kind: "reasoning", key: "r", text: "x", streaming: false, at: 0, endedAt: 400 })).toBe("Thought")
    expect(reasoningLabel({ kind: "reasoning", key: "r", text: "x", streaming: false, at: 0, endedAt: 2_400 })).toBe("Thought for 2s")
    expect(reasoningLabel({ kind: "reasoning", key: "r", text: "x", streaming: true, at: 0 })).toBe("Thinking")
  })
})

describe("a coding tool's own reviewer in the timeline", () => {
  const review = (key: string, fields: Record<string, unknown>): TimelineItem => ({ kind: "review", key, turnId: "t1", reviewId: key, reviewer: "codex", action: "command", capability: "process.exec", at: 1, ...fields }) as unknown as TimelineItem
  const notice = (key: string, code: string): TimelineItem => ({ kind: "notice", key, level: "info", code, at: 1 }) as TimelineItem

  test("a call it stopped and a reviewer that is off stay out of the fold; an approval and a warning fold", () => {
    const items = [user("u"), tool("x", "shell"), review("r1", { decision: "approved" }), review("r2", { decision: "denied" }), review("r3", { decision: "timed-out" }), notice("n1", "reviewer.unavailable"), notice("n2", "reviewer.warning"), said("a", "Done."), end()]
    const rows = buildRows(items, false, false, false)
    expect(shapes(rows)).toEqual(["user", "work", "review", "review", "notice", "assistant", "turn-end"])
    const work = rows[1]
    expect(work?.type === "work" ? shapes(work.rows) : []).toEqual(["tool", "review", "notice"])
  })

  test("says who decided, and what, when the row cannot name the call", () => {
    const title = (fields: Record<string, unknown>) => reviewTitle(review("r", fields) as Parameters<typeof reviewTitle>[0])
    expect(title({ decision: "approved", detail: "curl https://example.com" })).toBe("Codex's reviewer approved")
    expect(title({ decision: "reviewing", detail: "ls" })).toBe("Codex's reviewer is checking")
    expect(title({ decision: "denied", capability: "filesystem.write" })).toBe("Codex's reviewer denied a file change")
    expect(title({ decision: "timed-out", capability: "tool.use" })).toBe("Codex's reviewer ran out of time on a tool call")
    expect(title({ reviewer: "claude-code", decision: "denied", source: "reviewer", detail: "git push" })).toBe("Claude Code's auto mode denied")
    expect(title({ reviewer: "claude-code", decision: "denied", source: "rule", detail: "rm -rf /" })).toBe("A Claude Code rule denied")
    expect(title({ reviewer: "claude-code", decision: "denied", source: "mode", capability: "network.request" })).toBe("Claude Code's mode denied a network request")
    expect(title({ reviewer: "claude-code", decision: "denied", detail: "x" })).toBe("Claude Code denied")
  })
})
