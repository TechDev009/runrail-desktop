import { pendingApprovals, isQuestion } from "../thread/reducer"
import type { WorkflowRun } from "../protocol/schemas"
import { MAX_WATCH_FAILURES } from "./ciFix"
import type { ThreadMeta } from "./persist"
import type { GitView, ThreadRuntime } from "./store"

/** Derived, in-memory blockers presented by Office; nothing here is persisted. */
export type AttentionViewKind = "approval" | "ci-watch" | "review" | "workflow"

export type AttentionDestination =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "workflow"; readonly projectId: string; readonly workflowId: string; readonly runId: string }

export interface AttentionViewItem {
  /** Stable for as long as this source approval, watch, review, or workflow step exists. */
  readonly key: string
  readonly kind: AttentionViewKind
  readonly title: string
  readonly nextAction: string
  readonly destination: AttentionDestination
  readonly since: number
  readonly prUrl?: string
}

export interface AttentionViewInput {
  readonly threads: readonly ThreadMeta[]
  readonly runtime: Readonly<Record<string, ThreadRuntime>>
  readonly git: Readonly<Record<string, GitView>>
  readonly workflows: Readonly<Record<string, { readonly projectId: string; readonly run: WorkflowRun }>>
}

const ORDER: Readonly<Record<AttentionViewKind, number>> = { approval: 0, "ci-watch": 1, review: 2, workflow: 3 }
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const encoded = (value: string): string => encodeURIComponent(value)

function threadTitle(thread: ThreadMeta): string {
  return thread.titled ? thread.title : "New thread"
}

function addUnique(items: Map<string, AttentionViewItem>, item: AttentionViewItem): void {
  const before = items.get(item.key)
  if (before === undefined || compareText(JSON.stringify(item), JSON.stringify(before)) < 0) items.set(item.key, item)
}

function currentPull(view: GitView | undefined, number: number) {
  const matches = view?.pr?.pullRequests.filter((pull) => pull.number === number) ?? []
  return [...matches].sort((left, right) =>
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
    compareText(left.url ?? "", right.url ?? "") ||
    compareText(left.state, right.state) ||
    compareText(left.review ?? "", right.review ?? "") ||
    compareText(left.title ?? "", right.title ?? ""),
  )[0]
}

function prUrl(thread: ThreadMeta, view: GitView | undefined, number: number): string | undefined {
  const current = currentPull(view, number)?.url
  if (current !== undefined) return current
  return thread.pullRequests
    ?.filter((pull) => pull.number === number)
    .map((pull) => pull.url)
    .filter((url): url is string => url !== undefined)
    .sort(compareText)[0]
}

/** Select current person-actionable items from app and workflow state, in stable priority/age order. */
export function selectAttentionItems(input: AttentionViewInput): readonly AttentionViewItem[] {
  const byKey = new Map<string, AttentionViewItem>()

  for (const thread of [...input.threads].sort((left, right) => compareText(left.id, right.id))) {
    if (thread.archived === true) continue
    const title = threadTitle(thread)
    const destination: AttentionDestination = { kind: "thread", threadId: thread.id }
    const timeline = input.runtime[thread.id]?.timeline

    if (timeline !== undefined) {
      for (const approval of pendingApprovals(timeline)) {
        addUnique(byKey, {
          key: `approval:${encoded(thread.id)}:${encoded(approval.approvalId)}`,
          kind: "approval",
          title,
          nextAction: isQuestion(approval) ? "Answer the pending question in this thread." : `Review approval for ${approval.action}.`,
          destination,
          since: approval.at,
        })
      }
    }

    const watch = thread.ciWatch
    if (watch !== undefined && (watch.failures ?? 0) >= MAX_WATCH_FAILURES) {
      const view = input.git[thread.id]
      addUnique(byKey, {
        key: `ci-watch:${encoded(thread.id)}:${String(watch.number)}`,
        kind: "ci-watch",
        title,
        nextAction: `Check the paused CI watch for #${String(watch.number)} and resume or stop it.`,
        destination,
        since: watch.lastCheckedAt ?? thread.updatedAt,
        ...(prUrl(thread, view, watch.number) === undefined ? {} : { prUrl: prUrl(thread, view, watch.number) }),
      })
    }

    const view = input.git[thread.id]
    if (view?.pr?.state === "ready") {
      const records = [...(thread.pullRequests ?? [])].sort((left, right) => left.number - right.number || compareText(left.url ?? "", right.url ?? ""))
      const seen = new Set<number>()
      for (const record of records) {
        if (seen.has(record.number)) continue
        seen.add(record.number)
        const pull = currentPull(view, record.number)
        if (pull?.state !== "open" || pull.review !== "changes-requested") continue
        const url = pull.url ?? record.url ?? prUrl(thread, view, record.number)
        addUnique(byKey, {
          key: `review:${encoded(thread.id)}:${String(record.number)}`,
          kind: "review",
          title: pull.title ?? `Pull request #${String(record.number)}`,
          nextAction: `Address requested changes on #${String(record.number)} in ${title}.`,
          destination,
          since: pull.updatedAt ?? view.pr.readAt ?? thread.updatedAt,
          ...(url === undefined ? {} : { prUrl: url }),
        })
      }
    }
  }

  const runs = Object.values(input.workflows).sort((left, right) =>
    compareText(left.projectId, right.projectId) || compareText(left.run.runId, right.run.runId),
  )
  for (const { projectId, run } of runs) {
    const waiting = run.waiting
    if (run.state !== "waiting" || waiting === undefined) continue
    addUnique(byKey, {
      key: `workflow:${encoded(projectId)}:${encoded(run.runId)}:${encoded(waiting.stepId)}`,
      kind: "workflow",
      title: run.workflowName,
      nextAction: waiting.kind === "slack" ? `Reply in ${waiting.channel} on Slack.` : `Approve “${waiting.title}” in this workflow.`,
      destination: { kind: "workflow", projectId, workflowId: run.workflowId, runId: run.runId },
      since: run.startedAt,
      ...(run.pr?.url === undefined ? {} : { prUrl: run.pr.url }),
    })
  }

  return [...byKey.values()].sort((left, right) => ORDER[left.kind] - ORDER[right.kind] || left.since - right.since || compareText(left.key, right.key))
}
