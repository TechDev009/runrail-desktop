import { CircleCheck, CircleX, Hand, MoonStar, Square, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { APPROVAL_SETTLE_MS, triageKey, type TriageAction, type WaitingItem, type WaitingKind } from "../../app/attention"
import { offersSessionApproval } from "../../app/engines"
import { approve, deny, dismissWaiting, openWaiting, setTrayOpen, stopQuiet, useTray, useWaiting } from "../../app/triage"
import { useApp } from "../../app/store"
import { firstLine, relativeTime, shortcut } from "../../lib/format"
import { Button, cx, IconButton, Kbd, useOverlays, useTicker } from "../common"
import { approvalDetail, approvalQuestion, approvalReasonLine } from "../thread/rows"

/**
 * Everything waiting on the person, across projects, in one list worked from the keyboard: arrows
 * or J and K move, Return approves or opens, D denies, Shift-D denies with feedback, O opens, X sets
 * a finished, failed, or quiet thread aside, Esc closes. Approve and deny are the thread view's own.
 */

const KIND: Readonly<Record<WaitingKind, { readonly label: string; readonly icon: ReactNode }>> = {
  approval: { label: "Needs approval", icon: <Hand size={14} /> },
  failed: { label: "Failed", icon: <CircleX size={14} /> },
  quiet: { label: "Quiet", icon: <MoonStar size={14} /> },
  finished: { label: "Finished", icon: <CircleCheck size={14} /> },
}

/** "Waiting · N" beside "Running · N"; hidden while nothing waits. */
export function WaitingButton() {
  const items = useWaiting()
  const open = useTray((state) => state.open)
  if (items.length === 0) return null
  const asking = items.some((item) => item.kind === "approval")
  return (
    <button
      type="button"
      data-tray-toggle=""
      className={cx("header-waiting", asking && "is-asking", open && "is-active")}
      onClick={() => setTrayOpen(!open)}
      aria-expanded={open}
      aria-label={`Waiting on you, ${String(items.length)}`}
      title={`Waiting on you  ${shortcut("mod+i")}`}
    >
      {asking ? <Hand size={12} aria-hidden /> : <span className="header-waiting-dot" aria-hidden />}
      <span className="header-waiting-label">Waiting · </span>
      {items.length}
    </button>
  )
}

export function Tray() {
  const open = useTray((state) => state.open)
  return open ? <TrayPanel /> : null
}

function TrayPanel() {
  const items = useWaiting()
  const projects = useApp((state) => state.projects)
  const now = useTicker(true, 15_000)
  const panel = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  const returnTo = useRef<Element | null>(null)
  const restore = useRef(true)
  const [cursor, setCursor] = useState(0)
  const [feedback, setFeedback] = useState<{ readonly key: string; readonly text: string } | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [said, setSaid] = useState("")
  const current = items[Math.min(cursor, items.length - 1)]
  const shownAt = useRef(0)

  useEffect(() => {
    shownAt.current = Date.now()
  }, [current?.key])

  // Focus comes back to wherever it was when the tray opened, unless a thread was opened from it.
  useLayoutEffect(() => {
    returnTo.current = document.activeElement
    const element = panel.current
    if (element !== null) useOverlays.setState((overlays) => [...overlays, element], true)
    return () => {
      if (element !== null) useOverlays.setState((overlays) => overlays.filter((item) => item !== element), true)
      if (restore.current && returnTo.current instanceof HTMLElement && returnTo.current.isConnected) returnTo.current.focus()
    }
  }, [])

  // The cursor stays on the same place in the list as items are answered and leave it.
  useEffect(() => {
    if (cursor > 0 && cursor >= items.length) setCursor(Math.max(0, items.length - 1))
  }, [cursor, items.length])

  // Focus follows the cursor, but never leaves another control in the tray the person moved to.
  useEffect(() => {
    if (feedback !== undefined) return
    const active = document.activeElement
    const inside = panel.current?.contains(active) === true
    if (items.length === 0) {
      if (!inside || active === null) panel.current?.focus()
      return
    }
    const target = list.current?.querySelector<HTMLElement>(`[data-index="${String(Math.min(cursor, items.length - 1))}"]`)
    if (target === null || target === undefined || target.contains(active)) return
    if (inside && active !== panel.current && active?.closest(".tray-item") === null) return
    target.focus()
  }, [cursor, items, feedback])

  useEffect(() => {
    const outside = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (target === null || panel.current?.contains(target) === true || target.closest("[data-tray-toggle]") !== null) return
      setTrayOpen(false)
    }
    document.addEventListener("mousedown", outside)
    return () => document.removeEventListener("mousedown", outside)
  }, [])

  const run = (action: TriageAction, item: WaitingItem | undefined): void => {
    switch (action.kind) {
      case "move":
        setCursor((value) => Math.min(Math.max(0, value + action.by), Math.max(0, items.length - 1)))
        return
      case "edge":
        setCursor(action.to === "first" ? 0 : Math.max(0, items.length - 1))
        return
      case "close":
        setTrayOpen(false)
        return
    }
    if (item === undefined) return
    switch (action.kind) {
      case "approve":
        setBusy(item.key)
        setSaid(`Approved: ${item.title}`)
        void approve(item, action.session === true).finally(() => setBusy(undefined))
        return
      case "deny":
        setBusy(item.key)
        setSaid(`Denied: ${item.title}`)
        void deny(item).finally(() => setBusy(undefined))
        return
      case "feedback":
        setFeedback({ key: item.key, text: "" })
        return
      case "open":
        restore.current = false
        openWaiting(item)
        return
      case "dismiss":
        setSaid(`Set aside: ${item.title}`)
        dismissWaiting(item)
        return
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return
    // A focused button answers Return and Space itself, so they do what it says.
    if (target.tagName === "BUTTON" && (event.key === "Enter" || event.key === " ")) return
    const settled = Date.now() - shownAt.current >= APPROVAL_SETTLE_MS
    const action = triageKey(event, current, current !== undefined && offersSessionApproval(current.threadId), settled)
    if (action === undefined) return
    event.preventDefault()
    event.stopPropagation()
    run(action, current)
  }

  const sendFeedback = (item: WaitingItem, text: string): void => {
    if (text.trim().length === 0) return
    setFeedback(undefined)
    setBusy(item.key)
    setSaid(`Denied with feedback: ${item.title}`)
    void deny(item, text).finally(() => setBusy(undefined))
  }

  return (
    <div ref={panel} className="tray" role="dialog" aria-label="Waiting on you" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="tray-head">
        <span className="tray-title">Waiting on you</span>
        {items.length > 0 && <span className="tray-count">{items.length}</span>}
        <IconButton label="Close" kbd="escape" size="sm" className="tray-close" onClick={() => setTrayOpen(false)}>
          <X size={14} />
        </IconButton>
      </div>
      {items.length === 0 ? (
        <div className="tray-empty">
          <CircleCheck size={18} />
          <span>Nothing is waiting on you. Approvals, failed or finished turns, and threads that go quiet show up here.</span>
        </div>
      ) : (
        <ol ref={list} className="tray-list" aria-label="Waiting on you">
          {items.map((item, index) => {
            const selected = item.key === current?.key
            const project = projects.find((entry) => entry.id === item.projectId)?.name
            return (
              <li
                key={item.key}
                data-index={index}
                className={cx("tray-item", `is-${item.kind}`, selected && "is-current")}
                tabIndex={selected ? 0 : -1}
                aria-label={`${item.title}, ${KIND[item.kind].label}${project === undefined ? "" : `, ${project}`}`}
                onFocus={() => setCursor(index)}
              >
                <div className="tray-item-head">
                  <span className="tray-icon" aria-hidden>
                    {KIND[item.kind].icon}
                  </span>
                  <span className="tray-item-title">{item.title}</span>
                  <span className="tray-time">{waited(item, now)}</span>
                </div>
                <div className="tray-item-sub">
                  {project !== undefined && <span>{project}</span>}
                  <span>{summary(item, now)}</span>
                </div>
                {item.kind === "approval" && item.approval !== undefined && <ApprovalDetail item={item} />}
                {feedback?.key === item.key ? (
                  <div className="tray-feedback">
                    <input
                      autoFocus
                      value={feedback.text}
                      maxLength={2_000}
                      placeholder="Tell the agent what to do instead"
                      aria-label="Feedback for the agent"
                      onChange={(event) => setFeedback({ key: item.key, text: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          sendFeedback(item, feedback.text)
                        }
                        if (event.key === "Escape") {
                          event.preventDefault()
                          event.stopPropagation()
                          setFeedback(undefined)
                        }
                      }}
                    />
                    <Button size="sm" variant="ghost" onClick={() => setFeedback(undefined)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" disabled={feedback.text.trim().length === 0} onClick={() => sendFeedback(item, feedback.text)}>
                      Deny
                    </Button>
                  </div>
                ) : (
                  <Actions item={item} selected={selected} busy={busy === item.key} run={(action) => run(action, item)} />
                )}
              </li>
            )
          })}
        </ol>
      )}
      <div className="tray-keys" aria-hidden>
        <span>
          <Kbd keys="↑" />
          <Kbd keys="↓" /> Move
        </span>
        <span>
          <Kbd keys="enter" /> Approve or open
        </span>
        <span>
          <Kbd keys="d" /> Deny
        </span>
        <span>
          <Kbd keys="o" /> Open
        </span>
        <span>
          <Kbd keys="x" /> Set aside
        </span>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
    </div>
  )
}

function ApprovalDetail({ item }: { readonly item: WaitingItem }) {
  if (item.approval === undefined) return null
  const detail = approvalDetail(item.approval, item.tool) ?? item.tool?.presentation.title
  const reason = approvalReasonLine(item.approval, detail)
  return (
    <>
      {detail !== undefined && <pre className="tray-action">{detail}</pre>}
      {reason !== undefined && <div className="tray-reason">{reason}</div>}
    </>
  )
}

function Actions({ item, selected, busy, run }: { readonly item: WaitingItem; readonly selected: boolean; readonly busy: boolean; readonly run: (action: TriageAction) => void }) {
  // Only the current row's buttons are in the tab order; the arrows move between rows.
  const tab = selected ? 0 : -1
  // A question is answered in its thread, where its choices show.
  if (item.kind === "approval" && item.approval?.questions !== undefined)
    return (
      <div className="tray-actions">
        <Button variant="primary" size="sm" tabIndex={tab} onClick={() => run({ kind: "open" })} {...(selected ? { kbd: "enter" } : {})}>
          Answer
        </Button>
        <Button size="sm" tabIndex={tab} disabled={busy} title="The coding tool goes on without an answer" onClick={() => run({ kind: "deny" })} {...(selected ? { kbd: "d" } : {})}>
          Skip
        </Button>
      </div>
    )
  if (item.kind === "approval") {
    const session = offersSessionApproval(item.threadId)
    return (
      <div className="tray-actions">
        <Button variant="primary" size="sm" tabIndex={tab} loading={busy} disabled={busy} onClick={() => run({ kind: "approve" })} {...(selected ? { kbd: "enter" } : {})}>
          Approve
        </Button>
        {session && (
          <Button size="sm" tabIndex={tab} disabled={busy} title="Claude Code allows calls like this one for the rest of the session" onClick={() => run({ kind: "approve", session: true })} {...(selected ? { kbd: "shift+a" } : {})}>
            Allow for session
          </Button>
        )}
        <Button size="sm" tabIndex={tab} disabled={busy} onClick={() => run({ kind: "deny" })} {...(selected ? { kbd: "d" } : {})}>
          Deny
        </Button>
        <Button size="sm" variant="ghost" tabIndex={tab} disabled={busy} onClick={() => run({ kind: "feedback" })} {...(selected ? { kbd: "shift+d" } : {})}>
          Deny with feedback…
        </Button>
      </div>
    )
  }
  return (
    <div className="tray-actions">
      <Button variant={item.kind === "failed" ? "primary" : "secondary"} size="sm" tabIndex={tab} onClick={() => run({ kind: "open" })} {...(selected ? { kbd: "enter" } : {})}>
        {item.kind === "quiet" ? "Open and steer" : "Open"}
      </Button>
      {item.kind === "quiet" && (
        <Button size="sm" tabIndex={tab} icon={<Square size={11} />} onClick={() => stopQuiet(item)}>
          Stop
        </Button>
      )}
      <Button size="sm" variant="ghost" tabIndex={tab} onClick={() => run({ kind: "dismiss" })} {...(selected ? { kbd: "x" } : {})}>
        Set aside
      </Button>
    </div>
  )
}

function waited(item: WaitingItem, now: number): string {
  return relativeTime(item.since, now)
}

function summary(item: WaitingItem, now: number): string {
  switch (item.kind) {
    case "approval":
      return item.approval === undefined ? "Needs approval" : approvalQuestion(item.approval)
    case "failed":
      return "The turn stopped with an error"
    case "finished":
      return "Finished, not looked at yet"
    case "quiet": {
      const silent = `No activity for ${relativeTime(item.since, now)}`
      return item.tool === undefined ? silent : `${silent} while running ${firstLine(item.tool.presentation.title, 80)}`
    }
  }
}
