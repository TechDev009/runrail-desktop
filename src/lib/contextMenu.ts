import type { MouseEvent } from "react"

/**
 * A right-click menu drawn by the system, as native Mac apps have, built from the same entries as
 * a row's "…" menu. In a plain browser preview the browser's own menu shows instead.
 */

export interface ContextEntry {
  readonly id: string
  readonly label: string
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}

export type ContextItem = ContextEntry | { readonly separator: true; readonly id: string }

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/** Only entries with a plain-text label can be drawn by the system; a separator never leads or trails. */
export function nativeItems(entries: readonly { readonly id: string; readonly label?: unknown; readonly separator?: true; readonly danger?: boolean; readonly disabled?: boolean; readonly onSelect?: () => void }[]): ContextItem[] {
  const items: ContextItem[] = []
  for (const entry of entries) {
    if (entry.separator === true) {
      if (items.length > 0 && !("separator" in items[items.length - 1]!)) items.push({ separator: true, id: entry.id })
      continue
    }
    if (typeof entry.label !== "string" || entry.onSelect === undefined) continue
    items.push({ id: entry.id, label: entry.label, onSelect: entry.onSelect, ...(entry.danger === true ? { danger: true } : {}), ...(entry.disabled === true ? { disabled: true } : {}) })
  }
  while (items.length > 0 && "separator" in items[items.length - 1]!) items.pop()
  return items
}

export function openContextMenu(event: MouseEvent, items: readonly ContextItem[]): void {
  if (!inTauri() || items.length === 0) return
  event.preventDefault()
  void (async () => {
    const { Menu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu")
    const built = await Promise.all(
      items.map((item) =>
        "separator" in item
          ? PredefinedMenuItem.new({ item: "Separator" })
          : MenuItem.new({ id: item.id, text: item.label, enabled: item.disabled !== true, action: () => item.onSelect() }),
      ),
    )
    const menu = await Menu.new({ items: built })
    await menu.popup()
  })().catch(() => undefined)
}
