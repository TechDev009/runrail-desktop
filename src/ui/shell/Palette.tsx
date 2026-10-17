import {
  Archive,
  Bell,
  Building2,
  Columns3,
  FileDiff,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Globe,
  Hand,
  Import,
  Keyboard,
  KeyRound,
  ListChecks,
  LogOut,
  Moon,
  PanelLeft,
  PanelRight,
  Plug,
  Blocks,
  Search,
  Settings,
  Share2,
  Shrink,
  SquarePen,
  SquareTerminal,
  Sun,
  Workflow,
  Zap,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { confirmAction, connectModel, openDialog, pickProject, startNewThread, switchModel } from "../../app/actions"
import { showArchivedThreads } from "../../app/archive"
import { useCatalog, useFiles } from "../../app/catalog"
import { setInboxOpen } from "../../app/inbox"
import { setTrayOpen } from "../../app/triage"
import { setOfficeMode, showList, showOffice } from "../../app/office"
import { signOutConnection, type Connection } from "../../app/connections"
import { compactThread, threadCapability } from "../../app/engines"
import { newPanelTab, openPanel } from "../../app/panels"
import { activeProject, activeThread, get, openThread, set, setLayout, setPrefs, toast, useApp } from "../../app/store"
import { proposeWorkflowFrom } from "../../app/workflowRuns"
import { shareOffered } from "../../app/workflows"
import { toHostError } from "../../host"
import { relativeTime, tildify } from "../../lib/format"
import { fuzzyScore } from "../../lib/fuzzy"
import { previewFile } from "../../app/filePreview"
import { cx, Kbd, StatusIcon } from "../common"
import { saveProblemText, signOutTargets } from "../connections/text"
import { useActiveIds, useStatuses } from "../hooks"

/** ⌘K: jump to any thread, project, file, or command from one fuzzy list. */

interface Entry {
  readonly id: string
  readonly group: "Threads" | "Projects" | "Files" | "Commands"
  readonly label: string
  readonly detail?: string
  readonly icon: ReactNode
  readonly kbd?: string
  readonly keywords?: string
  readonly run: () => void
}

/** Subsequence match or undefined; fuzzyScore alone cannot tell "no match" from a low score. */
function hit(query: string, text: string): number | undefined {
  const lower = text.toLowerCase()
  let position = 0
  for (const char of query.toLowerCase()) {
    const found = lower.indexOf(char, position)
    if (found < 0) return undefined
    position = found + 1
  }
  return fuzzyScore(query, text)
}

const GROUP_ORDER: readonly Entry["group"][] = ["Commands", "Threads", "Projects", "Files"]

function signOut(connection: Connection): void {
  confirmAction({
    title: `Sign out of ${connection.label}?`,
    body: "The stored sign-in is deleted. The connection stays in the list, so you can sign in again later.",
    confirm: "Sign out",
    onConfirm: () =>
      void signOutConnection(connection.id).then(
        () => toast("success", `Signed out of ${connection.label}.`),
        (error: unknown) => toast("error", saveProblemText(toHostError(error).code)),
      ),
  })
}

export function paletteCommands(connections: readonly Connection[]): Entry[] {
  const thread = activeThread()
  const project = activeProject()
  const out: Entry[] = [
    { id: "new", group: "Commands", label: "New thread", icon: <SquarePen size={14} />, kbd: "mod+n", run: () => startNewThread() },
    { id: "open", group: "Commands", label: "Open project…", icon: <FolderPlus size={14} />, kbd: "mod+o", run: () => void pickProject() },
    { id: "connect", group: "Commands", label: "Connect a model…", detail: "Subscription, API key, or local model", keywords: "provider api key subscription sign in login add chatgpt openai anthropic claude openrouter ollama", icon: <Plug size={14} />, run: () => connectModel() },
    { id: "connections", group: "Commands", label: "Manage connections", keywords: "providers keys accounts models sign out remove rename test", icon: <KeyRound size={14} />, run: () => set({ settings: "connections" }) },
    { id: "settings", group: "Commands", label: "Settings", icon: <Settings size={14} />, kbd: "mod+,", run: () => set({ settings: "general" }) },
    { id: "shortcuts", group: "Commands", label: "Keyboard shortcuts", icon: <Keyboard size={14} />, kbd: "mod+/", run: () => set({ settings: "shortcuts" }) },
    { id: "sidebar", group: "Commands", label: "Show or hide the threads list", keywords: "sidebar toggle", icon: <PanelLeft size={14} />, kbd: "mod+b", run: () => setLayout({ sidebarOpen: !get().layout.sidebarOpen }) },
    { id: "workflows", group: "Commands", label: "Workflows", icon: <Workflow size={14} />, keywords: "automations schedule cron trigger", run: () => set({ view: { kind: "workflows" } }) },
    { id: "integrations", group: "Commands", label: "Integrations", icon: <Blocks size={14} />, keywords: "connectors github linear slack jira mcp servers plugins packages skills extensions", run: () => set({ view: { kind: "integrations" } }) },
    { id: "integrations-grants", group: "Commands", label: "Who may use what", icon: <Blocks size={14} />, keywords: "integrations roles permissions connectors grants", run: () => set({ view: { kind: "integrations", section: "grants" } }) },
    { id: "archived", group: "Commands", label: "Show archived threads", keywords: "archive restore unarchive delete hidden old", icon: <Archive size={14} />, run: () => showArchivedThreads() },
    { id: "notifications", group: "Commands", label: "Notifications", icon: <Bell size={14} />, keywords: "inbox finished failed approval", run: () => setInboxOpen(true) },
    get().prefs.officeMode === "off"
      ? { id: "office-on", group: "Commands", label: "Turn on office mode", detail: "Projects as rooms, threads as people at desks", keywords: "office floor rooms people pixel game", icon: <Building2 size={14} />, run: () => { setOfficeMode(true); showOffice() } }
      : get().view.kind === "office"
        ? { id: "office-list", group: "Commands", label: "Show the thread list", keywords: "office list sidebar threads", icon: <Building2 size={14} />, run: () => showList() }
        : { id: "office", group: "Commands", label: "Show the office", keywords: "office floor rooms people", icon: <Building2 size={14} />, run: () => showOffice() },
    { id: "waiting", group: "Commands", label: "Waiting on you", detail: "Approvals, failures, and quiet or finished threads", keywords: "triage tray approve deny hand quiet stuck", icon: <Hand size={14} />, kbd: "mod+i", run: () => setTrayOpen(true) },
    {
      id: "theme",
      group: "Commands",
      label: "Toggle light/dark theme",
      icon: document.documentElement.dataset.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />,
      run: () => setPrefs({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }),
    },
  ]
  if (project !== undefined) {
    out.push({ id: "switch-model", group: "Commands", label: "Switch model", detail: "Model and reasoning level", keywords: "change pick choose reasoning thinking effort", icon: <Zap size={14} />, run: () => switchModel() })
    out.push({ id: "import", group: "Commands", label: "Import session…", detail: "Claude Code, Codex, OpenCode, Gemini CLI, and more", keywords: "continue transcript history", icon: <Import size={14} />, run: () => openDialog({ kind: "import", projectId: project.id }) })
    if (project.git) out.push({ id: "best-of", group: "Commands", label: "Best of N…", detail: "Run one prompt on several models", keywords: "compare parallel candidates", icon: <Columns3 size={14} />, run: () => openDialog({ kind: "best-of-n", projectId: project.id }) })
  }
  if (thread !== undefined) {
    out.push({ id: "workflow-from-thread", group: "Commands", label: "Make a workflow from this thread", detail: "An agent proposes one; nothing runs until you approve it", keywords: "automate repeat schedule propose", icon: <Workflow size={14} />, run: () => proposeWorkflowFrom(thread.id) })
    out.push(
      { id: "review", group: "Commands", label: "Review changes", icon: <FileDiff size={14} />, kbd: "mod+shift+d", run: () => openPanel(thread.id, "review") },
      { id: "files", group: "Commands", label: "Browse files", icon: <FolderTree size={14} />, kbd: "mod+p", run: () => openPanel(thread.id, "files") },
      { id: "terminal", group: "Commands", label: "Open terminal", icon: <SquareTerminal size={14} />, kbd: "mod+j", run: () => openPanel(thread.id, "terminal") },
      { id: "new-terminal", group: "Commands", label: "New terminal tab", icon: <SquareTerminal size={14} />, run: () => newPanelTab(thread.id, "terminal") },
      { id: "tasks", group: "Commands", label: "Tasks", detail: "Running agents and commands", keywords: "background agents subagents processes servers", icon: <ListChecks size={14} />, kbd: "mod+shift+a", run: () => openPanel(thread.id, "tasks") },
      { id: "browser", group: "Commands", label: "Browser preview", keywords: "web localhost page site", icon: <Globe size={14} />, kbd: "mod+shift+b", run: () => openPanel(thread.id, "browser") },
      { id: "panel", group: "Commands", label: "Toggle side panel", icon: <PanelRight size={14} />, kbd: "mod+alt+b", run: () => setLayout({ inspectorOpen: !get().layout.inspectorOpen }) },
      ...(threadCapability(thread.id, "session.compact") ? [{ id: "compact", group: "Commands" as const, label: "Compact context", icon: <Shrink size={14} />, run: () => void compactThread(thread.id) }] : []),
      ...(shareOffered(get().prefs.developer) ? [{ id: "share", group: "Commands" as const, label: "Share thread…", icon: <Share2 size={14} />, run: () => openDialog({ kind: "share", threadId: thread.id }) }] : []),
    )
  }
  for (const connection of signOutTargets(connections)) {
    out.push({ id: `sign-out:${connection.id}`, group: "Commands", label: `Sign out of ${connection.label}`, keywords: "logout log out disconnect account subscription", icon: <LogOut size={14} />, run: () => signOut(connection) })
  }
  return out
}

export function Palette() {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const threads = useApp((state) => state.threads)
  const projects = useApp((state) => state.projects)
  const statuses = useStatuses()
  const { threadId, projectId } = useActiveIds()
  const files = useFiles(threadId, projectId, query.trim().length > 0)
  const connections = useCatalog(undefined).connections
  const close = (): void => set({ palette: false })

  useEffect(() => input.current?.focus(), [])

  const results = useMemo(() => {
    const q = query.trim()
    const pool: Entry[] = [
      ...paletteCommands(connections),
      ...threads
        .filter((thread) => thread.archived !== true || q.length > 0)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((thread) => ({
          id: `t:${thread.id}`,
          group: "Threads" as const,
          label: thread.title,
          detail: `${projects.find((project) => project.id === thread.projectId)?.name ?? ""} · ${relativeTime(thread.updatedAt)}${thread.archived === true ? " · archived" : ""}`,
          icon: <StatusIcon status={statuses[thread.id] ?? "idle"} size={13} />,
          run: () => openThread(thread.id),
        })),
      ...projects.map((project) => ({
        id: `p:${project.id}`,
        group: "Projects" as const,
        label: project.name,
        detail: tildify(project.path),
        icon: <FolderOpen size={14} />,
        run: () => startNewThread(project.id),
      })),
    ]
    if (q.length === 0) {
      const recent = pool.filter((entry) => entry.group === "Threads").slice(0, 6)
      const common = pool.filter((entry) => entry.group === "Commands").slice(0, 6)
      return [...recent, ...common]
    }
    const fileEntries: Entry[] = files.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        id: `f:${entry.path}`,
        group: "Files" as const,
        label: entry.path.slice(entry.path.lastIndexOf("/") + 1),
        detail: entry.path,
        icon: <FileText size={14} />,
        run: () => {
          if (threadId !== undefined) previewFile(threadId, entry.path)
        },
      }))
    const scored: { entry: Entry; score: number }[] = []
    for (const entry of [...pool, ...(threadId === undefined ? [] : fileEntries)]) {
      const label = hit(q, entry.label)
      const extra = hit(q, `${entry.keywords ?? ""} ${entry.detail ?? ""}`)
      const score = label ?? (extra === undefined ? undefined : extra - 300)
      if (score !== undefined) scored.push({ entry, score: score + (entry.group === "Commands" ? 50 : entry.group === "Files" ? -100 : 0) })
    }
    scored.sort((left, right) => right.score - left.score)
    const top = scored.slice(0, 60).map((item) => item.entry)
    return GROUP_ORDER.flatMap((group) => top.filter((entry) => entry.group === group))
  }, [query, threads, projects, statuses, files.entries, threadId, connections])

  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${String(cursor)}"]`)?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  const choose = (entry: Entry | undefined): void => {
    if (entry === undefined) return
    close()
    entry.run()
  }

  let lastGroup: string | undefined
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={15} />
          <input
            ref={input}
            value={query}
            placeholder="Search threads, projects, files, and commands"
            aria-label="Search"
            aria-controls="palette-list"
            aria-activedescendant={results[cursor] === undefined ? undefined : `palette-${String(cursor)}`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setCursor((value) => Math.min(value + 1, results.length - 1))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setCursor((value) => Math.max(value - 1, 0))
              } else if (event.key === "Enter") {
                event.preventDefault()
                choose(results[cursor])
              } else if (event.key === "Escape") {
                event.preventDefault()
                close()
              }
            }}
          />
          <Kbd keys="esc" />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {results.length === 0 ? (
            <div className="popup-empty">{files.loading ? "Searching…" : `Nothing matches “${query}”.`}</div>
          ) : (
            results.map((entry, index) => {
              const heading = entry.group !== lastGroup ? (query.trim().length === 0 && entry.group === "Threads" ? "Recent threads" : entry.group) : undefined
              lastGroup = entry.group
              return (
                <div key={entry.id}>
                  {heading !== undefined && <div className="palette-group">{heading}</div>}
                  <button
                    type="button"
                    id={`palette-${String(index)}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === cursor}
                    className={cx("palette-item", index === cursor && "is-active")}
                    onMouseMove={() => index !== cursor && setCursor(index)}
                    onClick={() => choose(entry)}
                  >
                    <span className="palette-icon">{entry.icon}</span>
                    <span className="palette-label">{entry.label}</span>
                    {entry.detail !== undefined && <span className="palette-detail">{entry.detail}</span>}
                    {entry.kbd !== undefined && <Kbd keys={entry.kbd} />}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd keys="↑" /> <Kbd keys="↓" /> navigate
          </span>
          <span>
            <Kbd keys="enter" /> open
          </span>
          <span className="muted">
            <Archive size={11} /> archived threads appear when you search
          </span>
        </div>
      </div>
    </div>
  )
}
