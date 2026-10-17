import { SHORTCUTS, type ShortcutId } from "../ui/shell/shortcuts"

/**
 * Outside macOS there is no app menu to catch the app's shortcuts while a browser preview (a
 * separate native view) has the keyboard, so the host hands them over (src-tauri/src/preview_gtk.rs)
 * by their keys, and they run as the menu's would.
 */

let listening = false

export function shortcutOf(keys: unknown): ShortcutId | undefined {
  return typeof keys === "string" ? SHORTCUTS.find((shortcut) => shortcut.keys === keys)?.id : undefined
}

export async function listenPreviewShortcuts(run: (id: ShortcutId) => void): Promise<void> {
  if (listening || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return
  listening = true
  const { listen } = await import("@tauri-apps/api/event")
  await listen<unknown>("preview:shortcut", (event) => {
    const id = shortcutOf(event.payload)
    if (id !== undefined) run(id)
  })
}
