import { expect, test } from "bun:test"
import { emptyRuntime, type ThreadRuntime } from "../src/app/store"
import { stayLines, stayReasons, when, type StayInput } from "../src/app/stayRunning"
import { slept } from "../src/app/workflowRuns"
import { emptyTimeline } from "../src/thread/reducer"

const idle: StayInput = { runtime: {}, workflowRuns: [], setupRuns: [], evalRuns: [], sources: false }

function thread(status: ThreadRuntime["timeline"]["status"], queued = 0): ThreadRuntime {
  return {
    ...emptyRuntime(),
    timeline: { ...emptyTimeline(), status },
    queue: Array.from({ length: queued }, (_, index) => ({ id: `q${String(index)}`, text: "next", attachments: [] })),
  }
}

test("nothing pending lets a close quit", () => {
  expect(stayReasons(idle)).toEqual([])
  expect(stayReasons({ ...idle, runtime: { a: thread("completed") }, upcoming: { armed: 0 } })).toEqual([])
  expect(stayReasons({ ...idle, workflowRuns: [{ state: "succeeded" }], setupRuns: [{ state: "failed" }], evalRuns: [{ state: "succeeded" }] })).toEqual([])
})

test("each kind of pending work keeps the app in the menu bar", () => {
  expect(stayReasons({ ...idle, runtime: { a: thread("running") } })).toEqual(["turn"])
  expect(stayReasons({ ...idle, runtime: { a: thread("idle", 1) } })).toEqual(["turn"])
  expect(stayReasons({ ...idle, runtime: { a: thread("waiting") } })).toEqual(["turn"])
  expect(stayReasons({ ...idle, workflowRuns: [{ state: "waiting" }] })).toEqual(["workflow-run"])
  expect(stayReasons({ ...idle, setupRuns: [{ state: "running" }] })).toEqual(["setup-run"])
  expect(stayReasons({ ...idle, evalRuns: [{ state: "running" }] })).toEqual(["eval-run"])
  expect(stayReasons({ ...idle, upcoming: { armed: 2 } })).toEqual(["schedule"])
  expect(stayReasons({ ...idle, sources: true })).toEqual(["memory-sync"])
})

const now = new Date(2026, 9, 9, 10, 0).getTime()

test("the menu says what runs, what waits, and what starts next", () => {
  expect(stayLines(idle, now)).toEqual(["Nothing running"])
  const busy: StayInput = {
    ...idle,
    runtime: { a: thread("running"), b: thread("waiting"), c: thread("completed") },
    workflowRuns: [{ state: "waiting", waiting: { kind: "approve", stepId: "s", title: "Merge?" } }],
    setupRuns: [{ state: "waiting", waiting: { kind: "approve", stepId: "s", plan: {} } } as never],
    upcoming: { armed: 1, next: { workflowId: "w", name: "Nightly triage", root: "/p", at: new Date(2026, 9, 9, 14, 30).getTime() } },
  }
  const lines = stayLines(busy, now)
  expect(lines[0]).toBe("1 running, 3 waiting for you")
  expect(lines[1]).toStartWith("Next: Nightly triage, at ")
  expect(stayLines({ ...idle, runtime: { a: thread("waiting") } }, now)).toEqual(["1 waiting for you"])
})

test("when says now, today, tomorrow or the weekday", () => {
  expect(when(now + 30_000, now)).toBe("now")
  expect(when(now - 5_000, now)).toBe("now")
  expect(when(new Date(2026, 9, 9, 14, 30).getTime(), now)).toStartWith("at ")
  expect(when(new Date(2026, 9, 10, 2, 0).getTime(), now)).toStartWith("tomorrow at ")
  expect(when(new Date(2026, 9, 13, 9, 0).getTime(), now)).toMatch(/^\S+ at /)
  expect(when(new Date(2026, 9, 13, 9, 0).getTime(), now)).not.toStartWith("tomorrow")
})

test("a gap in the 30-second tick reads as the Mac having slept", () => {
  expect(slept(undefined, now)).toBe(false)
  expect(slept(now - 30_000, now)).toBe(false)
  expect(slept(now - 85_000, now)).toBe(false)
  expect(slept(now - 8 * 3_600_000, now)).toBe(true)
})
