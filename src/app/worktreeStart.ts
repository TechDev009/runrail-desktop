import type { GitBranches, PullRequestEntry } from "../protocol/schemas"
import type { WorktreeBase } from "./persist"

/** Where a new thread's worktree starts: the project's HEAD, a branch, or a GitHub pull request. */
export type WorktreeStart =
  | { readonly kind: "head" }
  | { readonly kind: "branch"; readonly name: string; readonly remote?: string }
  | { readonly kind: "pr"; readonly number: number; readonly title?: string; readonly remote?: string }

export const HEAD_START: WorktreeStart = { kind: "head" }
const MAX_ROWS = 50

export function startLabel(start: WorktreeStart): string {
  if (start.kind === "head") return "New worktree"
  if (start.kind === "pr") return `PR #${String(start.number)}`
  return `From ${start.remote === undefined ? start.name : `${start.remote}/${start.name}`}`
}

export function startBase(start: WorktreeStart): WorktreeBase | undefined {
  if (start.kind === "head") return undefined
  if (start.kind === "branch") return { kind: "branch", name: start.remote === undefined ? start.name : `${start.remote}/${start.name}` }
  return { kind: "pr", number: start.number, ...(start.title === undefined ? {} : { title: start.title.slice(0, 256) }) }
}

/** The thread header's note: "from main", "PR #12". */
export function baseLabel(base: WorktreeBase): string {
  return base.kind === "pr" ? `PR #${String(base.number)}` : `from ${base.name}`
}

export interface BranchRow {
  readonly key: string
  readonly start: WorktreeStart
  readonly label: string
  readonly current: boolean
  readonly updatedAt: number
}

/**
 * Local branches, then remote branches that have no local branch of the same name, each newest
 * first. Every word of the query must appear in the name.
 */
export function branchRows(branches: GitBranches, query: string): { readonly local: readonly BranchRow[]; readonly remote: readonly BranchRow[] } {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
  const matches = (text: string): boolean => words.every((word) => text.toLowerCase().includes(word))
  const names = new Set(branches.local.map((branch) => branch.name))
  const local = branches.local
    .filter((branch) => matches(branch.name))
    .slice(0, MAX_ROWS)
    .map((branch) => ({ key: `l:${branch.name}`, start: { kind: "branch", name: branch.name } as const, label: branch.name, current: branch.name === branches.current, updatedAt: branch.updatedAt }))
  const remote = branches.remote
    .filter((branch) => !names.has(branch.name) && matches(`${branch.remote}/${branch.name}`))
    .slice(0, MAX_ROWS)
    .map((branch) => ({ key: `r:${branch.remote}/${branch.name}`, start: { kind: "branch", name: branch.name, remote: branch.remote } as const, label: `${branch.remote}/${branch.name}`, current: false, updatedAt: branch.updatedAt }))
  return { local, remote }
}

/** A pull request number typed as `12`, `#12`, or a GitHub pull request link. */
export function typedPullRequest(query: string): number | undefined {
  const text = query.trim()
  const match = /^#?(\d{1,10})$/.exec(text) ?? /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d{1,10})(?:[/?#]\S*)?$/.exec(text)
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1])
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000 ? value : undefined
}

/** Open pull requests matching the query by number, title, branch, or author. */
export function pullRequestRows(pullRequests: readonly PullRequestEntry[], query: string): readonly PullRequestEntry[] {
  const number = typedPullRequest(query)
  if (number !== undefined) return pullRequests.filter((pull) => pull.number === number)
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
  return pullRequests.filter((pull) => {
    const text = `${pull.title ?? ""} ${pull.head ?? ""} ${pull.author ?? ""}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

const SLUG_WORDS = 6
const SLUG_CHARS = 40
const CLASH_RETRIES = 4

/** `Fix the login form!` → `fix-the-login-form`: lowercase ASCII, accents dropped, at most 6 words and 40 characters. */
export function branchSlug(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0)
    .slice(0, SLUG_WORDS)
  let slug = ""
  for (const word of words) {
    const next = slug.length === 0 ? word : `${slug}-${word}`
    if (next.length > SLUG_CHARS) {
      if (slug.length === 0) slug = word.slice(0, SLUG_CHARS)
      break
    }
    slug = next
  }
  return slug
}

/**
 * The branch names a new worktree tries in turn: `runrail/<slug>`, then `-2` to `-5` when a
 * branch of that name exists, then `runrail/<id>`. With no slug, `runrail/<id>` at once. A run of
 * Best of N names its branches `<slug>-1`, `<slug>-2`, ...
 */
export function worktreeBranchNames(firstMessage: string | undefined, id: string, run?: number): readonly string[] {
  const slug = branchSlug(firstMessage ?? "")
  const fallback = `runrail/${id}`
  if (slug.length === 0) return [fallback]
  const base = run === undefined ? `runrail/${slug}` : `runrail/${slug}-${String(run)}`
  return [base, ...Array.from({ length: CLASH_RETRIES }, (_, index) => `${base}-${String(index + 2)}`), fallback]
}
