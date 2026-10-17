import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { closeCoveringPanel } from "../src/app/overlays"
import { defaultState } from "../src/app/persist"
import { get, set, setLayout } from "../src/app/store"

let width = 1400
const saved = (globalThis as { window?: unknown }).window

beforeEach(() => {
  // Only what the layout asks of the window: which width queries match.
  ;(globalThis as { window?: unknown }).window = { matchMedia: (query: string) => ({ matches: width <= Number(/(\d+)px/.exec(query)?.[1] ?? 0) }) }
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
})

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = saved
})

describe("Escape and panels over the thread", () => {
  test("closes the inspector, then the sidebar, only while they cover the thread", () => {
    width = 800
    setLayout({ inspectorOpen: true, sidebarOpen: true })
    expect(closeCoveringPanel()).toBe(true)
    expect(get().layout).toMatchObject({ inspectorOpen: false, sidebarOpen: true })
    expect(closeCoveringPanel()).toBe(true)
    expect(get().layout.sidebarOpen).toBe(false)
    // Nothing left on top: the next Escape is the composer's to use.
    expect(closeCoveringPanel()).toBe(false)
  })

  test("a panel beside the thread is left open", () => {
    width = 1400
    setLayout({ inspectorOpen: true, sidebarOpen: true })
    expect(closeCoveringPanel()).toBe(false)
    expect(get().layout).toMatchObject({ inspectorOpen: true, sidebarOpen: true })
    // Between the two widths only the inspector covers the thread.
    width = 1000
    expect(closeCoveringPanel()).toBe(true)
    expect(closeCoveringPanel()).toBe(false)
    expect(get().layout.sidebarOpen).toBe(true)
  })
})
