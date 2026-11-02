import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal, type ILinkHandler } from "@xterm/xterm"
import { RotateCcw, SquareTerminal, X } from "lucide-react"
import { useEffect, useRef } from "react"
import { create } from "zustand"
import { openUrl } from "../../app/actions"
import { threadRpc } from "../../app/engines"
import { newPanelTab, panelOf } from "../../app/panels"
import { newId, PANEL_LIMITS } from "../../app/persist"
import { get, set, useApp } from "../../app/store"
import { appKeyInTerminal } from "../../app/windowKeys"
import { isUnsupported, toHostError } from "../../host"
import { Button, cx, EmptyState, IconButton, Spinner } from "../common"
import { dropTermMeta, patchTermMeta, useTermMeta } from "./terminalMeta"
import { registerTerminalClosers } from "./terminalRegistry"
import { forgetInlineRun, forgetInlineRunsForThread, rememberInlineRun, useInlineRuns } from "./inlineRuns"

/**
 * Terminal tabs: shells owned by the engine (never the renderer), shown through xterm. The xterm
 * instances live outside React and are re-parented into the pane, so switching threads or tabs
 * never loses scrollback. A tab restored after a restart starts a fresh shell when it shows.
 */

const useSupport = create<Readonly<Record<string, "unknown" | "yes" | "no">>>()(() => ({}))

interface Live {
  readonly threadId: string
  readonly term: Terminal
  readonly fit: FitAddon
  readonly element: HTMLDivElement
  lastSeq: number
  cols: number
  rows: number
  /** Set once the shell was asked for, so it starts at the size the pane measured. */
  started: boolean
  writes: Promise<unknown>
}

const live = new Map<string, Live>()

type TerminalTheme = NonNullable<NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"]>

/** Each xterm color and the token in styles/tokens.css it is drawn with. */
const TERMINAL_COLORS: Readonly<Partial<Record<keyof TerminalTheme, string>>> = {
  background: "--term-bg",
  foreground: "--term-fg",
  cursor: "--term-cursor",
  cursorAccent: "--term-bg",
  selectionBackground: "--term-selection",
  black: "--term-black",
  red: "--term-red",
  green: "--term-green",
  yellow: "--term-yellow",
  blue: "--term-blue",
  magenta: "--term-magenta",
  cyan: "--term-cyan",
  white: "--term-white",
  brightBlack: "--term-bright-black",
  brightRed: "--term-bright-red",
  brightGreen: "--term-bright-green",
  brightYellow: "--term-bright-yellow",
  brightBlue: "--term-bright-blue",
  brightMagenta: "--term-bright-magenta",
  brightCyan: "--term-bright-cyan",
  brightWhite: "--term-bright-white",
}

/**
 * What a terminal does with a hyperlink a program printed (OSC 8): what any other link in the app
 * does, instead of xterm's own confirm() and window.open() in the app's window.
 */
export function terminalLinks(threadId?: string): ILinkHandler {
  return { activate: (_event, uri) => void openUrl(uri, threadId) }
}

/** The terminal palette from the current theme's tokens. A token that is not set keeps xterm's own color. */
export function terminalTheme(): TerminalTheme {
  const style = getComputedStyle(document.documentElement)
  const colors: Record<string, string> = {}
  for (const [key, token] of Object.entries(TERMINAL_COLORS)) {
    const value = token === undefined ? "" : style.getPropertyValue(token).trim()
    if (value.length > 0) colors[key] = value
  }
  return colors as TerminalTheme
}

let themeWatch: MutationObserver | undefined

/** Repaints every open terminal when the theme, palette or accent changes, so no shell has to be reopened. */
function watchTheme(): void {
  if (themeWatch !== undefined || typeof MutationObserver === "undefined") return
  themeWatch = new MutationObserver(() => {
    const next = terminalTheme()
    for (const session of live.values()) session.term.options.theme = next
  })
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "data-palette"] })
}

/** Threads whose engine is being asked; an engine still starting is asked again, a little later each time. */
const describing = new Set<string>()
const DESCRIBE_TRIES = 8

export function describeSupport(threadId: string, attempt = 0): void {
  const current = useSupport.getState()[threadId]
  if (current === "yes" || current === "no" || (attempt === 0 && describing.has(threadId))) return
  describing.add(threadId)
  threadRpc(threadId, "terminal.describe", {})
    .then(() => {
      describing.delete(threadId)
      useSupport.setState({ [threadId]: "yes" })
    })
    .catch((error: unknown) => {
      const unsupported = isUnsupported(toHostError(error).code)
      useSupport.setState({ [threadId]: unsupported ? "no" : "unknown" })
      if (unsupported || attempt + 1 >= DESCRIBE_TRIES) return void describing.delete(threadId)
      setTimeout(() => describeSupport(threadId, attempt + 1), Math.min(1_000 * 2 ** attempt, 30_000))
    })
}

export function terminalSupport(threadId: string): "unknown" | "yes" | "no" {
  return useSupport.getState()[threadId] ?? "unknown"
}

interface InitialTerminalInput {
  readonly text: string
  readonly reportExit: boolean
}

/** Input typed after a new shell starts. Inline Run inputs also print their final exit status. */
const firstLines = new Map<string, InitialTerminalInput>()

export interface ThreadTerminalLaunch {
  readonly threadId?: string
  readonly terminalId?: string
  readonly error?: string
}

/** Preserve the code block as one shell-evaluated action, then report its resulting status. */
export function commandWithExitStatus(command: string): string {
  const quoted = `'${command.split("'").join("'\\''")}'`
  return `eval ${quoted}; __runrail_exit=$?; printf '\\n[Runrail exit status: %s]\\n' "$__runrail_exit"`
}

/** Creates a shell and submits its initial command only after terminal.create succeeds. */
export async function createTerminalAndSubmit(
  threadId: string,
  id: string,
  cols: number,
  rows: number,
  input: string | undefined,
  rpc: typeof threadRpc = threadRpc,
): Promise<void> {
  await rpc(threadId, "terminal.create", { sessionId: id, cols, rows })
  if (input !== undefined) await rpc(threadId, "terminal.write", { sessionId: id, data: `${input}\r` })
}

/** Opens a non-tab terminal for an assistant Run button, scoped to the thread that owns the reply. */
export function runInThreadTerminal(threadId: string, command: string, runKey?: string): ThreadTerminalLaunch {
  const thread = get().threads.find((item) => item.id === threadId)
  if (thread === undefined) return { error: "This thread is no longer available." }
  if (thread.archived === true) return { error: "Unarchive this thread before running a command." }
  if (terminalSupport(threadId) === "no") return { error: "This engine does not support an in-thread terminal." }
  const existing = runKey === undefined ? undefined : useInlineRuns.getState()[runKey]
  if (existing?.threadId === threadId) return existing
  const terminalsInTabs = panelOf(threadId).tabs.filter((tab) => tab.kind === "terminal").length
  const inlineTerminals = Object.values(useInlineRuns.getState()).filter((run) => run.threadId === threadId).length
  if (terminalsInTabs + inlineTerminals >= PANEL_LIMITS.terminal) return { error: "Close a terminal in this thread before running another code block." }
  const terminalId = newId("inline-terminal")
  firstLines.set(terminalId, { text: command, reportExit: true })
  if (runKey !== undefined) rememberInlineRun(runKey, { threadId, terminalId })
  return { threadId, terminalId }
}

/**
 * Opens a terminal tab in the thread on screen, brings it into view, and types `line` into its
 * shell, where the person sees it run and answers it. False when no thread is on screen.
 */
export function typeInNewTerminal(line: string): boolean {
  const threadId = get().layout.activeThreadId
  if (threadId === undefined || !get().threads.some((thread) => thread.id === threadId)) return false
  const id = newPanelTab(threadId, "terminal")
  if (id === undefined) return false
  firstLines.set(id, { text: line, reportExit: false })
  set({ view: { kind: "thread" }, dialog: undefined, settings: false })
  return true
}

async function start(threadId: string, id: string): Promise<void> {
  const session = live.get(id)
  if (session === undefined) return
  patchTermMeta(id, { status: "starting", error: undefined })
  try {
    const initial = firstLines.get(id)
    const input = initial === undefined ? undefined : initial.reportExit ? commandWithExitStatus(initial.text) : initial.text
    await createTerminalAndSubmit(threadId, id, session.cols, session.rows, input)
    patchTermMeta(id, { status: "running" })
    firstLines.delete(id)
  } catch (error) {
    patchTermMeta(id, { status: "failed", error: toHostError(error).message })
  }
}

/** The emulator for a terminal tab, made the first time the tab shows; its shell starts after the first fit. */
function ensureTerminal(threadId: string, id: string): Live {
  const existing = live.get(id)
  if (existing !== undefined) return existing
  const element = document.createElement("div")
  element.className = "term-host"
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-term")) || 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5_000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    theme: terminalTheme(),
    linkHandler: terminalLinks(threadId),
  })
  watchTheme()
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri, threadId)))
  if (document.documentElement.dataset.platform === "linux") term.attachCustomKeyEventHandler((event) => !appKeyInTerminal(event))
  const session: Live = { threadId, term, fit, element, lastSeq: -1, cols: 100, rows: 30, started: false, writes: Promise.resolve() }
  live.set(id, session)
  term.onData((data) => {
    session.writes = session.writes.then(() => threadRpc(threadId, "terminal.write", { sessionId: id, data }).catch(() => undefined))
    wake(id)
  })
  // Shells name the window after what runs in them; the tab shows that name.
  term.onTitleChange((title) => patchTermMeta(id, { title: title.replace(/[\u0000-\u001f]/g, "").slice(0, 60) || undefined }))
  patchTermMeta(id, { status: "starting" })
  return session
}

async function restart(threadId: string, id: string): Promise<void> {
  const session = live.get(id)
  if (session === undefined) return
  session.lastSeq = -1
  session.term.reset()
  await start(threadId, id)
  wake(id)
}

function closeOne(threadId: string, id: string): void {
  const session = live.get(id)
  const status = useTermMeta.getState()[id]?.status
  if (session !== undefined && session.started && (status === "running" || status === "starting")) void threadRpc(threadId, "terminal.close", { sessionId: id }).catch(() => undefined)
  session?.term.dispose()
  session?.element.remove()
  live.delete(id)
  firstLines.delete(id)
  dropTermMeta(id)
}

registerTerminalClosers({
  thread: (threadId) => {
    for (const [id, session] of [...live]) if (session.threadId === threadId) closeOne(threadId, id)
    for (const run of Object.values(useInlineRuns.getState())) if (run.threadId === threadId) closeOne(threadId, run.terminalId)
    forgetInlineRunsForThread(threadId)
  },
  one: closeOne,
})

// One poll loop per visible terminal. Inline Run terminals may coexist with inspector tabs.
interface TerminalPollLoop {
  timer?: ReturnType<typeof setTimeout>
  idleRounds: number
  reading: boolean
  wakeRequested: boolean
}

const pollLoops = new Map<string, TerminalPollLoop>()

function schedulePoll(id: string, delay: number): void {
  const loop = pollLoops.get(id)
  if (loop === undefined || loop.timer !== undefined || loop.reading) return
  loop.timer = setTimeout(() => void poll(id), delay)
}

function wake(id: string): void {
  const loop = pollLoops.get(id)
  if (loop === undefined) return
  loop.idleRounds = 0
  if (loop.reading) {
    loop.wakeRequested = true
    return
  }
  if (loop.timer !== undefined) clearTimeout(loop.timer)
  loop.timer = undefined
  schedulePoll(id, 16)
}

async function poll(id: string): Promise<void> {
  const loop = pollLoops.get(id)
  if (loop === undefined || loop.reading) return
  loop.timer = undefined
  const session = live.get(id)
  if (session === undefined) {
    setPollTarget(id, false)
    return
  }
  if (useTermMeta.getState()[id]?.status !== "running") {
    schedulePoll(id, 200)
    return
  }
  loop.reading = true
  try {
    const result = (await threadRpc(session.threadId, "terminal.read", { sessionId: id, afterSeq: session.lastSeq, maxBytes: 256 * 1_024 })) as { chunks?: unknown; closed?: unknown }
    const chunks = Array.isArray(result.chunks) ? (result.chunks as { seq?: unknown; data?: unknown }[]) : []
    for (const chunk of chunks) {
      if (typeof chunk.seq !== "number" || typeof chunk.data !== "string" || chunk.seq <= session.lastSeq) continue
      session.term.write(chunk.data)
      session.lastSeq = chunk.seq
    }
    loop.idleRounds = chunks.length > 0 ? 0 : loop.idleRounds + 1
    if (result.closed === true) {
      patchTermMeta(id, { status: "closed" })
      session.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n")
    }
  } catch (error) {
    const code = toHostError(error).code
    if (code === "CONTROL_TERMINAL_NOT_FOUND" || code === "CONTROL_NOT_FOUND") patchTermMeta(id, { status: "closed" })
    loop.idleRounds += 4
  } finally {
    loop.reading = false
    if (pollLoops.get(id) === loop) {
      const delay = loop.wakeRequested ? 0 : loop.idleRounds < 10 ? 60 : loop.idleRounds < 40 ? 150 : 400
      loop.wakeRequested = false
      schedulePoll(id, delay)
    }
  }
}

function setPollTarget(id: string, visible: boolean): void {
  if (visible) {
    if (pollLoops.has(id)) return
    pollLoops.set(id, { idleRounds: 0, reading: false, wakeRequested: false })
    schedulePoll(id, 0)
    return
  }
  const loop = pollLoops.get(id)
  if (loop?.timer !== undefined) clearTimeout(loop.timer)
  pollLoops.delete(id)
}

/** One terminal tab: its shell, shown through xterm. */
export function TerminalView({ threadId, terminalId }: { readonly threadId: string; readonly terminalId: string }) {
  const support = useSupport((state) => state[threadId] ?? "unknown")
  const meta = useTermMeta((state) => state[terminalId])
  const themeName = useApp((state) => state.prefs.theme)
  const mount = useRef<HTMLDivElement>(null)

  useEffect(() => describeSupport(threadId), [threadId])

  // Re-parent the xterm into the pane and keep it sized to the pane.
  useEffect(() => {
    const container = mount.current
    if (container === null || support !== "yes") return
    const session = ensureTerminal(threadId, terminalId)
    container.appendChild(session.element)
    if (session.element.childElementCount === 0) session.term.open(session.element)
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const refit = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      session.fit.fit()
      const { cols, rows } = session.term
      if (cols === session.cols && rows === session.rows) return
      session.cols = cols
      session.rows = rows
      if (!session.started) return
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => void threadRpc(threadId, "terminal.resize", { sessionId: terminalId, cols, rows }).catch(() => undefined), 120)
    }
    refit()
    // The shell starts after the first fit: a shell created wider than the pane wraps its first prompt.
    if (!session.started) {
      session.started = true
      void start(threadId, terminalId)
    }
    const observer = new ResizeObserver(refit)
    observer.observe(container)
    session.term.focus()
    setPollTarget(terminalId, true)
    return () => {
      observer.disconnect()
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      setPollTarget(terminalId, false)
      if (session.element.parentElement === container) container.removeChild(session.element)
    }
  }, [terminalId, threadId, support])

  useEffect(() => {
    const next = terminalTheme()
    for (const session of live.values()) session.term.options.theme = next
  }, [themeName])

  if (support === "no")
    return (
      <EmptyState icon={<SquareTerminal size={20} />} title="Terminal not available">
        This engine doesn't expose a terminal. Update Runrail or open the project in your own terminal from the header.
      </EmptyState>
    )

  return (
    <div className="terminal">
      <div className="terminal-body">
        <div ref={mount} className="terminal-mount" />
        {(support === "unknown" || meta?.status === "starting") && (
          <div className={cx("terminal-overlay", support !== "unknown" && "is-soft")}>
            <Spinner size={14} /> {support === "unknown" ? "Connecting…" : "Starting shell…"}
          </div>
        )}
        {meta?.status === "failed" && (
          <div className="terminal-overlay">
            <span>Shell failed to start{meta.error === undefined ? "." : `: ${meta.error}`}</span>
            <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => void restart(threadId, terminalId)}>
              Try again
            </Button>
          </div>
        )}
        {meta?.status === "closed" && (
          <div className="terminal-exit">
            <span>Process exited</span>
            <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => void restart(threadId, terminalId)}>
              Restart
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** A shell rendered inside the assistant message that launched it, never in the inspector tabs. */
export function InlineTerminalView({ threadId, terminalId, runKey }: { readonly threadId: string; readonly terminalId: string; readonly runKey: string }) {
  return (
    <section className="assistant-run-terminal" aria-label="In-thread terminal">
      <div className="assistant-run-terminal-head">
        <span><SquareTerminal size={13} aria-hidden="true" /> Terminal</span>
        <IconButton size="sm" label="Close terminal" onClick={() => { closeOne(threadId, terminalId); forgetInlineRun(runKey) }}>
          <X size={13} />
        </IconButton>
      </div>
      <TerminalView threadId={threadId} terminalId={terminalId} />
    </section>
  )
}
