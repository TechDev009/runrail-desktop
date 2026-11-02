import type { ThreadMeta } from "./persist"
import type { ThreadRuntime } from "./store"
import { pendingApprovals, type ApprovalItem } from "../thread/reducer"

export interface PendingQuestionEntry {
  readonly threadId: string
  readonly threadTitle: string
  readonly item: ApprovalItem
}

/** Stable, app-wide queue for structured questions whose turns are waiting on a person. */
export function pendingQuestionQueue(
  threads: readonly Pick<ThreadMeta, "id" | "title" | "archived">[],
  runtimes: Readonly<Record<string, Pick<ThreadRuntime, "engine" | "timeline"> | undefined>>,
): readonly PendingQuestionEntry[] {
  const pending: PendingQuestionEntry[] = []
  for (const thread of threads) {
    if (thread.archived === true) continue
    const runtime = runtimes[thread.id]
    if (runtime === undefined || runtime.engine === "failed" || runtime.timeline.status !== "waiting") continue
    for (const item of pendingApprovals(runtime.timeline)) {
      if (item.questions !== undefined) pending.push({ threadId: thread.id, threadTitle: thread.title, item })
    }
  }
  return pending.sort((left, right) => left.item.at - right.item.at || left.threadId.localeCompare(right.threadId))
}
