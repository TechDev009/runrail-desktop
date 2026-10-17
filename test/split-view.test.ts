import { beforeEach, describe, expect, test } from "bun:test"
import { defaultState, parseState } from "../src/app/persist"
import { closePane, MAX_PANES, openBeside, shownPanes, showInPane } from "../src/app/split"
import { addProject, closeThreadPane, createThread, focusPane, get, openToSide, paneFocused, selectThread, set } from "../src/app/store"

/** Split view. */

const all = () => true

describe("the layout", () => {
  test("opening beside adds a pane next to the focused one, up to four", () => {
    expect(openBeside(undefined, "a", "b")).toEqual(["a", "b"])
    expect(openBeside(["a", "b", "c"], "a", "d")).toEqual(["a", "d", "b", "c"])
    expect(openBeside(["a", "b"], "a", "b")).toEqual(["a", "b"])
    expect(openBeside(undefined, undefined, "a")).toBeUndefined()
  })

  test("with every pane taken, the last one not focused gives way", () => {
    expect(openBeside(["a", "b", "c", "d"], "b", "e")).toEqual(["a", "b", "c", "e"])
    expect(openBeside(["a", "b", "c", "d"], "d", "e")).toEqual(["a", "b", "e", "d"])
  })

  test("a thread opened from the list shows in the focused pane, or focuses its own", () => {
    expect(showInPane(["a", "b"], "b", "c")).toEqual(["a", "c"])
    expect(showInPane(["a", "b"], "b", "a")).toEqual(["a", "b"])
    expect(showInPane(undefined, "a", "c")).toBeUndefined()
  })

  test("closing a pane moves the focus to its neighbour; one left is no split", () => {
    expect(closePane(["a", "b", "c"], "b", "b")).toEqual({ panes: ["a", "c"], active: "c" })
    expect(closePane(["a", "b", "c"], "c", "c")).toEqual({ panes: ["a", "b"], active: "b" })
    expect(closePane(["a", "b"], "a", "b")).toEqual({ panes: undefined, active: "a" })
  })

  test("what shows: saved panes still there, always with the focused thread", () => {
    expect(shownPanes(["a", "gone", "b"], "a", (id) => id !== "gone")).toEqual(["a", "b"])
    expect(shownPanes(["a", "b"], "c", all)).toEqual(["a", "b", "c"])
    expect(shownPanes(["a", "b", "c", "d"], "e", all)).toEqual(["a", "b", "c", "e"])
    expect(shownPanes(undefined, "a", all)).toEqual(["a"])
    expect(shownPanes(["gone", "b"], undefined, (id) => id !== "gone")).toEqual([])
    expect(shownPanes(["a", "a", "b"], "a", all)).toEqual(["a", "b"])
    expect(MAX_PANES).toBe(4)
  })
})

describe("panes in the app", () => {
  beforeEach(() => {
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  })

  const thread = (title: string) => createThread({ projectId: "p1", backend: "native", title, select: false }).id

  test("open to the side, focus, show from the list, and close", () => {
    const [a, b, c] = [thread("a"), thread("b"), thread("c")]
    selectThread(a)
    openToSide(b)
    expect(get().layout).toMatchObject({ panes: [a, b], activeThreadId: b })
    expect([paneFocused(b), paneFocused(a), paneFocused(undefined)]).toEqual([true, false, true])
    focusPane(a)
    expect(get().layout.activeThreadId).toBe(a)
    selectThread(c)
    expect(get().layout).toMatchObject({ panes: [c, b], activeThreadId: c })
    closeThreadPane(c)
    expect(get().layout.panes).toBeUndefined()
    expect(get().layout.activeThreadId).toBe(b)
  })

  test("the panes are saved with the layout, and a broken list is dropped", () => {
    const saved = parseState({ ...defaultState(), layout: { ...defaultState().layout, panes: ["th-a", "th-b"] } })
    expect(saved.layout.panes).toEqual(["th-a", "th-b"])
    expect(parseState({ ...defaultState(), layout: { ...defaultState().layout, panes: ["th-a"] } }).layout.panes).toBeUndefined()
    expect(parseState({ ...defaultState(), layout: { ...defaultState().layout, panes: ["th-1", "th-2", "th-3", "th-4", "th-5"] } }).layout.panes).toBeUndefined()
  })
})
