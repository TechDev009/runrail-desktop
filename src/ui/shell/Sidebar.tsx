import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronDown,
  ChevronRight,
  Columns2,
  Columns3,
  Ellipsis,
  FlaskConical,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  ListFilter,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Server,
  Settings2,
  Share2,
  SquarePen,
  Trash,
  Workflow,
  X,
} from "lucide-react"
import { memo, useMemo, useState, type MouseEvent } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction, openDialog, openInEditor, pickProject, reveal, startNewThread } from "../../app/actions"
import { runningTerminalCount } from "../inspector/terminalMeta"
import { useRunningCount } from "../../app/background"
import { archiveThread, deleteThread, renameThread, closeProject } from "../../app/engines"
import type { Project, SidebarView, ThreadMeta, ThreadStatus } from "../../app/persist"
import { selectionLabel } from "../../app/picker"
import { useWords } from "../../app/platformWords"
import { archiveWithUndo, showArchivedThreads } from "../../app/archive"
import { archivedCount, highlightedThread, sidebarModel, type Row, type Section } from "../../app/sidebar"
import { threadGroupKind } from "../../app/threadGroups"
import { MAX_PROJECT_NAME } from "../../app/projectForm"
import { get, openToSide, patchThread, renameProject, selectThread, set, setLayout, useApp } from "../../app/store"
import { getHost } from "../../host"
import { asksQuestion } from "../../thread/reducer"
import { plural, relativeTime, shortcut, tildify } from "../../lib/format"
import { nativeItems, openContextMenu } from "../../lib/contextMenu"
import { cx, IconButton, Menu, Resizer, StatusIcon, statusLabel, useTicker, type MenuEntry } from "../common"
import { useStatuses } from "../hooks"
import { shareOffered } from "../../app/workflows"
import { openProjectSettings } from "./revealSetting"
import { serviceLine } from "../../app/gitHosts"

const VISIBLE_THREADS = 8
/** The chronological list shows this many rows before "Show more". */
const VISIBLE_RECENT = 30
export const SIDEBAR_SEARCH_ID = "sidebar-search"

export function Sidebar() {
  const projects = useApp((state) => state.projects)
  const threads = useApp((state) => state.threads)
  const { activeThreadId, activeProjectId, collapsed, width, sidebarView } = useApp(
    useShallow((state) => ({
      activeThreadId: state.layout.activeThreadId,
      activeProjectId: state.layout.activeProjectId,
      collapsed: state.layout.collapsedProjects,
      width: state.layout.sidebarWidth,
      sidebarView: state.layout.sidebarView,
    })),
  )
  const view = useApp((state) => state.view)
  const archivedTotal = useApp((state) => archivedCount(state.projects, state.threads))
  const statuses = useStatuses()
  const now = useTicker(true, 60_000)
  const [query, setQuery] = useState("")
  const [recentLimit, setRecentLimit] = useState(VISIBLE_RECENT)
  const searching = query.trim().length > 0
  const model = useMemo(() => sidebarModel({ projects, threads, view: sidebarView, collapsed, query, now }), [projects, threads, sidebarView, collapsed, query, now])
  const compareGroup = view.kind === "compare" ? view.groupId : undefined
  const litThreadId = highlightedThread(view, activeThreadId)

  let budget = searching ? Number.POSITIVE_INFINITY : recentLimit
  const recentTotal = model.sections.reduce((sum, section) => sum + (section.kind === "time" ? section.rows.length : 0), 0)

  return (
    <aside className="sidebar" style={{ width }} aria-label="Projects and threads">
      <div className="sidebar-top" data-tauri-drag-region>
        <IconButton label="Hide sidebar" kbd="mod+b" size="sm" onClick={() => setLayout({ sidebarOpen: false })}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>
      <div className="sidebar-section-head">
        <SearchField value={query} onChange={setQuery} />
        <ViewMenu view={sidebarView} projects={projects} collapsed={collapsed} />
        <IconButton label="Add project" size="sm" onClick={() => void pickProject()}>
          <FolderPlus size={14} />
        </IconButton>
      </div>
      <div className="sidebar-scroll" role="tree" aria-label={sidebarView.organize === "chronological" ? "Threads" : "Projects"}>
        {projects.length === 0 && (
          <button type="button" className="sidebar-empty" onClick={() => void pickProject()}>
            <FolderPlus size={15} />
            <span>Open a project folder to start</span>
          </button>
        )}
        {model.noMatches && <div className="sidebar-note">No matches</div>}
        {!searching && projects.length > 0 && model.sections.length === 0 && <div className="sidebar-note">No threads</div>}
        {model.sections.map((section) => {
          if (section.kind === "project")
            return (
              <ProjectSection
                key={section.project.id}
                section={section}
                statuses={statuses}
                activeThreadId={litThreadId}
                highlighted={activeThreadId === undefined && activeProjectId === section.project.id && view.kind === "thread"}
                compareGroup={compareGroup}
                searching={searching}
              />
            )
          // Only the time-ordered list folds; Pinned above the projects shows every pin.
          const rows = sidebarView.organize === "chronological" ? section.rows.slice(0, Math.max(0, budget)) : section.rows
          budget -= rows.length
          return rows.length === 0 ? null : <TimeSection key={section.label} label={section.label} rows={rows} projects={projects} statuses={statuses} activeThreadId={litThreadId} compareGroup={compareGroup} />
        })}
        {sidebarView.organize === "chronological" && !searching && recentTotal > recentLimit && (
          <button type="button" className="show-more" onClick={() => setRecentLimit((limit) => limit + 50)}>
            Show {Math.min(50, recentTotal - recentLimit)} more
          </button>
        )}
      </div>
      <div className="sidebar-foot">
        {archivedTotal > 0 && (
          <button type="button" className={cx("sidebar-archived", view.kind === "archived" && "is-active")} aria-label={`Archived threads: ${String(archivedTotal)}`} aria-current={view.kind === "archived" ? "page" : undefined} onClick={showArchivedThreads}>
            <Archive size={14} />
            <span className="sidebar-archived-label">Archived</span>
            <span className="sidebar-archived-count">{archivedTotal}</span>
          </button>
        )}
        {getHost().kind === "preview" && (
          <span className="preview-badge" title="Running in a browser with a scripted engine">
            Preview
          </span>
        )}
      </div>
      <Resizer side="right" width={width} min={200} max={480} onResize={(next) => setLayout({ sidebarWidth: next })} />
    </aside>
  )
}

/** Filters the list as you type: every word must appear in a thread's title or its project's name. */
function SearchField({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <label className="sidebar-search">
      <Search size={13} aria-hidden />
      <input
        id={SIDEBAR_SEARCH_ID}
        type="text"
        value={value}
        placeholder="Search"
        aria-label="Search projects and threads"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.stopPropagation()
          if (value.length > 0) onChange("")
          else event.currentTarget.blur()
        }}
      />
      {value.length > 0 && (
        <button type="button" className="sidebar-search-clear" aria-label="Clear search" onClick={() => onChange("")}>
          <X size={12} />
        </button>
      )}
    </label>
  )
}

function ViewMenu({ view, projects, collapsed }: { readonly view: SidebarView; readonly projects: readonly Project[]; readonly collapsed: readonly string[] }) {
  const change = (patch: Partial<SidebarView>): void => setLayout({ sidebarView: { ...get().layout.sidebarView, ...patch } })
  const byProject = view.organize === "project"
  const items: MenuEntry[] = [
    { id: "organize", heading: "Organize" },
    { id: "by-project", label: "By project", checked: byProject, onSelect: () => change({ organize: "project" }) },
    { id: "chronological", label: "Chronological", checked: !byProject, onSelect: () => change({ organize: "chronological" }) },
    { id: "sep-sort", separator: true },
    { id: "sort", heading: "Sort threads" },
    { id: "updated", label: "Last updated", checked: view.threadSort === "updated", onSelect: () => change({ threadSort: "updated" }) },
    { id: "created", label: "Created", checked: view.threadSort === "created", onSelect: () => change({ threadSort: "created" }) },
    ...(byProject
      ? ([
          { id: "sep-projects", separator: true },
          { id: "projects", heading: "Sort projects" },
          { id: "added", label: "Order added", checked: view.projectSort === "added", onSelect: () => change({ projectSort: "added" }) },
          { id: "name", label: "Name", checked: view.projectSort === "name", onSelect: () => change({ projectSort: "name" }) },
          { id: "activity", label: "Recent activity", checked: view.projectSort === "activity", onSelect: () => change({ projectSort: "activity" }) },
        ] satisfies MenuEntry[])
      : []),
    { id: "sep-show", separator: true },
    { id: "archived", label: "Show archived", checked: view.showArchived, onSelect: () => change({ showArchived: !view.showArchived }) },
    ...(byProject
      ? ([
          { id: "sep-fold", separator: true },
          { id: "collapse", label: "Collapse all", disabled: projects.every((project) => collapsed.includes(project.id)), onSelect: () => setLayout({ collapsedProjects: projects.map((project) => project.id) }) },
          { id: "expand", label: "Expand all", disabled: collapsed.length === 0, onSelect: () => setLayout({ collapsedProjects: [] }) },
        ] satisfies MenuEntry[])
      : []),
  ]
  return (
    <Menu
      align="end"
      width={208}
      items={items}
      trigger={({ toggle, ref, open }) => (
        <IconButton ref={ref} label="View options" size="sm" active={open} onClick={toggle}>
          <ListFilter size={14} />
        </IconButton>
      )}
    />
  )
}

function groupStatus(threads: readonly ThreadMeta[], statuses: Readonly<Record<string, ThreadStatus>>): ThreadStatus {
  const list = threads.map((thread) => statuses[thread.id] ?? "idle")
  if (list.includes("waiting")) return "waiting"
  if (list.includes("running")) return "running"
  if (list.includes("failed")) return "failed"
  if (list.length > 0 && list.every((status) => status === "completed")) return "completed"
  return "idle"
}

/** Threads of one time group in the chronological list, each naming its project. */
function TimeSection({
  label,
  rows,
  projects,
  statuses,
  activeThreadId,
  compareGroup,
}: {
  readonly label: string
  readonly rows: readonly Row[]
  readonly projects: readonly Project[]
  readonly statuses: Readonly<Record<string, ThreadStatus>>
  readonly activeThreadId?: string
  readonly compareGroup?: string
}) {
  const [openGroups, setOpenGroups] = useState<readonly string[]>([])
  const projectName = (thread: ThreadMeta): string | undefined => projects.find((project) => project.id === thread.projectId)?.name
  return (
    <div className="time-section" role="group" aria-label={label}>
      <div className="time-section-head">{label}</div>
      <RowList rows={rows} statuses={statuses} activeThreadId={activeThreadId} compareGroup={compareGroup} openGroups={openGroups} setOpenGroups={setOpenGroups} projectName={projectName} />
    </div>
  )
}

function RowList({
  rows,
  statuses,
  activeThreadId,
  compareGroup,
  openGroups,
  setOpenGroups,
  projectName,
}: {
  readonly rows: readonly Row[]
  readonly statuses: Readonly<Record<string, ThreadStatus>>
  readonly activeThreadId?: string | undefined
  readonly compareGroup?: string | undefined
  readonly openGroups: readonly string[]
  readonly setOpenGroups: (update: (current: readonly string[]) => readonly string[]) => void
  readonly projectName?: (thread: ThreadMeta) => string | undefined
}) {
  return (
    <>
      {rows.map((row) =>
        row.kind === "thread" ? (
          <ThreadRow key={row.thread.id} thread={row.thread} status={statuses[row.thread.id] ?? "idle"} active={row.thread.id === activeThreadId} project={projectName?.(row.thread)} />
        ) : (
          <GroupRow
            key={row.id}
            row={row}
            statuses={statuses}
            open={openGroups.includes(row.id) || row.threads.some((thread) => thread.id === activeThreadId)}
            active={compareGroup === row.id}
            activeThreadId={activeThreadId}
            onToggle={() => setOpenGroups((current) => (current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id]))}
            status={groupStatus(row.threads, statuses)}
            project={row.threads[0] === undefined ? undefined : projectName?.(row.threads[0])}
          />
        ),
      )}
    </>
  )
}

const ProjectSection = memo(function ProjectSection({
  section,
  statuses,
  activeThreadId,
  highlighted,
  compareGroup,
  searching,
}: {
  readonly section: Extract<Section, { kind: "project" }>
  readonly statuses: Readonly<Record<string, ThreadStatus>>
  readonly activeThreadId?: string | undefined
  readonly highlighted: boolean
  readonly compareGroup?: string | undefined
  readonly searching: boolean
}) {
  const { project, rows, open } = section
  const [showAll, setShowAll] = useState(false)
  const [openGroups, setOpenGroups] = useState<readonly string[]>([])
  const [renaming, setRenaming] = useState(false)
  const words = useWords()
  const running = rows.flatMap((row) => (row.kind === "thread" ? [row.thread] : row.threads)).filter((thread) => statuses[thread.id] === "running" || statuses[thread.id] === "waiting").length

  const folded = !showAll && !searching
  const visible = folded ? rows.slice(0, VISIBLE_THREADS) : rows
  // Keep the active thread reachable even when it falls past the fold.
  const activeHidden = folded && activeThreadId !== undefined ? rows.slice(VISIBLE_THREADS).find((row): row is Extract<Row, { kind: "thread" }> => row.kind === "thread" && row.thread.id === activeThreadId) : undefined

  // Option-click opens or closes every project, as it does for folders in Finder.
  const toggle = (event: MouseEvent): void => {
    const state = get()
    const current = state.layout.collapsedProjects
    if (event.altKey) setLayout({ collapsedProjects: open ? state.projects.map((item) => item.id) : [] })
    else setLayout({ collapsedProjects: open ? [...current, project.id] : current.filter((id) => id !== project.id) })
  }

  const menu: MenuEntry[] = [
    { id: "new", label: "New thread", icon: <SquarePen size={14} />, onSelect: () => startNewThread(project.id) },
    { id: "rename", label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
    { id: "best", label: "Best-of-N run…", icon: <Columns3 size={14} />, disabled: !project.git, description: project.git ? undefined : "Needs a git repository", onSelect: () => openDialog({ kind: "best-of-n", projectId: project.id }) },
    { id: "import", label: "Import sessions…", icon: <History size={14} />, onSelect: () => openDialog({ kind: "import", projectId: project.id }) },
    { id: "workflow", label: "New workflow…", icon: <Workflow size={14} />, onSelect: () => set({ view: { kind: "workflows", projectId: project.id, workflowId: "new" } }) },
    { id: "sep1", separator: true },
    { id: "reveal", label: words.reveal, icon: <FolderOpen size={14} />, onSelect: () => void reveal(project.path) },
    { id: "editor", label: "Open in editor", icon: <Pencil size={14} />, onSelect: () => void openInEditor(project.path) },
    ...(project.remote === undefined ? [{ id: "folders", label: "Project folders...", icon: <FolderOpen size={14} />, onSelect: () => openProjectSettings(project.id) }] : []),
    { id: "settings", label: "Project settings", icon: <Settings2 size={14} />, onSelect: () => openProjectSettings(project.id) },
    { id: "sep2", separator: true },
    {
      id: "remove",
      label: "Remove from sidebar",
      icon: <Trash size={14} />,
      danger: true,
      onSelect: () =>
        confirmAction({
          title: `Remove ${project.name}?`,
          body: "The project and its threads leave the sidebar. Files on disk and engine history are not deleted.",
          confirm: "Remove",
          danger: true,
          onConfirm: () => void closeProject(project.id),
        }),
    },
  ]

  return (
    <div className="project" role="treeitem" aria-expanded={open} aria-selected={highlighted}>
      <div className={cx("project-row", highlighted && "is-active")} onContextMenu={(event) => openContextMenu(event, [{ id: "new", label: `New thread in ${project.name}`, onSelect: () => startNewThread(project.id) }, { separator: true, id: "sep-new" }, ...nativeItems(menu)])}>
        {renaming ? (
          <div className="project-main">
            <span className="project-icon">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
            <input
              className="thread-rename"
              defaultValue={project.name}
              aria-label="Project name"
              autoFocus
              maxLength={MAX_PROJECT_NAME}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => {
                renameProject(project.id, event.currentTarget.value)
                setRenaming(false)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur()
                if (event.key === "Escape") setRenaming(false)
              }}
            />
          </div>
        ) : (
          <button type="button" className="project-main" onClick={toggle} title={`${project.remote === undefined ? tildify(project.path) : `${project.remote.host}:${project.path}`}\n${words.option}-click to open or close all`}>
            <span className="project-icon">{project.remote !== undefined ? <Server size={14} aria-label={`On ${project.remote.host}`} /> : open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
            <span className="project-name">{project.name}</span>
            <ServiceMark project={project} />
            {!open && running > 0 && <StatusIcon status="running" size={13} />}
          </button>
        )}
        {!renaming && (
          <div className="row-actions">
            <IconButton label={`New thread in ${project.name}`} size="sm" onClick={() => startNewThread(project.id)}>
              <Plus size={14} />
            </IconButton>
            <Menu
              align="end"
              width={232}
              items={menu}
              trigger={({ toggle: show, ref, open: isOpen }) => (
                <IconButton ref={ref} label="Project actions" size="sm" active={isOpen} onClick={show}>
                  <Ellipsis size={14} />
                </IconButton>
              )}
            />
          </div>
        )}
      </div>
      {open && (
        <div className="thread-list" role="group">
          {section.empty && <div className="thread-empty">No threads</div>}
          <RowList rows={visible} statuses={statuses} activeThreadId={activeThreadId} compareGroup={compareGroup} openGroups={openGroups} setOpenGroups={setOpenGroups} />
          {activeHidden !== undefined && <ThreadRow key={activeHidden.thread.id} thread={activeHidden.thread} status={statuses[activeHidden.thread.id] ?? "idle"} active />}
          {!searching && rows.length > VISIBLE_THREADS && (
            <button type="button" className="show-more" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Show less" : `Show ${String(rows.length - VISIBLE_THREADS)} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
})

function GroupRow({
  row,
  statuses,
  open,
  active,
  activeThreadId,
  onToggle,
  status,
  project,
}: {
  readonly row: Extract<Row, { kind: "group" }>
  readonly statuses: Readonly<Record<string, ThreadStatus>>
  readonly open: boolean
  readonly active: boolean
  readonly activeThreadId?: string
  readonly onToggle: () => void
  readonly status: ThreadStatus
  readonly project?: string | undefined
}) {
  const kind = threadGroupKind(row.id, row.threads[0])
  const evalRun = kind.kind === "eval" ? kind.runId : undefined
  const setupRun = kind.kind === "setup" ? kind.runId : undefined
  return (
    <>
      <div className={cx("thread-row", "group-row", active && "is-active")}>
        <button type="button" className="thread-lead-btn" onClick={onToggle} aria-label={open ? "Collapse runs" : "Expand runs"} aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {evalRun !== undefined ? (
          <button type="button" className="thread-main" onClick={() => set({ view: { kind: "evals", runId: evalRun } })} title="Open the eval">
            <span className="thread-lead"><FlaskConical size={13} /></span>
            <span className="thread-title">{row.label}</span>
            {project !== undefined && <span className="thread-project">{project}</span>}
            <span className="thread-meta">{plural(row.threads.length, "thread")}</span>
            {status !== "idle" && <StatusIcon status={status} size={13} />}
          </button>
        ) : setupRun === undefined ? (
          <button type="button" className="thread-main" onClick={() => set({ view: { kind: "compare", groupId: row.id } })} title={`Compare ${plural(row.threads.length, "run")}`}>
            <span className="thread-lead"><Columns3 size={13} /></span>
            <span className="thread-title">{row.label}</span>
            {project !== undefined && <span className="thread-project">{project}</span>}
            <span className="thread-meta">{plural(row.threads.length, "run")}</span>
            {status !== "idle" && <StatusIcon status={status} size={13} />}
          </button>
        ) : (
          <button type="button" className="thread-main" onClick={() => set({ view: { kind: "agents", runId: setupRun } })} title="Open the setup run">
            <span className="thread-lead"><Bot size={13} /></span>
            <span className="thread-title">{row.label}</span>
            {project !== undefined && <span className="thread-project">{project}</span>}
            <span className="thread-meta">{plural(row.threads.length, "role")}</span>
            {status !== "idle" && <StatusIcon status={status} size={13} />}
          </button>
        )}
      </div>
      {open && row.threads.map((thread) => <ThreadRow key={thread.id} thread={thread} status={statuses[thread.id] ?? "idle"} active={thread.id === activeThreadId} nested />)}
    </>
  )
}

const ThreadRow = memo(function ThreadRow({ thread, status, active, nested, project }: { readonly thread: ThreadMeta; readonly status: ThreadStatus; readonly active: boolean; readonly nested?: boolean; readonly project?: string | undefined }) {
  const [renaming, setRenaming] = useState(false)
  const showStatus = status === "running" || status === "waiting" || status === "failed"
  const developer = useApp((state) => state.prefs.developer)
  const showTimestamps = useApp((state) => state.prefs.showThreadTimestamps)
  const background = useRunningCount(thread.id)
  const asking = useApp((state) => status === "waiting" && asksQuestion(state.runtime[thread.id]?.timeline))
  // Shown in a pane of the split view that is not the focused one.
  const shown = useApp((state) => !active && state.layout.panes?.includes(thread.id) === true)
  // Runs inside a comparison share one prompt, so they are told apart by what they run on.
  const label = nested === true ? selectionLabel(thread, developer) : thread.title
  const menu: MenuEntry[] = [
    { id: "side", label: "Open to the side", icon: <Columns2 size={14} />, description: `${shortcut("mod")}-click does the same`, onSelect: () => openToSide(thread.id) },
    { id: "sep-side", separator: true },
    { id: "rename", label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
    { id: "pin", label: thread.pinned === true ? "Unpin" : "Pin to top", icon: thread.pinned === true ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => patchThread(thread.id, { pinned: thread.pinned !== true }) },
    {
      id: "archive",
      label: thread.archived === true ? "Restore" : "Archive",
      icon: thread.archived === true ? <ArchiveRestore size={14} /> : <Archive size={14} />,
      onSelect: () => archiveOrRestore(thread),
    },
    ...(shareOffered(developer) ? [{ id: "share", label: "Share…", icon: <Share2 size={14} />, onSelect: () => openDialog({ kind: "share", threadId: thread.id }) }] : []),
    { id: "sep", separator: true },
    {
      id: "delete",
      label: "Delete",
      icon: <Trash size={14} />,
      danger: true,
      onSelect: () =>
        confirmAction({
          title: "Delete thread?",
          body: thread.worktree === undefined ? "Its conversation history is deleted from this machine. This cannot be undone." : "Its conversation history and its worktree are deleted from this machine. Uncommitted work in the worktree is lost. This cannot be undone.",
          confirm: "Delete",
          danger: true,
          onConfirm: () => void deleteThread(thread.id),
        }),
    },
  ]
  return (
    <div className={cx("thread-row", active && "is-active", shown && "is-shown", nested === true && "is-nested", thread.archived === true && "is-archived")} role="treeitem" aria-selected={active} onContextMenu={(event) => !renaming && openContextMenu(event, nativeItems(menu))}>
      {renaming ? (
        <input
          className="thread-rename"
          defaultValue={thread.title}
          aria-label="Thread title"
          autoFocus
          maxLength={256}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            renameThread(thread.id, event.currentTarget.value)
            setRenaming(false)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
            if (event.key === "Escape") setRenaming(false)
          }}
        />
      ) : (
        <button type="button" className="thread-main" onClick={(event) => (event.metaKey || event.ctrlKey ? openToSide(thread.id) : selectThread(thread.id))} onDoubleClick={() => setRenaming(true)} title={project === undefined ? thread.title : `${thread.title}\n${project}`}>
          <span className="thread-lead" aria-label={thread.unread === true ? "Unread" : undefined}>
            {thread.unread === true ? <span className="unread-dot" /> : thread.pinned === true ? <Pin size={11} className="muted" /> : null}
          </span>
          <span className={cx("thread-title", !thread.titled && nested !== true && "is-placeholder")}>{label}</span>
          {project !== undefined && <span className="thread-project">{project}</span>}
          {thread.worktree !== undefined && <GitBranch size={11} className="thread-flag" aria-label="Runs in a worktree" />}
          {background > 0 && (
            <span className="thread-bg" title={background === 1 ? "1 task running in the background" : `${String(background)} tasks running in the background`}>
              {background}
            </span>
          )}
          {(status === "waiting" || showTimestamps) && <span className="thread-time">{status === "waiting" ? (asking ? "Answer" : "Approve") : relativeTime(thread.updatedAt)}</span>}
          {showStatus && <span className="thread-status" aria-label={statusLabel(status)}><StatusIcon status={status} size={13} /></span>}
        </button>
      )}
      {!renaming && (
        <div className="row-actions">
          {thread.archived !== true && (
            <IconButton label={thread.pinned === true ? "Unpin" : "Pin"} size="sm" onClick={() => patchThread(thread.id, { pinned: thread.pinned !== true })}>
              {thread.pinned === true ? <PinOff size={13} /> : <Pin size={13} />}
            </IconButton>
          )}
          <IconButton label={thread.archived === true ? "Restore" : "Archive"} size="sm" onClick={() => archiveOrRestore(thread)}>
            {thread.archived === true ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </IconButton>
          <Menu
            align="end"
            width={200}
            items={menu}
            trigger={({ toggle, ref, open }) => (
              <IconButton ref={ref} label="Thread actions" size="sm" active={open} onClick={toggle}>
                <Ellipsis size={13} />
              </IconButton>
            )}
          />
        </div>
      )}
    </div>
  )
})

/** GitHub, GitLab or Bitbucket after a project's name; nothing without a service to name. */
function ServiceMark({ project }: { readonly project: Project }) {
  const line = project.git ? serviceLine(project.connectedTo) : undefined
  if (line?.short === undefined) return null
  return (
    <span className={cx("project-service", line.short.endsWith("?") && "is-guess")} title={line.title}>
      {line.short}
    </span>
  )
}

/** Archiving ends a thread's terminals; when one runs a shell (a dev server, a watcher), it asks first. */
function archiveOrRestore(thread: { readonly id: string; readonly title: string; readonly archived?: boolean }): void {
  if (thread.archived === true) return void archiveThread(thread.id, false)
  const shells = runningTerminalCount(thread.id)
  if (shells === 0) return void archiveWithUndo(thread.id)
  confirmAction({
    title: `Archive ${thread.title}?`,
    body: `Archiving ends its ${plural(shells, "open terminal")} and whatever runs in them, such as a dev server.`,
    confirm: "Archive",
    danger: true,
    onConfirm: () => void archiveWithUndo(thread.id),
  })
}
