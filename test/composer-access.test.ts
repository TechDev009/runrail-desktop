import { describe, expect, test } from "bun:test"
import { ACCESS_ORDER, accessOf, effectivePermission, nextAccess, offersAuto, withAccess } from "../src/app/access"
import { withSkills } from "../src/app/engines"
import { mergeLimits, planLabel, resetText, windowLabel } from "../src/app/limits"
import { behaviorFor } from "../src/app/persist"
import type { BackendId } from "../src/host/types"
import { accessChoices } from "../src/ui/thread/ComposerMenus"
import { LiveFrameSchema } from "../src/protocol/schemas"

describe("plan and permissions as one choice", () => {
  test("Plan is the thread's mode, so leaving it returns to the permission it had", () => {
    expect(accessOf("plan", "auto-edit")).toBe("plan")
    expect(accessOf("goal", "full")).toBe("full")
    const planned = withAccess({ mode: "agent", permission: "auto-edit" }, "plan")
    expect(planned).toEqual({ mode: "plan", permission: "auto-edit" })
    expect(withAccess(planned, "ask")).toEqual({ mode: "agent", permission: "ask" })
  })

  test("a permission keeps Goal on, and Plan replaces it", () => {
    expect(withAccess({ mode: "goal", permission: "ask" }, "full")).toEqual({ mode: "goal", permission: "full" })
    expect(withAccess({ mode: "goal", permission: "ask" }, "plan")).toEqual({ mode: "plan", permission: "ask" })
  })

  test("Shift-Tab never lands on Full access", () => {
    expect(nextAccess("ask")).toBe("auto-edit")
    expect(nextAccess("auto-edit")).toBe("plan")
    expect(nextAccess("plan")).toBe("ask")
    expect(nextAccess("full")).toBe("ask")
    expect(nextAccess("auto")).toBe("ask")
  })

  test("Auto is the tool's own reviewer: offered on Claude Code and Codex, and Ask on a tool without one", () => {
    expect(ACCESS_ORDER).toEqual(["plan", "ask", "auto-edit", "auto", "full"])
    const others: readonly BackendId[] = ["native", "copilot", "opencode", "gemini", "goose", "pi", "replay"]
    for (const backend of ["claude-code", "codex"] as const) {
      expect(offersAuto(backend)).toBe(true)
      expect(effectivePermission("auto", backend)).toBe("auto")
      expect(accessChoices(backend).map((choice) => choice.value)).toEqual(["plan", "ask", "auto-edit", "auto", "full"])
    }
    for (const backend of others) {
      expect(offersAuto(backend)).toBe(false)
      expect(effectivePermission("auto", backend)).toBe("ask")
      expect(accessChoices(backend).map((choice) => choice.value)).toEqual(["plan", "ask", "auto-edit", "full"])
    }
    expect(effectivePermission("full", "native")).toBe("full")
    expect(accessChoices("claude-code").find((choice) => choice.value === "auto")?.hint).toContain("Claude Code's auto mode")
    expect(accessChoices("codex").find((choice) => choice.value === "auto")?.hint).toContain("Approve for me")
  })

  test("Claude Code asks under Ask and Auto-edit, so its levels read as everyone's", () => {
    const hints = (backend: BackendId): Record<string, string> => Object.fromEntries(accessChoices(backend).map((choice) => [choice.value, choice.hint]))
    const claude = hints("claude-code")
    const native = hints("native")
    for (const value of ["plan", "ask", "auto-edit", "full"]) expect(claude[value]).toBe(native[value])
  })

  test("Auto reaches the engine as auto mode with asking as the default, Full access as allowing everything", () => {
    expect(behaviorFor("auto", "agent", "high")).toEqual({ mode: "auto", effort: "high", permissionDefault: "ask", rules: [] })
    expect(behaviorFor("full", "agent", "high")).toEqual({ mode: "auto", effort: "high", permissionDefault: "allow", rules: [] })
    expect(behaviorFor("auto", "plan", "high")).toMatchObject({ mode: "plan" })
  })
})

describe("skills picked in the composer", () => {
  test("go by id to Runrail's own agent and in words to a coding tool", () => {
    expect(withSkills("native", "Fix the build", ["release-notes"])).toEqual({ text: "Fix the build", skills: ["release-notes"] })
    expect(withSkills("codex", "Fix the build", ["release-notes", "lint"])).toEqual({ text: "Use the release-notes skill. Use the lint skill.\n\nFix the build", skills: [] })
    expect(withSkills("native", "Go", Array.from({ length: 10 }, (_, index) => `s${String(index)}`)).skills).toHaveLength(8)
    expect(withSkills("claude-code", "Go", [])).toEqual({ text: "Go", skills: [] })
  })
})

describe("plan usage", () => {
  test("an update that names one window keeps the others and the plan", () => {
    const first = mergeLimits(undefined, { plan: "pro", windows: [{ id: "weekly", usedPercent: 7, resetsAt: 2_000 }, { id: "five-hour", usedPercent: 24, resetsAt: 1_000 }] }, 10)
    expect(first.windows.map((window) => window.id)).toEqual(["five-hour", "weekly"])
    const next = mergeLimits(first, { windows: [{ id: "five-hour", usedPercent: 31 }] }, 20)
    expect(next).toEqual({ plan: "pro", at: 20, windows: [{ id: "five-hour", usedPercent: 31, resetsAt: 1_000 }, { id: "weekly", usedPercent: 7, resetsAt: 2_000 }] })
  })

  test("reads as the tools name their windows", () => {
    expect(windowLabel({ id: "five-hour", usedPercent: 1 })).toBe("5-hour limit")
    expect(windowLabel({ id: "weekly-opus", usedPercent: 1 })).toBe("Weekly · Opus")
    expect(windowLabel({ id: "primary", usedPercent: 1, windowMinutes: 1_440 })).toBe("Daily limit")
    expect(planLabel("codex", "pro")).toBe("Codex plan · Pro")
    expect(planLabel("claude-code", undefined)).toBe("Claude Code plan")
    expect(resetText(60 * 60_000 + 41 * 60_000, 0)).toBe("Resets in 1 hr 41 min")
    expect(resetText(5 * 60_000, 0)).toBe("Resets in 5 min")
    expect(resetText(undefined, 0)).toBeUndefined()
  })

  test("a frame with an unknown window or source is refused", () => {
    const frame = { liveSeq: 1, type: "plan.limits", source: "codex", windows: [{ id: "five-hour", usedPercent: 24 }] }
    expect(LiveFrameSchema.safeParse(frame).success).toBe(true)
    expect(LiveFrameSchema.safeParse({ ...frame, source: "gemini" }).success).toBe(false)
    expect(LiveFrameSchema.safeParse({ ...frame, windows: [{ id: "monthly", usedPercent: 3 }] }).success).toBe(false)
    expect(LiveFrameSchema.safeParse({ ...frame, windows: [{ id: "weekly", usedPercent: 140 }] }).success).toBe(false)
  })
})
