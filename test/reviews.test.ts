import { describe, expect, test } from "bun:test"
import { checksBadge, connectionFromError, fileGroups, mergeLine, parsePullRequestLink, REVIEW_GROUPS, reviewBadge, reviewKey, splitDiff, threadForPullRequest } from "../src/app/reviews"
import { parseOr, ReviewDetailSchema, ReviewSearchSchema } from "../src/protocol/schemas"

describe("inbox groups", () => {
  test("my review first, then mine, then my teams'", () => {
    expect(REVIEW_GROUPS.map((group) => group.id)).toEqual(["review-requested", "authored", "team"])
  })
})

describe("pull request links", () => {
  test("a pasted link, with or without a tail, and the short forms", () => {
    expect(parsePullRequestLink("https://github.com/example-org/widgets/pull/68")).toEqual({ owner: "example-org", repo: "widgets", number: 68 })
    expect(parsePullRequestLink("  https://github.com/oven-sh/bun/pull/44471/files?w=1 ")).toEqual({ owner: "oven-sh", repo: "bun", number: 44471 })
    expect(parsePullRequestLink("github.com/example-org/web.site/pull/3#discussion")).toEqual({ owner: "example-org", repo: "web.site", number: 3 })
    expect(parsePullRequestLink("example-org/web#12")).toEqual({ owner: "example-org", repo: "web", number: 12 })
    expect(parsePullRequestLink("example-org/web/pull/12")).toEqual({ owner: "example-org", repo: "web", number: 12 })
  })

  test("anything else is plain search text", () => {
    for (const text of ["plan host", "https://gitlab.com/example-org/web/-/merge_requests/3", "https://github.com/example-org/web/issues/3", "https://github.com/example-org/web/pull/0", "https://evil.example/github.com/a/b/pull/1", "example-org/web#", "../x/y#1"])
      expect(parsePullRequestLink(text)).toBeUndefined()
  })

  test("keys ignore case so a link and a list row meet", () => {
    expect(reviewKey({ owner: "Example-Org", repo: "Web", number: 1 })).toBe(reviewKey({ owner: "example-org", repo: "web", number: 1 }))
  })
})

describe("badges and lines", () => {
  test("checks say their state in words", () => {
    expect(checksBadge("passed")).toEqual({ text: "Checks passed", tone: "green" })
    expect(checksBadge("failed")?.tone).toBe("red")
    expect(checksBadge("pending")?.tone).toBe("amber")
    expect(checksBadge("none")).toBeUndefined()
  })

  test("a draft says so before any review state", () => {
    expect(reviewBadge({ draft: true, review: "approved" })?.text).toBe("Draft")
    expect(reviewBadge({ draft: false, review: "approved" })?.text).toBe("Approved")
    expect(reviewBadge({ draft: false, review: "changes-requested" })?.text).toBe("Changes requested")
    expect(reviewBadge({ draft: false, review: "required" })).toBeUndefined()
  })

  test("merge status from GitHub's merge state", () => {
    const open = { state: "open", draft: false, mergeable: "yes", mergeState: "clean" } as const
    expect(mergeLine(open).text).toBe("Can merge without conflicts")
    expect(mergeLine({ ...open, mergeable: "conflicts", mergeState: "dirty" }).tone).toBe("red")
    expect(mergeLine({ ...open, mergeState: "blocked" }).text).toBe("Blocked by required reviews or checks")
    expect(mergeLine({ ...open, mergeState: "behind" }).text).toBe("Behind the base branch")
    expect(mergeLine({ ...open, draft: true }).tone).toBe("gray")
    expect(mergeLine({ ...open, state: "merged" }).text).toBe("Merged")
    expect(mergeLine({ ...open, mergeable: "unknown", mergeState: "unknown" }).tone).toBe("gray")
  })

  test("only the codes the connect panel answers leave the group", () => {
    expect(connectionFromError("CONTROL_PR_NOT_CONNECTED")).toBe("not-connected")
    expect(connectionFromError("CONTROL_PR_UNAVAILABLE")).toBe("gh-missing")
    expect(connectionFromError("CONTROL_PR_CREDENTIALS")).toBe("signed-out")
    expect(connectionFromError("CONTROL_PR_RATE_LIMITED")).toBeUndefined()
  })
})

describe("changes", () => {
  test("files are grouped by folder, root files first", () => {
    const files = [
      { path: "src/b/x.ts", additions: 1, deletions: 0, change: "modified" },
      { path: "README.md", additions: 1, deletions: 0, change: "modified" },
      { path: "src/a.ts", additions: 1, deletions: 0, change: "added" },
      { path: "src/b/y.ts", additions: 1, deletions: 0, change: "modified" },
    ] as const
    expect(fileGroups(files).map((group) => [group.dir, group.files.map((file) => file.path)])).toEqual([
      ["", ["README.md"]],
      ["src", ["src/a.ts"]],
      ["src/b", ["src/b/x.ts", "src/b/y.ts"]],
    ])
  })

  test("a diff splits per file, a deleted file under its old path", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/from.ts b/to.ts",
      "similarity index 90%",
      "rename from from.ts",
      "rename to to.ts",
      "",
    ].join("\n")
    const files = splitDiff(diff)
    expect([...files.keys()]).toEqual(["a.ts", "old.ts", "to.ts"])
    expect(files.get("a.ts")).toContain("+y")
    expect(files.get("a.ts")).not.toContain("gone")
  })

  test("the thread that opened a pull request is found by its link", () => {
    const threads = [
      { id: "t1", title: "one", pullRequests: [{ number: 3, url: "https://github.com/example-org/web/pull/3", at: 1, card: true }] },
      { id: "t2", title: "two" },
    ]
    expect(threadForPullRequest(threads, "https://github.com/Example-Org/Web/pull/3")?.id).toBe("t1")
    expect(threadForPullRequest(threads, "https://github.com/example-org/web/pull/4")).toBeUndefined()
    expect(threadForPullRequest(threads, undefined)).toBeUndefined()
  })
})

describe("engine answers", () => {
  test("a search keeps good rows and drops bad ones", () => {
    const parsed = parseOr(ReviewSearchSchema, { total: 3, pullRequests: [{ owner: "a", repo: "b", number: 1, draft: false, review: "approved", checks: "passed" }, { owner: "a", repo: "b", number: -1 }, { owner: "a", repo: "b", number: 2, review: "new-state", checks: "odd" }] })
    expect(parsed?.pullRequests.map((entry) => [entry.number, entry.review, entry.checks])).toEqual([
      [1, "approved", "passed"],
      [2, "none", "none"],
    ])
  })

  test("a detail with missing parts still reads", () => {
    const parsed = parseOr(ReviewDetailSchema, { owner: "a", repo: "b", number: 1, files: "nope", checks: null })
    expect(parsed).toMatchObject({ body: "", files: [], reviews: [], requested: [], mergeMethods: [], checks: { passed: 0, items: [] }, mergeable: "unknown" })
  })
})

test("a pull request goes into the branch its worktree started from, else the repository's usual base", async () => {
  const { prBase } = await import("../src/ui/inspector/ReviewPane")
  expect(prBase({ kind: "branch", name: "release/2" }, undefined)).toBe("release/2")
  const branches = (names: string[], current?: string) => ({ ...(current === undefined ? {} : { current }), local: [], remote: names.map((name) => ({ remote: "origin", name, commit: "c", updatedAt: 1 })) })
  expect(prBase(undefined, branches(["master", "feature"], "feature"))).toBe("master")
  expect(prBase(undefined, branches(["main", "master"]))).toBe("main")
  expect(prBase(undefined, undefined)).toBe("main")
})

test("two files whose names differ only in punctuation get their own anchors", async () => {
  const { fileAnchor } = await import("../src/ui/views/Reviews")
  expect(fileAnchor("a/b.ts")).not.toBe(fileAnchor("a-b.ts"))
  expect(fileAnchor("a/b.ts")).toBe(fileAnchor("a/b.ts"))
  expect(fileAnchor("x".repeat(500)).length).toBeLessThan(120)
})
