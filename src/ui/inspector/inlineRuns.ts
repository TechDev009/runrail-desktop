import { create } from "zustand"

/** In-memory ownership for terminals launched from assistant code blocks. */
export interface InlineRun {
  readonly threadId: string
  readonly terminalId: string
}

export const useInlineRuns = create<Readonly<Record<string, InlineRun>>>()(() => ({}))

export function rememberInlineRun(key: string, run: InlineRun): void {
  useInlineRuns.setState((state) => ({ ...state, [key]: run }))
}

export function forgetInlineRun(key: string): void {
  useInlineRuns.setState((state) => {
    if (state[key] === undefined) return state
    const { [key]: _closed, ...rest } = state
    return rest
  }, true)
}

export function forgetInlineRunsForThread(threadId: string): void {
  useInlineRuns.setState((state) => {
    const next = Object.fromEntries(Object.entries(state).filter(([, run]) => run.threadId !== threadId))
    return Object.keys(next).length === Object.keys(state).length ? state : next
  }, true)
}
