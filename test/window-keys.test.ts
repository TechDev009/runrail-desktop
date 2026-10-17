import { expect, test } from "bun:test"
import { appKeyInTerminal, menuKey } from "../src/app/windowKeys"
import { isMac } from "../src/lib/format"

// "mod" is Command where the test runs on a Mac and Control elsewhere, as in the app.
const key = (code: string, key: string, mods: { mod?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  key,
  ctrlKey: mods.ctrl === true || (mods.mod === true && !isMac),
  metaKey: mods.mod === true && isMac,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
})

// Linux has no app menu, so the window quits, closes and goes full screen itself.
test("the window takes the app menu's own keys", () => {
  expect(menuKey(key("KeyQ", "q", { mod: true }))).toBe("quit")
  expect(menuKey(key("KeyW", "W", { mod: true, shift: true }))).toBe("close-window")
  expect(menuKey(key("F11", "F11"))).toBe("fullscreen")
  expect(menuKey(key("KeyW", "w", { mod: true }))).toBeUndefined()
  expect(menuKey(key("KeyQ", "q"))).toBeUndefined()
})

test("the terminal keeps the keys a shell edits with and hands the app the rest", () => {
  for (const letter of ["k", "j", "p", "w", "l", "q"]) expect(appKeyInTerminal(key(`Key${letter.toUpperCase()}`, letter, { ctrl: true }))).toBe(false)
  expect(appKeyInTerminal(key("KeyD", "D", { mod: true, shift: true }))).toBe(true)
  expect(appKeyInTerminal(key("Digit2", "2", { mod: true }))).toBe(true)
  expect(appKeyInTerminal(key("Comma", ",", { mod: true }))).toBe(true)
  expect(appKeyInTerminal(key("KeyB", "b", { mod: true, alt: true }))).toBe(true)
  expect(appKeyInTerminal(key("F11", "F11"))).toBe(true)
  // Ctrl+[ is Escape to a shell; Ctrl+Tab stays with the terminal, as on macOS.
  expect(appKeyInTerminal(key("BracketLeft", "[", { ctrl: true }))).toBe(false)
  expect(appKeyInTerminal(key("Tab", "Tab", { ctrl: true }))).toBe(false)
  expect(appKeyInTerminal(key("KeyA", "a"))).toBe(false)
})
