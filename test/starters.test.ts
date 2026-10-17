import { expect, test } from "bun:test"
import { startersFor, startersShown } from "../src/ui/thread/ThreadView"

test("a folder that is not a git repository gets no git starters", () => {
  expect(startersFor(true).map((starter) => starter.label)).toEqual(["Explain this codebase", "Find and fix a bug", "Add missing tests", "Review my changes", "Best of N", "Continue a session"])
  expect(startersFor(false).map((starter) => starter.label)).toEqual(["Explain this codebase", "Find and fix a bug", "Add missing tests", "Continue a session"])
})

test("starters show on an empty box only, and give way to connecting a model", () => {
  expect(startersShown("", false)).toBe(true)
  expect(startersShown("  \n", false)).toBe(true)
  expect(startersShown("fix the build", false)).toBe(false)
  expect(startersShown("", true)).toBe(false)
})

test("Continue a session opens the import dialog for the new thread's project", () => {
  const starter = startersFor(false).find((item) => item.label === "Continue a session")
  expect(starter !== undefined && "dialog" in starter ? starter.dialog : undefined).toBe("import")
})
