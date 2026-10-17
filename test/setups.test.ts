import { describe, expect, test } from "bun:test"
import { draftOf, draftSetup, listedRuns, roleSelection, turnAnswer } from "../src/app/setups"
import { parseOr, SetupRunSchema, SetupSchema } from "../src/protocol/schemas"
import type { TimelineItem } from "../src/thread/reducer"

describe("setups on the desktop", () => {
  test("a role runs as a thread on its route, model, connection, and effort", () => {
    expect(roleSelection({ route: "codex", model: "gpt-5.5", effort: "high", access: "auto-edit" })).toEqual({ backend: "codex", model: "gpt-5.5", thinking: "high" })
    expect(roleSelection({ route: "native", connectionId: "c1" })).toEqual({ backend: "native", connectionId: "c1" })
  })

  test("a turn's answer joins every assistant message of that turn, and only that turn", () => {
    const items: TimelineItem[] = [
      { kind: "assistant", key: "a", turnId: "t1", text: "earlier turn", streaming: false, at: 1 },
      { kind: "assistant", key: "b", turnId: "t2", text: "Reading.", streaming: false, at: 2 },
      { kind: "assistant", key: "c", turnId: "t2", text: "```json\n{}\n```", streaming: false, at: 3 },
    ]
    expect(turnAnswer(items, "t2")).toBe("Reading.\n\n```json\n{}\n```")
  })

  test("a new setup plans, executes with Auto-edit, and reviews once, approving the plan first", () => {
    const draft = draftSetup({ route: "claude-code" }, "bun test")
    expect(draft.roles).toEqual({ planner: { route: "claude-code" }, executor: { route: "claude-code", access: "auto-edit" }, reviewer: { route: "claude-code" } })
    expect(draft.rules).toEqual({ approvePlan: true, reviewRounds: 1, check: "bun test", budget: { maxTurns: 40, maxMinutes: 120 } })
    expect(draft.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  })

  test("an engine setup becomes an editable draft without its source", () => {
    const setup = parseOr(SetupSchema, { id: "s", name: "S", source: "project", roles: { executor: { route: "pi" } }, rules: { approvePlan: false, reviewRounds: 0, budget: { maxTurns: 5, maxMinutes: 9 } } })
    expect(setup === undefined ? undefined : draftOf(setup)).toEqual({ id: "s", name: "S", roles: { executor: { route: "pi" } }, rules: { approvePlan: false, reviewRounds: 0, budget: { maxTurns: 5, maxMinutes: 9 } } })
  })

  test("a run's status reads, waiting on a turn or on the person", () => {
    const base = { runId: "setup-1", setupId: "s", setupName: "S", task: "t", state: "waiting", startedAt: 1, turns: 1, steps: [{ id: "1", kind: "plan", title: "Plan", status: "done", role: "planner", note: "2 steps" }] }
    expect(parseOr(SetupRunSchema, { ...base, waiting: { kind: "approve", stepId: "approve-2", plan: { steps: [{ title: "One" }] } } })?.waiting?.kind).toBe("approve")
    expect(parseOr(SetupRunSchema, { ...base, waiting: { kind: "turn", stepId: "3-2", role: "executor", thread: "setup-1:executor", runsOn: { route: "codex" }, mode: "agent", access: "ask", title: "S: executor", prompt: "Do step 1" } })?.waiting?.kind).toBe("turn")
    expect(parseOr(SetupRunSchema, { ...base, state: "dreaming" })).toBeUndefined()
  })

  test("a run the desktop cannot read leaves the others in the list", () => {
    const base = { setupId: "s", setupName: "S", task: "t", state: "waiting", startedAt: 1, turns: 1, steps: [{ id: "1", kind: "step", title: "1. Fix it", status: "running", role: "executor" }] }
    const unreadable = { ...base, runId: "setup-2", steps: [{ ...base.steps[0], title: "x".repeat(300) }] }
    expect(listedRuns({ runs: [{ ...base, runId: "setup-1" }, unreadable] })?.map((run) => run.runId)).toEqual(["setup-1"])
    expect(listedRuns({ runs: [] })).toEqual([])
    expect(listedRuns({ error: "down" })).toBeUndefined()
  })
})
