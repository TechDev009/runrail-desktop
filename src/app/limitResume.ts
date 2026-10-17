import type { NoticeItem, TimelineItem } from "../thread/reducer"
import { ensureEngine, onSendFailed, onTurnEnded, retry, send } from "./engines"
import { planSourceOf, usePlanLimits, type AllLimits } from "./limits"
import { get, patchThread, runtimeOf, threadById, toast, useApp } from "./store"

/**
 * Continue when a usage limit resets. A turn the provider refused for a usage
 * limit ends with a card that says when the limit resets. "Continue when the limit resets" keeps a
 * wait with the thread (saved with it, without its message), and 30 seconds after the reset the
 * thread goes on: with "Continue" when the turn had begun to answer, or with its message again
 * when nothing came back. Any message sent to the thread before then drops the wait. While one
 * waits, Runrail stays in the menu bar when its window closes (`stayRunning.ts`). A message held
 * because the plan was already used up (`limitCheck.ts`) gets the same card and goes itself.
 */

export const RESUME_DELAY_MS = 30_000
export const CONTINUE_PROMPT = "Continue"
const LIMIT_CODE = /RATE_LIMITED$/
const RESET_TEXT = / ?Resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\./
// The longest a timer can wait; a later reset is armed again when this one fires.
const MAX_TIMER_MS = 2 ** 31 - 1

export function isLimitNotice(item: NoticeItem): boolean {
  return item.level === "error" && LIMIT_CODE.test(item.code)
}

/** The reset the engine's message names ("... Resets at <ISO>."), and the message without it. */
export function readLimitMessage(message: string | undefined): { readonly text: string; readonly resetAt?: number } {
  const text = message ?? "The usage limit was reached."
  const match = RESET_TEXT.exec(text)
  const at = match === null ? Number.NaN : Date.parse(match[1] as string)
  return Number.isFinite(at) ? { text: text.replace(RESET_TEXT, "").trim(), resetAt: at } : { text }
}

/** When a full window of the plan this thread's tool runs on resets, from its last reading. */
export function resetFromPlan(limits: AllLimits, source: string | undefined, connectionId: string | undefined, now: number): number | undefined {
  if (source === undefined) return undefined
  const reading = (connectionId === undefined ? undefined : limits[`${source}:${connectionId}`]) ?? limits[source]
  // Every full window must reset before a request goes through, so the latest of them counts.
  const resets = (reading?.windows ?? []).filter((window) => window.usedPercent >= 100 && window.resetsAt !== undefined && window.resetsAt > now).map((window) => window.resetsAt as number)
  return resets.length === 0 ? undefined : Math.max(...resets)
}

/** When the limit a notice reports resets: from its message, else from the plan's last reading. */
export function limitReset(threadId: string, item: NoticeItem, now = Date.now()): number | undefined {
  const thread = threadById(threadId)
  return readLimitMessage(item.message).resetAt ?? resetFromPlan(usePlanLimits.getState(), planSourceOf(thread?.backend), thread?.connectionId, now)
}

/** Whether the turn had begun to answer, so "Continue" picks it up; otherwise its message goes again. */
export function answered(items: readonly TimelineItem[], turnId: string | undefined): boolean {
  if (turnId === undefined) return false
  return items.some((item) => "turnId" in item && item.turnId === turnId && ((item.kind === "assistant" && item.text.trim().length > 0) || item.kind === "tool"))
}

/** Whether going on means sending the limited turn's message again: it had not begun to answer. */
export function repeatsMessage(threadId: string, notice: NoticeItem): boolean {
  const items = runtimeOf(threadId).timeline.items
  const at = items.findIndex((item) => item.key === notice.key)
  // The turn a limit notice ended is the last one that ended before it; a message held for the limit had none.
  const end = items
    .slice(0, at < 0 ? items.length : at)
    .reverse()
    .find((item) => item.kind === "turn-end" || (item.kind === "user" && item.state === "failed"))
  if (end?.kind === "user") return true
  return !answered(items, end?.kind === "turn-end" ? end.turnId : undefined)
}

/** The thread's last limit notice, while no message has followed it. */
export function openLimit(items: readonly TimelineItem[]): NoticeItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as TimelineItem
    if (item.kind === "user") return undefined
    if (item.kind === "notice" && isLimitNotice(item)) return item
  }
  return undefined
}

/** Keeps a wait with the thread: it goes on 30 seconds after `resetAt`. */
export function continueAfterReset(threadId: string, notice: NoticeItem, resetAt: number): void {
  patchThread(threadId, { resume: { at: Math.max(resetAt + RESUME_DELAY_MS, Date.now() + 1_000), again: repeatsMessage(threadId, notice) } })
}

export function dropResume(threadId: string): void {
  if (threadById(threadId)?.resume !== undefined) patchThread(threadId, { resume: undefined })
}

/** Goes on now: what a wait does when it comes due, and "Try again" when the reset is not known. `lost`: the held message was gone. */
export async function resumeNow(threadId: string, again: boolean): Promise<"went" | "lost" | undefined> {
  const thread = threadById(threadId)
  if (thread === undefined || thread.archived === true) return undefined
  dropResume(threadId)
  if (!again) {
    send(threadId, { text: CONTINUE_PROMPT })
    return "went"
  }
  // The message itself is not saved with the wait; it is read back from the thread's history.
  await ensureEngine(threadId).catch(() => undefined)
  const items = runtimeOf(threadId).timeline.items
  // A message held for the limit is kept only while Runrail runs; its card goes with it, and the message before it is not the one to send.
  if (openLimit(items) === undefined) return "lost"
  const last = [...items].reverse().find((item) => item.kind === "user" && item.steer !== true)
  // A held message goes in its own place, under the key it was first given.
  if (last?.kind === "user" && last.state === "failed") retry(threadId, last.key)
  else send(threadId, { text: last?.kind === "user" && last.text.trim().length > 0 ? last.text : CONTINUE_PROMPT })
  return "went"
}

const timers = new Map<string, { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }>()
/** A wait that came due while Runrail was closed goes on a little after start, once connections are known. */
let notBefore = 0

function arm(threadId: string, at: number): void {
  const current = timers.get(threadId)
  if (current?.at === at) return
  if (current !== undefined) clearTimeout(current.timer)
  const wait = Math.min(Math.max(Math.max(at, notBefore) - Date.now(), 0), MAX_TIMER_MS)
  timers.set(threadId, {
    at,
    timer: setTimeout(() => {
      timers.delete(threadId)
      const resume = threadById(threadId)?.resume
      if (resume === undefined) return
      if (resume.at > Date.now()) return arm(threadId, resume.at)
      const title = threadById(threadId)?.title ?? "A thread"
      void resumeNow(threadId, resume.again).then((outcome) => {
        // Said even with notifications off: the wait promised a message that did not go.
        if (outcome === "lost") toast("info", `${title}: its usage limit reset, but the message held for it was not kept after Runrail quit. Send it again.`)
        else if (outcome === "went" && get().prefs.notifications) toast("info", `${title} went on after its usage limit reset.`)
      })
    }, wait),
  })
}

function sync(): void {
  const waiting = new Map(get().threads.flatMap((thread) => (thread.resume === undefined || thread.archived === true ? [] : [[thread.id, thread.resume.at] as const])))
  for (const [threadId, entry] of timers) {
    if (waiting.get(threadId) === entry.at) continue
    clearTimeout(entry.timer)
    timers.delete(threadId)
  }
  for (const [threadId, at] of waiting) arm(threadId, at)
}

/**
 * Arms the saved waits (one that came due while Runrail was closed goes on now), keeps them in
 * step with the threads, and, when the person chose to always continue, waits on each new limit.
 */
export function initLimitResume(startDelayMs = 5_000): () => void {
  notBefore = Date.now() + startDelayMs
  sync()
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.threads !== previous.threads) sync()
  })
  const waitOnLimit = (threadId: string): void => {
    if (!get().prefs.continueAfterLimit) return
    const notice = openLimit(runtimeOf(threadId).timeline.items)
    if (notice === undefined || threadById(threadId)?.resume !== undefined) return
    const resetAt = limitReset(threadId, notice)
    if (resetAt !== undefined) continueAfterReset(threadId, notice, resetAt)
  }
  const offEnd = onTurnEnded(waitOnLimit)
  // A message held for a used-up plan ends no turn.
  const offHeld = onSendFailed(waitOnLimit)
  return () => {
    unsubscribe()
    offEnd()
    offHeld()
    for (const entry of timers.values()) clearTimeout(entry.timer)
    timers.clear()
  }
}
