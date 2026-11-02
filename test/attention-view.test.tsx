import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MAX_WATCH_FAILURES } from "../src/app/ciFix"
import { selectAttentionItems, type AttentionViewInput, type AttentionViewItem } from "../src/app/attentionView"
import type { ThreadMeta, ThreadPullRequest } from "../src/app/persist"
import type { GitView, ThreadRuntime } from "../src/app/store"
import type { PullRequestStatusEntry, WorkflowRun } from "../src/protocol/schemas"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline } from "../src/thread/reducer"
import { emptyRuntime } from "../src/app/store"
import { AttentionBoard } from "../src/ui/office/AttentionBoard"

let seq = 0
function event(type: string, fields: Record<string, unknown>, at: number): StreamFrame {
  return { kind: "event", data: { version: 1, sessionId: "s", seq: seq++, at, type, ...fields } }
}

function asking(at: number, approvalId = "approval-1") {
  return applyFrames(emptyTimeline(), [
    event("turn.started", { turnId: "turn-1", prompt: "go" }, at - 2),
    event("tool.started", { turnId: "turn-1", callId: "call-1", name: "run_command", presentation: { kind: "shell", title: "bun test", command: "bun test" } }, at - 1),
    event("approval.required", { turnId: "turn-1", approvalId, action: "bun test", capability: "shell", reason: "Commands need approval" }, at),
  ])
}

function thread(id: string, patch: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, projectId: "project-1", title: `Thread ${id}`, titled: true, createdAt: 0, updatedAt: 100, backend: "native", mode: "agent", permission: "ask", ...patch }
}

function runtime(timeline = emptyTimeline()): ThreadRuntime {
  return { ...emptyRuntime(), timeline }
}

function pull(number: number, patch: Partial<PullRequestStatusEntry> = {}): PullRequestStatusEntry {
  return { number, state: "open", ...patch }
}

function gitView(pullRequests: readonly PullRequestStatusEntry[], state: "ready" | "loading" | "error" = "ready"): GitView {
  return { loading: state === "loading", pr: { state, pullRequests, failures: 0, readAt: 50 } }
}

function prRecord(number: number, url = `https://github.com/acme/app/pull/${String(number)}`): ThreadPullRequest {
  return { number, url, at: 1, card: false }
}

function workflow(runId: string, patch: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId,
    workflowId: "workflow-1",
    workflowName: "Nightly checks",
    trigger: "manual",
    state: "waiting",
    startedAt: 60,
    steps: [],
    waiting: { kind: "approve", stepId: "approval-step", title: "Review the result" },
    notices: [],
    ...patch,
  }
}

function input(patch: Partial<AttentionViewInput> = {}): AttentionViewInput {
  return { threads: [], runtime: {}, git: {}, workflows: {}, ...patch }
}

function keys(items: readonly AttentionViewItem[]): readonly string[] {
  return items.map((item) => item.key)
}

describe("Office attention view selector", () => {
  test("derives thread approvals, paused watches, requested PR changes, and waiting workflows", () => {
    const owner = thread("owner", {
      ciWatch: { number: 12, heads: [], rounds: 1, failures: MAX_WATCH_FAILURES, lastCheckedAt: 30 },
      pullRequests: [prRecord(12), prRecord(13)],
    })
    const items = selectAttentionItems(input({
      threads: [owner],
      runtime: { owner: runtime(asking(10)) },
      git: { owner: gitView([pull(12), pull(13, { title: "Update docs", review: "changes-requested", updatedAt: 20 })]) },
      workflows: { run: { projectId: "project-2", run: workflow("run-1", { pr: { number: 13, url: "https://github.com/acme/app/pull/13" } }) } },
    }))

    expect(items.map((item) => item.kind)).toEqual(["approval", "ci-watch", "review", "workflow"])
    expect(items.map((item) => item.nextAction)).toEqual([
      "Review approval for bun test.",
      "Check the paused CI watch for #12 and resume or stop it.",
      "Address requested changes on #13 in Thread owner.",
      "Approve “Review the result” in this workflow.",
    ])
    expect(items.every((item) => item.destination.kind === "thread" && item.destination.threadId === "owner" || item.destination.kind === "workflow" && item.destination.runId === "run-1")).toBe(true)
    expect(items[1]?.prUrl).toBe("https://github.com/acme/app/pull/12")
    expect(items[2]?.prUrl).toBe("https://github.com/acme/app/pull/13")
    expect(items[3]?.prUrl).toBe("https://github.com/acme/app/pull/13")
    expect(new Set(keys(items)).size).toBe(items.length)
  })

  test("uses the watch failure threshold and maps review state only through saved owning-thread PRs", () => {
    const owner = thread("owner", { ciWatch: { number: 21, heads: [], rounds: 0, failures: MAX_WATCH_FAILURES - 1 }, pullRequests: [prRecord(21), prRecord(22), prRecord(23)] })
    const items = selectAttentionItems(input({
      threads: [owner],
      git: { owner: gitView([
        pull(21),
        pull(22, { review: "changes-requested" }),
        pull(23, { state: "closed", review: "changes-requested" }),
        pull(24, { review: "changes-requested" }),
      ]) },
    }))
    expect(items.map((item) => item.key)).toEqual(["review:owner:22"])

    const reached = selectAttentionItems(input({
      threads: [{ ...owner, ciWatch: { ...owner.ciWatch!, failures: MAX_WATCH_FAILURES } }],
      git: { owner: gitView([pull(21), pull(22, { review: "changes-requested" }), pull(23, { state: "closed", review: "changes-requested" })], "error") },
    }))
    expect(reached.map((item) => item.kind)).toEqual(["ci-watch"])
  })

  test("deduplicates repeated source records and orders output deterministically", () => {
    const duplicate = thread("same", { pullRequests: [prRecord(31), prRecord(31)] })
    const sameApproval = runtime(asking(10))
    const workflows = {
      z: { projectId: "project-2", run: workflow("run-z", { startedAt: 10 }) },
      duplicate: { projectId: "project-2", run: workflow("run-z", { startedAt: 10 }) },
      a: { projectId: "project-1", run: workflow("run-a", { startedAt: 10 }) },
    }
    const source = input({
      threads: [duplicate, duplicate],
      runtime: { same: sameApproval },
      git: { same: gitView([pull(31, { review: "changes-requested" })]) },
      workflows,
    })
    const first = selectAttentionItems(source)
    const reversed = selectAttentionItems({ ...source, threads: [...source.threads].reverse(), workflows: Object.fromEntries(Object.entries(workflows).reverse()) })
    expect(keys(first)).toEqual(["approval:same:approval-1", "review:same:31", "workflow:project-1:run-a:approval-step", "workflow:project-2:run-z:approval-step"])
    expect(keys(reversed)).toEqual(keys(first))
    expect(new Set(keys(first)).size).toBe(first.length)
  })

  test("drops items as source state resolves and excludes archived or merely working threads", () => {
    const active = thread("active", { ciWatch: { number: 44, heads: [], rounds: 0, failures: MAX_WATCH_FAILURES }, pullRequests: [prRecord(45)] })
    const waiting = workflow("run", {})
    const before = input({
      threads: [active, thread("archived", { archived: true, ciWatch: { number: 99, heads: [], rounds: 0, failures: MAX_WATCH_FAILURES } })],
      runtime: { active: runtime(asking(10)), working: runtime() },
      git: { active: gitView([pull(45, { review: "changes-requested" })]) },
      workflows: { run: { projectId: "project-1", run: waiting } },
    })
    expect(selectAttentionItems(before)).toHaveLength(4)

    const after = selectAttentionItems({
      ...before,
      threads: [{ ...active, ciWatch: { ...active.ciWatch!, failures: 0 } }, thread("working")],
      runtime: { active: runtime(), working: runtime() },
      git: { active: gitView([pull(45, { review: "approved" })]) },
      workflows: { run: { projectId: "project-1", run: workflow("run", { state: "running", waiting: undefined }) } },
    })
    expect(after).toEqual([])
  })

  test("the board shows next actions and an optional PR link", () => {
    const item: AttentionViewItem = {
      key: "review:t:5",
      kind: "review",
      title: "Update the docs",
      nextAction: "Address requested changes on #5 in Docs thread.",
      destination: { kind: "thread", threadId: "t" },
      since: 1,
      prUrl: "https://github.com/acme/app/pull/5",
    }
    const html = renderToStaticMarkup(<AttentionBoard items={[item]} onOpen={() => undefined} />)
    expect(html).toContain("Address requested changes on #5 in Docs thread.")
    expect(html).toContain('class="office-attention-pr"')
    expect(html).toContain('aria-label="Open pull request"')
    expect(html).toContain("Changes requested")
  })
})
