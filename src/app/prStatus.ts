import type { PullRequestStatusEntry } from "../protocol/schemas"
import { MAX_THREAD_PULL_REQUESTS, type ThreadPullRequest } from "./persist"

/**
 * The pull request chip in the thread bar, the cards in the timeline, and when PR status is read
 * again. Pure, so each case is a test.
 */

/** A merged or closed PR stays on the chip this long after it was merged or closed. */
export const SETTLED_SHOWN_MS = 24 * 3_600_000
export const PR_OPEN_INTERVAL_MS = 5 * 60_000
export const PR_POLL_MS = 60_000
export const PR_POLL_LIMIT_MS = 30 * 60_000
export const PR_POLL_FAILURES = 3

export type PrTone = "green" | "amber" | "red" | "gray" | "purple" | "muted"

export interface PrView {
  readonly state: "loading" | "ready" | "not-connected" | "unavailable" | "error"
  readonly pullRequests: readonly PullRequestStatusEntry[]
  /** The repository the pull requests are in, as the engine read it from the remote. */
  readonly owner?: string
  readonly repo?: string
  /** The branch these were read for; a read for another branch is not shown. */
  readonly branch?: string
  readonly readAt?: number
  readonly failures: number
  /** When the current run of 60-second reads began; a push starts a new one. */
  readonly pollFrom?: number
  readonly message?: string
}

export type PrChip =
  | { readonly kind: "pr"; readonly pull: PullRequestStatusEntry; readonly label: string; readonly tone: PrTone; readonly checks?: { readonly text: string; readonly tone: PrTone }; readonly notes: readonly { readonly text: string; readonly tone: PrTone }[] }
  | { readonly kind: "create" }
  | { readonly kind: "connect" }

/** The open PR, else the newest closed or merged one still within a day of settling. */
export function pickPullRequest(pulls: readonly PullRequestStatusEntry[], now: number): PullRequestStatusEntry | undefined {
  const open = pulls.find((pull) => pull.state === "open")
  if (open !== undefined) return open
  const settled = pulls
    .map((pull) => ({ pull, at: pull.state === "merged" ? pull.mergedAt : pull.closedAt }))
    .filter((entry): entry is { pull: PullRequestStatusEntry; at: number } => entry.at !== undefined && now - entry.at < SETTLED_SHOWN_MS)
    .sort((a, b) => b.at - a.at)
  return settled[0]?.pull
}

export function checksLabel(checks: PullRequestStatusEntry["checks"]): { readonly text: string; readonly tone: PrTone } | undefined {
  if (checks === undefined) return undefined
  const total = checks.passed + checks.failed + checks.pending + checks.skipped
  if (total === 0) return undefined
  const done = checks.passed + checks.skipped
  if (checks.failed > 0) return { text: `✕ ${String(checks.failed)} failing`, tone: "red" }
  if (checks.pending > 0) return { text: `◌ ${String(done)}/${String(total)}`, tone: "amber" }
  return { text: `✓ ${String(done)}/${String(total)}`, tone: "green" }
}

/** Branches a pull request is not opened from. */
const TRUNKS = new Set(["main", "master", "trunk", "develop"])

export function prChip(input: { readonly view: PrView | undefined; readonly branch: string | undefined; readonly published: boolean; readonly offered: boolean; readonly now: number }): PrChip | undefined {
  const view = input.view
  if (!input.offered || input.branch === undefined || view === undefined) return undefined
  if (view.state === "not-connected") return { kind: "connect" }
  if (view.state === "unavailable") return undefined
  if (view.branch !== input.branch) return undefined
  const pull = pickPullRequest(view.pullRequests, input.now)
  if (pull === undefined) return view.state === "ready" && input.published && !TRUNKS.has(input.branch) ? { kind: "create" } : undefined
  const number = `#${String(pull.number)}`
  if (pull.state === "merged") return { kind: "pr", pull, label: `${number} · Merged`, tone: "purple", notes: [] }
  if (pull.state === "closed") return { kind: "pr", pull, label: `${number} · Closed`, tone: "gray", notes: [] }
  const notes: { text: string; tone: PrTone }[] = []
  if (pull.review === "changes-requested") notes.push({ text: "Changes requested", tone: "red" })
  if (pull.review === "approved") notes.push({ text: "Approved", tone: "green" })
  if (pull.mergeable === "conflicts") notes.push({ text: "Conflicts", tone: "red" })
  if (pull.draft === true) return { kind: "pr", pull, label: `${number} · Draft`, tone: "gray", notes }
  const checks = checksLabel(pull.checks)
  return { kind: "pr", pull, label: `${number} · Open`, tone: checks?.tone ?? "green", ...(checks === undefined ? {} : { checks }), notes }
}

export function hasPendingCheck(view: PrView | undefined, now: number): boolean {
  const pull = view === undefined ? undefined : pickPullRequest(view.pullRequests, now)
  return pull?.state === "open" && (pull.checks?.pending ?? 0) > 0
}

/**
 * Whether the 60-second read keeps going: only while a check is pending and the thread is
 * on screen, for at most 30 minutes from its start, and not after three failed reads in a row.
 */
export function keepPolling(input: { readonly view: PrView | undefined; readonly onScreen: boolean; readonly now: number }): boolean {
  const view = input.view
  if (view === undefined || !input.onScreen || view.failures >= PR_POLL_FAILURES) return false
  if (!hasPendingCheck(view, input.now)) return false
  return view.pollFrom !== undefined && input.now - view.pollFrom < PR_POLL_LIMIT_MS
}

/** Opening a thread reads PR status at most once per five minutes per branch. */
export function openReadDue(view: PrView | undefined, branch: string, now: number): boolean {
  return view?.branch !== branch || view.readAt === undefined || now - view.readAt >= PR_OPEN_INTERVAL_MS
}

/**
 * The thread's PR records after a read: the first read keeps the PRs that already exist without
 * a card; a PR seen later gets a card after `turnId`, the turn it became known in.
 */
export function notePullRequests(known: readonly ThreadPullRequest[] | undefined, pulls: readonly PullRequestStatusEntry[], at: number, turnId: string | undefined): readonly ThreadPullRequest[] | undefined {
  const first = known === undefined
  const list = [...(known ?? [])]
  let changed = first
  for (const pull of pulls) {
    if (list.some((entry) => entry.number === pull.number)) continue
    list.push({ number: pull.number, ...(pull.url === undefined ? {} : { url: pull.url }), ...(first || turnId === undefined ? {} : { turnId }), at, card: !first })
    changed = true
  }
  return changed ? list.slice(-MAX_THREAD_PULL_REQUESTS) : known
}

/** A PR made from the Review pane gets its card after the turn it was made in. */
export function noteCreatedPullRequest(known: readonly ThreadPullRequest[] | undefined, pull: { readonly number: number; readonly url?: string }, at: number, turnId: string | undefined): readonly ThreadPullRequest[] {
  const others = (known ?? []).filter((entry) => entry.number !== pull.number)
  return [...others, { number: pull.number, ...(pull.url === undefined ? {} : { url: pull.url }), ...(turnId === undefined ? {} : { turnId }), at, card: true }].slice(-MAX_THREAD_PULL_REQUESTS)
}

export interface CardRowPlace {
  /** The row index the card goes before. */
  readonly before: number
  readonly number: number
}

/**
 * Where each card goes among the timeline's rows: after its turn's end row, or, when that turn
 * is not loaded, before the first row that came later than the card; else at the end.
 */
export function placeCards(rows: readonly { readonly turnEnd?: string; readonly at?: number; readonly footer?: boolean }[], cards: readonly ThreadPullRequest[]): readonly CardRowPlace[] {
  const end = rows.findIndex((row) => row.footer === true)
  const last = end < 0 ? rows.length : end
  const places: CardRowPlace[] = []
  for (const card of cards) {
    if (!card.card) continue
    const turn = card.turnId === undefined ? -1 : rows.findIndex((row) => row.turnEnd === card.turnId)
    if (turn >= 0) {
      places.push({ before: turn + 1, number: card.number })
      continue
    }
    const later = rows.findIndex((row, index) => index < last && row.at !== undefined && row.at > card.at)
    places.push({ before: later < 0 ? last : later, number: card.number })
  }
  return places.sort((a, b) => a.before - b.before)
}
