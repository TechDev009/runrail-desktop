import { describe, expect, test } from "bun:test"
import { parseState, type ThreadPullRequest } from "../src/app/persist"
import { checksLabel, keepPolling, notePullRequests, noteCreatedPullRequest, openReadDue, pickPullRequest, placeCards, prChip, PR_OPEN_INTERVAL_MS, PR_POLL_LIMIT_MS, SETTLED_SHOWN_MS, type PrView } from "../src/app/prStatus"
import type { PullRequestStatusEntry } from "../src/protocol/schemas"

const NOW = 10_000_000_000

function pr(fields: Partial<PullRequestStatusEntry> = {}): PullRequestStatusEntry {
  return { number: 128, url: "https://github.com/example-org/web/pull/128", title: "Faster search", state: "open", draft: false, ...fields }
}

function checks(passed: number, failed: number, pending: number, skipped = 0): PullRequestStatusEntry["checks"] {
  return { passed, failed, pending, skipped, items: [] }
}

function view(pulls: readonly PullRequestStatusEntry[], fields: Partial<PrView> = {}): PrView {
  return { state: "ready", pullRequests: pulls, branch: "feat/x", readAt: NOW, failures: 0, ...fields }
}

const chip = (pulls: readonly PullRequestStatusEntry[], fields: { readonly published?: boolean; readonly branch?: string; readonly offered?: boolean; readonly view?: Partial<PrView> } = {}) =>
  prChip({ view: view(pulls, fields.view), branch: fields.branch ?? "feat/x", published: fields.published ?? true, offered: fields.offered ?? true, now: NOW })

describe("the pull request chip", () => {
  test("each state of the chip", () => {
    expect(chip([pr({ checks: checks(5, 0, 0) })])).toMatchObject({ kind: "pr", label: "#128 · Open", tone: "green", checks: { text: "✓ 5/5", tone: "green" }, notes: [] })
    expect(chip([pr({ checks: checks(3, 0, 2) })])).toMatchObject({ tone: "amber", checks: { text: "◌ 3/5" } })
    expect(chip([pr({ checks: checks(4, 1, 0) })])).toMatchObject({ tone: "red", checks: { text: "✕ 1 failing" } })
    expect(chip([pr({ draft: true, checks: checks(5, 0, 0) })])).toMatchObject({ label: "#128 · Draft", tone: "gray" })
    expect(chip([pr({ review: "changes-requested" })])).toMatchObject({ notes: [{ text: "Changes requested", tone: "red" }] })
    expect(chip([pr({ review: "approved" })])).toMatchObject({ notes: [{ text: "Approved", tone: "green" }] })
    expect(chip([pr({ mergeable: "conflicts" })])).toMatchObject({ notes: [{ text: "Conflicts", tone: "red" }] })
    expect(chip([pr({ state: "merged", mergedAt: NOW - 3_600_000 })])).toMatchObject({ label: "#128 · Merged", tone: "purple" })
    expect(chip([pr({ state: "closed", closedAt: NOW - 3_600_000 })])).toMatchObject({ label: "#128 · Closed", tone: "gray" })
    expect(chip([])).toEqual({ kind: "create" })
    expect(chip([], { offered: false })).toBeUndefined()
    expect(chip([], { view: { state: "not-connected" } })).toEqual({ kind: "connect" })
  })

  test("a settled PR is shown for a day; Create PR needs a pushed branch that is not the trunk", () => {
    expect(chip([pr({ state: "merged", mergedAt: NOW - SETTLED_SHOWN_MS })])).toEqual({ kind: "create" })
    expect(chip([], { published: false })).toBeUndefined()
    expect(chip([], { branch: "main", view: { branch: "main" } })).toBeUndefined()
    expect(chip([pr()], { branch: "other" })).toBeUndefined()
    expect(chip([], { view: { state: "unavailable" } })).toBeUndefined()
    expect(chip([], { view: { state: "loading" } })).toBeUndefined()
  })

  test("the open PR wins, else the newest that settled", () => {
    const open = pr({ number: 3 })
    const merged = pr({ number: 2, state: "merged", mergedAt: NOW - 1_000 })
    const closed = pr({ number: 1, state: "closed", closedAt: NOW - 500 })
    expect(pickPullRequest([merged, open, closed], NOW)?.number).toBe(3)
    expect(pickPullRequest([merged, closed], NOW)?.number).toBe(1)
  })

  test("checks count skipped as done and say nothing when there are none", () => {
    expect(checksLabel(checks(3, 0, 0, 2))).toEqual({ text: "✓ 5/5", tone: "green" })
    expect(checksLabel(checks(0, 0, 0))).toBeUndefined()
    expect(checksLabel(undefined)).toBeUndefined()
  })
})

describe("when PR status is read again", () => {
  const running = [pr({ checks: checks(1, 0, 2) })]

  test("the minute timer runs only while a check is pending and the thread is on screen, for 30 minutes, and stops after three failures", () => {
    const polling = view(running, { pollFrom: NOW - 1_000 })
    expect(keepPolling({ view: polling, onScreen: true, now: NOW })).toBe(true)
    expect(keepPolling({ view: polling, onScreen: false, now: NOW })).toBe(false)
    expect(keepPolling({ view: view([pr({ checks: checks(3, 0, 0) })], { pollFrom: NOW }), onScreen: true, now: NOW })).toBe(false)
    expect(keepPolling({ view: view(running, { pollFrom: NOW - PR_POLL_LIMIT_MS }), onScreen: true, now: NOW })).toBe(false)
    expect(keepPolling({ view: { ...polling, failures: 3 }, onScreen: true, now: NOW })).toBe(false)
    expect(keepPolling({ view: view(running), onScreen: true, now: NOW })).toBe(false)
  })

  test("opening a thread reads at most once per five minutes per branch", () => {
    expect(openReadDue(undefined, "feat/x", NOW)).toBe(true)
    expect(openReadDue(view([], { readAt: NOW - 1_000 }), "feat/x", NOW)).toBe(false)
    expect(openReadDue(view([], { readAt: NOW - PR_OPEN_INTERVAL_MS }), "feat/x", NOW)).toBe(true)
    expect(openReadDue(view([], { readAt: NOW - 1_000 }), "feat/y", NOW)).toBe(true)
  })
})

describe("PR cards in the thread", () => {
  test("the first read keeps existing PRs without a card; a PR seen later gets one after its turn", () => {
    const baseline = notePullRequests(undefined, [pr({ number: 7 })], NOW, "turn-1")
    expect(baseline).toEqual([{ number: 7, url: "https://github.com/example-org/web/pull/128", at: NOW, card: false }])
    const none = notePullRequests(undefined, [], NOW, "turn-1")
    expect(none).toEqual([])
    const later = notePullRequests(baseline, [pr({ number: 7 }), pr({ number: 9, url: undefined })], NOW + 1, "turn-2")
    expect(later?.[1]).toEqual({ number: 9, turnId: "turn-2", at: NOW + 1, card: true })
    expect(notePullRequests(later, [pr({ number: 9 })], NOW + 2, "turn-3")).toBe(later)
  })

  test("a PR made from the Review pane gets a card after the turn it was made in, and the list keeps twenty", () => {
    const made = noteCreatedPullRequest([{ number: 4, at: 1, card: false }], { number: 4, url: "https://github.com/a/b/pull/4" }, NOW, "turn-5")
    expect(made).toEqual([{ number: 4, url: "https://github.com/a/b/pull/4", turnId: "turn-5", at: NOW, card: true }])
    const many = Array.from({ length: 25 }, (_, index): ThreadPullRequest => ({ number: index + 1, at: index, card: true }))
    expect(noteCreatedPullRequest(many, { number: 99 }, NOW, undefined)).toHaveLength(20)
  })

  test("a card sits after its turn's end, or by time when that turn is not loaded, and before the working line", () => {
    const rows = [{ at: 10 }, { turnEnd: "t1", at: 20 }, { at: 30 }, { turnEnd: "t2", at: 40 }, { footer: true }]
    const card = (fields: Partial<ThreadPullRequest>): ThreadPullRequest => ({ number: 1, at: 0, card: true, ...fields })
    expect(placeCards(rows, [card({ turnId: "t1" })])).toEqual([{ before: 2, number: 1 }])
    expect(placeCards(rows, [card({ turnId: "gone", at: 25 })])).toEqual([{ before: 2, number: 1 }])
    expect(placeCards(rows, [card({ turnId: "gone", at: 99 })])).toEqual([{ before: 4, number: 1 }])
    expect(placeCards(rows, [card({ card: false, turnId: "t1" })])).toEqual([])
  })

  test("saved PR records keep good entries, drop damaged ones, and at most twenty", () => {
    const load = (pullRequests: unknown) =>
      parseState({ version: 1, projects: [{ id: "p1", path: "/a", name: "a", git: true, addedAt: 1 }], threads: [{ id: "t1", projectId: "p1", title: "T", titled: true, createdAt: 1, updatedAt: 1, backend: "native", mode: "agent", permission: "ask", pullRequests }], prefs: {}, layout: {} }).threads[0]
    expect(load([{ number: 3, at: 1, card: true, turnId: "t" }, { number: -1, at: 1, card: true }, { number: 4, url: "javascript:x", at: 1, card: false }, "junk"])?.pullRequests).toEqual([{ number: 3, at: 1, card: true, turnId: "t" }])
    expect(load(Array.from({ length: 30 }, (_, index) => ({ number: index + 1, at: index, card: true })))?.pullRequests).toHaveLength(20)
    expect(load("nonsense")).toMatchObject({ id: "t1" })
    expect(load("nonsense")?.pullRequests).toBeUndefined()
  })
})
