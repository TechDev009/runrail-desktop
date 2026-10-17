import { create } from "zustand"
import { toHostError } from "../host"
import { GitDiffSchema, parseOr, type GitDiff } from "../protocol/schemas"
import { isBusy } from "../thread/reducer"
import { archiveThread, ensureEngine, onTurnEnded, send, threadRpc } from "./engines"
import { commentableLines, FINDINGS_FORMAT, type Finding } from "./reviewFindings"
import { addComments, type LineComment } from "./reviewMemory"
import { findingsOf } from "./reviews"
import { createThread, get, openThread, runtimeOf, threadById, toast } from "./store"

/**
 * "Review my changes": a second thread on the same tool and model reads the
 * checkout's uncommitted changes in Plan mode, with a security checklist, and ends with the
 * findings block the pull request reviews use. Each finding on a changed line lands in the first
 * thread's Review pane as a comment there; the rest are listed above the files. Nothing is sent to
 * the agent until the person sends the comments.
 */

/** The diff in the prompt, in characters; past it, files are named for the reviewer to read. */
export const REVIEW_DIFF_CHARS = 60_000

export const SECURITY_CHECKLIST = [
  "Input from outside (requests, files, environment, tool or model output) reaching a shell, SQL, a file path, a URL, HTML, or eval without validation or escaping",
  "Secrets, tokens, or personal data written to logs, errors, URLs, or files, or added to the code",
  "Authentication or authorization checks missing, skipped, or weakened",
  "Paths or symlinks that can leave the directory they are meant to stay in",
  "Unsafe deserialization, prototype pollution, or regular expressions open to catastrophic backtracking",
  "Requests to addresses taken from input, or TLS verification turned off",
  "Missing limits on size, count, or time, and races between a check and its use",
  "New dependencies, and widened permissions or file modes",
]

/** The changes as the reviewer reads them: whole patches while they fit, then file names only. */
export function diffForReview(diff: GitDiff, max = REVIEW_DIFF_CHARS): { readonly text: string; readonly unread: readonly string[] } {
  const parts: string[] = []
  const unread: string[] = []
  let used = 0
  for (const file of diff.files) {
    if (file.patch === undefined || file.sensitive === true || file.binary === true) {
      unread.push(file.path)
      continue
    }
    const part = `--- ${file.change === "added" ? "/dev/null" : `a/${file.originalPath ?? file.path}`}\n+++ b/${file.path}\n${file.patch.replace(/\n$/, "")}`
    if (used + part.length > max) {
      unread.push(file.path)
      continue
    }
    parts.push(part)
    used += part.length + 1
  }
  return { text: parts.join("\n"), unread }
}

export function selfReviewPrompt(input: { readonly diff: GitDiff; readonly focus?: string }): string {
  const { text, unread } = diffForReview(input.diff)
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)))
  const focus = input.focus?.trim()
  return [
    "Review the changes in this checkout that are not committed yet. The diff against HEAD is below; read the changed files around it for context.",
    "You are reviewing only: do not edit files, commit, push, or run commands that change anything.",
    "Look for bugs, security problems, missing tests, and changes that break callers. Skip style nits.",
    "Check the changed code against this security list:",
    ...SECURITY_CHECKLIST.map((item) => `- ${item}`),
    ...(focus === undefined || focus.length === 0 ? [] : [`Pay particular attention to: ${focus}`]),
    "",
    FINDINGS_FORMAT,
    ...(text.length === 0 ? [] : ["", `${fence}diff`, text, fence]),
    ...(unread.length === 0 ? [] : ["", `Not shown above (too large, binary, or withheld); read them yourself if they matter, except files that hold credentials: ${unread.join(", ")}`]),
  ].join("\n")
}

/** Findings on lines the diff shows become comments there; the others are listed apart. */
export function placeFindings(findings: readonly Finding[], diff: GitDiff, from: string): { readonly comments: readonly Omit<LineComment, "id">[]; readonly general: readonly Finding[] } {
  const patches = new Map(diff.files.flatMap((file) => (file.patch === undefined ? [] : [[file.path, file.patch] as const])))
  const lines = new Map<string, ReadonlySet<number>>()
  const comments: Omit<LineComment, "id">[] = []
  const general: Finding[] = []
  for (const finding of findings) {
    const patch = finding.path === undefined ? undefined : patches.get(finding.path)
    if (finding.path === undefined || finding.line === undefined || patch === undefined) {
      general.push(finding)
      continue
    }
    const known = lines.get(finding.path) ?? commentableLines(patch)
    lines.set(finding.path, known)
    if (!known.has(finding.line)) {
      general.push(finding)
      continue
    }
    comments.push({ path: finding.path, line: finding.line, side: "new", text: `${finding.title}${finding.body === undefined ? "" : `\n\n${finding.body}`}`, excerpt: "", from, severity: finding.severity })
  }
  return { comments, general }
}

export interface SelfReview {
  readonly reviewThreadId: string
  readonly state: "running" | "done" | "failed"
  readonly summary?: string
  readonly general: readonly Finding[]
  readonly placed: number
}

/** The latest review of each thread's changes, in memory only; its findings stay in the review thread. */
export const useSelfReviews = create<Readonly<Record<string, SelfReview>>>()(() => ({}))

function setReview(threadId: string, review: SelfReview | undefined): void {
  useSelfReviews.setState((state) => {
    const next = { ...state }
    if (review === undefined) delete next[threadId]
    else next[threadId] = review
    return next
  }, true)
}

export function dismissSelfReview(threadId: string): void {
  setReview(threadId, undefined)
}

const diffs = new Map<string, GitDiff>()

/** Starts the review thread, on the thread's own tool, model, and checkout, without opening it. */
export async function reviewMyChanges(threadId: string, focus?: string): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined || useSelfReviews.getState()[threadId]?.state === "running") return
  let diff: GitDiff | undefined
  try {
    diff = parseOr(GitDiffSchema, await threadRpc(threadId, "git.diff", { scope: "head", includeUntracked: true, contextLines: 3, maxFiles: 500, maxBytes: 4 * 1_024 * 1_024 }))
  } catch (error) {
    toast("error", `Could not read the changes: ${toHostError(error).message}`)
    return
  }
  if (diff === undefined || diff.files.length === 0) {
    toast("info", "There are no uncommitted changes to review.")
    return
  }
  // An earlier review that has finished goes to the archive, so reviews do not pile up in the list.
  for (const earlier of get().threads) if (earlier.reviewOf === threadId && earlier.archived !== true && !isBusy(runtimeOf(earlier.id).timeline)) void archiveThread(earlier.id, true)
  const review = createThread({
    projectId: thread.projectId,
    backend: thread.backend,
    ...(thread.model === undefined ? {} : { model: thread.model }),
    ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }),
    ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
    mode: "plan",
    permission: "ask",
    title: `Review: ${thread.title}`.slice(0, 120),
    // Shared: deleting the review keeps the checkout while the thread it reviews still has it.
    ...(thread.worktree === undefined ? {} : { worktree: thread.worktree }),
    reviewOf: threadId,
    select: false,
  })
  diffs.set(review.id, diff)
  setReview(threadId, { reviewThreadId: review.id, state: "running", general: [], placed: 0 })
  try {
    await ensureEngine(review.id)
    send(review.id, { text: selfReviewPrompt({ diff, ...(focus === undefined ? {} : { focus }) }) })
  } catch (error) {
    setReview(threadId, { reviewThreadId: review.id, state: "failed", general: [], placed: 0 })
    toast("error", `The review could not start: ${toHostError(error).message}`)
  }
}

/** When a review thread's turn ends, its findings go to the reviewed thread's Review pane. */
export function finishSelfReview(reviewThreadId: string): void {
  const review = threadById(reviewThreadId)
  const threadId = review?.reviewOf
  if (review === undefined || threadId === undefined || threadById(threadId) === undefined) return
  const current = useSelfReviews.getState()[threadId]
  if (current?.reviewThreadId !== reviewThreadId || current.state !== "running") return
  const result = findingsOf(runtimeOf(reviewThreadId).timeline.items)
  const diff = diffs.get(reviewThreadId)
  diffs.delete(reviewThreadId)
  if (result === undefined || result.state !== "ok" || diff === undefined) {
    setReview(threadId, { reviewThreadId, state: "failed", general: [], placed: 0 })
    toast("error", "The review ended without its findings block. Open the review thread to read it.")
    return
  }
  const { comments, general } = placeFindings(result.findings, diff, "Review")
  addComments(threadId, comments)
  setReview(threadId, { reviewThreadId, state: "done", ...(result.summary === undefined ? {} : { summary: result.summary }), general, placed: comments.length })
  const total = result.findings.length
  toast(total === 0 ? "success" : "info", total === 0 ? "The review found nothing to raise." : `The review found ${String(total)} thing${total === 1 ? "" : "s"}; they are in the Review pane.`)
}

export function openSelfReview(threadId: string): void {
  const review = useSelfReviews.getState()[threadId]
  if (review !== undefined && threadById(review.reviewThreadId) !== undefined) openThread(review.reviewThreadId)
}

export function initSelfReview(): () => void {
  return onTurnEnded((threadId) => finishSelfReview(threadId))
}
