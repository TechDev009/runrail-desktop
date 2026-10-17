import { Blocks, Bot, Brain, Building2, FlaskConical, GitPullRequest, MessagesSquare, Search, Settings, SquarePen, Workflow } from "lucide-react"
import type { ReactNode } from "react"
import { startNewThread } from "../../app/actions"
import { unreadCount, useInbox } from "../../app/inbox"
import { showList, showOffice } from "../../app/office"
import { ariaKeys, railAction, railItems, type RailPlace } from "../../app/rail"
import { get, set, setLayout, useApp } from "../../app/store"
import { useReviews } from "../../app/reviews"
import { useEvals } from "../../app/evals"
import { useSetups } from "../../app/setups"
import { useWaiting } from "../../app/triage"
import { isMac } from "../../lib/format"
import { cx, Kbd, Menu } from "../common"
import { RailUsage } from "../thread/PlanUsage"
import { Mark, useMenuItems } from "./Account"

/**
 * The window's left edge, Codex style: icons only, each naming itself in a pill on hover and on
 * keyboard focus. The threads list beside it is the old sidebar.
 */

const ICONS: Readonly<Record<RailPlace, ReactNode>> = {
  threads: <MessagesSquare size={16} />,
  reviews: <GitPullRequest size={16} />,
  agents: <Bot size={16} />,
  workflows: <Workflow size={16} />,
  evals: <FlaskConical size={16} />,
  memory: <Brain size={16} />,
  integrations: <Blocks size={16} />,
  office: <Building2 size={16} />,
}

export function goTo(place: RailPlace): void {
  const state = get()
  const office = state.prefs.officeMode !== "off"
  const action = railAction(place, { view: state.view, office })
  if (action === "none") return
  if (action === "toggle-list") {
    setLayout({ sidebarOpen: !state.layout.sidebarOpen })
    return
  }
  switch (place) {
    case "threads":
      // Leaving the floor for the list is remembered, so the next start opens the list.
      if (office) showList()
      else set({ view: { kind: "thread" } })
      return
    case "reviews":
    case "agents":
    case "workflows":
    case "evals":
    case "integrations":
    case "memory":
      set({ view: { kind: place } })
      return
    case "office":
      showOffice()
      return
  }
}

export function Rail() {
  const view = useApp((state) => state.view)
  const office = useApp((state) => state.prefs.officeMode !== "off")
  const listOpen = useApp((state) => state.layout.sidebarOpen)
  const projects = useApp((state) => state.projects.length)
  const waiting = useWaiting().length
  const reviewsWaiting = useReviews((state) => state.waiting)
  const agentsWaiting = useSetups((state) => Object.values(state.runs).filter((entry) => entry.run.waiting?.kind === "approve").length)
  const evalsRunning = useEvals((state) => Object.values(state.runs).filter((entry) => entry.run.state === "running").length)
  const items = railItems({ view, office, waiting, reviewsWaiting, agentsWaiting, evalsRunning })
  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail-top" data-tauri-drag-region />
      <RailButton label="New thread" keys="mod+n" {...(projects === 0 ? { note: "Open a project first" } : {})} onClick={() => startNewThread()}>
        <SquarePen size={16} />
      </RailButton>
      <div className="rail-divider" />
      {items.map((item) => (
        <RailButton
          key={item.place}
          label={item.place === "threads" && item.active ? (listOpen ? "Hide threads" : "Show threads") : item.label}
          keys={item.keys}
          active={item.active}
          {...(item.badge === undefined ? {} : { badge: item.badge })}
          onClick={() => goTo(item.place)}
        >
          {ICONS[item.place]}
        </RailButton>
      ))}
      <div className="rail-spacer" />
      <RailUsage />
      <RailButton label="Search" keys="mod+k" onClick={() => set({ palette: true })}>
        <Search size={16} />
      </RailButton>
      <RailButton label="Settings" keys="mod+," onClick={() => set({ settings: "general" })}>
        <Settings size={16} />
      </RailButton>
      <RailMenu />
    </nav>
  )
}

function RailButton({
  label,
  keys,
  active,
  badge,
  note,
  onClick,
  children,
}: {
  readonly label: string
  readonly keys: string
  readonly active?: boolean
  readonly badge?: number
  /** Why the button is off; it disables the button and replaces the shortcut in the pill. */
  readonly note?: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  const spoken = badge === undefined ? label : `${label}, ${String(badge)} waiting on you`
  return (
    <button
      type="button"
      className={cx("rail-item", active === true && "is-active")}
      aria-label={note === undefined ? spoken : `${spoken}. ${note}`}
      aria-current={active === true ? "page" : undefined}
      aria-keyshortcuts={note === undefined ? ariaKeys(keys, isMac) : undefined}
      disabled={note !== undefined}
      onClick={onClick}
    >
      {children}
      {badge !== undefined && (
        <span className="rail-badge" aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <span className="rail-tip" aria-hidden="true">
        {label}
        {note === undefined ? <Kbd keys={keys} /> : <span className="rail-tip-note">{note}</span>}
      </span>
    </button>
  )
}

/** The Runrail menu: notifications, updates, shortcuts, and the version. */
function RailMenu() {
  const items = useMenuItems()
  const unread = useInbox(unreadCount)
  return (
    <Menu
      side="top"
      align="start"
      width={248}
      className="account-menu"
      items={items}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx("rail-item rail-account", open && "is-open")} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={unread > 0 ? `Runrail menu, ${String(unread)} new notifications` : "Runrail menu"}>
          <Mark unread={unread > 0} />
          <span className="rail-tip" aria-hidden="true">
            {unread > 0 ? `${String(unread)} new` : "Runrail"}
          </span>
        </button>
      )}
    />
  )
}
