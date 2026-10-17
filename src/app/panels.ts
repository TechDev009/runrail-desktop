import { create } from "zustand"
import { getHost } from "../host"
import { closeTerminal } from "../ui/inspector/terminalRegistry"
import { ARTBOARDS, artboardTab, setArtboards } from "./artboards"
import { dropPreview } from "./previews"
import { newId, PANEL_LIMITS, savedUrl, SINGLE_PANELS, type PanelKind, type PanelState, type PanelTab } from "./persist"
import { get, set } from "./store"

/**
 * A thread's side panel: tabs the person opens and closes, like a browser. Review, Files, and Tasks
 * open once; terminals and browser previews can be several. Closing a tab ends what it shows.
 */

const EMPTY: PanelState = { tabs: [] }

/** Set when something asked for the panel's launcher (⌘T); the panel opens it and clears this. */
export const useLauncherRequest = create<{ readonly pending: boolean }>()(() => ({ pending: false }))

export function panelOf(threadId: string | undefined): PanelState {
  return threadId === undefined ? EMPTY : get().layout.panels[threadId] ?? EMPTY
}

/** The tab on screen: the active one, or the last when none is marked. */
export function activeTab(panel: PanelState): PanelTab | undefined {
  return panel.tabs.find((tab) => tab.id === panel.active) ?? panel.tabs[panel.tabs.length - 1]
}

export function countOf(panel: PanelState, kind: PanelKind): number {
  return panel.tabs.filter((tab) => tab.kind === kind).length
}

/** Whether one more tab of this kind fits. */
export function canAdd(panel: PanelState, kind: PanelKind): boolean {
  if (panel.tabs.length >= PANEL_LIMITS.tabs) return false
  if (SINGLE_PANELS.has(kind)) return countOf(panel, kind) === 0
  return countOf(panel, kind) < (kind === "terminal" ? PANEL_LIMITS.terminal : PANEL_LIMITS.browser)
}

/** Adds a tab after the active one and shows it. */
export function withTab(panel: PanelState, tab: PanelTab): PanelState {
  const at = panel.tabs.findIndex((item) => item.id === panel.active)
  const tabs = at < 0 ? [...panel.tabs, tab] : [...panel.tabs.slice(0, at + 1), tab, ...panel.tabs.slice(at + 1)]
  return { tabs, active: tab.id }
}

/** Removes a tab; when it was on screen, its right neighbour shows, else its left one. */
export function withoutTab(panel: PanelState, id: string): PanelState {
  const at = panel.tabs.findIndex((tab) => tab.id === id)
  if (at < 0) return panel
  const tabs = panel.tabs.filter((tab) => tab.id !== id)
  const shown = activeTab(panel)?.id
  const active = shown !== id ? shown : (tabs[at] ?? tabs[at - 1])?.id
  return active === undefined ? { tabs } : { tabs, active }
}

export function movedTab(panel: PanelState, id: string, to: number): PanelState {
  const from = panel.tabs.findIndex((tab) => tab.id === id)
  if (from < 0) return panel
  const tabs = [...panel.tabs]
  const [tab] = tabs.splice(from, 1)
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab as PanelTab)
  return { ...panel, tabs }
}

/** The tab `delta` places away from the shown one, wrapping around. */
export function cycledTab(panel: PanelState, delta: number): string | undefined {
  if (panel.tabs.length === 0) return undefined
  const at = Math.max(0, panel.tabs.findIndex((tab) => tab.id === activeTab(panel)?.id))
  return panel.tabs[(at + delta + panel.tabs.length) % panel.tabs.length]?.id
}

function write(threadId: string, panel: PanelState, open?: boolean): void {
  set((state) => {
    const { [threadId]: _previous, ...others } = state.layout.panels
    // The thread just touched goes last, so the oldest threads' tabs are the ones let go.
    const kept = Object.entries(others).slice(-(PANEL_LIMITS.threads - 1))
    const panels = Object.fromEntries(panel.tabs.length === 0 ? kept : [...kept, [threadId, panel]])
    return { layout: { ...state.layout, panels, ...(open === undefined ? {} : { inspectorOpen: open }) } }
  })
}

function ended(threadId: string, tab: PanelTab): void {
  if (tab.kind === "terminal") closeTerminal(threadId, tab.id)
  if (tab.kind === "browser") {
    for (const id of [tab.id, ...ARTBOARDS.map((artboard) => artboardTab(tab.id, artboard.id))]) {
      dropPreview(id)
      void getHost().previewClose(id).catch(() => undefined)
    }
    setArtboards(tab.id, false)
  }
}

/**
 * Shows a kind of tab, opening one when there is none. With `toggle`, asking for what is already
 * on screen hides the panel, as the header buttons and shortcuts do.
 */
export function openPanel(threadId: string, kind: PanelKind, options: { readonly toggle?: boolean } = {}): void {
  const panel = panelOf(threadId)
  const shown = activeTab(panel)
  if (options.toggle === true && get().layout.inspectorOpen && shown?.kind === kind) {
    set((state) => ({ layout: { ...state.layout, inspectorOpen: false } }))
    return
  }
  const existing = shown?.kind === kind ? shown : [...panel.tabs].reverse().find((tab) => tab.kind === kind)
  if (existing !== undefined) {
    write(threadId, { ...panel, active: existing.id }, true)
    return
  }
  newPanelTab(threadId, kind)
}

/**
 * Opens a new tab of a kind; undefined when the panel has no room for it. `show: false` leaves the
 * panel as it is, for a tab the agent opens in a thread the person may not be looking at.
 */
export function newPanelTab(threadId: string, kind: PanelKind, url?: string, options: { readonly show?: boolean } = {}): string | undefined {
  const panel = panelOf(threadId)
  const show = options.show !== false
  if (!canAdd(panel, kind)) {
    const existing = [...panel.tabs].reverse().find((tab) => tab.kind === kind)
    if (existing !== undefined && show) write(threadId, { ...panel, active: existing.id }, true)
    return undefined
  }
  const saved = kind === "browser" ? savedUrl(url) : undefined
  const tab: PanelTab = { id: newId(kind === "terminal" ? "term" : "tab"), kind, ...(saved === undefined ? {} : { url: saved }) }
  const shown = activeTab(panel)?.id
  // Unshown, the tab joins the strip and whatever was on screen stays there.
  write(threadId, show || shown === undefined ? withTab(panel, tab) : { ...withTab(panel, tab), active: shown }, show ? true : undefined)
  return tab.id
}

/** Shows the panel with its launcher open, for choosing what the new tab shows. */
export function requestLauncher(threadId: string): void {
  if (!get().threads.some((thread) => thread.id === threadId)) return
  set((state) => ({ layout: { ...state.layout, inspectorOpen: true } }))
  useLauncherRequest.setState({ pending: true })
}

/** `openPanel` for the thread on screen. */
export function openPanelHere(kind: PanelKind, options: { readonly toggle?: boolean } = {}): void {
  const threadId = get().layout.activeThreadId
  if (threadId !== undefined && get().threads.some((thread) => thread.id === threadId)) openPanel(threadId, kind, options)
}

/** The kind of tab a thread's panel shows, when the panel is open. For store selectors. */
export function shownKind(layout: { readonly inspectorOpen: boolean; readonly panels: Readonly<Record<string, PanelState>> }, threadId: string | undefined): PanelKind | undefined {
  if (!layout.inspectorOpen || threadId === undefined) return undefined
  const panel = layout.panels[threadId]
  return panel === undefined ? undefined : activeTab(panel)?.kind
}

export function selectPanelTab(threadId: string, id: string): void {
  const panel = panelOf(threadId)
  if (panel.tabs.some((tab) => tab.id === id)) write(threadId, { ...panel, active: id }, true)
}

/** Closes tabs; the panel hides when the last one goes. */
export function closePanelTabs(threadId: string, ids: readonly string[]): void {
  let panel = panelOf(threadId)
  for (const id of ids) {
    const tab = panel.tabs.find((item) => item.id === id)
    if (tab === undefined) continue
    ended(threadId, tab)
    panel = withoutTab(panel, id)
  }
  write(threadId, panel, panel.tabs.length === 0 ? false : undefined)
}

export function closePanelTab(threadId: string, id: string): void {
  closePanelTabs(threadId, [id])
}

export function closeOtherPanelTabs(threadId: string, id: string): void {
  closePanelTabs(threadId, panelOf(threadId).tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))
}

export function closePanelTabsToRight(threadId: string, id: string): void {
  const tabs = panelOf(threadId).tabs
  closePanelTabs(threadId, tabs.slice(tabs.findIndex((tab) => tab.id === id) + 1).map((tab) => tab.id))
}

export function cyclePanelTab(threadId: string, delta: number): void {
  const next = cycledTab(panelOf(threadId), delta)
  if (next !== undefined) selectPanelTab(threadId, next)
}

export function movePanelTab(threadId: string, id: string, to: number): void {
  write(threadId, movedTab(panelOf(threadId), id, to))
}

/** Keeps where a browser tab is, so it reopens there. */
export function setPanelUrl(threadId: string, id: string, url: string): void {
  const panel = panelOf(threadId)
  const saved = savedUrl(url)
  const tab = panel.tabs.find((item) => item.id === id)
  if (tab === undefined || tab.kind !== "browser" || saved === undefined || tab.url === saved) return
  write(threadId, { ...panel, tabs: panel.tabs.map((item) => (item.id === id ? { ...item, url: saved } : item)) })
}

/** A deleted thread's tabs go, with whatever they were showing. */
export function forgetPanel(threadId: string): void {
  const panel = panelOf(threadId)
  for (const tab of panel.tabs) ended(threadId, tab)
  if (panel.tabs.length > 0) write(threadId, EMPTY)
}
