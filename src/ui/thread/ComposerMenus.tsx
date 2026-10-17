import { AppWindowMac, ArrowLeft, AtSign, Bot, Check, ChevronDown, ChevronRight, Columns2, File, Folder, FolderGit2, GitBranch, GitPullRequest, Globe, ImagePlus, Laptop, ListTodo, MessagesSquare, MousePointerClick, Play, Plug, Plus, Search, Settings2, Shield, ShieldCheck, ShieldHalf, ShieldOff, Target, X, Zap } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ACCESS_LABELS, ACCESS_ORDER, offersAuto, type Access } from "../../app/access"
import { loadAndroidStatus, useAndroid } from "../../app/android"
import { takesBrowser } from "../../app/browserAgent"
import { computerPlace, loadComputerSetup, takesComputer, useComputerSetup } from "../../app/computerAgent"
import { loadSimulator, useSimulator } from "../../app/simulator"
import type { Catalog } from "../../app/catalog"
import { projectRpc, setBrowserUse, setComputerUse } from "../../app/engines"
import { useFiles } from "../../app/catalog"
import { setMcpEnabled, useMcpServers } from "../../app/mcp"
import { useProjectHeads } from "../../app/projectGit"
import { set, toast, useApp, type SettingsSection } from "../../app/store"
import { startView } from "../../app/threadBar"
import type { BackendId, McpServer } from "../../host/types"
import { toHostError } from "../../host"
import { relativeTime } from "../../lib/format"
import { rank } from "../../lib/fuzzy"
import { GitBranchesSchema, PullRequestListSchema, parseOr, type GitBranches, type PullRequestEntry } from "../../protocol/schemas"
import { branchRows, HEAD_START, pullRequestRows, startLabel, typedPullRequest, type WorktreeStart } from "../../app/worktreeStart"
import { cx, IconButton, Kbd, Menu, Popover, Spinner } from "../common"
import { openComputerSettings } from "../shell/revealSetting"
import { useThread } from "../hooks"

/**
 * The composer's menus. Access: Plan or a permission level, in one place. Add: images, files,
 * skills, subagents, MCP servers, working toward a goal, and browser use, searchable together.
 * Worktree: where a new thread works, and for a worktree, the branch or pull request it starts from.
 */

const ACCESS_ICON: Record<Access, ReactNode> = {
  plan: <ListTodo size={14} />,
  ask: <Shield size={14} />,
  "auto-edit": <ShieldCheck size={14} />,
  auto: <ShieldHalf size={14} />,
  full: <ShieldOff size={14} />,
}

const ACCESS_HINT: Record<Access, string> = {
  plan: "Reads and proposes a plan. Changes nothing",
  ask: "Asks before edits and commands",
  "auto-edit": "Edits files freely, asks before commands",
  auto: "A reviewer approves routine actions and stops risky ones",
  full: "Runs anything without asking",
}

/** Auto is the tool's own reviewer, offered only where the tool has one. */
const AUTO_HINT: Partial<Record<BackendId, string>> = {
  "claude-code": "Claude Code's auto mode approves routine actions and blocks risky ones",
  codex: "Codex's Approve for me: its reviewer approves routine requests and denies risky ones",
}

/** The levels the menu lists for a tool, each with the line under it. */
export function accessChoices(backend: BackendId): readonly { readonly value: Access; readonly hint: string }[] {
  return ACCESS_ORDER.filter((value) => value !== "auto" || offersAuto(backend)).map((value) => ({ value, hint: (value === "auto" ? AUTO_HINT[backend] : undefined) ?? ACCESS_HINT[value] }))
}

export function AccessMenu({ access, backend, onChoose }: { readonly access: Access; readonly backend: BackendId; readonly onChoose: (access: Access) => void }) {
  return (
    <Menu
      side="top"
      width={312}
      className="access-menu"
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          className={cx("tool-chip", access === "plan" && "is-plan", access === "full" && "is-danger", open && "is-open")}
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          title="What the agent may do · Shift-Tab switches"
        >
          {ACCESS_ICON[access]}
          <span>{ACCESS_LABELS[access]}</span>
          <ChevronDown size={11} className="tool-chip-chevron" />
        </button>
      )}
      items={[
        { heading: "What the agent may do", id: "heading" },
        ...accessChoices(backend).map(({ value, hint }) => ({
          id: value,
          label: ACCESS_LABELS[value],
          description: hint,
          icon: ACCESS_ICON[value],
          checked: access === value,
          ...(value === "full" ? { danger: true } : {}),
          onSelect: () => onChoose(value),
        })),
        { separator: true, id: "separator" },
        { id: "settings", label: "Permission settings", icon: <Settings2 size={14} />, onSelect: () => set({ settings: "permissions" }) },
      ]}
    />
  )
}

export function GoalChip({ onOff }: { readonly onOff: () => void }) {
  return (
    <span className="tool-chip is-goal" title="Keeps working until the goal's checks pass">
      <Target size={13} />
      <span>Goal</span>
      <button type="button" className="chip-remove" aria-label="Stop working toward a goal" onClick={onOff}>
        <X size={11} />
      </button>
    </span>
  )
}

export interface ComposerToken {
  /**
   * A setup token runs that saved setup with the message as its task, instead of sending it. A
   * thread token adds that thread's context to the message.
   */
  readonly kind: "skill" | "agent" | "setup" | "thread"
  readonly id: string
  readonly name: string
}

const TOKEN_TITLE: Readonly<Record<ComposerToken["kind"], (name: string) => string>> = {
  skill: (name) => `Runs the ${name} skill with this message`,
  agent: (name) => `Asks the ${name} subagent to take part`,
  setup: (name) => `Runs the ${name} setup with this message as its task`,
  thread: (name) => `Adds what was asked in ${name}, and its latest reply`,
}

export function TokenChip({ token, onRemove }: { readonly token: ComposerToken; readonly onRemove: () => void }) {
  return (
    <span className={cx("composer-token", token.kind === "setup" && "is-setup")} title={TOKEN_TITLE[token.kind](token.name)}>
      {token.kind === "skill" ? <Zap size={12} /> : token.kind === "setup" ? <Play size={12} /> : token.kind === "thread" ? <MessagesSquare size={12} /> : <Bot size={12} />}
      <span className="composer-token-name">{token.name}</span>
      <button type="button" className="chip-remove" aria-label={`Remove ${token.name}`} onClick={onRemove}>
        <X size={11} />
      </button>
    </span>
  )
}

type Page = "main" | "skills" | "agents" | "mcp"

const PAGE_TITLE: Record<Exclude<Page, "main">, string> = { skills: "Skills", agents: "Subagents", mcp: "MCP servers" }
const PAGE_SETTINGS: Record<Exclude<Page, "main">, SettingsSection> = { skills: "skills", agents: "agents", mcp: "mcp" }

export interface AddMenuProps {
  readonly projectId: string
  readonly threadId: string | undefined
  readonly backend: BackendId
  readonly catalog: Pick<Catalog, "skills" | "agents">
  readonly tokens: readonly ComposerToken[]
  readonly goal: boolean
  readonly imagesFull: boolean
  readonly onImages: () => void
  /** Mentions a file, or with no path starts typing a mention at the caret. */
  readonly onMention: (path?: string) => void
  readonly onToken: (token: ComposerToken) => void
  readonly onGoal: (on: boolean) => void
  readonly onBestOf?: () => void
}

export function AddMenu(props: AddMenuProps) {
  return (
    <Popover
      side="top"
      width={340}
      room={360}
      className="add-popover"
      trigger={({ toggle, ref, open }) => (
        <IconButton ref={ref} label="Add files, skills, and more" className={cx("add-trigger", open && "is-open")} onClick={toggle} aria-haspopup="dialog" aria-expanded={open}>
          <Plus size={16} />
        </IconButton>
      )}
    >
      {(close) => <AddPanel {...props} close={close} />}
    </Popover>
  )
}

function Row({ icon, label, description, hint, trailing, onSelect, disabled, page, checked }: { readonly icon: ReactNode; readonly label: ReactNode; readonly description?: ReactNode; readonly hint?: ReactNode; readonly trailing?: ReactNode; readonly onSelect: () => void; readonly disabled?: boolean; readonly page?: string; readonly checked?: boolean }) {
  return (
    <button type="button" role={checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={checked} className="menu-item add-item" disabled={disabled} data-page={page} onClick={onSelect}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-text">
        <span className="menu-label">{label}</span>
        {description !== undefined && <span className="menu-desc add-desc">{description}</span>}
      </span>
      {hint !== undefined && <span className="menu-hint">{hint}</span>}
      {trailing}
    </button>
  )
}

function Switch({ on }: { readonly on: boolean }) {
  return (
    <span className={cx("toggle", "add-switch", on && "is-on")} aria-hidden="true">
      <span className="toggle-knob" />
    </span>
  )
}

const MAX_FOUND = 6

/** The same two switches as the browser tab's toolbar. Each change restarts the thread's agent. */
function BrowserRows({ threadId }: { readonly threadId: string }) {
  const thread = useThread(threadId)
  if (thread === undefined) return null
  const supported = takesBrowser(thread.backend)
  const on = supported && thread.browser?.agent === true
  const anySite = on && thread.browser?.anySite === true
  return (
    <>
      <div className="menu-sep" role="separator" />
      <Row
        icon={<MousePointerClick size={14} />}
        label="Let the agent use the browser"
        description={!supported ? "Not available for this coding tool yet" : !on ? "Opens and uses pages in the browser tab" : anySite ? "On, for any site" : "On, for pages on this computer"}
        checked={on}
        disabled={!supported}
        trailing={<Switch on={on} />}
        onSelect={() => setBrowserUse(threadId, { agent: !on, anySite: false })}
      />
      {on && (
        <Row
          icon={<Globe size={14} />}
          label="Any site, not only this computer"
          description="Web pages may try to steer the agent"
          checked={anySite}
          trailing={<Switch on={anySite} />}
          onSelect={() => setBrowserUse(threadId, { agent: true, anySite: !anySite })}
        />
      )}
    </>
  )
}

/** Computer use for one thread; the apps it may use are chosen in Settings. */
function ComputerRow({ threadId, close }: { readonly threadId: string; readonly close: () => void }) {
  const thread = useThread(threadId)
  const { access, allowed } = useComputerSetup()
  const simulators = useSimulator((state) => state.status?.agents === true)
  const emulators = useAndroid((state) => state.status?.agents === true)
  const platform = useApp((state) => state.platform)
  useEffect(() => {
    void loadComputerSetup().catch(() => undefined)
    void loadSimulator()
    void loadAndroidStatus()
  }, [])
  // Emulators take no window access, so they stay usable where apps cannot be.
  if (thread === undefined || (access?.supported === false && !emulators)) return null
  const supported = takesComputer(thread.backend)
  const on = supported && thread.computer === true
  // On Wayland the one window the person shared stands in for the allowed apps.
  const wayland = access?.session === "wayland"
  const apps = access?.supported === false ? [] : wayland ? (access.portal === "shared" ? ["the shared window"] : []) : [...(allowed ?? []).map((app) => app.name), ...(simulators ? ["iOS simulators"] : [])]
  const names = [...apps, ...(emulators ? ["Android emulators"] : [])].join(", ")
  const none = names.length === 0 && (wayland || allowed !== undefined)
  return (
    <Row
      icon={<AppWindowMac size={14} />}
      label={`Let the agent use apps on ${computerPlace(platform)}`}
      description={!supported ? "Codex and Claude Code only" : none ? (wayland ? "Share a window in Settings first" : "Choose the apps in Settings first") : on ? `On, for ${names}` : names.length > 0 ? `Sees and uses ${names}` : "Sees and uses the apps you allowed"}
      checked={on}
      disabled={!supported}
      trailing={<Switch on={on} />}
      onSelect={() => {
        if (none && !on) {
          close()
          openComputerSettings()
          return
        }
        setComputerUse(threadId, !on)
      }}
    />
  )
}

function AddPanel({ projectId, threadId, backend, catalog, tokens, goal, imagesFull, onImages, onMention, onToken, onGoal, onBestOf, close }: AddMenuProps & { readonly close: () => void }) {
  const [page, setPage] = useState<Page>("main")
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement | null>(null)
  const typed = query.trim()
  const files = useFiles(threadId, projectId, page === "main" && typed.length > 0)
  const mcp = useMcpServers()
  const [switching, setSwitching] = useState<string | undefined>()
  const skills = catalog.skills.filter((skill) => skill.enabled !== false)
  const picked = new Set(tokens.map((token) => `${token.kind}:${token.id}`))

  // The row that was clicked goes away with the page, so the search field takes focus back.
  const go = (next: Page): void => {
    setPage(next)
    setQuery("")
    requestAnimationFrame(() => search.current?.focus())
  }
  const run = (action: () => void): void => {
    close()
    action()
  }
  const toggleServer = (server: McpServer): void => {
    setSwitching(server.name)
    setMcpEnabled(server.name, server.enabled === false)
      .then((list) => mcp.set(list))
      .catch((error: unknown) => toast("error", `Could not switch ${server.name}: ${toHostError(error).message}`))
      .finally(() => setSwitching(undefined))
  }

  const skillRow = (skill: (typeof skills)[number]): ReactNode => {
    const name = skill.name ?? skill.id
    return <Row key={`skill:${skill.id}`} icon={<Zap size={14} />} label={name} description={skill.description} checked={picked.has(`skill:${skill.id}`)} onSelect={() => run(() => onToken({ kind: "skill", id: skill.id, name }))} />
  }
  const agentRow = (agent: Catalog["agents"][number]): ReactNode => (
    <Row key={`agent:${agent.id}`} icon={<Bot size={14} />} label={agent.id} description={agent.description ?? agent.role} checked={picked.has(`agent:${agent.id}`)} onSelect={() => run(() => onToken({ kind: "agent", id: agent.id, name: agent.id }))} />
  )
  const serverRow = (server: McpServer): ReactNode => (
    <Row
      key={`mcp:${server.name}`}
      icon={<Plug size={14} />}
      label={server.name}
      description={server.url ?? ([server.command, ...server.args].join(" ") || undefined)}
      checked={server.enabled !== false}
      disabled={switching === server.name}
      trailing={switching === server.name ? <Spinner size={12} /> : <Switch on={server.enabled !== false} />}
      onSelect={() => toggleServer(server)}
    />
  )

  // Up and down walk the rows; the search field is the row above the first. Right opens a page, left goes back.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const inSearch = target instanceof HTMLInputElement
    if ((event.key === "ArrowLeft" && (!inSearch || query.length === 0)) || (event.key === "Backspace" && inSearch && query.length === 0)) {
      if (page === "main") return
      event.preventDefault()
      go("main")
      return
    }
    if (event.key === "ArrowRight" && !inSearch) {
      const next = target.dataset.page as Page | undefined
      if (next === undefined) return
      event.preventDefault()
      go(next)
      return
    }
    walkRows(event, search.current)
  }

  const enabledServers = mcp.servers.filter((server) => server.enabled !== false).length
  const placeholder = page === "main" ? "Search files, skills, and tools" : `Search ${PAGE_TITLE[page].toLowerCase()}`

  let body: ReactNode
  if (page === "main" && typed.length === 0) {
    body = (
      <>
        <Row icon={<ImagePlus size={14} />} label="Add images" hint="Paste or drop" disabled={imagesFull} onSelect={() => run(onImages)} />
        <Row icon={<AtSign size={14} />} label="Mention a file" hint={<Kbd keys="@" />} onSelect={() => run(() => onMention())} />
        <div className="menu-sep" role="separator" />
        <Row icon={<Zap size={14} />} label="Skills" page="skills" hint={<Count value={skills.length} />} trailing={<ChevronRight size={13} className="add-chevron" />} onSelect={() => go("skills")} />
        <Row icon={<Bot size={14} />} label="Subagents" page="agents" hint={<Count value={catalog.agents.length} />} trailing={<ChevronRight size={13} className="add-chevron" />} onSelect={() => go("agents")} />
        <Row icon={<Plug size={14} />} label="MCP servers" page="mcp" hint={mcp.loading ? undefined : mcp.servers.length === 0 ? "None" : `${String(enabledServers)} on`} trailing={<ChevronRight size={13} className="add-chevron" />} onSelect={() => go("mcp")} />
        <div className="menu-sep" role="separator" />
        <Row icon={<Target size={14} />} label="Work until checks pass" description="Keeps trying until the goal's checks pass" checked={goal} trailing={<Switch on={goal} />} onSelect={() => onGoal(!goal)} />
        {onBestOf !== undefined && <Row icon={<Columns2 size={14} />} label="Best of several models" description="Runs this task on more than one model to compare" onSelect={() => run(onBestOf)} />}
        {threadId !== undefined && <BrowserRows threadId={threadId} />}
        {threadId !== undefined && <ComputerRow threadId={threadId} close={close} />}
      </>
    )
  } else if (page === "main") {
    const foundFiles = rank(typed, files.entries, (entry) => entry.path, MAX_FOUND)
    const foundSkills = rank(typed, skills, (skill) => `${skill.name ?? skill.id} ${skill.description ?? ""}`, MAX_FOUND)
    const foundAgents = rank(typed, catalog.agents, (agent) => `${agent.id} ${agent.description ?? ""}`, MAX_FOUND)
    const foundServers = rank(typed, mcp.servers, (server) => server.name, MAX_FOUND)
    const nothing = foundFiles.length + foundSkills.length + foundAgents.length + foundServers.length === 0
    body = (
      <>
        {foundFiles.length > 0 && <div className="menu-heading">Files</div>}
        {foundFiles.map((entry) => (
          <Row key={`file:${entry.path}`} icon={entry.type === "directory" ? <Folder size={14} /> : <File size={14} />} label={<span className="add-path">{entry.path}</span>} onSelect={() => run(() => onMention(`${entry.path}${entry.type === "directory" ? "/" : ""}`))} />
        ))}
        {foundSkills.length > 0 && <div className="menu-heading">Skills</div>}
        {foundSkills.map(skillRow)}
        {foundAgents.length > 0 && <div className="menu-heading">Subagents</div>}
        {foundAgents.map(agentRow)}
        {foundServers.length > 0 && <div className="menu-heading">MCP servers</div>}
        {foundServers.map(serverRow)}
        {files.loading && foundFiles.length === 0 && (
          <div className="add-empty">
            <Spinner size={12} /> Indexing files…
          </div>
        )}
        {nothing && !files.loading && <div className="add-empty">Nothing matches “{typed}”.</div>}
      </>
    )
  } else {
    const list = page === "skills" ? rank(typed, skills, (skill) => `${skill.name ?? skill.id} ${skill.description ?? ""}`).map(skillRow) : page === "agents" ? rank(typed, catalog.agents, (agent) => `${agent.id} ${agent.description ?? ""}`).map(agentRow) : rank(typed, mcp.servers, (server) => server.name).map(serverRow)
    body = (
      <>
        {page === "mcp" && backend !== "native" && <div className="add-note">This thread's coding tool uses the MCP servers set up in it. These are for Runrail's own agent.</div>}
        {page === "mcp" && mcp.loading && (
          <div className="add-empty">
            <Spinner size={12} /> Reading servers…
          </div>
        )}
        {list.length === 0 && !(page === "mcp" && mcp.loading) && <div className="add-empty">{typed.length > 0 ? `Nothing matches “${typed}”.` : `No ${PAGE_TITLE[page].toLowerCase()} yet.`}</div>}
        {list}
        <div className="menu-sep" role="separator" />
        <Row icon={<Settings2 size={14} />} label={`Manage ${PAGE_TITLE[page].toLowerCase()}`} onSelect={() => run(() => set({ settings: PAGE_SETTINGS[page] }))} />
      </>
    )
  }

  return (
    <div className="add-panel" role="menu" onKeyDown={onKeyDown}>
      <div className="picker-top add-top">
        {page !== "main" && (
          <IconButton label="Back" size="sm" onClick={() => go("main")}>
            <ArrowLeft size={13} />
          </IconButton>
        )}
        <label className="picker-search">
          {page === "main" && <Search size={13} />}
          <input
            ref={search}
            type="text"
            value={query}
            maxLength={160}
            placeholder={placeholder}
            aria-label={placeholder}
            data-autofocus=""
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {page !== "main" && <span className="add-page-title">{PAGE_TITLE[page]}</span>}
      </div>
      <div className="add-list">{body}</div>
    </div>
  )
}

function Count({ value }: { readonly value: number }) {
  return <span className="add-count">{value === 0 ? "None" : String(value)}</span>
}

/** Up and down walk a panel's rows; the search field is the row above the first. */
function walkRows(event: KeyboardEvent<HTMLDivElement>, search: HTMLInputElement | null): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".add-item:not(:disabled)"))
  if (rows.length === 0) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === "ArrowDown") rows[at + 1 < rows.length ? at + 1 : 0]?.focus()
  else if (at === 0) search?.focus()
  else rows[at <= 0 ? rows.length - 1 : at - 1]?.focus()
}

export interface WorktreeChoice {
  readonly worktree: boolean
  readonly start: WorktreeStart
}

/** Where a new thread works: the checkout, or a worktree from HEAD, a branch, or a pull request. */
export function WorktreeMenu({ projectId, value, onChange }: { readonly projectId: string; readonly value: WorktreeChoice; readonly onChange: (value: WorktreeChoice) => void }) {
  const head = useProjectHeads((heads) => heads[projectId])
  const view = startView(head, value)
  const label = view?.label ?? "Local checkout"
  return (
    <Popover
      side="top"
      width={340}
      room={360}
      className="add-popover"
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          className={cx("bar-branch", value.worktree && "is-worktree", open && "is-active")}
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={view?.title ?? "Runs in your checkout"}
        >
          {value.start.kind === "pr" && value.worktree ? <GitPullRequest size={12} /> : <GitBranch size={12} />}
          <span className="bar-branch-name">{label}</span>
          <ChevronDown size={11} className="tool-chip-chevron" />
        </button>
      )}
    >
      {(close) => <WorktreePanel projectId={projectId} value={value} onChange={onChange} close={close} />}
    </Popover>
  )
}

type WorktreePage = "main" | "branch" | "pr"

type Loaded<T> = { readonly state: "loading" } | { readonly state: "ready"; readonly value: T } | { readonly state: "failed"; readonly code: string; readonly message: string }

function useProjectList<T>(projectId: string, active: boolean, method: string, params: Record<string, unknown>, parse: (value: unknown) => T | undefined): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" })
  useEffect(() => {
    if (!active) return
    let live = true
    setLoaded({ state: "loading" })
    projectRpc(projectId, method, params)
      .then((value) => {
        const parsed = parse(value)
        if (live) setLoaded(parsed === undefined ? { state: "failed", code: "CONTROL_INVALID_RESPONSE", message: "the engine's answer was malformed" } : { state: "ready", value: parsed })
      })
      .catch((error: unknown) => {
        const failure = toHostError(error)
        if (live) setLoaded({ state: "failed", code: failure.code, message: failure.message })
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, active, method])
  return loaded
}

const parseBranches = (value: unknown): GitBranches | undefined => parseOr(GitBranchesSchema, value)
const parsePullRequests = (value: unknown): readonly PullRequestEntry[] | undefined => parseOr(PullRequestListSchema, value)?.pullRequests

function WorktreePanel({ projectId, value, onChange, close }: { readonly projectId: string; readonly value: WorktreeChoice; readonly onChange: (value: WorktreeChoice) => void; readonly close: () => void }) {
  const [page, setPage] = useState<WorktreePage>("main")
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement | null>(null)
  const branches = useProjectList(projectId, page === "branch", "git.branches", { maxBranches: 200 }, parseBranches)
  const pulls = useProjectList(projectId, page === "pr", "git.pr.list", { limit: 100 }, parsePullRequests)
  const typed = query.trim()

  const go = (next: WorktreePage): void => {
    setPage(next)
    setQuery("")
    requestAnimationFrame(() => search.current?.focus())
  }
  const choose = (choice: WorktreeChoice): void => {
    close()
    onChange(choice)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const inSearch = event.target instanceof HTMLInputElement
    if (page !== "main" && ((event.key === "ArrowLeft" && (!inSearch || query.length === 0)) || (event.key === "Backspace" && inSearch && query.length === 0))) {
      event.preventDefault()
      go("main")
      return
    }
    if (event.key === "ArrowRight" && !inSearch) {
      const next = (event.target as HTMLElement).dataset.page as WorktreePage | undefined
      if (next === undefined) return
      event.preventDefault()
      go(next)
      return
    }
    walkRows(event, search.current)
  }

  const isStart = (start: WorktreeStart): boolean => value.worktree && JSON.stringify(value.start) === JSON.stringify(start)
  const mark = (checked: boolean): ReactNode => (checked ? <Check size={14} className="menu-check" /> : undefined)
  let body: ReactNode
  if (page === "main") {
    body = (
      <>
        <Row icon={<Laptop size={14} />} label="Local checkout" description="Works in your checkout" checked={!value.worktree} trailing={mark(!value.worktree)} onSelect={() => choose({ worktree: false, start: value.start })} />
        <Row icon={<FolderGit2 size={14} />} label="New worktree" description="Its own copy from where you are now, on a new branch" checked={isStart(HEAD_START)} trailing={mark(isStart(HEAD_START))} onSelect={() => choose({ worktree: true, start: HEAD_START })} />
        <div className="menu-sep" role="separator" />
        <Row icon={<GitBranch size={14} />} label="From a branch" page="branch" hint={value.worktree && value.start.kind === "branch" ? startLabel(value.start).replace(/^From /, "") : undefined} trailing={<ChevronRight size={13} className="add-chevron" />} onSelect={() => go("branch")} />
        <Row icon={<GitPullRequest size={14} />} label="From a pull request" page="pr" hint={value.worktree && value.start.kind === "pr" ? startLabel(value.start) : undefined} trailing={<ChevronRight size={13} className="add-chevron" />} onSelect={() => go("pr")} />
      </>
    )
  } else if (page === "branch") {
    if (branches.state === "loading") body = <div className="add-empty"><Spinner size={12} /> Reading branches…</div>
    else if (branches.state === "failed") body = <div className="add-note">Could not list branches: {branches.message}</div>
    else {
      const rows = branchRows(branches.value, typed)
      const row = (entry: (typeof rows.local)[number]): ReactNode => (
        <Row key={entry.key} icon={<GitBranch size={14} />} label={<span className="add-path">{entry.label}</span>} hint={entry.current ? "current" : relativeTime(entry.updatedAt)} checked={isStart(entry.start)} trailing={mark(isStart(entry.start))} onSelect={() => choose({ worktree: true, start: entry.start })} />
      )
      body = (
        <>
          {rows.local.length > 0 && <div className="menu-heading">Local</div>}
          {rows.local.map(row)}
          {rows.remote.length > 0 && <div className="menu-heading">Remote</div>}
          {rows.remote.map(row)}
          {rows.local.length + rows.remote.length === 0 && <div className="add-empty">{typed.length > 0 ? `No branch matches “${typed}”.` : "No branches yet."}</div>}
          {rows.remote.length > 0 && <div className="add-note">A remote branch is fetched again when the thread starts.</div>}
        </>
      )
    }
  } else {
    const number = typedPullRequest(typed)
    const listed = pulls.state === "ready" ? pullRequestRows(pulls.value, typed) : []
    const typedRow = number !== undefined && !listed.some((pull) => pull.number === number) && (
      <Row icon={<GitPullRequest size={14} />} label={`Pull request #${String(number)}`} description="Fetched from GitHub when the thread starts" checked={isStart({ kind: "pr", number })} trailing={mark(isStart({ kind: "pr", number }))} onSelect={() => choose({ worktree: true, start: { kind: "pr", number } })} />
    )
    body = (
      <>
        {typedRow}
        {pulls.state === "loading" && <div className="add-empty"><Spinner size={12} /> Reading pull requests…</div>}
        {pulls.state === "failed" && <div className="add-note">{pullListProblem(pulls.code, pulls.message)}</div>}
        {listed.map((pull) => (
          <Row
            key={pull.number}
            icon={<GitPullRequest size={14} />}
            label={
              <>
                <span className="pr-number">#{pull.number}</span> {pull.title ?? pull.head ?? ""}
              </>
            }
            description={[pull.draft === true ? "Draft" : undefined, pull.head, pull.author, pull.updatedAt === undefined ? undefined : relativeTime(pull.updatedAt)].filter((part) => part !== undefined).join(" · ")}
            checked={value.worktree && value.start.kind === "pr" && value.start.number === pull.number}
            trailing={mark(value.worktree && value.start.kind === "pr" && value.start.number === pull.number)}
            onSelect={() => choose({ worktree: true, start: { kind: "pr", number: pull.number, ...(pull.title === undefined ? {} : { title: pull.title }) } })}
          />
        ))}
        {pulls.state === "ready" && listed.length === 0 && typedRow === false && <div className="add-empty">{typed.length > 0 ? `No open pull request matches “${typed}”.` : "No open pull requests."}</div>}
      </>
    )
  }

  const placeholder = page === "branch" ? "Search branches" : page === "pr" ? "Search, or enter a number" : undefined
  return (
    <div className="add-panel" role="menu" onKeyDown={onKeyDown}>
      {page === "main" ? (
        <div className="add-list" data-autofocus="" tabIndex={-1}>{body}</div>
      ) : (
        <>
          <div className="picker-top add-top">
            <IconButton label="Back" size="sm" onClick={() => go("main")}>
              <ArrowLeft size={13} />
            </IconButton>
            <label className="picker-search">
              <input
                ref={search}
                type="text"
                value={query}
                maxLength={160}
                placeholder={placeholder}
                aria-label={placeholder}
                data-autofocus=""
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span className="add-page-title">{page === "branch" ? "Branches" : "Pull requests"}</span>
          </div>
          <div className="add-list">{body}</div>
        </>
      )}
    </div>
  )
}

/** The engine's own words, except where there is something the person can do about it. */
function pullListProblem(code: string, message: string): string {
  if (code === "CONTROL_PR_UNAVAILABLE") return "Install the GitHub CLI (gh) to list pull requests here. You can still enter a number."
  if (code === "CONTROL_PR_CREDENTIALS") return "Sign in to the GitHub CLI (run gh auth login in a terminal) to list pull requests. You can still enter a number."
  if (code === "CONTROL_GIT_NOT_FOUND") return "This project has no remote to list pull requests from."
  if (code === "CONTROL_INVALID_INPUT" && /owner\/repo/.test(message)) return "This project's remote is not on GitHub."
  return `Could not list pull requests: ${message}`
}
