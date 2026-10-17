import { HostError } from "./types"

/**
 * The preview's Reviews inbox: made-up pull requests in made-up repositories, answered as the
 * engine's `git.pr.search`, `git.pr.teams`, `git.pr.view`, and `git.pr.diff` would. A posted review
 * or a merge goes nowhere: it is kept in memory until the page reloads.
 */

const HOUR = 3_600_000

interface FakePull {
  readonly group: "review-requested" | "authored" | "team"
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly author: string
  readonly hoursAgo: number
  readonly draft?: boolean
  readonly review: "approved" | "changes-requested" | "required" | "none"
  readonly checks: "passed" | "failed" | "pending" | "none"
  readonly files: readonly { readonly path: string; readonly additions: number; readonly deletions: number; readonly change: "added" | "modified" | "deleted" }[]
}

const PULLS: readonly FakePull[] = [
  { group: "review-requested", owner: "example-org", repo: "web", number: 88, title: "Show the shift report with what each person finished", author: "maya-k", hoursAgo: 3, review: "required", checks: "passed", files: [{ path: "src/report/ShiftReport.tsx", additions: 64, deletions: 12, change: "modified" }, { path: "src/report/summary.ts", additions: 41, deletions: 0, change: "added" }, { path: "test/summary.test.ts", additions: 38, deletions: 0, change: "added" }] },
  { group: "review-requested", owner: "example-org", repo: "engine", number: 231, title: "Bound restarts of a stdio server that keeps exiting", author: "devon-r", hoursAgo: 26, review: "required", checks: "failed", files: [{ path: "src/mcp/stdio.ts", additions: 22, deletions: 9, change: "modified" }, { path: "test/stdio.test.ts", additions: 30, deletions: 2, change: "modified" }] },
  { group: "authored", owner: "example-org", repo: "engine", number: 412, title: "A usage limit ends the turn instead of being retried", author: "preview-user", hoursAgo: 2, review: "required", checks: "pending", files: [{ path: "src/providers/http.ts", additions: 2, deletions: 2, change: "modified" }, { path: "src/limits/rate-limit.ts", additions: 56, deletions: 0, change: "added" }, { path: "docs/limits.md", additions: 14, deletions: 3, change: "modified" }] },
  { group: "authored", owner: "example-org", repo: "engine", number: 411, title: "Share one accounts folder between the CLI and the app", author: "preview-user", hoursAgo: 2, review: "approved", checks: "passed", files: [{ path: "src/accounts/storage.ts", additions: 48, deletions: 20, change: "modified" }] },
  { group: "authored", owner: "example-org", repo: "docs", number: 409, title: "Plan: office mode, agent teams and evals", author: "preview-user", hoursAgo: 24, draft: true, review: "none", checks: "none", files: [{ path: "plans/office.md", additions: 120, deletions: 0, change: "added" }] },
]

const BODY = `## What this changes

A short description the author wrote, shown as they wrote it.

- One point about the change
- Another point, with \`code\` in it

## Tests

The checks on the head commit are listed on the right.`

export const REVIEW_METHODS: ReadonlySet<string> = new Set(["git.pr.search", "git.pr.teams", "git.pr.view", "git.pr.diff", "git.pr.review.post", "git.pr.merge"])

const merged = new Set<string>()
const posted = new Map<string, number>()

function keyOf(pull: FakePull): string {
  return `${pull.owner}/${pull.repo}#${String(pull.number)}`
}

function confirmed(params: Record<string, unknown>): void {
  if (params.confirm !== true) throw new HostError("CONTROL_CONFIRMATION_REQUIRED", "this writes to GitHub; confirm it first", 428)
}

function find(params: Record<string, unknown>): FakePull {
  const pull = PULLS.find((item) => item.owner === params.owner && item.repo === params.repo && item.number === params.number)
  if (pull === undefined) throw new HostError("CONTROL_PR_NOT_FOUND", "the repository or pull request was not found, or this sign-in cannot see it", 404)
  return pull
}

function patchFor(file: FakePull["files"][number]): string {
  const added = Array.from({ length: Math.min(file.additions, 8) }, (_, index) => `+export const line${String(index + 1)} = ${String(index + 1)}`)
  const removed = Array.from({ length: Math.min(file.deletions, 4) }, (_, index) => `-const old${String(index + 1)} = ${String(index + 1)}`)
  const header = file.change === "added" ? ["new file mode 100644", "--- /dev/null", `+++ b/${file.path}`] : [`--- a/${file.path}`, `+++ b/${file.path}`]
  return [`diff --git a/${file.path} b/${file.path}`, ...header, `@@ -1,${String(removed.length + 1)} +1,${String(added.length + 1)} @@`, " import { value } from \"./value\"", ...removed, ...added, ""].join("\n")
}

export function reviewsRpc(method: string, params: Record<string, unknown>, connected: boolean): unknown {
  if (!connected) throw new HostError("CONTROL_PR_NOT_CONNECTED", "GitHub is not connected for github.com", 501)
  const now = Date.now()
  switch (method) {
    case "git.pr.search": {
      const words = typeof params.query === "string" ? params.query.toLowerCase().trim() : ""
      const limit = typeof params.limit === "number" ? params.limit : 20
      const found = PULLS.filter((pull) => !merged.has(keyOf(pull)) && pull.group === params.group && (words.length === 0 || pull.title.toLowerCase().includes(words) || pull.repo.includes(words)))
      return {
        host: "github.com",
        group: params.group,
        total: found.length,
        pullRequests: found.slice(0, limit).map((pull) => ({ owner: pull.owner, repo: pull.repo, number: pull.number, url: `https://github.com/${pull.owner}/${pull.repo}/pull/${String(pull.number)}`, title: pull.title, author: pull.author, updatedAt: now - pull.hoursAgo * HOUR, draft: pull.draft === true, review: pull.review, checks: pull.checks })),
      }
    }
    case "git.pr.teams":
      return { host: "github.com", teams: [{ org: "example-org", slug: "platform", name: "Platform" }, { org: "example-org", slug: "web", name: "Web" }] }
    case "git.pr.view": {
      const pull = find(params)
      const items = pull.checks === "none" ? [] : [{ name: "ci / test", state: pull.checks === "failed" ? "failed" : pull.checks === "pending" ? "pending" : "passed" }, { name: "ci / typecheck", state: "passed" }, { name: "ci / lint", state: "passed" }]
      return {
        owner: pull.owner,
        repo: pull.repo,
        number: pull.number,
        url: `https://github.com/${pull.owner}/${pull.repo}/pull/${String(pull.number)}`,
        title: pull.title,
        body: BODY,
        bodyTruncated: false,
        state: merged.has(keyOf(pull)) ? "merged" : "open",
        draft: pull.draft === true,
        author: pull.author,
        createdAt: now - (pull.hoursAgo + 20) * HOUR,
        updatedAt: now - pull.hoursAgo * HOUR,
        base: "main",
        head: pull.title.toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 32),
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        crossRepository: false,
        mergeable: pull.checks === "failed" ? "conflicts" : "yes",
        mergeState: pull.draft === true ? "draft" : pull.checks === "pending" ? "unstable" : pull.review === "approved" ? "clean" : "blocked",
        review: pull.review,
        additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
        changedFiles: pull.files.length,
        files: pull.files,
        filesTruncated: false,
        reviews: [...(pull.review === "approved" ? [{ author: "maya-k", state: "approved", submittedAt: now - HOUR }] : []), ...((posted.get(keyOf(pull)) ?? 0) > 0 ? [{ author: "preview-user", state: "commented", submittedAt: now }] : [])],
        requested: pull.group === "authored" ? [{ kind: "user", login: "devon-r" }] : [{ kind: "user", login: "preview-user" }, { kind: "team", org: "example-org", slug: "platform" }],
        checks: { passed: items.filter((item) => item.state === "passed").length, failed: items.filter((item) => item.state === "failed").length, pending: items.filter((item) => item.state === "pending").length, skipped: 0, items },
        checksState: pull.checks,
        mergeMethods: ["squash", "rebase"],
        permission: "write",
      }
    }
    case "git.pr.diff": {
      const pull = find(params)
      return { diff: pull.files.map(patchFor).join(""), truncated: false }
    }
    case "git.pr.review.post": {
      confirmed(params)
      const pull = find(params)
      posted.set(keyOf(pull), (posted.get(keyOf(pull)) ?? 0) + 1)
      const id = 1000 + (posted.get(keyOf(pull)) ?? 0)
      return { id, url: `https://github.com/${pull.owner}/${pull.repo}/pull/${String(pull.number)}#pullrequestreview-${String(id)}`, comments: Array.isArray(params.comments) ? params.comments.length : 0 }
    }
    case "git.pr.merge": {
      confirmed(params)
      const pull = find(params)
      if (pull.draft === true) throw new HostError("CONTROL_PR_MERGE_REFUSED", "a draft pull request cannot be merged", 409)
      merged.add(keyOf(pull))
      return { merged: true, method: params.method }
    }
    default:
      throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
  }
}
