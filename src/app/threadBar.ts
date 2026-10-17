import type { GitStatus } from "../protocol/schemas"
import type { WorktreeBase } from "./persist"
import type { ProjectHead } from "./projectGit"
import type { WorktreeStart } from "./worktreeStart"

/**
 * What the bar above the composer shows for a thread's checkout: the branch, its changes, and the
 * one git button. Pure, so every case is a test.
 */

export interface ChangeStats {
  readonly files: number
  readonly additions: number
  readonly deletions: number
  /** The engine stopped counting at a size limit; the numbers are at least these. */
  readonly truncated?: boolean
}

export interface BranchView {
  readonly label: string
  /** `↑2 ↓1`, when either is non-zero. */
  readonly counts?: string
  readonly worktree: boolean
  readonly title: string
}

export type OneButton =
  | { readonly kind: "publish"; readonly label: string; readonly disabled?: string }
  | { readonly kind: "push"; readonly label: string; readonly count: number; readonly disabled?: string }
  | { readonly kind: "pull"; readonly label: string; readonly count: number; readonly disabled?: string }
  | { readonly kind: "sync"; readonly label: string; readonly disabled: string }

export interface ThreadWorktreeView {
  readonly branch?: string
  readonly path: string
  readonly base?: WorktreeBase
}

export const DIVERGED_REASON = "Both changed. Ask the agent to merge, or merge in a terminal"
export const BUSY_REASON = "Wait for the agent to finish: pulling changes files under it"

export function branchView(status: GitStatus | undefined, worktree: ThreadWorktreeView | undefined): BranchView | undefined {
  const branch = status?.branch ?? worktree?.branch ?? undefined
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const counts = ahead > 0 || behind > 0 ? [ahead > 0 ? `↑${String(ahead)}` : "", behind > 0 ? `↓${String(behind)}` : ""].filter((part) => part.length > 0).join(" ") : undefined
  const upstream = status?.upstream ?? undefined
  const tracking = branch === undefined ? "" : upstream === undefined ? `${branch}\nNot published` : `${branch} → ${upstream}`
  const withCounts = (view: Omit<BranchView, "counts">): BranchView => (counts === undefined ? view : { ...view, counts })
  if (status?.detached === true) {
    const short = (status.head ?? "").slice(0, 7)
    return { label: short.length > 0 ? `detached at ${short}` : "detached", worktree: worktree !== undefined, title: worktree === undefined ? "No branch is checked out" : `No branch is checked out\n${worktree.path}` }
  }
  if (branch === undefined) return undefined
  if (status?.initial === true) return { label: `${branch} · no commits`, worktree: worktree !== undefined, title: `${branch} has no commits yet` }
  if (worktree === undefined) return withCounts({ label: branch, worktree: false, title: tracking })
  const base = worktree.base
  const from = base === undefined ? "" : base.kind === "pr" ? ` · PR #${String(base.number)}` : ` · from ${base.name}`
  return withCounts({ label: `Worktree${from}`, worktree: true, title: `Worktree on ${tracking}\n${worktree.path}` })
}

/**
 * A new thread's branch before its checkout is read: the project's branch for the
 * checkout, else where the worktree starts, labelled as `branchView` will label it once it runs.
 */
export function startView(head: ProjectHead | undefined, choice: { readonly worktree: boolean; readonly start: WorktreeStart }): BranchView | undefined {
  if (choice.worktree) {
    const start = choice.start
    if (start.kind === "pr") return { label: `Worktree · PR #${String(start.number)}`, worktree: true, title: `A new worktree from pull request #${String(start.number)}, on its own branch` }
    if (start.kind === "branch") {
      const name = start.remote === undefined ? start.name : `${start.remote}/${start.name}`
      return { label: `Worktree · from ${name}`, worktree: true, title: `A new worktree from ${name}, on its own branch` }
    }
    return { label: "Worktree", worktree: true, title: `A new worktree from where your checkout is now${head?.branch === undefined ? "" : ` (${head.branch})`}, on its own branch` }
  }
  if (head === undefined) return undefined
  if (head.detached) {
    const short = (head.head ?? "").slice(0, 7)
    return { label: short.length > 0 ? `detached at ${short}` : "detached", worktree: false, title: "Runs in your checkout, where no branch is checked out" }
  }
  if (head.branch === undefined) return undefined
  if (head.initial) return { label: `${head.branch} · no commits`, worktree: false, title: `Runs in your checkout. ${head.branch} has no commits yet` }
  return { label: head.branch, worktree: false, title: `Runs in your checkout on ${head.branch}` }
}

/** `+120 -34 · 6 files`, or nothing when the checkout is clean. */
export function changesLabel(stats: ChangeStats | undefined): string | undefined {
  if (stats === undefined || stats.files === 0) return undefined
  return `+${String(stats.additions)} -${String(stats.deletions)} · ${filesLabel(stats)}`
}

/** `6 files`; `6+ files` when the engine stopped counting at a size limit. */
export function filesLabel(stats: ChangeStats): string {
  const more = stats.truncated === true ? "+" : ""
  return `${String(stats.files)}${more} ${stats.files === 1 && more === "" ? "file" : "files"}`
}

/**
 * The one button: Publish, Push, Pull, or a Sync that explains why it cannot run. Pull never
 * merges, so a branch that moved on both sides is left to the person or the agent.
 */
export function oneButton(input: { readonly status: GitStatus | undefined; readonly hasRemote: boolean | undefined; readonly busy: boolean }): OneButton | undefined {
  const status = input.status
  if (status === undefined || status.detached === true || status.initial === true || status.branch == null) return undefined
  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0
  if (status.upstream == null) return input.hasRemote === true ? { kind: "publish", label: "Publish branch" } : undefined
  if (ahead > 0 && behind > 0) return { kind: "sync", label: "Sync", disabled: DIVERGED_REASON }
  if (ahead > 0) return { kind: "push", label: `Push ${String(ahead)}`, count: ahead }
  if (behind > 0) return { kind: "pull", label: `Pull ${String(behind)}`, count: behind, ...(input.busy ? { disabled: BUSY_REASON } : {}) }
  return undefined
}

/** `origin/feature/x` names remote `origin` and branch `feature/x`: remote names cannot hold a slash. */
export function splitUpstream(upstream: string | null | undefined): { readonly remote: string; readonly branch: string } | undefined {
  if (upstream == null) return undefined
  const slash = upstream.indexOf("/")
  if (slash <= 0 || slash === upstream.length - 1) return undefined
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) }
}

/** Fetch on open and on the branch menu, at most this often per checkout. */
export const FETCH_INTERVAL_MS = 5 * 60_000

export function fetchDue(lastFetchedAt: number | undefined, now: number): boolean {
  return lastFetchedAt === undefined || now - lastFetchedAt >= FETCH_INTERVAL_MS
}

export function fetchedLabel(fetchedAt: number | undefined, now: number): string {
  if (fetchedAt === undefined) return "Not fetched yet"
  const minutes = Math.floor((now - fetchedAt) / 60_000)
  if (minutes < 1) return "Fetched just now"
  if (minutes < 60) return `Fetched ${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `Fetched ${String(hours)}h ago` : `Fetched ${String(Math.floor(hours / 24))}d ago`
}

/** What a pull did, for its toast. */
export function pulledMessage(result: { readonly pulled?: unknown; readonly upstream?: unknown; readonly outcome?: unknown }): string {
  const upstream = typeof result.upstream === "string" ? result.upstream : "the upstream"
  if (result.outcome === "up-to-date" || result.pulled === 0) return `Already up to date with ${upstream}`
  const count = typeof result.pulled === "number" ? result.pulled : 0
  return `Pulled ${String(count)} ${count === 1 ? "commit" : "commits"} from ${upstream}`
}
