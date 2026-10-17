import { Archive, ArrowRightLeft, ChevronDown, Link, Ellipsis, FolderTree, Maximize2, Minimize2, PanelRight, Pencil, Share2, Sparkles, SquareArrowOutUpRight, SquareTerminal, Trash, Users, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction, EDITOR_LABELS, openDialog, openInEditor, reveal, useEditors, workspaceOf } from "../../app/actions"
import { archiveWithUndo } from "../../app/archive"
import { archiveThread, deleteThread, renameThread, threadStatus } from "../../app/engines"
import { anyElsewhere } from "../../app/moveThread"
import { nifraInUse, nifraSummary } from "../../app/nifra"
import { copyThreadLink, usePhone } from "../../app/phone"
import { useBackground, runningCount } from "../../app/background"
import { openPanel, shownKind } from "../../app/panels"
import { useWords } from "../../app/platformWords"
import { openThread, set, setLayout, useApp } from "../../app/store"
import { shareOffered } from "../../app/workflows"
import { isBusy } from "../../thread/reducer"
import { cx, IconButton, Menu, StatusIcon, type MenuEntry } from "../common"
import { useProject, useRuntime, useThread } from "../hooks"
import { WaitingButton } from "../office/Tray"
import { revealSetting } from "../shell/revealSetting"

/** Title bar for a thread: editable title, its project and what that is connected to, and panel toggles. */

export function Title({ threadId, title, editing, setEditing }: { readonly threadId: string; readonly title: string; readonly editing: boolean; readonly setEditing: (value: boolean) => void }) {
  const [value, setValue] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) setValue(title)
  }, [title, editing])
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])
  const commit = (): void => {
    setEditing(false)
    if (value.trim() !== title) renameThread(threadId, value)
  }
  if (editing)
    return (
      <input
        ref={input}
        className="header-title-input"
        value={value}
        maxLength={256}
        aria-label="Thread title"
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit()
          if (event.key === "Escape") {
            setValue(title)
            setEditing(false)
          }
        }}
      />
    )
  return (
    <button type="button" className="header-title" title={`${title}\nDouble-click to rename`} onDoubleClick={() => setEditing(true)}>
      {title}
    </button>
  )
}

/** The office drawer's own controls, when the thread shows there instead of in the main view. */
export interface DrawerControls {
  readonly expanded: boolean
  readonly canExpand: boolean
  readonly onExpand: () => void
  readonly onClose: () => void
}

/** A thread shown side by side with others. */
export interface PaneControls {
  readonly focused: boolean
  readonly close: () => void
}

export function DrawerButtons({ drawer }: { readonly drawer: DrawerControls }) {
  return (
    <>
      {drawer.canExpand && (
        <IconButton label={drawer.expanded ? "Show the floor" : "Expand"} size="sm" onClick={drawer.onExpand}>
          {drawer.expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
      )}
      <IconButton label="Close" size="sm" onClick={drawer.onClose}>
        <X size={15} />
      </IconButton>
    </>
  )
}

export function ThreadHeader({ threadId, drawer, pane }: { readonly threadId: string; readonly drawer?: DrawerControls; readonly pane?: PaneControls }) {
  const thread = useThread(threadId)
  const project = useProject(thread?.projectId)
  const phoneOn = usePhone((state) => state.status?.running === true)
  const runtime = useRuntime(threadId)
  const [renaming, setRenaming] = useState(false)
  const { inspectorOpen, shown, developer, movable } = useApp(
    useShallow((state) => ({ inspectorOpen: state.layout.inspectorOpen, shown: shownKind(state.layout, threadId), developer: state.prefs.developer, movable: project !== undefined && anyElsewhere(project, state.projects) })),
  )
  const editors = useEditors()
  const editor = editors.editor
  const words = useWords()
  if (thread === undefined) return null
  const status = threadStatus(thread, runtime)
  const workspace = workspaceOf(threadId)
  const sub = thread.group === undefined ? undefined : thread.group.label

  const more: MenuEntry[] = [
    { id: "rename", label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
    ...(shareOffered(developer) ? [{ id: "share", label: "Share…", icon: <Share2 size={14} />, description: "Content-free record: status and metadata only", onSelect: () => openDialog({ kind: "share", threadId }) }] : []),
    ...(phoneOn ? [{ id: "share-link", label: "Copy read-only link", icon: <Link size={14} />, description: "For your tailnet, through phone access", onSelect: () => void copyThreadLink(threadId) }] : []),
    ...(movable ? [{ id: "continue-on", label: "Continue on…", icon: <ArrowRightLeft size={14} />, description: "Another machine with this repository", onSelect: () => openDialog({ kind: "continue-on", threadId }) }] : []),
    ...(thread.group === undefined ? [] : [{ id: "compare", label: "Compare runs", icon: <Users size={14} />, onSelect: () => set({ view: { kind: "compare", groupId: thread.group?.id ?? "" } }) }]),
    { id: "sep", separator: true },
    { id: "archive", label: thread.archived === true ? "Unarchive" : "Archive", icon: <Archive size={14} />, onSelect: () => void (thread.archived === true ? archiveThread(threadId, false) : archiveWithUndo(threadId)) },
    {
      id: "delete",
      label: "Delete…",
      icon: <Trash size={14} />,
      danger: true,
      onSelect: () =>
        confirmAction({
          title: "Delete thread?",
          body: thread.worktree === undefined ? "The conversation and its engine data are removed from this machine." : "The conversation, its engine data, and its worktree (including uncommitted changes there) are removed.",
          confirm: "Delete",
          danger: true,
          onConfirm: () => void deleteThread(threadId),
        }),
    },
  ]

  return (
    <header className="thread-header" data-tauri-drag-region>
      <div className="header-main" data-tauri-drag-region>
        <div className="header-line">
          <Title threadId={threadId} title={thread.title} editing={renaming} setEditing={setRenaming} />
          <StatusIcon status={status} size={13} />
          {/* Beside the title, not with the project name, so it shows at every width. */}
          {nifraInUse(runtime?.nifra) && (
            <button
              type="button"
              className="header-nifra"
              title={nifraSummary(runtime.nifra)}
              aria-label={nifraSummary(runtime.nifra)}
              onClick={() => {
                set({ settings: "general" })
                revealSetting("nifra")
              }}
            >
              <Sparkles size={10} aria-hidden />
              Nifra
            </button>
          )}
        </div>
        <div className="header-meta" data-tauri-drag-region>
          <span className="header-project" title={project?.path}>
            {project?.name ?? "Missing project"}
          </span>
          {sub !== undefined && <span className="header-group">Run of “{sub}”</span>}
        </div>
      </div>
      <div className="header-actions">
        {/* What waits and runs elsewhere is said once, in the focused pane. */}
        {(pane === undefined || pane.focused) && (
          <>
            <WaitingButton />
            <RunningElsewhere threadId={threadId} />
          </>
        )}
        <div className="split-button">
          <IconButton label={`Open in ${EDITOR_LABELS[editor]}`} size="sm" onClick={() => void openInEditor(workspace)}>
            <SquareArrowOutUpRight size={13} />
            <span className="editor-label">{EDITOR_LABELS[editor]}</span>
          </IconButton>
          <Menu
            align="end"
            width={220}
            trigger={({ toggle, ref }) => (
              <button ref={ref} type="button" className="icon-btn icon-btn-sm split-caret" aria-label="Open in…" onClick={toggle}>
                <ChevronDown size={12} />
              </button>
            )}
            items={[
              ...editors.list.map((id) => ({ id, label: `Open in ${EDITOR_LABELS[id]}`, checked: id === editor, onSelect: () => void openInEditor(workspace, undefined, id) })),
              { id: "sep", separator: true as const },
              { id: "reveal", label: words.reveal, onSelect: () => void reveal(workspace) },
            ]}
          />
        </div>
        <IconButton label="Files" size="sm" kbd="mod+p" className="header-quick" active={shown === "files"} onClick={() => openPanel(threadId, "files", { toggle: true })}>
          <FolderTree size={15} />
        </IconButton>
        <IconButton label="Terminal" size="sm" kbd="mod+j" className="header-quick" active={shown === "terminal"} onClick={() => openPanel(threadId, "terminal", { toggle: true })}>
          <SquareTerminal size={15} />
        </IconButton>
        <IconButton label={inspectorOpen ? "Hide panel" : "Show panel"} size="sm" kbd="mod+alt+b" active={inspectorOpen} onClick={() => setLayout({ inspectorOpen: !inspectorOpen })}>
          <PanelRight size={15} />
        </IconButton>
        <Menu
          align="end"
          width={240}
          trigger={({ toggle, ref }) => (
            <button ref={ref} type="button" className="icon-btn icon-btn-sm" aria-label="More" title="More" onClick={toggle}>
              <Ellipsis size={15} />
            </button>
          )}
          items={more}
        />
        {drawer !== undefined && <DrawerButtons drawer={drawer} />}
        {pane !== undefined && (
          <IconButton label="Close this pane" size="sm" onClick={pane.close}>
            <X size={15} />
          </IconButton>
        )}
      </div>
    </header>
  )
}

/** "Running · N": other threads with a turn in progress or work left running, one click away. */
function RunningElsewhere({ threadId }: { readonly threadId: string }) {
  const busy = useApp(
    useShallow((state) =>
      state.threads
        .filter((thread) => {
          const timeline = state.runtime[thread.id]?.timeline
          return thread.id !== threadId && thread.archived !== true && timeline !== undefined && isBusy(timeline)
        })
        .map((thread) => thread.id),
    ),
  )
  // Pairs flattened to [id, count, id, count, …] so a shallow compare sees when nothing changed.
  const pairs = useBackground(useShallow((state) => Object.entries(state).flatMap(([id, value]) => (id !== threadId && runningCount(value) > 0 ? [id, runningCount(value)] : []))))
  const threads = useApp((state) => state.threads)
  const counts = new Map<string, number>()
  for (let index = 0; index + 1 < pairs.length; index += 2) counts.set(String(pairs[index]), Number(pairs[index + 1]))
  const ids = [...new Set([...busy, ...counts.keys()])].filter((id) => threads.some((thread) => thread.id === id))
  if (ids.length === 0) return null
  const items: MenuEntry[] = [
    { id: "heading", heading: "Running in other threads" },
    ...ids.slice(0, 12).map((id) => {
      const thread = threads.find((item) => item.id === id)
      const count = counts.get(id) ?? 0
      return {
        id,
        label: thread?.title ?? "Thread",
        icon: <StatusIcon status={busy.includes(id) ? "running" : "idle"} size={13} />,
        ...(count > 0 ? { description: `${String(count)} in the background` } : {}),
        onSelect: () => openThread(id),
      }
    }),
  ]
  return (
    <Menu
      align="end"
      width={280}
      items={items}
      trigger={({ toggle, ref, open }) => (
        <button ref={ref} type="button" className={cx("header-running", open && "is-active")} onClick={toggle} aria-label={`${String(ids.length)} other threads running`}>
          <span className="header-running-dot" aria-hidden />
          Running · {ids.length}
        </button>
      )}
    />
  )
}
