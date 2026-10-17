import { HostError, toHostError } from "../host"
import { FailedChecksSchema, parseOr, ReviewDetailSchema, type FailedChecks, type PullRequestStatusEntry } from "../protocol/schemas"
import { ciFixMessage } from "../thread/ciLogs"
import { isBusy } from "../thread/reducer"
import { confirmAction } from "./actions"
import { onTurnEnded, send, threadRpc } from "./engines"
import { gitHubHostOf, refreshPullRequests } from "./gitBar"
import { pickPullRequest, PR_POLL_LIMIT_MS, PR_POLL_MS } from "./prStatus"
import { get, patchThread, runtimeOf, threadById, toast, useApp } from "./store"

/**
 * CI on the pull request chip. "Fix failing checks" sends the thread's agent the
 * end of each failing GitHub Actions job's log, in a block after the request that the bubble hides.
 * A watch, off until the person turns it on for one pull request, does that by itself for each new
 * head that fails, asks the agent to push the fix, and stops after three fixes that did not pass.
 * "Merge when green" turns on GitHub's auto-merge for the head the person saw.
 */

export const MAX_WATCH_ROUNDS = 3
const MAX_HEADS = 10

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
export async function fixFailingChecks(threadId: string, number: number, push = false): Promise<{ readonly sent: boolean; readonly headCommit?: string }> {
  const where = repositoryOf(threadId)
  try {
    const logs = await readFailedChecks(threadId, number)
    if (logs.failed === 0 || where === undefined) {
      if (!push) toast("info", "No checks are failing now.")
      return { sent: false }
    }
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
  patchThread(threadId, { ciWatch: on ? { number, heads: [], rounds: 0 } : undefined })
  if (on) {
    active.set(threadId, Date.now())
    void refreshPullRequests(threadId, "click")
  }
}

/** When each watched thread last moved: turned on, a fix sent, a turn ended. Reads stop 30 minutes after. */
const active = new Map<string, number>()
const acting = new Set<string>()

async function step(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const watch = thread?.ciWatch
  if (thread === undefined || watch === undefined || acting.has(threadId)) return
  const view = get().git[threadId]?.pr
  if (view?.state !== "ready") return
  const pull = view.pullRequests.find((entry) => entry.number === watch.number) ?? pickPullRequest(view.pullRequests, Date.now())
  const next = watchStep(watch, pull)
  if (next === "end") {
    patchThread(threadId, { ciWatch: undefined })
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
    patchThread(threadId, { ciWatch: undefined })
    toast("error", `The checks on #${String(watch.number)} still fail after ${String(MAX_WATCH_ROUNDS)} fixes. Stopped watching them.`)
    return
  }
  // A running turn may be the fix itself; its end reads the pull request again.
  if (next !== "fix" || isBusy(runtimeOf(threadId).timeline)) return
  acting.add(threadId)
  try {
    const head = pull?.headCommit as string
    const sent = await fixFailingChecks(threadId, watch.number, true)
    const current = threadById(threadId)?.ciWatch
    if (current === undefined || current.number !== watch.number) return
    active.set(threadId, Date.now())
    const heads = [...new Set([...current.heads, head, ...(sent.headCommit === undefined ? [] : [sent.headCommit])])].slice(-MAX_HEADS)
    patchThread(threadId, { ciWatch: { ...current, heads, rounds: current.rounds + (sent.sent ? 1 : 0) } })
  } finally {
    acting.delete(threadId)
  }
}

/** Keeps watched pull requests read every minute, on screen or not, until 30 minutes after the thread last moved. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function schedule(threadId: string): void {
  if (timers.has(threadId)) return
  const since = active.get(threadId) ?? Date.now()
  if (!active.has(threadId)) active.set(threadId, since)
  if (Date.now() - since >= PR_POLL_LIMIT_MS) return
  timers.set(
    threadId,
    setTimeout(() => {
      timers.delete(threadId)
      if (threadById(threadId)?.ciWatch === undefined) return
      void refreshPullRequests(threadId, "poll").then(() => schedule(threadId))
    }, PR_POLL_MS),
  )
}

function sync(): void {
  const watched = new Set(get().threads.flatMap((thread) => (thread.ciWatch === undefined || thread.archived === true ? [] : [thread.id])))
  for (const [threadId, timer] of timers) {
    if (watched.has(threadId)) continue
    clearTimeout(timer)
    timers.delete(threadId)
    active.delete(threadId)
  }
  for (const threadId of watched) schedule(threadId)
}

export function initCiWatch(): () => void {
  sync()
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.threads !== previous.threads) sync()
    if (state.git === previous.git) return
    for (const thread of state.threads) {
      if (thread.ciWatch !== undefined && state.git[thread.id]?.pr !== previous.git[thread.id]?.pr) void step(thread.id)
    }
  })
  const offEnd = onTurnEnded((threadId) => {
    if (threadById(threadId)?.ciWatch === undefined) return
    active.set(threadId, Date.now())
    schedule(threadId)
  })
  return () => {
    unsubscribe()
    offEnd()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    active.clear()
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
