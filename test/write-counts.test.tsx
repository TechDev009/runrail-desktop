import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, loadHistory, type ToolItem } from "../src/thread/reducer"
import { ToolRow } from "../src/ui/thread/rows"

let seq = -1
function event(type: string, fields: Record<string, unknown>): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

const presentation = { kind: "write", title: "notes.txt", path: "notes.txt", content: "a\nB\nc\nd\n" }

function toolOf(frames: readonly StreamFrame[]): ToolItem {
  return applyFrames(emptyTimeline(), frames).items.find((item): item is ToolItem => item.kind === "tool")!
}

describe("a file write's line counts", () => {
  test("an overwrite shows what changed against the old file, not every line as new", () => {
    const tool = toolOf([
      event("turn.started", { turnId: "t1", prompt: "edit" }),
      event("tool.started", { turnId: "t1", callId: "w1", name: "write_file", presentation }),
      // The engine's own loop sends the result as JSON text.
      event("tool.completed", { turnId: "t1", callId: "w1", name: "write_file", ok: true, output: JSON.stringify({ path: "notes.txt", bytes: 8, created: false, additions: 2, deletions: 1 }) }),
    ])
    expect(tool).toMatchObject({ additions: 2, deletions: 1, created: false })
    const html = renderToStaticMarkup(<ToolRow item={tool} />)
    expect(html).toContain("+2")
    expect(html).toContain("-1")
    expect(html).not.toContain("+4")
  })

  test("a new file counts every line, and an older engine without counts still gets the shown diff's", () => {
    const created = toolOf([
      event("turn.started", { turnId: "t2", prompt: "edit" }),
      event("tool.started", { turnId: "t2", callId: "w2", name: "write_file", presentation }),
      event("tool.completed", { turnId: "t2", callId: "w2", name: "write_file", ok: true, output: { path: "notes.txt", bytes: 8, created: true, additions: 4, deletions: 0 } }),
    ])
    expect(renderToStaticMarkup(<ToolRow item={created} />)).toContain("+4")
    const older = toolOf([
      event("turn.started", { turnId: "t3", prompt: "edit" }),
      event("tool.started", { turnId: "t3", callId: "w3", name: "write_file", presentation }),
      event("tool.completed", { turnId: "t3", callId: "w3", name: "write_file", ok: true, output: { path: "notes.txt", bytes: 8 } }),
    ])
    expect(older.additions).toBeUndefined()
    expect(renderToStaticMarkup(<ToolRow item={older} />)).toContain("+4")
  })

  test("counts come back with the thread, and bad ones are refused", () => {
    const base = { id: "1", seq: 0, at: 1, turnId: "t", kind: "tool", callId: "w", name: "write_file", presentation, status: "ok" }
    const loaded = loadHistory(emptyTimeline(), [{ ...base, additions: 2, deletions: 1, created: false }], false)
    expect(loaded.items.find((item): item is ToolItem => item.kind === "tool")).toMatchObject({ additions: 2, deletions: 1, created: false })
    const bad = loadHistory(emptyTimeline(), [{ ...base, additions: -2, deletions: 1 }], false)
    expect(bad.items.find((item): item is ToolItem => item.kind === "tool")).toBeUndefined()
  })
})

describe("a coding tool's file change", () => {
  test("shows the counts and title the engine gave it", () => {
    const tool = toolOf([
      event("turn.started", { turnId: "t9", prompt: "edit" }),
      event("tool.started", { turnId: "t9", callId: "p1", name: "file_change", presentation: { kind: "patch", title: "Patch codex-check.txt", paths: ["codex-check.txt"], additions: 1, deletions: 0, content: "@@ -0,0 +1,1 @@\n+hello\n" } }),
      event("tool.completed", { turnId: "t9", callId: "p1", name: "file_change", ok: true, output: { status: "completed" } }),
    ])
    const html = renderToStaticMarkup(<ToolRow item={tool} />)
    expect(html).toContain("codex-check.txt")
    expect(html).toContain("+1")
    expect(html).not.toContain("/private")
  })

  test("a count out of range is dropped, not the row", () => {
    const tool = toolOf([
      event("turn.started", { turnId: "t10", prompt: "edit" }),
      event("tool.started", { turnId: "t10", callId: "p2", name: "file_change", presentation: { kind: "patch", title: "Patch a.txt", paths: ["a.txt"], additions: -3, deletions: 1.5 } }),
    ])
    expect(tool.presentation).toMatchObject({ kind: "patch", title: "Patch a.txt" })
    expect(tool.presentation.additions).toBeUndefined()
    expect(tool.presentation.deletions).toBeUndefined()
  })
})
