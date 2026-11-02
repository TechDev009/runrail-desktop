import { expect, test } from "bun:test"
import type { ThreadMeta } from "../src/app/persist"
import type { GitView } from "../src/app/store"
import { watchedThreadsForRelayEvents } from "../src/app/ciRelay"
import { GithubRelayEventSchema, type GithubRelayEvent } from "../src/protocol/schemas"

function thread(id: string, number: number, archived = false): ThreadMeta {
  return {
    id,
    projectId: "p1",
    title: id,
    titled: true,
    createdAt: 1,
    updatedAt: 1,
    backend: "native",
    mode: "agent",
    permission: "ask",
    ...(archived ? { archived: true } : {}),
    ciWatch: { number, heads: [], rounds: 0 },
  }
}

function relayEvent(patch: Partial<GithubRelayEvent> = {}): GithubRelayEvent {
  return {
    deliveryId: "123e4567-e89b-12d3-a456-426614174000",
    event: "check_run.completed",
    repository: "acme/api",
    prNumber: 12,
    headSha: "a".repeat(40),
    runId: 42,
    attempt: 1,
    conclusion: "failure",
    occurredAt: "2026-11-01T12:00:00.000Z",
    ...patch,
  }
}

function git(owner: string, repo: string): GitView {
  return {
    loading: false,
    pr: { state: "ready", pullRequests: [], owner, repo, branch: "feature", readAt: 1, failures: 0 },
  }
}

test("relay metadata is bounded and valid before it can trigger a local refresh", () => {
  expect(GithubRelayEventSchema.safeParse(relayEvent()).success).toBe(true)
  expect(GithubRelayEventSchema.safeParse(relayEvent({ repository: "https://evil.example/acme/api" })).success).toBe(false)
  expect(GithubRelayEventSchema.safeParse(relayEvent({ headSha: "not-a-sha" })).success).toBe(false)
  expect(GithubRelayEventSchema.safeParse(relayEvent({ occurredAt: "not-a-time" })).success).toBe(false)
})

test("only an active watch for the exact repository and PR is refreshed, case-insensitively", () => {
  const events = [relayEvent()]
  const threads = [thread("match", 12), thread("other-pr", 13), thread("archived", 12, true), thread("no-repo", 12)]
  const gitViews = { match: git("Acme", "API"), "other-pr": git("acme", "api"), archived: git("acme", "api") }
  expect(watchedThreadsForRelayEvents(events, threads, gitViews)).toEqual(["match"])
})

test("a PR close event wakes a matching watch so local GitHub status clears it", () => {
  const closed = relayEvent({ event: "pull_request.closed", conclusion: undefined, runId: undefined, attempt: undefined })
  expect(watchedThreadsForRelayEvents([closed], [thread("closed-watch", 12)], { "closed-watch": git("acme", "api") })).toEqual(["closed-watch"])
})
