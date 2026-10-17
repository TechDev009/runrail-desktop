import { HostError } from "../host/types"
import { knownTools, listConnectionSettings } from "./connectionSettings"
import { accountOfKey, planAccount, planSourceOf, usePlanLimits, type PlanAccount, type PlanLimits, type PlanWindow } from "./limits"
import type { ThreadMeta } from "./persist"
import { lastUsageRead, readAccountUsage } from "./planUsage"

/** What a turn the provider refused for a usage limit ends with, so a held message shows the same card. */
export const PLAN_LIMIT_CODE = "COMMAND_AGENT_RATE_LIMITED"
/** The held message's own line; the card under it says which limit and when it resets. */
export const HELD_FOR_LIMIT = "Claude Code's usage limit is used up"
/** A reading that takes longer lets the message go; Claude Code still answers for the limit itself. */
const CHECK_MS = 10_000
/** The windows every model counts against, in the words Claude Code's own limit message uses. */
const ALL_MODELS: Partial<Readonly<Record<PlanWindow["id"], string>>> = { "five-hour": "five-hour", weekly: "weekly" }

/** The account a thread's tool runs as; none for a key, or a connection not listed yet. */
export async function threadAccount(thread: Pick<ThreadMeta, "backend" | "connectionId">): Promise<PlanAccount | undefined> {
  const source = planSourceOf(thread.backend)
  if (source === undefined) return undefined
  const connectionId = thread.connectionId
  const connection = connectionId === undefined ? undefined : (knownTools() ?? (await listConnectionSettings().catch(() => undefined))?.tools)?.find((tool) => tool.id === connectionId)
  // A connection that is gone, or not listed yet, could be another account than the usual one.
  if (connectionId !== undefined && connection === undefined) return undefined
  return planAccount(source, connection)
}

/** The used-up window every request counts against that resets last, unless extra usage covers it. */
export function usedUpWindow(limits: PlanLimits | undefined, now: number): (PlanWindow & { readonly resetsAt: number }) | undefined {
  if (limits === undefined || limits.extraUsage === true) return undefined
  let found: (PlanWindow & { readonly resetsAt: number }) | undefined
  for (const window of limits.windows) {
    if (ALL_MODELS[window.id] === undefined || window.usedPercent < 100 || window.resetsAt === undefined || window.resetsAt <= now) continue
    if (found === undefined || window.resetsAt > found.resetsAt) found = { ...window, resetsAt: window.resetsAt }
  }
  return found
}

/** Whether a reading of any of the tool's accounts says its plan is used up; a send otherwise goes without waiting. */
export function mayHoldForLimit(thread: Pick<ThreadMeta, "backend">, now = Date.now()): boolean {
  if (thread.backend !== "claude-code") return false
  return Object.entries(usePlanLimits.getState()).some(([key, limits]) => accountOfKey(key)?.source === "claude-code" && usedUpWindow(limits, now) !== undefined)
}

/**
 * Claude Code can take a minute or more to say a used-up plan refused a message. When the last
 * reading says the plan is used up, it is read again first (a few seconds), and a message the plan
 * cannot take is held with the limit's words instead of sent.
 */
export async function planLimitRefusal(thread: Pick<ThreadMeta, "backend" | "connectionId">): Promise<HostError | undefined> {
  if (thread.backend !== "claude-code") return undefined
  const account = await threadAccount(thread)
  if (account === undefined || usedUpWindow(usePlanLimits.getState()[account.key], Date.now()) === undefined) return undefined
  const asked = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([readAccountUsage(account, 0), new Promise<void>((resolve) => (timer = setTimeout(resolve, CHECK_MS)))])
  clearTimeout(timer)
  // Only a reading taken now that says extra usage cannot help holds a message.
  const read = lastUsageRead(account.key)
  const limits = usePlanLimits.getState()[account.key]
  if (read === undefined || read < asked || limits?.extraUsage !== false) return undefined
  const window = usedUpWindow(limits, Date.now())
  if (window === undefined) return undefined
  return new HostError(PLAN_LIMIT_CODE, `Claude Code ${ALL_MODELS[window.id] ?? ""} usage limit reached. Resets at ${new Date(window.resetsAt).toISOString()}.`)
}
