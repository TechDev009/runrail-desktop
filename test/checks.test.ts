import { describe, expect, test } from "bun:test"
import { checkCommandFrom, checkLine, failurePrompt, suggestedRun } from "../src/app/checks"
import type { CheckResult } from "../src/protocol/schemas"

const result = (patch: Partial<CheckResult>): CheckResult => ({ id: "c", passed: false, timedOut: false, stopped: false, durationMs: 41_000, tail: "", truncated: false, ...patch })

describe("a run's check line", () => {
  test("passed, failed with counts, failed without, timed out, stopped, not checked", () => {
    expect(checkLine({ state: "done", at: 0, result: result({ passed: true, exitCode: 0, counts: { runner: "bun", passed: 128, failed: 0, skipped: 0, total: 128 } }) })).toEqual({ tone: "green", text: "Passed 128/128 · 41s" })
    expect(checkLine({ state: "done", at: 0, result: result({ exitCode: 1, counts: { runner: "bun", passed: 126, failed: 2, skipped: 0, total: 128 } }) })).toEqual({ tone: "red", text: "Failed 2 of 128 · 41s" })
    expect(checkLine({ state: "done", at: 0, result: result({ exitCode: 2 }) })).toEqual({ tone: "red", text: "Failed (exit 2) · 41s" })
    expect(checkLine({ state: "done", at: 0, result: result({ timedOut: true }) }).text).toBe("Timed out after 41s")
    expect(checkLine({ state: "done", at: 0, result: result({ stopped: true }) })).toEqual({ tone: "gray", text: "Stopped after 41s" })
    expect(checkLine(undefined)).toEqual({ tone: "gray", text: "Not checked" })
    expect(checkLine({ state: "running", runId: "r", startedAt: 1_000 }, 4_000)).toEqual({ tone: "amber", text: "Checking… 3s" })
  })
})

describe("the suggested run", () => {
  test("the passing run with the smallest change", () => {
    expect(suggestedRun([{ threadId: "a", passed: true, lines: 40 }, { threadId: "b", passed: true, lines: 12 }, { threadId: "c", passed: false, lines: 3 }])).toBe("b")
  })

  test("none when nothing passed, or a passing run changed nothing or is not read yet", () => {
    expect(suggestedRun([{ threadId: "a", passed: false, lines: 4 }])).toBeUndefined()
    expect(suggestedRun([{ threadId: "a", passed: true, lines: 0 }, { threadId: "b", passed: true }])).toBeUndefined()
  })
})

describe("failures sent back to a run", () => {
  test("names the command and why, and fences the log", () => {
    const prompt = failurePrompt("bun test", result({ exitCode: 1, tail: "(fail) skips blank lines", counts: { runner: "bun", passed: 126, failed: 2, skipped: 0, total: 128 } }))
    expect(prompt).toStartWith("The check `bun test` failed 2 of 128.")
    expect(prompt).toContain("```\n(fail) skips blank lines\n```")
  })

  test("a log with its own fence gets a different one", () => {
    expect(failurePrompt("make", result({ timedOut: true, tail: "```oops" }))).toContain("~~~~\n```oops\n~~~~")
  })
})

describe("a check command from the project", () => {
  const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "x", scripts, ...extra })

  test("the check script first, then test, with the lockfile's manager", () => {
    expect(checkCommandFrom({ packageJson: pkg({ test: "bun test", check: "tsc && bun test" }), lockfiles: ["bun.lock"], cargo: false })).toBe("bun run check")
    expect(checkCommandFrom({ packageJson: pkg({ test: "vitest run" }), lockfiles: ["pnpm-lock.yaml"], cargo: false })).toBe("pnpm run test")
    expect(checkCommandFrom({ packageJson: pkg({ test: "jest" }), lockfiles: [], cargo: false })).toBe("npm test")
    expect(checkCommandFrom({ packageJson: pkg({ check: "x" }), lockfiles: [], cargo: false })).toBe("npm run check")
    expect(checkCommandFrom({ packageJson: pkg({ test: "jest" }, { packageManager: "yarn@4.1.0" }), lockfiles: ["bun.lock"], cargo: false })).toBe("yarn run test")
  })

  test("npm's placeholder test script, a broken package.json, and Cargo", () => {
    expect(checkCommandFrom({ packageJson: pkg({ test: 'echo "Error: no test specified" && exit 1' }), lockfiles: [], cargo: false })).toBeUndefined()
    expect(checkCommandFrom({ packageJson: "{nope", lockfiles: [], cargo: true })).toBe("cargo test")
    expect(checkCommandFrom({ lockfiles: [], cargo: false })).toBeUndefined()
  })
})
