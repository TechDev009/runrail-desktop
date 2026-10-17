import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import type { Connection } from "../src/app/connections"
import type { ToolConnection } from "../src/app/connectionSettings"
import { DEFAULT_PREFS } from "../src/app/persist"
import type { CodingTool } from "../src/app/picker"
import { useQuick } from "../src/app/quick"
import { get, set, useApp } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { quickChatKeys, Welcome, welcomeChips } from "../src/ui/thread/ThreadView"

const ROOT = join(import.meta.dir, "..")
let previous = { ...get() }
const initialState = useApp.getInitialState()
const originalInitialState = { ...initialState }

function render(node: ReactNode): string {
  // Server rendering reads Zustand's initial snapshot rather than its current state.
  Object.assign(initialState, get())
  return renderToStaticMarkup(node)
}

beforeEach(() => {
  previous = { ...get() }
  setHost(createFakeHost())
  set({ projects: [], threads: [], prefs: DEFAULT_PREFS, layout: { ...previous.layout, activeThreadId: undefined, activeProjectId: undefined } })
})
afterEach(() => {
  set(previous)
  Object.assign(initialState, originalInitialState)
})

describe("welcome screen", () => {
  test("shows the head, the three ways to start, and the status strip", () => {
    const html = render(<Welcome />)
    expect(html).toContain('src="/runrail-icon.png"')
    expect(html).toContain("What are we building?")
    for (const card of ["Open a folder", "New app", "Quick chat"]) expect(html).toContain(card)
    expect(html).toContain("Nifra, Vite, Next.js, or empty")
    expect(html).toContain('class="welcome-strip"')
    expect(html).toContain("commands")
    // The old marketing copy is gone.
    expect(html).not.toContain("welcome-points")
  })

  test("quick chat shows its shortcut, or says it is off", () => {
    expect(render(<Welcome />)).toContain("Ask anything, no project")
    // Server rendering reads the store's initial snapshot, as for the app store above.
    const quick = useQuick.getInitialState() as { status?: unknown }
    quick.status = { enabled: false, shortcut: "Alt+Space" }
    try {
      const html = render(<Welcome />)
      expect(html).toContain("Turned off in Settings")
      expect(html).not.toContain("Ask anything, no project")
    } finally {
      delete quick.status
    }
  })
})

describe("status chips", () => {
  const tool = (id: string, extra: Partial<ToolConnection> = {}): ToolConnection => ({ id, tool: "claude-code", label: "Claude Code", authMode: "subscription", separateAccount: false, enabled: true, ...extra })
  const connection = (id: string, extra: Partial<Connection> = {}): Connection => ({ id, label: id, presetId: "anthropic", authMode: "api-key", status: "ready", ...extra })

  test("a tool signed in is green, one that says it is not is amber with Sign in", () => {
    const found: CodingTool[] = [
      { id: "claude-code", available: true, signedIn: true },
      { id: "codex", available: true, signedIn: false },
    ]
    const chips = welcomeChips([tool("cc"), tool("cx", { tool: "codex", label: "Codex" })], found, undefined)
    expect(chips.map((chip) => [chip.text, chip.tone])).toEqual([
      ["Claude Code", "ok"],
      ["Codex · Sign in", "warn"],
    ])
    expect(chips.every((chip) => chip.fix === "connections")).toBe(true)
    expect(chips[0]?.label).toBe("Claude Code, signed in")
  })

  test("tools that are off are left out; a separate account or an unknown state stays neutral", () => {
    const found: CodingTool[] = [{ id: "claude-code", available: true, signedIn: false }]
    const chips = welcomeChips([tool("off", { enabled: false }), tool("own", { label: "Claude Code (work)", separateAccount: true }), tool("pi", { tool: "pi", label: "Pi" })], found, undefined)
    expect(chips.map((chip) => [chip.text, chip.tone])).toEqual([
      ["Claude Code (work)", "off"],
      ["Pi", "off"],
    ])
  })

  test("a tool that is not installed says so", () => {
    const chips = welcomeChips([tool("cc")], [{ id: "claude-code", available: false }], undefined)
    expect(chips[0]).toMatchObject({ text: "Claude Code · Not installed", tone: "warn" })
  })

  test("Runrail's chip counts ready models once the list is in, or offers to connect one", () => {
    expect(welcomeChips([], [], undefined)).toEqual([])
    expect(welcomeChips([], [], [])).toEqual([{ key: "runrail", text: "Connect a model", label: "Runrail, no model connected", tone: "off", fix: "connect" }])
    const listed = [connection("a"), connection("b"), connection("off", { enabled: false }), connection("expired", { status: "expired" })]
    expect(welcomeChips([], [], listed)[0]).toMatchObject({ text: "Runrail · 2 models", tone: "ok", fix: "connections" })
    expect(welcomeChips([], [], [connection("a")])[0]?.text).toBe("Runrail · 1 model")
  })
})

describe("quick chat keys", () => {
  test("the shortcut plugin's words become the keys Kbd draws", () => {
    expect(quickChatKeys("Alt+Space", true)).toBe("alt+Space")
    expect(quickChatKeys("Control+Alt+Space", false)).toBe("ctrl+alt+Space")
    expect(quickChatKeys("Super+Shift+KeyK", true)).toBe("mod+shift+K")
    expect(quickChatKeys("Super+Shift+KeyK", false)).toBe("Super+shift+K")
    expect(quickChatKeys("CmdOrCtrl+Digit1", false)).toBe("ctrl+1")
  })
})

describe("splash", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8")
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""

  interface Page {
    readonly root: { dataset: Record<string, string | undefined> }
    readonly stored: Map<string, string>
    readonly observed: { callback?: () => void; filter?: readonly string[] }
  }

  /** Runs the inline script against a stand-in page; `storage: false` makes storage throw, as a locked-down webview does. */
  function run(saved: string | undefined, storage = true): Page {
    const page: Page = { root: { dataset: {} }, stored: new Map(saved === undefined ? [] : [["runrail.theme", saved]]), observed: {} }
    const localStorage = {
      getItem: (key: string): string | null => {
        if (!storage) throw new Error("storage is off")
        return page.stored.get(key) ?? null
      },
      setItem: (key: string, value: string): void => {
        if (!storage) throw new Error("storage is off")
        page.stored.set(key, value)
      },
    }
    class MutationObserver {
      constructor(callback: () => void) {
        page.observed.callback = callback
      }
      observe(_target: unknown, options: { readonly attributeFilter: readonly string[] }): void {
        page.observed.filter = options.attributeFilter
      }
    }
    new Function("document", "localStorage", "MutationObserver", script)({ documentElement: page.root }, localStorage, MutationObserver)
    return page
  }

  test("is drawn by index.html itself, outside the app's root, with the shared icon", () => {
    expect(html.indexOf('id="splash"')).toBeGreaterThan(-1)
    expect(html.indexOf('id="splash"')).toBeLessThan(html.indexOf('id="root"'))
    expect(html).toContain('src="/runrail-icon.png"')
    expect(existsSync(join(ROOT, "public", "runrail-icon.png"))).toBe(true)
  })

  test("takes the saved theme, and leaves anything else to the system's look", () => {
    expect(run("light").root.dataset.splash).toBe("light")
    expect(run("dark").root.dataset.splash).toBe("dark")
    expect(run("sepia").root.dataset.splash).toBeUndefined()
    expect(run(undefined).root.dataset.splash).toBeUndefined()
    expect(run("light", false).root.dataset.splash).toBeUndefined()
  })

  test("saves each theme the app applies, for the next launch", () => {
    const page = run(undefined)
    expect(page.observed.filter).toEqual(["data-theme"])
    page.root.dataset.theme = "light"
    page.observed.callback?.()
    expect(page.stored.get("runrail.theme")).toBe("light")
    page.root.dataset.theme = "dark"
    page.observed.callback?.()
    expect(page.stored.get("runrail.theme")).toBe("dark")
    const locked = run(undefined, false)
    locked.root.dataset.theme = "light"
    expect(() => locked.observed.callback?.()).not.toThrow()
  })

  test("styles come from a linked sheet, so Tauri adds no style nonce that would void unsafe-inline", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as { app: { security: { csp: string; dangerousDisableAssetCspModification?: unknown } } }
    expect(html).not.toContain("<style")
    expect(html).toContain('<link rel="stylesheet" href="/splash.css" />')
    expect(readFileSync(join(ROOT, "public", "splash.css"), "utf8")).toContain("#splash")
    expect(config.app.security.dangerousDisableAssetCspModification).toBeUndefined()
    expect(config.app.security.csp).toContain("style-src 'self' 'unsafe-inline'")
  })
})
