import { expect, test } from "bun:test"
import { threadGroupKind } from "../src/app/threadGroups"

test("a group is an eval's runs, a setup run's roles, or runs to compare", () => {
  expect(threadGroupKind("eval-1a2b", { setup: { runId: "sr-9", role: "executor" } })).toEqual({ kind: "eval", runId: "eval-1a2b" })
  expect(threadGroupKind("sr-9", { setup: { runId: "sr-9", role: "planner" } })).toEqual({ kind: "setup", runId: "sr-9" })
  // A workflow's steps share the workflow run's id and open the step's setup run.
  expect(threadGroupKind("wf-77", { setup: { runId: "sr-3", role: "executor" } })).toEqual({ kind: "setup", runId: "sr-3" })
  expect(threadGroupKind("g-1", {})).toEqual({ kind: "compare" })
  expect(threadGroupKind("eval-1", undefined)).toEqual({ kind: "compare" })
})
