import { beforeEach, describe, expect, test } from "bun:test"
import { noteOpen, notePainted, noteThreadChosen, resetDiagnostics, stepClock, useDiagnostics, watchPaint } from "../src/app/diagnostics"

const now = (values: number[]) => () => values.shift() ?? Number.NaN
const painted = (done: () => void) => done()

beforeEach(() => resetDiagnostics())

describe("thread open timings", () => {
  test("a step clock gives each step the time since the one before", () => {
    const clock = stepClock(now([100, 112.4, 160, 161]))
    clock.mark("launch")
    clock.mark("history")
    clock.mark("ready")
    expect(clock.steps()).toEqual([["launch", 12], ["history", 48], ["ready", 1]])
    expect(clock.total()).toBe(61)
  })

  test("opens are kept newest first, at most 20", () => {
    for (let index = 0; index < 25; index++) noteOpen({ backend: "native", steps: [], totalMs: index, items: 0, at: index })
    const opens = useDiagnostics.getState().opens
    expect(opens).toHaveLength(20)
    expect(opens[0]?.totalMs).toBe(24)
  })

  test("drawn history is timed from the click, and says whether it had to load", () => {
    noteThreadChosen("t1", 1_000)
    watchPaint("t1", false, 1_040)
    notePainted("t1", 2048, painted, () => 1_180)
    noteThreadChosen("t2", 2_000)
    watchPaint("t2", true, 2_010)
    notePainted("t2", 12, painted, () => 2_030)
    expect(useDiagnostics.getState().paints.map(({ kind, ms, items }) => ({ kind, ms, items }))).toEqual([
      { kind: "revisit", ms: 30, items: 12 },
      { kind: "first", ms: 180, items: 2048 },
    ])
  })

  test("a thread shown without a recent click is timed from when it was shown, once", () => {
    noteThreadChosen("t1", 0)
    watchPaint("t1", false, 5_000)
    notePainted("t1", 3, painted, () => 5_100)
    notePainted("t1", 3, painted, () => 9_000)
    notePainted("other", 3, painted, () => 9_000)
    expect(useDiagnostics.getState().paints.map(({ ms }) => ms)).toEqual([100])
  })
})
