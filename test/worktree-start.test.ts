import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { stopProjectService } from "../src/app/engines"
import { defaultState, parseState } from "../src/app/persist"
import { addProject, get, set } from "../src/app/store"
import { createWorktreeThread } from "../src/app/workflows"
import { baseLabel, branchRows, pullRequestRows, startBase, startLabel, typedPullRequest } from "../src/app/worktreeStart"
import { HostError, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { GitBranches, PullRequestEntry } from "../src/protocol/schemas"

const BRANCHES: GitBranches = {
  current: "main",
  local: [
    { name: "main", commit: "a", updatedAt: 30 },
    { name: "feat/search", commit: "b", updatedAt: 20 },
  ],
  remote: [
    { remote: "origin", name: "main", commit: "a", updatedAt: 30 },
    { remote: "origin", name: "fix/login", commit: "c", updatedAt: 25 },
  ],
}

const PULLS: readonly PullRequestEntry[] = [
  { number: 128, title: "Faster fuzzy search", head: "feat/fuzzy", author: "mira" },
  { number: 12, title: "Retry uploads", head: "fix/upload", author: "devon" },
]

describe("where a worktree starts", () => {
  test("local branches first; a remote branch shows only when there is no local one of that name", () => {
    const rows = branchRows(BRANCHES, "")
    expect(rows.local.map((row) => [row.label, row.current])).toEqual([["main", true], ["feat/search", false]])
    expect(rows.remote.map((row) => row.label)).toEqual(["origin/fix/login"])
    expect(rows.remote[0]?.start).toEqual({ kind: "branch", name: "fix/login", remote: "origin" })
    expect(branchRows(BRANCHES, "ORIGIN login").remote).toHaveLength(1)
    expect(branchRows(BRANCHES, "search").local.map((row) => row.label)).toEqual(["feat/search"])
  })

  test("a pull request can be typed as a number, #number, or its link", () => {
    expect(typedPullRequest("12")).toBe(12)
    expect(typedPullRequest(" #128 ")).toBe(128)
    expect(typedPullRequest("https://github.com/example-org/widgets/pull/7/files")).toBe(7)
    for (const text of ["", "0", "#", "12a", "https://github.com/example-org/widgets/issues/7", "99999999999"]) expect(typedPullRequest(text)).toBeUndefined()
    expect(pullRequestRows(PULLS, "#12").map((pull) => pull.number)).toEqual([12])
    expect(pullRequestRows(PULLS, "mira fuzzy").map((pull) => pull.number)).toEqual([128])
  })

  test("the chip and the thread header name the start", () => {
    expect(startLabel({ kind: "head" })).toBe("New worktree")
    expect(startLabel({ kind: "branch", name: "main" })).toBe("From main")
    expect(startLabel({ kind: "branch", name: "fix/login", remote: "origin" })).toBe("From origin/fix/login")
    expect(startLabel({ kind: "pr", number: 12 })).toBe("PR #12")
    expect(startBase({ kind: "head" })).toBeUndefined()
    expect(baseLabel(startBase({ kind: "branch", name: "fix/login", remote: "origin" }) ?? { kind: "branch", name: "" })).toBe("from origin/fix/login")
    expect(baseLabel({ kind: "pr", number: 12, title: "Retry uploads" })).toBe("PR #12")
  })

  test("a saved start is kept, and a damaged one is dropped without losing the worktree", () => {
    const load = (base: unknown) => parseState({ version: 1, projects: [{ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }], threads: [{ id: "t1", projectId: "p1", title: "x", titled: true, createdAt: 1, updatedAt: 1, backend: "native", mode: "agent", permission: "ask", worktree: { id: "wt1", path: "/w", cwd: "/w", base } }], prefs: {}, layout: { panels: {} } }).threads[0]?.worktree
    expect(load({ kind: "pr", number: 12, title: "Retry uploads" })?.base).toEqual({ kind: "pr", number: 12, title: "Retry uploads" })
    expect(load({ kind: "branch", name: "main" })?.base).toEqual({ kind: "branch", name: "main" })
    expect(load({ kind: "pr", number: -3 })).toMatchObject({ id: "wt1" })
    expect(load({ kind: "pr", number: -3 })?.base).toBeUndefined()
    expect(load({ kind: "tag", name: "v1" })?.base).toBeUndefined()
  })
})

describe("creating the worktree", () => {
  // One host for every test: the project's service engine stays started across them.
  const host = createFakeHost({})
  let calls: { method: string; params: Record<string, unknown> }[] = []
  let offline = false
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      calls.push({ method, params: params ?? {} })
      if (offline && method === "git.fetch") throw new HostError("CONTROL_GIT_FAILED", "git fetch failed; check the remote and its credentials", 500)
      return host.rpc(engineId, method, params)
    },
  })

  // Later test files bring their own host, which has never heard of this one's service engine.
  afterAll(() => stopProjectService("p1"))

  beforeEach(() => {
    calls = []
    offline = false
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  })

  const created = (method: string) => calls.find((call) => call.method === method)?.params

  test("a local branch starts as it is, on a branch of the thread's own", async () => {
    const thread = await createWorktreeThread({ projectId: "p1", backend: "native", select: false }, { kind: "branch", name: "feat/search" })
    expect(calls.some((call) => call.method === "git.fetch")).toBe(false)
    expect(created("worktree.create")).toMatchObject({ revision: "refs/heads/feat/search" })
    expect(String(created("worktree.create")?.branch)).toStartWith("runrail/")
    expect(thread.worktree?.base).toEqual({ kind: "branch", name: "feat/search" })
  })

  test("a pull request is fetched first and recorded on the thread", async () => {
    const thread = await createWorktreeThread({ projectId: "p1", backend: "native", select: false }, { kind: "pr", number: 128, title: "Faster fuzzy search" })
    expect(created("git.fetch")).toEqual({ pullRequest: 128 })
    expect(created("worktree.create")).toMatchObject({ revision: "refs/runrail/pull/origin/128" })
    expect(thread.worktree?.base).toEqual({ kind: "pr", number: 128, title: "Faster fuzzy search" })
  })

  test("a pull request that cannot be fetched starts nothing", async () => {
    await expect(createWorktreeThread({ projectId: "p1", backend: "native", select: false }, { kind: "pr", number: 999 })).rejects.toThrow("no such branch or pull request")
    expect(calls.some((call) => call.method === "worktree.create")).toBe(false)
    expect(get().threads).toHaveLength(0)
  })

  test("the branch is named from the first message, and a name already taken tries the next", async () => {
    const first = await createWorktreeThread({ projectId: "p1", backend: "native", select: false }, undefined, { firstMessage: "Fix the flaky upload test" })
    expect(first.worktree?.branch).toBe("runrail/fix-the-flaky-upload-test")
    const second = await createWorktreeThread({ projectId: "p1", backend: "native", select: false }, undefined, { firstMessage: "Fix the flaky upload test" })
    expect(second.worktree?.branch).toBe("runrail/fix-the-flaky-upload-test-2")
    expect(calls.filter((call) => call.method === "worktree.create").map((call) => call.params.branch)).toEqual(["runrail/fix-the-flaky-upload-test", "runrail/fix-the-flaky-upload-test", "runrail/fix-the-flaky-upload-test-2"])
    const unnamed = await createWorktreeThread({ projectId: "p1", backend: "native", select: false }, undefined, { firstMessage: "!!!" })
    expect(unnamed.worktree?.branch).toBe(`runrail/${unnamed.worktree?.id ?? ""}`)
  })

  test("offline, a remote branch starts from the copy fetched before, and says so", async () => {
    offline = true
    await createWorktreeThread({ projectId: "p1", backend: "native", select: false }, { kind: "branch", name: "fix/login", remote: "origin" })
    expect(created("worktree.create")).toMatchObject({ revision: "refs/remotes/origin/fix/login" })
    expect(get().toasts.at(-1)?.text).toContain("Starting from the copy fetched before")
  })
})
