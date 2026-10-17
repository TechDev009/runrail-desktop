import { ArchiveRestore, Bug, Columns3, Download, FileSearch, FolderOpen, History, MessageCircle, Plug, Sparkles, TestTube } from "lucide-react"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { connectModel, openDialog, pickProject, workspaceOf } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import type { Connection } from "../../app/connections"
import { detectTools, type ToolConnection } from "../../app/connectionSettings"
import { notePainted, watchPaint } from "../../app/diagnostics"
import { archiveThread, ensureEngine, peekThread, refreshGit } from "../../app/engines"
import { recheckProject } from "../../app/gitBar"
import { anyConnected, type CodingTool } from "../../app/picker"
import { useWords } from "../../app/platformWords"
import { DEFAULT_SHORTCUT, useQuick } from "../../app/quick"
import { closeThreadPane, focusPane, set, toast, useApp } from "../../app/store"
import { bringInTurns, checkNewTurns, EXTERNAL_LABELS } from "../../app/workflows"
import { toHostError } from "../../host"
import { isMac } from "../../lib/format"
import { Button, cx, Kbd } from "../common"
import { countText } from "../connections/text"
import { useProject, useRuntime, useThread } from "../hooks"
import { FlowerMark } from "../seasonal"
import { isBusy, latestPlan } from "../../thread/reducer"
import { Composer } from "./Composer"
import { LivePlan } from "./rows"
import { DrawerButtons, ThreadHeader, type DrawerControls, type PaneControls } from "./ThreadHeader"
import { Timeline } from "./Timeline"

/** The main column: an open thread, the new-thread composer for a project, or first-run welcome. */

export function ThreadView({ drawer }: { readonly drawer?: DrawerControls } = {}) {
  const threadId = useApp((state) => state.layout.activeThreadId)
  const projectId = useApp((state) => state.layout.activeProjectId ?? state.projects[0]?.id)
  const thread = useThread(threadId)
  if (thread !== undefined) return <OpenThread threadId={thread.id} projectId={thread.projectId} {...(drawer === undefined ? {} : { drawer })} />
  if (projectId !== undefined) return <NewThread projectId={projectId} {...(drawer === undefined ? {} : { drawer })} />
  return <Welcome />
}

/**
 * Threads side by side: each pane is a whole thread with its own composer.
 * Pointing into a pane focuses it, and the side panel and the title follow.
 */
export function SplitView({ panes }: { readonly panes: readonly string[] }) {
  const active = useApp((state) => state.layout.activeThreadId)
  return (
    <main className="split-view" aria-label="Threads side by side">
      {panes.map((id) => (
        <SplitPane key={id} threadId={id} focused={id === active} />
      ))}
    </main>
  )
}

function SplitPane({ threadId, focused }: { readonly threadId: string; readonly focused: boolean }) {
  const thread = useThread(threadId)
  if (thread === undefined) return null
  return (
    <section className={cx("split-pane", focused && "is-focused")} aria-label={thread.title} onPointerDownCapture={() => focusPane(threadId)} onFocusCapture={() => focusPane(threadId)}>
      <OpenThread threadId={threadId} projectId={thread.projectId} pane={{ focused, close: () => closeThreadPane(threadId) }} />
    </section>
  )
}

/** The session this thread imported gained turns in its tool since; one click brings them in. */
function NewTurns({ threadId }: { readonly threadId: string }) {
  const turns = useApp((state) => state.runtime[threadId]?.newTurns)
  const source = useApp((state) => state.threads.find((item) => item.id === threadId)?.importedFrom?.source)
  const busy = useApp((state) => { const timeline = state.runtime[threadId]?.timeline; return timeline !== undefined && isBusy(timeline) })
  const [bringing, setBringing] = useState(false)
  if (turns === undefined || source === undefined) return null
  const count = `${String(turns)} new turn${turns === 1 ? "" : "s"}`
  const bring = () => {
    setBringing(true)
    bringInTurns(threadId)
      .catch((error: unknown) => toast("error", `Could not bring in the new turns: ${toHostError(error).message}`))
      .finally(() => setBringing(false))
  }
  return (
    <div className="new-turns" role="status">
      <Download size={13} aria-hidden />
      <span className="new-turns-text">{EXTERNAL_LABELS[source]} added {count} to this session since you imported it.</span>
      <Button size="sm" loading={bringing} disabled={busy} onClick={bring}>
        Bring in {count}
      </Button>
    </div>
  )
}

function OpenThread({ threadId, projectId, drawer, pane }: { readonly threadId: string; readonly projectId: string; readonly drawer?: DrawerControls; readonly pane?: PaneControls }) {
  const runtime = useRuntime(threadId)
  const workspace = workspaceOf(threadId)
  const archived = useApp((state) => state.threads.find((item) => item.id === threadId)?.archived === true)
  // The running turn's plan; the timeline shows it once the turn is over.
  const livePlan = useMemo(() => {
    const timeline = runtime.timeline
    if (!isBusy(timeline) || timeline.activeTurnId === undefined) return undefined
    const plan = latestPlan(timeline)
    return plan?.turnId === timeline.activeTurnId && plan.steps.length > 0 ? plan : undefined
  }, [runtime.timeline])

  // Opening a thread starts (or reattaches) its engine and loads its history.
  useEffect(() => {
    // An archived thread starts no engine; its history is read from the transcript alone.
    if (archived) {
      void peekThread(threadId)
      return
    }
    ensureEngine(threadId)
      .then(() => checkNewTurns(threadId))
      .catch((error: unknown) => {
        const failure = toHostError(error)
        // Both are told under the composer, with what to do.
        if (failure.code !== "CONNECTION_REMOVED" && failure.code !== "WORKSPACE_MISSING") toast("error", `Agent could not start: ${failure.message}`)
      })
    void refreshGit(threadId)
    void recheckProject(projectId)
  }, [threadId, projectId, archived])

  const items = runtime.timeline.items.length
  // History is on screen once the engine read it, or earlier, once the system engine peeked it.
  const drawn = runtime.historyLoaded || items > 0
  // Click to drawn history, for Settings → Advanced. Only the first draw after a switch counts.
  useEffect(() => watchPaint(threadId, drawn), [threadId])
  useEffect(() => {
    if (drawn) notePainted(threadId, items)
  }, [threadId, drawn])

  // A pane sits inside the split view's own landmark.
  const Root = pane === undefined ? "main" : "div"
  return (
    <Root className="thread-view" aria-label="Thread">
      <ThreadHeader threadId={threadId} {...(drawer === undefined ? {} : { drawer })} {...(pane === undefined ? {} : { pane })} />
      {archived ? (
        <div className="archived-note">
          <History size={14} /> This thread is archived. Restore it to continue.
          <Button size="sm" icon={<ArchiveRestore size={13} />} onClick={() => void archiveThread(threadId, false)}>
            Restore
          </Button>
        </div>
      ) : null}
      <Timeline threadId={threadId} runtime={runtime} {...(workspace === undefined ? {} : { workspace })} />
      {!archived && (
        <div className="composer-dock">
          {livePlan !== undefined && <LivePlan steps={livePlan.steps} {...(livePlan.explanation === undefined ? {} : { explanation: livePlan.explanation })} />}
          <NewTurns threadId={threadId} />
          <Composer threadId={threadId} projectId={projectId} />
        </div>
      )}
    </Root>
  )
}

/** Starters for a new thread; `git` ones only in a git repository. A starter fills the box or opens a dialog. */
export type Starter = { readonly icon: ReactNode; readonly label: string; readonly git?: true } & ({ readonly prompt: string } | { readonly dialog: "best-of-n" | "import" })

export const STARTERS: readonly Starter[] = [
  { icon: <FileSearch size={13} />, label: "Explain this codebase", prompt: "Give me a tour of this codebase: the main modules, how they fit together, and where to start reading." },
  { icon: <Bug size={13} />, label: "Find and fix a bug", prompt: "Run the tests, find the first failure, and fix its root cause." },
  { icon: <TestTube size={13} />, label: "Add missing tests", prompt: "Find an important module with weak test coverage and add focused tests for it." },
  { icon: <Sparkles size={13} />, label: "Review my changes", prompt: "Review the uncommitted changes in this repository for bugs, risky edge cases, and missing tests.", git: true },
  { icon: <Columns3 size={13} />, label: "Best of N", dialog: "best-of-n", git: true },
  { icon: <History size={13} />, label: "Continue a session", dialog: "import" },
]

export function startersFor(git: boolean): readonly Starter[] {
  return git ? STARTERS : STARTERS.filter((starter) => starter.git !== true)
}

/**
 * Starters show only on a thread not started yet (one is made on its first send), while its box is
 * empty; a project with no model to run gets the way to connect one instead.
 */
export function startersShown(draft: string, unconnected: boolean): boolean {
  return draft.trim().length === 0 && !unconnected
}

/** A thread not started yet: the header, an empty history, and the box where it sits in any thread. */
function NewThread({ projectId, drawer }: { readonly projectId: string; readonly drawer?: DrawerControls }) {
  const project = useProject(projectId)
  const draftKey = `new:${projectId}`
  const draft = useApp((state) => state.drafts[draftKey] ?? "")
  const palette = useApp((state) => state.prefs.palette)
  const catalog = useCatalog(projectId)
  useEffect(() => {
    void recheckProject(projectId)
  }, [projectId])
  // Known only once the list has loaded; a list that could not be read is reported in Settings instead.
  const unconnected = !catalog.loading && catalog.connectionsError === undefined && !anyConnected(catalog)
  if (project === undefined) return <Welcome />
  const start = (starter: Starter): void => {
    if ("dialog" in starter) openDialog({ kind: starter.dialog, projectId })
    else set((state) => ({ drafts: { ...state.drafts, [draftKey]: starter.prompt }, focusComposer: state.focusComposer + 1 }))
  }
  return (
    <main className="thread-view" aria-label="New thread">
      <header className="thread-header" data-tauri-drag-region>
        <div className="header-main" data-tauri-drag-region>
          <div className="header-line">
            <span className="header-title is-new">New thread</span>
          </div>
          <div className="header-meta" data-tauri-drag-region>
            <span className="header-project" title={project.path}>
              {project.name}
            </span>
          </div>
        </div>
        {drawer !== undefined && (
          <div className="header-actions">
            <DrawerButtons drawer={drawer} />
          </div>
        )}
      </header>
      <div className="new-thread-history" data-tauri-drag-region>
        {palette !== "default" && <FlowerMark flower={palette} />}
      </div>
      <div className="composer-dock">
        {unconnected ? (
          <div className="new-thread-lead">
            <div className="conn-first" role="status">
              <span className="conn-first-icon" aria-hidden>
                <Plug size={15} />
              </span>
              <div className="conn-first-text">
                <div className="conn-first-title">Connect a model to start</div>
                <div className="conn-first-body">Sign in with a subscription you already pay for, or paste an API key. Claude Code, Codex, GitHub Copilot, and Pi threads use the login those tools already have.</div>
              </div>
              <Button variant="primary" size="sm" onClick={() => connectModel()}>
                Connect a model
              </Button>
            </div>
          </div>
        ) : (
          startersShown(draft, unconnected) && (
            <div className="new-thread-lead starters" role="group" aria-label="Starters">
              {startersFor(project.git).map((starter) => (
                <button key={starter.label} type="button" className="starter" onClick={() => start(starter)}>
                  {starter.icon}
                  <span>{starter.label}</span>
                </button>
              ))}
            </div>
          )
        )}
        <Composer projectId={projectId} />
      </div>
    </main>
  )
}

/** The main column before any project is added: start something, or fix a connection. */
export function Welcome() {
  return (
    <main className="thread-view is-new" aria-label="Welcome">
      <header className="thread-header is-bare" data-tauri-drag-region />
      <div className="welcome">
        <div className="welcome-head">
          <img className="welcome-icon" src="/runrail-icon.png" width={30} height={30} alt="" />
          <h1 className="welcome-title">What are we building?</h1>
        </div>
        <WelcomeCards />
        <StatusStrip />
      </div>
    </main>
  )
}

function WelcomeCards() {
  const words = useWords()
  const quick = useQuick((state) => state.status)
  const shortcut = quick?.enabled === false ? undefined : (quick?.shortcut ?? quick?.defaultShortcut ?? DEFAULT_SHORTCUT)
  return (
    <div className="welcome-cards">
      <button type="button" className="welcome-card" onClick={() => void pickProject()}>
        <FolderOpen size={16} aria-hidden />
        <Kbd keys="mod+o" className="welcome-card-kbd" />
        <span className="welcome-card-title">Open a folder</span>
        <span className="welcome-card-text">A project on this {words.computer}</span>
      </button>
      <button type="button" className="welcome-card" onClick={() => openDialog({ kind: "create-project", where: "new" })}>
        <Sparkles size={16} aria-hidden />
        <span className="welcome-card-title">New app</span>
        <span className="welcome-card-text">Nifra, Vite, Next.js, or empty</span>
      </button>
      {/* The host has no call that opens quick chat's window, so this card only teaches its shortcut. */}
      <div className="welcome-card is-hint">
        <MessageCircle size={16} aria-hidden />
        {shortcut !== undefined && <Kbd keys={quickChatKeys(shortcut, isMac)} className="welcome-card-kbd" />}
        <span className="welcome-card-title">Quick chat</span>
        <span className="welcome-card-text">{shortcut === undefined ? "Turned off in Settings" : "Ask anything, no project"}</span>
      </div>
    </div>
  )
}

const KBD_MODIFIERS: Readonly<Record<string, string>> = { Alt: "alt", Option: "alt", Shift: "shift", Control: "ctrl", Ctrl: "ctrl" }
const COMMAND_KEYS: ReadonlySet<string> = new Set(["Command", "Cmd", "Super", "Meta"])

/** Quick chat's shortcut, in the shortcut plugin's words ("Alt+Space"), as the keys Kbd draws. */
export function quickChatKeys(shortcut: string, mac: boolean): string {
  return shortcut
    .split("+")
    .map((part) => {
      if (part === "CmdOrCtrl" || part === "CommandOrControl") return mac ? "mod" : "ctrl"
      if (COMMAND_KEYS.has(part)) return mac ? "mod" : "Super"
      return KBD_MODIFIERS[part] ?? part.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "")
    })
    .join("+")
}

export interface WelcomeChip {
  readonly key: string
  readonly text: string
  /** The dot's meaning in words, for a screen reader and the tooltip. */
  readonly label: string
  readonly tone: "ok" | "warn" | "off"
  readonly fix: "connections" | "connect"
}

/**
 * One chip per coding tool that is on, by what the engine last found (its usual login only; a
 * separate account or a key is not asked here), then one for Runrail's own models. `connections`
 * is undefined until the list has loaded, so the count never reads zero by mistake.
 */
export function welcomeChips(tools: readonly ToolConnection[], found: readonly CodingTool[], connections: readonly Connection[] | undefined): readonly WelcomeChip[] {
  const chips = tools
    .filter((tool) => tool.enabled)
    .map((tool): WelcomeChip => {
      const usual = tool.authMode === "subscription" && !tool.separateAccount ? found.find((entry) => entry.id === tool.tool) : undefined
      if (usual?.available === false) return { key: tool.id, text: `${tool.label} · Not installed`, label: `${tool.label}, not installed`, tone: "warn", fix: "connections" }
      if (usual?.signedIn === false) return { key: tool.id, text: `${tool.label} · Sign in`, label: `${tool.label}, not signed in`, tone: "warn", fix: "connections" }
      if (usual?.signedIn === true) return { key: tool.id, text: tool.label, label: `${tool.label}, signed in`, tone: "ok", fix: "connections" }
      return { key: tool.id, text: tool.label, label: tool.label, tone: "off", fix: "connections" }
    })
  if (connections === undefined) return chips
  const ready = connections.filter((connection) => connection.status === "ready" && connection.enabled !== false).length
  const own: WelcomeChip = ready === 0 ? { key: "runrail", text: "Connect a model", label: "Runrail, no model connected", tone: "off", fix: "connect" } : { key: "runrail", text: `Runrail · ${countText(ready, "model")}`, label: `Runrail, ${countText(ready, "model")} connected`, tone: "ok", fix: "connections" }
  return [...chips, own]
}

function StatusStrip() {
  const catalog = useCatalog(undefined)
  const [found, setFound] = useState<readonly CodingTool[]>([])
  const tools = catalog.tools ?? []
  const asks = tools.some((tool) => tool.enabled && tool.authMode === "subscription" && !tool.separateAccount)
  useEffect(() => {
    if (!asks) return
    let live = true
    // Cached for the session: the engine looked for the tools once, and this only reads that.
    void detectTools().then((value) => {
      if (live) setFound(value)
    })
    return () => {
      live = false
    }
  }, [asks])
  const known = !catalog.loading || catalog.connections.length > 0 || catalog.tools !== undefined
  const chips = welcomeChips(tools, found, known ? catalog.connections : undefined)
  return (
    <div className="welcome-strip" role="group" aria-label="Connections">
      {chips.map((chip) => (
        <button key={chip.key} type="button" className="welcome-chip" title={chip.label} aria-label={chip.label} onClick={() => (chip.fix === "connect" ? connectModel() : set({ settings: "connections" }))}>
          <span className={cx("welcome-dot", `is-${chip.tone}`)} aria-hidden />
          {chip.text}
        </button>
      ))}
      <span className="welcome-hint">
        <Kbd keys="mod+k" /> commands
      </span>
    </div>
  )
}
