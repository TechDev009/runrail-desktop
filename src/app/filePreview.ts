import { create } from "zustand"
import { openInEditor } from "./actions"
import { openPanel } from "./panels"
import { get, toast } from "./store"
import type { DiffLine } from "../lib/diff"

export type FileChange = { readonly lines: readonly DiffLine[] } | { readonly patch: string }
export interface PreviewRequest {
  readonly threadId: string
  readonly path: string
  readonly nonce: number
  readonly view?: "changes"
  readonly change?: FileChange
  /** The line to bring into view, from a link such as `src/a.ts:42`. */
  readonly line?: number
  /** A related folder the path is in; the thread's own checkout when unset. */
  readonly folder?: string
}

/** A file another part of the window asked the Files pane to show. */
export const usePreviewRequest = create<{ readonly request?: PreviewRequest }>(() => ({}))
let previewNonce = 0

export function previewFile(threadId: string, path: string, at: { readonly line?: number; readonly folder?: string } = {}): void {
  usePreviewRequest.setState({ request: { threadId, path, nonce: ++previewNonce, ...at } })
  openPanel(threadId, "files")
}

/** A file opens in the thread's Files pane; editors and Finder are on its right-click menu (src/app/fileMenu.ts). */
export function previewWorkspaceFile(workspace: string, path: string, at: { readonly threadId?: string; readonly line?: number; readonly folder?: string } = {}): void {
  const inside = insideWorkspace(workspace, path)
  if (inside === undefined) {
    toast("error", `${path} is outside this project, so Runrail does not open it.`)
    return
  }
  const threadId = at.threadId ?? get().layout.activeThreadId
  if (threadId !== undefined) previewFile(threadId, inside, { ...(at.line === undefined ? {} : { line: at.line }), ...(at.folder === undefined ? {} : { folder: at.folder }) })
}

/** A file named in an answer opens where Settings says: the Files pane (the default) or the editor. */
export function openFileLink(workspace: string, path: string, at: { readonly threadId?: string; readonly line?: number } = {}): void {
  if (get().prefs.fileLinks !== "editor") return previewWorkspaceFile(workspace, path, at)
  const inside = insideWorkspace(workspace, path)
  if (inside === undefined) toast("error", `${path} is outside this project, so Runrail does not open it.`)
  else void openInEditor(workspace, inside)
}

export function previewWorkspaceChanges(workspace: string, path: string, change?: FileChange, threadId = get().layout.activeThreadId): void {
  const inside = insideWorkspace(workspace, path)
  if (inside === undefined) {
    toast("error", `${path} is outside this project, so Runrail does not open it.`)
    return
  }
  if (threadId === undefined) return
  usePreviewRequest.setState({ request: { threadId, path: inside, nonce: ++previewNonce, view: "changes", ...(change === undefined ? {} : { change }) } })
  openPanel(threadId, "files")
}

/**
 * A path a model named, as one relative to the workspace; none when it leads outside. The model
 * writes these, so they are checked here as well as by the host.
 */
export function insideWorkspace(workspace: string, path: string): string | undefined {
  const root = workspace.replace(/\/+$/, "")
  if (path.length === 0 || path.length > 4_096 || path.includes("\0") || path.startsWith("~")) return undefined
  let relative = path
  if (path.startsWith("/")) {
    if (path !== root && !path.startsWith(`${root}/`)) return undefined
    relative = path.slice(root.length)
  }
  const parts: string[] = []
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }
  return parts.join("/")
}
