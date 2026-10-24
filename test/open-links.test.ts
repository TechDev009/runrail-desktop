import { beforeEach, describe, expect, test } from "bun:test"
import { linkTarget, openInBrowser, openUrl } from "../src/app/actions"
import { panelOf } from "../src/app/panels"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { createTauriHost } from "../src/host/tauriHost"
import { terminalLinks } from "../src/ui/inspector/TerminalPane"

/** Where a link opens: pages on this computer in a thread's browser tab, other https pages in the system browser. */

let opened: string[] = []

beforeEach(() => {
  opened = []
  const host = createFakeHost()
  setHost({
    ...host,
    openUrl: async (url) => {
      opened.push(url)
    },
  })
  set({ ...defaultState(), runtime: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
})

const errors = (): string[] => get().toasts.filter((toast) => toast.level === "error").map((toast) => toast.text)
const browserTabs = (threadId: string): (string | undefined)[] => panelOf(threadId).tabs.filter((tab) => tab.kind === "browser").map((tab) => tab.url)

describe("a link", () => {
  test("is read whatever case its scheme is in; pages on this computer go to the preview, other https to the browser", () => {
    expect(linkTarget("HTTPS://Example.com/docs")).toEqual({ where: "browser", url: "https://example.com/docs" })
    for (const local of ["http://localhost:5173", "HTTP://LOCALHOST:5173/", "https://127.0.0.1:8443/", "http://[::1]:3000/", "http://app.localhost/"]) expect(linkTarget(local)?.where).toBe("preview")
    for (const refused of ["http://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://me:secret@example.com/", "not a url", ""]) expect(linkTarget(refused)).toBeUndefined()
  })

  test("to an https page opens in the system browser with its scheme as the opener allows it", async () => {
    await openUrl("HTTPS://example.com/docs")
    expect(opened).toEqual(["https://example.com/docs"])
    expect(errors()).toEqual([])
  })

  test("to a dev server opens in the thread's browser tab, not the system browser", async () => {
    const thread = createThread({ projectId: "p1", backend: "claude-code" })
    await openUrl("http://localhost:5173")
    expect(browserTabs(thread.id)).toEqual(["http://localhost:5173/"])
    expect(get().layout.inspectorOpen).toBe(true)
    expect(opened).toEqual([])
  })

  test("that cannot be opened says so instead of doing nothing", async () => {
    await openUrl("http://example.com/")
    await openUrl("ftp://example.com/file")
    set({ layout: { ...get().layout, activeThreadId: undefined } })
    await openUrl("http://localhost:5173")
    await openInBrowser("http://localhost:5173")
    expect(opened).toEqual([])
    expect(errors()).toHaveLength(4)
    expect(errors()[2]).toBe("Open a thread to see http://localhost:5173/ in its browser tab.")
  })

  test("printed in a terminal, OSC 8 included, takes the same way, to that terminal's thread", async () => {
    const thread = createThread({ projectId: "p1", backend: "claude-code", select: false })
    const range = { start: { x: 1, y: 1 }, end: { x: 22, y: 1 } }
    terminalLinks(thread.id).activate({} as MouseEvent, "http://127.0.0.1:4000/app", range)
    terminalLinks(thread.id).activate({} as MouseEvent, "HTTPS://example.com/", range)
    await Promise.resolve()
    expect(browserTabs(thread.id)).toEqual(["http://127.0.0.1:4000/app"])
    expect(opened).toEqual(["https://example.com/"])
  })

  test("the desktop host refuses anything but https out loud, whatever its case", async () => {
    await expect(createTauriHost().openUrl("http://example.com/")).rejects.toMatchObject({ code: "LINK_REFUSED" })
    await expect(createFakeHost().openUrl("http://localhost:5173/")).rejects.toMatchObject({ code: "LINK_REFUSED" })
  })
})
