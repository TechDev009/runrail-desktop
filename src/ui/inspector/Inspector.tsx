import { FileDiff, FolderTree, Globe, ListChecks, Plus, Smartphone, SquareTerminal, TabletSmartphone, X } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react"
import { useShallow } from "zustand/react/shallow"
import { refreshBackground, useBackground } from "../../app/background"
import {
  activeTab,
  canAdd,
  closeOtherPanelTabs,
  closePanelTab,
  closePanelTabsToRight,
  movePanelTab,
  newPanelTab,
  openPanel,
  selectPanelTab,
  useLauncherRequest,
} from "../../app/panels"
import type { PanelKind, PanelState, PanelTab } from "../../app/persist"
import { usePreviews } from "../../app/previews"
import { useRunningTasks } from "../../app/tasks"
import { setLayout, useApp } from "../../app/store"
import { nativeItems, openContextMenu } from "../../lib/contextMenu"
import { shortcut } from "../../lib/format"
import { cx, IconButton, Kbd, Menu, Resizer, Spinner, type MenuEntry } from "../common"
import { useGit, useThread } from "../hooks"
import { BrowserView } from "./BrowserView"
import { FilesPane } from "./FilesPane"
import { ReviewPane } from "./ReviewPane"
import { SimulatorPane } from "./SimulatorPane"
import { AndroidPane } from "./AndroidPane"
import { TasksPane } from "./TasksPane"
import { useTermMeta } from "./terminalMeta"

/**
 * The thread's side panel: tabs the person opens and closes, like a browser's. Review, Files, and
 * Tasks open once; terminals and browser previews can be several.
 */

// The terminal emulator is the heaviest dependency; it loads the first time a terminal shows.
const TerminalView = lazy(() => import("./TerminalPane").then((module) => ({ default: module.TerminalView })))

const KINDS: Readonly<Record<PanelKind, { readonly label: string; readonly icon: (size: number) => ReactNode; readonly kbd?: string }>> = {
  review: { label: "Review", icon: (size) => <FileDiff size={size} />, kbd: "mod+shift+d" },
  files: { label: "Files", icon: (size) => <FolderTree size={size} />, kbd: "mod+p" },
  tasks: { label: "Tasks", icon: (size) => <ListChecks size={size} />, kbd: "mod+shift+a" },
  terminal: { label: "Terminal", icon: (size) => <SquareTerminal size={size} />, kbd: "mod+j" },
  browser: { label: "Browser", icon: (size) => <Globe size={size} />, kbd: "mod+shift+b" },
  simulator: { label: "Simulator", icon: (size) => <Smartphone size={size} /> },
  android: { label: "Android", icon: (size) => <TabletSmartphone size={size} /> },
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

export function Inspector({ threadId }: { readonly threadId: string }) {
  const { panel, width } = useApp(useShallow((state) => ({ panel: state.layout.panels[threadId], width: state.layout.inspectorWidth })))
  const thread = useThread(threadId)
  if (thread === undefined) return null
  const tabs = panel?.tabs ?? []
  const shown = panel === undefined ? undefined : activeTab(panel)

  return (
    <aside className="inspector" style={{ width }} aria-label="Side panel">
      <Resizer side="left" width={width} min={320} max={1200} onResize={(value) => setLayout({ inspectorWidth: value })} />
      <div className="panel-strip" data-tauri-drag-region>
        {panel !== undefined && tabs.length > 0 && <TabStrip threadId={threadId} panel={panel} />}
        {tabs.length > 0 && <Launcher threadId={threadId} />}
        <div className="pane-toolbar-spacer" data-tauri-drag-region />
        <IconButton label="Hide panel" size="sm" kbd="mod+alt+b" onClick={() => setLayout({ inspectorOpen: false })}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="inspector-body" role="tabpanel" id={`panel-${threadId}`} aria-labelledby={shown === undefined ? undefined : `tab-${shown.id}`}>
        {shown === undefined ? <EmptyPanel threadId={threadId} /> : <Body threadId={threadId} tab={shown} archived={thread.archived === true} />}
      </div>
    </aside>
  )
}

function Body({ threadId, tab, archived }: { readonly threadId: string; readonly tab: PanelTab; readonly archived: boolean }) {
  switch (tab.kind) {
    case "review":
      return <ReviewPane threadId={threadId} />
    case "files":
      return <FilesPane threadId={threadId} />
    case "tasks":
      return <TasksPane threadId={threadId} />
    case "simulator":
      return <SimulatorPane />
    case "android":
      return <AndroidPane />
    case "browser":
      return <BrowserView key={tab.id} threadId={threadId} tab={tab} />
    case "terminal":
      if (archived) return <div className="inspect-empty pad">Unarchive this thread to open a terminal.</div>
      return (
        <Suspense
          fallback={
            <div className="pane-loading">
              <Spinner size={12} /> Starting terminal…
            </div>
          }
        >
          <TerminalView key={tab.id} threadId={threadId} terminalId={tab.id} />
        </Suspense>
      )
  }
}

/** Where a dragged tab would land: the index it goes before, among all tabs. */
function dropIndex(strip: HTMLElement, x: number): number {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab]"))
  const at = tabs.findIndex((node) => {
    const rect = node.getBoundingClientRect()
    return x < rect.left + rect.width / 2
  })
  return at < 0 ? tabs.length : at
}

function TabStrip({ threadId, panel }: { readonly threadId: string; readonly panel: PanelState }) {
  const strip = useRef<HTMLDivElement>(null)
  const drag = useRef<{ readonly id: string; readonly x: number; moved: boolean } | undefined>(undefined)
  const [dragging, setDragging] = useState<{ readonly id: string; readonly before: number } | undefined>()
  const [overflowing, setOverflowing] = useState(false)
  const shown = activeTab(panel)

  useEffect(() => {
    const node = strip.current
    if (node === null) return
    const check = (): void => setOverflowing(node.scrollWidth > node.clientWidth + 1)
    const observer = new ResizeObserver(check)
    observer.observe(node)
    check()
    return () => observer.disconnect()
  }, [panel.tabs.length])

  useEffect(() => {
    if (shown === undefined) return
    strip.current?.querySelector(`[data-tab="${CSS.escape(shown.id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [shown])

  const startDrag = (event: PointerEvent, id: string): void => {
    if (event.button !== 0 || (event.target as Element).closest(".panel-tab-close") !== null) return
    selectPanelTab(threadId, id)
    drag.current = { id, x: event.clientX, moved: false }
    const move = (next: globalThis.PointerEvent): void => {
      const current = drag.current
      if (current === undefined || strip.current === null) return
      if (!current.moved && Math.abs(next.clientX - current.x) < 5) return
      current.moved = true
      setDragging({ id: current.id, before: dropIndex(strip.current, next.clientX) })
    }
    const end = (next: globalThis.PointerEvent): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      const current = drag.current
      drag.current = undefined
      setDragging(undefined)
      if (current === undefined || !current.moved || strip.current === null || next.type === "pointercancel") return
      const from = panel.tabs.findIndex((tab) => tab.id === current.id)
      const before = dropIndex(strip.current, next.clientX)
      movePanelTab(threadId, current.id, before > from ? before - 1 : before)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }

  // Roving focus: arrows move between tabs and show them; Delete closes the focused one.
  const onKey = (event: KeyboardEvent): void => {
    const at = panel.tabs.findIndex((tab) => tab.id === (event.target as HTMLElement).dataset.tab)
    if (at < 0) return
    const target =
      event.key === "ArrowRight" ? (at + 1) % panel.tabs.length : event.key === "ArrowLeft" ? (at - 1 + panel.tabs.length) % panel.tabs.length : event.key === "Home" ? 0 : event.key === "End" ? panel.tabs.length - 1 : undefined
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      closePanelTab(threadId, panel.tabs[at]!.id)
      requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
      return
    }
    if (target === undefined) return
    event.preventDefault()
    const id = panel.tabs[target]!.id
    selectPanelTab(threadId, id)
    strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus()
  }

  return (
    <div ref={strip} className={cx("panel-tabs", dragging !== undefined && "is-dragging", overflowing && "is-overflowing")} role="tablist" aria-label="Side panel tabs" onKeyDown={onKey}>
      {panel.tabs.map((tab, index) => (
        <TabButton
          key={tab.id}
          threadId={threadId}
          tab={tab}
          number={panel.tabs.filter((item) => item.kind === tab.kind).indexOf(tab) + 1}
          many={panel.tabs.filter((item) => item.kind === tab.kind).length > 1}
          selected={tab.id === shown?.id}
          dragged={dragging?.id === tab.id}
          dropBefore={dragging !== undefined && dragging.before === index && dragging.id !== tab.id}
          dropAfter={dragging !== undefined && index === panel.tabs.length - 1 && dragging.before === panel.tabs.length && dragging.id !== tab.id}
          onPointerDown={(event) => startDrag(event, tab.id)}
        />
      ))}
    </div>
  )
}

interface TabLook {
  readonly title: string
  readonly detail?: string
  readonly badge?: ReactNode
}

function useTabLook(threadId: string, tab: PanelTab, number: number, many: boolean): TabLook {
  const git = useGit(threadId)
  const running = useRunningTasks(threadId)
  const term = useTermMeta((state) => (tab.kind === "terminal" ? state[tab.id] : undefined))
  const page = usePreviews((state) => (tab.kind === "browser" ? state[tab.id] : undefined))
  switch (tab.kind) {
    case "review": {
      const counts = git.status?.counts
      const changed = counts === undefined ? 0 : counts.staged + counts.unstaged + counts.untracked
      return { title: "Review", ...(changed > 0 ? { badge: <span className="tab-count">{changed}</span>, detail: `${String(changed)} changed` } : {}) }
    }
    case "files":
      return { title: "Files" }
    case "simulator":
      return { title: "Simulator" }
    case "android":
      return { title: "Android" }
    case "tasks":
      return { title: "Tasks", ...(running > 0 ? { badge: <span className="tab-count is-live">{running}</span>, detail: `${String(running)} running` } : {}) }
    case "terminal": {
      const title = term?.title?.trim() || (many ? `Terminal ${String(number)}` : "Terminal")
      const status = term?.status ?? "closed"
      return { title, detail: status === "running" ? "Running" : status === "starting" ? "Starting" : status === "failed" ? "Failed to start" : "Ended", badge: <span className={cx("terminal-dot", `is-${status}`)} aria-hidden /> }
    }
    case "browser": {
      const url = page?.url ?? tab.url
      const title = page?.title?.trim() || hostOf(url) || "New tab"
      return { title, ...(url === undefined ? {} : { detail: url }), ...(page?.loading === true ? { badge: <Spinner size={11} /> } : {}) }
    }
  }
}

function TabButton({
  threadId,
  tab,
  number,
  many,
  selected,
  dragged,
  dropBefore,
  dropAfter,
  onPointerDown,
}: {
  readonly threadId: string
  readonly tab: PanelTab
  readonly number: number
  readonly many: boolean
  readonly selected: boolean
  readonly dragged: boolean
  readonly dropBefore: boolean
  readonly dropAfter: boolean
  readonly onPointerDown: (event: PointerEvent) => void
}) {
  const look = useTabLook(threadId, tab, number, many)
  const menu = (event: MouseEvent): void =>
    openContextMenu(
      event,
      nativeItems([
        { id: "close", label: "Close Tab", onSelect: () => closePanelTab(threadId, tab.id) },
        { id: "others", label: "Close Other Tabs", onSelect: () => closeOtherPanelTabs(threadId, tab.id) },
        { id: "right", label: "Close Tabs to the Right", onSelect: () => closePanelTabsToRight(threadId, tab.id) },
        { id: "sep", separator: true },
        { id: "terminal", label: "New Terminal", onSelect: () => newPanelTab(threadId, "terminal") },
        { id: "browser", label: "New Browser Tab", onSelect: () => newPanelTab(threadId, "browser") },
      ]),
    )
  return (
    <div
      role="tab"
      id={`tab-${tab.id}`}
      data-tab={tab.id}
      aria-selected={selected}
      aria-controls={`panel-${threadId}`}
      tabIndex={selected ? 0 : -1}
      className={cx("panel-tab", selected && "is-active", dragged && "is-dragged", dropBefore && "drop-before", dropAfter && "drop-after")}
      title={look.detail === undefined ? look.title : `${look.title}\n${look.detail}`}
      onPointerDown={onPointerDown}
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        closePanelTab(threadId, tab.id)
      }}
      onContextMenu={menu}
    >
      <span className="panel-tab-icon">{KINDS[tab.kind].icon(13)}</span>
      <span className="panel-tab-label">{look.title}</span>
      {look.badge}
      <button type="button" className="panel-tab-close" tabIndex={-1} aria-label={`Close ${look.title}`} onClick={() => closePanelTab(threadId, tab.id)}>
        <X size={12} />
      </button>
    </div>
  )
}

interface LaunchItem {
  readonly id: string
  readonly kind: PanelKind
  readonly label: string
  readonly kbd?: string
  readonly disabled: boolean
  readonly run: () => void
}

function useLaunchItems(threadId: string): { readonly items: readonly LaunchItem[]; readonly servers: readonly { readonly id: string; readonly label: string; readonly detail: string; readonly run: () => void }[] } {
  const panel = useApp((state) => state.layout.panels[threadId]) ?? { tabs: [] }
  const archived = useThread(threadId)?.archived === true
  const servers = useBackground((state) => state[threadId]?.servers)
  const browserRoom = canAdd(panel, "browser")
  // Xcode's simulators run on a Mac, the Android emulator on a Mac or Linux; the preview stands in for either.
  const simulators = useApp((state) => state.platform === "macos" || state.platform === "browser")
  const emulators = useApp((state) => state.platform === "macos" || state.platform === "linux" || state.platform === "browser")
  return {
    items: [
      { id: "terminal", kind: "terminal", label: "New terminal", disabled: archived || !canAdd(panel, "terminal"), run: () => newPanelTab(threadId, "terminal") },
      { id: "browser", kind: "browser", label: "Browser preview", kbd: "mod+shift+b", disabled: !browserRoom, run: () => newPanelTab(threadId, "browser") },
      { id: "review", kind: "review", label: "Review changes", kbd: "mod+shift+d", disabled: false, run: () => openPanel(threadId, "review") },
      { id: "files", kind: "files", label: "Files", kbd: "mod+p", disabled: false, run: () => openPanel(threadId, "files") },
      { id: "tasks", kind: "tasks", label: "Tasks", kbd: "mod+shift+a", disabled: false, run: () => openPanel(threadId, "tasks") },
      ...(simulators ? [{ id: "simulator", kind: "simulator" as const, label: "iOS Simulator", disabled: false, run: () => openPanel(threadId, "simulator") }] : []),
      ...(emulators ? [{ id: "android", kind: "android" as const, label: "Android Emulator", disabled: false, run: () => openPanel(threadId, "android") }] : []),
    ],
    servers: (servers ?? []).slice(0, 8).map((server) => ({
      id: `server-${String(server.port)}`,
      label: `localhost:${String(server.port)}`,
      detail: server.process,
      run: () => {
        if (browserRoom) newPanelTab(threadId, "browser", `http://localhost:${String(server.port)}`)
      },
    })),
  }
}

/** The `+` menu: what a new tab can show, and the servers the thread's work is running. */
function Launcher({ threadId }: { readonly threadId: string }) {
  const { items, servers } = useLaunchItems(threadId)
  const pending = useLauncherRequest((state) => state.pending)
  const control = useRef<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => undefined })

  useEffect(() => {
    if (!pending) return
    useLauncherRequest.setState({ pending: false })
    if (!control.current.open) control.current.toggle()
  }, [pending])

  const entries: MenuEntry[] = [
    ...items.map((item) => ({ id: item.id, label: item.label, icon: KINDS[item.kind].icon(14), disabled: item.disabled, onSelect: item.run, ...(item.kbd === undefined ? {} : { hint: <Kbd keys={item.kbd} /> }) })),
    ...(servers.length === 0 ? [] : [{ id: "servers", heading: "Running servers" }, ...servers.map((server) => ({ id: server.id, label: server.label, icon: <Globe size={14} />, hint: <span className="menu-hint-text">{server.detail}</span>, onSelect: server.run }))]),
  ]
  return (
    <Menu
      width={240}
      items={entries}
      trigger={({ open, toggle, ref }) => {
        control.current = { open, toggle }
        return (
          <button
            ref={ref}
            type="button"
            className={cx("icon-btn icon-btn-sm panel-add", open && "is-active")}
            aria-label="New tab"
            title={`New tab  ${shortcut("mod+t")}`}
            onClick={() => {
              if (!open) void refreshBackground(threadId, { servers: true })
              toggle()
            }}
          >
            <Plus size={14} />
          </button>
        )
      }}
    />
  )
}

/** A panel with no tabs shows the launcher's choices in place. */
function EmptyPanel({ threadId }: { readonly threadId: string }) {
  const { items, servers } = useLaunchItems(threadId)
  const first = useRef<HTMLButtonElement>(null)
  const pending = useLauncherRequest((state) => state.pending)

  useEffect(() => {
    void refreshBackground(threadId, { servers: true })
  }, [threadId])

  useEffect(() => {
    if (!pending) return
    useLauncherRequest.setState({ pending: false })
    first.current?.focus()
  }, [pending])

  return (
    <div className="panel-launch">
      <div className="panel-launch-title">Open in the side panel</div>
      <div className="panel-launch-list">
        {items.map((item, index) => (
          <button key={item.id} ref={index === 0 ? first : undefined} type="button" className="panel-launch-item" disabled={item.disabled} onClick={item.run}>
            <span className="panel-launch-icon">{KINDS[item.kind].icon(15)}</span>
            <span className="panel-launch-label">{item.label}</span>
            {item.kbd !== undefined && <Kbd keys={item.kbd} />}
          </button>
        ))}
      </div>
      {servers.length > 0 && (
        <>
          <div className="panel-launch-title">Running servers</div>
          <div className="panel-launch-list">
            {servers.map((server) => (
              <button key={server.id} type="button" className="panel-launch-item" onClick={server.run}>
                <span className="panel-launch-icon">
                  <Globe size={15} />
                </span>
                <span className="panel-launch-label">{server.label}</span>
                <span className="panel-launch-detail">{server.detail}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
