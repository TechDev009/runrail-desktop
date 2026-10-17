import { matches, type KeyLike } from "../lib/format"
import { SHORTCUTS } from "../ui/shell/shortcuts"

/**
 * Keys macOS gives to its app menu. Linux has no app menu, so the window takes them
 * itself, and its terminal hands the app every shortcut but the plain Ctrl+letter keys shells edit with.
 */

export type MenuKey = "quit" | "close-window" | "fullscreen"

export function menuKey(event: KeyLike): MenuKey | undefined {
  if (matches(event, "mod+q")) return "quit"
  if (matches(event, "mod+shift+w")) return "close-window"
  if (matches(event, "f11")) return "fullscreen"
  return undefined
}

/** Ctrl+W deletes a word and Ctrl+L clears in a shell, so a plain Ctrl+letter stays in the terminal. */
export function appKeyInTerminal(event: KeyLike): boolean {
  if (event.ctrlKey && !event.shiftKey && !event.altKey && /^Key[A-Z]$/.test(event.code)) return false
  return menuKey(event) !== undefined || SHORTCUTS.some((item) => item.keys.startsWith("mod+") && matches(event, item.keys))
}

export async function toggleFullscreen(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const current = getCurrentWindow()
  await current.setFullscreen(!(await current.isFullscreen()))
}
