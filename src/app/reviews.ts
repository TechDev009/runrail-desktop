import { create } from "zustand"
import { toHostError } from "../host"
import { CodeHostListSchema, CodeHostStatusSchema, parseOr, ProjectRemotesSchema, ReviewDetailSchema, ReviewDiffSchema, ReviewSearchSchema, ReviewTeamsSchema, type ReviewDetail, type ReviewEntry, type ReviewTeam } from "../protocol/schemas"
import type { TimelineItem } from "../thread/reducer"
import { systemCapability, systemRpc } from "./connections"
import { send } from "./engines"
import type { Thinking } from "../host/types"
import type { ThreadMeta } from "./persist"
import type { Selection } from "./picker"
import { parseFindings, reviewPrompt, type Finding, type FindingsResult, type ReviewPost } from "./reviewFindings"
import { createWorktreeThread } from "./workflows"

/**
 * The Reviews inbox: the person's pull requests in every repository, read through their
 * own `gh` on the app-wide engine. Read only. The helpers at the top are pure, so each is a test.
 */

export type ReviewGroup = "review-requested" | "authored" | "team"

/** What waits on the person first, then their own, then their teams'. */
export const REVIEW_GROUPS: readonly { readonly id: ReviewGroup; readonly label: string; readonly empty: string }[] = [
  { id: "review-requested", label: "Needs my review", empty: "No one is waiting on your review" },
  { id: "authored", label: "Authored by me", empty: "No open pull requests of yours" },
  { id: "team", label: "Needs my team's review", empty: "Nothing waits on your teams" },
]

export const REVIEWS_HOST = "github.com"
export const REVIEWS_POLL_MS = 60_000
/** The rail's dot reads the first group this often while the app is open. */
export const REVIEWS_BADGE_MS = 5 * 60_000

export interface ReviewRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export type Tone = "green" | "amber" | "red" | "gray" | "purple"

export function reviewKey(ref: ReviewRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`.toLowerCase()
}

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}"

/** A pull request link pasted or typed: `https://github.com/o/r/pull/12/files`, `o/r#12`, or `o/r/pull/12`. */
export function parsePullRequestLink(text: string): ReviewRef | undefined {
  const value = text.trim()
  const match =
    new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${SEGMENT})/(${SEGMENT})/pull/(\\d{1,10})(?:[/?#].*)?$`, "i").exec(value) ??
    new RegExp(`^(${SEGMENT})/(${SEGMENT})(?:#|/pull/)(\\d{1,10})$`).exec(value)
  if (match === null) return undefined
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number < 1) return undefined
  return { owner: match[1] ?? "", repo: match[2] ?? "", number }
}

export function checksBadge(state: ReviewEntry["checks"]): { readonly text: string; readonly tone: Tone } | undefined {
  switch (state) {
    case "passed":
      return { text: "Checks passed", tone: "green" }
    case "failed":
      return { text: "Checks failing", tone: "red" }
    case "pending":
      return { text: "Checks running", tone: "amber" }
    case "none":
      return undefined
  }
}

export function reviewBadge(entry: Pick<ReviewEntry, "draft" | "review">): { readonly text: string; readonly tone: Tone } | undefined {
  if (entry.draft) return { text: "Draft", tone: "gray" }
  if (entry.review === "approved") return { text: "Approved", tone: "green" }
  if (entry.review === "changes-requested") return { text: "Changes requested", tone: "red" }
  return undefined
}

/** One line on whether it can merge, from GitHub's merge state; GitHub's own wording is not shown. */
export function mergeLine(detail: Pick<ReviewDetail, "state" | "draft" | "mergeable" | "mergeState">): { readonly text: string; readonly tone: Tone } {
  if (detail.state === "merged") return { text: "Merged", tone: "purple" }
  if (detail.state === "closed") return { text: "Closed without merging", tone: "gray" }
  if (detail.draft) return { text: "Draft: mark it ready before merging", tone: "gray" }
  if (detail.mergeable === "conflicts" || detail.mergeState === "dirty") return { text: "Has conflicts with the base branch", tone: "red" }
  switch (detail.mergeState) {
    case "clean":
    case "has-hooks":
      return { text: "Can merge without conflicts", tone: "green" }
    case "unstable":
      return { text: "Can merge; some checks are not passing", tone: "amber" }
    case "blocked":
      return { text: "Blocked by required reviews or checks", tone: "amber" }
    case "behind":
      return { text: "Behind the base branch", tone: "amber" }
    default:
      return detail.mergeable === "yes" ? { text: "No conflicts", tone: "green" } : { text: "GitHub is still working out whether it can merge", tone: "gray" }
  }
}

export interface FileGroup {
  readonly dir: string
  readonly files: readonly ReviewDetail["files"][number][]
}

/** Files grouped by folder, folders in path order, root files first. */
export function fileGroups(files: readonly ReviewDetail["files"][number][]): readonly FileGroup[] {
  const groups = new Map<string, ReviewDetail["files"][number][]>()
  for (const file of files) {
    const cut = file.path.lastIndexOf("/")
    const dir = cut < 0 ? "" : file.path.slice(0, cut)
    const list = groups.get(dir) ?? []
    list.push(file)
    groups.set(dir, list)
  }
  return [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))).map(([dir, list]) => ({ dir, files: list }))
}

/** A unified diff split per file, keyed by the new path (the old one for a deletion). */
export function splitDiff(diff: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>()
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(part)
    if (header === null) continue
    const deleted = /^\+\+\+ \/dev\/null$/m.test(part)
    files.set((deleted ? header[1] : header[2]) ?? "", part)
  }
  return files
}

/** The Runrail thread that opened this pull request, if one remembers its link. */
export function threadForPullRequest(threads: readonly Pick<ThreadMeta, "id" | "title" | "pullRequests">[], url: string | undefined): Pick<ThreadMeta, "id" | "title"> | undefined {
  if (url === undefined) return undefined
  const wanted = url.toLowerCase()
  return threads.find((thread) => thread.pullRequests?.some((pull) => pull.url?.toLowerCase() === wanted) === true)
}

export type Connection =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly login?: string }
  | { readonly state: "not-connected" | "gh-missing" | "signed-out" | "unavailable" }
  | { readonly state: "error"; readonly message: string }

/** What a failed inbox call means for the connect panel; anything else stays an error on the group. */
export function connectionFromError(code: string): "not-connected" | "gh-missing" | "signed-out" | undefined {
  switch (code) {
    case "CONTROL_PR_NOT_CONNECTED":
      return "not-connected"
    case "CONTROL_PR_UNAVAILABLE":
      return "gh-missing"
    case "CONTROL_PR_CREDENTIALS":
      return "signed-out"
    default:
      return undefined
  }
}

interface GroupState {
  readonly state: "idle" | "loading" | "ready" | "error"
  readonly entries: readonly ReviewEntry[]
  readonly total: number
  readonly message?: string
}

interface DetailState {
  readonly state: "loading" | "ready" | "error"
  readonly detail?: ReviewDetail
  readonly message?: string
}

interface DiffState {
  readonly state: "loading" | "ready" | "error"
  readonly files: ReadonlyMap<string, string>
  readonly truncated: boolean
  readonly message?: string
}

interface ReviewsState {
  readonly connection: Connection
  readonly groups: Readonly<Record<ReviewGroup, GroupState>>
  readonly query: string
  readonly team?: ReviewTeam
  readonly teams?: readonly ReviewTeam[] | "scope-missing"
  readonly readAt?: number
  readonly selected?: ReviewRef
  readonly tab: "summary" | "changes"
  readonly details: Readonly<Record<string, DetailState>>
  readonly diffs: Readonly<Record<string, DiffState>>
  /** Files marked viewed, per pull request and head commit; kept for this session only. */
  readonly viewed: Readonly<Record<string, readonly string[]>>
  /** How many wait on the person's review, for the rail's dot. */
  readonly waiting: number
}

const EMPTY_GROUP: GroupState = { state: "idle", entries: [], total: 0 }

export const useReviews = create<ReviewsState>()(() => ({
  connection: { state: "checking" },
  groups: { "review-requested": EMPTY_GROUP, authored: EMPTY_GROUP, team: EMPTY_GROUP },
  query: "",
  tab: "summary",
  details: {},
  diffs: {},
  viewed: {},
  waiting: 0,
}))

const patch = (value: Partial<ReviewsState>): void => useReviews.setState(value)

/** Whether the engine reads the inbox and GitHub is connected; says what is missing otherwise. */
async function checkConnection(): Promise<Connection> {
  if (!(await systemCapability("git.pr.reviews").catch(() => false))) return { state: "unavailable" }
  const listing = parseOr(CodeHostListSchema, await systemRpc("codehost.list"))
  const connected = listing?.hosts.some((record) => record.host === REVIEWS_HOST && record.connection?.enabled === true) === true
  if (connected) return { state: "ready" }
  const status = parseOr(CodeHostStatusSchema, await systemRpc("codehost.status", { host: REVIEWS_HOST }))
  return status?.state === "missing" ? { state: "gh-missing" } : status?.state === "signed-out" ? { state: "signed-out" } : { state: "not-connected" }
}

let loading: Promise<void> | undefined

/** Reads every group again; with `quiet` the rows already shown stay while it reads. */
export function loadReviews(quiet = false): Promise<void> {
  loading ??= (async () => {
    try {
      const connection = await checkConnection()
      if (connection.state !== "ready") {
        patch({ connection })
        return
      }
      if (useReviews.getState().connection.state !== "ready") patch({ connection })
      const { query, team } = useReviews.getState()
      await Promise.all(REVIEW_GROUPS.map(({ id }) => loadGroup(id, query, id === "team" ? team : undefined, quiet)))
      patch({ readAt: Date.now() })
    } catch (error) {
      patch({ connection: { state: "error", message: toHostError(error).message } })
    } finally {
      loading = undefined
    }
  })()
  return loading
}

async function loadGroup(group: ReviewGroup, query: string, team: ReviewTeam | undefined, quiet: boolean): Promise<void> {
  const before = useReviews.getState().groups[group]
  const setGroup = (value: GroupState): void => useReviews.setState((state) => ({ groups: { ...state.groups, [group]: value } }))
  if (!quiet || before.state === "idle") setGroup({ ...before, state: "loading" })
  try {
    const params = { group, limit: 20, ...(query.trim().length === 0 ? {} : { query: query.trim() }), ...(team === undefined ? {} : { team: `${team.org}/${team.slug}` }) }
    const result = parseOr(ReviewSearchSchema, await systemRpc("git.pr.search", params))
    if (result === undefined) {
      setGroup({ ...before, state: "error", message: "The engine sent a list this app cannot read." })
      return
    }
    setGroup({ state: "ready", entries: result.pullRequests, total: result.total })
    if (group === "review-requested" && query.trim().length === 0) patch({ waiting: result.total })
  } catch (error) {
    const failure = toHostError(error)
    const connection = connectionFromError(failure.code)
    if (connection !== undefined) patch({ connection: { state: connection } })
    setGroup({ ...before, state: "error", message: failure.message })
  }
}

/** Turns on pull requests through gh for github.com, as Settings → Projects does, then reads the inbox. */
export async function connectGitHub(): Promise<void> {
  patch({ connection: { state: "checking" } })
  try {
    const status = parseOr(CodeHostStatusSchema, await systemRpc("codehost.status", { host: REVIEWS_HOST }))
    if (status?.state !== "ready") {
      patch({ connection: { state: status?.state === "missing" ? "gh-missing" : "signed-out" } })
      return
    }
    await systemRpc("codehost.connect", { host: REVIEWS_HOST, via: "gh" })
    patch({ connection: { state: "ready", ...(status.login === undefined ? {} : { login: status.login }) } })
    await loadReviews()
  } catch (error) {
    patch({ connection: { state: "error", message: toHostError(error).message } })
  }
}

export function setReviewQuery(query: string): void {
  patch({ query })
}

export function setReviewTeam(team: ReviewTeam | undefined): void {
  patch(team === undefined ? { team: undefined } : { team })
  void loadGroup("team", useReviews.getState().query, team, false)
}

/** The person's teams for the team filter; a sign-in without read:org says so. */
export async function loadTeams(): Promise<void> {
  if (useReviews.getState().teams !== undefined) return
  try {
    const result = parseOr(ReviewTeamsSchema, await systemRpc("git.pr.teams"))
    patch({ teams: result?.teams ?? [] })
  } catch (error) {
    patch({ teams: toHostError(error).code === "CONTROL_PR_SCOPE_MISSING" ? "scope-missing" : [] })
  }
}

export function selectReview(ref: ReviewRef | undefined): void {
  patch(ref === undefined ? { selected: undefined } : { selected: { owner: ref.owner, repo: ref.repo, number: ref.number } })
  if (ref === undefined) return
  void loadDetail(ref)
  if (useReviews.getState().tab === "changes") void loadDiff(ref)
}

export function setReviewTab(tab: "summary" | "changes"): void {
  patch({ tab })
  const selected = useReviews.getState().selected
  if (tab === "changes" && selected !== undefined && useReviews.getState().diffs[reviewKey(selected)] === undefined) void loadDiff(selected)
}

export async function loadDetail(ref: ReviewRef, quiet = false): Promise<void> {
  const key = reviewKey(ref)
  const before = useReviews.getState().details[key]
  const setDetail = (value: DetailState): void => useReviews.setState((state) => ({ details: { ...state.details, [key]: value } }))
  if (!quiet || before?.detail === undefined) setDetail({ ...before, state: "loading" })
  try {
    const detail = parseOr(ReviewDetailSchema, await systemRpc("git.pr.view", { owner: ref.owner, repo: ref.repo, number: ref.number }))
    if (detail === undefined) setDetail({ state: "error", message: "The engine sent a pull request this app cannot read." })
    else setDetail({ state: "ready", detail })
  } catch (error) {
    setDetail({ ...(before?.detail === undefined ? {} : { detail: before.detail }), state: "error", message: toHostError(error).message })
  }
}

export async function loadDiff(ref: ReviewRef): Promise<void> {
  const key = reviewKey(ref)
  const setDiff = (value: DiffState): void => useReviews.setState((state) => ({ diffs: { ...state.diffs, [key]: value } }))
  setDiff({ state: "loading", files: new Map(), truncated: false })
  try {
    const result = parseOr(ReviewDiffSchema, await systemRpc("git.pr.diff", { owner: ref.owner, repo: ref.repo, number: ref.number }))
    if (result === undefined) setDiff({ state: "error", files: new Map(), truncated: false, message: "The engine sent changes this app cannot read." })
    else setDiff({ state: "ready", files: splitDiff(result.diff), truncated: result.truncated })
  } catch (error) {
    setDiff({ state: "error", files: new Map(), truncated: false, message: toHostError(error).message })
  }
}

export function viewedKey(ref: ReviewRef, headCommit: string | undefined): string {
  return `${reviewKey(ref)}@${headCommit ?? "head"}`
}

export function toggleViewed(key: string, path: string): void {
  useReviews.setState((state) => {
    const list = state.viewed[key] ?? []
    return { viewed: { ...state.viewed, [key]: list.includes(path) ? list.filter((item) => item !== path) : [...list, path] } }
  })
}

/** Reads the selected pull request and the groups again, keeping what is shown while it reads. */
export async function refreshReviews(): Promise<void> {
  await loadReviews(true)
  const selected = useReviews.getState().selected
  if (selected !== undefined) await loadDetail(selected, true)
}

/** Only the first group, for the rail's dot; quiet when GitHub is not connected. */
export async function readWaiting(): Promise<void> {
  try {
    if (!(await systemCapability("git.pr.reviews"))) return
    const result = parseOr(ReviewSearchSchema, await systemRpc("git.pr.search", { group: "review-requested", limit: 1 }))
    if (result !== undefined) patch({ waiting: result.total })
  } catch {
    // Not connected or offline: the dot stays as it was.
  }
}

/** A project whose GitHub remote is this pull request's repository, directly or as the fork's parent. */
export function projectForPullRequest<T extends { readonly id: string; readonly git: boolean; readonly connectedTo?: { readonly host?: string; readonly path?: string; readonly upstream?: string } }>(projects: readonly T[], ref: ReviewRef): T | undefined {
  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase()
  return projects.find((project) => project.git && project.connectedTo?.host === REVIEWS_HOST && (project.connectedTo.path?.toLowerCase() === wanted || project.connectedTo.upstream?.toLowerCase() === wanted))
}

/** The review threads of one pull request, newest first. */
export function reviewThreadsOf<T extends Pick<ThreadMeta, "review" | "createdAt" | "archived">>(threads: readonly T[], ref: ReviewRef): readonly T[] {
  const key = reviewKey(ref)
  return threads.filter((thread) => thread.review !== undefined && thread.archived !== true && reviewKey(thread.review) === key).sort((a, b) => b.createdAt - a.createdAt)
}

/** The remote whose repository is the pull request's, so its `pull/<n>/head` can be fetched. */
async function remoteFor(projectPath: string, ref: ReviewRef): Promise<string | undefined> {
  const answer = parseOr(ProjectRemotesSchema, await systemRpc("codehost.remotes", { path: projectPath }))
  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase()
  return answer?.remotes?.find((remote) => remote.host === REVIEWS_HOST && `${remote.owner ?? ""}/${remote.repo ?? ""}`.toLowerCase() === wanted)?.name
}

export interface ReviewStart {
  readonly projectId: string
  readonly projectPath: string
  readonly selection: Selection
  readonly thinking?: Thinking
  readonly focus?: string
}

/**
 * Starts a review thread: a worktree at the pull request's head, Plan mode, so Claude Code
 * runs in its plan mode and Codex in its read-only sandbox. The tool reads; nothing is posted.
 */
export async function startReview(ref: ReviewRef, detail: Pick<ReviewDetail, "title" | "base" | "headCommit">, start: ReviewStart): Promise<ThreadMeta> {
  const remote = await remoteFor(start.projectPath, ref)
  const title = `Review #${String(ref.number)}${detail.title === undefined ? "" : `: ${detail.title}`}`.slice(0, 120)
  const thread = await createWorktreeThread(
    {
      projectId: start.projectId,
      backend: start.selection.backend,
      ...(start.selection.model === undefined ? {} : { model: start.selection.model }),
      ...(start.selection.connectionId === undefined ? {} : { connectionId: start.selection.connectionId }),
      ...(start.thinking === undefined ? {} : { thinking: start.thinking }),
      mode: "plan",
      permission: "ask",
      title,
      review: { owner: ref.owner, repo: ref.repo, number: ref.number, ...(detail.headCommit === undefined ? {} : { headCommit: detail.headCommit }) },
      select: false,
    },
    { kind: "pr", number: ref.number, ...(detail.title === undefined ? {} : { title: detail.title }), ...(remote === undefined ? {} : { remote }) },
    { firstMessage: `review ${String(ref.number)}` },
  )
  send(thread.id, { text: reviewPrompt({ ...ref, ...(detail.title === undefined ? {} : { title: detail.title }), ...(detail.base === undefined ? {} : { base: detail.base }), ...(start.focus === undefined ? {} : { focus: start.focus }) }) })
  return thread
}

/** The findings block of the thread's last answer, once its turn has ended. */
export function findingsOf(items: readonly TimelineItem[]): FindingsResult | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "assistant") return item.streaming ? undefined : parseFindings(item.text)
  }
  return undefined
}

export type FindingMark = "included" | "dismissed"

/** A finding goes to GitHub only once the person includes it. Kept for this session only. */
export const useFindingMarks = create<{ readonly marks: Readonly<Record<string, Readonly<Record<number, FindingMark>>>> }>()(() => ({ marks: {} }))

export function markFinding(threadId: string, index: number, mark: FindingMark | undefined): void {
  useFindingMarks.setState((state) => {
    const current = { ...(state.marks[threadId] ?? {}) }
    if (mark === undefined) delete current[index]
    else current[index] = mark
    return { marks: { ...state.marks, [threadId]: current } }
  })
}

/** What a person asks of a coding tool to fix one finding, in a thread of its own. */
export function fixPrompt(ref: ReviewRef, finding: Finding): string {
  const where = finding.path === undefined ? "" : ` in \`${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`}\``
  return [`A review of pull request #${String(ref.number)} in ${ref.owner}/${ref.repo} found this${where}:`, "", `${finding.title}${finding.body === undefined ? "" : `\n\n${finding.body}`}`, "", "Check whether it holds, and fix it if it does."].join("\n")
}

export async function postFindings(ref: ReviewRef, commit: string, post: ReviewPost): Promise<{ readonly url?: string }> {
  const result = (await systemRpc("git.pr.review.post", { owner: ref.owner, repo: ref.repo, number: ref.number, commit, body: post.body, comments: post.comments, confirm: true })) as { readonly url?: unknown }
  return typeof result.url === "string" && result.url.startsWith("https://") ? { url: result.url } : {}
}

export interface MergeChoice {
  readonly method: "merge" | "squash" | "rebase"
  readonly headCommit: string
  readonly subject?: string
  readonly deleteBranch: boolean
}

export async function mergePullRequest(ref: ReviewRef, choice: MergeChoice): Promise<void> {
  await systemRpc("git.pr.merge", { owner: ref.owner, repo: ref.repo, number: ref.number, confirm: true, ...choice })
  await refreshReviews()
}
