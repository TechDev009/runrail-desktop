import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, send } from "../src/app/engines"
import { defaultState, parseState } from "../src/app/persist"
import { FINDINGS_FORMAT } from "../src/app/reviewFindings"
import { useReviewMemory } from "../src/app/reviewMemory"
import { diffForReview, initSelfReview, placeFindings, reviewMyChanges, SECURITY_CHECKLIST, selfReviewPrompt, useSelfReviews } from "../src/app/selfReview"
import { addProject, createThread, get, runtimeOf, set, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { GitDiff } from "../src/protocol/schemas"
import { commentPrompt } from "../src/ui/inspector/ReviewPane"

/** "Review my changes". */

setDefaultTimeout(20_000)

const PATCH = ["@@ -1,3 +1,4 @@", " const a = 1", "-const b = 2", "+const b = 3", "+const c = `x`", " export { a }", ""].join("\n")
const diff: GitDiff = {
  files: [
    { path: "src/a.ts", change: "modified", additions: 2, deletions: 1, patch: PATCH },
    { path: ".env", change: "modified", additions: 1, deletions: 1, sensitive: true },
    { path: "logo.png", change: "added", additions: 0, deletions: 0, binary: true },
  ],
  totals: { files: 3, additions: 3, deletions: 2 },
}

test("the prompt asks for a read-only review with the checklist, the diff, and the findings block", () => {
  const prompt = selfReviewPrompt({ diff, focus: "the parser" })
  expect(prompt.startsWith("Review the changes in this checkout that are not committed yet.")).toBe(true)
  expect(prompt).toContain("do not edit files, commit, push")
  for (const item of SECURITY_CHECKLIST) expect(prompt).toContain(`- ${item}`)
  expect(prompt).toContain("Pay particular attention to: the parser")
  expect(prompt).toContain(FINDINGS_FORMAT)
  // The patch has backticks of its own, so the fence is longer than any of them.
  expect(prompt).toContain("```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@")
  expect(prompt).toContain("except files that hold credentials: .env, logo.png")
})

test("past the budget, the rest of the files are named instead", () => {
  const big: GitDiff = { files: [{ path: "src/a.ts", change: "modified", additions: 1, deletions: 0, patch: PATCH }, { path: "src/b.ts", change: "added", additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${"x".repeat(500)}` }], totals: { files: 2, additions: 2, deletions: 0 } }
  const { text, unread } = diffForReview(big, 200)
  expect(text).toContain("+++ b/src/a.ts")
  expect(text).not.toContain("src/b.ts")
  expect(unread).toEqual(["src/b.ts"])
  expect(diffForReview(big).text).toContain("--- /dev/null\n+++ b/src/b.ts")
})

test("findings on lines the diff shows become comments; the rest are listed apart", () => {
  const { comments, general } = placeFindings(
    [
      { severity: "high", path: "src/a.ts", line: 2, title: "b changed", body: "Callers expect 2." },
      { severity: "low", path: "src/a.ts", line: 40, title: "Far away" },
      { severity: "medium", path: "src/other.ts", line: 1, title: "Not in the diff" },
      { severity: "low", title: "No tests" },
    ],
    diff,
    "Review",
  )
  expect(comments).toEqual([{ path: "src/a.ts", line: 2, side: "new", text: "b changed\n\nCallers expect 2.", excerpt: "", from: "Review", severity: "high" }])
  expect(general.map((finding) => finding.title)).toEqual(["Far away", "Not in the diff", "No tests"])
})

test("a review comment says so when it goes to the agent", () => {
  const text = commentPrompt([
    { id: "c1", path: "src/a.ts", line: 2, side: "new", text: "b changed", excerpt: "", from: "Review", severity: "high" },
    { id: "c2", path: "src/a.ts", line: 3, side: "new", text: "mine", excerpt: "const c" },
  ])
  expect(text).toContain("- src/a.ts:2 [high, from the review]\n  b changed")
  expect(text).toContain("- src/a.ts:3 (`const c`)\n  mine")
})

test("the review thread's link back is saved, and a bad one dropped", () => {
  const thread = { id: "t1", projectId: "p1", title: "x", titled: true, createdAt: 1, updatedAt: 1, backend: "native", mode: "plan", permission: "ask" }
  const project = { id: "p1", path: "/a", name: "a", git: true, addedAt: 1 }
  expect(parseState({ ...defaultState(), projects: [project], threads: [{ ...thread, reviewOf: "t0" }] }).threads[0]?.reviewOf).toBe("t0")
  expect(parseState({ ...defaultState(), projects: [project], threads: [{ ...thread, reviewOf: "../x" }] }).threads[0]?.reviewOf).toBeUndefined()
})

async function until(done: () => boolean, tries = 3_000): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

describe("reviewing a thread's changes", () => {
  let stop: () => void = () => undefined

  beforeEach(() => {
    stop()
    setHost(createFakeHost({}))
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    useSelfReviews.setState({}, true)
    useReviewMemory.setState({ comments: {}, viewed: {} })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    const engines = initEngines()
    const reviews = initSelfReview()
    stop = () => {
      reviews()
      engines()
    }
  })

  test("runs on the thread's model in Plan mode, unopened, and its findings land as comments", async () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai", permission: "full" })
    await ensureEngine(thread.id)
    send(thread.id, { text: "fix the parser" })
    await until(() => runtimeOf(thread.id).timeline.items.some((item) => item.kind === "turn-end"))
    const shown = get().layout
    await reviewMyChanges(thread.id)
    const running = useSelfReviews.getState()[thread.id]
    expect(running?.state).toBe("running")
    const review = threadById(running?.reviewThreadId)
    expect(review).toMatchObject({ backend: "native", model: "gpt-5.5", connectionId: "openai", mode: "plan", reviewOf: thread.id })
    expect(review?.title).toStartWith("Review: ")
    expect(get().layout).toEqual(shown)
    await until(() => useSelfReviews.getState()[thread.id]?.state === "done")
    const comments = useReviewMemory.getState().comments[thread.id] ?? []
    expect(comments.map((comment) => [comment.path, comment.line, comment.severity])).toEqual([
      ["src/session.ts", 17, "medium"],
      ["src/session.ts", 19, "low"],
    ])
    const done = useSelfReviews.getState()[thread.id]
    expect(done?.placed).toBe(2)
    expect(done?.general.map((finding) => finding.title)).toEqual(["No test for a line that is JSON but not an Entry"])
    expect(get().toasts.some((toast) => toast.text === "The review found 3 things; they are in the Review pane.")).toBe(true)
    // A second review archives the first, which has finished.
    await reviewMyChanges(thread.id)
    expect(threadById(review?.id)?.archived).toBe(true)
    expect(get().threads.filter((item) => item.reviewOf === thread.id && item.archived !== true)).toHaveLength(1)
  })

  test("with nothing changed there is nothing to start", async () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    const before = get().threads.length
    await reviewMyChanges(thread.id)
    expect(get().threads.length).toBe(before)
    expect(useSelfReviews.getState()[thread.id]).toBeUndefined()
    expect(get().toasts.some((toast) => toast.text === "There are no uncommitted changes to review.")).toBe(true)
  })
})
