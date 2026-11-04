import type { UsageDay, UsageHistory } from "./persist"
import { get, set } from "./store"

const MAX_DAYS = 1_096
const MAX_SEEN = 2_048
const MAX_MODELS = 32
const OTHER_MODELS = "Other models"

export interface UsageRange {
  readonly from?: string
  readonly to?: string
}

export interface UsageSummary {
  readonly messages: number
  readonly turns: number
  readonly activeDays: number
  readonly currentStreak: number
  readonly longestStreak: number
  readonly peakHours: readonly number[]
  readonly models: readonly { readonly key: string; readonly turns: number }[]
  readonly tokenStatus: "unavailable"
  readonly complete: boolean
}

interface UsageRun {
  readonly backend?: string
  readonly model?: string
}

export function usageDayKey(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return String(year) + "-" + month + "-" + day
}

function shiftDayKey(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number)
  const shifted = new Date(year ?? 0, (month ?? 1) - 1, date ?? 1)
  shifted.setDate(shifted.getDate() + delta)
  return usageDayKey(shifted.getTime())
}

function hourOf(at: number): number {
  return new Date(at).getHours()
}

function dayAt(value: UsageHistory, day: string): UsageDay {
  return value.days.find((entry) => entry.day === day) ?? { day, messages: 0, turns: 0, activeHours: [], models: [] }
}

function updateDay(value: UsageHistory, day: UsageDay): UsageHistory {
  const days = [...value.days.filter((entry) => entry.day !== day.day), day].sort((left, right) => left.day.localeCompare(right.day)).slice(-MAX_DAYS)
  return { ...value, days }
}

function modelKey(run: UsageRun | undefined): string {
  if (run?.model !== undefined && run.model.trim().length > 0) return run.model.trim().slice(0, 256)
  if (run?.backend !== undefined && run.backend.trim().length > 0) return "Model not reported (" + run.backend + ")"
  return "Model not reported"
}

function boundModels(models: readonly { readonly key: string; readonly turns: number }[]): readonly { readonly key: string; readonly turns: number }[] {
  const sorted = [...models].sort((left, right) => right.turns - left.turns || left.key.localeCompare(right.key))
  if (sorted.length <= MAX_MODELS) return sorted
  const explicit = sorted.filter((model) => model.key !== OTHER_MODELS)
  const kept = explicit.slice(0, MAX_MODELS - 1)
  const otherTurns = sorted.filter((model) => model.key === OTHER_MODELS).reduce((total, model) => total + model.turns, 0) + explicit.slice(MAX_MODELS - 1).reduce((total, model) => total + model.turns, 0)
  return [...kept, { key: OTHER_MODELS, turns: otherTurns }].sort((left, right) => right.turns - left.turns || left.key.localeCompare(right.key))
}

function addEvent(eventId: string, at: number, kind: "message" | "turn", run?: UsageRun): void {
  const state = get()
  if (!state.usageHistory.enabled || state.usageHistory.seen.includes(eventId)) return
  const current = state.usageHistory
  const day = dayAt(current, usageDayKey(at))
  const model = modelKey(run)
  const existingModel = day.models.find((entry) => entry.key === model)
  const models = kind === "message"
    ? day.models
    : boundModels(existingModel === undefined ? [...day.models, { key: model, turns: 1 }] : day.models.map((entry) => (entry.key === model ? { ...entry, turns: entry.turns + 1 } : entry)))
  const updated: UsageDay = {
    ...day,
    messages: day.messages + (kind === "message" ? 1 : 0),
    turns: day.turns + (kind === "turn" ? 1 : 0),
    activeHours: day.activeHours.includes(hourOf(at)) ? day.activeHours : [...day.activeHours, hourOf(at)].sort((left, right) => left - right),
    models,
  }
  set({
    usageHistory: updateDay({ ...current, seen: [...current.seen, eventId].slice(-MAX_SEEN) }, updated),
  })
}

export function setUsageEnabled(enabled: boolean): void {
  const current = get().usageHistory
  set({ usageHistory: { ...current, enabled, ...(enabled && !current.enabled ? { enabledAt: Date.now() } : {}) } })
}

export function clearUsageHistory(): void {
  const current = get().usageHistory
  set({ usageHistory: { ...current, days: [], seen: [] } })
}

export function recordAcceptedMessage(threadId: string, requestId: string, at = Date.now()): void {
  addEvent("message:" + threadId + ":" + requestId, at, "message")
}

export function recordTurn(threadId: string, turnId: string, startedAt: number, run?: UsageRun): void {
  addEvent("turn:" + threadId + ":" + turnId, startedAt, "turn", run)
}

function dayInRange(day: UsageDay, range: UsageRange): boolean {
  return (range.from === undefined || day.day >= range.from) && (range.to === undefined || day.day <= range.to)
}

export function usageSummary(history: UsageHistory, range: UsageRange = {}): UsageSummary {
  const days = history.days.filter((day) => dayInRange(day, range))
  const active = new Set(days.filter((day) => day.messages > 0).map((day) => day.day))
  const models = new Map<string, number>()
  let messages = 0
  let turns = 0
  const hours = new Map<number, number>()
  for (const day of days) {
    messages += day.messages
    turns += day.turns
    for (const hour of day.activeHours) hours.set(hour, (hours.get(hour) ?? 0) + 1)
    for (const model of day.models) models.set(model.key, (models.get(model.key) ?? 0) + model.turns)
  }
  const sortedDays = [...active].sort()
  let longest = 0
  let current = 0
  let previous: string | undefined
  for (const day of sortedDays) {
    if (previous !== undefined && shiftDayKey(previous, 1) !== day) current = 0
    current += 1
    longest = Math.max(longest, current)
    previous = day
  }
  const today = usageDayKey(Date.now())
  const yesterday = shiftDayKey(today, -1)
  const latest = active.has(today) ? today : yesterday
  let streak = 0
  if (active.has(latest)) {
    let cursor = latest
    while (active.has(cursor)) {
      streak += 1
      cursor = shiftDayKey(cursor, -1)
    }
  }
  const peak = [...hours.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])
  const topCount = peak[0]?.[1] ?? 0
  return {
    messages,
    turns,
    activeDays: active.size,
    currentStreak: streak,
    longestStreak: longest,
    peakHours: peak.filter((entry) => entry[1] === topCount && topCount > 0).map(([hour]) => hour),
    models: [...models.entries()].sort((left, right) => right[1] - left[1]).map(([key, count]) => ({ key, turns: count })),
    tokenStatus: "unavailable",
    complete: history.enabled,
  }
}
