import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react"
import { focusComposer, openUrl, pickProject, startNewThread } from "../../app/actions"
import { cancel } from "../../app/engines"
import { closeWindow, installAppMenu, setOfficeInMenu } from "../../app/appMenu"
import { activeTab, closePanelTab, cyclePanelTab, forgetPanel, openPanel, panelOf, requestLauncher, shownKind } from "../../app/panels"
import { listenPreviewShortcuts } from "../../app/previewKeys"
import { listShown, placeOf } from "../../app/rail"
import { readWaiting, REVIEWS_BADGE_MS } from "../../app/reviews"
import { sidebarModel, steppedThread } from "../../app/sidebar"
import { get, openThread, set, setLayout, useApp } from "../../app/store"
import { MEDIUM, NARROW } from "../../app/overlays"
import { setTrayOpen, useTray } from "../../app/triage"
import { menuKey, toggleFullscreen, type MenuKey } from "../../app/windowKeys"
import { getHost } from "../../host"
import { matches } from "../../lib/format"
import { Spinner } from "../common"
import { DialogHost } from "../dialogs/Dialogs"
import { Inspector } from "../inspector/Inspector"
import { closeThreadTerminals } from "../inspector/terminalRegistry"
import { Tray } from "../office/Tray"
import { SplitView, ThreadView } from "../thread/ThreadView"
import { shownPanes } from "../../app/split"
import { useShallow } from "zustand/react/shallow"
import { InboxPanel } from "./Account"
import { Palette } from "./Palette"
import { goTo, Rail } from "./Rail"
import { SHORTCUTS, type ShortcutId } from "./shortcuts"
import { Sidebar, SIDEBAR_SEARCH_ID } from "./Sidebar"
import { Toasts } from "./Toasts"
import { Onboarding } from "../onboarding/Onboarding"

// Secondary surfaces load on first use to keep the first paint small.
const ReviewsView = lazy(() => import("../views/Reviews").then((module) => ({ default: module.ReviewsView })))
const AgentsView = lazy(() => import("../views/Agents").then((module) => ({ default: module.AgentsView })))
const EvalsView = lazy(() => import("../views/Evals").then((module) => ({ default: module.EvalsView })))
const MemoryView = lazy(() => import("../views/Memory").then((module) => ({ default: module.MemoryView })))
const WorkflowsView = lazy(() => import("../views/Workflows").then((module) => ({ default: module.WorkflowsView })))
const CompareView = lazy(() => import("../views/Compare").then((module) => ({ default: module.CompareView })))
const OfficeView = lazy(() => import("../office/Office").then((module) => ({ default: module.OfficeView })))
const ArchivedView = lazy(() => import("../views/Archived").then((module) => ({ default: module.ArchivedView })))
const IntegrationsView = lazy(() => import("../views/Integrations").then((module) => ({ default: module.IntegrationsView })))
const SettingsPage = lazy(() => import("./Settings").then((module) => ({ default: module.SettingsPage })))

/**
 * The window: sidebar, main view, and inspector, plus the overlays (palette, settings, dialogs,
 * toasts). Narrow windows turn the sidebar and inspector into overlays instead of squeezing the
 * conversation.
 */

function useMedia(query: string): boolean {
  const [value, setValue] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (): void => setValue(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [query])
  return value
}

export function App() {
  const loaded = useApp((state) => state.loaded)
  const onboarded = useApp((state) => state.prefs.onboarded)
  const view = useApp((state) => state.view)
  const list = useApp((state) => listShown(state.view, state.layout.sidebarOpen))
  const inspectorOpen = useApp((state) => state.layout.inspectorOpen)
  const activeThreadId = useApp((state) => (state.threads.some((thread) => thread.id === state.layout.activeThreadId) ? state.layout.activeThreadId : undefined))
  const palette = useApp((state) => state.palette)
  const settings = useApp((state) => state.settings)
  const narrow = useMedia(NARROW)
  const medium = useMedia(MEDIUM)
  const inspectorWidth = useApp((state) => state.layout.inspectorWidth)
  const officeDrawer = useApp((state) => state.officeDrawer)
  const threadShown = view.kind === "thread" || (view.kind === "office" && officeDrawer)
  const panes = useApp(useShallow((state) => shownPanes(state.layout.panes, state.layout.activeThreadId, (id) => state.threads.some((thread) => thread.id === id))))
  const previewShown = useApp((state) => (state.view.kind === "thread" || (state.view.kind === "office" && state.officeDrawer)) && shownKind(state.layout, activeThreadId) === "browser")

  useGlobalKeys()
  useMenuShortcuts()
  useWindowTitle()
  useTerminalCleanup()
  useReviewsWaiting(loaded)

  // On narrow windows the sidebar is an overlay: picking a thread closes it.
  useEffect(() => {
    if (narrow && get().layout.sidebarOpen) setLayout({ sidebarOpen: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, activeThreadId])

  // The splash index.html draws covers the window until the saved state is in (main.tsx).
  if (!loaded) return null
  if (!onboarded)
    return (
      <>
        <Onboarding />
        <DialogHost />
        <Toasts />
      </>
    )

  const showInspector = inspectorOpen && activeThreadId !== undefined && threadShown
  const main =
    view.kind === "reviews" ? (
      <ReviewsView />
    ) : view.kind === "agents" ? (
      <AgentsView runId={view.runId} />
    ) : view.kind === "evals" ? (
      <EvalsView runId={view.runId} />
    ) : view.kind === "memory" ? (
      <MemoryView />
    ) : view.kind === "workflows" ? (
      <WorkflowsView projectId={view.projectId} workflowId={view.workflowId} runId={view.runId} />
    ) : view.kind === "integrations" ? (
      <IntegrationsView section={view.section} />
    ) : view.kind === "compare" ? (
      <CompareView groupId={view.groupId} />
    ) : view.kind === "office" ? (
      <OfficeView />
    ) : view.kind === "archived" ? (
      <ArchivedView />
    ) : panes.length > 1 && !narrow ? (
      // Below the narrow width one pane shows: the focused one.
      <SplitView panes={panes} />
    ) : (
      <ThreadView />
    )

  // Settings is a page of its own: it takes the window, with its own rail and a way back.
  if (settings !== false)
    return (
      <div className="app is-settings">
        <Suspense fallback={<ViewLoading />}>
          <SettingsPage />
        </Suspense>
        {palette && <Palette />}
        <DialogHost />
        <Toasts />
      </div>
    )

  return (
    <div
      className={`app${narrow ? " is-narrow" : ""}${medium ? " is-medium" : ""}${!list || narrow ? " has-rail" : ""}${showInspector && previewShown ? " has-preview" : ""}`}
      style={{ "--panel-w": `${String(inspectorWidth)}px` } as CSSProperties}
    >
      <Rail />
      {list && (
        <>
          {narrow && <div className="scrim" aria-hidden onClick={() => setLayout({ sidebarOpen: false })} />}
          <Sidebar />
        </>
      )}
      <div className="main">
        <Suspense fallback={<ViewLoading />}>{main}</Suspense>
      </div>
      {showInspector && (
        <>
          {medium && <div className="scrim is-inspector" aria-hidden onClick={() => setLayout({ inspectorOpen: false })} />}
          <Inspector threadId={activeThreadId} />
        </>
      )}
      {palette && <Palette />}

      <InboxPanel />
      <Tray />
      <DialogHost />
      <Toasts />
    </div>
  )
}

/** Holds the view area while a lazily loaded surface arrives. */
function ViewLoading() {
  return (
    <div className="pane-loading" role="status">
      <Spinner size={12} /> Loading…
    </div>
  )
}

function useWindowTitle(): void {
  const title = useApp((state) => {
    if (state.view.kind === "reviews") return "Reviews"
    if (state.view.kind === "agents") return "Agents"
    if (state.view.kind === "workflows") return "Workflows"
    if (state.view.kind === "evals") return "Evals"
    if (state.view.kind === "memory") return "Memory"
    if (state.view.kind === "integrations") return "Integrations"
    if (state.view.kind === "archived") return "Archived threads"
    if (state.view.kind === "office" && !state.officeDrawer) return "Office"
    if (state.view.kind === "compare") {
      const groupId = state.view.groupId
      return state.threads.find((thread) => thread.group?.id === groupId)?.group?.label ?? "Compare"
    }
    const thread = state.threads.find((item) => item.id === state.layout.activeThreadId)
    if (thread !== undefined) return thread.titled ? thread.title : "New thread"
    return state.projects.find((project) => project.id === state.layout.activeProjectId)?.name
  })
  useEffect(() => {
    const bounded = title === undefined ? undefined : title.length > 80 ? `${title.slice(0, 79)}…` : title
    document.title = bounded === undefined ? "Runrail" : `${bounded} - Runrail`
  }, [title])
}

/** The rail's count on Reviews: one small search now and then while the app is open. */
function useReviewsWaiting(loaded: boolean): void {
  useEffect(() => {
    if (!loaded) return
    void readWaiting()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void readWaiting()
    }, REVIEWS_BADGE_MS)
    return () => clearInterval(timer)
  }, [loaded])
}

/** Terminals and previews belong to threads: archiving ends the terminals, deleting closes every tab. */
function useTerminalCleanup(): void {
  useEffect(
    () =>
      useApp.subscribe((state, previous) => {
        if (state.threads === previous.threads) return
        const live = new Map(state.threads.map((thread) => [thread.id, thread]))
        for (const thread of previous.threads) {
          const next = live.get(thread.id)
          if (next === undefined) forgetPanel(thread.id)
          if (next === undefined || (next.archived === true && thread.archived !== true)) closeThreadTerminals(thread.id)
        }
      }),
    [],
  )
}

/** Previous and next walk the threads in the order the sidebar shows them. */
function orderedThreads(): readonly string[] {
  const state = get()
  return sidebarModel({ projects: state.projects, threads: state.threads, view: state.layout.sidebarView, collapsed: state.layout.collapsedProjects, now: Date.now() }).order
}

function run(id: ShortcutId): void {
  const state = get()
  const threadId = state.threads.some((thread) => thread.id === state.layout.activeThreadId) ? state.layout.activeThreadId : undefined
  switch (id) {
    case "palette":
      set({ palette: !state.palette })
      return
    case "new-thread":
      startNewThread()
      return
    case "open-project":
      void pickProject()
      return
    case "settings":
      set({ settings: state.settings === false ? "general" : false })
      return
    case "shortcuts":
      set({ settings: "shortcuts" })
      return
    case "sidebar":
      if (placeOf(state.view) !== "threads") {
        goTo("threads")
        setLayout({ sidebarOpen: true })
      } else setLayout({ sidebarOpen: !state.layout.sidebarOpen })
      return
    case "search":
      if (placeOf(state.view) !== "threads") goTo("threads")
      setLayout({ sidebarOpen: true })
      requestAnimationFrame(() => document.getElementById(SIDEBAR_SEARCH_ID)?.focus())
      return
    case "inspector":
      if (threadId !== undefined) setLayout({ inspectorOpen: !state.layout.inspectorOpen })
      return
    case "review":
    case "files":
    case "terminal":
    case "tasks":
    case "browser":
      if (threadId === undefined) return
      showThreadSurface()
      openPanel(threadId, id, { toggle: true })
      return
    case "new-tab":
      if (threadId === undefined) return
      showThreadSurface()
      requestLauncher(threadId)
      return
    case "close-tab": {
      const shown = threadId === undefined || !state.layout.inspectorOpen ? undefined : activeTab(panelOf(threadId))
      // A browser preview holding the keyboard leaves this page without focus.
      if (threadId !== undefined && shown !== undefined && (focusInPanel() || !document.hasFocus())) closePanelTab(threadId, shown.id)
      else void closeWindow()
      return
    }
    case "next-tab":
    case "prev-tab":
      if (threadId !== undefined && state.layout.inspectorOpen) cyclePanelTab(threadId, id === "next-tab" ? 1 : -1)
      return
    case "prev-thread":
    case "next-thread": {
      const next = steppedThread(orderedThreads(), threadId, id === "next-thread" ? 1 : -1)
      if (next !== undefined) openThread(next)
      return
    }
    case "composer":
      showThreadSurface()
      focusComposer()
      return
    case "find":
      // The side panel keeps its own keys, as the browser preview's page does.
      if (threadId === undefined || focusInPanel()) return
      showThreadSurface()
      set({ findSignal: state.findSignal + 1 })
      return
    case "stop":
      if (threadId !== undefined) void cancel(threadId)
      return
    case "dictate":
      showThreadSurface()
      set({ dictateSignal: state.dictateSignal + 1 })
      return
    case "waiting":
      setTrayOpen(!useTray.getState().open)
      return
    case "go-threads":
      goTo("threads")
      return
    case "go-reviews":
      goTo("reviews")
      return
    case "go-agents":
      goTo("agents")
      return
    case "go-workflows":
      goTo("workflows")
      return
    case "go-evals":
      goTo("evals")
      return
    case "go-memory":
      goTo("memory")
      return
    case "go-integrations":
      goTo("integrations")
      return
    case "go-office":
      goTo("office")
      return
  }
}

/** Keys that act on the open thread show it: in the thread view, or in the office's open drawer. */
function showThreadSurface(): void {
  const state = get()
  if (state.view.kind === "thread" || (state.view.kind === "office" && state.officeDrawer)) return
  set({ view: { kind: "thread" } })
}

function focusInPanel(): boolean {
  return document.activeElement?.closest(".inspector") != null
}

/** The last shortcut this page handled, so the menu item for the same keys does not run it twice. */
let lastKey: { readonly id: ShortcutId; readonly at: number } | undefined

function runFromMenu(id: ShortcutId): void {
  if (lastKey !== undefined && lastKey.id === id && performance.now() - lastKey.at < 250) return
  // The same rule as the key handler: while a modal is up only the palette toggle and settings pass.
  const state = get()
  const modal = state.dialog !== undefined || state.settings !== false || state.palette
  if (modal && id !== "palette" && id !== "settings") return
  if (modal && id === "palette" && (state.dialog !== undefined || state.settings !== false)) return
  run(id)
}

function runMenuKey(key: MenuKey): void {
  if (key === "quit") void getHost().appQuit().catch(() => undefined)
  else if (key === "close-window") void closeWindow()
  else void toggleFullscreen().catch(() => undefined)
}

/**
 * The app menu on macOS, or the host's hand-over elsewhere, so shortcuts also work while a browser
 * preview has the keyboard. It waits for boot to say which platform this is: App mounts before that.
 */
function useMenuShortcuts(): void {
  const platform = useApp((state) => state.platform)
  useEffect(() => {
    if (platform === "unknown") return undefined
    if (platform !== "macos") {
      void listenPreviewShortcuts(runFromMenu).catch(() => undefined)
      return undefined
    }
    void setOfficeInMenu(get().prefs.officeMode !== "off").catch(() => undefined)
    void installAppMenu(runFromMenu, (url) => void openUrl(url)).catch(() => undefined)
    return useApp.subscribe((state, previous) => {
      if (state.prefs.officeMode !== previous.prefs.officeMode) void setOfficeInMenu(state.prefs.officeMode !== "off").catch(() => undefined)
    })
  }, [platform])
}

/** One window-level handler for every shortcut in SHORTCUTS. Overlays keep their own keys. */
function useGlobalKeys(): void {
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const state = get()
      const linux = document.documentElement.dataset.platform === "linux"
      const key = linux ? menuKey(event) : undefined
      if (key !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        runMenuKey(key)
        return
      }
      for (const shortcut of SHORTCUTS) {
        if (!matches(event, shortcut.keys)) continue
        // Outside the side panel ⌘W is the menu's (it closes the window), or the browser's own; Linux has no such menu.
        if (shortcut.id === "close-tab" && !focusInPanel() && !linux) return
        // While a modal is up only the palette toggle and settings close pass through.
        const modal = state.dialog !== undefined || state.settings !== false || state.palette
        if (modal && shortcut.id !== "palette" && shortcut.id !== "settings") return
        if (modal && shortcut.id === "palette" && (state.dialog !== undefined || state.settings !== false)) return
        event.preventDefault()
        event.stopPropagation()
        lastKey = { id: shortcut.id, at: performance.now() }
        run(shortcut.id)
        return
      }
    }
    window.addEventListener("keydown", handle)
    return () => window.removeEventListener("keydown", handle)
  }, [])
}
