import { HostError, getHost, toHostError } from "../host"
import { FailedChecksSchema, parseOr, ReviewDetailSchema, type FailedChecks, type PullRequestStatusEntry } from "../protocol/schemas"
import { ciFixMessage } from "../thread/ciLogs"
import { isBusy } from "../thread/reducer"
import { confirmAction } from "./actions"
import { onTurnEnded, send, threadRpc } from "./engines"
import { gitHubHostOf, refreshPullRequests } from "./gitBar"
import { pickPullRequest, PR_POLL_MS } from "./prStatus"
import { get, patchThread, runtimeOf, threadById, toast, useApp } from "./store"

/**
 * CI on the pull request chip. "Fix failing checks" sends the thread's agent the
 * end of each failing GitHub Actions job's log, in a block after the request that the bubble hides.
 * A watch, off until the person turns it on for one pull request, does that by itself for each new
 * head that fails, asks the agent to push the fix, and stops after three fixes that did not pass.
 * "Merge when green" turns on GitHub's auto-merge for the head the person saw.
 */

export const MAX_WATCH_ROUNDS = 3
export const MAX_WATCH_FAILURES = 3
const MAX_WATCH_FAILURE_COUNT = 100
const MAX_HEADS = 10
const MAX_WATCH_POLL_MS = 5 * 60_000

/** Error backoff: the first retry is one minute, capped at five. */
export function watchPollDelay(failures: number): number {
  return Math.min(PR_POLL_MS * 2 ** Math.max(0, failures), MAX_WATCH_POLL_MS)
}

function repositoryOf(threadId: string): { readonly owner: string; readonly repo: string } | undefined {
  const view = get().git[threadId]?.pr
  return view?.owner === undefined || view.repo === undefined ? undefined : { owner: view.owner, repo: view.repo }
}

function hostParam(threadId: string): { readonly host?: string } {
  const host = gitHubHostOf(threadId)
  return host === "github.com" ? {} : { host }
}

export async function readFailedChecks(threadId: string, number: number): Promise<FailedChecks> {
  const where = repositoryOf(threadId)
  if (where === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "the pull request's repository is not known yet")
  const logs = parseOr(FailedChecksSchema, await threadRpc(threadId, "git.pr.checks.logs", { ...where, number, ...hostParam(threadId) }))
  if (logs === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "the failing checks could not be read")
  return logs
}

/** Sends the agent the failing checks' logs; false when there was nothing to fix or it failed. */
export async function fixFailingChecks(threadId: string, number: number, push = false, maySend?: () => boolean): Promise<{ readonly sent: boolean; readonly headCommit?: string }> {
  const where = repositoryOf(threadId)
  try {
    const logs = await readFailedChecks(threadId, number)
    if (logs.failed === 0 || where === undefined) {
      if (!push) toast("info", "No checks are failing now.")
      return { sent: false }
    }
    if (maySend !== undefined && !maySend()) return { sent: false }
    send(threadId, { text: ciFixMessage({ ...where, logs, push }) })
    return { sent: true, ...(logs.headCommit === undefined ? {} : { headCommit: logs.headCommit }) }
  } catch (error) {
    toast("error", `Could not read the failing checks: ${toHostError(error).message}`)
    return { sent: false }
  }
}

export type WatchStep = "fix" | "wait" | "passed" | "give-up" | "end"

/** What a watch does after a read of the thread's pull requests. */
export function watchStep(watch: NonNullable<ReturnType<typeof threadById>>["ciWatch"], pull: PullRequestStatusEntry | undefined): WatchStep {
  if (watch === undefined) return "wait"
  if (pull === undefined || pull.number !== watch.number || pull.state !== "open") return "end"
  const checks = pull.checks
  if (checks === undefined || checks.pending > 0 || checks.passed + checks.failed + checks.skipped === 0) return "wait"
  if (checks.failed === 0) return "passed"
  // Asked once per pushed commit; a head the agent was already asked about waits for its push.
  if (pull.headCommit === undefined || watch.heads.includes(pull.headCommit)) return "wait"
  return watch.rounds >= MAX_WATCH_ROUNDS ? "give-up" : "fix"
}

export function watchChecks(threadId: string, number: number, on: boolean): void {
  if (!on) {
    stopWatch(threadId)
    return
  }
  invalidateWatch(threadId)
  patchThread(threadId, { ciWatch: { number, heads: [], rounds: 0, failures: 0 } })
  void refreshWatch(threadId, "click")
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const polling = new Map<string, Promise<void>>()
const acting = new Set<string>()
const generations = new Map<string, number>()
const knownWatches = new Set<string>()
let initialized = false
let syncing = false

function generation(threadId: string): number {
  return generations.get(threadId) ?? 0
}

function invalidateWatch(threadId: string): void {
  generations.set(threadId, generation(threadId) + 1)
}

function clearTimer(threadId: string): void {
  const timer = timers.get(threadId)
  if (timer === undefined) return
  clearTimeout(timer)
  timers.delete(threadId)
}

function watchedThread(threadId: string, number?: number): boolean {
  const thread = threadById(threadId)
  return thread !== undefined && thread.archived !== true && thread.ciWatch !== undefined && (number === undefined || thread.ciWatch.number === number)
}

function stopWatch(threadId: string): void {
  clearTimer(threadId)
  invalidateWatch(threadId)
  if (threadById(threadId)?.ciWatch !== undefined) patchThread(threadId, { ciWatch: undefined })
}

function noteWatchCheck(threadId: string, number: number, passed: boolean): void {
  const thread = threadById(threadId)
  const watch = thread?.ciWatch
  if (thread === undefined || thread.archived === true || watch === undefined || watch.number !== number) return
  if (!polling.has(threadId)) clearTimer(threadId)
  patchThread(threadId, {
    ciWatch: {
      ...watch,
      lastCheckedAt: Date.now(),
      failures: passed ? 0 : Math.min(MAX_WATCH_FAILURE_COUNT, (watch.failures ?? 0) + 1),
    },
  })
}

async function step(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const watch = thread?.ciWatch
  if (thread === undefined || thread.archived === true || watch === undefined) return
  const view = get().git[threadId]?.pr
  if (view?.state !== "ready") return
  const pull = view.pullRequests.find((entry) => entry.number === watch.number) ?? pickPullRequest(view.pullRequests, Date.now())
  const next = watchStep(watch, pull)
  if (next === "end") {
    stopWatch(threadId)
    return
  }
  if (next === "passed") {
    if (watch.rounds > 0) {
      patchThread(threadId, { ciWatch: { ...watch, rounds: 0 } })
      toast("success", `The checks on #${String(watch.number)} pass now.`)
    }
    return
  }
  if (next === "give-up") {
    stopWatch(threadId)
    toast("error", `The checks on #${String(watch.number)} still fail after ${String(MAX_WATCH_ROUNDS)} fixes. Stopped watching them.`)
    return
  }
  // A running turn may be the fix itself; its end reads the pull request again.
  if (next !== "fix" || acting.has(threadId) || isBusy(runtimeOf(threadId).timeline)) return
  const head = pull?.headCommit
  if (head === undefined) return
  const token = generation(threadId)
  acting.add(threadId)
  try {
    const sent = await fixFailingChecks(threadId, watch.number, true, () => generation(threadId) === token && watchedThread(threadId, watch.number))
    const current = threadById(threadId)?.ciWatch
    if (generation(threadId) !== token || current === undefined || current.number !== watch.number) return
    const attemptedHeads = sent.sent ? [head, ...(sent.headCommit === undefined ? [] : [sent.headCommit])] : []
    const heads = [...new Set([...current.heads, ...attemptedHeads])].slice(-MAX_HEADS)
    patchThread(threadId, { ciWatch: { ...current, heads, rounds: current.rounds + (sent.sent ? 1 : 0) } })
  } finally {
    acting.delete(threadId)
  }
}

function schedule(threadId: string): void {
  if (!initialized || timers.has(threadId) || polling.has(threadId)) return
  const watch = threadById(threadId)?.ciWatch
  if (!watchedThread(threadId) || watch === undefined) return
  timers.set(
    threadId,
    setTimeout(() => {
      timers.delete(threadId)
      if (watchedThread(threadId)) void refreshWatch(threadId)
    }, watchPollDelay(watch.failures ?? 0)),
  )
}

function refreshWatch(threadId: string, reason: "click" | "poll" = "poll"): Promise<void> {
  if (!initialized || !watchedThread(threadId)) return Promise.resolve()
  const inFlight = polling.get(threadId)
  if (inFlight !== undefined) return inFlight
  clearTimer(threadId)
  let request: Promise<void>
  request = refreshPullRequests(threadId, reason)
    .catch(() => undefined)
    .finally(() => {
      if (polling.get(threadId) === request) polling.delete(threadId)
      // A watch can be turned off and back on while this request is in flight. The old
      // generation must not act on the new watch, but the new watch still needs its poll timer.
      schedule(threadId)
    })
  polling.set(threadId, request)
  return request
}

function refreshActiveWatches(): void {
  for (const thread of get().threads) if (thread.ciWatch !== undefined && thread.archived !== true) void refreshWatch(thread.id)
}

function sync(): void {
  if (!initialized || syncing) return
  syncing = true
  try {
    for (const thread of get().threads) {
      if (thread.archived === true && thread.ciWatch !== undefined) {
        clearTimer(thread.id)
        patchThread(thread.id, { ciWatch: undefined })
      }
    }
    const watched = new Set(get().threads.flatMap((thread) => (thread.ciWatch === undefined || thread.archived === true ? [] : [thread.id])))
    for (const threadId of knownWatches) {
      if (watched.has(threadId)) continue
      invalidateWatch(threadId)
      knownWatches.delete(threadId)
    }
    for (const [threadId] of timers) if (!watched.has(threadId)) clearTimer(threadId)
    for (const threadId of watched) {
      knownWatches.add(threadId)
      schedule(threadId)
    }
  } finally {
    syncing = false
  }
}

export function initCiWatch(): () => void {
  initialized = true
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.threads !== previous.threads) sync()
    if (state.git === previous.git) return
    for (const thread of state.threads) {
      if (thread.ciWatch === undefined || thread.archived === true) continue
      const current = state.git[thread.id]?.pr
      if (current === previous.git[thread.id]?.pr) continue
      if (current !== undefined && current.state !== "loading") noteWatchCheck(thread.id, thread.ciWatch.number, current.state === "ready")
      void step(thread.id)
    }
  })
  const offEnd = onTurnEnded((threadId) => {
    if (watchedThread(threadId)) void refreshWatch(threadId)
  })
  const offBackground = getHost().onBackground((hidden) => {
    if (!hidden) refreshActiveWatches()
  })
  const onForeground = (): void => {
    if (typeof document === "undefined" || document.visibilityState === "visible") refreshActiveWatches()
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onForeground)
    window.addEventListener("pageshow", onForeground)
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onForeground)
  sync()
  refreshActiveWatches()
  return () => {
    initialized = false
    unsubscribe()
    offEnd()
    offBackground()
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onForeground)
      window.removeEventListener("pageshow", onForeground)
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onForeground)
    for (const threadId of timers.keys()) clearTimer(threadId)
    knownWatches.clear()
  }
}

const METHOD_ORDER = ["squash", "merge", "rebase"] as const
const METHOD_WORDS: Readonly<Record<(typeof METHOD_ORDER)[number], string>> = { squash: "squash-merge", merge: "merge", rebase: "rebase-merge" }

/**
 * "Merge when green": reads the pull request for its head and the methods the repository allows,
 * asks the person, then turns on auto-merge for that head only.
 */
export async function mergeWhenGreen(threadId: string, number: number): Promise<void> {
  const where = repositoryOf(threadId)
  if (where === undefined) return
  let detail
  try {
    detail = parseOr(ReviewDetailSchema, await threadRpc(threadId, "git.pr.view", { ...where, number, ...hostParam(threadId) }))
  } catch (error) {
    toast("error", `Could not read #${String(number)}: ${toHostError(error).message}`)
    return
  }
  const method = METHOD_ORDER.find((entry) => detail?.mergeMethods.includes(entry))
  const headCommit = detail?.headCommit
  if (detail === undefined || method === undefined || headCommit === undefined) {
    toast("error", `#${String(number)} cannot be merged from here: the repository allows no merge method Runrail can use.`)
    return
  }
  confirmAction({
    title: `Merge #${String(number)} when its checks pass?`,
    body: `GitHub will ${METHOD_WORDS[method]} "${detail.title ?? `#${String(number)}`}" into ${detail.base ?? "its base branch"} once its required checks pass and its reviews allow it, including any fix pushed before then. The repository must allow auto-merge; it can be turned off on GitHub.`,
    confirm: "Merge when green",
    onConfirm: () =>
      void threadRpc(threadId, "git.pr.merge", { ...where, number, ...hostParam(threadId), confirm: true, auto: true, method, headCommit })
        .then(() => {
          toast("success", `#${String(number)} merges when its checks pass.`)
          void refreshPullRequests(threadId, "click")
        })
        .catch((error: unknown) => toast("error", `Could not turn on auto-merge: ${toHostError(error).message}`)),
  })
}
