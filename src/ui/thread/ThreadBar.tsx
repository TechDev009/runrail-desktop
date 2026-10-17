import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, GitMerge, GitPullRequest, RefreshCw, SquareArrowOutUpRight, Upload } from "lucide-react"
import { useEffect, useState } from "react"
import { confirmAction, openInEditor, reveal, workspaceOf } from "../../app/actions"
import { checkoutBusy, fetchedAt, fetchUpstream, previewPush, pullBranch } from "../../app/gitBar"
import { repoLine } from "../../app/gitHosts"
import type { Project } from "../../app/persist"
import { openPanel } from "../../app/panels"
import { useWords } from "../../app/platformWords"
import { useProjectHeads } from "../../app/projectGit"
import { toast, useApp } from "../../app/store"
import { branchView, changesLabel, fetchedLabel, filesLabel, oneButton, startView, type OneButton } from "../../app/threadBar"
import { applyWinner } from "../../app/workflows"
import type { GitPushPreview } from "../../protocol/schemas"
import { toHostError } from "../../host"
import { cx, Menu, Spinner, type MenuEntry } from "../common"
import { useGit, useProject, useThread } from "../hooks"
import { PushDialog } from "../inspector/ReviewPane"
import { openProjectSettings } from "../shell/revealSetting"
import { PullRequestChip } from "./PullRequests"

/**
 * The git row above the composer: the repository, the branch and its menu, the
 * checkout's changes, the PR chip, and the one git button. Shown from the thread's creation,
 * with the project's branch until the thread's own checkout is read; not shown for a
 * folder that is not a git repository.
 */
export function ThreadBar({ threadId }: { readonly threadId: string }) {
  const thread = useThread(threadId)
  const project = useProject(thread?.projectId)
  const git = useGit(threadId)
  const head = useProjectHeads((heads) => (thread === undefined ? undefined : heads[thread.projectId]))
  const busy = useApp(() => checkoutBusy(threadId))
  const [push, setPush] = useState<GitPushPreview | undefined>()

  // Opening a thread fetches its upstream at most once per 5 minutes per checkout.
  const upstream = git.status?.upstream
  useEffect(() => {
    if (upstream != null) void fetchUpstream(threadId, "open")
  }, [threadId, upstream])

  if (thread === undefined) return null
  if ((project?.git !== true && thread.worktree === undefined) || git.error === "NOT_A_REPOSITORY") return null
  const status = git.status
  const branch = branchView(status, thread.worktree) ?? (status === undefined && thread.worktree === undefined ? startView(head, { worktree: false, start: { kind: "head" } }) : undefined)
  const changes = changesLabel(git.stats)
  const button = oneButton({ status, hasRemote: git.remotes === undefined ? undefined : git.remotes.length > 0, busy })
  const startPush = async (): Promise<void> => {
    const preview = await previewPush(threadId)
    if (preview !== undefined) setPush(preview)
  }

  return (
    <div className="thread-bar" role="toolbar" aria-label="Git">
      {project !== undefined && <RepoMark project={project} />}
      {branch !== undefined && <BranchControl threadId={threadId} label={branch.label} counts={branch.counts} worktree={branch.worktree} title={branch.title} fallback={head?.branch} button={button} onPush={() => void startPush()} />}
      {changes !== undefined && git.stats !== undefined && (
        <button type="button" className="bar-changes" aria-label={`${changes}. Open the Review pane`} onClick={() => openPanel(threadId, "review")} title={git.stats.truncated === true ? "Counting stopped at the size limit. Open the Review pane" : "Open the Review pane"}>
          <FileDiff size={12} />
          <span className="bar-changes-add">+{git.stats.additions}</span>
          <span className="bar-changes-del">-{git.stats.deletions}</span>
          <span className="bar-changes-files">· {filesLabel(git.stats)}</span>
        </button>
      )}
      <PullRequestChip threadId={threadId} />
      <span className="thread-bar-spacer" />
      {button !== undefined && <TheButton button={button} working={git.busy} onPull={() => void pullBranch(threadId)} onPush={() => void startPush()} />}
      {push !== undefined && <PushDialog threadId={threadId} preview={push} onClose={() => setPush(undefined)} />}
    </div>
  )
}

/** The repository's name, first in the row; it opens Project settings, where its service is answered or changed. */
export function RepoMark({ project }: { readonly project: Project }) {
  const repo = repoLine(project)
  if (repo === undefined) return null
  return (
    <button type="button" className="bar-service" aria-label={`Repository ${repo.name}. Open Project settings`} title={repo.title} onClick={() => openProjectSettings(project.id)}>
      <FolderGit2 size={12} />
      <span className="bar-service-name">{repo.name}</span>
    </button>
  )
}

function TheButton({ button, working, onPull, onPush }: { readonly button: OneButton; readonly working: "fetch" | "pull" | "push" | undefined; readonly onPull: () => void; readonly onPush: () => void }) {
  const running = (button.kind === "pull" && working === "pull") || ((button.kind === "push" || button.kind === "publish") && working === "push")
  const icon = button.kind === "pull" ? <ArrowDownToLine size={12} /> : button.kind === "sync" ? <GitMerge size={12} /> : button.kind === "publish" ? <Upload size={12} /> : <ArrowUpFromLine size={12} />
  return (
    <button
      type="button"
      className={cx("bar-button", button.kind === "sync" && "is-diverged")}
      disabled={button.disabled !== undefined || working !== undefined}
      title={button.disabled}
      aria-label={button.disabled === undefined ? button.label : `${button.label}: ${button.disabled}`}
      onClick={() => (button.kind === "pull" ? onPull() : onPush())}
    >
      {running ? <Spinner size={11} /> : icon}
      {button.label}
    </button>
  )
}

function BranchControl({
  threadId,
  label,
  counts,
  worktree,
  title,
  fallback,
  button,
  onPush,
}: {
  readonly threadId: string
  readonly label: string
  readonly counts: string | undefined
  readonly worktree: boolean
  readonly title: string
  /** The project checkout's branch, until the thread's own status is read. */
  readonly fallback: string | undefined
  readonly button: OneButton | undefined
  readonly onPush: () => void
}) {
  const thread = useThread(threadId)
  const git = useGit(threadId)
  const words = useWords()
  const now = Date.now()
  const status = git.status
  const name = status?.branch ?? thread?.worktree?.branch ?? (status === undefined ? fallback : undefined) ?? undefined
  const upstream = status?.upstream ?? undefined
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const busy = checkoutBusy(threadId)
  const noRemote = git.remotes !== undefined && git.remotes.length === 0
  const workspace = workspaceOf(threadId)

  const pullReason = upstream === undefined ? "Not published" : behind === 0 ? "Up to date" : ahead > 0 ? "Both changed: pull only fast-forwards" : busy ? "Wait for the agent to finish" : undefined
  const pushReason = name === undefined ? "No branch is checked out" : noRemote ? "This repository has no remote" : upstream !== undefined && ahead === 0 ? "Nothing to push" : undefined
  const items: MenuEntry[] = [
    { id: "heading", heading: name === undefined ? "No branch" : upstream === undefined ? `${name} · Not published` : `${name} → ${upstream}` },
    { id: "fetched", heading: git.busy === "fetch" ? "Fetching…" : fetchedLabel(fetchedAt(threadId), now) },
    { id: "fetch", label: "Fetch", icon: <RefreshCw size={14} />, disabled: upstream === undefined || git.busy !== undefined, ...(upstream === undefined ? { description: "Not published" } : {}), onSelect: () => void fetchUpstream(threadId, "button") },
    { id: "pull", label: behind > 0 ? `Pull ↓${String(behind)}` : "Pull", icon: <ArrowDownToLine size={14} />, disabled: pullReason !== undefined || git.busy !== undefined, ...(pullReason === undefined ? {} : { description: pullReason }), onSelect: () => void pullBranch(threadId) },
    {
      id: "push",
      label: upstream === undefined ? "Publish branch" : ahead > 0 ? `Push ↑${String(ahead)}` : "Push",
      icon: upstream === undefined ? <Upload size={14} /> : <ArrowUpFromLine size={14} />,
      disabled: pushReason !== undefined || git.busy !== undefined,
      ...(pushReason === undefined ? {} : { description: pushReason }),
      onSelect: onPush,
    },
    ...(button?.kind === "sync" ? [{ id: "diverged", label: "Sync", icon: <GitMerge size={14} />, disabled: true, description: button.disabled, onSelect: () => undefined }] : []),
    { id: "sep", separator: true },
    ...(thread?.worktree !== undefined
      ? [
          { id: "editor", label: "Open in editor", icon: <SquareArrowOutUpRight size={14} />, onSelect: () => void openInEditor(workspace) },
          { id: "reveal", label: words.reveal, icon: <FolderOpen size={14} />, onSelect: () => void reveal(workspace) },
          {
            id: "apply",
            label: "Apply to project",
            icon: <Check size={14} />,
            description: "Copies this worktree's changes into the project checkout, staged",
            onSelect: () =>
              confirmAction({
                title: "Apply to project?",
                body: "This worktree's changes are applied to the project checkout and staged for review there. The worktree is kept.",
                confirm: "Apply",
                onConfirm: () => void applyWinner(threadId, false).catch((error: unknown) => toast("error", `Could not apply: ${toHostError(error).message}`)),
              }),
          },
        ]
      : []),
    ...(name === undefined
      ? []
      : [{ id: "copy", label: "Copy branch name", icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(name).then(() => toast("success", "Branch name copied")) }]),
  ]

  return (
    <Menu
      side="top"
      width={280}
      items={items}
      trigger={({ toggle, ref, open: shown }) => (
        <button
          ref={ref}
          type="button"
          className={cx("bar-branch", worktree && "is-worktree", shown && "is-active")}
          title={title}
          onClick={() => {
            if (!shown) void fetchUpstream(threadId, "menu")
            toggle()
          }}
        >
          {thread?.worktree?.base?.kind === "pr" ? <GitPullRequest size={12} /> : <GitBranch size={12} />}
          <span className="bar-branch-name">{label}</span>
          {counts !== undefined && <span className="bar-branch-counts">{counts}</span>}
        </button>
      )}
    />
  )
}
