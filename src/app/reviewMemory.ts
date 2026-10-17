import { create } from "zustand"
import type { Severity } from "./reviewFindings"
import { newId } from "./persist"

/**
 * The Review pane's line comments and "viewed" marks, per thread. They live in memory only. A
 * comment the person wrote has no `from`; one a review left names it and its
 * severity, and goes to the agent the same way.
 */

export interface LineComment {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly side: "old" | "new"
  readonly text: string
  readonly excerpt: string
  readonly from?: string
  readonly severity?: Severity
}

interface ReviewMemory {
  readonly comments: Readonly<Record<string, readonly LineComment[]>>
  readonly viewed: Readonly<Record<string, readonly string[]>>
}

export const useReviewMemory = create<ReviewMemory>()(() => ({ comments: {}, viewed: {} }))

export function addComments(threadId: string, comments: readonly Omit<LineComment, "id">[]): void {
  if (comments.length === 0) return
  useReviewMemory.setState((state) => ({ comments: { ...state.comments, [threadId]: [...(state.comments[threadId] ?? []), ...comments.map((comment) => ({ ...comment, id: newId("c") }))] } }))
}
