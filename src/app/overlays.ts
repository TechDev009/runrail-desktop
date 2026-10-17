import { get, setLayout } from "./store"

/** Below these widths the sidebar, then the inspector, open over the thread instead of beside it. */
export const NARROW = "(max-width: 860px)"
export const MEDIUM = "(max-width: 1180px)"

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
}

/**
 * Closes the inspector or the sidebar when it covers the thread, so Escape in the composer closes
 * what is on top before it would stop a turn. True when something was closed.
 */
export function closeCoveringPanel(): boolean {
  const { layout, view } = get()
  if (layout.inspectorOpen && view.kind === "thread" && matches(MEDIUM)) {
    setLayout({ inspectorOpen: false })
    return true
  }
  if (layout.sidebarOpen && matches(NARROW)) {
    setLayout({ sidebarOpen: false })
    return true
  }
  return false
}
