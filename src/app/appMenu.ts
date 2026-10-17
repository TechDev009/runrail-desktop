import { SHORTCUTS, type ShortcutId } from "../ui/shell/shortcuts"

/**
 * The macOS menu bar. Its items carry the app's shortcuts, so they also work while a browser
 * preview (a separate native view) has the keyboard. In the app's own page the window-level key
 * handler takes them first and the menu does not fire.
 */

/** "mod+shift+d" as a Tauri accelerator: "CmdOrCtrl+Shift+D". */
export function accelerator(keys: string): string {
  return keys
    .split("+")
    .map((part) => {
      switch (part) {
        case "mod":
          return "CmdOrCtrl"
        case "shift":
          return "Shift"
        case "alt":
          return "Alt"
        case "ctrl":
          return "Ctrl"
        case "tab":
          return "Tab"
        default:
          return part.length === 1 ? part.toUpperCase() : part
      }
    })
    .join("+")
}

function keysOf(id: ShortcutId): string | undefined {
  return SHORTCUTS.find((item) => item.id === id)?.keys
}

type Entry = { readonly id: ShortcutId; readonly text: string } | "separator"

const FILE: readonly Entry[] = [{ id: "new-thread", text: "New Thread" }, { id: "open-project", text: "Open Project…" }, "separator", { id: "new-tab", text: "New Panel Tab" }, { id: "close-tab", text: "Close" }]
const VIEW: readonly Entry[] = [
  { id: "palette", text: "Command Palette…" },
  "separator",
  { id: "go-threads", text: "Threads" },
  { id: "go-reviews", text: "Reviews" },
  { id: "go-agents", text: "Agents" },
  { id: "go-workflows", text: "Workflows" },
  { id: "go-evals", text: "Evals" },
  { id: "go-integrations", text: "Integrations" },
  { id: "go-memory", text: "Memory" },
  { id: "go-office", text: "Office" },
  "separator",
  { id: "sidebar", text: "Show or Hide Threads List" },
  { id: "inspector", text: "Toggle Side Panel" },
  "separator",
  { id: "review", text: "Review Changes" },
  { id: "files", text: "Files" },
  { id: "terminal", text: "Terminal" },
  { id: "tasks", text: "Tasks" },
  { id: "browser", text: "Browser Preview" },
  "separator",
  { id: "next-tab", text: "Next Panel Tab" },
  { id: "prev-tab", text: "Previous Panel Tab" },
]
const THREAD: readonly Entry[] = [{ id: "composer", text: "Focus Composer" }, { id: "stop", text: "Stop the Agent" }, { id: "dictate", text: "Dictate" }, "separator", { id: "waiting", text: "Waiting on You" }, "separator", { id: "prev-thread", text: "Previous Thread" }, { id: "next-thread", text: "Next Thread" }]
const FIND: readonly Entry[] = [{ id: "find", text: "Find in Thread" }, { id: "search", text: "Search Projects and Threads…" }]
const HELP: readonly Entry[] = [{ id: "shortcuts", text: "Keyboard Shortcuts" }]

/** The shortcuts the menu carries, which are the ones that work while a browser preview has the keyboard. */
export const MENU_SHORTCUTS: readonly ShortcutId[] = ["settings", ...[FILE, FIND, VIEW, THREAD, HELP].flat().flatMap((entry) => (entry === "separator" ? [] : [entry.id]))]

const REPOSITORY = "https://github.com/TechDev009/runrail-desktop"

let installed = false
let officeOn = false
let officeItem: { readonly setEnabled: (enabled: boolean) => Promise<void> } | undefined

/** Tauri menus can grey an item but not hide it, so Office stays in View, disabled while office mode is off. */
export async function setOfficeInMenu(on: boolean): Promise<void> {
  officeOn = on
  await officeItem?.setEnabled(on)
}

/** Closes the window as its close button does, so an unfinished turn still asks first. */
export async function closeWindow(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  await getCurrentWindow().close()
}

export async function installAppMenu(run: (id: ShortcutId) => void, openLink: (url: string) => void): Promise<void> {
  if (installed || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return
  installed = true
  const { Menu, MenuItem, Submenu } = await import("@tauri-apps/api/menu")
  // Every item with an action is made on its own: Tauri drops an action with its item, and keeps
  // only items made this way, so one given to Submenu.new as options never runs. Ids are left to
  // Tauri for the same reason, or a reload's old items would take the new ones' actions with them.
  const action = (text: string, act: () => void, keys?: string, enabled = true) => MenuItem.new({ text, action: act, enabled, ...(keys === undefined ? {} : { accelerator: accelerator(keys) }) })
  const shortcut = (entry: Exclude<Entry, "separator">) => action(entry.text, () => run(entry.id), keysOf(entry.id), entry.id !== "go-office" || officeOn)
  const items = (entries: readonly Entry[]) => Promise.all(entries.map((entry) => (entry === "separator" ? { item: "Separator" as const } : shortcut(entry))))
  const view = await items(VIEW)
  const help = await Submenu.new({
    text: "Help",
    items: [...(await items(HELP)), { item: "Separator" }, await action("Runrail Desktop on GitHub", () => openLink(REPOSITORY)), await action("Report an Issue…", () => openLink(`${REPOSITORY}/issues`))],
  })
  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Runrail",
        items: [
          { item: { About: null } },
          { item: "Separator" },
          await action("Settings…", () => run("settings"), keysOf("settings") ?? "mod+,"),
          { item: "Separator" },
          { item: "Services" },
          { item: "Separator" },
          { item: "Hide" },
          { item: "HideOthers" },
          { item: "ShowAll" },
          { item: "Separator" },
          { item: "Quit" },
        ],
      }),
      await Submenu.new({ text: "File", items: await items(FILE) }),
      await Submenu.new({ text: "Edit", items: [{ item: "Undo" }, { item: "Redo" }, { item: "Separator" }, { item: "Cut" }, { item: "Copy" }, { item: "Paste" }, { item: "SelectAll" }, { item: "Separator" }, ...(await items(FIND))] }),
      await Submenu.new({ text: "View", items: [...view, { item: "Separator" }, { item: "Fullscreen" }] }),
      await Submenu.new({ text: "Thread", items: await items(THREAD) }),
      await Submenu.new({
        text: "Window",
        items: [{ item: "Minimize" }, { item: "Maximize" }, { item: "Separator" }, await action("Close Window", () => void closeWindow(), "mod+shift+w"), { item: "BringAllToFront" }],
      }),
      help,
    ],
  })
  await menu.setAsAppMenu()
  // macOS then adds its menu search field to Help.
  await help.setAsHelpMenuForNSApp()
  const office = view[VIEW.findIndex((entry) => entry !== "separator" && entry.id === "go-office")]
  officeItem = office !== undefined && "setEnabled" in office ? office : undefined
  await officeItem?.setEnabled(officeOn)
}
