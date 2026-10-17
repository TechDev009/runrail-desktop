import { Bell, CircleArrowUp, CircleCheck, CircleSlash, CircleX, Hand, Keyboard } from "lucide-react"
import { useRef, type ReactNode } from "react"
import { markAllRead, setInboxOpen, unreadCount, useInbox, type InboxItem, type InboxKind } from "../../app/inbox"
import { openThread, set, useApp } from "../../app/store"
import { checkForUpdates, useUpdates } from "../../app/updates"
import { relativeTime } from "../../lib/format"
import { cx, useOutside, type MenuEntry } from "../common"

/** The Runrail menu at the rail's foot, Codex style: notifications, updates, and the version. */

export function useMenuItems(): MenuEntry[] {
  const version = useApp((state) => state.hostVersion)
  const unread = useInbox(unreadCount)
  const update = useUpdates((state) => (state.status.phase === "available" ? state.status.update?.version : undefined))
  const supported = useUpdates((state) => state.supported)
  return [
    { id: "notifications", label: "Notifications", icon: <Bell size={14} />, ...(unread > 0 ? { hint: <span className="menu-count is-unread">{unread}</span> } : {}), onSelect: () => setInboxOpen(true) },
    { separator: true, id: "separator-1" },
    update !== undefined
      ? { id: "update", label: `Install Runrail ${update}`, icon: <CircleArrowUp size={14} />, onSelect: () => set({ settings: "general" }) }
      : { id: "update", label: "Check for updates", icon: <CircleArrowUp size={14} />, disabled: !supported, ...(supported ? {} : { description: "This build does not update itself" }), onSelect: () => void checkForUpdates() },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={14} />, onSelect: () => set({ settings: "shortcuts" }) },
    { separator: true, id: "separator-2" },
    { heading: version.length === 0 ? "Runrail, development build" : `Runrail ${version}`, id: "version" },
  ]
}

/** The app's mark where an account picture would sit; a dot when something new is in the inbox. */
export function Mark({ unread }: { readonly unread: boolean }) {
  return (
    <span className="account-mark" aria-hidden="true">
      R{unread && <span className="account-dot" />}
    </span>
  )
}

const KIND: Readonly<Record<InboxKind, { readonly text: string; readonly icon: ReactNode }>> = {
  finished: { text: "Finished", icon: <CircleCheck size={14} className="status-completed" /> },
  failed: { text: "Failed", icon: <CircleX size={14} className="status-failed" /> },
  stopped: { text: "Stopped", icon: <CircleSlash size={14} className="status-stopped" /> },
  approval: { text: "Needs your approval", icon: <Hand size={14} className="status-waiting" /> },
}

/** Notifications: the latest from each thread you were not looking at, newest first. */
export function InboxPanel() {
  const open = useInbox((state) => state.open)
  const items = useInbox((state) => state.items)
  const panel = useRef<HTMLDivElement | null>(null)
  useOutside(panel, () => setInboxOpen(false), open)
  if (!open) return null
  const unread = items.some((item) => !item.read)
  const go = (item: InboxItem): void => {
    setInboxOpen(false)
    openThread(item.threadId)
  }
  return (
    <div ref={panel} className="inbox" role="dialog" aria-label="Notifications">
      <div className="inbox-head">
        <span className="inbox-title">Notifications</span>
        {unread && (
          <button type="button" className="inbox-action" onClick={markAllRead}>
            Mark all read
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="inbox-empty">
          <Bell size={18} />
          <span>Nothing new. Background threads that finish, fail, or wait for approval show up here.</span>
        </div>
      ) : (
        <div className="inbox-list">
          {items.map((item) => (
            <button key={item.id} type="button" className={cx("inbox-item", !item.read && "is-unread")} onClick={() => go(item)}>
              <span className="inbox-icon">{KIND[item.kind].icon}</span>
              <span className="inbox-text">
                <span className="inbox-item-title">{item.title}</span>
                <span className="inbox-item-sub">{KIND[item.kind].text}</span>
              </span>
              <span className="inbox-time">{relativeTime(item.at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
