/**
 * Split view: the main area shows one to four threads side by side. The
 * focused pane is the layout's active thread; it drives the side panel, the window title and the
 * shortcuts. Opening a thread from the list shows it in the focused pane, unless it already has a
 * pane of its own.
 */

export const MAX_PANES = 4

/** One thread, or none, is no split. */
function asPanes(ids: readonly string[]): readonly string[] | undefined {
  return ids.length > 1 ? ids : undefined
}

/** The threads on screen, in order: the saved panes still open, always with the focused one. */
export function shownPanes(panes: readonly string[] | undefined, active: string | undefined, exists: (id: string) => boolean): readonly string[] {
  const kept = [...new Set(panes ?? [])].filter(exists).slice(0, MAX_PANES)
  if (active === undefined || !exists(active)) return kept.length > 1 ? kept : []
  if (kept.includes(active)) return kept
  return kept.length === 0 ? [active] : [...kept.slice(0, MAX_PANES - 1), active]
}

/** Shows `id` where the focused pane is, or focuses its own pane when it has one. */
export function showInPane(panes: readonly string[] | undefined, active: string | undefined, id: string): readonly string[] | undefined {
  if (panes === undefined || panes.includes(id)) return panes
  const at = active === undefined ? -1 : panes.indexOf(active)
  return asPanes(at < 0 ? [...panes.slice(0, MAX_PANES - 1), id] : panes.map((pane, index) => (index === at ? id : pane)))
}

/**
 * Opens `id` in a pane of its own beside the focused one. With every pane taken, it takes the
 * place of the last pane that is not focused.
 */
export function openBeside(panes: readonly string[] | undefined, active: string | undefined, id: string): readonly string[] | undefined {
  const current = panes ?? (active === undefined ? [] : [active])
  if (current.includes(id)) return asPanes(current)
  if (current.length < MAX_PANES) {
    const at = active === undefined ? -1 : current.indexOf(active)
    return asPanes(at < 0 ? [...current, id] : [...current.slice(0, at + 1), id, ...current.slice(at + 1)])
  }
  let replace = current.length - 1
  while (replace > 0 && current[replace] === active) replace -= 1
  return asPanes(current.map((pane, index) => (index === replace ? id : pane)))
}

/** Closes the pane of `id`; the focus moves to its neighbour when it was the focused one. */
export function closePane(panes: readonly string[] | undefined, active: string | undefined, id: string): { readonly panes: readonly string[] | undefined; readonly active: string | undefined } {
  if (panes === undefined || !panes.includes(id)) return { panes, active }
  const at = panes.indexOf(id)
  const rest = panes.filter((pane) => pane !== id)
  return { panes: asPanes(rest), active: active === id ? (rest[Math.min(at, rest.length - 1)] ?? undefined) : active }
}
