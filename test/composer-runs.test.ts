import { expect, test } from "bun:test"
import { commandName } from "../src/app/composerRuns"

test("a saved setup or workflow is a / command named after it", () => {
  expect(commandName("Plan, execute, review")).toBe("plan-execute-review")
  expect(commandName("Crème brûlée: nightly")).toBe("creme-brulee-nightly")
  expect(commandName("!!!")).toBe("run")
  expect(commandName(`${"word ".repeat(12)}end`)).toBe("word-word-word-word-word-word-word-word")
})
