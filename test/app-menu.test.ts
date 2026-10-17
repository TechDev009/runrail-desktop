import { afterAll, expect, mock, test } from "bun:test"
import { MENU_SHORTCUTS } from "../src/app/appMenu"

class MenuItem {
  static async new(options: Record<string, unknown>): Promise<MenuItem> {
    return new MenuItem(options)
  }
  constructor(readonly options: Record<string, unknown>) {}
  async setEnabled(): Promise<void> {}
}

const submenus: (readonly unknown[])[] = []

afterAll(() => {
  delete (globalThis as { window?: unknown }).window
})

test("every app menu item with an action is made on its own, which is the only kind Tauri keeps the action of", async () => {
  mock.module("@tauri-apps/api/menu", () => ({
    MenuItem,
    Submenu: {
      new: async (options: { readonly items: readonly unknown[] }) => {
        submenus.push(options.items)
        return { setAsHelpMenuForNSApp: async () => undefined }
      },
    },
    Menu: { new: async () => ({ setAsAppMenu: async () => undefined }) },
  }))
  ;(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} }
  const { installAppMenu } = await import("../src/app/appMenu")
  await installAppMenu(() => undefined, () => undefined)
  const items = submenus.flat()
  expect(items.filter((item) => !(item instanceof MenuItem) && typeof item === "object" && item !== null && ("action" in item || "text" in item))).toEqual([])
  // The shortcuts, the two Help links and Close Window.
  expect(items.filter((item) => item instanceof MenuItem)).toHaveLength(MENU_SHORTCUTS.length + 3)
  expect(items.some((item) => item instanceof MenuItem && "id" in item.options)).toBe(false)
})
