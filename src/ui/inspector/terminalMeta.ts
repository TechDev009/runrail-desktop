import { create } from "zustand"
import { panelOf } from "../../app/panels"

/** What each terminal tab shows in the tab strip, kept apart from the emulator so the strip loads without it. */

export type TermStatus = "starting" | "running" | "closed" | "failed"

export interface TermMeta {
  readonly status: TermStatus
  readonly title?: string
  readonly error?: string
}

export const useTermMeta = create<Readonly<Record<string, TermMeta>>>()(() => ({}))

export function patchTermMeta(id: string, patch: Partial<TermMeta>): void {
  useTermMeta.setState((state) => ({ [id]: { ...(state[id] ?? { status: "starting" }), ...patch } }))
}

export function dropTermMeta(id: string): void {
  useTermMeta.setState((state) => {
    const { [id]: _gone, ...rest } = state
    return rest
  }, true)
}

/** How many of a thread's terminal tabs run a shell now: archiving the thread ends them. */
export function runningTerminalCount(threadId: string): number {
  const meta = useTermMeta.getState()
  return panelOf(threadId).tabs.filter((tab) => tab.kind === "terminal" && meta[tab.id]?.status === "running").length
}
