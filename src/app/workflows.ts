import { getHost, HostError, toHostError } from "../host"
import type { BackendId } from "../host/types"
import { ExternalRefreshSchema, ExternalSessionListSchema, GitDiffSchema, GitFetchSchema, WorktreeApplySchema, WorktreeSchema, parseOr, type ExternalSession, type GitDiff, type WorktreeApply } from "../protocol/schemas"
import { deleteThread, projectRpc, reloadHistory, send, stopEngine, threadRpc } from "./engines"
import { appendNotice } from "../thread/reducer"
import { runLabel } from "./modelText"
import { newId, type Project, type ThreadMeta } from "./persist"
import { readProjectGit } from "./projectGit"
import { carried, type Selection } from "./picker"
import { addProject, createThread, get, openThread, patchRuntime, patchThread, projectById, runtimeOf, set, startingModel, threadById, toast, type Attachment, type NewThreadInput } from "./store"
import { HEAD_START, startBase, worktreeBranchNames, type WorktreeStart } from "./worktreeStart"
// Registers the turn-end listener that checks a Best of N run when it finishes.
import "./checks"

/**
 * Creates a thread that runs in its own git worktree, so parallel work never collides. The
 * worktree gets a branch of its own, named from the first message and started from `start`.
 */
export async function createWorktreeThread(input: NewThreadInput, start: WorktreeStart = HEAD_START, naming: { readonly firstMessage?: string; readonly run?: number; readonly branch?: string } = {}): Promise<ThreadMeta> {
  const project = projectById(input.projectId)
  if (project === undefined) throw new HostError("PROJECT_NOT_FOUND", "project no longer exists")
  if (!project.git) throw new HostError("NOT_A_REPOSITORY", "worktrees need a git repository")
  const revision = await startRevision(project.id, start)
  const id = newId("wt").slice(0, 60)
  const generated = worktreeBranchNames(naming.firstMessage, id, naming.run)
  const names = naming.branch === undefined ? generated : [naming.branch, ...generated]
  let created: unknown
  for (const [index, branch] of names.entries()) {
    try {
      created = await projectRpc(project.id, "worktree.create", { id, branch, ...(revision === undefined ? {} : { revision }) })
      break
    } catch (error) {
      const failure = toHostError(error)
      if (index === names.length - 1 || failure.code !== "CONTROL_GIT_CONFLICT" || !failure.message.includes("branch already exists")) throw error
    }
  }
  const worktree = parseOr(WorktreeSchema, created)
  if (worktree === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "worktree response was malformed")
  const base = startBase(start)
  return createThread({
    ...input,
    worktree: { id: worktree.id, path: worktree.path, cwd: worktree.cwd, ...(worktree.branch === undefined ? {} : { branch: worktree.branch }), ...(base === undefined ? {} : { base }) },
  })
}

/** A local branch is used as it is; a remote branch or a pull request is fetched first. */
async function startRevision(projectId: string, start: WorktreeStart): Promise<string | undefined> {
  if (start.kind === "head") return undefined
  if (start.kind === "pr") return fetchRevision(projectId, { pullRequest: start.number, ...(start.remote === undefined ? {} : { remote: start.remote }) })
  const { name, remote } = start
  if (remote === undefined) return `refs/heads/${name}`
  try {
    return await fetchRevision(projectId, { remote, branch: name })
  } catch (error) {
    // Offline, or the remote refused: the copy fetched before is still on disk.
    toast("info", `Could not update ${remote}/${name}: ${toHostError(error).message}. Starting from the copy fetched before.`)
    return `refs/remotes/${remote}/${name}`
  }
}

async function fetchRevision(projectId: string, params: Record<string, unknown>): Promise<string> {
  const fetched = parseOr(GitFetchSchema, await projectRpc(projectId, "git.fetch", params))
  if (fetched === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "fetch response was malformed")
  return fetched.revision
}

export interface BestOfInput {
  readonly projectId: string
  readonly prompt: string
  readonly attachments?: readonly Attachment[]
  readonly runs: readonly { readonly backend: BackendId; readonly model?: string; readonly connectionId?: string }[]
  /** The command each run is checked with, and whether it runs when a run finishes. */
  readonly check?: string
  readonly autoCheck?: boolean
}

/** Runs one prompt on several models or coding tools in parallel worktrees, grouped for comparison. */
export async function startBestOf(input: BestOfInput): Promise<string> {
  const project = projectById(input.projectId)
  if (project === undefined) throw new HostError("PROJECT_NOT_FOUND", "project no longer exists")
  const groupId = newId("g")
  const label = input.prompt.replace(/\s+/g, " ").trim().slice(0, 80)
  const check = input.check?.trim()
  const checking = check === undefined || check.length === 0 ? {} : { check, autoCheck: input.autoCheck !== false }
  if (checking.check !== undefined) set((state) => ({ projects: state.projects.map((item) => (item.id === project.id ? { ...item, checkCommand: checking.check } : item)) }))
  const threads: ThreadMeta[] = []
  for (const [index, run] of input.runs.entries()) {
    try {
      const thread = await createWorktreeThread(
        {
          projectId: project.id,
          backend: run.backend,
          ...(run.model === undefined ? {} : { model: run.model }),
          ...(run.connectionId === undefined ? {} : { connectionId: run.connectionId }),
          title: `${label} (${String(index + 1)})`,
          group: { id: groupId, label, ...checking },
          select: false,
        },
        HEAD_START,
        { firstMessage: input.prompt, run: index + 1 },
      )
      threads.push(thread)
    } catch (error) {
      toast("error", `Run ${String(index + 1)} could not start: ${toHostError(error).message}`)
    }
  }
  for (const thread of threads) send(thread.id, { text: input.prompt, ...(input.attachments === undefined ? {} : { attachments: input.attachments }) })
  set({ view: { kind: "compare", groupId } })
  return groupId
}

export function groupThreads(groupId: string): readonly ThreadMeta[] {
  return get().threads.filter((thread) => thread.group?.id === groupId)
}

/** The candidate's full change set relative to where its worktree started. */
export async function candidateDiff(threadId: string): Promise<GitDiff | undefined> {
  return parseOr(GitDiffSchema, await threadRpc(threadId, "git.diff", { scope: "head", includeUntracked: true, contextLines: 3, maxFiles: 500 }))
}

/**
 * Applies the winner's worktree changes to the project checkout (three-way, staged for review),
 * then optionally discards the losing worktrees.
 */
export async function applyWinner(threadId: string, discardOthers: boolean): Promise<WorktreeApply> {
  const thread = threadById(threadId)
  if (thread?.worktree === undefined) throw new HostError("NOT_A_WORKTREE", "this thread has no worktree")
  const result = parseOr(WorktreeApplySchema, await projectRpc(thread.projectId, "worktree.apply", { id: thread.worktree.id }))
  if (result === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "apply response was malformed")
  // Kept with the thread, so the comparison still says which run went in after the view closes.
  if (thread.group !== undefined) patchThread(threadId, { group: { ...thread.group, appliedAt: Date.now() } })
  const files = result.files.length
  const conflicts = result.conflicts.length
  if (conflicts > 0) toast("error", `Applied with ${String(conflicts)} conflict${conflicts === 1 ? "" : "s"} - resolve them in the project`)
  else toast("success", files === 0 ? "Nothing to apply - the candidate made no changes" : `Applied ${String(files)} file${files === 1 ? "" : "s"} to the project`)
  if (!discardOthers || thread.group === undefined) return result
  for (const other of groupThreads(thread.group.id)) {
    if (other.id === threadId || other.worktree === undefined) continue
    await discardWorktree(other.id)
  }
  return result
}

/**
 * Stops the thread's engine and removes its worktree; the thread stays as a record. A thread
 * continued on another model works in the same worktree, so every thread using it goes along.
 */
export async function discardWorktree(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const worktree = thread?.worktree
  if (thread === undefined || worktree === undefined) return
  const users = get().threads.filter((item) => item.worktree?.id === worktree.id)
  for (const user of users) await stopEngine(user.id)
  try {
    await projectRpc(thread.projectId, "worktree.remove", { id: worktree.id, force: true, deleteBranch: true })
  } catch (error) {
    toast("error", `Could not remove worktree: ${toHostError(error).message}`)
    return
  }
  set((state) => ({ threads: state.threads.map((item) => (item.worktree?.id === worktree.id ? { ...item, worktree: undefined, archived: true } : item)) }))
}

const MAX_TITLE = 256
const CONTINUED = " (continued)"

/**
 * Carries a thread's work on with another model or coding tool, in a new thread: same folder (and
 * worktree), mode, and permissions, and the message being written moves along. The conversation
 * itself stays in the old thread - a coding tool keeps its own session and cannot be handed one.
 */
/** Whether anything was said in the thread, as far as this window can tell: a turn ran, one is queued, or it was imported. */
export function threadHasHistory(threadId: string): boolean {
  const thread = threadById(threadId)
  if (thread === undefined) return false
  const runtime = runtimeOf(threadId)
  return runtime.timeline.items.length > 0 || runtime.queue.length > 0 || thread.lastStatus !== undefined || thread.importedFrom !== undefined
}

export function continueInNewThread(threadId: string, selection: Selection): ThreadMeta | undefined {
  const thread = threadById(threadId)
  if (thread === undefined) return undefined
  const base = thread.title.endsWith(CONTINUED) ? thread.title.slice(0, -CONTINUED.length) : thread.title
  const created = createThread({
    projectId: thread.projectId,
    backend: selection.backend,
    ...carried(selection),
    ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
    mode: thread.mode,
    permission: thread.permission,
    title: `${base.slice(0, MAX_TITLE - CONTINUED.length)}${CONTINUED}`,
    ...(thread.worktree === undefined ? {} : { worktree: thread.worktree }),
    parentThreadId: thread.id,
    ...(thread.runHistory === undefined ? {} : { runHistory: thread.runHistory }),
  })
  set((state) => {
    const draft = state.drafts[threadId]
    if (draft === undefined || draft.length === 0) return {}
    const { [threadId]: _moved, ...rest } = state.drafts
    return { drafts: { ...rest, [created.id]: draft } }
  })
  patchRuntime(created.id, (current) => ({
    timeline: appendNotice(current.timeline, {
      code: "model.changed",
      message: `Continued from ${runLabel({ backend: thread.backend, model: thread.model, connectionId: thread.connectionId })} to ${runLabel({ backend: selection.backend, ...carried(selection) })} in a new thread.`,
    }),
  }))
  return created
}

/** The whole conversation so far, continued in a new thread on the same model; the new thread opens. */
export function forkThread(threadId: string): ThreadMeta | undefined {
  const thread = threadById(threadId)
  if (thread === undefined) return undefined
  const created = continueInNewThread(threadId, { backend: thread.backend, ...(thread.model === undefined ? {} : { model: thread.model }), ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }) })
  if (created !== undefined) openThread(created.id)
  return created
}

/**
 * Sharing makes a content-free record the engine keeps, but nothing carries it to anyone yet: a
 * share id opens nowhere. Until a transport exists it is offered only in developer mode.
 */
export function shareOffered(developer: boolean): boolean {
  return developer
}

/** Content-free share: a task record and a share bundle with no conversation payload. */
export async function shareThread(threadId: string, mode: "read" | "comment"): Promise<{ readonly shareId: string; readonly digest?: string }> {
  const thread = threadById(threadId)
  if (thread === undefined) throw new HostError("THREAD_NOT_FOUND", "thread no longer exists")
  const task = (await threadRpc(threadId, "task.create", { title: thread.title.slice(0, 256) })) as { taskId?: unknown }
  if (typeof task.taskId !== "string") throw new HostError("CONTROL_INVALID_RESPONSE", "task response was malformed")
  const created = (await threadRpc(threadId, "share.create", {
    taskId: task.taskId,
    mode: mode === "read" ? "read-only-live" : "collaborative",
    payload: { kind: "none", encrypted: false },
  })) as {
    share?: { shareId?: unknown }
    bundle?: { taskDigest?: unknown }
  }
  const shareId = created.share?.shareId
  if (typeof shareId !== "string") throw new HostError("CONTROL_INVALID_RESPONSE", "share response was malformed")
  return { shareId, ...(typeof created.bundle?.taskDigest === "string" ? { digest: created.bundle.taskDigest } : {}) }
}

export const EXTERNAL_LABELS: Record<ExternalSession["source"], string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode", gemini: "Gemini CLI", goose: "Goose", copilot: "Copilot CLI" }

export const EXTERNAL_LIST_LIMIT = 200

/** Where the import dialog looks: the project's own folder, or every folder the tools recorded. */
export type ImportScope = "project" | "all"

/** Sessions from other coding tools recorded for this project's folder, or for any folder. */
export async function listExternal(projectId: string, scope: ImportScope = "project"): Promise<{ readonly sessions: readonly ExternalSession[]; readonly truncated: boolean }> {
  const result = parseOr(ExternalSessionListSchema, await projectRpc(projectId, "session.external.list", { limit: EXTERNAL_LIST_LIMIT, ...(scope === "all" ? { scope: "all" } : {}) }))
  if (result === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "session list was malformed")
  return { sessions: result.sessions, truncated: result.truncated === true }
}

/**
 * The note a newly added project gets when other tools recorded sessions in its folder, such as
 * "Claude Code has 14 sessions here"; none when they recorded nothing. A count from a list the
 * engine cut short is a floor, shown with a plus.
 */
export function importNote(sessions: readonly Pick<ExternalSession, "source">[], truncated: boolean): string | undefined {
  const counts = new Map<ExternalSession["source"], number>()
  for (const session of sessions) counts.set(session.source, (counts.get(session.source) ?? 0) + 1)
  const ranked = [...counts].sort((left, right) => right[1] - left[1])
  const told = ranked.map(([source, count], index) => `${EXTERNAL_LABELS[source]} has ${String(count)}${truncated ? "+" : ""}${index === 0 ? ` session${count === 1 && !truncated ? "" : "s"} here` : ""}`)
  if (told.length === 0) return undefined
  return told.length === 1 ? told[0] : `${told.slice(0, -1).join(", ")}, and ${told[told.length - 1] ?? ""}`
}

/** Once, when a project is added: if another coding tool worked in its folder, says so with a way to bring that in. */
export async function offerImport(projectId: string): Promise<void> {
  const listed = await listExternal(projectId).catch(() => undefined)
  const note = listed === undefined ? undefined : importNote(listed.sessions, listed.truncated)
  if (note === undefined || projectById(projectId) === undefined) return
  toast("info", `${note}.`, { label: "Import…", run: () => set({ dialog: { kind: "import", projectId } }) })
}

/** Whether `folder` is `parent` or inside it. */
export function holds(parent: string, folder: string): boolean {
  return folder === parent || folder.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
}

/** The project whose folder holds `cwd`; the innermost when projects nest. */
export function projectForFolder(cwd: string, projects: readonly Project[] = get().projects): Project | undefined {
  let found: Project | undefined
  for (const project of projects) if (holds(project.path, cwd) && (found === undefined || project.path.length > found.path.length)) found = project
  return found
}

/**
 * A session from a folder that is not a project yet: the person approves that folder, or one
 * that holds it, in the native folder dialog, which makes it a project as any other is; the import
 * then runs there. Cancelling imports nothing, and so does a folder that does not hold the session.
 */
export async function importFromFolder(session: ExternalSession, target: ImportTarget = "runrail"): Promise<ThreadMeta | undefined> {
  const cwd = session.cwd
  if (cwd === undefined || session.missing === true) throw new HostError("IMPORT_FOLDER_MISSING", "the folder this session was recorded in no longer exists")
  const picked = await getHost().workspacePick({ near: cwd })
  if (picked === null) return undefined
  // The host resolves links in both paths, and answers only for a folder that is now approved.
  const recorded = await getHost().workspaceInspect(cwd).catch(() => undefined)
  if (recorded === undefined || !holds(picked.path, recorded.path)) throw new HostError("IMPORT_FOLDER_MISMATCH", `the session was recorded in ${cwd}, which is not inside ${picked.path}`)
  const project = addProject({ id: newId("p"), path: picked.path, name: picked.name, git: picked.git, addedAt: Date.now() })
  void readProjectGit(project.id, 0)
  return importExternal(project.id, session, target)
}

/**
 * Whether the session an idle thread imported gained turns in its tool since. The engine
 * answers with nothing to bring in once the thread has run a turn of its own, or when the session
 * changed before the point it was imported to; either way no offer shows.
 */
export async function checkNewTurns(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  if (thread?.importedFrom === undefined || thread.archived === true) return
  const result = parseOr(ExternalRefreshSchema, await threadRpc(threadId, "session.external.refresh", { dryRun: true }).catch(() => undefined))
  const turns = result === undefined || result.turns === 0 ? undefined : result.turns
  if (runtimeOf(threadId).newTurns !== turns) patchRuntime(threadId, { newTurns: turns })
}

/** Appends what the imported session gained in its tool; only the new turns, once. */
export async function bringInTurns(threadId: string): Promise<void> {
  patchRuntime(threadId, { newTurns: undefined })
  await threadRpc(threadId, "session.external.refresh")
  await reloadHistory(threadId)
}

/** The thread that already continues this external session, if any. */
export function importedThread(session: Pick<ExternalSession, "source" | "id">): ThreadMeta | undefined {
  return get().threads.find((thread) => thread.importedFrom?.source === session.source && thread.importedFrom.id === session.id)
}

/** Where an imported session continues: its own tool resumes a copy of it, or Runrail's loop takes the history as context. */
export type ImportTarget = "tool" | "runrail"

/** Sources whose own tool can continue a copy of the session; the others continue on Runrail. */
export function continuesInTool(source: ExternalSession["source"]): source is "claude-code" | "codex" | "opencode" {
  return source === "claude-code" || source === "codex" || source === "opencode"
}

/** Why a session continues on Runrail even when its own tool is asked for; none when that tool resumes a copy. */
export function toolResumeNote(source: ExternalSession["source"]): string | undefined {
  if (continuesInTool(source)) return undefined
  const label = EXTERNAL_LABELS[source]
  // They load a session only as it is, so continuing there would write Runrail's turns into it.
  if (source === "gemini" || source === "goose" || source === "copilot") return `${label} can continue only the session itself, not a copy, so this one continues on Runrail and the original stays as it was`
  return `${label} sessions continue on Runrail`
}

/**
 * Imports an external session as a new Runrail thread. The thread's own engine copies the
 * conversation into its empty transcript, so it reads as history. On Runrail it becomes model
 * context; in its own tool the thread runs on that tool, which forks the session and continues the
 * fork. Either way the original session file is only read.
 */
export async function importExternal(projectId: string, session: ExternalSession, target: ImportTarget = "runrail"): Promise<ThreadMeta> {
  const project = projectById(projectId)
  if (project === undefined) throw new HostError("PROJECT_NOT_FOUND", "project no longer exists")
  const existing = importedThread(session)
  if (existing !== undefined) {
    openThread(existing.id)
    return existing
  }
  const inTool = target === "tool" && continuesInTool(session.source)
  const thread = createThread({
    projectId,
    // In its own tool: that tool's default model and own sign-in, where the session was recorded.
    // On Runrail: the loop, on the model a new thread would start with.
    ...(inTool ? { backend: session.source } : { backend: "native" as const, ...startingModel(get().prefs) }),
    title: session.title ?? `Imported ${EXTERNAL_LABELS[session.source]} session`,
    importedFrom: { source: session.source, id: session.id },
    select: false,
  })
  try {
    await threadRpc(thread.id, "session.external.import", { source: session.source, id: session.id, ...(inTool ? { continueIn: "tool" } : {}) })
    await reloadHistory(thread.id)
  } catch (error) {
    await deleteThread(thread.id).catch(() => undefined)
    throw toHostError(error)
  }
  openThread(thread.id)
  return thread
}
