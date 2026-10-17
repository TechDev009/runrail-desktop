import type { PastedBlock } from "./paste"
import { create } from "zustand"
import type { Contract, GitRemote, GitStatus } from "../protocol/schemas"
import type { ConnectedTo } from "./gitHosts"
import type { PrView } from "./prStatus"
import type { ChangeStats } from "./threadBar"
import type { RewindPlan } from "./rewind"
import { emptyTimeline, type Timeline } from "../thread/reducer"
import {
  defaultState,
  MAX_DISABLED_SKILLS,
  MAX_PROJECT_FOLDERS,
  MAX_THREAD_RUNS,
  newId,
  type DesktopState,
  type Layout,
  type PermissionPreset,
  type Prefs,
  type Project,
  type RecentModel,
  type ThreadMeta,
  type ThreadRun,
  type ThreadMode,
} from "./persist"
import type { BackendId, EditorId, Thinking } from "../host/types"
import { markThreadRead } from "./inbox"
import { noteThreadChosen } from "./diagnostics"
import { cleanProjectName } from "./projectForm"
import type { NifraUse } from "./nifra"
import { closePane, openBeside, showInPane } from "./split"
import { takesModel, type Selection } from "./picker"

export interface Attachment {
  readonly id: string
  readonly path: string
  readonly kind: "file" | "image"
  readonly name: string
  readonly mediaType?: string
  /** Object URL for image thumbnails; lives only in memory. */
  readonly previewUrl?: string
}

export interface QueuedPrompt {
  readonly id: string
  readonly text: string
  readonly attachments: readonly Attachment[]
  readonly skills?: readonly string[]
  /** Goes even when the plan reads as used up: the person sent it again after it was held. */
  readonly anyway?: true
}

export interface TurnChanges {
  readonly files: number
  readonly additions: number
  readonly deletions: number
}

export interface GoalState {
  readonly objective: string
  readonly iteration: number
  readonly max: number
  readonly status: "running" | "passed" | "exhausted" | "stopped"
}

export interface ThreadRuntime {
  readonly engine: "stopped" | "starting" | "ready" | "failed"
  readonly engineId?: string
  readonly engineError?: string
  readonly instance?: number
  readonly contract?: Contract
  readonly stream: "idle" | "connected" | "reconnecting"
  readonly timeline: Timeline
  readonly historyLoaded: boolean
  readonly queue: readonly QueuedPrompt[]
  readonly queuePaused: boolean
  readonly goal?: GoalState
  readonly changes: Readonly<Record<string, TurnChanges>>
  readonly restartPending: boolean
  readonly lastError?: string
  /** The coding tool is compacting the conversation; new messages wait for it. */
  readonly compacting?: boolean
  /** Turns the imported session gained in its tool, ready to bring in. */
  readonly newTurns?: number
  /** What Nifra adds to this thread's engine, shown in the thread header. */
  readonly nifra?: NifraUse
}

export interface GitView {
  readonly status?: GitStatus
  readonly loading: boolean
  readonly error?: string
  readonly updatedAt?: number
  /** Changed lines and files against HEAD, counted without patches. */
  readonly stats?: ChangeStats
  readonly remotes?: readonly GitRemote[]
  /** When this checkout last fetched its upstream. */
  readonly fetchedAt?: number
  /** A fetch, pull, or push started from the thread bar is running. */
  readonly busy?: "fetch" | "pull" | "push"
  /** Pull requests for the checked-out branch, as last read. */
  readonly pr?: PrView
}

export type View =
  | { readonly kind: "thread" }
  | { readonly kind: "reviews" }
  /** Setups and their runs; `runId` opens one run. */
  | { readonly kind: "agents"; readonly runId?: string }
  | { readonly kind: "evals"; readonly runId?: string }
  | { readonly kind: "memory" }
  /** Workflows: a project's, one workflow, one of its runs. */
  | { readonly kind: "workflows"; readonly projectId?: string; readonly workflowId?: string; readonly runId?: string }
  /** Integrations: connectors, MCP servers, who may use what, plugins and skills. */
  | { readonly kind: "integrations"; readonly section?: "connectors" | "mcp" | "grants" | "extensions" }
  | { readonly kind: "compare"; readonly groupId: string }
  | { readonly kind: "office" }
  /** Archived threads by project. */
  | { readonly kind: "archived" }

/** Where a new project comes from: a folder here, one on a remote machine, or a new app. */
export type ProjectWhere = "local" | "remote" | "new"

export type Dialog =
  | { readonly kind: "create-project"; readonly where?: ProjectWhere }
  | { readonly kind: "best-of-n"; readonly projectId: string }
  | { readonly kind: "import"; readonly projectId: string }
  | { readonly kind: "other-tools"; readonly section: "skills" | "servers" | "agents"; readonly projectId: string }
  | { readonly kind: "share"; readonly threadId: string }
  /** Continue a thread on another machine with the same repository. */
  | { readonly kind: "continue-on"; readonly threadId: string }
  /**
   * Connect a model. With nothing set it opens on the list of providers; `presetId` opens that
   * provider's key form, `flow` that sign-in, and `connectionId` repairs an existing connection
   * (a new key, or signing in again when `flow` is set too).
   */
  | { readonly kind: "connect"; readonly presetId?: string; readonly flow?: string; readonly connectionId?: string; readonly custom?: { readonly label: string; readonly address: string }; readonly tool?: string; readonly models?: string }
  | { readonly kind: "confirm"; readonly title: string; readonly body: string; readonly confirm: string; readonly danger?: boolean; readonly onConfirm: () => void }
  | { readonly kind: "shift-report" }
  | { readonly kind: "quests"; readonly projectId: string }
  /** Going back to before a message, its files ticked. */
  | { readonly kind: "rewind"; readonly plan: RewindPlan }

export interface Toast {
  readonly id: string
  readonly level: "info" | "success" | "error"
  readonly text: string
  readonly action?: { readonly label: string; readonly run: () => void }
}

/** Settings sections; "connections" opens the Models section at its connections. */
export type SettingsSection = "general" | "ai" | "voice" | "instructions" | "models" | "connections" | "permissions" | "skills" | "mcp" | "agents" | "projects" | "import" | "shortcuts" | "developer"

export interface AppState extends DesktopState {
  readonly loaded: boolean
  readonly runtime: Readonly<Record<string, ThreadRuntime>>
  readonly git: Readonly<Record<string, GitView>>
  readonly drafts: Readonly<Record<string, string>>
  /** Attachments an Edit put back, by draft key, for that draft's composer to take. In memory only. */
  readonly editAttachments: Readonly<Record<string, readonly Attachment[]>>
  /** Long pastes folded out of each draft, by draft key. In memory only, like the drafts. */
  readonly pastes: Readonly<Record<string, readonly PastedBlock[]>>
  readonly view: View
  /** In the office view, the open thread shows in a drawer beside the floor. */
  readonly officeDrawer: boolean
  readonly palette: boolean
  readonly settings: false | SettingsSection
  readonly dialog?: Dialog
  readonly toasts: readonly Toast[]
  readonly focusComposer: number
  /** Bumped by the dictation shortcut; the composer on screen starts or stops listening. */
  readonly dictateSignal: number
  /** Bumped by the find shortcut; the thread on screen opens its find bar. */
  readonly findSignal: number
  /** Bumped to open the composer's model menu from outside it. */
  readonly modelMenu: number
  readonly platform: string
  readonly hostVersion: string
  /** Where the engine keeps keys and sign-ins; unknown until the host answers. */
  readonly credentialStore?: "keychain" | "file"
  /** True when the host can read a key from the clipboard itself, so it never enters the window. */
  readonly clipboardSecrets: boolean
  /** The "Open in" choices this computer has, once the host has answered. */
  readonly openIn?: readonly EditorId[]
  /** Process start to ready for this launch, once the host has answered. */
  readonly startupMs?: number
}

export function emptyRuntime(): ThreadRuntime {
  return { engine: "stopped", stream: "idle", timeline: emptyTimeline(), historyLoaded: false, queue: [], queuePaused: false, changes: {}, restartPending: false }
}

export const useApp = create<AppState>()(() => ({
  ...defaultState(),
  loaded: false,
  runtime: {},
  git: {},
  drafts: {},
  editAttachments: {},
  pastes: {},
  view: { kind: "thread" },
  officeDrawer: false,
  palette: false,
  settings: false,
  toasts: [],
  focusComposer: 0,
  dictateSignal: 0,
  findSignal: 0,
  modelMenu: 0,
  platform: "unknown",
  hostVersion: "",
  clipboardSecrets: false,
}))

export const get = useApp.getState
export const set = useApp.setState

export function runtimeOf(threadId: string | undefined): ThreadRuntime {
  if (threadId === undefined) return emptyRuntime()
  return get().runtime[threadId] ?? emptyRuntime()
}

export function patchRuntime(threadId: string, patch: Partial<ThreadRuntime> | ((current: ThreadRuntime) => Partial<ThreadRuntime>)): void {
  set((state) => {
    const current = state.runtime[threadId] ?? emptyRuntime()
    const next = typeof patch === "function" ? patch(current) : patch
    return { runtime: { ...state.runtime, [threadId]: { ...current, ...next } } }
  })
}

export function patchGit(threadId: string, patch: Partial<GitView>): void {
  set((state) => ({ git: { ...state.git, [threadId]: { ...(state.git[threadId] ?? { loading: false }), ...patch } } }))
}

export function threadById(id: string | undefined): ThreadMeta | undefined {
  return id === undefined ? undefined : get().threads.find((thread) => thread.id === id)
}

export function projectById(id: string | undefined): Project | undefined {
  return id === undefined ? undefined : get().projects.find((project) => project.id === id)
}

export function activeThread(): ThreadMeta | undefined {
  return threadById(get().layout.activeThreadId)
}

export function activeProject(): Project | undefined {
  const state = get()
  const thread = activeThread()
  return projectById(thread?.projectId ?? state.layout.activeProjectId) ?? state.projects[0]
}

export function patchThread(id: string, patch: Partial<ThreadMeta>): void {
  set((state) => ({ threads: state.threads.map((thread) => (thread.id === id ? { ...thread, ...patch } : thread)) }))
}

export function setLayout(patch: Partial<Layout>): void {
  set((state) => ({ layout: { ...state.layout, ...patch } }))
}

export function setPrefs(patch: Partial<Prefs>): void {
  set((state) => ({ prefs: { ...state.prefs, ...patch } }))
}

export function toast(level: Toast["level"], text: string, action?: Toast["action"]): void {
  const id = newId("toast")
  set((state) => ({ toasts: [...state.toasts.slice(-3), { id, level, text, ...(action === undefined ? {} : { action }) }] }))
  setTimeout(() => dismissToast(id), level === "error" ? 7_000 : 4_000)
}

export function dismissToast(id: string): void {
  set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
}

/** The thread in view: the office floor with its drawer closed shows people, not the last thread opened. */
export function threadOnScreen(state: AppState = get()): string | undefined {
  return state.view.kind === "office" && !state.officeDrawer ? undefined : state.layout.activeThreadId
}

/**
 * Shows a thread on its own, leaving the office floor. `onFloor` is for the floor's own clicks:
 * the floor stays and the thread opens in its drawer.
 */
export function selectThread(id: string | undefined, onFloor = false): void {
  const thread = threadById(id)
  if (id !== undefined) noteThreadChosen(id)
  markThreadRead(id)
  set((state) => ({
    ...(onFloor && state.view.kind === "office" ? { officeDrawer: id !== undefined } : { view: { kind: "thread" } as const, officeDrawer: false }),
    layout: { ...state.layout, activeThreadId: id, ...(thread === undefined ? {} : { activeProjectId: thread.projectId }), ...(id === undefined ? {} : { panes: showInPane(state.layout.panes, state.layout.activeThreadId, id) }) },
    threads: thread?.unread === true ? state.threads.map((item) => (item.id === id ? { ...item, unread: false } : item)) : state.threads,
    focusComposer: state.focusComposer + 1,
  }))
}

/** Opens a thread in a pane of its own beside the focused one, and focuses it. */
export function openToSide(id: string): void {
  const thread = threadById(id)
  if (thread === undefined) return
  markThreadRead(id)
  set((state) => ({
    view: { kind: "thread" },
    officeDrawer: false,
    layout: { ...state.layout, panes: openBeside(state.layout.panes, state.layout.activeThreadId, id), activeThreadId: id, activeProjectId: thread.projectId },
    threads: thread.unread === true ? state.threads.map((item) => (item.id === id ? { ...item, unread: false } : item)) : state.threads,
    focusComposer: state.focusComposer + 1,
  }))
}

/** Focuses the pane of `id`, as clicking into it does; the side panel and the title follow it. */
export function focusPane(id: string): void {
  const state = get()
  if (state.layout.activeThreadId === id) return
  const thread = threadById(id)
  markThreadRead(id)
  set({ layout: { ...state.layout, activeThreadId: id, ...(thread === undefined ? {} : { activeProjectId: thread.projectId }) } })
}

/** Closes the pane of `id`; the thread itself stays in the list. */
export function closeThreadPane(id: string): void {
  set((state) => {
    const next = closePane(state.layout.panes, state.layout.activeThreadId, id)
    const thread = threadById(next.active)
    return { layout: { ...state.layout, panes: next.panes, activeThreadId: next.active, ...(thread === undefined ? {} : { activeProjectId: thread.projectId }) } }
  })
}

/** Whether the composer, find bar or microphone of `threadId` is the one a shortcut means. */
export function paneFocused(threadId: string | undefined): boolean {
  return threadId === undefined || get().layout.activeThreadId === threadId
}

/**
 * Opens a thread from anywhere but the thread list: on the office floor it opens there,
 * in the drawer, and the floor stays; anywhere else it opens in the thread view.
 */
export function openThread(id: string): void {
  selectThread(id, true)
}

export function addProject(project: Project): Project {
  const existing = get().projects.find((item) => item.path === project.path && item.remote?.id === project.remote?.id)
  if (existing !== undefined) {
    setLayout({ activeProjectId: existing.id })
    return existing
  }
  set((state) => ({ projects: [...state.projects, project], layout: { ...state.layout, activeProjectId: project.id } }))
  return project
}

/** Records a skill turned on or off for a project. */
export function setProjectSkill(projectId: string, skillId: string, enabled: boolean): void {
  set((state) => ({
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project
      const others = (project.disabledSkills ?? []).filter((id) => id !== skillId)
      const next = enabled ? others : [...others, skillId].slice(-MAX_DISABLED_SKILLS)
      const { disabledSkills: _previous, ...rest } = project
      return next.length === 0 ? rest : { ...rest, disabledSkills: next }
    }),
  }))
}

/** Records what a project's folder is, as git and its remote say; only a change is written. */
export function noteProjectGit(projectId: string, patch: { readonly git?: boolean; readonly connectedTo?: ConnectedTo }): void {
  const project = projectById(projectId)
  if (project === undefined) return
  const gitChanged = patch.git !== undefined && patch.git !== project.git
  const remoteChanged = patch.connectedTo !== undefined && JSON.stringify(patch.connectedTo) !== JSON.stringify(project.connectedTo)
  // A folder that is no longer a repository is connected to nothing.
  const remoteGone = patch.git === false && project.connectedTo !== undefined
  if (!gitChanged && !remoteChanged && !remoteGone) return
  set((state) => ({
    projects: state.projects.map((item) => {
      if (item.id !== projectId) return item
      const { connectedTo: _previous, ...kept } = item
      return { ...(remoteGone ? kept : item), ...(gitChanged && patch.git !== undefined ? { git: patch.git } : {}), ...(remoteChanged && patch.connectedTo !== undefined ? { connectedTo: patch.connectedTo } : {}) }
    }),
  }))
}

/** The project's related folders; its engines start again to take them. */
export function setProjectFolders(projectId: string, folders: readonly string[]): void {
  set((state) => ({
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project
      const { folders: _previous, ...rest } = project
      const next = [...new Set(folders)].slice(0, MAX_PROJECT_FOLDERS)
      return next.length === 0 ? rest : { ...rest, folders: next }
    }),
  }))
}

export function renameProject(projectId: string, name: string): void {
  const clean = cleanProjectName(name)
  if (clean === undefined) return
  set((state) => ({ projects: state.projects.map((project) => (project.id === projectId ? { ...project, name: clean } : project)) }))
}

export function removeProject(id: string): void {
  set((state) => ({
    projects: state.projects.filter((project) => project.id !== id),
    threads: state.threads.filter((thread) => thread.projectId !== id),
    layout: {
      ...state.layout,
      ...(state.layout.activeProjectId === id ? { activeProjectId: undefined } : {}),
      ...(threadById(state.layout.activeThreadId)?.projectId === id ? { activeThreadId: undefined } : {}),
    },
  }))
}

export interface NewThreadInput {
  readonly projectId: string
  readonly backend?: BackendId
  readonly model?: string
  /** Connection `model` is reached through. */
  readonly connectionId?: string
  readonly thinking?: Thinking
  readonly mode?: ThreadMode
  readonly permission?: PermissionPreset
  readonly title?: string
  readonly worktree?: ThreadMeta["worktree"]
  readonly group?: ThreadMeta["group"]
  readonly parentThreadId?: string
  readonly review?: ThreadMeta["review"]
  readonly reviewOf?: string
  readonly setup?: ThreadMeta["setup"]
  readonly importedFrom?: ThreadMeta["importedFrom"]
  readonly runHistory?: ThreadMeta["runHistory"]
  readonly select?: boolean
}

/** The model a new thread starts on before the list of connections is known: the default, else the last one used. */
export function startingModel(prefs: Prefs): RecentModel | undefined {
  return prefs.defaultModel !== undefined && prefs.defaultConnectionId !== undefined ? { model: prefs.defaultModel, connectionId: prefs.defaultConnectionId } : prefs.recentModels[0]
}

/** What a new thread or run starts on before anything is picked. A recorded session is never a start. */
export function startSelection(prefs: Prefs): Selection {
  if (prefs.defaultBackend !== "native" && prefs.defaultBackend !== "replay") return { backend: prefs.defaultBackend, ...startingToolModel(prefs) }
  return { backend: "native", ...startingModel(prefs) }
}

/** The model and tool connection a coding tool starts a new thread with, when the default is such a tool. */
function startingToolModel(prefs: Prefs): { readonly model?: string; readonly connectionId?: string } {
  if (!takesModel(prefs.defaultBackend)) return {}
  return { ...(prefs.defaultToolModel === undefined ? {} : { model: prefs.defaultToolModel }), ...(prefs.defaultToolConnectionId === undefined ? {} : { connectionId: prefs.defaultToolConnectionId }) }
}

/** What the new-thread composer opens on. Developer mode's backend row is taken at its word, a recorded session included. */
export function draftSelection(prefs: Prefs): Selection {
  return prefs.defaultBackend === "native" ? { backend: "native", ...startingModel(prefs) } : { backend: prefs.defaultBackend, ...startingToolModel(prefs) }
}

/** Whether a new-thread draft already sits on exactly what the preferences name, so a change to them is its own doing. */
export function sitsOnDefault(value: Selection, prefs: Prefs): boolean {
  if (value.backend !== prefs.defaultBackend) return false
  if (value.backend !== "native") return !takesModel(value.backend) || (value.model === prefs.defaultToolModel && value.connectionId === prefs.defaultToolConnectionId)
  return value.model === prefs.defaultModel && value.connectionId === prefs.defaultConnectionId
}

export function createThread(input: NewThreadInput): ThreadMeta {
  const prefs = get().prefs
  const now = Date.now()
  const backend = input.backend ?? prefs.defaultBackend
  // A caller that says what the thread runs on is taken at its word. One that says nothing gets the default model, else the last one used.
  const fallback = input.backend === undefined ? startingModel(prefs) : undefined
  const model = backend === "native" ? (input.model ?? fallback?.model) : !takesModel(backend) ? undefined : input.backend === undefined ? prefs.defaultToolModel : input.model
  // A coding tool keeps the tool connection it was given, or the default's when it was given none.
  const toolConnectionId = !takesModel(backend) ? undefined : input.backend === undefined ? prefs.defaultToolConnectionId : input.connectionId
  const connectionId = backend !== "native" ? toolConnectionId : input.model === undefined ? fallback?.connectionId : input.connectionId
  const thread: ThreadMeta = {
    id: newId("th"),
    projectId: input.projectId,
    title: input.title ?? "New thread",
    titled: input.title !== undefined,
    createdAt: now,
    updatedAt: now,
    backend,
    ...(model === undefined ? {} : { model }),
    ...(connectionId === undefined || (backend === "native" && model === undefined) ? {} : { connectionId }),
    thinking: input.thinking ?? prefs.defaultThinking,
    mode: input.mode ?? "agent",
    permission: input.permission ?? prefs.defaultPermission,
    ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    ...(input.group === undefined ? {} : { group: input.group }),
    ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
    ...(input.review === undefined ? {} : { review: input.review }),
    ...(input.reviewOf === undefined ? {} : { reviewOf: input.reviewOf }),
    ...(input.setup === undefined ? {} : { setup: input.setup }),
    ...(input.importedFrom === undefined ? {} : { importedFrom: input.importedFrom }),
    ...(input.runHistory === undefined ? {} : { runHistory: input.runHistory }),
  }
  set((state) => ({ threads: [thread, ...state.threads] }))
  if (input.select !== false) openThread(thread.id)
  return thread
}

/** Remember only bounded route metadata; prompts and tool payloads stay in the engine transcript. */
export function rememberThreadRun(threadId: string, run: ThreadRun): void {
  set((state) => ({
    threads: state.threads.map((thread) => {
      if (thread.id !== threadId) return thread
      const previous = thread.runHistory ?? []
      const next = [...previous.filter((entry) => entry.turnId !== run.turnId), run].slice(-MAX_THREAD_RUNS)
      return { ...thread, runHistory: next }
    }),
  }))
}

export function persistedSlice(state: AppState): DesktopState {
  return { version: 1, projects: state.projects, threads: state.threads, prefs: state.prefs, layout: state.layout, learning: state.learning, game: state.game }
}
