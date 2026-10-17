import { getHost, toHostError, type EditorId } from "../host"
import { newId } from "./persist"
import type { ProjectSource } from "./projectForm"
import { readProjectGit } from "./projectGit"
import { offerImport } from "./workflows"
import { activeProject, addProject, get, projectById, set, threadById, toast, useApp, type AppState, type Dialog } from "./store"

/** UI-level actions shared by the sidebar, palette, menus, and empty states. */

/** Every "add a project" entry point opens the Create project dialog; the folder is picked inside it. */
export function pickProject(): Promise<void> {
  openDialog({ kind: "create-project" })
  return Promise.resolve()
}

export function createProject(folder: ProjectSource, name: string, folders: readonly string[] = []): void {
  const id = newId("p")
  const project = addProject({ id, path: folder.path, name, git: folder.git, addedAt: Date.now(), ...(folder.remote === undefined ? (folders.length === 0 ? {} : { folders }) : { remote: folder.remote }) })
  void readProjectGit(project.id, 0)
  closeDialog()
  startNewThread(project.id)
  // A folder that was already a project was offered its sessions when it was added; sessions of
  // other tools on a remote machine are not on this Mac to import.
  if (project.id === id && folder.remote === undefined) void offerImport(project.id)
}

/** Shows the new-thread composer; the thread is created on first send. */
export function startNewThread(projectId?: string): void {
  const id = projectId ?? activeProject()?.id
  set((state) => ({
    ...(state.view.kind === "office" ? { officeDrawer: true } : { view: { kind: "thread" } as const }),
    layout: { ...state.layout, activeThreadId: undefined, ...(id === undefined ? {} : { activeProjectId: id }) },
    focusComposer: state.focusComposer + 1,
  }))
}

/** The directory a thread works in: its worktree when it has one, else the project root. */
export function workspaceOf(threadId: string | undefined): string | undefined {
  const thread = threadById(threadId)
  if (thread === undefined) return undefined
  return thread.worktree?.cwd ?? projectById(thread.projectId)?.path
}

/** The remote machine a workspace is on: a remote project's folder, or a worktree of one. */
export function remoteHostOf(workspace: string): string | undefined {
  const { projects, threads } = get()
  const inside = (root: string): boolean => workspace === root || workspace.startsWith(`${root}/`)
  const project = projects.find((item) => item.remote !== undefined && inside(item.path)) ?? projectById(threads.find((thread) => thread.worktree !== undefined && inside(thread.worktree.cwd))?.projectId)
  return project?.remote?.host
}

/** Opening a file or a folder here needs it on this Mac. */
function refusedRemote(workspace: string): boolean {
  const host = remoteHostOf(workspace)
  if (host === undefined) return false
  toast("info", `That folder is on ${host}. Open it there, or with your editor's SSH remote.`)
  return true
}

export async function openInEditor(workspace: string | undefined, relative?: string, editor?: EditorId): Promise<void> {
  if (workspace === undefined || refusedRemote(workspace)) return
  try {
    await getHost().workspaceOpenIn(workspace, relative, editor ?? editorOf(get().openIn, get().prefs.editor))
  } catch (error) {
    toast("error", `Could not open: ${toHostError(error).message}`)
  }
}

export async function reveal(workspace: string | undefined, relative?: string): Promise<void> {
  if (workspace === undefined || refusedRemote(workspace)) return
  try {
    await getHost().workspaceReveal(workspace, relative)
  } catch (error) {
    toast("error", `Could not reveal: ${toHostError(error).message}`)
  }
}

export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  try {
    await getHost().openUrl(url)
  } catch (error) {
    toast("error", `Could not open link: ${toHostError(error).message}`)
  }
}

export function openDialog(dialog: Dialog): void {
  set({ dialog })
}

export function closeDialog(): void {
  set({ dialog: undefined })
}

export function confirmAction(input: { readonly title: string; readonly body: string; readonly confirm: string; readonly danger?: boolean; readonly onConfirm: () => void }): void {
  set({ dialog: { kind: "confirm", ...input } })
}

/** Opens "Connect a model", or one of its steps; see the `connect` dialog kind. */
/** `tool` opens on adding that coding tool; `models` on choosing the models of that connection. */
export function connectModel(target: { readonly presetId?: string; readonly flow?: string; readonly connectionId?: string; readonly tool?: string; readonly models?: string } = {}): void {
  set({ dialog: { kind: "connect", ...target } })
}

/** Opens the model menu of the composer on screen. */
export function switchModel(): void {
  set((state) => ({ view: { kind: "thread" }, modelMenu: state.modelMenu + 1 }))
}

export function focusComposer(): void {
  set((state) => ({ focusComposer: state.focusComposer + 1 }))
}

export const EDITOR_LABELS: Record<EditorId, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  xcode: "Xcode",
  terminal: "Terminal",
  iterm: "iTerm",
  ghostty: "Ghostty",
  finder: "Finder",
  files: "Files",
  "gnome-terminal": "GNOME Terminal",
  "gnome-console": "Console",
  ptyxis: "Ptyxis",
  konsole: "Konsole",
  "xfce4-terminal": "Xfce Terminal",
  kitty: "kitty",
  wezterm: "WezTerm",
  alacritty: "Alacritty",
  idea: "IntelliJ IDEA",
  pycharm: "PyCharm",
  webstorm: "WebStorm",
  goland: "GoLand",
  clion: "CLion",
  rustrover: "RustRover",
  phpstorm: "PhpStorm",
  rider: "Rider",
  rubymine: "RubyMine",
}

/** The "Open in" choices the host reported, or macOS's fixed list until it answers. */
export const MAC_EDITORS: readonly EditorId[] = ["vscode", "cursor", "zed", "xcode", "finder", "terminal", "iterm", "ghostty"]

/** A chosen editor this computer lacks (VS Code by default) gives way to the first one it has. */
function editorOf(openIn: AppState["openIn"], chosen: EditorId): EditorId {
  const list = openIn ?? MAC_EDITORS
  return list.includes(chosen) ? chosen : (list[0] ?? chosen)
}

export function useEditors(): { readonly list: readonly EditorId[]; readonly editor: EditorId } {
  const openIn = useApp((state) => state.openIn)
  const chosen = useApp((state) => state.prefs.editor)
  return { list: openIn ?? MAC_EDITORS, editor: editorOf(openIn, chosen) }
}

export function editorsNow(): { readonly list: readonly EditorId[]; readonly editor: EditorId } {
  const { openIn, prefs } = get()
  return { list: openIn ?? MAC_EDITORS, editor: editorOf(openIn, prefs.editor) }
}
