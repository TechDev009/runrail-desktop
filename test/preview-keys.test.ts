import { describe, expect, test } from "bun:test"
import { shortcutOf } from "../src/app/previewKeys"
import { SHORTCUTS } from "../src/ui/shell/shortcuts"

describe("shortcuts a preview hands over", () => {
  test("run by their keys, and nothing else does", () => {
    for (const shortcut of SHORTCUTS) expect(shortcutOf(shortcut.keys)).toBe(shortcut.id)
    for (const other of ["mod+c", "", "mod+K", null, 7, { keys: "mod+k" }]) expect(shortcutOf(other)).toBeUndefined()
  })
})
