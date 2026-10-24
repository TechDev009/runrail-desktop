import { beforeEach, describe, expect, test } from "bun:test"
import { backgroundOf, isRunning, noteBackgroundFrames, runningCount, useBackground } from "../src/app/background"
import { FINISHED_SHOWN, plainOutput, taskRows } from "../src/app/tasks"
import type { BackgroundEntry } from "../src/protocol/schemas"
import { parseFrames, type TimelineItem, type ToolItem } from "../src/thread/reducer"

function entry(id: string, fields: Partial<BackgroundEntry> = {}): BackgroundEntry {
  return { id, kind: "command", status: "running", label: `sleep ${id}`, stoppable: true, hasOutput: true, ...fields }
}

function agent(callId: string, fields: Partial<ToolItem> = {}): ToolItem {
  return { kind: "tool", key: `k-${callId}`, callId, name: "Task", presentation: { kind: "agent", title: `Agent ${callId}` }, status: "running", at: 10, agent: { title: `Agent ${callId}`, agentType: "explorer" }, ...fields } as ToolItem
}

function frame(liveSeq: number, value: BackgroundEntry) {
  return { kind: "live" as const, data: { type: "background.state", liveSeq, entry: value } }
}

describe("task rows", () => {
  test("running work comes first, agents before commands; finished rows are capped", () => {
    const finished = Array.from({ length: FINISHED_SHOWN + 3 }, (_, index) => entry(`done-${String(index)}`, { status: "completed", stoppable: false, endedAt: 100 + index }))
    const rows = taskRows([entry("cmd", { startedAt: 1 }), ...finished, entry("claude:task", { kind: "agent", label: "Review", startedAt: 5 })], [])
    expect(rows.running.map((row) => row.id)).toEqual(["claude:task", "cmd"])
    expect(rows.finished).toHaveLength(FINISHED_SHOWN)
    expect(rows.finished[0]?.id).toBe(`done-${String(FINISHED_SHOWN + 2)}`)
  })

  test("an engine entry stands for the timeline subagent it names; other subagents get their own row", () => {
    const items: TimelineItem[] = [agent("call-1"), agent("call-2", { status: "ok", endedAt: 50 })]
    const rows = taskRows([entry("claude:t1", { kind: "agent", label: "Explore", callId: "call-1", agentType: undefined })], items)
    expect(rows.running).toHaveLength(1)
    expect(rows.running[0]).toMatchObject({ id: "claude:t1", agentType: "explorer", startedAt: 10 })
    expect(rows.finished).toEqual([expect.objectContaining({ id: "call:call-2", status: "completed", label: "Agent call-2", endedAt: 50 })])
  })

  test("a command still tied to its turn is not listed until it detaches", () => {
    const tied = entry("claude:bash", { foreground: true })
    expect(isRunning(tied)).toBe(false)
    expect(taskRows([tied], []).running).toHaveLength(0)
    expect(taskRows([{ ...tied, foreground: false }], []).running).toHaveLength(1)
  })
})

describe("background frames", () => {
  beforeEach(() => useBackground.setState({}, true))

  test("frames add and update entries; an older frame does not undo a newer one", () => {
    noteBackgroundFrames("t1", parseFrames([frame(3, entry("a")), frame(4, entry("b"))]))
    expect(runningCount(backgroundOf("t1"))).toBe(2)
    noteBackgroundFrames("t1", parseFrames([frame(6, entry("a", { status: "stopped", stoppable: false })), frame(5, entry("a"))]))
    expect(backgroundOf("t1").entries.find((item) => item.id === "a")?.status).toBe("stopped")
    expect(runningCount(backgroundOf("t1"))).toBe(1)
  })

  test("malformed frames and other threads are left alone", () => {
    noteBackgroundFrames("t2", parseFrames([{ kind: "live", data: { type: "background.state", liveSeq: 1, entry: { id: "x", kind: "process", status: "running" } } }, { kind: "event", data: { type: "background.state" } }]))
    expect(backgroundOf("t2").entries).toHaveLength(0)
    expect(backgroundOf("t1").entries).toHaveLength(0)
  })
})

describe("command output", () => {
  test("terminal escapes go and a redrawn line keeps its last state", () => {
    expect(plainOutput("\u001b[32mready\u001b[0m in 300ms\n")).toBe("ready in 300ms\n")
    expect(plainOutput("progress 10%\rprogress 50%\rprogress 100%\ndone")).toBe("progress 100%\ndone")
    expect(plainOutput("line\r\nnext")).toBe("line\nnext")
    expect(plainOutput("\u001b]0;title\u0007bell\u0007 text\u0000")).toBe("bell text")
  })
})
