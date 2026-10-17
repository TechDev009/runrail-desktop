import { describe, expect, test } from "bun:test"
import { accelerator } from "../src/app/appMenu"
import { ariaKeys, listShown, placeOf, railAction, railItems } from "../src/app/rail"
import type { View } from "../src/app/store"
import { isMac, matches } from "../src/lib/format"
import { SHORTCUTS } from "../src/ui/shell/shortcuts"

const THREAD: View = { kind: "thread" }
const COMPARE: View = { kind: "compare", groupId: "g1" }
const WORKFLOWS: View = { kind: "workflows" }
const INTEGRATIONS: View = { kind: "integrations" }
const OFFICE: View = { kind: "office" }
const REVIEWS: View = { kind: "reviews" }
const AGENTS: View = { kind: "agents", runId: "setup-1" }
const EVALS: View = { kind: "evals" }
const MEMORY: View = { kind: "memory" }

describe("rail items", () => {
  test("lists the shipped places in rail order, with office only when office mode is on", () => {
    expect(railItems({ view: THREAD, office: false, waiting: 0 }).map((item) => item.place)).toEqual(["threads", "reviews", "agents", "workflows", "evals", "integrations", "memory"])
    expect(railItems({ view: THREAD, office: true, waiting: 0 }).map((item) => item.place)).toEqual(["threads", "reviews", "agents", "workflows", "evals", "integrations", "memory", "office"])
  })

  test("marks exactly one place active for every view", () => {
    for (const [view, place] of [
      [THREAD, "threads"],
      [COMPARE, "threads"],
      [REVIEWS, "reviews"],
      [AGENTS, "agents"],
      [WORKFLOWS, "workflows"],
      [EVALS, "evals"],
      [MEMORY, "memory"],
      [INTEGRATIONS, "integrations"],
      [OFFICE, "office"],
    ] as const) {
      const active = railItems({ view, office: true, waiting: 0 }).filter((item) => item.active)
      expect(active.map((item) => item.place)).toEqual([place])
      expect(placeOf(view)).toBe(place)
    }
  })

  test("counts threads waiting on Office and pull requests waiting on Reviews, only when something waits", () => {
    const items = railItems({ view: THREAD, office: true, waiting: 3, reviewsWaiting: 2, agentsWaiting: 1, evalsRunning: 1 })
    expect(items.filter((item) => item.badge !== undefined).map((item) => [item.place, item.badge])).toEqual([
      ["reviews", 2],
      ["agents", 1],
      ["evals", 1],
      ["office", 3],
    ])
    expect(railItems({ view: THREAD, office: true, waiting: 0 }).some((item) => item.badge !== undefined)).toBe(false)
  })

  test("keeps each place's digit, and every digit is a registered shortcut", () => {
    const keys = Object.fromEntries(railItems({ view: THREAD, office: true, waiting: 0 }).map((item) => [item.place, item.keys]))
    expect(keys).toEqual({ threads: "mod+1", reviews: "mod+2", agents: "mod+3", workflows: "mod+4", evals: "mod+5", integrations: "mod+6", memory: "mod+7", office: "mod+8" })
    for (const value of Object.values(keys)) expect(SHORTCUTS.some((shortcut) => shortcut.keys === value)).toBe(true)
  })
})

describe("threads list", () => {
  test("shows on the Threads place only, and only while kept open", () => {
    expect(listShown(THREAD, true)).toBe(true)
    expect(listShown(COMPARE, true)).toBe(true)
    expect(listShown(THREAD, false)).toBe(false)
    for (const view of [REVIEWS, AGENTS, WORKFLOWS, EVALS, INTEGRATIONS, MEMORY, OFFICE]) expect(listShown(view, true)).toBe(false)
  })
})

describe("choosing a place", () => {
  test("shows another place", () => {
    expect(railAction("workflows", { view: THREAD, office: false })).toBe("show")
    expect(railAction("threads", { view: INTEGRATIONS, office: false })).toBe("show")
    expect(railAction("office", { view: THREAD, office: true })).toBe("show")
  })

  test("toggles the threads list when Threads is already shown, also from Compare", () => {
    expect(railAction("threads", { view: THREAD, office: false })).toBe("toggle-list")
    expect(railAction("threads", { view: COMPARE, office: false })).toBe("toggle-list")
  })

  test("does nothing for the place already shown, or Office while office mode is off", () => {
    expect(railAction("workflows", { view: WORKFLOWS, office: false })).toBe("none")
    expect(railAction("office", { view: OFFICE, office: true })).toBe("none")
    expect(railAction("office", { view: THREAD, office: false })).toBe("none")
  })
})

describe("rail shortcuts", () => {
  test("no two shortcuts share keys", () => {
    const keys = SHORTCUTS.map((shortcut) => shortcut.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("a digit shortcut matches its key and its physical key, and not a bare digit", () => {
    const mod = { ctrlKey: !isMac, metaKey: isMac, shiftKey: false, altKey: false }
    expect(matches({ ...mod, key: "1", code: "Digit1" }, "mod+1")).toBe(true)
    expect(matches({ ...mod, key: "¡", code: "Digit1" }, "mod+1")).toBe(true)
    expect(matches({ ...mod, ctrlKey: false, metaKey: false, key: "1", code: "Digit1" }, "mod+1")).toBe(false)
  })

  test("names the keys for assistive technology and the native menu", () => {
    expect(ariaKeys("mod+1", true)).toBe("Meta+1")
    expect(ariaKeys("mod+1", false)).toBe("Control+1")
    expect(ariaKeys("mod+shift+k", true)).toBe("Meta+Shift+K")
    expect(accelerator("mod+4")).toBe("CmdOrCtrl+4")
  })
})
