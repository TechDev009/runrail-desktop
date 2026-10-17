/** Every global shortcut, in one table the keymap handler and the Shortcuts settings page share. */

export type ShortcutId =
  | "palette"
  | "search"
  | "new-thread"
  | "open-project"
  | "settings"
  | "shortcuts"
  | "sidebar"
  | "inspector"
  | "review"
  | "files"
  | "terminal"
  | "tasks"
  | "browser"
  | "new-tab"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "prev-thread"
  | "next-thread"
  | "composer"
  | "find"
  | "stop"
  | "dictate"
  | "waiting"
  | "go-threads"
  | "go-reviews"
  | "go-agents"
  | "go-workflows"
  | "go-evals"
  | "go-memory"
  | "go-integrations"
  | "go-office"

export interface Shortcut {
  readonly id: ShortcutId
  readonly keys: string
  readonly label: string
  readonly group: "General" | "Go to" | "Layout" | "Threads"
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", keys: "mod+k", label: "Command palette", group: "General" },
  { id: "search", keys: "mod+shift+f", label: "Search projects and threads", group: "General" },
  { id: "new-thread", keys: "mod+n", label: "New thread", group: "General" },
  { id: "open-project", keys: "mod+o", label: "Open project", group: "General" },
  { id: "settings", keys: "mod+,", label: "Settings", group: "General" },
  { id: "shortcuts", keys: "mod+/", label: "Keyboard shortcuts", group: "General" },
  { id: "go-threads", keys: "mod+1", label: "Threads", group: "Go to" },
  { id: "go-reviews", keys: "mod+2", label: "Reviews", group: "Go to" },
  { id: "go-agents", keys: "mod+3", label: "Agents", group: "Go to" },
  { id: "go-workflows", keys: "mod+4", label: "Workflows", group: "Go to" },
  { id: "go-evals", keys: "mod+5", label: "Evals", group: "Go to" },
  { id: "go-memory", keys: "mod+7", label: "Memory", group: "Go to" },
  { id: "go-integrations", keys: "mod+6", label: "Integrations", group: "Go to" },
  { id: "go-office", keys: "mod+8", label: "Office, when office mode is on", group: "Go to" },
  { id: "sidebar", keys: "mod+b", label: "Show or hide the threads list", group: "Layout" },
  { id: "inspector", keys: "mod+alt+b", label: "Toggle side panel", group: "Layout" },
  { id: "review", keys: "mod+shift+d", label: "Review changes", group: "Layout" },
  { id: "files", keys: "mod+p", label: "Files", group: "Layout" },
  { id: "terminal", keys: "mod+j", label: "Terminal", group: "Layout" },
  { id: "tasks", keys: "mod+shift+a", label: "Tasks", group: "Layout" },
  { id: "browser", keys: "mod+shift+b", label: "Browser preview", group: "Layout" },
  { id: "new-tab", keys: "mod+t", label: "New side panel tab", group: "Layout" },
  { id: "close-tab", keys: "mod+w", label: "Close side panel tab", group: "Layout" },
  { id: "next-tab", keys: "ctrl+tab", label: "Next side panel tab", group: "Layout" },
  { id: "prev-tab", keys: "ctrl+shift+tab", label: "Previous side panel tab", group: "Layout" },
  { id: "prev-thread", keys: "mod+shift+[", label: "Previous thread", group: "Threads" },
  { id: "next-thread", keys: "mod+shift+]", label: "Next thread", group: "Threads" },
  { id: "composer", keys: "mod+l", label: "Focus the composer", group: "Threads" },
  { id: "find", keys: "mod+f", label: "Find in the thread", group: "Threads" },
  { id: "stop", keys: "mod+.", label: "Stop the agent", group: "Threads" },
  { id: "dictate", keys: "mod+shift+m", label: "Dictate into the composer", group: "Threads" },
  { id: "waiting", keys: "mod+i", label: "Waiting on you", group: "Threads" },
]

/** Composer keys are handled inside the composer; listed here for the reference page only. */
export const COMPOSER_KEYS: readonly { readonly keys: string; readonly label: string }[] = [
  { keys: "enter", label: "Send (or queue while the agent works)" },
  { keys: "shift+enter", label: "New line" },
  { keys: "mod+enter", label: "Steer the running turn" },
  { keys: "escape", label: "Stop the agent" },
  { keys: "@", label: "Mention a file" },
  { keys: "/", label: "Slash commands" },
]
