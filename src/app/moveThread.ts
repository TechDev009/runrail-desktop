import { GitStatusSchema, parseOr } from "../protocol/schemas"
import { threadRpc } from "./engines"
import type { Project, ThreadMeta } from "./persist"
import { words } from "./platformWords"
import { readProjectGit } from "./projectGit"
import { get, openThread, projectById, set, threadById } from "./store"
import { splitUpstream } from "./threadBar"
import { threadContext } from "./threadMention"
import { createWorktreeThread } from "./workflows"

/**
 * Continue a thread on another machine: the same repository in a project on the
 * other side, this Mac or a remote machine, gets a worktree thread on the thread's branch as its
 * upstream has it, with the conversation in its composer for the person to send. Nothing is
 * committed or pushed here: a branch with work not on its upstream is refused until it is pushed.
 */

type RepoFields = Pick<Project, "git" | "connectedTo">

function repositoryKey(project: RepoFields): string | undefined {
  const to = project.connectedTo
  if (!project.git || to?.host === undefined || to.path === undefined) return undefined
  return `${to.host.toLowerCase()}/${to.path.toLowerCase().replace(/\.git$/, "")}`
}

/** Two projects hold the same repository when their folders push to the same one. */
export function sameRepository(a: RepoFields, b: RepoFields): boolean {
  const key = repositoryKey(a)
  return key !== undefined && key === repositoryKey(b)
}

/** Where a project's folder is, for the person: this computer or the machine's host. */
export function whereOf(project: Pick<Project, "remote">): string {
  return project.remote?.host ?? `this ${words().computer}`
}

function elsewhere(project: Project, source: Project): boolean {
  return project.id !== source.id && project.git && project.remote?.id !== source.remote?.id
}

/** Whether a git project on another machine exists at all, for offering the move. */
export function anyElsewhere(source: Project, projects: readonly Project[]): boolean {
  return source.git && projects.some((project) => elsewhere(project, source))
}

/** The projects on another machine with the thread's repository, as last read. */
export function moveTargets(threadId: string, projects: readonly Project[] = get().projects): readonly Project[] {
  const source = projectById(threadById(threadId)?.projectId)
  if (source === undefined) return []
  return projects.filter((project) => elsewhere(project, source) && sameRepository(project, source))
}

/** Reads the repository of the projects not read yet, reaching remote machines, then the targets. */
export async function findMoveTargets(threadId: string): Promise<readonly Project[]> {
  const source = projectById(threadById(threadId)?.projectId)
  if (source === undefined) return []
  const unread = [source, ...get().projects.filter((project) => elsewhere(project, source))].filter((project) => project.connectedTo === undefined)
  // One at a time, as the app reads folders elsewhere.
  for (const project of unread) await readProjectGit(project.id, 0, { reach: true })
  return moveTargets(threadId)
}

export type MovePlan = { readonly ok: true; readonly remote: string; readonly branch: string } | { readonly ok: false; readonly reason: string }

/** Whether the thread's work is all on its upstream, which the other machine starts from. */
export async function movePlan(threadId: string): Promise<MovePlan> {
  const status = parseOr(GitStatusSchema, await threadRpc(threadId, "git.status", { maxEntries: 200 }).catch(() => undefined))
  if (status === undefined) return { ok: false, reason: "The thread's git status could not be read." }
  const branch = status.branch ?? undefined
  if (status.detached === true || branch === undefined || branch.length === 0) return { ok: false, reason: "The thread is not on a branch." }
  const { staged, unstaged, untracked, conflicted } = status.counts
  const changed = staged + unstaged + untracked + conflicted
  if (changed > 0) return { ok: false, reason: `${String(changed)} changed ${changed === 1 ? "file is" : "files are"} not committed on ${branch}. Commit and push first; the other machine starts from what the upstream has.` }
  const upstream = splitUpstream(status.upstream)
  if (upstream === undefined) return { ok: false, reason: `${branch} has no upstream yet. Push it first.` }
  const ahead = status.ahead ?? 0
  if (ahead > 0) return { ok: false, reason: `${String(ahead)} ${ahead === 1 ? "commit" : "commits"} on ${branch} ${ahead === 1 ? "is" : "are"} not pushed. Push first.` }
  return { ok: true, ...upstream }
}

/** Starts the thread's work in `targetId`'s project and opens it, the conversation ready to send. */
export async function continueOn(threadId: string, targetId: string, plan: Extract<MovePlan, { ok: true }>): Promise<ThreadMeta> {
  const thread = threadById(threadId)
  const source = projectById(thread?.projectId)
  const target = projectById(targetId)
  if (thread === undefined || source === undefined || target === undefined) throw new Error("The thread or the project is gone.")
  const created = await createWorktreeThread(
    {
      projectId: target.id,
      backend: thread.backend,
      title: thread.title,
      ...(thread.model === undefined ? {} : { model: thread.model }),
      ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
      // A connection lives on this Mac; on a remote machine the thread runs on what is signed in there.
      ...(target.remote === undefined && thread.connectionId !== undefined ? { connectionId: thread.connectionId } : {}),
    },
    { kind: "branch", name: plan.branch, remote: plan.remote },
    // The same branch name when it is free there, so a push continues the same pull request.
    { firstMessage: thread.title, branch: plan.branch },
  )
  const context = await threadContext(threadId).catch(() => undefined)
  const note = `Continue this work here. This worktree starts from ${plan.remote}/${plan.branch}, where it was left on ${whereOf(source)}.`
  set((state) => ({ drafts: { ...state.drafts, [created.id]: context === undefined ? note : `${context}\n\n${note}` } }))
  openThread(created.id)
  return created
}
