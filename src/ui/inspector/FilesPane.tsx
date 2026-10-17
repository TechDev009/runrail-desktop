import { useVirtualizer } from "@tanstack/react-virtual"
import { AtSign, ChevronDown, ChevronRight, File, FileText, Folder, FolderOpen, Pencil, RefreshCw, Search, SquareArrowOutUpRight, TriangleAlert, X } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react"
import { confirmAction, EDITOR_LABELS, focusComposer, openInEditor, reveal, useEditors, workspaceOf } from "../../app/actions"
import { useFiles } from "../../app/catalog"
import { fileMenuItems, openFileMenu } from "../../app/fileMenu"
import { usePreviewRequest, type PreviewRequest } from "../../app/filePreview"
import { folderRpc, refreshFolderGit, showFolder, useFolderGit, useShownFolder } from "../../app/folderGit"
import { shownKind } from "../../app/panels"
import { useWords } from "../../app/platformWords"
import { set, toast, useApp } from "../../app/store"
import { toHostError } from "../../host"
import { openContextMenu, type ContextItem } from "../../lib/contextMenu"
import { basename, bytes, dirname, pathCrumbs } from "../../lib/format"
import { rank } from "../../lib/fuzzy"
import { langFor } from "../../lib/highlight"
import { hasCapability, parseOr, WorkspaceReadSchema, WorkspaceWriteSchema, type GitEntry, type WorkspaceEntry } from "../../protocol/schemas"
import { Button, CopyButton, cx, EmptyState, IconButton, Segmented, Spinner } from "../common"
import { FileChanges } from "./FileChanges"
import type { CodeEditor } from "./codeEditor"
import { useDebounced, useGit, useThread } from "../hooks"
import { CodeBlock } from "../thread/Markdown"
import { useListOffset } from "../virtual"
import { FolderSwitch } from "./FolderSwitch"

/**
 * Files pane: the thread's workspace as a tree with git status letters, a fuzzy filter, and a
 * preview that can be edited. Files are read and saved through the engine
 * (bounded, the agent's file rules); nothing here touches the disk directly.
 */

interface TreeNode {
  readonly name: string
  readonly path: string
  readonly type: "file" | "directory"
  readonly bytes?: number
  readonly children: TreeNode[]
}

function buildTree(entries: readonly WorkspaceEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] }
  const directories = new Map<string, TreeNode>([["", root]])
  const ensure = (path: string): TreeNode => {
    const existing = directories.get(path)
    if (existing !== undefined) return existing
    const slash = path.lastIndexOf("/")
    const parent = ensure(slash < 0 ? "" : path.slice(0, slash))
    const node: TreeNode = { name: slash < 0 ? path : path.slice(slash + 1), path, type: "directory", children: [] }
    parent.children.push(node)
    directories.set(path, node)
    return node
  }
  for (const entry of entries) {
    if (entry.type === "directory") {
      ensure(entry.path)
      continue
    }
    const slash = entry.path.lastIndexOf("/")
    const parent = ensure(slash < 0 ? "" : entry.path.slice(0, slash))
    parent.children.push({ name: slash < 0 ? entry.path : entry.path.slice(slash + 1), path: entry.path, type: "file", ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }), children: [] })
  }
  const sort = (node: TreeNode): void => {
    node.children.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1))
    for (const child of node.children) sort(child)
  }
  sort(root)
  return root.children
}

interface TreeRow {
  readonly node: TreeNode
  readonly depth: number
}

/** The tree as the rows it shows: each folder's children follow it while it is open. */
export function treeRows(tree: readonly TreeNode[], open: ReadonlySet<string>): readonly TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ node, depth })
      if (node.type === "directory" && open.has(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return rows
}

/** Matches `.file-row`. */
const ROW_HEIGHT = 26

function gitLetter(entry: GitEntry | undefined): { readonly letter: string; readonly label: string } | undefined {
  if (entry === undefined) return undefined
  if (entry.conflicted) return { letter: "!", label: "Conflicted" }
  if (entry.untracked) return { letter: "U", label: "Untracked" }
  const code = entry.index !== "." && entry.index !== " " ? entry.index : entry.worktree
  if (code === "A") return { letter: "A", label: "Added" }
  if (code === "D") return { letter: "D", label: "Deleted" }
  if (code === "R") return { letter: "R", label: "Renamed" }
  return { letter: "M", label: "Modified" }
}

/** A related folder's file goes by its full path, since the agent works from the thread's checkout. */
function mention(threadId: string, path: string, folder?: string): void {
  const named = folder === undefined ? path : `${folder}/${path}`
  set((state) => {
    const current = state.drafts[threadId] ?? ""
    const spacer = current.length === 0 || /\s$/.test(current) ? "" : " "
    return { drafts: { ...state.drafts, [threadId]: `${current}${spacer}@${named} ` } }
  })
  focusComposer()
}

/** Other surfaces (the palette, @mentions) ask the pane to preview a path through this channel. */
export function FilesPane({ threadId }: { readonly threadId: string }) {
  const folder = useShownFolder(threadId)
  return <FolderFiles key={folder ?? ""} threadId={threadId} {...(folder === undefined ? {} : { folder })} />
}

/** The files of the thread's checkout, or of one of the project's related folders. */
function FolderFiles({ threadId, folder }: { readonly threadId: string; readonly folder?: string }) {
  const thread = useThread(threadId)
  const files = useFiles(threadId, thread?.projectId, true, folder)
  const ownGit = useGit(threadId)
  const folderGit = useFolderGit(threadId, folder)
  const git = folder === undefined ? ownGit : folderGit
  const [query, setQuery] = useState("")
  const debounced = useDebounced(query, 80)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | undefined>()
  const [preview, setPreview] = useState<PreviewRequest | undefined>()
  const [cursor, setCursor] = useState(0)
  /** The folder the pane is at: the last one opened, or one picked from the breadcrumb. */
  const [location, setLocation] = useState("")
  const [jump, setJump] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const focusFiles = useApp((state) => shownKind(state.layout, threadId) === "files")
  const input = useRef<HTMLInputElement>(null)
  const request = usePreviewRequest((state) => state.request)
  const workspace = folder ?? workspaceOf(threadId)
  const fileMenu = (path: string, file: boolean): ContextItem[] =>
    workspace === undefined ? [] : fileMenuItems(workspace, path, { threadId, ...(folder === undefined ? {} : { folder }) }, file ? { extra: [{ id: "mention", label: "Mention in message", onSelect: () => mention(threadId, path, folder) }] } : { directory: true })

  useEffect(() => {
    if (focusFiles && request === undefined) input.current?.focus()
  }, [focusFiles, request])

  useEffect(() => {
    if (folder !== undefined) void refreshFolderGit(threadId, folder)
  }, [threadId, folder])

  useEffect(() => {
    if (request === undefined || request.threadId !== threadId) return
    // A path asked for elsewhere is in the thread's checkout unless it names a related folder; the pane moves there first.
    if (request.folder !== folder) return showFolder(threadId, request.folder)
    setSelected(request.path)
    setPreview(request)
    usePreviewRequest.setState({ request: undefined })
  }, [request, threadId, folder])

  const status = useMemo(() => {
    const map = new Map<string, GitEntry>()
    for (const entry of git.status?.entries ?? []) map.set(entry.path, entry)
    return map
  }, [git.status])
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>()
    for (const path of status.keys()) {
      let slash = path.lastIndexOf("/")
      while (slash > 0) {
        dirs.add(path.slice(0, slash))
        slash = path.lastIndexOf("/", slash - 1)
      }
    }
    return dirs
  }, [status])

  const tree = useMemo(() => buildTree(files.entries), [files.entries])
  const matches = useMemo(() => (debounced.trim().length === 0 ? undefined : rank(debounced.trim(), files.entries.filter((entry) => entry.type === "file"), (entry) => entry.path, 200)), [debounced, files.entries])
  const rows = useMemo(() => (matches === undefined ? treeRows(tree, open) : []), [matches, tree, open])
  const treeRef = useRef<HTMLDivElement>(null)
  const offset = useListOffset(list, treeRef, rows.length > 0)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => list.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.node.path ?? index,
    overscan: 12,
    scrollMargin: offset,
  })

  useEffect(() => setCursor(0), [debounced])

  const toggle = (path: string): void => {
    const closing = open.has(path)
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!closing) setLocation(path)
    else if (location === path || location.startsWith(`${path}/`)) setLocation(dirname(path))
  }

  // Opens a folder and every folder above it, then brings its row into view.
  const goTo = (folder: string): void => {
    setQuery("")
    setOpen((current) => {
      const next = new Set(current)
      const parts = folder.split("/").filter((part) => part.length > 0)
      for (let index = 1; index <= parts.length; index += 1) next.add(parts.slice(0, index).join("/"))
      return next
    })
    setLocation(folder)
    setJump((value) => value + 1)
  }

  useEffect(() => {
    if (jump === 0) return
    const index = location === "" ? -1 : rows.findIndex((row) => row.node.path === location)
    if (index < 0) list.current?.scrollTo({ top: 0 })
    else virtualizer.scrollToIndex(index, { align: "auto" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  if (selected !== undefined)
    return (
      <FilePreview
        key={`${selected}:${String(preview?.nonce ?? 0)}`}
        threadId={threadId}
        {...(folder === undefined ? {} : { folder })}
        path={selected}
        {...(preview?.path === selected ? { preview } : {})}
        onBack={(folder) => {
          setSelected(undefined)
          setPreview(undefined)
          goTo(folder ?? dirname(selected))
        }}
      />
    )

  return (
    <div className="files">
      <FolderSwitch threadId={threadId} />
      <Crumbs workspace={workspace} at={matches === undefined ? location : ""} onPick={goTo} />
      <div className="pane-toolbar">
        <label className="search-field">
          <Search size={13} />
          <input
            ref={input}
            value={query}
            placeholder="Go to file"
            aria-label="Filter files"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (matches === undefined) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setCursor((value) => Math.min(value + 1, matches.length - 1))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setCursor((value) => Math.max(value - 1, 0))
              } else if (event.key === "Enter") {
                event.preventDefault()
                const match = matches[cursor]
                if (match === undefined) return
                if (event.metaKey || event.ctrlKey) mention(threadId, match.path, folder)
                else setSelected(match.path)
              } else if (event.key === "Escape") setQuery("")
            }}
          />
          {query.length > 0 && (
            <button type="button" className="search-clear" aria-label="Clear filter" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </label>
        <IconButton label="Refresh files" size="sm" onClick={files.reload} disabled={files.loading}>
          {files.loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </IconButton>
      </div>
      <div ref={list} className="file-list" role="tree" aria-label="Workspace files">
        {files.error !== undefined && files.entries.length === 0 ? (
          <EmptyState icon={<Folder size={20} />} title="Could not list files">
            {files.error}
          </EmptyState>
        ) : files.loading && files.entries.length === 0 ? (
          <div className="pane-loading">
            <Spinner size={14} /> Indexing files…
          </div>
        ) : matches !== undefined ? (
          matches.length === 0 ? (
            <div className="popup-empty">No files match “{debounced}”.</div>
          ) : (
            matches.map((entry, index) => {
              const letter = gitLetter(status.get(entry.path))
              return (
                <div key={entry.path} className={cx("file-row", index === cursor && "is-active")} role="treeitem" aria-selected={index === cursor} onContextMenu={(event) => openContextMenu(event, fileMenu(entry.path, true))}>
                  <button type="button" className="file-row-main" onClick={() => setSelected(entry.path)} title={entry.path}>
                    <File size={13} className="file-icon" />
                    <span className="file-name">{basename(entry.path)}</span>
                    <span className="file-dir">{entry.path.slice(0, Math.max(0, entry.path.length - basename(entry.path).length - 1))}</span>
                  </button>
                  {letter !== undefined && (
                    <span className={cx("git-letter", `change-${letter.letter}`)} title={letter.label}>
                      {letter.letter}
                    </span>
                  )}
                  <IconButton label="Mention in message" size="sm" className="file-row-action" onClick={() => mention(threadId, entry.path, folder)}>
                    <AtSign size={12} />
                  </IconButton>
                </div>
              )
            })
          )
        ) : rows.length === 0 ? (
          <EmptyState icon={<Folder size={20} />} title="No files">
            This workspace is empty or every file is ignored.
          </EmptyState>
        ) : (
          <div ref={treeRef} className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (row === undefined) return null
              const { node, depth } = row
              const letter = node.type === "file" ? gitLetter(status.get(node.path)) : undefined
              const isOpen = open.has(node.path)
              const dirty = node.type === "directory" && changedDirs.has(node.path)
              return (
                <div
                  key={item.key}
                  className={cx("file-row", "virtual-row", node.path === location && "is-here")}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={node.type === "directory" ? isOpen : undefined}
                  style={{ top: item.start - offset, paddingLeft: 6 + depth * 14 }}
                  onContextMenu={(event) => openContextMenu(event, fileMenu(node.path, node.type === "file"))}
                >
                  <button type="button" className="file-row-main" onClick={() => (node.type === "directory" ? toggle(node.path) : setSelected(node.path))} title={node.path}>
                    {node.type === "directory" ? (
                      <>
                        {isOpen ? <ChevronDown size={12} className="file-caret" /> : <ChevronRight size={12} className="file-caret" />}
                        {isOpen ? <FolderOpen size={13} className="file-icon is-dir" /> : <Folder size={13} className="file-icon is-dir" />}
                      </>
                    ) : (
                      <>
                        <span className="file-caret" />
                        <FileText size={13} className="file-icon" />
                      </>
                    )}
                    <span className={cx("file-name", dirty && "is-dirty")}>{node.name}</span>
                  </button>
                  {letter !== undefined && (
                    <span className={cx("git-letter", `change-${letter.letter}`)} title={letter.label}>
                      {letter.letter}
                    </span>
                  )}
                  {dirty && <span className="git-dot" title="Contains changes" />}
                  {node.type === "file" && (
                    <IconButton label="Mention in message" size="sm" className="file-row-action" onClick={() => mention(threadId, node.path, folder)}>
                      <AtSign size={12} />
                    </IconButton>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {files.truncated && <div className="diff-note">Large workspace: only part of the tree is indexed. Use the filter to find files.</div>}
      </div>
    </div>
  )
}

/** Edits not saved yet, by thread and file, kept while the pane shows something else. Memory only. */
const unsaved = new Map<string, { readonly text: string; readonly baseHash: string }>()

interface Loaded {
  readonly content?: string
  readonly bytes?: number
  readonly truncated?: boolean
  readonly hash?: string
  readonly error?: string
  readonly loading: boolean
}

async function readFile(threadId: string, path: string, folder?: string): Promise<Loaded> {
  try {
    const parsed = parseOr(WorkspaceReadSchema, await folderRpc(threadId, folder, "workspace.read", { path, maxBytes: 256 * 1_024 }))
    if (parsed === undefined) return { loading: false, error: "The engine returned a file this app cannot read." }
    return { loading: false, content: parsed.content, ...(parsed.bytes === undefined ? {} : { bytes: parsed.bytes }), ...(parsed.truncated === undefined ? {} : { truncated: parsed.truncated }), ...(parsed.hash === undefined ? {} : { hash: parsed.hash }) }
  } catch (error) {
    return { loading: false, error: toHostError(error).message }
  }
}

function unsavedKey(threadId: string, path: string, folder: string | undefined): string {
  return folder === undefined ? `${threadId}:${path}` : `${threadId}:${folder}:${path}`
}

function FilePreview({ threadId, folder, path, preview, onBack }: { readonly threadId: string; readonly folder?: string; readonly path: string; readonly preview?: PreviewRequest; readonly onBack: (folder?: string) => void }) {
  const [state, setState] = useState<Loaded>({ loading: true })
  const [view, setView] = useState<"changes" | "file">(preview?.view ?? "file")
  const [editing, setEditing] = useState(() => preview?.view !== "changes" && unsaved.has(unsavedKey(threadId, path, folder)))
  const writable = useApp((app) => hasCapability(app.runtime[threadId]?.contract, "workspace.write"))
  const words = useWords()
  const { editor } = useEditors()
  const workspace = folder ?? workspaceOf(threadId)
  useEffect(() => {
    let live = true
    setState({ loading: true })
    void readFile(threadId, path, folder).then((loaded) => live && setState(loaded))
    return () => {
      live = false
    }
  }, [threadId, path, folder])
  // A file read in part, or by an engine that hands out no hash, cannot be saved safely.
  const editable = writable && state.content !== undefined && state.truncated !== true && state.hash !== undefined
  const line = preview?.line
  const body = useRef<HTMLDivElement>(null)
  const band = useLineBand(body, line, state.content, view === "file" && !editing)

  return (
    <div className="file-preview">
      <Crumbs workspace={workspace} at={path} file onPick={onBack} />
      <div className="pane-toolbar">
        <IconButton label="Back to files" size="sm" onClick={() => onBack()}>
          <ChevronRight size={13} className="flip" />
        </IconButton>
        <span className="file-preview-name" title={path} onContextMenu={(event) => workspace !== undefined && openFileMenu(event, workspace, path, { threadId, ...(folder === undefined ? {} : { folder }) })}>
          {basename(path)}
        </span>
        {line !== undefined && view === "file" && !editing && <span className="file-preview-line">Line {line}</span>}
        {state.bytes !== undefined && <span className="muted">{bytes(state.bytes)}</span>}
        <div className="pane-toolbar-spacer" />
        {editable && !editing && (
          <IconButton label="Edit file" size="sm" onClick={() => { setView("file"); setEditing(true) }}>
            <Pencil size={12} />
          </IconButton>
        )}
        <CopyButton text={path} label="Copy path" />
        <IconButton label="Mention in message" size="sm" onClick={() => mention(threadId, path, folder)}>
          <AtSign size={12} />
        </IconButton>
        <IconButton label={words.reveal} size="sm" onClick={() => void reveal(workspace, path)}>
          <FolderOpen size={12} />
        </IconButton>
        <IconButton label={`Open in ${EDITOR_LABELS[editor]}`} size="sm" onClick={() => void openInEditor(workspace, path)}>
          <SquareArrowOutUpRight size={12} />
        </IconButton>
      </div>
      {preview?.view === "changes" && !editing && <div className="pane-toolbar"><Segmented label="File view" value={view} onChange={setView} options={[{ value: "changes", label: "Changes" }, { value: "file", label: "File" }]} /></div>}
      {view === "changes" && !editing ? (
        <FileChanges threadId={threadId} path={path} {...(preview?.change === undefined ? {} : { change: preview.change })} />
      ) : editing && editable ? (
        <FileEditor
          threadId={threadId}
          {...(folder === undefined ? {} : { folder })}
          path={path}
          content={state.content ?? ""}
          hash={state.hash ?? ""}
          onSaved={(content, hash) => setState((current) => ({ ...current, content, hash, bytes: new TextEncoder().encode(content).length }))}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div ref={body} className="file-preview-body" style={{ "--gutter": `${String(Math.max(2, String((state.content ?? "").split("\n").length).length))}ch` } as CSSProperties}>
          {band !== undefined && <div className="file-line-target" style={{ top: band.top, height: band.height }} aria-hidden />}
          {state.loading ? (
            <div className="pane-loading">
              <Spinner size={14} /> Loading…
            </div>
          ) : state.error !== undefined ? (
            <EmptyState icon={<File size={20} />} title="Cannot preview this file">
              {state.error}
            </EmptyState>
          ) : (
            <>
              <CodeBlock code={state.content ?? ""} {...(langFor(path) === undefined ? {} : { lang: langFor(path) })} />
              {state.truncated === true && <div className="diff-note">Preview truncated. Open in your editor to see the whole file.</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Where line `line` of the file shown in `body` sits, measured from the rendered text so plain and
 * highlighted code agree; the body scrolls it into view once, when the text first shows.
 */
function useLineBand(body: RefObject<HTMLDivElement | null>, line: number | undefined, content: string | undefined, shown: boolean): { readonly top: number; readonly height: number } | undefined {
  const [band, setBand] = useState<{ readonly top: number; readonly height: number }>()
  useLayoutEffect(() => {
    const root = body.current
    if (line === undefined || content === undefined || !shown || root === null) {
      setBand(undefined)
      return
    }
    const target = Math.min(line, content.split("\n").length)
    let scrolled = false
    const place = (): void => {
      const pre = root.querySelector("pre")
      if (pre === null) return
      const style = getComputedStyle(pre)
      const height = Number.parseFloat(style.lineHeight) || 20
      const top = pre.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop + Number.parseFloat(style.paddingTop) + (target - 1) * height
      setBand((current) => (current?.top === top && current.height === height ? current : { top, height }))
      if (!scrolled) {
        scrolled = true
        root.scrollTop = Math.max(0, top - root.clientHeight / 3)
      }
    }
    place()
    // The highlighted text replaces the plain text a moment later.
    const observer = new MutationObserver(place)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [body, line, content, shown])
  return band
}

/**
 * Editing one file. A save goes only over the text that was opened: when the file changed since
 * (the agent edited it, say), the engine refuses, and the person picks the new version, or keeps
 * theirs by overwriting it on purpose. Edits not saved stay in memory while the pane shows
 * another file, and come back with this one.
 */
function FileEditor({ threadId, folder, path, content, hash, onSaved, onDone }: { readonly threadId: string; readonly folder?: string; readonly path: string; readonly content: string; readonly hash: string; readonly onSaved: (content: string, hash: string) => void; readonly onDone: () => void }) {
  const key = unsavedKey(threadId, path, folder)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<CodeEditor | undefined>(undefined)
  const draft = useRef(unsaved.get(key))
  const base = useRef(draft.current?.baseHash ?? hash)
  /** The text on disk, as last read or saved. */
  const disk = useRef(content)
  const [dirty, setDirty] = useState(draft.current !== undefined && draft.current.text !== content)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)

  const note = (text: string): void => {
    const changed = text !== disk.current
    setDirty(changed)
    if (changed) unsaved.set(key, { text, baseHash: base.current })
    else unsaved.delete(key)
  }

  const write = async (baseHash: string): Promise<void> => {
    const current = editor.current
    if (current === undefined || saving) return
    const text = current.text()
    setSaving(true)
    try {
      const saved = parseOr(WorkspaceWriteSchema, await folderRpc(threadId, folder, "workspace.write", { path, content: text, baseHash }))
      if (saved === undefined) throw new Error("The engine's answer could not be read.")
      base.current = saved.hash
      disk.current = text
      setConflict(false)
      note(current.text())
      onSaved(text, saved.hash)
    } catch (error) {
      const failure = toHostError(error)
      if (failure.code === "CONTROL_WORKSPACE_CONFLICT") setConflict(true)
      else toast("error", failure.code === "CONTROL_WORKSPACE_BINARY" ? `${basename(path)} is not plain UTF-8 text, so Runrail does not save it.` : `Could not save ${basename(path)}: ${failure.message}`)
    } finally {
      setSaving(false)
    }
  }
  const save = useRef(() => Promise.resolve())
  save.current = () => write(base.current)

  useEffect(() => {
    let live = true
    void import("./codeEditor").then(({ createCodeEditor }) => {
      if (!live || host.current === null) return
      editor.current = createCodeEditor({ parent: host.current, text: draft.current?.text ?? content, path, onChange: note, onSave: () => void save.current() })
      editor.current.focus()
    })
    return () => {
      live = false
      editor.current?.destroy()
      editor.current = undefined
    }
    // The editor is made once per file; later text comes from its own reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  /** The file as it is on disk now, in place of the edits. */
  const reload = async (): Promise<void> => {
    const loaded = await readFile(threadId, path, folder)
    if (loaded.content === undefined || loaded.hash === undefined) {
      toast("error", `Could not read ${basename(path)} again: ${loaded.error ?? "it is too large to edit here"}`)
      return
    }
    base.current = loaded.hash
    disk.current = loaded.content
    editor.current?.reset(loaded.content)
    unsaved.delete(key)
    setDirty(false)
    setConflict(false)
    onSaved(loaded.content, loaded.hash)
  }
  /** Keeps the person's text over a file that changed since: asked for by name, never by default. */
  const overwrite = async (): Promise<void> => {
    const loaded = await readFile(threadId, path, folder)
    if (loaded.hash === undefined) return toast("error", `Could not read ${basename(path)} again: ${loaded.error ?? "it is too large to edit here"}`)
    await write(loaded.hash)
  }
  const discardThen = (then: () => void, title: string, confirm: string): void => {
    if (!dirty) return then()
    confirmAction({ title, body: `Your changes to ${basename(path)} that are not saved will be lost.`, confirm, danger: true, onConfirm: then })
  }

  return (
    <div className="file-editor">
      <div className="file-editor-bar">
        <span className={cx("file-editor-state", dirty && "is-dirty")}>{saving ? "Saving…" : dirty ? "Edited" : "Saved"}</span>
        <div className="pane-toolbar-spacer" />
        <Button size="sm" variant="ghost" onClick={() => discardThen(() => {
          unsaved.delete(key)
          onDone()
        }, `Stop editing ${basename(path)}?`, "Discard changes")}>
          Done
        </Button>
        <Button size="sm" variant="primary" kbd="mod+s" disabled={!dirty || saving} onClick={() => void save.current()}>
          Save
        </Button>
      </div>
      {conflict && (
        <div className="file-editor-conflict" role="alert">
          <TriangleAlert size={13} />
          <span>{basename(path)} changed since you opened it, maybe by the agent. Saving now would overwrite that change.</span>
          <div className="file-editor-conflict-actions">
            <Button size="sm" variant="secondary" onClick={() => discardThen(() => void reload(), "Load the new version?", "Load it")}>
              Load the new version
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(editor.current?.text() ?? "").then(() => toast("info", "Your version is on the clipboard."), () => toast("error", "Could not copy your version."))}>
              Copy my version
            </Button>
            <Button size="sm" variant="ghost" onClick={() => confirmAction({ title: `Overwrite ${basename(path)}?`, body: "The change made since you opened it will be lost.", confirm: "Overwrite", danger: true, onConfirm: () => void overwrite() })}>
              Overwrite it
            </Button>
          </div>
        </div>
      )}
      <div className="file-editor-body" ref={host} />
    </div>
  )
}

interface Crumb {
  readonly name: string
  /** The folder inside the workspace this crumb goes to; none for the folders above it. */
  readonly folder?: string
  readonly current: boolean
}

/**
 * Where the pane is: the workspace's whole path, then the folders inside it. Folders inside the
 * workspace go there; the ones above it are for reading only, since the pane lists nothing outside.
 */
function Crumbs({ workspace, at, file = false, onPick }: { readonly workspace: string | undefined; readonly at: string; readonly file?: boolean; readonly onPick: (folder: string) => void }) {
  const strip = useRef<HTMLElement>(null)
  const [clipped, setClipped] = useState(false)
  const outer = workspace === undefined ? [] : pathCrumbs(workspace)
  const root = outer.pop() ?? "Workspace"
  const inner = at.split("/").filter((part) => part.length > 0)
  const crumbs: Crumb[] = [
    ...outer.map((name) => ({ name, current: false })),
    { name: root, folder: "", current: inner.length === 0 },
    ...inner.map((name, index) => ({ name, folder: inner.slice(0, index + 1).join("/"), current: index === inner.length - 1 })),
  ]

  // The end of the path is where the pane is, so a path too long for the pane keeps that end in view.
  useLayoutEffect(() => {
    const node = strip.current
    if (node === null) return
    const measure = (): void => setClipped(node.scrollLeft > 0)
    const settle = (): void => {
      node.scrollLeft = node.scrollWidth
      measure()
    }
    settle()
    const observer = new ResizeObserver(settle)
    observer.observe(node)
    node.addEventListener("scroll", measure, { passive: true })
    return () => {
      observer.disconnect()
      node.removeEventListener("scroll", measure)
    }
  }, [workspace, at])

  return (
    <nav ref={strip} className={cx("crumbs", clipped && "is-clipped")} aria-label="Location" title={workspace === undefined ? at : at.length === 0 ? workspace : `${workspace}/${at}`}>
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={`${String(index)}:${crumb.name}`}>
            {index > 0 && <ChevronRight size={11} className="crumb-sep" aria-hidden />}
            {crumb.current ? (
              <span className={cx("crumb", "is-current", file && "is-file")} aria-current="location">
                {crumb.name}
              </span>
            ) : crumb.folder === undefined ? (
              <span className="crumb is-outer">{crumb.name}</span>
            ) : (
              <button type="button" className="crumb" onClick={() => onPick(crumb.folder ?? "")}>
                {crumb.name}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
