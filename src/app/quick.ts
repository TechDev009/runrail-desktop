import { create } from "zustand"
import { getHost, toHostError, type QuickMessage, type QuickStatus, type Unsubscribe } from "../host"
import { send } from "./engines"
import { newId } from "./persist"
import { selectionProblem } from "./picker"
import { activeProject, createThread, get, set, startSelection, toast, type Attachment } from "./store"

/**
 * Quick chat: a message typed in the small window the global shortcut opens
 * starts a new thread here, in the project in front, with the picture of the window that was in
 * front when the person asked for one.
 */

export const DEFAULT_SHORTCUT = "Alt+Space"

export const useQuick = create<{ readonly status?: QuickStatus; readonly error?: string }>()(() => ({}))

function track(next: Promise<QuickStatus>): Promise<void> {
  return next.then(
    (status) => useQuick.setState({ status, error: undefined }),
    (error: unknown) => useQuick.setState({ error: toHostError(error).message }),
  )
}

export function loadQuick(): Promise<void> {
  return track(getHost().quickStatus())
}

export function setQuick(enabled: boolean, shortcut: string): Promise<void> {
  return track(getHost().quickSet(enabled, shortcut))
}

function bytesOf(base64: string): Uint8Array {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}

/** Starts a thread from one quick chat message; without a model to send on, it waits as a draft. */
export async function startQuick(message: QuickMessage): Promise<void> {
  const project = activeProject()
  if (project === undefined) {
    toast("info", "Add a project, then quick chat can start threads in it.")
    return
  }
  const thread = createThread({ projectId: project.id })
  const prefs = get().prefs
  if (selectionProblem(startSelection(prefs), undefined, prefs.developer) !== undefined) {
    if (message.text.length > 0) set((state) => ({ drafts: { ...state.drafts, [thread.id]: message.text } }))
    toast("info", message.image === undefined ? "Pick a model for this thread, then send." : "Pick a model for this thread, then send. The window's picture was not kept.")
    return
  }
  const attachments: Attachment[] = []
  if (message.image !== undefined) {
    try {
      const path = await getHost().attachmentSave(project.path, message.image.mediaType, bytesOf(message.image.dataBase64))
      attachments.push({ id: newId("a"), path, kind: "image", name: message.image.name, mediaType: message.image.mediaType })
    } catch (error) {
      toast("error", `The window's picture could not be attached: ${toHostError(error).message}`)
    }
  }
  send(thread.id, { text: message.text, attachments })
}

/** Takes quick chat's messages while the app runs. */
export function initQuick(): Unsubscribe {
  void loadQuick()
  return getHost().onQuickSubmit((message) => void startQuick(message))
}

const KEY_NAMES: Readonly<Record<string, string>> = { Alt: "Option", Shift: "Shift", Control: "Control", Ctrl: "Control", Super: "Command", Command: "Command", Cmd: "Command", CmdOrCtrl: "Command", CommandOrControl: "Command", Space: "Space" }
const LINUX_KEY_NAMES: Readonly<Record<string, string>> = { Alt: "Alt", Shift: "Shift", Control: "Ctrl", Ctrl: "Ctrl", Super: "Super", Command: "Super", Cmd: "Super", Meta: "Super", CmdOrCtrl: "Ctrl", CommandOrControl: "Ctrl", Space: "Space" }

/** A shortcut as the platform writes it: `Alt+Space` is "Option Space" on macOS, `Control+Alt+Space` "Ctrl+Alt+Space" on Linux. */
export function describeShortcut(shortcut: string, platform: string | undefined = get().platform): string {
  const linux = platform === "linux"
  return shortcut
    .split("+")
    .map((part) => (linux ? LINUX_KEY_NAMES : KEY_NAMES)[part] ?? part.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, ""))
    .join(linux ? "+" : " ")
}

/**
 * A key press as a shortcut in the plugin's words, or none while only modifiers are down. A shortcut
 * needs a modifier, so a plain key never fires everywhere.
 */
export function shortcutOf(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code">): string | undefined {
  if (/^(Alt|Control|Meta|Shift|OS)(Left|Right)?$/.test(event.code) || event.code === "") return undefined
  const mods = [event.metaKey ? "Command" : "", event.ctrlKey ? "Control" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter((part) => part.length > 0)
  if (mods.length === 0) return undefined
  return [...mods, event.code].join("+")
}
