import { describe, expect, test } from "bun:test"
import { triageKey, waitingItems, type AttentionInput, type TriageKey, type WaitingItem } from "../src/app/attention"
import { DEFAULT_PREFS, parseState, type ThreadMeta } from "../src/app/persist"
import { emptyRuntime, get, threadOnScreen, type ThreadRuntime } from "../src/app/store"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, isBusy, pendingApprovals, type Timeline } from "../src/thread/reducer"

let seq = -1
let liveSeq = 0
function event(type: string, fields: Record<string, unknown> = {}, at = 1_000 + seq + 1): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at, type, ...fields } }
}
function live(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  liveSeq += 1
  return { kind: "live", data: { version: 1, sessionId: "s", liveSeq, at: 1_000 + liveSeq, type, ...fields } }
}

function thread(id: string, patch: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, projectId: "p1", title: `Thread ${id}`, titled: true, createdAt: 0, updatedAt: 0, backend: "native", mode: "agent", permission: "ask", ...patch }
}

function runtime(timeline: Timeline): ThreadRuntime {
  return { ...emptyRuntime(), engine: "ready", timeline }
}

/** A turn that started and is still running. */
function running(turnId: string): Timeline {
  return applyFrames(emptyTimeline(), [event("turn.started", { turnId, prompt: "go" })])
}

/** A running turn parked on an approval, asked at `at`. */
function asking(turnId: string, approvalId: string, at: number, action = "bun test"): Timeline {
  return applyFrames(running(turnId), [
    event("tool.started", { turnId, callId: `${turnId}-c1`, name: "run_command", presentation: { kind: "shell", title: action, command: action } }),
    event("approval.required", { turnId, approvalId, action, capability: "shell", reason: "Commands need approval" }, at),
  ])
}

function input(patch: Partial<AttentionInput>): AttentionInput {
  return { threads: [], runtime: {}, activity: {}, agentsRunning: new Set(), quietMs: 5 * 60_000, acknowledged: {}, now: 10_000_000, ...patch }
}

function keys(items: readonly WaitingItem[]): string[] {
  return items.map((item) => item.key)
}

describe("waiting on you", () => {
  test("lists approvals first, then failures, quiet threads, and finished turns, longest waiting first", () => {
    const now = 10_000_000
    const items = waitingItems(
      input({
        now,
        threads: [
          thread("done", { lastStatus: "completed", unread: true, updatedAt: 100 }),
          thread("quiet"),
          thread("late", { projectId: "p2" }),
          thread("broke", { lastStatus: "failed", unread: true, updatedAt: 500 }),
          thread("early", { projectId: "p3" }),
        ],
        runtime: { late: runtime(asking("t1", "a-late", 9_000)), early: runtime(asking("t1", "a-early", 2_000)), quiet: runtime(running("t1")) },
        activity: { quiet: now - 6 * 60_000 },
      }),
    )
    expect(keys(items)).toEqual(["approval:early:a-early", "approval:late:a-late", "failed:broke", "quiet:quiet", "finished:done"])
    expect(items[0]?.projectId).toBe("p3")
    expect(items[0]?.since).toBe(2_000)
    expect(items[0]?.tool?.presentation.title).toBe("bun test")
  })

  test("every pending approval of a thread is its own item, and read or archived threads are left out", () => {
    const timeline = applyFrames(asking("t1", "a1", 1_000), [event("approval.required", { turnId: "t1", approvalId: "a2", action: "git push", capability: "shell" }, 3_000)])
    const items = waitingItems(
      input({
        threads: [thread("two"), thread("read", { lastStatus: "completed", unread: false }), thread("gone", { archived: true, lastStatus: "failed", unread: true }), thread("stopped", { lastStatus: "stopped", unread: true })],
        runtime: { two: runtime(timeline), gone: runtime(asking("t1", "a9", 1_000)) },
      }),
    )
    expect(keys(items)).toEqual(["approval:two:a1", "approval:two:a2"])
  })

  test("an untitled thread is named as the sidebar names it", () => {
    const items = waitingItems(input({ threads: [thread("new", { titled: false, title: "", lastStatus: "completed", unread: true })] }))
    expect(items[0]?.title).toBe("New thread")
  })
})

describe("quiet threads", () => {
  const now = 10_000_000
  const quietMs = 5 * 60_000

  function quiet(patch: Partial<AttentionInput>): readonly WaitingItem[] {
    return waitingItems(input({ now, quietMs, threads: [thread("q")], runtime: { q: runtime(running("t1")) }, activity: { q: now - quietMs }, ...patch })).filter((item) => item.kind === "quiet")
  }

  test("a running turn silent for the set minutes is quiet, and names the call it is still running", () => {
    const timeline = applyFrames(running("t1"), [event("tool.started", { turnId: "t1", callId: "c1", name: "run_command", presentation: { kind: "shell", title: "bun run e2e", command: "bun run e2e" } })])
    const items = quiet({ runtime: { q: runtime(timeline) } })
    expect(items).toHaveLength(1)
    expect(items[0]?.since).toBe(now - quietMs)
    expect(items[0]?.tool?.presentation.title).toBe("bun run e2e")
  })

  test("is not quiet before the threshold, with the setting off, or with no turn running", () => {
    expect(quiet({ activity: { q: now - quietMs + 1 } })).toHaveLength(0)
    expect(quiet({ quietMs: 0 })).toHaveLength(0)
    expect(quiet({ runtime: { q: runtime(emptyTimeline()) } })).toHaveLength(0)
    const ended = applyFrames(running("t1"), [event("session.completed", { snapshot: { id: "s", backend: "native", status: "idle" } })])
    expect(quiet({ runtime: { q: runtime(ended) } })).toHaveLength(0)
  })

  test("a raised hand or a working subagent is not quiet, and no stamp means nothing to measure", () => {
    expect(quiet({ runtime: { q: runtime(asking("t1", "a1", 1_000)) } })).toHaveLength(0)
    expect(quiet({ agentsRunning: new Set(["q"]) })).toHaveLength(0)
    expect(quiet({ activity: {} })).toHaveLength(0)
  })

  test("setting a quiet thread aside lasts until it next sends something", () => {
    expect(quiet({ acknowledged: { q: now - quietMs } })).toHaveLength(0)
    const later = now + quietMs
    expect(quiet({ now: later, activity: { q: later - quietMs }, acknowledged: { q: now - quietMs } })).toHaveLength(1)
  })
})

describe("a raised hand keeps its engine", () => {
  test("a turn parked on an approval counts as busy, which eviction never stops", () => {
    const timeline = asking("t1", "a1", 1_000)
    expect(pendingApprovals(timeline)).toHaveLength(1)
    expect(isBusy(timeline)).toBe(true)
  })

  test("background subagent frames do not end the turn", () => {
    const timeline = applyFrames(running("t1"), [live("agent.spawned", { turnId: "t1", callId: "a1", title: "Scan", agentType: "explore" })])
    expect(isBusy(timeline)).toBe(true)
  })
})

describe("triage keys", () => {
  const press = (key: string, mods: Partial<TriageKey> = {}): TriageKey => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })
  const approval = waitingItems(input({ threads: [thread("a")], runtime: { a: runtime(asking("t1", "a1", 1_000)) } }))[0]
  const finished: WaitingItem = { key: "finished:f", kind: "finished", threadId: "f", projectId: "p1", title: "F", since: 0 }

  test("arrows and J/K move, Home and End jump, Esc closes, with or without an item", () => {
    expect(triageKey(press("ArrowDown"), undefined, false)).toEqual({ kind: "move", by: 1 })
    expect(triageKey(press("j"), approval, false)).toEqual({ kind: "move", by: 1 })
    expect(triageKey(press("ArrowUp"), approval, false)).toEqual({ kind: "move", by: -1 })
    expect(triageKey(press("k"), approval, false)).toEqual({ kind: "move", by: -1 })
    expect(triageKey(press("Home"), approval, false)).toEqual({ kind: "edge", to: "first" })
    expect(triageKey(press("End"), approval, false)).toEqual({ kind: "edge", to: "last" })
    expect(triageKey(press("Escape"), undefined, false)).toEqual({ kind: "close" })
    expect(triageKey(press("Enter"), undefined, false)).toBeUndefined()
  })

  test("an approval: Return or A approves, D denies, Shift-D asks for feedback, Shift-A only where offered", () => {
    expect(approval).toBeDefined()
    expect(triageKey(press("Enter"), approval, false)).toEqual({ kind: "approve" })
    expect(triageKey(press("a"), approval, false)).toEqual({ kind: "approve" })
    expect(triageKey(press("d"), approval, false)).toEqual({ kind: "deny" })
    expect(triageKey(press("D", { shiftKey: true }), approval, false)).toEqual({ kind: "feedback" })
    expect(triageKey(press("A", { shiftKey: true }), approval, false)).toBeUndefined()
    expect(triageKey(press("A", { shiftKey: true }), approval, true)).toEqual({ kind: "approve", session: true })
    expect(triageKey(press("o"), approval, false)).toEqual({ kind: "open" })
    expect(triageKey(press("x"), approval, false)).toBeUndefined()
  })

  test("a held key, or a press before the approval has settled in place, answers nothing", () => {
    expect(triageKey(press("Enter", { repeat: true }), approval, false)).toBeUndefined()
    expect(triageKey(press("d", { repeat: true }), approval, false)).toBeUndefined()
    expect(triageKey(press("ArrowDown", { repeat: true }), approval, false)).toEqual({ kind: "move", by: 1 })
    expect(triageKey(press("Enter"), approval, false, false)).toBeUndefined()
    expect(triageKey(press("a"), approval, false, false)).toBeUndefined()
    expect(triageKey(press("d"), approval, false, false)).toBeUndefined()
    expect(triageKey(press("o"), approval, false, false)).toEqual({ kind: "open" })
    expect(triageKey(press("x"), finished, false, false)).toEqual({ kind: "dismiss" })
  })

  test("anything else: Return and O open, X sets it aside, approval keys do nothing", () => {
    expect(triageKey(press("Enter"), finished, false)).toEqual({ kind: "open" })
    expect(triageKey(press("o"), finished, false)).toEqual({ kind: "open" })
    expect(triageKey(press("x"), finished, false)).toEqual({ kind: "dismiss" })
    expect(triageKey(press("a"), finished, false)).toBeUndefined()
    expect(triageKey(press("d"), finished, false)).toBeUndefined()
  })

  test("a chord with Command, Control, or Option passes through to the app", () => {
    expect(triageKey(press("i", { metaKey: true }), approval, false)).toBeUndefined()
    expect(triageKey(press("Enter", { ctrlKey: true }), approval, false)).toBeUndefined()
    expect(triageKey(press("d", { altKey: true }), approval, false)).toBeUndefined()
  })
})

describe("sound and quiet settings", () => {
  const prefsOf = (prefs: Record<string, unknown>) => parseState({ version: 1, projects: [], threads: [], prefs, layout: {} }).prefs

  test("default to today's loudness and a five-minute quiet threshold, and refuse values they do not know", () => {
    expect(prefsOf({})).toMatchObject({ volume: DEFAULT_PREFS.volume, quietMinutes: 5 })
    expect(DEFAULT_PREFS.volume).toBe(0.6)
    expect(prefsOf({ volume: 0, quietMinutes: 0 })).toMatchObject({ volume: 0, quietMinutes: 0 })
    expect(prefsOf({ volume: 1, quietMinutes: 30 })).toMatchObject({ volume: 1, quietMinutes: 30 })
    expect(prefsOf({ volume: 2, quietMinutes: 7 })).toMatchObject({ volume: 0.6, quietMinutes: 5 })
    expect(prefsOf({ volume: "loud", quietMinutes: "5" })).toMatchObject({ volume: 0.6, quietMinutes: 5 })
  })
})

describe("the thread on screen", () => {
  test("the office floor with its drawer closed shows no thread, so the last one opened still chimes and goes unread", () => {
    const state = { ...get(), layout: { ...get().layout, activeThreadId: "t1" } }
    expect(threadOnScreen({ ...state, view: { kind: "thread" } })).toBe("t1")
    expect(threadOnScreen({ ...state, view: { kind: "office" }, officeDrawer: true })).toBe("t1")
    expect(threadOnScreen({ ...state, view: { kind: "office" }, officeDrawer: false })).toBeUndefined()
  })
})
