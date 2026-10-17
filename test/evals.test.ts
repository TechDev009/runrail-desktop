import { describe, expect, test } from "bun:test"
import { cell, evalCheckFrom, rate, scoreboard, suiteName, totals } from "../src/app/evals"
import { EvalRunSchema, parseOr, SetupRunSchema, type EvalJob, type EvalRun } from "../src/protocol/schemas"

const job = (index: number, setupId: string, state: EvalJob["state"], extra: Partial<EvalJob> = {}): EvalJob => ({ index, caseId: `c${String(index % 2)}`, setupId, repeat: 1 + Math.floor(index / 4), state, ...extra })

const RUN: EvalRun = {
  runId: "eval-1",
  suite: "smoke",
  setups: [
    { id: "slow", name: "Slow" },
    { id: "fast", name: "Fast" },
  ],
  cases: ["c0", "c1"],
  repeats: 2,
  state: "running",
  startedAt: 0,
  jobs: [
    job(0, "slow", "passed", { durationMs: 9_000, turns: 4 }),
    job(1, "slow", "failed", { durationMs: 7_000, turns: 6 }),
    job(2, "fast", "passed", { durationMs: 3_000, turns: 1 }),
    job(3, "fast", "failed", { durationMs: 1_000, turns: 1 }),
    job(4, "slow", "running"),
    job(5, "fast", "skipped"),
  ],
}

describe("eval scores", () => {
  test("only passed, failed and errored jobs count; median time and mean turns over those", () => {
    expect(totals(RUN.jobs.filter((item) => item.setupId === "slow"))).toEqual({ scored: 2, passed: 1, total: 3, medianMs: 8_000, meanTurns: 5 })
    expect(totals([])).toEqual({ scored: 0, passed: 0, total: 0 })
    expect(rate({ passed: 0, scored: 0 })).toBe(0)
  })

  test("the scoreboard ranks by pass rate, then the faster setup", () => {
    expect(scoreboard(RUN).map((row) => [row.name, row.passed, row.scored])).toEqual([
      ["Fast", 1, 2],
      ["Slow", 1, 2],
    ])
  })

  test("a cell holds one case and setup's runs, by repeat", () => {
    expect(cell(RUN, "c0", "slow").map((item) => [item.index, item.repeat])).toEqual([
      [0, 1],
      [4, 2],
    ])
  })
})

describe("eval inputs", () => {
  test("a Bun project's check runs only the case's tests; others run whole", () => {
    expect(evalCheckFrom("bun test")).toBe("bun test {tests}")
    expect(evalCheckFrom("cargo test")).toBe("cargo test")
    expect(evalCheckFrom(undefined)).toBe("")
  })

  test("a suite name is made safe for the engine", () => {
    expect(suiteName("Parser Fixes!")).toBe("parser-fixes")
    expect(suiteName("--x")).toBe("x")
    expect(suiteName("a".repeat(80))).toHaveLength(64)
  })

  test("an engine eval run parses; prompts and answers are not part of it", () => {
    const run = parseOr(EvalRunSchema, { ...RUN, jobs: [{ ...RUN.jobs[0], check: { exitCode: 0, timedOut: false, counts: { runner: "bun", passed: 3, failed: 0, skipped: 0, total: 3 } }, error: "x".repeat(500) }] })
    expect(run?.jobs[0]?.check?.counts?.passed).toBe(3)
    expect(run?.jobs[0]?.error).toBeUndefined()
  })

  test("a setup turn an eval started carries the worktree every role works in", () => {
    const turn = { kind: "turn", stepId: "1-1", role: "executor", thread: "t", runsOn: { route: "codex" }, mode: "agent", access: "auto-edit", title: "t", prompt: "p", worktree: { id: "ev-1-0", path: "/w", cwd: "/w" } }
    const run = parseOr(SetupRunSchema, { runId: "setup-1", setupId: "s", setupName: "S", task: "t", state: "waiting", startedAt: 0, turns: 1, steps: [], waiting: turn })
    expect(run?.waiting?.kind === "turn" ? run.waiting.worktree : undefined).toEqual({ id: "ev-1-0", path: "/w", cwd: "/w" })
  })
})
