import { afterEach, describe, expect, test } from "bun:test"
import { defaultState, parseState } from "../src/app/persist"
import { get, persistedSlice, set } from "../src/app/store"
import { clearUsageHistory, recordAcceptedMessage, recordTurn, setUsageEnabled, usageDayKey, usageSummary } from "../src/app/usageHistory"

const EMPTY = { enabled: true, days: [], seen: [] } as const

function at(day: string, hour: number): number {
  const [year, month, date] = day.split("-").map(Number)
  return new Date(year!, month! - 1, date!, hour).getTime()
}

function day(key: string, fields: Partial<{ messages: number; turns: number; activeHours: number[]; models: { key: string; turns: number }[] }> = {}) {
  return { day: key, messages: 1, turns: 0, activeHours: [], models: [], ...fields }
}

afterEach(() => set({ usageHistory: { enabled: false, days: [], seen: [] } }))

describe("usage history recording", () => {
  test("records nothing while it is off", () => {
    recordAcceptedMessage("t1", "r1", at("2026-03-02", 9))
    recordTurn("t1", "u1", at("2026-03-02", 9), { model: "m" })
    expect(get().usageHistory.days).toEqual([])
    expect(get().usageHistory.seen).toEqual([])
  })

  test("counts a message and a turn once, on the local day and hour", () => {
    setUsageEnabled(true)
    const when = at("2026-03-02", 14)
    recordAcceptedMessage("t1", "r1", when)
    recordAcceptedMessage("t1", "r1", when)
    recordTurn("t1", "u1", when, { backend: "codex", model: "gpt-5.5" })
    recordTurn("t1", "u1", when, { backend: "codex", model: "gpt-5.5" })
    expect(get().usageHistory.days).toEqual([{ day: "2026-03-02", messages: 1, turns: 1, activeHours: [14], models: [{ key: "gpt-5.5", turns: 1 }] }])
  })

  test("a turn with no reported model is named by its engine, and never leaks a prompt", () => {
    setUsageEnabled(true)
    recordTurn("t1", "u1", at("2026-03-02", 1), { backend: "pi" })
    recordTurn("t1", "u2", at("2026-03-02", 1))
    expect(get().usageHistory.days[0]?.models.map((model) => model.key).sort()).toEqual(["Model not reported", "Model not reported (pi)"])
    expect(JSON.stringify(get().usageHistory)).not.toContain("prompt")
  })

  test("more than 32 models fold into Other models without losing turns", () => {
    setUsageEnabled(true)
    for (let index = 0; index < 40; index += 1) recordTurn("t1", "u" + String(index), at("2026-03-02", 10), { model: "model-" + String(index) })
    const models = get().usageHistory.days[0]!.models
    expect(models).toHaveLength(32)
    expect(models.reduce((total, model) => total + model.turns, 0)).toBe(40)
    expect(models.some((model) => model.key === "Other models")).toBe(true)
  })

  test("the days and seen ids stay bounded", () => {
    setUsageEnabled(true)
    for (let index = 0; index < 2_100; index += 1) recordAcceptedMessage("t1", "r" + String(index), at("2026-03-02", 8))
    expect(get().usageHistory.seen).toHaveLength(2_048)
    expect(get().usageHistory.days[0]?.messages).toBe(2_100)
  })

  test("turning it off keeps what was counted; clearing removes it but keeps the setting", () => {
    setUsageEnabled(true)
    recordAcceptedMessage("t1", "r1", at("2026-03-02", 8))
    setUsageEnabled(false)
    expect(get().usageHistory.days).toHaveLength(1)
    setUsageEnabled(true)
    clearUsageHistory()
    expect(get().usageHistory).toMatchObject({ enabled: true, days: [], seen: [] })
  })
})

describe("usage summary", () => {
  test("streaks count consecutive active days across month ends", () => {
    const history = { ...EMPTY, days: [day("2026-02-27"), day("2026-02-28"), day("2026-03-01"), day("2026-03-05"), day("2026-03-06")] }
    const summary = usageSummary(history)
    expect(summary.activeDays).toBe(5)
    expect(summary.longestStreak).toBe(3)
    expect(summary.currentStreak).toBe(0)
  })

  test("the current streak runs through today or yesterday", () => {
    const today = usageDayKey(Date.now())
    const before = usageDayKey(Date.now() - 24 * 3_600_000 * 1.5)
    const summary = usageSummary({ ...EMPTY, days: [day(before), day(today)] })
    expect(summary.currentStreak).toBeGreaterThanOrEqual(1)
  })

  test("peak hours list every tied hour, and are empty with no data", () => {
    const summary = usageSummary({ ...EMPTY, days: [day("2026-03-01", { activeHours: [9, 15] }), day("2026-03-02", { activeHours: [15, 9, 22] })] })
    expect(summary.peakHours).toEqual([9, 15])
    expect(usageSummary(EMPTY).peakHours).toEqual([])
  })

  test("the date range filters days, and models are summed and ranked", () => {
    const history = {
      ...EMPTY,
      days: [
        day("2026-03-01", { turns: 2, models: [{ key: "a", turns: 2 }] }),
        day("2026-03-02", { turns: 3, models: [{ key: "b", turns: 3 }, { key: "a", turns: 0 }] }),
        day("2026-03-03", { turns: 1, models: [{ key: "a", turns: 1 }] }),
      ],
    }
    const summary = usageSummary(history, { from: "2026-03-02", to: "2026-03-03" })
    expect(summary).toMatchObject({ messages: 2, turns: 4, activeDays: 2 })
    expect(summary.models).toEqual([{ key: "b", turns: 3 }, { key: "a", turns: 1 }])
    expect(summary.tokenStatus).toBe("unavailable")
  })
})

describe("usage history in saved state", () => {
  test("a new profile starts off and empty", () => {
    expect(defaultState().usageHistory).toEqual({ enabled: false, days: [], seen: [] })
    expect(parseState({ version: 1 }).usageHistory).toEqual({ enabled: false, days: [], seen: [] })
  })

  test("it survives a save and load", () => {
    setUsageEnabled(true)
    recordAcceptedMessage("t1", "r1", at("2026-03-02", 8))
    expect(parseState(JSON.parse(JSON.stringify(persistedSlice(get())))).usageHistory).toEqual(get().usageHistory)
  })

  test("invalid or oversized entries are dropped, not trusted", () => {
    const parsed = parseState({
      version: 1,
      usageHistory: {
        enabled: true,
        days: [
          { day: "2026-03-02", messages: 1, turns: 1, activeHours: [3, 3, 99], models: [] },
          { day: "yesterday", messages: 1, turns: 0, activeHours: [], models: [] },
          { day: "2026-03-03", messages: -4, turns: 0, activeHours: [], models: [] },
          { day: "2026-03-04", messages: 2, turns: 0, activeHours: [5, 5], models: Array.from({ length: 40 }, (_, index) => ({ key: "m" + String(index), turns: 1 })) },
        ],
        seen: ["", "a", 4, "a"],
      },
    }).usageHistory
    expect(parsed.days.map((entry) => entry.day)).toEqual([])
    expect(parsed.seen).toEqual(["a"])
  })
})
