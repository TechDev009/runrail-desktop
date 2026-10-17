import type { MouseEvent } from "react"
import type { EditorId } from "../host/types"
import { openContextMenu, type ContextItem } from "../lib/contextMenu"
import { EDITOR_LABELS, editorsNow, openInEditor, remoteHostOf, reveal } from "./actions"
import { insideWorkspace, previewWorkspaceFile } from "./filePreview"
import { words } from "./platformWords"

/** "Open in" choices that take a folder, not a file: terminals and file managers. */
const FOLDER_APPS: ReadonlySet<EditorId> = new Set(["finder", "files", "terminal", "iterm", "ghostty", "gnome-terminal", "gnome-console", "ptyxis", "konsole", "xfce4-terminal", "kitty", "wezterm", "alacritty"])

export interface FileAt {
  readonly threadId?: string
  readonly line?: number
  readonly folder?: string
}

/**
 * A file link's right-click menu: Runrail's Files pane, the editors this computer has (the chosen
 * one first), the file manager, and the path, whichever place a click goes to.
 */
export function fileMenuItems(workspace: string, path: string, at: FileAt = {}, more: { readonly directory?: boolean; readonly extra?: readonly ContextItem[] } = {}): ContextItem[] {
  const inside = insideWorkspace(workspace, path)
  if (inside === undefined || inside.length === 0) return []
  const absolute = `${workspace.replace(/\/+$/, "")}/${inside}`
  const local = remoteHostOf(workspace) === undefined
  const { list, editor } = editorsNow()
  const editors = [editor, ...list.filter((id) => id !== editor)].filter((id) => !FOLDER_APPS.has(id))
  const copy = (text: string) => () => void navigator.clipboard.writeText(text).catch(() => undefined)
  return [
    ...(more.directory === true ? [] : [{ id: "open", label: "Open in Runrail", onSelect: () => previewWorkspaceFile(workspace, inside, at) }]),
    ...(more.extra ?? []),
    ...(local
      ? [
          ...(more.directory === true && (more.extra ?? []).length === 0 ? [] : [{ separator: true as const, id: "sep-apps" }]),
          ...editors.map((id) => ({ id: `open-in-${id}`, label: `Open in ${EDITOR_LABELS[id]}`, onSelect: () => void openInEditor(workspace, inside, id) })),
          { id: "reveal", label: words().reveal, onSelect: () => void reveal(workspace, inside) },
        ]
      : []),
    { separator: true, id: "sep-copy" },
    { id: "copy-path", label: "Copy path", onSelect: copy(absolute) },
    { id: "copy-relative", label: "Copy relative path", onSelect: copy(inside) },
  ]
}

export function openFileMenu(event: MouseEvent, workspace: string, path: string, at: FileAt = {}): void {
  openContextMenu(event, fileMenuItems(workspace, path, at))
}
