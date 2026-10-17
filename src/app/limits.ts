import { create } from "zustand"
import { LiveFrameSchema, type LiveFrame } from "../protocol/schemas"
import type { BackendId } from "../host/types"

/**
 * How much of a Codex or Claude Code subscription is used, per account: a tool's usual
 * login, or a connection signed in from a folder of its own. A tool may say it rarely, so the last
 * word is kept across runs with when it was said; a window that has reset since, or a reading a
 * week old, says nothing about the plan now and is not shown.
 */

const STORAGE_KEY = "runrail.plan-limits.v2"
const MAX_AGE_MS = 7 * 24 * 60 * 60_000
const MAX_ACCOUNTS = 32
/** `claude-code` is the usual login; `claude-code:<connection id>` a folder of its own. */
const ACCOUNT_KEY = /^(codex|claude-code)(?::([A-Za-z][A-Za-z0-9._:-]{0,255}))?$/

export type PlanFrame = Extract<LiveFrame, { readonly type: "plan.limits" }>
export type PlanWindow = PlanFrame["windows"][number]
export type PlanSource = PlanFrame["source"]

export interface PlanLimits {
  readonly plan?: string
  readonly windows: readonly PlanWindow[]
  /** Whether extra usage can serve requests past a used-up window, as the tool last said. */
  readonly extraUsage?: boolean
  readonly at: number
}

/** Whose plan a reading is about. */
export interface PlanAccount {
  readonly key: string
  readonly source: PlanSource
  /** Set for a connection signed in from a folder of its own. */
  readonly connectionId?: string
}

export type AllLimits = Readonly<Record<string, PlanLimits>>

/** The connection fields that decide the account. */
export interface AccountConnection {
  readonly id: string
  readonly tool: string
  readonly authMode: "subscription" | "api-key"
  readonly separateAccount: boolean
}

/**
 * The account a tool runs as: its usual login when there is no connection or the connection
 * shares it, the connection's own when it signs in from a folder of its own. A pasted key has no
 * plan, and a connection for another tool says nothing about this one.
 */
export function planAccount(source: PlanSource, connection: AccountConnection | undefined): PlanAccount | undefined {
  if (connection === undefined) return { key: source, source }
  if (connection.tool !== source || connection.authMode === "api-key") return undefined
  return connection.separateAccount ? { key: `${source}:${connection.id}`, source, connectionId: connection.id } : { key: source, source }
}

export function accountOfKey(key: string): PlanAccount | undefined {
  const match = ACCOUNT_KEY.exec(key)
  if (match === null) return undefined
  const source = match[1] as PlanSource
  return match[2] === undefined ? { key, source } : { key, source, connectionId: match[2] }
}

export function cleanLimits(value: unknown): AllLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, PlanLimits> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ACCOUNTS)) {
    const account = accountOfKey(key)
    if (account === undefined || entry === null || typeof entry !== "object") continue
    const { plan, windows, extraUsage, at } = entry as Record<string, unknown>
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) continue
    const parsed = LiveFrameSchema.safeParse({ liveSeq: 0, type: "plan.limits", source: account.source, plan, windows, extraUsage })
    if (!parsed.success || parsed.data.type !== "plan.limits") continue
    out[key] = { ...(parsed.data.plan === undefined ? {} : { plan: parsed.data.plan }), windows: parsed.data.windows, ...(parsed.data.extraUsage === undefined ? {} : { extraUsage: parsed.data.extraUsage }), at }
  }
  return out
}

export function loadPlanLimits(storage: Pick<Storage, "getItem">): AllLimits {
  try {
    return Object.fromEntries(Object.entries(cleanLimits(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}"))).filter(([key]) => accountOfKey(key)?.source !== "codex"))
  } catch {
    return {}
  }
}

export const usePlanLimits = create<AllLimits>(() => (typeof localStorage === "undefined" ? {} : loadPlanLimits(localStorage)))

/** What still holds now: windows that have not reset since, from a reading under a week old. */
export function currentLimits(limits: PlanLimits | undefined, now: number): PlanLimits | undefined {
  if (limits === undefined || now - limits.at > MAX_AGE_MS) return undefined
  const windows = limits.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now)
  return windows.length === 0 ? undefined : { ...limits, windows }
}

/** Window order in the card: the short window first, then the weekly ones, each model's last. */
const ORDER: readonly PlanWindow["id"][] = ["five-hour", "primary", "weekly", "secondary", "weekly-opus", "weekly-sonnet", "weekly-model"]

/** A window's identity across updates: models each have a weekly window of their own. */
export function windowKey(window: PlanWindow): string {
  return window.model === undefined ? window.id : `${window.id}:${window.model}`
}

/** An update can name only some windows; the others keep what was said before. */
export function mergeLimits(previous: PlanLimits | undefined, frame: Pick<PlanFrame, "plan" | "windows" | "extraUsage">, now: number): PlanLimits {
  const byKey = new Map((previous?.windows ?? []).map((window) => [windowKey(window), window]))
  for (const window of frame.windows) {
    const key = windowKey(window)
    const previous = byKey.get(key)
    if (previous?.resetsAt !== undefined && previous.resetsAt <= now && window.resetsAt === undefined) {
      const { resetsAt: _expired, ...rest } = previous
      byKey.set(key, { ...rest, ...window })
    } else byKey.set(key, { ...previous, ...window })
  }
  const windows = [...byKey.values()].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
  const plan = frame.plan ?? previous?.plan
  const extraUsage = frame.extraUsage ?? previous?.extraUsage
  return { ...(plan === undefined ? {} : { plan }), windows, ...(extraUsage === undefined ? {} : { extraUsage }), at: now }
}

/** The plan frames in a batch of live frames, checked. */
export function planFrames(frames: readonly { readonly kind: string; readonly data: unknown }[]): readonly PlanFrame[] {
  return frames.flatMap((frame) => {
    if (frame.kind === "event" || (frame.data as { readonly type?: unknown } | null)?.type !== "plan.limits") return []
    const parsed = LiveFrameSchema.safeParse(frame.data)
    return parsed.success && parsed.data.type === "plan.limits" ? [parsed.data] : []
  })
}

function savePlanLimits(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(usePlanLimits.getState()).filter(([key]) => accountOfKey(key)?.source !== "codex"))))
  } catch {
    // Private mode or a full store: the tool says it again on a later read.
  }
}

/** Files a reading under the account it is about. */
export function notePlanReading(account: PlanAccount, frame: Pick<PlanFrame, "source" | "plan" | "windows" | "extraUsage">, now = Date.now()): void {
  if (frame.source !== account.source) return
  usePlanLimits.setState((state) => ({ [account.key]: mergeLimits(account.source === "codex" ? undefined : state[account.key], { ...(frame.plan === undefined ? {} : { plan: frame.plan }), windows: frame.windows, ...(frame.extraUsage === undefined ? {} : { extraUsage: frame.extraUsage }) }, now) }))
  savePlanLimits()
}

export function forgetPlanReading(key: string): void {
  usePlanLimits.setState((state) => Object.fromEntries(Object.entries(state).filter(([entry]) => entry !== key)), true)
  savePlanLimits()
}

/** Forgets the readings of connections that are gone; the usual logins stay. */
export function forgetPlanAccounts(keep: (connectionId: string) => boolean): void {
  const state = usePlanLimits.getState()
  const gone = Object.keys(state).filter((key) => {
    const connectionId = accountOfKey(key)?.connectionId
    return connectionId !== undefined && !keep(connectionId)
  })
  if (gone.length === 0) return
  usePlanLimits.setState(Object.fromEntries(Object.entries(state).filter(([key]) => !gone.includes(key))), true)
  savePlanLimits()
}

export function planSourceOf(backend: BackendId | undefined): PlanSource | undefined {
  return backend === "codex" || backend === "claude-code" ? backend : undefined
}

const WINDOW_LABEL: Readonly<Record<PlanWindow["id"], string>> = {
  "five-hour": "5-hour limit",
  weekly: "Weekly",
  "weekly-opus": "Weekly · Opus",
  "weekly-sonnet": "Weekly · Sonnet",
  "weekly-model": "Weekly",
  primary: "Short window",
  secondary: "Long window",
}

export function windowLabel(window: PlanWindow, source?: PlanSource): string {
  if (window.id === "five-hour" && source === "claude-code") return "Session limit"
  if (window.id === "weekly-model" && window.model !== undefined) return `Weekly · ${window.model}`
  if ((window.id === "primary" || window.id === "secondary") && window.windowMinutes !== undefined) return `${durationText(window.windowMinutes)} limit`
  return WINDOW_LABEL[window.id]
}

function durationText(minutes: number): string {
  if (minutes % 1_440 === 0) return minutes === 1_440 ? "Daily" : `${String(minutes / 1_440)}-day`
  if (minutes % 60 === 0) return `${String(minutes / 60)}-hour`
  return `${String(minutes)}-minute`
}

const PLAN_NAMES: Readonly<Record<string, string>> = { plus: "Plus", pro: "Pro", prolite: "Pro Lite", promax: "Pro Max", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu", go: "Go", free: "Free", max: "Max" }

export function planName(plan: string): string {
  return PLAN_NAMES[plan] ?? plan.replace(/[_-]+/g, " ")
}

export function planLabel(source: PlanSource, plan: string | undefined): string {
  const tool = toolName(source)
  if (plan === undefined) return `${tool} plan`
  return `${tool} plan · ${planName(plan)}`
}

/** The sidebar footer names a window in a few letters: `5h`, `wk`, `wk Opus`, `wk Fable`. */
export function shortWindowLabel(window: PlanWindow, source?: PlanSource): string {
  if (window.id === "five-hour" && source === "claude-code") return "session"
  if (window.id === "five-hour") return "5h"
  if (window.id === "weekly") return "wk"
  if (window.id === "weekly-opus") return "wk Opus"
  if (window.id === "weekly-sonnet") return "wk Sonnet"
  if (window.id === "weekly-model") return window.model === undefined ? "wk" : `wk ${window.model}`
  const minutes = window.windowMinutes
  if (minutes === undefined) return window.id === "primary" ? "short" : "long"
  if (minutes === 10_080) return "wk"
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}d`
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`
  return `${String(minutes)}m`
}

/** Green under 80% used, amber from 80%, red from 95%: the context ring, card and plan meters. */
export function usageLevel(share: number): "is-full" | "is-high" | "is-ok" {
  return share >= 0.95 ? "is-full" : share >= 0.8 ? "is-high" : "is-ok"
}

/** The window closest to its limit; on a tie, the shorter one. */
export function tightestWindow(limits: PlanLimits): PlanWindow | undefined {
  return limits.windows.reduce<PlanWindow | undefined>((tightest, window) => (tightest === undefined || window.usedPercent > tightest.usedPercent ? window : tightest), undefined)
}

const SHORT_WINDOWS: ReadonlySet<PlanWindow["id"]> = new Set(["five-hour", "primary"])

/** A footer line's pair: the short window and the tightest long one, a model's own included. */
export function footerWindows(limits: PlanLimits): readonly PlanWindow[] {
  const short = limits.windows.find((window) => SHORT_WINDOWS.has(window.id))
  const longer = tightestWindow({ ...limits, windows: limits.windows.filter((window) => !SHORT_WINDOWS.has(window.id)) })
  return [short, longer].filter((window): window is PlanWindow => window !== undefined)
}

export interface PlanReading {
  readonly account: PlanAccount
  readonly limits: PlanLimits
}

/** Every account with a reading that still holds: Claude Code first, each tool's usual login before its own folders. */
export function planReadings(all: AllLimits, now: number): readonly PlanReading[] {
  const readings = Object.entries(all).flatMap(([key, stored]): PlanReading[] => {
    const account = accountOfKey(key)
    const limits = currentLimits(stored, now)
    return account === undefined || limits === undefined ? [] : [{ account, limits }]
  })
  const rank = (account: PlanAccount): number => (account.source === "claude-code" ? 0 : 2) + (account.connectionId === undefined ? 0 : 1)
  return readings.sort((a, b) => rank(a.account) - rank(b.account) || a.account.key.localeCompare(b.account.key))
}

export function toolName(source: PlanSource): string {
  return source === "codex" ? "Codex" : "Claude Code"
}

/** "Resets in 1 hr 41 min", or the day and time when it is further off. */
export function resetText(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined
  const left = resetsAt - now
  if (left <= 0) return "Resets now"
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `Resets in ${String(minutes)} min`
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `Resets in ${String(hours)} hr${rest === 0 ? "" : ` ${String(rest)} min`}`
  }
  const when = new Date(resetsAt)
  return `Resets ${when.toLocaleDateString(undefined, { weekday: "short" })} ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
}
