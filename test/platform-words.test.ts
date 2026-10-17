import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { platformWords } from "../src/app/platformWords"

/**
 * Words that only make sense on a Mac stay out of what Linux shows. Every string
 * and JSX text in the app is read; one naming Finder, the Mac, macOS, System Settings, the menu bar,
 * the Keychain or a Mac key fails unless it comes from `platformWords` or is listed below with why
 * Linux never shows it.
 */

const SRC = join(import.meta.dir, "..", "src")

const MAC_ONLY: readonly RegExp[] = [
  /\bFinder\b/,
  /\b(this|the|your) Mac\b/,
  /\bMac's\b/,
  /\bmacOS\b/,
  /\bSystem Settings\b/,
  /\bmenu bar\b/,
  /\bKeychain\b/,
  /\bDock\b/,
  /\bCmd\+/,
  /[⌘⌥⌃]/,
  /\bOption(-click| Space)\b/,
  /\bCommand-Return\b/,
]

/** Shown only where the words are right, each with the reason. */
const SHOWN_ON_MAC_ONLY: readonly { readonly file: string; readonly text: string; readonly why: string }[] = [
  { file: "app/platformWords.ts", text: "", why: "the macOS side of the platform words" },
  { file: "app/appMenu.ts", text: "", why: "the app menu is installed on macOS only" },
  { file: "lib/format.ts", text: "", why: "key glyphs are picked by platform there" },
  { file: "app/actions.ts", text: "Finder", why: "an Open in label the host lists on macOS only" },
  { file: "ui/shell/ComputerSettings.tsx", text: "", why: "computer use, which has its own Linux text" },
  { file: "ui/thread/Composer.tsx", text: "on this Mac", why: "computer use, which has its own Linux text" },
  { file: "ui/thread/ComposerMenus.tsx", text: "apps on this Mac", why: "computer use, which has its own Linux text" },
  { file: "quick/main.tsx", text: "Screen Recording permission; macOS asks", why: "shown with a window picture, which Linux leaves off" },
  { file: "ui/shell/Settings.tsx", text: "Keep speech on this Mac", why: "Apple's recognizer, which Linux does not offer" },
  { file: "ui/shell/Settings.tsx", text: "macOS recognizes on this Mac only", why: "Apple's recognizer, which Linux does not offer" },
  { file: "ui/shell/Settings.tsx", text: "Depending on the language and your Mac", why: "Apple's recognizer, which Linux does not offer" },
  { file: "ui/shell/settingsIndex.ts", text: "Keep speech on this Mac", why: "Apple's recognizer, which Linux does not offer" },
  { file: "ui/shell/settingsIndex.ts", text: "open at login background menu bar tray", why: "search words, never shown" },
  { file: "app/voice.ts", text: "System Settings", why: "the web view's own recognizer, which WebKitGTK does not have" },
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Every string literal, template piece and JSX text in a file, with its line. */
function texts(path: string): { readonly line: number; readonly text: string }[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { line: number; text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test("no macOS-only word reaches a string Linux shows", () => {
  const offenders: string[] = []
  for (const path of sources(SRC)) {
    const file = relative(SRC, path)
    // The browser preview's stand-in for the Mac app; Linux runs the real host.
    if (file.startsWith("host/fake")) continue
    for (const { line, text } of texts(path)) {
      if (!MAC_ONLY.some((word) => word.test(text))) continue
      if (SHOWN_ON_MAC_ONLY.some((allowed) => allowed.file === file && text.includes(allowed.text))) continue
      offenders.push(`${file}:${String(line)}: ${text.trim().slice(0, 120)}`)
    }
  }
  expect(offenders).toEqual([])
})

test("Linux words name the computer, its file manager and its keyring plainly", () => {
  const linux = platformWords("linux")
  for (const word of Object.values(linux)) if (typeof word === "string") expect(MAC_ONLY.some((pattern) => pattern.test(word))).toBe(false)
  expect([linux.reveal, `this ${linux.computer}`, linux.notifications, linux.notificationsInText]).toEqual(["Show in Files", "this computer", "System notifications", "system notifications"])
  // Everywhere else, the browser preview included, reads as the Mac app always did.
  for (const platform of ["macos", "browser", undefined]) expect(platformWords(platform).reveal).toBe("Reveal in Finder")
})
