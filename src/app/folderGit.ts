import { create } from "zustand"
import { HostError, toHostError } from "../host"
import { GitStatusSchema, hasCapability, parseOr, type GitStatus } from "../protocol/schemas"
import { takesBrowser } from "./browserAgent"
import { onTurnEnded, threadRpc } from "./engines"
import { get, useApp } from "./store"

/**
 * A project's related folders in a thread's Files and Review panes. The thread
 * runs in its own checkout; its engine also takes the project's related folders, and a
 * `workspace.*` or `git.*` call naming one acts there, with paths relative to it. Which folder each
 * thread's panes show, and each folder's git status, live in memory only.
 */

export const NOT_A_REPOSITORY = "NOT_A_REPOSITORY"
/** What the engine says when git is asked about a folder that is not in a work tree. */
const OUTSIDE_WORK_TREE = "workspace is not a git work tree"

export interface FolderGitView {
  readonly status?: GitStatus
  readonly loading: boolean
  readonly error?: string
  readonly updatedAt?: number
}

interface FolderState {
  /** The related folder each thread's panes show; absent for the thread's own checkout. */
  readonly shown: Readonly<Record<string, string>>
  readonly git: Readonly<Record<string, FolderGitView>>
}

export const useFolders = create<FolderState>()(() => ({ shown: {}, git: {} }))

const NO_FOLDERS: readonly string[] = []
const IDLE: FolderGitView = { loading: false }

/** One key per thread and folder, for git status and review comments. */
export function folderKey(threadId: string, folder: string): string {
  return `${threadId}\n${folder}`
}

/** The related folders a thread's engine takes: none for a tool that cannot, or an engine that does not know them. */
export function useThreadFolders(threadId: string): readonly string[] {
  return useApp((state) => {
    const thread = state.threads.find((item) => item.id === threadId)
    if (thread === undefined || !takesBrowser(thread.backend)) return NO_FOLDERS
    const contract = state.runtime[threadId]?.contract
    if (contract !== undefined && !hasCapability(contract, "workspace.folders")) return NO_FOLDERS
    return state.projects.find((project) => project.id === thread.projectId)?.folders ?? NO_FOLDERS
  })
}

/** The folder a thread's panes show, while it is still one of the project's. */
export function useShownFolder(threadId: string): string | undefined {
  const folders = useThreadFolders(threadId)
  const shown = useFolders((state) => state.shown[threadId])
  return shown !== undefined && folders.includes(shown) ? shown : undefined
}

export function showFolder(threadId: string, folder: string | undefined): void {
  useFolders.setState((state) => {
    const shown = { ...state.shown }
    if (folder === undefined) delete shown[threadId]
    else shown[threadId] = folder
    return { shown }
  })
}

export function useFolderGit(threadId: string, folder: string | undefined): FolderGitView {
  return useFolders((state) => (folder === undefined ? IDLE : (state.git[folderKey(threadId, folder)] ?? IDLE)))
}

export function patchFolderGit(threadId: string, folder: string, patch: Partial<FolderGitView>): void {
  const key = folderKey(threadId, folder)
  useFolders.setState((state) => ({ git: { ...state.git, [key]: { ...(state.git[key] ?? IDLE), ...patch } } }))
}

/** A call on the thread's engine, in a related folder when one is named. */
export function folderRpc(threadId: string, folder: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return threadRpc(threadId, method, folder === undefined ? params : { ...params, folder })
}

export async function refreshFolderGit(threadId: string, folder: string): Promise<void> {
  patchFolderGit(threadId, folder, { loading: true })
  try {
    const status = parseOr(GitStatusSchema, await folderRpc(threadId, folder, "git.status", { maxEntries: 2_000 }))
    if (status === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "git status was malformed")
    patchFolderGit(threadId, folder, { status, loading: false, error: undefined, updatedAt: Date.now() })
  } catch (error) {
    const failure = toHostError(error)
    patchFolderGit(threadId, folder, { loading: false, error: failure.code === "CONTROL_GIT_UNAVAILABLE" && failure.message === OUTSIDE_WORK_TREE ? NOT_A_REPOSITORY : failure.code })
  }
}

/** A turn may have edited the folder a thread's pane shows; its status is read again when the turn ends. */
export function initFolderGit(): () => void {
  return onTurnEnded((threadId) => {
    const folder = useFolders.getState().shown[threadId]
    const thread = get().threads.find((item) => item.id === threadId)
    const project = get().projects.find((item) => item.id === thread?.projectId)
    if (folder !== undefined && project?.folders?.includes(folder) === true) void refreshFolderGit(threadId, folder)
  })
}
