import { useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { threadStatus } from "../app/engines"
import type { Project, ThreadMeta, ThreadStatus } from "../app/persist"
import { emptyRuntime, useApp, type GitView, type ThreadRuntime } from "../app/store"
import type { Host } from "../host/types"

const EMPTY_RUNTIME = emptyRuntime()
const EMPTY_GIT: GitView = { loading: false }

export function useRuntime(threadId: string | undefined): ThreadRuntime {
  return useApp((state) => (threadId === undefined ? EMPTY_RUNTIME : (state.runtime[threadId] ?? EMPTY_RUNTIME)))
}

export function useThread(threadId: string | undefined): ThreadMeta | undefined {
  return useApp((state) => (threadId === undefined ? undefined : state.threads.find((thread) => thread.id === threadId)))
}

export function useProject(projectId: string | undefined): Project | undefined {
  return useApp((state) => (projectId === undefined ? undefined : state.projects.find((project) => project.id === projectId)))
}

export function useGit(threadId: string | undefined): GitView {
  return useApp((state) => (threadId === undefined ? EMPTY_GIT : (state.git[threadId] ?? EMPTY_GIT)))
}

/** Live status per thread; re-renders only when some status changes. */
export function useStatuses(): Readonly<Record<string, ThreadStatus>> {
  return useApp(
    useShallow((state) => {
      const out: Record<string, ThreadStatus> = {}
      for (const thread of state.threads) out[thread.id] = threadStatus(thread, state.runtime[thread.id])
      return out
    }),
  )
}

export function useActiveIds(): { readonly threadId?: string; readonly projectId?: string } {
  return useApp(
    useShallow((state) => {
      const thread = state.threads.find((item) => item.id === state.layout.activeThreadId)
      const projectId = thread?.projectId ?? state.layout.activeProjectId ?? state.projects[0]?.id
      return { ...(thread === undefined ? {} : { threadId: thread.id }), ...(projectId === undefined ? {} : { projectId }) }
    }),
  )
}

/** Debounced value for filters over large lists. */
export function useDebounced<T>(value: T, delay = 120): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return current
}

/** The system's reduced motion, or Settings' when it always reduces. */
export function usePrefersReducedMotion(): boolean {
  const always = useApp((state) => state.prefs.motion === "reduce")
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const change = (): void => setReduced(query.matches)
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])
  return always || reduced
}

/**
 * Hides a browser preview when the view showing it goes; the page stays loaded. The hide waits a
 * microtask because React's development double mount runs this cleanup and then mounts the view again.
 */
export function useHidePreviewWhenGone(host: Host, tab: string): void {
  const showing = useRef<string | undefined>(undefined)
  useEffect(() => {
    showing.current = tab
    return () => {
      showing.current = undefined
      queueMicrotask(() => {
        if (showing.current !== tab) void host.previewBounds(tab, null).catch(() => undefined)
      })
    }
  }, [host, tab])
}
