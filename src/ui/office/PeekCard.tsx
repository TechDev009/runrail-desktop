import { ArrowUp, X } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react"
import { askAgain, peekThread, resolveApproval, send } from "../../app/engines"
import { modelLabel } from "../../app/modelText"
import { closePeek, expandPeek } from "../../app/office"
import { BACKEND_LABELS, type ThreadMeta } from "../../app/persist"
import { personState, type PersonTone } from "../../app/personState"
import { openThread, useApp, type ThreadRuntime } from "../../app/store"
import { relativeTime, plainText } from "../../lib/format"
import { isBusy, isQuestion, pendingApprovals, type NoticeItem } from "../../thread/reducer"
import { approvalDetail, approvalQuestion, noticeCopy } from "../thread/rows"
import { useProject, useThread } from "../hooks"
import { Button } from "../common"
import { QuestionForm } from "../thread/QuestionCard"

/**
 * A thread's Peek card: what its person is doing, the latest reply, an approval or an error to
 * act on, and a reply box, beside the person on the floor. "Open thread" moves it to the drawer.
 * It follows its person as the floor scrolls or reflows, and closes when the person is gone.
 */

const CARD_WIDTH = 340
const GAP = 10
const EDGE = 8
const REPLY_CHARS = 600

const TONE_COLORS: Readonly<Record<PersonTone, string>> = { work: "var(--blue)", ask: "var(--amber)", fail: "var(--red)", done: "var(--green)", idle: "var(--text-3)" }

export function PeekCard({ threadId, floor }: { readonly threadId: string; readonly floor: RefObject<HTMLDivElement | null> }) {
  const thread = useThread(threadId)
  const project = useProject(thread?.projectId)
  const runtime = useApp((state) => state.runtime[threadId])
  const card = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ readonly top: number; readonly left: number } | undefined>()

  const personOf = useCallback(() => floor.current?.querySelector<HTMLButtonElement>(`button.person[data-thread="${CSS.escape(threadId)}"]`) ?? null, [floor, threadId])

  // A thread nobody opened yet has an empty timeline; its transcript is read without starting its engine.
  useEffect(() => {
    void peekThread(threadId)
  }, [threadId])

  useLayoutEffect(() => {
    const box = floor.current
    if (box === null) return
    const follow = (): void => {
      const person = personOf()
      if (person === null) {
        closePeek()
        return
      }
      setPlace(peekPlacement(person.getBoundingClientRect(), box.getBoundingClientRect(), { top: box.scrollTop, left: box.scrollLeft, width: box.clientWidth }))
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(box)
    const rooms = box.querySelector(".office-rooms")
    if (rooms !== null) observer.observe(rooms)
    return () => observer.disconnect()
  }, [floor, personOf])

  // Focus moves in once the card is placed: a hidden element cannot take it.
  const shown = place !== undefined
  useEffect(() => {
    if (shown) card.current?.focus({ preventScroll: true })
  }, [shown])

  // A press anywhere else closes the card; a person's own press opens theirs instead.
  useEffect(() => {
    const press = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || card.current?.contains(target) === true || target.closest("button.person") !== null) return
      closePeek()
    }
    // Escape from anywhere on the floor, unless something nearer took it first.
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      const person = personOf()
      closePeek()
      person?.focus()
    }
    document.addEventListener("pointerdown", press, true)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", press, true)
      document.removeEventListener("keydown", escape)
    }
  }, [personOf])

  if (thread === undefined) return null
  const close = (): void => {
    const person = personOf()
    closePeek()
    person?.focus()
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  return (
    <div
      ref={card}
      className="peek-card"
      role="dialog"
      aria-label={thread.titled ? thread.title : "New thread"}
      tabIndex={-1}
      style={place === undefined ? { visibility: "hidden" } : { top: place.top, left: place.left }}
      onKeyDown={keys}
    >
      <PeekBody thread={thread} {...(project === undefined ? {} : { projectName: project.name })} {...(runtime === undefined ? {} : { runtime })} onClose={close} />
    </div>
  )
}

/** What the card says, from plain facts; `PeekCard` feeds it and places it. */
export function PeekBody({ thread, projectName, runtime, onClose }: { readonly thread: ThreadMeta; readonly projectName?: string; readonly runtime?: ThreadRuntime; readonly onClose: () => void }) {
  const [draft, setDraft] = useState("")
  const threadId = thread.id
  const timeline = runtime?.timeline
  const person = personState({ thread, ...(runtime === undefined ? {} : { runtime }), backgroundAgents: 0 })
  const busy = timeline !== undefined && isBusy(timeline)
  const approval = timeline === undefined ? undefined : pendingApprovals(timeline)[0]
  const gatePosition = approval?.callKey === undefined ? undefined : timeline?.index.get(approval.callKey)
  const gate = gatePosition === undefined ? undefined : timeline?.items[gatePosition]
  const detail = approval === undefined ? undefined : approvalDetail(approval, gate?.kind === "tool" ? gate : undefined)
  const reply = latestReply(timeline?.items ?? [])
  const failure = person.tone === "fail" ? latestError(timeline?.items ?? []) : undefined
  const title = thread.titled ? thread.title : "New thread"
  const model = thread.model !== undefined ? modelLabel(thread.model) : BACKEND_LABELS[thread.backend]
  const color = TONE_COLORS[person.tone]
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (draft.trim().length === 0) return
    send(threadId, { text: draft })
    setDraft("")
  }

  return (
    <>
      <div className="peek-head">
        <span className="peek-status" style={{ color }}>
          <span className="peek-status-dot" style={{ background: color }} aria-hidden />
          {person.label}
        </span>
        <span className="peek-time">{relativeTime(thread.updatedAt)}</span>
        <span className="peek-spacer" />
        <Button size="sm" variant="ghost" onClick={() => expandPeek(threadId)}>
          Open thread
        </Button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="peek-title">
        <span className="peek-name">{title}</span>
        <span className="peek-meta">{[projectName, model, person.detail].filter((part) => part !== undefined && part.length > 0).join(" · ")}</span>
      </div>
      {reply !== undefined && <p className="peek-reply">{reply}</p>}
      {approval !== undefined && (
        <div className="peek-approval">
          <span className="peek-approval-question">{approvalQuestion(approval)}</span>
          {detail !== undefined && <code className="peek-approval-detail">{detail}</code>}
          {approval.questions !== undefined ? (
            <QuestionForm item={approval} threadId={threadId} primary={false} compact />
          ) : isQuestion(approval) ? (
            <div className="peek-actions">
              <Button size="sm" onClick={() => openThread(threadId)}>
                Open
              </Button>
            </div>
          ) : (
            <div className="peek-actions">
              <Button size="sm" variant="primary" onClick={() => void resolveApproval(threadId, approval.approvalId, true)}>
                Approve
              </Button>
              <Button size="sm" onClick={() => void resolveApproval(threadId, approval.approvalId, false)}>
                Deny
              </Button>
            </div>
          )}
        </div>
      )}
      {failure !== undefined && (
        <div className="peek-error">
          <span>{failure}</span>
          <Button size="sm" onClick={() => askAgain(threadId)}>
            Try again
          </Button>
        </div>
      )}
      <form className="peek-compose" onSubmit={submit}>
        <input value={draft} placeholder={busy ? "Add a follow-up" : "Reply"} aria-label={`Reply to ${title}`} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="peek-send" aria-label="Send" disabled={draft.trim().length === 0}>
          <ArrowUp size={13} />
        </button>
      </form>
    </>
  )
}

type Box = Pick<DOMRect, "top" | "left" | "right">

/**
 * Where the card sits in the floor's scrolled content: beside the person on the right, on the left
 * when the right has no room, and never past the floor's edge.
 */
export function peekPlacement(person: Box, floor: Box, scroll: { readonly top: number; readonly left: number; readonly width: number }): { readonly top: number; readonly left: number } {
  const right = person.right - floor.left + scroll.left + GAP
  const left = right + CARD_WIDTH <= scroll.width - EDGE ? right : Math.max(EDGE, person.left - floor.left + scroll.left - GAP - CARD_WIDTH)
  return { top: Math.max(EDGE, person.top - floor.top + scroll.top - 6), left }
}

/** The newest answer, flattened for a short read; the drawer has the rest. */
function latestReply(items: readonly { readonly kind: string; readonly text?: string }[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind !== "assistant" || item.text === undefined) continue
    const text = plainText(item.text)
    if (text.length === 0) continue
    return text.length <= REPLY_CHARS ? text : `${text.slice(0, REPLY_CHARS - 1)}…`
  }
  return undefined
}

/** Why the last turn failed, as the thread says it. */
function latestError(items: readonly { readonly kind: string }[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "notice" && (item as NoticeItem).level === "error") return noticeCopy(item as NoticeItem)
    if (item?.kind === "user") break
  }
  return "The last turn failed."
}
