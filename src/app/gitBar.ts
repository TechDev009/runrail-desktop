import { getHost, HostError, toHostError } from "../host"
import { CodeHostStatusSchema, GitPullSchema, GitPushPreviewSchema, GitStatusSchema, PullRequestStatusSchema, parseOr, type CodeHostStatus, type GitPushPreview } from "../protocol/schemas"
import { isBusy } from "../thread/reducer"
import { workspaceOf } from "./actions"
import { systemRpc } from "./connections"
import { onTurnEnded, refreshGit, refreshRemotes, threadRpc } from "./engines"
import { pullRequestsOffered } from "./gitHosts"
import { hasPendingCheck, noteCreatedPullRequest, notePullRequests, openReadDue, type PrView } from "./prStatus"
import { readProjectGit } from "./projectGit"
import { get, noteProjectGit, patchGit, patchThread, projectById, runtimeOf, threadById, toast } from "./store"
import { DIVERGED_REASON, fetchDue, pulledMessage, splitUpstream } from "./threadBar"

/** The thread bar's git actions: fetch, pull, and the push preview its dialog confirms. */

const lastFetch = new Map<string, number>()
/** Opening the branch menu fetches, but not more than this often. */
const MENU_FETCH_FLOOR_MS = 30_000

/**
 * Fetches only the branch's upstream: when the thread opens, at most once per 5 minutes per
 * checkout, and when the branch menu opens. Never on a timer.
 */
export async function fetchUpstream(threadId: string, reason: "open" | "menu" | "button"): Promise<void> {
  const upstream = splitUpstream(get().git[threadId]?.status?.upstream)
  const key = workspaceOf(threadId) ?? threadId
  if (upstream === undefined) return
  const now = Date.now()
  const last = lastFetch.get(key)
  if (reason === "open" ? !fetchDue(last, now) : reason === "menu" && last !== undefined && now - last < MENU_FETCH_FLOOR_MS) return
  lastFetch.set(key, now)
  patchGit(threadId, { busy: "fetch" })
  try {
    await threadRpc(threadId, "git.fetch", { remote: upstream.remote, branch: upstream.branch })
    patchGit(threadId, { fetchedAt: Date.now() })
    await refreshGit(threadId)
  } catch (error) {
    // Opening a thread offline is normal; only a fetch the person asked for reports a failure.
    if (reason !== "open") toast("error", `Could not fetch ${upstream.remote}/${upstream.branch}: ${toHostError(error).message}`)
  } finally {
    if (get().git[threadId]?.busy === "fetch") patchGit(threadId, { busy: undefined })
  }
}

export function fetchedAt(threadId: string): number | undefined {
  return get().git[threadId]?.fetchedAt ?? lastFetch.get(workspaceOf(threadId) ?? threadId)
}

/** Any thread working in this thread's directory has a turn running; pulling would change files under it. */
export function checkoutBusy(threadId: string): boolean {
  const workspace = workspaceOf(threadId)
  const state = get()
  return state.threads.some((thread) => {
    const timeline = state.runtime[thread.id]?.timeline
    return timeline !== undefined && isBusy(timeline) && (thread.id === threadId || (workspace !== undefined && workspaceOf(thread.id) === workspace))
  })
}

export async function pullBranch(threadId: string): Promise<void> {
  if (checkoutBusy(threadId)) return
  patchGit(threadId, { busy: "pull" })
  try {
    const result = parseOr(GitPullSchema, await threadRpc(threadId, "git.pull", { runHooks: get().prefs.gitHooks }))
    const status = parseOr(GitStatusSchema, result?.status)
    if (status !== undefined) patchGit(threadId, { status, updatedAt: Date.now() })
    void refreshGit(threadId)
    toast("success", result === undefined ? "Pulled" : pulledMessage(result))
  } catch (error) {
    const failure = toHostError(error)
    toast("error", failure.code === "CONTROL_GIT_DIVERGED" ? `${DIVERGED_REASON}.` : `Pull failed: ${failure.message}`)
    void refreshGit(threadId)
  } finally {
    patchGit(threadId, { busy: undefined })
  }
}

/** The exact commits a push would send, for the push dialog; undefined after a reported failure. */
export async function previewPush(threadId: string): Promise<GitPushPreview | undefined> {
  patchGit(threadId, { busy: "push" })
  try {
    const preview = parseOr(GitPushPreviewSchema, await threadRpc(threadId, "git.push.preview", {}))
    if (preview === undefined) throw new Error("The engine returned a push preview this app cannot read.")
    return preview
  } catch (error) {
    toast("error", `Could not prepare push: ${toHostError(error).message}`)
    return undefined
  } finally {
    patchGit(threadId, { busy: undefined })
  }
}

const lastCheck = new Map<string, number>()
const RECHECK_MS = 60_000

/**
 * Re-reads whether a project's folder is a git repository when it is opened, so a folder that got
 * `git init` after it was added is noticed.
 */
export async function recheckProject(projectId: string): Promise<void> {
  const project = projectById(projectId)
  if (project === undefined) return
  void readProjectGit(projectId)
  const now = Date.now()
  const last = lastCheck.get(projectId)
  if (last !== undefined && now - last < RECHECK_MS) return
  lastCheck.set(projectId, now)
  try {
    const info = await getHost().workspaceInspect(project.path)
    noteProjectGit(projectId, { git: info.git })
  } catch {
    // A folder that moved or vanished is reported where it is used.
  }
}

/** After the person answers which service a host is, threads re-read their remotes. */
export function rereadRemotes(): void {
  const state = get()
  for (const threadId of Object.keys(state.git)) if (threadById(threadId) !== undefined) void refreshRemotes(threadId)
}

export type PrReadReason = "open" | "turn" | "push" | "click" | "poll"

const prReads = new Map<string, Promise<void>>()

/** The turn a newly seen pull request belongs to: the last one that ended. */
function lastTurnId(threadId: string): string | undefined {
  const items = runtimeOf(threadId).timeline.items
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "turn-end") return item.turnId
  }
  return undefined
}

/**
 * Reads the branch's pull requests: when the thread opens (at most once per five minutes
 * per branch), after a turn, after a push or a new PR, on click, and every minute while a check
 * runs. Reads GitHub only; it never fetches.
 */
export async function refreshPullRequests(threadId: string, reason: PrReadReason, turnId?: string): Promise<void> {
  const thread = threadById(threadId)
  const project = projectById(thread?.projectId)
  if (thread === undefined || project === undefined || (!project.git && thread.worktree === undefined)) return
  // Before the remote list is read the service is not known yet; a certain GitLab or Bitbucket is never asked.
  if (project.connectedTo !== undefined && !pullRequestsOffered(project.connectedTo)) return
  const branch = get().git[threadId]?.status?.branch ?? undefined
  if (branch === undefined) return
  const now = Date.now()
  const prior = get().git[threadId]?.pr
  if (reason === "open" && !openReadDue(prior, branch, now)) return
  const running = prReads.get(threadId)
  if (running !== undefined) return running
  const read = readPullRequests(threadId, reason, branch, prior, turnId).finally(() => prReads.delete(threadId))
  prReads.set(threadId, read)
  return read
}

async function readPullRequests(threadId: string, reason: PrReadReason, branch: string, prior: PrView | undefined, turnId: string | undefined): Promise<void> {
  const now = Date.now()
  if (prior === undefined || prior.branch !== branch) patchGit(threadId, { pr: { state: "loading", pullRequests: [], branch, failures: 0 } })
  try {
    const result = parseOr(PullRequestStatusSchema, await threadRpc(threadId, "git.pr.status", {}))
    if (result === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "pull request status was malformed")
    const read: PrView = { state: "ready", pullRequests: result.pullRequests, owner: result.owner, repo: result.repo, branch, readAt: now, failures: 0 }
    const pending = hasPendingCheck(read, now)
    const pollFrom = !pending ? undefined : reason === "push" || prior?.branch !== branch || prior.pollFrom === undefined ? now : prior.pollFrom
    patchGit(threadId, { pr: pollFrom === undefined ? read : { ...read, pollFrom } })
    const thread = threadById(threadId)
    if (thread === undefined) return
    const records = notePullRequests(thread.pullRequests, result.pullRequests, now, turnId ?? lastTurnId(threadId))
    if (records !== thread.pullRequests && records !== undefined) patchThread(threadId, { pullRequests: records })
  } catch (error) {
    const failure = toHostError(error)
    // gh signed out reads as not connected: the Connect flow says how to sign in.
    if (failure.code === "CONTROL_PR_NOT_CONNECTED" || failure.code === "CONTROL_PR_CREDENTIALS") patchGit(threadId, { pr: { state: "not-connected", pullRequests: [], branch, readAt: now, failures: 0, message: failure.message } })
    else if (failure.code === "CONTROL_PR_UNAVAILABLE") patchGit(threadId, { pr: { state: "unavailable", pullRequests: [], branch, readAt: now, failures: 0, message: failure.message } })
    else patchGit(threadId, { pr: { ...(prior?.branch === branch ? prior : { pullRequests: [], branch }), state: "error", failures: (prior?.branch === branch ? prior.failures : 0) + 1, message: failure.message } })
    if (reason === "click") toast("error", `Could not read pull requests: ${failure.message}`)
  }
}

onTurnEnded((threadId, turnId) => void refreshPullRequests(threadId, "turn", turnId))

/** A PR made from the Review pane or the bar: its card goes after the turn it was made in. */
export function notePullRequestCreated(threadId: string, pull: { readonly number: number; readonly url?: string }): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  patchThread(threadId, { pullRequests: noteCreatedPullRequest(thread.pullRequests, pull, Date.now(), lastTurnId(threadId)) })
  void refreshPullRequests(threadId, "click")
}

/** The host whose GitHub connection a thread's pull requests need. */
export function gitHubHostOf(threadId: string): string {
  return projectById(threadById(threadId)?.projectId)?.connectedTo?.host ?? "github.com"
}

export async function gitHubCliStatus(host: string): Promise<CodeHostStatus | undefined> {
  return parseOr(CodeHostStatusSchema, await systemRpc("codehost.status", { host }))
}

/** Lets this host's pull requests use the person's own GitHub CLI sign-in, then reads them. */
export async function connectGitHubCli(threadId: string, host: string): Promise<void> {
  await systemRpc("codehost.connect", { host, via: "gh" })
  await refreshPullRequests(threadId, "click")
}
