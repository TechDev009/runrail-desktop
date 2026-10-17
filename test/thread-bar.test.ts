import { describe, expect, test } from "bun:test"
import { connectedTo, projectGitRow, pullRequestsOffered, repoLine, serviceLine, type ConnectedTo } from "../src/app/gitHosts"
import { parseState } from "../src/app/persist"
import { branchView, BUSY_REASON, changesLabel, DIVERGED_REASON, fetchDue, fetchedLabel, FETCH_INTERVAL_MS, oneButton, pulledMessage, splitUpstream, startView } from "../src/app/threadBar"
import { branchSlug, worktreeBranchNames } from "../src/app/worktreeStart"
import { parsePreviewScenario } from "../src/host/fakeConnections"
import type { GitRemote, GitStatus } from "../src/protocol/schemas"

function status(fields: Partial<GitStatus>): GitStatus {
  return { branch: "main", detached: false, initial: false, head: "abc1234def5678", ahead: 0, behind: 0, upstream: "origin/main", entries: [], counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, ...fields }
}

describe("the branch control", () => {
  test("each state of the branch", () => {
    expect(branchView(status({}), undefined)).toEqual({ label: "main", worktree: false, title: "main → origin/main" })
    expect(branchView(status({ ahead: 2, behind: 1 }), undefined)).toMatchObject({ label: "main", counts: "↑2 ↓1" })
    expect(branchView(status({ ahead: 2 }), undefined)?.counts).toBe("↑2")
    expect(branchView(status({ branch: "feat/x", upstream: null }), undefined)?.title).toBe("feat/x\nNot published")
    const worktree = { branch: "runrail/fix-login", path: "/wt/1" }
    expect(branchView(status({ branch: "runrail/fix-login", upstream: null }), { ...worktree, base: { kind: "branch", name: "main" } })).toMatchObject({ label: "Worktree · from main", worktree: true })
    expect(branchView(status({ branch: "runrail/x" }), { ...worktree, base: { kind: "pr", number: 128 } })?.label).toBe("Worktree · PR #128")
    expect(branchView(status({ branch: "runrail/x" }), worktree)?.label).toBe("Worktree")
    expect(branchView(status({ branch: "runrail/x" }), worktree)?.title).toContain("/wt/1")
    expect(branchView(status({ branch: null, detached: true }), undefined)?.label).toBe("detached at abc1234")
    expect(branchView(status({ initial: true, upstream: null }), undefined)?.label).toBe("main · no commits")
    expect(branchView(undefined, undefined)).toBeUndefined()
    expect(branchView(undefined, worktree)?.label).toBe("Worktree")
  })
})

describe("the one button", () => {
  const button = (fields: Partial<GitStatus>, hasRemote: boolean | undefined = true, busy = false) => oneButton({ status: status(fields), hasRemote, busy })

  test("each state of the button", () => {
    expect(button({ upstream: null })).toEqual({ kind: "publish", label: "Publish branch" })
    expect(button({ upstream: null }, false)).toBeUndefined()
    expect(oneButton({ status: status({ upstream: null }), hasRemote: undefined, busy: false })).toBeUndefined()
    expect(button({ ahead: 2 })).toEqual({ kind: "push", label: "Push 2", count: 2 })
    expect(button({ behind: 1 })).toEqual({ kind: "pull", label: "Pull 1", count: 1 })
    expect(button({ ahead: 2, behind: 1 })).toEqual({ kind: "sync", label: "Sync", disabled: DIVERGED_REASON })
    expect(button({})).toBeUndefined()
    expect(button({ detached: true, branch: null })).toBeUndefined()
    expect(button({ initial: true })).toBeUndefined()
  })

  test("pull waits while a thread on the same checkout is working; push does not", () => {
    expect(button({ behind: 3 }, true, true)).toMatchObject({ kind: "pull", disabled: BUSY_REASON })
    expect(button({ ahead: 3 }, true, true)).not.toHaveProperty("disabled")
  })
})

describe("changes, fetch, and pull wording", () => {
  test("changes read +added -removed and files, with a + when the engine stopped counting", () => {
    expect(changesLabel({ files: 6, additions: 120, deletions: 34 })).toBe("+120 -34 · 6 files")
    expect(changesLabel({ files: 1, additions: 1, deletions: 0 })).toBe("+1 -0 · 1 file")
    expect(changesLabel({ files: 1, additions: 1, deletions: 0, truncated: true })).toBe("+1 -0 · 1+ files")
    expect(changesLabel({ files: 0, additions: 0, deletions: 0 })).toBeUndefined()
    expect(changesLabel(undefined)).toBeUndefined()
  })

  test("an upstream splits at its first slash, since remote names hold none", () => {
    expect(splitUpstream("origin/feature/x")).toEqual({ remote: "origin", branch: "feature/x" })
    expect(splitUpstream("origin/")).toBeUndefined()
    expect(splitUpstream("main")).toBeUndefined()
    expect(splitUpstream(null)).toBeUndefined()
  })

  test("fetch is due once per five minutes, and says when it last ran", () => {
    expect(fetchDue(undefined, 10)).toBe(true)
    expect(fetchDue(0, FETCH_INTERVAL_MS - 1)).toBe(false)
    expect(fetchDue(0, FETCH_INTERVAL_MS)).toBe(true)
    expect(fetchedLabel(undefined, 0)).toBe("Not fetched yet")
    expect(fetchedLabel(0, 30_000)).toBe("Fetched just now")
    expect(fetchedLabel(0, 3 * 60_000)).toBe("Fetched 3m ago")
    expect(fetchedLabel(0, 2 * 3_600_000)).toBe("Fetched 2h ago")
  })

  test("a pull's toast names what came in", () => {
    expect(pulledMessage({ pulled: 2, upstream: "origin/main", outcome: "fast-forwarded" })).toBe("Pulled 2 commits from origin/main")
    expect(pulledMessage({ pulled: 1, upstream: "origin/main", outcome: "fast-forwarded" })).toBe("Pulled 1 commit from origin/main")
    expect(pulledMessage({ pulled: 0, upstream: "origin/main", outcome: "up-to-date" })).toBe("Already up to date with origin/main")
  })
})

describe("a new thread's branch, before it runs", () => {
  const local = { worktree: false, start: { kind: "head" } } as const
  test("the checkout's branch, labelled as the thread's bar will label it", () => {
    expect(startView({ branch: "main", detached: false, initial: false }, local)).toEqual({ label: "main", worktree: false, title: "Runs in your checkout on main" })
    expect(startView({ detached: true, initial: false, head: "4f2c9e1a7b3d" }, local)?.label).toBe("detached at 4f2c9e1")
    expect(startView({ branch: "trunk", detached: false, initial: true }, local)?.label).toBe("trunk · no commits")
    expect(startView(undefined, local)).toBeUndefined()
  })

  test("a worktree reads as it will once it runs", () => {
    const head = { branch: "main", detached: false, initial: false }
    expect(startView(head, { worktree: true, start: { kind: "head" } })).toMatchObject({ label: "Worktree", worktree: true, title: "A new worktree from where your checkout is now (main), on its own branch" })
    expect(startView(head, { worktree: true, start: { kind: "branch", name: "release", remote: "origin" } })?.label).toBe("Worktree · from origin/release")
    expect(startView(undefined, { worktree: true, start: { kind: "pr", number: 12 } })?.label).toBe("Worktree · PR #12")
    const wt = { branch: "runrail/fix", path: "/wt/1" }
    expect(branchView(undefined, { ...wt, base: { kind: "branch", name: "origin/release" } })?.label).toBe(startView(head, { worktree: true, start: { kind: "branch", name: "release", remote: "origin" } })?.label)
    expect(branchView(undefined, { ...wt, base: { kind: "pr", number: 12 } })?.label).toBe(startView(head, { worktree: true, start: { kind: "pr", number: 12 } })?.label)
    expect(branchView(undefined, wt)?.label).toBe(startView(head, { worktree: true, start: { kind: "head" } })?.label)
  })
})

function remote(fields: Partial<GitRemote> & { readonly name: string }): GitRemote {
  return { url: "x", ...fields }
}

describe("what a folder is connected to", () => {
  test("each kind of remote", () => {
    const line = (remotes: readonly GitRemote[]) => serviceLine(connectedTo(remotes))?.text
    expect(line([])).toBe("git")
    expect(line([remote({ name: "origin", url: "local" })])).toBe("git")
    expect(line([remote({ name: "origin", host: "github.com", path: "example-org/widgets", service: "github", serviceFrom: "host" })])).toBe("GitHub · example-org/widgets")
    expect(line([remote({ name: "origin", host: "gitlab.com", path: "group/sub/widgets", service: "gitlab", serviceFrom: "host" })])).toBe("GitLab · group/sub/widgets")
    expect(line([remote({ name: "origin", host: "bitbucket.org", path: "workspace/widgets", service: "bitbucket", serviceFrom: "host" })])).toBe("Bitbucket · workspace/widgets")
    expect(line([remote({ name: "origin", host: "git.corp.example", path: "a/b/c", service: "gitlab", serviceFrom: "path" })])).toBe("git.corp.example · GitLab?")
    expect(line([remote({ name: "origin", host: "git.corp.example", path: "a/b/c", service: "gitlab", serviceFrom: "user" })])).toBe("GitLab · a/b/c")
    expect(line([remote({ name: "origin", host: "code.example", path: "example-org/widgets", service: "unknown" })])).toBe("code.example · example-org/widgets")
  })

  test("the upstream remote counts first, then origin, then the only one; a fork names its parent", () => {
    const fork = [remote({ name: "origin", host: "github.com", owner: "me", path: "me/widgets", service: "github", serviceFrom: "host" }), remote({ name: "upstream", host: "github.com", owner: "example-org", path: "example-org/widgets", service: "github", serviceFrom: "host" })]
    expect(connectedTo(fork)).toMatchObject({ path: "me/widgets", upstream: "example-org/widgets" })
    expect(serviceLine(connectedTo(fork))?.text).toBe("GitHub · me/widgets · fork of example-org/widgets")
    expect(connectedTo(fork, "upstream")).toMatchObject({ path: "example-org/widgets" })
    expect(connectedTo([remote({ name: "a", host: "h1" }), remote({ name: "b", host: "h2" })])).toEqual({ service: "local", certain: true })
  })

  test("the bar names the repository, and where it lives in the tooltip", () => {
    const repo = (remotes: readonly GitRemote[] | undefined, path = "/Users/me/code/widgets-app") => repoLine({ path, git: true, ...(remotes === undefined ? {} : { connectedTo: connectedTo(remotes) }) })
    expect(repo([remote({ name: "origin", host: "github.com", path: "example-org/widgets", service: "github", serviceFrom: "host" })])).toEqual({ name: "widgets", title: "GitHub · github.com/example-org/widgets" })
    expect(repo([remote({ name: "origin", host: "gitlab.com", path: "group/sub/widgets", service: "gitlab", serviceFrom: "host" })])?.name).toBe("widgets")
    expect(repo([remote({ name: "origin", host: "git.corp.example", path: "ops/api", service: "gitlab", serviceFrom: "path" })])).toEqual({ name: "api", title: "git.corp.example/ops/api\ngit.corp.example looks like GitLab. Confirm it in Settings → Projects." })
    expect(repo([remote({ name: "origin", host: "code.example", path: "example-org/widgets", service: "unknown" })])?.title).toStartWith("code.example/example-org/widgets\ncode.example: which service")
    const fork = [remote({ name: "origin", host: "github.com", owner: "me", path: "me/widgets", service: "github", serviceFrom: "host" }), remote({ name: "upstream", host: "github.com", owner: "example-org", path: "example-org/widgets", service: "github", serviceFrom: "host" })]
    expect(repo(fork)).toEqual({ name: "widgets", title: "GitHub · github.com/me/widgets · fork of example-org/widgets" })
    expect(repo([])).toEqual({ name: "widgets-app", title: "widgets-app\nA git repository with no remote" })
    expect(repo(undefined, "/Users/me/code/notes/")).toEqual({ name: "notes", title: "notes" })
    expect(repoLine({ path: "/Users/me/code/notes", git: false })).toBeUndefined()
  })

  test("pull requests are offered on GitHub and on a guess, not on a certain GitLab or Bitbucket", () => {
    const offered = (connected: ConnectedTo) => pullRequestsOffered(connected)
    expect(offered({ service: "github", certain: true, host: "github.com" })).toBe(true)
    expect(offered({ service: "gitlab", certain: false, host: "git.corp" })).toBe(true)
    expect(offered({ service: "gitlab", certain: true, host: "gitlab.com" })).toBe(false)
    expect(offered({ service: "bitbucket", certain: true, host: "bitbucket.org" })).toBe(false)
    expect(offered({ service: "local", certain: true })).toBe(false)
  })

  test("a project's row in Settings → Projects says what its folder is on and offers what applies", () => {
    const row = (connected: ConnectedTo | undefined, records: Parameters<typeof projectGitRow>[1] = [], git = true) => projectGitRow({ git, ...(connected === undefined ? {} : { connectedTo: connected }) }, records)
    expect(row(undefined, [], false)).toEqual({ text: "Not a git folder", git: false, answer: "none" })
    expect(row(undefined)).toEqual({ text: "git", git: true, answer: "none" })
    expect(row({ service: "local", certain: true })).toEqual({ text: "git · no remote", git: true, answer: "none" })
    expect(row({ service: "github", certain: true, host: "github.com", path: "example-org/web" })).toEqual({ text: "GitHub · example-org/web", git: true, host: "github.com", service: "github", answer: "none", githubCli: { enabled: false } })
    expect(row({ service: "github", certain: true, host: "github.com", path: "me/web", upstream: "example-org/web" }, [{ host: "github.com", connection: { via: "gh", enabled: true, addedAt: 1 } }])).toMatchObject({ text: "GitHub · me/web", fork: "example-org/web", githubCli: { enabled: true } })
    expect(row({ service: "gitlab", certain: true, host: "gitlab.com", path: "example-org/mobile/app" })).toEqual({ text: "GitLab · example-org/mobile/app", git: true, host: "gitlab.com", service: "gitlab", answer: "none" })
    expect(row({ service: "gitlab", certain: false, host: "git.corp.example", path: "ops/api" })).toEqual({ text: "git.corp.example · looks like GitLab", git: true, host: "git.corp.example", service: "gitlab", answer: "ask", guess: "gitlab" })
    expect(row({ service: "unknown", certain: false, host: "code.example", path: "example-org/web" })).toEqual({ text: "code.example · example-org/web", git: true, host: "code.example", service: "unknown", answer: "ask", githubCli: { enabled: false } })
    // An answer kept for host:port covers the remote on that host; the person can change it.
    expect(row({ service: "bitbucket", certain: true, host: "git.corp.example", path: "ops/api" }, [{ host: "git.corp.example:8443", service: "bitbucket" }])).toMatchObject({ text: "Bitbucket · ops/api", answer: "change" })
  })
})

describe("worktree branch names", () => {
  test("the slug is lowercase ASCII, at most six words and forty characters", () => {
    expect(branchSlug("Fix the login form!")).toBe("fix-the-login-form")
    expect(branchSlug("Café crème: déjà vu")).toBe("cafe-creme-deja-vu")
    expect(branchSlug("one two three four five six seven")).toBe("one-two-three-four-five-six")
    expect(branchSlug("refactor authentication middleware into separate packages")).toBe("refactor-authentication-middleware-into")
    expect(branchSlug("x".repeat(60))).toBe("x".repeat(40))
    expect(branchSlug("¿¿ !! ??")).toBe("")
  })

  test("a clash tries -2 to -5, then the id; no slug uses the id at once; Best of N numbers its runs", () => {
    expect(worktreeBranchNames("Fix login", "wt-1")).toEqual(["runrail/fix-login", "runrail/fix-login-2", "runrail/fix-login-3", "runrail/fix-login-4", "runrail/fix-login-5", "runrail/wt-1"])
    expect(worktreeBranchNames("", "wt-1")).toEqual(["runrail/wt-1"])
    expect(worktreeBranchNames(undefined, "wt-1")).toEqual(["runrail/wt-1"])
    expect(worktreeBranchNames("Fix login", "wt-1", 2)[0]).toBe("runrail/fix-login-2")
  })
})

describe("saved and preview state", () => {
  const project = (connectedTo: unknown) => parseState({ version: 1, projects: [{ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1, connectedTo }], threads: [], prefs: {}, layout: {} }).projects[0]

  test("what a project is connected to is kept; a damaged value is dropped, not the project", () => {
    expect(project({ service: "github", certain: true, host: "github.com", path: "example-org/web" })?.connectedTo).toEqual({ service: "github", certain: true, host: "github.com", path: "example-org/web" })
    expect(project({ service: "svn", certain: true })).toMatchObject({ id: "p1" })
    expect(project({ service: "svn", certain: true })?.connectedTo).toBeUndefined()
    expect(project({ service: "github", certain: "yes" })?.connectedTo).toBeUndefined()
  })

  test("the preview reads a git state and a GitHub CLI state from its scenario", () => {
    expect(parsePreviewScenario("git-behind,gh-signed-out")).toEqual({ git: "behind", gh: "signed-out" })
    expect(parsePreviewScenario("git-nonsense")).toEqual({})
  })
})
