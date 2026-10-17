import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { createRoot } from "react-dom/client"
import "../styles/tokens.css"
import "../styles/phone.css"
import type { PhoneItem } from "../app/phone"
import { COMPUTER, httpTransport, PhoneApiError, savedToken, saveToken, type PhoneTransport } from "./api"
import { needsHomeScreen, pushSupported, subscribe, subscribed, unsubscribe } from "./push"

/**
 * Runrail on a phone: the threads on the person's Mac, one thread's conversation,
 * a message box, Stop, and approvals. Served by the Mac through the person's own Tailscale.
 */

interface ThreadSummary {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly machine?: string
  readonly status: string
  readonly updatedAt: number
}

interface ThreadView extends ThreadSummary {
  readonly items: readonly PhoneItem[]
}

const LIST_POLL_MS = 5_000
const THREAD_POLL_MS = 2_000
const SHARE_POLL_MS = 3_000
const STATUS_LABELS: Readonly<Record<string, string>> = { running: "Running", waiting: "Needs you", failed: "Failed", completed: "Done", stopped: "Stopped", idle: "Idle" }

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${String(hours)} h` : `${String(Math.round(hours / 24))} d`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "That did not work."
}

/** Runs `poll` now and every `ms` while the page is visible; a hidden page asks nothing. */
function usePoll(poll: () => Promise<void>, ms: number): void {
  useEffect(() => {
    let timer: number | undefined
    let live = true
    const tick = async (): Promise<void> => {
      if (!live) return
      if (document.visibilityState === "visible") await poll()
      if (live) timer = window.setTimeout(() => void tick(), ms)
    }
    void tick()
    const wake = (): void => {
      if (document.visibilityState !== "visible") return
      window.clearTimeout(timer)
      void tick()
    }
    document.addEventListener("visibilitychange", wake)
    return () => {
      live = false
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
    }
  }, [poll, ms])
}

function Pair({ transport, onPaired, note }: { readonly transport: PhoneTransport; readonly onPaired: (token: string) => void; readonly note?: string }) {
  const [code, setCode] = useState(() => /(?:^#|&)pair=([A-Za-z0-9-]{4,16})/.exec(window.location.hash)?.[1] ?? "")
  const [name, setName] = useState(() => (/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone"))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(note)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const token = await transport.pair(code, name)
      // The code is spent; it should not linger in the address bar or history.
      window.history.replaceState(null, "", window.location.pathname + window.location.search)
      onPaired(token)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="ph-pair">
      <h1>Runrail</h1>
      <p className="ph-muted">On your {COMPUTER}, open Settings, General, Phone access, and show a pairing code.</p>
      <form className="ph-form" onSubmit={(event) => void submit(event)}>
        <label className="ph-field">
          <span>Pairing code</span>
          <input className="ph-input ph-code" value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="characters" autoComplete="one-time-code" autoCorrect="off" spellCheck={false} maxLength={16} required />
        </label>
        <label className="ph-field">
          <span>Name for this phone</span>
          <input className="ph-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
        </label>
        {error !== undefined && (
          <p className="ph-error" role="alert">
            {error}
          </p>
        )}
        <button className="ph-button ph-primary" type="submit" disabled={busy || code.trim().length === 0}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </main>
  )
}

function Status({ status }: { readonly status: string }) {
  return (
    <span className={`ph-status is-${status}`}>
      <span className="ph-dot" aria-hidden="true" />
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

/** Notifications on this phone: a tap to turn them on, or why they cannot be. */
function Notify({ call }: { readonly call: Caller }) {
  const [on, setOn] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  useEffect(() => {
    void subscribed().then(setOn, () => setOn(false))
  }, [])
  const supported = pushSupported()
  if (!supported && !needsHomeScreen()) return null
  const toggle = async (): Promise<void> => {
    setBusy(true)
    setNote(undefined)
    try {
      if (!supported) throw new Error("For notifications, add Runrail to your Home Screen: Share, then Add to Home Screen, and open it from there.")
      if (on === true) await unsubscribe(call)
      else await subscribe(call)
      setOn(on !== true)
    } catch (failure) {
      setNote(message(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" className="ph-button" disabled={busy || (supported && on === undefined)} onClick={() => void toggle()}>
        {on === true ? "Notifications on" : "Notify me"}
      </button>
      {note !== undefined && (
        <p className="ph-error ph-banner" role="alert">
          {note}
        </p>
      )}
    </>
  )
}

function Threads({ call, onOpen }: { readonly call: Caller; readonly onOpen: (id: string) => void }) {
  const [threads, setThreads] = useState<readonly ThreadSummary[]>()
  const [error, setError] = useState<string>()
  const poll = useCallback(async () => {
    try {
      const answer = await call<{ readonly threads: readonly ThreadSummary[] }>("threads")
      setThreads(answer.threads)
      setError(undefined)
    } catch (failure) {
      setError(message(failure))
    }
  }, [call])
  usePoll(poll, LIST_POLL_MS)
  return (
    <main className="ph-list">
      <header className="ph-bar">
        <h1 className="ph-grow">Threads</h1>
        <Notify call={call} />
      </header>
      {error !== undefined && (
        <p className="ph-error ph-banner" role="alert">
          {error}
        </p>
      )}
      {threads === undefined ? (
        error === undefined && <p className="ph-muted ph-pad">Loading…</p>
      ) : threads.length === 0 ? (
        <p className="ph-muted ph-pad">No threads yet. Start one on your {COMPUTER}.</p>
      ) : (
        <ul className="ph-threads">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button type="button" className="ph-thread" onClick={() => onOpen(thread.id)}>
                <span className="ph-thread-title">{thread.title}</span>
                <span className="ph-thread-meta">
                  <Status status={thread.status} />
                  <span>{thread.machine === undefined ? thread.project : `${thread.project} on ${thread.machine}`}</span>
                  <span>{ago(thread.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

/** Fenced code set apart; the rest stays as written. */
function Text({ text }: { readonly text: string }) {
  const parts = text.split(/```[^\n]*\n?/)
  return <>{parts.map((part, index) => (index % 2 === 1 ? <pre key={index} className="ph-pre">{part.replace(/\n$/, "")}</pre> : part.length > 0 && <span key={index}>{part}</span>))}</>
}

function Item({ item, onAnswer, answering, readOnly = false }: { readonly item: PhoneItem; readonly onAnswer: (approvalId: string, approved: boolean) => void; readonly answering: boolean; readonly readOnly?: boolean }) {
  switch (item.kind) {
    case "user":
      return <div className={`ph-msg ph-user${item.failed === true ? " is-failed" : ""}`}>{item.text}</div>
    case "assistant":
      return (
        <div className="ph-msg ph-assistant">
          <Text text={item.text} />
        </div>
      )
    case "tool":
      return (
        <div className={`ph-tool is-${item.status}`}>
          <span className="ph-dot" aria-hidden="true" />
          {item.title}
        </div>
      )
    case "notice":
      return <div className="ph-error">{item.text}</div>
    case "approval":
      return (
        <div className={`ph-approval is-${item.status}`}>
          <div className="ph-approval-head">{item.status === "pending" ? "Asks to" : item.status === "approved" ? "Allowed" : "Denied"}</div>
          <div className="ph-approval-action">{item.action}</div>
          {item.reason !== undefined && <div className="ph-muted">{item.reason}</div>}
          {item.status === "pending" &&
            (readOnly ? (
              <div className="ph-muted">Waiting for an answer.</div>
            ) : item.question === true ? (
              <div className="ph-muted">Answer this question on your {COMPUTER}.</div>
            ) : (
              <div className="ph-actions">
                <button type="button" className="ph-button" disabled={answering} onClick={() => onAnswer(item.approvalId, false)}>
                  Deny
                </button>
                <button type="button" className="ph-button ph-primary" disabled={answering} onClick={() => onAnswer(item.approvalId, true)}>
                  Allow
                </button>
              </div>
            ))}
        </div>
      )
  }
}

function Thread({ call, id, onBack }: { readonly call: Caller; readonly id: string; readonly onBack: () => void }) {
  const [thread, setThread] = useState<ThreadView>()
  const [error, setError] = useState<string>()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const count = useRef(0)
  const poll = useCallback(async () => {
    try {
      setThread(await call<ThreadView>("thread", { threadId: id }))
      setError(undefined)
    } catch (failure) {
      setError(message(failure))
    }
  }, [call, id])
  usePoll(poll, THREAD_POLL_MS)
  useEffect(() => {
    const items = thread?.items.length ?? 0
    if (items > count.current) end.current?.scrollIntoView({ block: "end" })
    count.current = items
  }, [thread])
  const act = async (method: string, params: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await call(method, { threadId: id, ...params })
      await poll()
      return true
    } catch (failure) {
      setError(message(failure))
      return false
    } finally {
      setBusy(false)
    }
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (text.trim().length > 0 && (await act("send", { text }))) setText("")
  }
  const running = thread?.status === "running" || thread?.status === "waiting"
  return (
    <main className="ph-thread-view">
      <header className="ph-bar">
        <button type="button" className="ph-back" onClick={onBack} aria-label="Back to threads">
          ‹
        </button>
        <div className="ph-bar-text">
          <h1>{thread?.title ?? "Thread"}</h1>
          {thread !== undefined && <Status status={thread.status} />}
        </div>
        {running && (
          <button type="button" className="ph-button" disabled={busy} onClick={() => void act("stop", {})}>
            Stop
          </button>
        )}
      </header>
      {error !== undefined && (
        <p className="ph-error ph-banner" role="alert">
          {error}
        </p>
      )}
      <div className="ph-items">
        {thread?.items.length === 0 && <p className="ph-muted">No messages yet.</p>}
        {thread?.items.map((item) => <Item key={item.key} item={item} answering={busy} onAnswer={(approvalId, approved) => void act("approve", { approvalId, approved })} />)}
        <div ref={end} />
      </div>
      <form className="ph-composer" onSubmit={(event) => void submit(event)}>
        <textarea className="ph-input" value={text} onChange={(event) => setText(event.target.value)} placeholder={running ? "Queue a follow-up" : "Message"} rows={2} maxLength={20_000} aria-label="Message" />
        <button className="ph-button ph-primary" type="submit" disabled={busy || text.trim().length === 0}>
          Send
        </button>
      </form>
    </main>
  )
}

type Caller = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

interface SharedThread {
  readonly title: string
  readonly status: string
  readonly items: readonly PhoneItem[]
}

/** A thread through its read-only link: its conversation, with nothing to act on. */
function Shared({ transport, token }: { readonly transport: PhoneTransport; readonly token: string }) {
  const [thread, setThread] = useState<SharedThread>()
  const [error, setError] = useState<string>()
  const end = useRef<HTMLDivElement>(null)
  const count = useRef(0)
  const poll = useCallback(async () => {
    try {
      const next = await transport.share<SharedThread>(token)
      setThread(next)
      setError(undefined)
      document.title = `${next.title} - Runrail`
    } catch (failure) {
      setError(message(failure))
    }
  }, [transport, token])
  usePoll(poll, SHARE_POLL_MS)
  useEffect(() => {
    const items = thread?.items.length ?? 0
    if (items > count.current) end.current?.scrollIntoView({ block: "end" })
    count.current = items
  }, [thread])
  return (
    <main className="ph-thread-view">
      <header className="ph-bar">
        <div className="ph-bar-text">
          <h1>{thread?.title ?? "Shared thread"}</h1>
          {thread !== undefined && <Status status={thread.status} />}
        </div>
      </header>
      {error !== undefined && (
        <p className="ph-error ph-banner" role="alert">
          {error}
        </p>
      )}
      <div className="ph-items">
        {thread?.items.length === 0 && <p className="ph-muted">No messages yet.</p>}
        {thread?.items.map((item) => <Item key={item.key} item={item} answering readOnly onAnswer={() => undefined} />)}
        <div ref={end} />
      </div>
      <p className="ph-muted ph-pad ph-note">A read-only link to a Runrail thread. Only the person who shared it can send to it.</p>
    </main>
  )
}

function App({ transport }: { readonly transport: PhoneTransport }) {
  const [token, setToken] = useState(savedToken)
  const [note, setNote] = useState<string>()
  const [open, setOpen] = useState<string | undefined>(() => /^#t=([A-Za-z0-9_-]{1,80})$/.exec(window.location.hash)?.[1])
  useEffect(() => {
    const back = (): void => setOpen(/^#t=([A-Za-z0-9_-]{1,80})$/.exec(window.location.hash)?.[1])
    window.addEventListener("popstate", back)
    return () => window.removeEventListener("popstate", back)
  }, [])
  const call = useCallback<Caller>(
    async (method, params) => {
      if (token === undefined) throw new PhoneApiError("PHONE_NOT_PAIRED", "Pair this phone first.")
      try {
        return await transport.call(token, method, params)
      } catch (error) {
        if (error instanceof PhoneApiError && error.code === "PHONE_NOT_PAIRED") {
          saveToken(undefined)
          setToken(undefined)
          setNote(error.message)
        }
        throw error
      }
    },
    [token, transport],
  )
  if (token === undefined)
    return (
      <Pair
        transport={transport}
        note={note}
        onPaired={(next) => {
          saveToken(next)
          setNote(undefined)
          setToken(next)
        }}
      />
    )
  if (open !== undefined)
    return (
      <Thread
        call={call}
        id={open}
        onBack={() => {
          if (window.history.state === "thread") window.history.back()
          else {
            window.history.replaceState(null, "", window.location.pathname + window.location.search)
            setOpen(undefined)
          }
        }}
      />
    )
  return (
    <Threads
      call={call}
      onOpen={(id) => {
        window.history.pushState("thread", "", `#t=${id}`)
        setOpen(id)
      }}
    />
  )
}

function followTheme(): void {
  const light = window.matchMedia("(prefers-color-scheme: light)")
  const apply = (): void => {
    document.documentElement.dataset.theme = light.matches ? "light" : "dark"
  }
  apply()
  light.addEventListener("change", apply)
}

async function start(): Promise<void> {
  const root = document.getElementById("root")
  if (root === null) throw new Error("missing #root")
  followTheme()
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview")
  const transport = preview ? await (await import("./previewTransport")).previewTransport() : httpTransport
  // The Mac serves this page at `/s/<token>` for a read-only link; the preview has no such path.
  const share = /^\/s\/([A-Za-z0-9_-]{16,64})$/.exec(window.location.pathname)?.[1] ?? (preview ? /^#s=([A-Za-z0-9_-]{16,64})$/.exec(window.location.hash)?.[1] : undefined)
  createRoot(root).render(<StrictMode>{share === undefined ? <App transport={transport} /> : <Shared transport={transport} token={share} />}</StrictMode>)
}

void start()
