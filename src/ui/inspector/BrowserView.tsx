import { ArrowLeft, ArrowRight, Globe, MessageSquarePlus, MonitorSmartphone, MousePointerClick, RotateCw, Smartphone, SquareArrowOutUpRight, X } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { openUrl } from "../../app/actions"
import { artboardOf, setArtboards, useArtboards } from "../../app/artboards"
import { useBackground } from "../../app/background"
import { takesBrowser } from "../../app/browserAgent"
import { setBrowserUse } from "../../app/engines"
import { addPageComment, elementLabel, MAX_PAGE_COMMENT, startPicking, stopPicking, usePicking } from "../../app/pageComments"
import { setPanelUrl } from "../../app/panels"
import { BACKEND_LABELS, type PanelTab } from "../../app/persist"
import { patchPreview, typedAddress, usePreviews } from "../../app/previews"
import { signInProject } from "../../app/signIns"
import { toast, useApp } from "../../app/store"
import { getHost, toHostError } from "../../host"
import type { PreviewBounds } from "../../host/types"
import { Button, cx, EmptyState, IconButton, Popover, Spinner, Toggle, useOverlays } from "../common"
import { useHidePreviewWhenGone, useThread } from "../hooks"
import { Artboards } from "./Artboards"

/**
 * A browser tab: the page is a separate native view the host places over this pane's frame, with
 * no access to the app. It hides while a menu or dialog overlaps it, and when its tab, the panel,
 * or the thread is not on screen. In a plain browser (the UI preview) an iframe stands in.
 */

const PHONE_WIDTH = 390
/** How long after the agent's last action the tab still shows it at work. */
const AGENT_GLOW_MS = 6_000

type Phase =
  | { readonly kind: "blank" }
  | { readonly kind: "opening"; readonly url: string }
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "unreachable"; readonly url: string }
  | { readonly kind: "refused"; readonly url: string }
  | { readonly kind: "failed"; readonly url: string; readonly message: string }

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function sameBounds(a: PreviewBounds | null | undefined, b: PreviewBounds | null): boolean {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** The tab itself or one of its artboards. */
function ownTab(previewTab: string, tab: string): boolean {
  return previewTab === tab || artboardOf(previewTab)?.tab === tab
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function BrowserView({ threadId, tab }: { readonly threadId: string; readonly tab: PanelTab }) {
  const host = getHost()
  const native = host.previewNative
  const page = usePreviews((state) => state[tab.id])
  const servers = useBackground((state) => state[threadId]?.servers)
  const palette = useApp((state) => state.palette)
  const overlays = useOverlays()
  const [phase, setPhase] = useState<Phase>(() => {
    // A page still loaded (the agent's, or one left by switching tabs) shows as it is, not reloaded.
    const kept = usePreviews.getState()[tab.id]
    if (native && kept?.url !== undefined && !kept.unloaded) return { kind: "open", url: kept.url }
    return tab.url === undefined ? { kind: "blank" } : { kind: "opening", url: tab.url }
  })
  const [draft, setDraft] = useState<string | undefined>()
  const [hint, setHint] = useState<string | undefined>()
  const [phone, setPhone] = useState(false)
  const boards = useArtboards((state) => state[tab.id] === true)
  const [frameBox, setFrameBox] = useState<DOMRect | undefined>()
  const frame = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const sent = useRef<PreviewBounds | null | undefined>(undefined)
  const opening = useRef(0)
  const followed = useRef(page?.opened)
  const agentBusy = useRecent(page?.agentAt, AGENT_GLOW_MS)

  const measure = useCallback((): PreviewBounds | undefined => {
    const box = frame.current?.getBoundingClientRect()
    if (box === undefined || box.width < 1 || box.height < 1) return undefined
    const width = phone ? Math.min(PHONE_WIDTH, box.width) : box.width
    const x = phone ? box.left + (box.width - width) / 2 : box.left
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(box.top)), width: Math.round(width), height: Math.round(box.height) }
  }, [phone])

  const open = useCallback(
    async (url: string): Promise<void> => {
      const attempt = ++opening.current
      setPhase({ kind: "opening", url })
      if (!native) {
        setPhase({ kind: "open", url })
        setPanelUrl(threadId, tab.id, url)
        patchPreview(tab.id, { url })
        return
      }
      const bounds = measure() ?? { x: 0, y: 0, width: 1, height: 1 }
      try {
        const result = await host.previewOpen(tab.id, url, bounds, false, signInProject(threadId))
        if (attempt !== opening.current) return
        sent.current = undefined
        if (!result.reachable) return setPhase({ kind: "unreachable", url })
        setPhase({ kind: "open", url })
        setPanelUrl(threadId, tab.id, url)
        patchPreview(tab.id, { url, unloaded: false })
      } catch (error) {
        if (attempt !== opening.current) return
        const failure = toHostError(error)
        setPhase(failure.code === "PREVIEW_URL_REFUSED" ? { kind: "refused", url } : { kind: "failed", url, message: failure.message })
      }
    },
    [host, native, measure, threadId, tab.id],
  )

  // A restored tab loads its saved address when it first shows.
  useEffect(() => {
    if (phase.kind === "opening") void open(phase.url)
    else if (phase.kind === "blank") address.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The agent loaded a page here out of sight; the tab drops its own load and shows the agent's.
  useEffect(() => {
    if (page?.opened === undefined || page.opened === followed.current || page.url === undefined) return
    followed.current = page.opened
    opening.current += 1
    sent.current = undefined
    setPhase({ kind: "open", url: page.url })
  }, [page?.opened, page?.url])

  // The page closed to make room for another loads again while its tab is on screen.
  useEffect(() => {
    if (page?.unloaded === true && phase.kind === "open") void open(page.url ?? phase.url)
  }, [page?.unloaded, page?.url, phase, open])

  const covered = palette || (frameBox !== undefined && overlays.some((element) => overlaps(element.getBoundingClientRect(), frameBox)))

  // Follows the frame: one host call per animation frame at most, and only when something moved.
  useLayoutEffect(() => {
    if (!native) return
    const node = frame.current
    if (node === null) return
    let pending = 0
    const sync = (): void => {
      pending = 0
      setFrameBox(node.getBoundingClientRect())
    }
    const schedule = (): void => {
      if (pending === 0) pending = requestAnimationFrame(sync)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    window.addEventListener("resize", schedule)
    sync()
    return () => {
      cancelAnimationFrame(pending)
      observer.disconnect()
      window.removeEventListener("resize", schedule)
    }
  }, [native])

  useEffect(() => {
    // While opening, the host places the page itself once it has loaded.
    if (!native || phase.kind === "opening") return
    // With the artboards showing, they are the page; the tab's own stays loaded out of sight.
    const bounds = phase.kind === "open" && !covered && !boards ? measure() ?? null : null
    if (sameBounds(sent.current, bounds)) return
    sent.current = bounds
    host.previewBounds(tab.id, bounds).catch((error: unknown) => {
      sent.current = undefined
      if (toHostError(error).code === "PREVIEW_NOT_FOUND" && bounds !== null && phase.kind === "open") void open(page?.url ?? phase.url)
    })
  }, [native, phase, covered, boards, frameBox, measure, host, tab.id, page?.url, open])

  // Off screen (another tab, the panel closed, another thread): the page hides but stays loaded.
  useHidePreviewWhenGone(host, tab.id)

  const current = page?.url ?? (phase.kind === "blank" ? undefined : phase.url)
  const loading = phase.kind === "opening" || page?.loading === true
  const live = phase.kind === "open"
  const keepsSignIns = useApp((state) => state.projects.find((project) => project.id === state.threads.find((thread) => thread.id === threadId)?.projectId)?.browserSignIns === true)
  const picking = usePicking((state) => state.tab === tab.id)
  const pickingHere = usePicking((state) => state.tab !== undefined && ownTab(state.tab, tab.id))
  const picked = usePicking((state) => (state.picked !== undefined && ownTab(state.picked.tab, tab.id) ? state.picked : undefined))

  const go = (input: string): void => {
    const url = typedAddress(input)
    if (url === undefined) {
      setHint("Type a web address, such as localhost:5173 or example.com.")
      return
    }
    setHint(undefined)
    setDraft(undefined)
    address.current?.blur()
    void open(url)
  }

  const act = (action: "back" | "forward" | "reload" | "stop"): void => {
    if (!native || !live) {
      if (action === "reload" && current !== undefined) void open(current)
      return
    }
    host.previewAction(tab.id, action).catch(() => undefined)
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <IconButton label="Back" size="sm" disabled={!live || !native} onClick={() => act("back")}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton label="Forward" size="sm" disabled={!live || !native} onClick={() => act("forward")}>
          <ArrowRight size={14} />
        </IconButton>
        {loading && live ? (
          <IconButton label="Stop loading" size="sm" onClick={() => act("stop")}>
            <X size={14} />
          </IconButton>
        ) : (
          <IconButton label="Reload" size="sm" disabled={current === undefined} onClick={() => act("reload")}>
            <RotateCw size={13} />
          </IconButton>
        )}
        <div className={cx("browser-address", loading && "is-loading", agentBusy && "is-agent")}>
          {loading ? <Spinner size={12} /> : <Globe size={12} aria-hidden />}
          <input
            ref={address}
            value={draft ?? current ?? ""}
            placeholder="Type an address, such as localhost:5173"
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={2_048}
            onFocus={(event) => event.currentTarget.select()}
            aria-invalid={hint !== undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setHint(undefined)
            }}
            onBlur={() => {
              setDraft(undefined)
              setHint(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                go(event.currentTarget.value)
              } else if (event.key === "Escape") {
                event.preventDefault()
                setDraft(undefined)
                event.currentTarget.blur()
              }
            }}
          />
        </div>
        <AgentSwitch threadId={threadId} busy={agentBusy} />
        <IconButton
          label={picking ? "Stop picking" : "Comment on an element"}
          size="sm"
          active={picking}
          disabled={!live || boards}
          onClick={() => void (picking ? stopPicking() : startPicking(threadId, tab.id))}
        >
          <MessageSquarePlus size={13} />
        </IconButton>
        <IconButton label={phone ? "Full width" : "Phone width"} size="sm" active={phone} disabled={!live || boards} onClick={() => setPhone((value) => !value)}>
          <Smartphone size={13} />
        </IconButton>
        <IconButton
          label={boards ? "One page" : "Phone, tablet, and desktop side by side"}
          size="sm"
          active={boards}
          disabled={!live}
          onClick={() => {
            if (pickingHere) void stopPicking()
            setArtboards(tab.id, !boards)
          }}
        >
          <MonitorSmartphone size={13} />
        </IconButton>
        <IconButton
          label="Open in your browser"
          size="sm"
          disabled={current === undefined}
          onClick={() => {
            if (native && live) host.previewExternal(tab.id).catch(() => undefined)
            else if (current !== undefined) void openUrl(current)
          }}
        >
          <SquareArrowOutUpRight size={13} />
        </IconButton>
      </div>
      {hint !== undefined && (
        <div className="browser-hint" role="alert">
          {hint}
        </div>
      )}
      {pickingHere && (
        <div className="browser-pick" role="status">
          <span>Click an element on the page to comment on it. Escape cancels.</span>
          <Button size="sm" variant="ghost" onClick={() => void stopPicking()}>
            Cancel
          </Button>
        </div>
      )}
      {picked !== undefined && <CommentForm threadId={threadId} picked={picked} />}
      <div ref={frame} className={cx("browser-frame", phone && !boards && "is-phone", boards && "is-artboards")}>
        {phase.kind === "blank" && (
          <EmptyState icon={<Globe size={20} />} title="Preview a page">
            <p>{keepsSignIns ? "Type an address above. This project keeps its browser sign-ins (Settings, Projects); pages cannot reach Runrail." : "Type an address above. Pages here keep no cookies or storage, and cannot reach Runrail."}</p>
            {servers !== undefined && servers.length > 0 && (
              <div className="browser-servers">
                {servers.slice(0, 6).map((server) => (
                  <button key={server.port} type="button" className="chip" onClick={() => void open(`http://localhost:${String(server.port)}/`)}>
                    localhost:{server.port}
                    <span className="muted">{server.process}</span>
                  </button>
                ))}
              </div>
            )}
          </EmptyState>
        )}
        {phase.kind === "unreachable" && (
          <EmptyState icon={<Globe size={20} />} title={`Nothing answers at ${hostOf(phase.url)}`} actions={<Button size="sm" onClick={() => void open(phase.url)}>Try again</Button>}>
            Start the server, or check the port.
          </EmptyState>
        )}
        {phase.kind === "refused" && (
          <EmptyState icon={<Globe size={20} />} title="Runrail opens web addresses only">
            Pages must start with http or https, and cannot be Runrail itself.
          </EmptyState>
        )}
        {phase.kind === "failed" && (
          <EmptyState icon={<Globe size={20} />} title="The page could not be opened" actions={<Button size="sm" onClick={() => void open(phase.url)}>Try again</Button>}>
            {phase.message}
          </EmptyState>
        )}
        {phase.kind === "open" && boards && <Artboards threadId={threadId} tab={tab.id} url={page?.url ?? phase.url} covered={covered} />}
        {phase.kind === "open" && !boards && native && covered && <div className="browser-covered">{hostOf(phase.url)}</div>}
        {phase.kind === "open" && !boards && !native && <iframe className="browser-iframe" title={hostOf(phase.url)} src={phase.url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />}
      </div>
    </div>
  )
}

/** The comment on a picked element, which goes with the thread's next message. */
function CommentForm({ threadId, picked }: { readonly threadId: string; readonly picked: NonNullable<ReturnType<typeof usePicking.getState>["picked"]> }) {
  const [comment, setComment] = useState("")
  const add = (): void => {
    if (comment.trim().length === 0) return
    addPageComment(threadId, picked, comment)
    toast("success", "The comment goes with your next message")
  }
  return (
    <form
      className="browser-comment"
      onSubmit={(event) => {
        event.preventDefault()
        add()
      }}
    >
      <span className="browser-comment-target" title={picked.selector}>
        On {elementLabel(picked)}
        {picked.width !== undefined && <span className="muted"> at {picked.width} px</span>}
      </span>
      <input
        className="input input-sm"
        autoFocus
        aria-label={`Comment on ${elementLabel(picked)}`}
        placeholder="What should change here?"
        maxLength={MAX_PAGE_COMMENT}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            void stopPicking()
          }
        }}
      />
      <Button size="sm" type="submit" variant="primary" disabled={comment.trim().length === 0}>
        Add
      </Button>
      <IconButton label="Cancel" size="sm" onClick={() => void stopPicking()}>
        <X size={13} />
      </IconButton>
    </form>
  )
}

/** True until `span` after `at`, then false without another render from outside. */
function useRecent(at: number | undefined, span: number): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (at === undefined) return
    const left = at + span - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), left + 50)
    return () => clearTimeout(timer)
  }, [at, span])
  return at !== undefined && now < at + span
}

/** Whether the thread's agent may use this browser, and on which sites. Off unless the person turns it on. */
function AgentSwitch({ threadId, busy }: { readonly threadId: string; readonly busy: boolean }) {
  const thread = useThread(threadId)
  if (thread === undefined) return null
  const supported = takesBrowser(thread.backend)
  const on = supported && thread.browser?.agent === true
  const anySite = on && thread.browser?.anySite === true
  const name = BACKEND_LABELS[thread.backend]
  const label = !on ? "Agent browser use: off" : busy ? "The agent is using this page" : anySite ? "Agent browser use: on, any site" : "Agent browser use: on, this computer only"
  return (
    <Popover
      align="end"
      width={300}
      room={260}
      className="browser-agent-popover"
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          className={cx("icon-btn icon-btn-sm browser-agent-btn", on && "is-on", open && "is-active")}
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          title={label}
        >
          <MousePointerClick size={13} />
          {busy && <span className="browser-agent-dot" aria-hidden />}
        </button>
      )}
    >
      {() => (
        <div className="browser-agent-card" tabIndex={-1} data-autofocus="">
          <div className="browser-agent-row">
            <div className="browser-agent-text">
              <span className="browser-agent-title">Let the agent use the browser</span>
              <span className="browser-agent-note">{supported ? `${name} can open, read, click, and type in this thread's browser tab.` : `${name} cannot use the browser yet.`}</span>
            </div>
            <Toggle checked={on} disabled={!supported} label="Let the agent use the browser" onChange={(agent) => setBrowserUse(threadId, { agent, anySite: false })} />
          </div>
          <div className="browser-agent-row">
            <div className="browser-agent-text">
              <span className="browser-agent-title">Any site, not only this computer</span>
              <span className="browser-agent-note">Off, the agent opens localhost pages only. Any page can hold text written to steer the agent.</span>
            </div>
            <Toggle checked={anySite} disabled={!on} label="Any site, not only this computer" onChange={(value) => setBrowserUse(threadId, { agent: true, anySite: value })} />
          </div>
          <div className="browser-agent-sep" />
          <p className="browser-agent-note">Each script the agent wants to run in a page asks you first.</p>
          <p className="browser-agent-note">A change restarts the agent; a turn in progress finishes first.</p>
          {thread.backend === "codex" && <p className="browser-agent-note">Codex has the browser only in conversations it starts while this is on.</p>}
        </div>
      )}
    </Popover>
  )
}
