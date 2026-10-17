import { describe, expect, test } from "bun:test"
import { commentableLines, FINDINGS_FORMAT, parseFindings, planPost, reviewPrompt } from "../src/app/reviewFindings"
import { findingsOf, fixPrompt, projectForPullRequest, reviewThreadsOf } from "../src/app/reviews"
import type { TimelineItem } from "../src/thread/reducer"

const block = (value: unknown): string => `Here is what I found.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

describe("reading findings", () => {
  test("a valid block, its summary and findings", () => {
    const result = parseFindings(block({ summary: "Adds a report.", findings: [{ severity: "high", path: "src/a.ts", line: 4, title: "Null read", body: "Guard it." }, { severity: "low", title: "No test" }] }))
    expect(result).toEqual({ state: "ok", summary: "Adds a report.", findings: [{ severity: "high", path: "src/a.ts", line: 4, title: "Null read", body: "Guard it." }, { severity: "low", title: "No test" }], dropped: 0 })
  })

  test("the last block wins, so an example earlier in the answer is not read", () => {
    const text = `${block({ findings: [{ severity: "low", title: "example" }] })}\n\nThen:\n${block({ findings: [] })}`
    expect(parseFindings(text)).toEqual({ state: "ok", findings: [], dropped: 0 })
  })

  test("partial: bad entries are dropped and counted, never guessed at", () => {
    const result = parseFindings(block({ findings: [{ severity: "critical", title: "x" }, { severity: "medium" }, "text", { severity: "medium", title: "Kept", path: "/etc/passwd", line: 3 }, { severity: "low", title: "Up", path: "../x.ts" }, { severity: "low", title: "Line only", line: 9 }] }))
    expect(result.state).toBe("ok")
    if (result.state !== "ok") return
    expect(result.dropped).toBe(3)
    // An absolute or escaping path is not a place in the change, and a line without a path is no place either.
    expect(result.findings).toEqual([{ severity: "medium", title: "Kept" }, { severity: "low", title: "Up" }, { severity: "low", title: "Line only" }])
  })

  test("missing and invalid blocks", () => {
    expect(parseFindings("All good, nothing to raise.")).toEqual({ state: "missing" })
    expect(parseFindings("```json\n{not json}\n```")).toEqual({ state: "invalid" })
    expect(parseFindings(block([1, 2]))).toEqual({ state: "invalid" })
    expect(parseFindings(block({ summary: "no list" }))).toEqual({ state: "invalid" })
  })

  test("oversized: at most 50 findings, long text cut", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ severity: "low", title: `T${String(index)}`, ...(index === 0 ? { body: "b".repeat(10_000) } : {}) }))
    const result = parseFindings(block({ findings: many }))
    expect(result.state).toBe("ok")
    if (result.state !== "ok") return
    expect(result.findings).toHaveLength(50)
    expect(result.dropped).toBe(30)
    expect(result.findings[0]?.body).toHaveLength(4_000)
  })

  test("a long answer is read from its end, where the block is", () => {
    expect(parseFindings(`${"prose ".repeat(60_000)}\n${block({ findings: [{ severity: "low", title: "Kept" }] })}`)).toEqual({ state: "ok", findings: [{ severity: "low", title: "Kept" }], dropped: 0 })
  })

  test("a finding is read only once the answer has ended", () => {
    const answer = (text: string, streaming: boolean): TimelineItem => ({ kind: "assistant", key: "a", text, streaming, at: 1 })
    expect(findingsOf([answer(block({ findings: [] }), true)])).toBeUndefined()
    expect(findingsOf([answer(block({ findings: [] }), false)])).toEqual({ state: "ok", findings: [], dropped: 0 })
    expect(findingsOf([])).toBeUndefined()
  })
})

describe("the review prompt", () => {
  test("names the pull request, says it only reads, and ends with the format", () => {
    const prompt = reviewPrompt({ owner: "example-org", repo: "web", number: 88, title: "Shift report", base: "main", focus: "the summary math" })
    expect(prompt).toContain("#88 in example-org/web: Shift report")
    expect(prompt).toContain("origin/main")
    expect(prompt).toContain("do not edit files")
    expect(prompt).toContain("Pay particular attention to: the summary math")
    expect(prompt.endsWith(FINDINGS_FORMAT)).toBe(true)
  })
})

const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", " keep", "-gone", "+added one", "+added two", " tail", ""].join("\n")

describe("what goes to GitHub", () => {
  test("comment lines are the new side of the hunks, added or unchanged", () => {
    expect([...commentableLines(PATCH)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13])
  })

  test("a finding on a line in the diff is a line comment; any other is a point in the body", () => {
    const post = planPost(
      [
        { severity: "high", path: "src/a.ts", line: 11, title: "Wrong value", body: "Use two." },
        { severity: "medium", path: "src/a.ts", line: 40, title: "Far away" },
        { severity: "low", path: "src/other.ts", line: 1, title: "Not in diff" },
        { severity: "low", title: "Whole change", body: "Line one\nline two" },
      ],
      new Map([["src/a.ts", PATCH]]),
      "Codex",
    )
    expect(post.comments).toEqual([{ path: "src/a.ts", line: 11, side: "RIGHT", body: "**High: Wrong value**\n\nUse two." }])
    expect(post.body).toBe(["Review by Codex, through Runrail: 4 findings, 1 on lines below.", "", "- **Medium: Far away** (`src/a.ts:40`)", "- **Low: Not in diff** (`src/other.ts:1`)", "- **Low: Whole change** Line one line two"].join("\n"))
  })
})

describe("matching a pull request to a project", () => {
  const project = (id: string, path: string | undefined, upstream?: string, git = true) => ({ id, git, connectedTo: { service: "github" as const, certain: true, host: "github.com", ...(path === undefined ? {} : { path }), ...(upstream === undefined ? {} : { upstream }) } })

  test("by the repository, or a fork's upstream, ignoring case", () => {
    const projects = [project("p1", "me/other"), project("p2", "me/web", "Example-Org/Web"), project("p3", "example-org/web")]
    expect(projectForPullRequest(projects, { owner: "example-org", repo: "web", number: 1 })?.id).toBe("p2")
    expect(projectForPullRequest([project("p3", "EXAMPLE-ORG/web")], { owner: "example-org", repo: "web", number: 1 })?.id).toBe("p3")
  })

  test("not a folder without git, nor another host", () => {
    expect(projectForPullRequest([project("p1", "example-org/web", undefined, false)], { owner: "example-org", repo: "web", number: 1 })).toBeUndefined()
    expect(projectForPullRequest([{ id: "p2", git: true, connectedTo: { host: "gitlab.com", path: "example-org/web" } }], { owner: "example-org", repo: "web", number: 1 })).toBeUndefined()
  })

  test("review threads of one pull request, newest first, archived left out", () => {
    const review = { owner: "example-org", repo: "web", number: 7 }
    const threads = [
      { id: "a", review, createdAt: 1 },
      { id: "b", review, createdAt: 3 },
      { id: "c", review, createdAt: 5, archived: true },
      { id: "d", review: { ...review, number: 8 }, createdAt: 9 },
      { id: "e", createdAt: 10 },
    ]
    expect(reviewThreadsOf(threads, review).map((thread) => thread.id)).toEqual(["b", "a"])
  })

  test("a fix prompt names the place and the problem", () => {
    expect(fixPrompt({ owner: "example-org", repo: "web", number: 7 }, { severity: "high", path: "src/a.ts", line: 3, title: "Null read", body: "Guard it." })).toBe(["A review of pull request #7 in example-org/web found this in `src/a.ts:3`:", "", "Null read\n\nGuard it.", "", "Check whether it holds, and fix it if it does."].join("\n"))
  })
})
