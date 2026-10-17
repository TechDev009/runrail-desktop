import { describe, expect, test } from "bun:test"
import { accelerator, MENU_SHORTCUTS } from "../src/app/appMenu"
import { activeTab, canAdd, cycledTab, movedTab, withoutTab, withTab } from "../src/app/panels"
import { cleanPanels, parseState, PANEL_LIMITS, savedUrl, type PanelState, type PanelTab } from "../src/app/persist"
import { typedAddress } from "../src/app/previews"
import { matches } from "../src/lib/format"
import { SHORTCUTS } from "../src/ui/shell/shortcuts"

const tab = (id: string, kind: PanelTab["kind"] = "terminal"): PanelTab => ({ id, kind })
const panel = (ids: readonly string[], active?: string): PanelState => ({ tabs: ids.map((id) => tab(id)), ...(active === undefined ? {} : { active }) })

describe("panel tabs", () => {
  test("a new tab goes after the one on screen and shows", () => {
    expect(withTab(panel(["a", "b", "c"], "a"), tab("n"))).toEqual({ tabs: [tab("a"), tab("n"), tab("b"), tab("c")], active: "n" })
    expect(withTab(panel([]), tab("n"))).toEqual({ tabs: [tab("n")], active: "n" })
  })

  test("closing the shown tab shows its right neighbour, else its left one", () => {
    expect(withoutTab(panel(["a", "b", "c"], "b"), "b")).toEqual({ tabs: [tab("a"), tab("c")], active: "c" })
    expect(withoutTab(panel(["a", "b", "c"], "c"), "c")).toEqual({ tabs: [tab("a"), tab("b")], active: "b" })
    expect(withoutTab(panel(["a", "b"], "a"), "b")).toEqual({ tabs: [tab("a")], active: "a" })
    expect(withoutTab(panel(["a"], "a"), "a")).toEqual({ tabs: [] })
    expect(withoutTab(panel(["a"]), "missing")).toEqual(panel(["a"]))
  })

  test("without a marked tab the last one shows", () => {
    expect(activeTab(panel(["a", "b"]))?.id).toBe("b")
    expect(activeTab(panel(["a", "b"], "gone"))?.id).toBe("b")
  })

  test("moving and cycling", () => {
    expect(movedTab(panel(["a", "b", "c"]), "a", 2).tabs.map((item) => item.id)).toEqual(["b", "c", "a"])
    expect(movedTab(panel(["a", "b", "c"]), "c", 0).tabs.map((item) => item.id)).toEqual(["c", "a", "b"])
    expect(movedTab(panel(["a", "b", "c"]), "c", 99).tabs.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(cycledTab(panel(["a", "b", "c"], "c"), 1)).toBe("a")
    expect(cycledTab(panel(["a", "b", "c"], "a"), -1)).toBe("c")
    expect(cycledTab(panel([]), 1)).toBeUndefined()
  })

  test("singles open once; terminals, browsers, and all tabs are capped", () => {
    const review: PanelState = { tabs: [tab("r", "review")] }
    expect(canAdd(review, "review")).toBe(false)
    expect(canAdd(review, "files")).toBe(true)
    const terminals: PanelState = { tabs: Array.from({ length: PANEL_LIMITS.terminal }, (_, index) => tab(`t${String(index)}`)) }
    expect(canAdd(terminals, "terminal")).toBe(false)
    expect(canAdd(terminals, "browser")).toBe(true)
    const full: PanelState = { tabs: Array.from({ length: PANEL_LIMITS.tabs }, (_, index) => tab(`x${String(index)}`, index % 2 === 0 ? "browser" : "terminal")) }
    expect(canAdd(full, "tasks")).toBe(false)
  })
})

describe("saved panel tabs", () => {
  test("a browser tab keeps only the origin and path of its address", () => {
    expect(savedUrl("http://localhost:5173/app/page?token=abc#x")).toBe("http://localhost:5173/app/page")
    expect(savedUrl("https://user:secret@example.com/a")).toBeUndefined()
    expect(savedUrl("file:///etc/passwd")).toBeUndefined()
    expect(savedUrl("javascript:alert(1)")).toBeUndefined()
    expect(savedUrl(`https://example.com/${"a".repeat(2_100)}`)).toBeUndefined()
  })

  test("bad, duplicate, and extra tabs are dropped; a missing active tab is forgotten", () => {
    const panels = cleanPanels({
      t1: {
        tabs: [
          { id: "a", kind: "review" },
          { id: "b", kind: "review" },
          { id: "a", kind: "files" },
          { id: "c", kind: "agents" },
          { id: "d", kind: "browser", url: "http://localhost:3000/x?q=1" },
          { id: "e", kind: "browser", url: "tauri://localhost" },
        ],
        active: "zzz",
      },
      "bad id with spaces": { tabs: [{ id: "f", kind: "files" }] },
      t2: { tabs: [] },
      t3: "nonsense",
    })
    expect(panels).toEqual({ t1: { tabs: [{ id: "a", kind: "review" }, { id: "d", kind: "browser", url: "http://localhost:3000/x" }, { id: "e", kind: "browser" }] } })
  })

  test("at most the last threads' panels are kept", () => {
    const many = Object.fromEntries(Array.from({ length: PANEL_LIMITS.threads + 5 }, (_, index) => [`t${String(index)}`, { tabs: [{ id: "a", kind: "files" }] }]))
    const kept = Object.keys(cleanPanels(many))
    expect(kept).toHaveLength(PANEL_LIMITS.threads)
    expect(kept[0]).toBe("t5")
  })

  test("a deleted thread's tabs are not loaded", () => {
    const project = { id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }
    const thread = { id: "t1", projectId: "p1", title: "T", titled: true, createdAt: 1, updatedAt: 1, mode: "agent", permission: "ask", backend: "codex" }
    const state = parseState({
      version: 1,
      projects: [project],
      threads: [thread],
      prefs: {},
      layout: { panels: { t1: { tabs: [{ id: "a", kind: "tasks" }] }, gone: { tabs: [{ id: "b", kind: "files" }] } } },
    })
    expect(state.threads).toHaveLength(1)
    expect(state.layout.panels).toEqual({ t1: { tabs: [{ id: "a", kind: "tasks" }] } })
  })
})

describe("browser addresses", () => {
  test("a port or a local host means http on this computer", () => {
    expect(typedAddress("5173")).toBe("http://localhost:5173/")
    expect(typedAddress(":3000/app")).toBe("http://localhost:3000/app")
    expect(typedAddress("localhost:5173")).toBe("http://localhost:5173/")
    expect(typedAddress("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x")
    expect(typedAddress("[::1]:8080")).toBe("http://[::1]:8080/")
    expect(typedAddress("app.localhost:4000")).toBe("http://app.localhost:4000/")
  })

  test("a bare domain means https; a scheme is kept for the host to judge", () => {
    expect(typedAddress("example.com")).toBe("https://example.com/")
    expect(typedAddress("docs.example.com:8443/a?b=1")).toBe("https://docs.example.com:8443/a?b=1")
    expect(typedAddress("http://example.com")).toBe("http://example.com/")
    expect(typedAddress("file:///etc/passwd")).toBe("file:///etc/passwd")
    expect(typedAddress("javascript:alert(1)")).toBe("javascript:alert(1)")
  })

  test("anything else is not an address", () => {
    expect(typedAddress("")).toBeUndefined()
    expect(typedAddress("how do I fix this")).toBeUndefined()
    expect(typedAddress("hello")).toBeUndefined()
    expect(typedAddress(`https://example.com/${"a".repeat(2_100)}`)).toBeUndefined()
  })
})

describe("panel keys", () => {
  const key = (fields: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...fields })

  test("ctrl+tab needs Control, so Tab alone still moves focus", () => {
    expect(matches(key({ key: "Tab", ctrlKey: true }), "ctrl+tab")).toBe(true)
    expect(matches(key({ key: "Tab" }), "ctrl+tab")).toBe(false)
    expect(matches(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "ctrl+shift+tab")).toBe(true)
    expect(matches(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "ctrl+tab")).toBe(false)
  })

  test("menu accelerators follow the shortcut table's notation", () => {
    expect(accelerator("mod+shift+d")).toBe("CmdOrCtrl+Shift+D")
    expect(accelerator("ctrl+shift+tab")).toBe("Ctrl+Shift+Tab")
    expect(accelerator("mod+alt+b")).toBe("CmdOrCtrl+Alt+B")
    expect(accelerator("mod+,")).toBe("CmdOrCtrl+,")
  })

  test("the macOS menu carries every shortcut once, so each works while a browser preview has the keyboard", () => {
    expect([...MENU_SHORTCUTS].sort()).toEqual(SHORTCUTS.map((item) => item.id).sort())
  })
})
