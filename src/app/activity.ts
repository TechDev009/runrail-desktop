import { create } from "zustand"

/**
 * When each thread's engine last sent anything, for telling a turn that has gone quiet. Kept out of
 * the app store and stamped at most once a second, so a busy stream does not re-render the window.
 */

const STAMP_MS = 1_000

export const useActivity = create<Readonly<Record<string, number>>>()(() => ({}))

export function noteActivity(threadId: string, at = Date.now()): void {
  const last = useActivity.getState()[threadId]
  if (last !== undefined && at - last < STAMP_MS) return
  useActivity.setState({ [threadId]: at })
}

export function lastActivity(threadId: string): number | undefined {
  return useActivity.getState()[threadId]
}

export function forgetActivity(threadId: string): void {
  if (useActivity.getState()[threadId] === undefined) return
  useActivity.setState((state) => {
    const next = { ...state }
    delete next[threadId]
    return next
  }, true)
}
