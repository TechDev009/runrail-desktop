import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Lock,
  MessageSquare,
  Minus,
  Plus,
  RefreshCw,
  ShieldCheck,
  Undo2,
} from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { confirmAction, focusComposer, openUrl, workspaceOf } from "../../app/actions"
import { mergeDiff, PARTIAL_LIMIT } from "../../app/diffRefresh"
import { refreshGit, send, steer, threadRpc } from "../../app/engines"
import { openFileMenu } from "../../app/fileMenu"
import { previewWorkspaceFile } from "../../app/filePreview"
import { folderKey, folderRpc, NOT_A_REPOSITORY, patchFolderGit, refreshFolderGit, useFolderGit, useShownFolder, type FolderGitView } from "../../app/folderGit"
import type { WorktreeBase } from "../../app/persist"
import { noteCommit, recordGame } from "../../app/play"
import { get, patchGit, runtimeOf, setPrefs, toast, useApp } from "../../app/store"
import { toHostError } from "../../host"
import { basename, dirname, plural, relativeTime } from "../../lib/format"
import { GitBranchesSchema, GitCommitSchema, GitDiffSchema, GitPushPreviewSchema, GitStatusSchema, hasCapability, parseOr, type GitBranches, type GitCommit, type GitDiff, type GitDiffFile, type GitEntry, type GitPushPreview, type GitStatus } from "../../protocol/schemas"
import { isBusy } from "../../thread/reducer"
import { Button, cx, EmptyState, IconButton, Modal, Segmented, Spinner, Toggle } from "../common"
import { addComments, useReviewMemory, type LineComment } from "../../app/reviewMemory"
import { dismissSelfReview, openSelfReview, reviewMyChanges, useSelfReviews } from "../../app/selfReview"
import { DIFF_LAYOUTS, layoutFor, patchHeight, patchShape, PatchView, type PatchShape } from "../diff/DiffView"
import { useGit, useProject, useThread } from "../hooks"
import { keepMounted, useListOffset } from "../virtual"
import { FolderSwitch } from "./FolderSwitch"
import { z } from "zod"
import { notePullRequestCreated, refreshPullRequests } from "../../app/gitBar"

/**
 * Review pane: the working tree's changes as reviewable diffs. Stage, unstage, or discard per
 * file; leave line comments and send them to the agent as one message; commit, push, and open a
 * pull request without leaving the app. Comments and "viewed" marks live in memory only.
 */

type Scope = "head" | "unstaged" | "staged"


const AUTO_EXPAND_FILES = 12
const AUTO_EXPAND_LINES = 600
/** A file's header row, border included. */
const FILE_HEAD = 34
const NO_SHAPE: PatchShape = { lines: 0, hunks: 0 }

const CHANGE_LABEL: Record<string, { readonly letter: string; readonly label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  untracked: { letter: "U", label: "Untracked" },
  "type-changed": { letter: "T", label: "Type changed" },
}

function changeOf(file: GitDiffFile): { readonly letter: string; readonly label: string } {
  return CHANGE_LABEL[file.change] ?? { letter: "M", label: file.change }
}

/** How many changed files a diff scope holds; an untracked file counts as unstaged. */
function scopeCount(entries: ReadonlyMap<string, GitEntry>, scope: "staged" | "unstaged"): number {
  let count = 0
  for (const entry of entries.values()) if (scope === "staged" ? entry.staged === true : entry.unstaged === true || entry.untracked === true) count += 1
  return count
}

export function commentPrompt(comments: readonly LineComment[]): string {
  const lines = comments.map((comment) => {
    const excerpt = comment.excerpt.trim().slice(0, 100)
    const from = comment.from === undefined ? "" : ` [${comment.severity === undefined ? "" : `${comment.severity}, `}from the review]`
    return `- ${comment.path}:${String(comment.line)}${excerpt.length > 0 ? ` (\`${excerpt}\`)` : ""}${from}\n  ${comment.text.replace(/\n/g, "\n  ")}`
  })
  return [`Please address these review comments on your changes:`, "", ...lines].join("\n")
}

const LogSchema = z.looseObject({ commits: z.array(GitCommitSchema).max(200) })
const PrStatusSchema = z.looseObject({
  pullRequests: z.array(z.looseObject({ number: z.number(), url: z.string().max(2048), title: z.string().max(1024).optional(), state: z.string().max(32).optional(), draft: z.boolean().optional() })).max(50).optional(),
})
type PullRequest = NonNullable<z.infer<typeof PrStatusSchema>["pullRequests"]>[number]
type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export function ReviewPane({ threadId }: { readonly threadId: string }) {
  const folder = useShownFolder(threadId)
  return <ReviewChanges key={folder ?? ""} threadId={threadId} {...(folder === undefined ? {} : { folder })} />
}

/** The changes in the thread's checkout or a related folder; pushes, pull requests and the second-pass review are the checkout's only. */
function ReviewChanges({ threadId, folder }: { readonly threadId: string; readonly folder?: string }) {
  const thread = useThread(threadId)
  const project = useProject(thread?.projectId)
  const ownGit = useGit(threadId)
  const folderGit = useFolderGit(threadId, folder)
  const git: FolderGitView = folder === undefined ? ownGit : folderGit
  const rpc = useCallback<Rpc>((method, params = {}) => folderRpc(threadId, folder, method, params), [threadId, folder])
  const refresh = useCallback((): Promise<void> => (folder === undefined ? refreshGit(threadId) : refreshFolderGit(threadId, folder)), [threadId, folder])
  const patchStatus = (patch: Partial<FolderGitView>): void => (folder === undefined ? patchGit(threadId, patch) : patchFolderGit(threadId, folder, patch))
  /** Comments and viewed marks on a related folder are its own. */
  const memoryKey = folder === undefined ? threadId : folderKey(threadId, folder)
  const diffView = useApp((state) => state.prefs.diffView)
  const [scope, setScope] = useState<Scope>("head")
  const [diff, setDiff] = useState<GitDiff | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({})
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [commits, setCommits] = useState<readonly GitCommit[]>([])
  const [pulls, setPulls] = useState<readonly PullRequest[]>([])
  const request = useRef(0)
  const shown = useRef<GitDiff | undefined>(undefined)
  const fullRead = useRef(false)
  /** Paths this pane just staged, unstaged or discarded, and the status time that wrote. */
  const touched = useRef<{ readonly at: number; readonly paths: readonly string[] } | undefined>(undefined)
  const [pinned, setPinned] = useState<string | undefined>()
  const [large, setLarge] = useState<ReadonlySet<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const comments = useReviewMemory((state) => state.comments[memoryKey] ?? EMPTY_COMMENTS)
  const viewed = useReviewMemory((state) => state.viewed[memoryKey] ?? EMPTY_VIEWED)
  const workspace = folder ?? workspaceOf(threadId)
  const status = git.status
  // Pull requests need a GitHub connector in the engine; without one the engine refuses the call.
  const pullsReady = useApp((state) => hasCapability(state.runtime[threadId]?.contract, "git.pr"))

  // A stage, unstage or discard reads only the files it touched; while a whole read is on its way, that read covers them.
  const load = useCallback(async (paths?: readonly string[]): Promise<void> => {
    const id = ++request.current
    const base = shown.current
    const partial = paths !== undefined && paths.length <= PARTIAL_LIMIT && base !== undefined && !fullRead.current
    if (!partial) fullRead.current = true
    setLoading(true)
    try {
      const value = await rpc("git.diff", { scope, contextLines: 3, maxFiles: 500, maxBytes: 8 * 1_024 * 1_024, includeUntracked: scope !== "staged", ...(partial ? { paths } : {}) })
      if (id !== request.current) return
      const parsed = parseOr(GitDiffSchema, value)
      const next = partial && parsed !== undefined ? mergeDiff(base, paths, parsed) : parsed
      if (partial && next === undefined) {
        void load()
        return
      }
      shown.current = next
      setDiff(next)
      setError(next === undefined ? "The engine returned a diff this app cannot read." : undefined)
    } catch (failure) {
      if (id === request.current) setError(toHostError(failure).message)
    } finally {
      if (id === request.current) {
        setLoading(false)
        fullRead.current = false
      }
    }
  }, [rpc, scope])

  // A related folder's status is read when it is shown; the thread's own is kept fresh by the engine's events.
  useEffect(() => {
    if (folder !== undefined) void refreshFolderGit(threadId, folder)
  }, [threadId, folder])

  // Edits made outside the agent (an editor, a terminal) show when the person comes back to the window.
  useEffect(() => {
    if (git.error === NOT_A_REPOSITORY) return
    const onFocus = (): void => {
      if (document.visibilityState === "visible") void refresh()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh, git.error])

  // Another scope's files are not shown under this one while it loads.
  useEffect(() => {
    shown.current = undefined
    setDiff(undefined)
    setError(undefined)
  }, [threadId, scope])

  useEffect(() => {
    if (git.error === NOT_A_REPOSITORY) return
    const local = touched.current
    touched.current = undefined
    void load(local !== undefined && local.at === git.updatedAt ? local.paths : undefined)
  }, [load, git.updatedAt, git.error])

  useEffect(() => {
    if (git.error === NOT_A_REPOSITORY) return
    let live = true
    rpc("git.log", { limit: 8 })
      .then((value) => live && setCommits(parseOr(LogSchema, value)?.commits ?? []))
      .catch(() => live && setCommits([]))
    return () => {
      live = false
    }
  }, [rpc, git.updatedAt, git.error])

  useEffect(() => {
    if (git.error === NOT_A_REPOSITORY || !pullsReady || folder !== undefined) return
    let live = true
    threadRpc(threadId, "git.pr.status", {})
      .then((value) => live && setPulls(parseOr(PrStatusSchema, value)?.pullRequests ?? []))
      .catch(() => live && setPulls([]))
    return () => {
      live = false
    }
  }, [threadId, git.error, status?.branch, pullsReady, folder])

  const entries = useMemo(() => {
    const map = new Map<string, GitEntry>()
    for (const entry of status?.entries ?? []) map.set(entry.path, entry)
    return map
  }, [status])

  const mutate = async (method: "git.stage" | "git.unstage" | "git.discard", paths: readonly string[], options: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    if (paths.length === 0) return
    setPending((current) => new Set([...current, ...paths]))
    try {
      const result = (await rpc(method, { paths, ...options })) as { status?: unknown; skippedConflicted?: unknown }
      if (typeof result.skippedConflicted === "number" && result.skippedConflicted > 0) toast("info", `${plural(result.skippedConflicted, "conflicted file")} left untouched. Resolve the conflict first.`)
      const next = parseOr(GitStatusSchema, result.status)
      if (next !== undefined) {
        const at = Date.now()
        touched.current = { at, paths: [...(touched.current?.paths ?? []), ...paths] }
        patchStatus({ status: next, updatedAt: at, loading: false, error: undefined })
      } else await refresh()
    } catch (failure) {
      const verb = method === "git.stage" ? "stage" : method === "git.unstage" ? "unstage" : "discard"
      toast("error", `Could not ${verb}: ${toHostError(failure).message}`)
    } finally {
      setPending((current) => {
        const next = new Set(current)
        for (const path of paths) next.delete(path)
        return next
      })
    }
  }

  const discard = (paths: readonly string[]): void => {
    const untracked = paths.some((path) => entries.get(path)?.untracked === true)
    confirmAction({
      title: paths.length === 1 ? `Discard changes to ${basename(paths[0] ?? "")}?` : `Discard changes to ${plural(paths.length, "file")}?`,
      body: `${untracked ? "New files will be deleted. " : ""}This restores the files to the last commit and cannot be undone.`,
      confirm: "Discard",
      danger: true,
      // The engine keeps staged changes and new files unless asked; the dialog promises the last commit.
      onConfirm: () => void mutate("git.discard", paths, { scope: "all", includeUntracked: true }),
    })
  }

  const addComment = (comment: Omit<LineComment, "id">): void =>
    addComments(memoryKey, [comment])
  const removeComment = (id: string): void =>
    useReviewMemory.setState((state) => ({ comments: { ...state.comments, [memoryKey]: (state.comments[memoryKey] ?? []).filter((comment) => comment.id !== id) } }))
  const clearComments = (): void => useReviewMemory.setState((state) => ({ comments: { ...state.comments, [memoryKey]: [] } }))
  const toggleViewed = (path: string): void => {
    const next = viewed.includes(path) ? viewed.filter((item) => item !== path) : [...viewed, path]
    useReviewMemory.setState((state) => ({ viewed: { ...state.viewed, [memoryKey]: next } }))
    if (!viewed.includes(path)) setExpanded((current) => ({ ...current, [path]: false }))
  }

  const sendComments = async (): Promise<void> => {
    // The agent works from the thread's checkout, so a related folder's files go by their full path.
    const text = commentPrompt(folder === undefined ? comments : comments.map((comment) => ({ ...comment, path: `${folder}/${comment.path}` })))
    // Cleared once the message is on its way; a failed send keeps them, and its bubble can be retried.
    if (isBusy(runtimeOf(threadId).timeline)) await steer(threadId, { text })
    else send(threadId, { text })
    clearComments()
    focusComposer()
  }

  const files = diff?.files ?? NO_FILES
  const shapes = useMemo(() => new Map(files.map((file) => [file.path, patchShape(file.patch)])), [files])
  const autoOpen = files.length <= AUTO_EXPAND_FILES
  const isOpen = (file: GitDiffFile): boolean => expanded[file.path] ?? (autoOpen && !viewed.includes(file.path) && (shapes.get(file.path)?.lines ?? 0) <= AUTO_EXPAND_LINES)
  const offset = useListOffset(scrollRef, listRef, files.length > 0)
  const pinnedIndex = pinned === undefined ? undefined : files.findIndex((file) => file.path === pinned)
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const file = files[index]
      if (file === undefined || !isOpen(file)) return FILE_HEAD
      const hidden = file.sensitive === true || file.binary === true
      return FILE_HEAD + patchHeight(hidden ? NO_SHAPE : (shapes.get(file.path) ?? NO_SHAPE), large.has(file.path)) + (file.truncated === true && file.patch !== undefined ? patchHeight(NO_SHAPE) : 0)
    },
    getItemKey: (index) => files[index]?.path ?? index,
    overscan: 3,
    gap: 6,
    scrollMargin: offset,
    rangeExtractor: keepMounted(pinnedIndex),
  })

  if (folder !== undefined && git.error === NOT_A_REPOSITORY)
    return (
      <div className="review">
        <FolderSwitch threadId={threadId} />
        <EmptyState icon={<GitBranch size={20} />} title="Not a git repository">
          {basename(folder)} is not in a git repository. Its files are in the Files pane.
        </EmptyState>
      </div>
    )
  if (folder === undefined && project?.git === false && thread?.worktree === undefined)
    return (
      <EmptyState icon={<GitBranch size={20} />} title="Not a git repository">
        Review, staging, and commits need git. Run <code>git init</code> in {project.name} and reopen the project.
      </EmptyState>
    )

  const totals = diff?.totals
  const unstagedPaths = files.filter((file) => entries.get(file.path)?.unstaged === true || entries.get(file.path)?.untracked === true).map((file) => file.path)
  const stagedPaths = files.filter((file) => entries.get(file.path)?.staged === true).map((file) => file.path)
  const conflicted = status?.counts.conflicted ?? 0

  const renderFile = (file: GitDiffFile): ReactNode => {
    const entry = entries.get(file.path)
    const open = isOpen(file)
    const change = changeOf(file)
    const fullyStaged = entry !== undefined && entry.staged && !entry.unstaged && !entry.untracked
    const partial = entry !== undefined && entry.staged && (entry.unstaged || entry.untracked)
    const busy = pending.has(file.path)
    const fileComments = comments.filter((comment) => comment.path === file.path)
    const seen = viewed.includes(file.path)
    const at = { threadId, ...(folder === undefined ? {} : { folder }) }
    return (
      <section className={cx("review-file", seen && "is-viewed")} aria-label={file.path} onFocus={() => pinned !== file.path && setPinned(file.path)}>
        <div className="review-file-head" onContextMenu={(event) => workspace !== undefined && openFileMenu(event, workspace, file.path, at)}>
          <button type="button" className="review-file-toggle" aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [file.path]: !open }))}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className={cx("change-badge", `change-${change.letter}`)} title={change.label}>
              {change.letter}
            </span>
            <span className="review-file-path" title={file.originalPath === undefined ? file.path : `${file.originalPath} → ${file.path}`}>
              {dirname(file.path).length > 0 && <span className="muted">{dirname(file.path)}/</span>}
              {basename(file.path)}
            </span>
            {fileComments.length > 0 && (
              <span className="review-file-comments" title={plural(fileComments.length, "comment")}>
                <MessageSquare size={11} /> {fileComments.length}
              </span>
            )}
            <span className="review-file-counts">
              {file.additions > 0 && <span className="add">+{file.additions}</span>}
              {file.deletions > 0 && <span className="del">-{file.deletions}</span>}
            </span>
          </button>
          <div className="review-file-actions">
            {workspace !== undefined && change.letter !== "D" && (
              <IconButton label="Open file" size="sm" onClick={() => previewWorkspaceFile(workspace, file.path, at)}>
                <FileText size={12} />
              </IconButton>
            )}
            <IconButton label="Discard changes" size="sm" disabled={busy} onClick={() => discard([file.path])}>
              <Undo2 size={12} />
            </IconButton>
            <label className="viewed-toggle" title="Mark as viewed">
              <input type="checkbox" checked={seen} onChange={() => toggleViewed(file.path)} />
              Viewed
            </label>
            <button
              type="button"
              className={cx("stage-box", fullyStaged && "is-checked", partial && "is-partial")}
              role="checkbox"
              aria-checked={partial ? "mixed" : fullyStaged}
              aria-label={fullyStaged ? "Unstage file" : "Stage file"}
              title={fullyStaged ? "Staged. Click to unstage." : partial ? "Partly staged. Click to stage all." : "Click to stage"}
              disabled={busy}
              onClick={() => void mutate(fullyStaged ? "git.unstage" : "git.stage", [file.path])}
            >
              {busy ? <Spinner size={10} /> : fullyStaged ? <Check size={11} /> : partial ? <Minus size={11} /> : null}
            </button>
          </div>
        </div>
        {open && (
          <div className="review-file-body">
            {file.sensitive === true ? (
              <div className="diff-note">
                <Lock size={12} /> Content hidden: this file may contain secrets.
              </div>
            ) : file.binary === true ? (
              <div className="diff-note">Binary file</div>
            ) : file.patch === undefined || file.patch.length === 0 ? (
              <div className="diff-note">{file.truncated === true ? "Diff too large to show here." : "No textual changes"}</div>
            ) : (
              <PatchView
                patch={file.patch}
                path={file.path}
                mode={layoutFor(file.change, diffView)}
                comments={fileComments}
                onComment={addComment}
                onRemoveComment={removeComment}
                showLarge={large.has(file.path)}
                onShowLarge={() => setLarge((current) => new Set(current).add(file.path))}
              />
            )}
            {file.truncated === true && file.patch !== undefined && (
              <div className="diff-note">
                Diff truncated.{" "}
                <button type="button" className="link" onClick={() => workspace !== undefined && previewWorkspaceFile(workspace, file.path, at)}>
                  Open the file
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    )
  }

  return (
    <div className="review">
      <FolderSwitch threadId={threadId} />
      <div className="pane-toolbar">
        <Segmented
          size="sm"
          label="Diff scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: "head", label: "All", title: "Everything since the last commit", ...(status === undefined ? {} : { count: entries.size }) },
            { value: "unstaged", label: "Unstaged", ...(status === undefined ? {} : { count: scopeCount(entries, "unstaged") }) },
            { value: "staged", label: "Staged", ...(status === undefined ? {} : { count: scopeCount(entries, "staged") }) },
          ]}
        />
        <div className="pane-toolbar-spacer" />
        <Segmented
          size="sm"
          iconOnly
          label="Diff layout"
          value={diffView}
          onChange={(value) => setPrefs({ diffView: value })}
          options={DIFF_LAYOUTS}
        />
        <IconButton label="Refresh" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>

      <div className="review-summary">
        {status?.branch !== undefined && status.branch !== null && (
          <span className="review-branch" title={status.upstream ?? "No upstream"}>
            <GitBranch size={12} /> {status.branch}
            {(status.ahead ?? 0) > 0 && <span className="review-ahead">↑{status.ahead}</span>}
            {(status.behind ?? 0) > 0 && <span className="review-behind">↓{status.behind}</span>}
          </span>
        )}
        {totals !== undefined && totals.files > 0 && (
          <span className="review-totals">
            {plural(totals.files, "file")} <span className="add">+{totals.additions}</span> <span className="del">-{totals.deletions}</span>
          </span>
        )}
        <div className="pane-toolbar-spacer" />
        {files.length > 0 && folder === undefined && <ReviewMyChanges threadId={threadId} />}
        {scope !== "staged" && unstagedPaths.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => void mutate("git.stage", unstagedPaths)}>
            Stage all
          </Button>
        )}
        {scope !== "unstaged" && stagedPaths.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Minus size={12} />} onClick={() => void mutate("git.unstage", stagedPaths)}>
            Unstage all
          </Button>
        )}
      </div>

      {conflicted > 0 && (
        <div className="strip is-error">
          <CircleAlert size={13} />
          <span className="strip-text">{plural(conflicted, "file")} with merge conflicts. Resolve them before committing.</span>
        </div>
      )}
      {status?.truncated === true && <div className="strip">Showing the first part of a very large change set.</div>}

      {error !== undefined && diff !== undefined && (
        <div className="strip" role="alert">
          Could not refresh the changes: {error}{" "}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
      {folder === undefined && <SelfReviewNotes threadId={threadId} />}
      <div ref={scrollRef} className="review-files">
        {error !== undefined && diff === undefined ? (
          <EmptyState icon={<CircleAlert size={20} />} title="Could not load changes" actions={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
            {error}
          </EmptyState>
        ) : diff === undefined ? (
          <div className="pane-loading">
            <Spinner size={14} /> Loading changes…
          </div>
        ) : files.length === 0 ? (
          <EmptyState icon={<FileDiff size={20} />} title={scope === "staged" ? "Nothing staged" : "No changes"}>
            {scope === "staged" ? "Stage files from the All or Unstaged view to include them in the next commit." : "Edits the agent makes show up here for review before you commit."}
          </EmptyState>
        ) : (
          <div ref={listRef} className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const file = files[item.index]
              return file === undefined ? null : (
                <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="virtual-row" style={{ top: item.start - offset }}>
                  {renderFile(file)}
                </div>
              )
            })}
          </div>
        )}
        {diff?.truncated === true && <div className="diff-note">Only the first {files.length} files are shown.</div>}
      </div>

      {comments.length > 0 && (
        <div className="review-comments-bar">
          <MessageSquare size={13} />
          <span>{plural(comments.length, "comment")}</span>
          <div className="pane-toolbar-spacer" />
          <Button size="sm" variant="ghost" onClick={clearComments}>
            Clear
          </Button>
          <Button size="sm" variant="primary" onClick={() => void sendComments()}>
            Send to agent
          </Button>
        </div>
      )}

      <CommitBox threadId={threadId} rpc={rpc} onStatus={(next) => patchStatus({ status: next, updatedAt: Date.now(), loading: false })} refresh={refresh} memoryKey={memoryKey} remote={folder === undefined} stagedCount={status?.counts.staged ?? 0} changedCount={(status?.counts.unstaged ?? 0) + (status?.counts.untracked ?? 0)} ahead={status?.ahead ?? 0} hasUpstream={typeof status?.upstream === "string"} branch={status?.branch ?? undefined} conflicted={conflicted > 0} pulls={pulls} pullsReady={pullsReady} onPulls={setPulls} refreshedAt={git.updatedAt} />

      {commits.length > 0 && <RecentCommits commits={commits} />}
    </div>
  )
}

/** "Review my changes": a Plan-mode pass on this thread's tool and model. */
function ReviewMyChanges({ threadId }: { readonly threadId: string }) {
  const review = useSelfReviews((state) => state[threadId])
  if (review?.state === "running")
    return (
      <Button size="sm" variant="ghost" icon={<Spinner size={11} />} onClick={() => openSelfReview(threadId)} title="Open the review thread">
        Reviewing…
      </Button>
    )
  return (
    <Button size="sm" variant="ghost" icon={<ShieldCheck size={12} />} onClick={() => void reviewMyChanges(threadId)} title="A second pass on this thread's model, in Plan mode, with a security checklist. Findings land here as comments.">
      Review my changes
    </Button>
  )
}

/** What the last review said that has no line here: its summary, findings on the change as a whole, and a failure. */
function SelfReviewNotes({ threadId }: { readonly threadId: string }) {
  const review = useSelfReviews((state) => state[threadId])
  if (review === undefined || review.state === "running") return null
  const failed = review.state === "failed"
  return (
    <div className={cx("review-notes", failed && "is-failed")}>
      <div className="review-notes-head">
        <ShieldCheck size={13} />
        <span>{failed ? "The review ended without findings Runrail could read." : `Review: ${review.placed === 0 ? "no line comments" : plural(review.placed, "comment")} on the changes below${review.general.length === 0 ? "" : `, ${String(review.general.length)} more here`}`}</span>
        <div className="pane-toolbar-spacer" />
        <Button size="sm" variant="ghost" onClick={() => openSelfReview(threadId)}>
          Open review
        </Button>
        <IconButton label="Dismiss" size="sm" onClick={() => dismissSelfReview(threadId)}>
          <Minus size={12} />
        </IconButton>
      </div>
      {review.summary !== undefined && <p className="review-notes-summary">{review.summary}</p>}
      {review.general.length > 0 && (
        <ul className="review-notes-list">
          {review.general.map((finding, index) => (
            <li key={`${finding.title}:${String(index)}`}>
              <span className={cx("review-notes-sev", `sev-${finding.severity}`)}>{finding.severity}</span> {finding.title}
              {finding.path !== undefined && (
                <code>
                  {" "}
                  {finding.path}
                  {finding.line === undefined ? "" : `:${String(finding.line)}`}
                </code>
              )}
              {finding.body !== undefined && <div className="muted">{finding.body}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const EMPTY_COMMENTS: readonly LineComment[] = []
const NO_FILES: readonly GitDiffFile[] = []
const EMPTY_VIEWED: readonly string[] = []

function CommitBox({
  threadId,
  rpc,
  onStatus,
  refresh,
  memoryKey,
  remote,
  stagedCount,
  changedCount,
  ahead,
  hasUpstream,
  branch,
  conflicted,
  pulls,
  pullsReady,
  refreshedAt,
  onPulls,
}: {
  readonly threadId: string
  readonly rpc: Rpc
  readonly onStatus: (status: GitStatus) => void
  readonly refresh: () => Promise<void>
  /** Where this checkout's viewed marks are kept. */
  readonly memoryKey: string
  /** Push and pull requests: the thread's own checkout only. */
  readonly remote: boolean
  readonly stagedCount: number
  readonly changedCount: number
  readonly ahead: number
  readonly hasUpstream: boolean
  readonly branch?: string
  readonly conflicted: boolean
  readonly pulls: readonly PullRequest[]
  readonly pullsReady: boolean
  /** When the git status was last read; a refresh re-checks the remotes too. */
  readonly refreshedAt?: number
  readonly onPulls: (pulls: readonly PullRequest[]) => void
}) {
  const [message, setMessage] = useState("")
  const [committing, setCommitting] = useState(false)
  const [push, setPush] = useState<GitPushPreview | "loading" | undefined>()
  const [pr, setPr] = useState(false)
  const stageAll = stagedCount === 0 && changedCount > 0
  const canCommit = message.trim().length > 0 && (stagedCount > 0 || changedCount > 0) && !conflicted && !committing

  const commit = async (withNewFiles = false): Promise<void> => {
    if (!canCommit) return
    setCommitting(true)
    try {
      // What this commit takes, read fresh: the game layer counts it as reviewed only if every file was viewed.
      const status = parseOr(GitStatusSchema, await rpc("git.status", { maxEntries: 5_000 }))
      const entries = status?.entries ?? []
      // A new file (a `.env`, a build output) is committed only when the person saw it named and agreed.
      const newFiles = stageAll ? entries.filter((entry) => entry.untracked === true).map((entry) => entry.path) : []
      if (newFiles.length > 0 && !withNewFiles) {
        setCommitting(false)
        confirmAction({
          title: `Commit ${plural(newFiles.length, "new file")} too?`,
          body: `${newFiles.slice(0, 12).join("\n")}${newFiles.length > 12 ? `\n…and ${String(newFiles.length - 12)} more` : ""}\n\nThese are not tracked yet. To leave some out, stage the files you want and commit those.`,
          confirm: "Commit all",
          onConfirm: () => void commit(true),
        })
        return
      }
      const committed = (stageAll ? entries.filter((entry) => entry.unstaged || entry.untracked) : entries.filter((entry) => entry.staged === true)).map((entry) => entry.path)
      if (stageAll && committed.length > 0) await rpc("git.stage", { paths: committed })
      const result = (await rpc("git.commit", { message: message.trim(), runHooks: get().prefs.gitHooks })) as { shortCommit?: unknown; status?: unknown }
      const next = parseOr(GitStatusSchema, result.status)
      if (next !== undefined) onStatus(next)
      else void refresh()
      setMessage("")
      toast("success", `Committed ${typeof result.shortCommit === "string" ? result.shortCommit : ""}`.trim())
      noteCommit(threadId, committed, useReviewMemory.getState().viewed[memoryKey] ?? EMPTY_VIEWED)
    } catch (failure) {
      const error = toHostError(failure)
      toast(
        "error",
        error.code === "CONTROL_GIT_NOTHING_TO_COMMIT"
          ? "Nothing is staged to commit."
          : error.code === "CONTROL_GIT_HOOK_REJECTED"
            ? "A git hook stopped the commit. Commit in the terminal to see what it reported."
            : `Commit failed: ${error.message}`,
      )
    } finally {
      setCommitting(false)
    }
  }

  const previewPush = async (): Promise<void> => {
    setPush("loading")
    try {
      const preview = parseOr(GitPushPreviewSchema, await threadRpc(threadId, "git.push.preview", {}))
      if (preview === undefined) throw new Error("The engine returned a push preview this app cannot read.")
      setPush(preview)
    } catch (failure) {
      setPush(undefined)
      toast("error", `Could not prepare push: ${toHostError(failure).message}`)
    }
  }

  // A branch without an upstream can be published only to a remote the repository already has.
  const [remoteCount, setRemoteCount] = useState<number | undefined>()
  useEffect(() => {
    if (!remote || hasUpstream || branch === undefined) return
    let live = true
    threadRpc(threadId, "git.remote.list", {})
      .then((result) => {
        const remotes = (result as { remotes?: unknown }).remotes
        if (live) setRemoteCount(Array.isArray(remotes) ? remotes.length : undefined)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [threadId, remote, hasUpstream, branch, refreshedAt])
  const noRemote = !hasUpstream && remoteCount === 0

  const open = pulls.find((pull) => pull.state === undefined || pull.state === "open")
  const canPush = remote && (ahead > 0 || (!hasUpstream && branch !== undefined))

  return (
    <div className="commit-box">
      <textarea
        className="commit-input"
        placeholder={stagedCount > 0 ? `Commit message for ${plural(stagedCount, "staged file")}` : changedCount > 0 ? "Commit message (stages all changes)" : "Nothing to commit"}
        value={message}
        rows={2}
        maxLength={10_000}
        aria-label="Commit message"
        disabled={stagedCount === 0 && changedCount === 0}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void commit()
          }
        }}
      />
      <div className="commit-actions">
        <Button size="sm" variant="primary" icon={<GitCommitHorizontal size={13} />} loading={committing} disabled={!canCommit} onClick={() => void commit()} kbd="mod+enter">
          {stageAll ? "Stage all & commit" : "Commit"}
        </Button>
        <div className="pane-toolbar-spacer" />
        {canPush && (
          <Button size="sm" variant="secondary" icon={<ArrowUpFromLine size={13} />} loading={push === "loading"} disabled={noRemote} title={noRemote ? "This repository has no remote. Add one with git remote add, then refresh." : undefined} onClick={() => void previewPush()}>
            {ahead > 0 ? `Push ${String(ahead)}` : "Publish branch"}
          </Button>
        )}
        {!remote ? null : open !== undefined ? (
          <Button size="sm" variant="ghost" icon={<GitPullRequest size={13} />} onClick={() => void openUrl(open.url)} title={open.title}>
            #{open.number}
            <ExternalLink size={11} />
          </Button>
        ) : (
          hasUpstream &&
          ahead === 0 &&
          branch !== undefined && (
            <Button size="sm" variant="ghost" icon={<GitPullRequest size={13} />} disabled={!pullsReady} title={pullsReady ? undefined : "Pull requests need a GitHub connector in the engine configuration"} onClick={() => setPr(true)}>
              Create PR
            </Button>
          )
        )}
      </div>
      {push !== undefined && push !== "loading" && <PushDialog threadId={threadId} preview={push} onClose={() => setPush(undefined)} />}
      {pr && (
        <PrDialog
          threadId={threadId}
          onClose={() => setPr(false)}
          onCreated={(pull) => {
            onPulls([pull, ...pulls])
            setPr(false)
          }}
        />
      )}
    </div>
  )
}

export function PushDialog({ threadId, preview, onClose }: { readonly threadId: string; readonly preview: GitPushPreview; readonly onClose: () => void }) {
  const [pushing, setPushing] = useState(false)
  const push = async (): Promise<void> => {
    setPushing(true)
    try {
      const result = (await threadRpc(threadId, "git.push", { remote: preview.remote, branch: preview.branch, confirmation: preview.confirmation, runHooks: get().prefs.gitHooks })) as { status?: unknown; outcome?: unknown }
      const next = parseOr(GitStatusSchema, result.status)
      if (next !== undefined) patchGit(threadId, { status: next, updatedAt: Date.now(), loading: false })
      else void refreshGit(threadId)
      toast("success", `Pushed to ${preview.remote}/${preview.branch}`)
      recordGame("push", threadId)
      void refreshPullRequests(threadId, "push")
      onClose()
    } catch (failure) {
      const error = toHostError(failure)
      toast("error", error.code === "GIT_PUSH_CONFIRMATION_STALE" ? "The branch changed since this preview. Review the push again." : `Push failed: ${error.message}`)
      setPushing(false)
      if (error.code === "GIT_PUSH_CONFIRMATION_STALE") onClose()
    }
  }
  return (
    <Modal
      title="Push commits"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pushing} onClick={() => void push()} disabled={preview.ahead === 0 && !preview.newBranch}>
            Push to {preview.remote}
          </Button>
        </>
      }
    >
      <p className="dialog-lede">
        {preview.newBranch ? (
          <>
            Creates <code>{preview.branch}</code> on <code>{preview.remote}</code>
            {preview.setUpstream === true ? " and sets it as upstream" : ""}.
          </>
        ) : (
          <>
            Pushes {plural(preview.ahead, "commit")} to <code>
              {preview.remote}/{preview.branch}
            </code>
            .
          </>
        )}
      </p>
      <ul className="commit-list">
        {preview.commits.map((commit) => (
          <li key={commit.commit}>
            <code>{commit.shortCommit}</code> <span>{commit.summary}</span>
          </li>
        ))}
        {preview.commitsTruncated === true && <li className="muted">and more…</li>}
      </ul>
    </Modal>
  )
}

const USUAL_BASES = ["main", "master", "trunk", "develop"]

/** The branch a pull request goes into: what the worktree started from, else the repository's usual base. */
export function prBase(started: WorktreeBase | undefined, branches: GitBranches | undefined): string {
  if (started?.kind === "branch") return started.name
  const names = new Set([...(branches?.remote ?? []).filter((branch) => branch.remote === "origin").map((branch) => branch.name), ...(branches?.local ?? []).map((branch) => branch.name)])
  return USUAL_BASES.find((name) => names.has(name) && name !== branches?.current) ?? "main"
}

export function PrDialog({ threadId, onClose, onCreated }: { readonly threadId: string; readonly onClose: () => void; readonly onCreated: (pull: PullRequest) => void }) {
  const thread = useThread(threadId)
  const [title, setTitle] = useState(thread?.title ?? "")
  const [body, setBody] = useState("")
  const started = thread?.worktree?.base
  const [base, setBase] = useState(() => prBase(started, undefined))
  const baseTouched = useRef(false)
  useEffect(() => {
    if (started?.kind === "branch") return
    let live = true
    threadRpc(threadId, "git.branches", { maxBranches: 200 })
      .then((value) => {
        if (live && !baseTouched.current) setBase(prBase(undefined, parseOr(GitBranchesSchema, value)))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [threadId, started])
  const [draft, setDraft] = useState(true)
  const [creating, setCreating] = useState(false)
  const create = async (): Promise<void> => {
    setCreating(true)
    try {
      const result = (await threadRpc(threadId, "git.pr.create", { confirm: true, base: base.trim(), title: title.trim(), ...(body.trim().length > 0 ? { body } : {}), draft })) as {
        number?: unknown
        url?: unknown
        title?: unknown
      }
      if (typeof result.number !== "number" || typeof result.url !== "string") throw new Error("unexpected response")
      toast("success", `Opened pull request #${String(result.number)}`, { label: "View", run: () => void openUrl(result.url as string) })
      recordGame("pr-opened", threadId)
      notePullRequestCreated(threadId, { number: result.number, url: result.url })
      onCreated({ number: result.number, url: result.url, title: title.trim(), state: "open", draft })
    } catch (failure) {
      toast("error", `Could not create pull request: ${toHostError(failure).message}`)
      setCreating(false)
    }
  }
  return (
    <Modal
      title="Create pull request"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={creating} disabled={title.trim().length === 0 || base.trim().length === 0} onClick={() => void create()}>
            {draft ? "Create draft" : "Create"}
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Title</span>
        <input className="input" value={title} maxLength={256} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <textarea className="input" rows={6} value={body} maxLength={60_000} placeholder="What changed and why" onChange={(event) => setBody(event.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Base branch</span>
          <input
            className="input"
            value={base}
            maxLength={255}
            onChange={(event) => {
              baseTouched.current = true
              setBase(event.target.value)
            }}
          />
        </label>
        <div className="field">
          <span className="field-label">Draft</span>
          <Toggle checked={draft} onChange={setDraft} label="Open as draft" />
        </div>
      </div>
      <p className="field-hint">Uses the GitHub CLI signed in on this machine. The branch must be pushed first.</p>
    </Modal>
  )
}

function authoredAt(commit: GitCommit): number | undefined {
  if (typeof commit.authoredAt === "number") return commit.authoredAt < 1e12 ? commit.authoredAt * 1_000 : commit.authoredAt
  if (typeof commit.authoredAt === "string") {
    const parsed = Date.parse(commit.authoredAt)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function RecentCommits({ commits }: { readonly commits: readonly GitCommit[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="recent-commits">
      <button type="button" className="recent-commits-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Recent commits
      </button>
      {open && (
        <ul className="commit-list">
          {commits.map((commit) => (
            <li key={commit.commit} title={commit.commit}>
              <code>{commit.shortCommit}</code>
              <span className="commit-summary">{commit.summary}</span>
              {authoredAt(commit) !== undefined && <span className="muted">{relativeTime(authoredAt(commit) ?? 0)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
