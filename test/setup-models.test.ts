import { expect, test } from "bun:test"
import { pickModelHint, rolesWithoutModel } from "../src/app/setups"

test("a setup needs a model for each role it uses, except in developer mode", () => {
  const roles = { planner: { route: "native" }, executor: { route: "claude-code" }, reviewer: { route: "native", model: "claude-haiku-4-5" } } as const
  expect(rolesWithoutModel(roles, false)).toEqual(["planner"])
  expect(rolesWithoutModel(roles, true)).toEqual([])
  expect(rolesWithoutModel({ executor: { route: "native" } }, false)).toEqual(["executor"])
  expect(pickModelHint(["planner"])).toBe("Pick a model for the planner")
  expect(pickModelHint(["planner", "executor", "reviewer"])).toBe("Pick a model for the planner, executor and reviewer")
})
