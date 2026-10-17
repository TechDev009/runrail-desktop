import { beforeEach, describe, expect, test } from "bun:test"
import { ARTBOARD_GAP, ARTBOARD_HEAD, ARTBOARDS, artboardLayout, artboardOf, artboardTab, setArtboards, useArtboards } from "../src/app/artboards"
import { noteBrowserFrames } from "../src/app/browserAgent"
import { addPageComment, pageCommentsBlock, startPicking, usePageComments, usePicking } from "../src/app/pageComments"
import { closePanelTab, newPanelTab } from "../src/app/panels"
import { defaultState } from "../src/app/persist"
import { openArtboard, patchPreview, usePreviews } from "../src/app/previews"
import { addProject, createThread, patchThread, set } from "../src/app/store"
import { setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { StreamFrame } from "../src/host/types"

/** A browser tab's page at phone, tablet, and desktop widths side by side. */

const PROJECT = "p1"
const ENGINE = "engine-1"
const URL_HERE = "http://localhost:5173/"
let opened: { tab: string; url: string; hidden: boolean | undefined }[]
let closed: string[]
let shots: { tab: string; width: number | undefined }[]
let tasks: Map<string, Record<string, unknown>>
let answers: { ok: boolean; result?: { text: string } }[]

function use(native: boolean): void {
  const host = createFakeHost()
  opened = []
  closed = []
  shots = []
  tasks = new Map()
  answers = []
  const wrapped: Host = {
    ...host,
    previewNative: native,
    rpc: async (engineId, method, params) => {
      const body = params as { requestId: string; answer?: never }
      if (method === "browser.take") {
        const task = tasks.get(body.requestId)
        tasks.delete(body.requestId)
        if (task === undefined) throw new Error("BROWSER_REQUEST_NOT_FOUND")
        return task
      }
      if (method === "browser.respond") {
        answers.push(body.answer as never)
        return { ok: true }
      }
      return host.rpc(engineId, method, params)
    },
    previewOpen: async (tab, url, _bounds, hidden) => {
      opened.push({ tab, url, hidden })
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { reachable: true }
    },
    previewClose: async (tab) => {
      closed.push(tab)
    },
    previewScreenshot: async (tab, _anySite, width) => {
      shots.push({ tab, width })
      return { mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }
    },
  }
  setHost(wrapped)
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  usePreviews.setState({}, true)
  useArtboards.setState({}, true)
  usePicking.setState({}, true)
  usePageComments.setState({}, true)
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
}

let counter = 0
function ask(threadId: string, action: string, params: Record<string, unknown> = {}): void {
  counter += 1
  const requestId = `br-${(0xab00_0000 + counter).toString(16).padStart(32, "0")}`
  tasks.set(requestId, { requestId, action, params, expiresAt: Date.now() + 30_000 })
  const frame: StreamFrame = { kind: "live", data: { type: "browser.request", liveSeq: counter, requestId, action } }
  noteBrowserFrames(threadId, ENGINE, [frame])
}

async function answered(count: number): Promise<void> {
  for (let tries = 0; tries < 2_000 && answers.length < count; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(answers).toHaveLength(count)
}

/** A thread whose agent may use the browser, with a page loaded in its browser tab. */
function pageOpen(): { readonly threadId: string; readonly tab: string } {
  const thread = createThread({ projectId: PROJECT, backend: "native" })
  patchThread(thread.id, { browser: { agent: true } })
  const tab = newPanelTab(thread.id, "browser", URL_HERE)!
  patchPreview(tab, { url: URL_HERE, unloaded: false, loading: false })
  return { threadId: thread.id, tab }
}

describe("the layout", () => {
  test("one scale for all three, never above 1, side by side under their names", () => {
    const wide = artboardLayout({ width: 5_000, height: 2_000 })
    expect(wide.scale).toBe(1)
    expect(wide.places.map((place) => [place.width, place.height])).toEqual(ARTBOARDS.map((artboard) => [artboard.width, artboard.height]))
    // Centred: the room left over is split either side.
    const used = 390 + 820 + 1280 + ARTBOARD_GAP * 2
    expect(wide.places[0]?.x).toBe(Math.round((5_000 - used) / 2))

    const panel = artboardLayout({ width: 900, height: 700 })
    expect(panel.scale).toBeCloseTo((900 - ARTBOARD_GAP * 2) / (390 + 820 + 1280), 6)
    for (const place of panel.places) expect(place.y).toBe(ARTBOARD_HEAD)
    const [phone, tablet, desktop] = panel.places
    expect(tablet!.x).toBeGreaterThanOrEqual(phone!.x + phone!.width + ARTBOARD_GAP - 1)
    expect(desktop!.x + desktop!.width).toBeLessThanOrEqual(901)

    // A short panel scales by its height instead.
    const short = artboardLayout({ width: 5_000, height: 400 })
    expect(short.scale).toBeCloseTo((400 - ARTBOARD_HEAD) / 1_180, 6)
  })

  test("each artboard is a preview of its own, named after its browser tab", () => {
    expect(artboardTab("tab-1", "tablet")).toBe("tab-1.tablet")
    expect(artboardOf("tab-1.tablet")).toEqual({ tab: "tab-1", artboard: ARTBOARDS[1]! })
    expect(artboardOf("tab-1")).toBeUndefined()
    expect(artboardOf("tab-1.watch")).toBeUndefined()
    expect(artboardOf(".phone")).toBeUndefined()
  })
})

describe("the agent", () => {
  beforeEach(() => use(true))

  test("looks at the page at a width on that artboard, which the tab then shows", async () => {
    const { threadId, tab } = pageOpen()
    ask(threadId, "screenshot", { width: "phone" })
    await answered(1)
    expect(opened).toEqual([{ tab: `${tab}.phone`, url: URL_HERE, hidden: true }])
    expect(shots).toEqual([{ tab: `${tab}.phone`, width: 390 }])
    expect(answers[0]?.result?.text).toBe("The page laid out 390 px wide (phone).")
    expect(useArtboards.getState()[tab]).toBe(true)
    expect(usePreviews.getState()[`${tab}.phone`]).toMatchObject({ url: URL_HERE, unloaded: false })

    // Already loaded at the tab's address: no second load. Without a width, the tab's own page.
    ask(threadId, "screenshot", { width: "phone" })
    ask(threadId, "screenshot")
    await answered(3)
    expect(opened).toHaveLength(1)
    expect(shots.slice(1)).toEqual([
      { tab: `${tab}.phone`, width: 390 },
      { tab, width: undefined },
    ])
  })

  test("its box on screen and the agent asking for the same address share one load", async () => {
    const both = await Promise.all([openArtboard("tab-1.desktop", URL_HERE, { x: 10, y: 10, width: 400, height: 250 }, undefined), openArtboard("tab-1.desktop", URL_HERE, null, undefined)])
    expect(both).toEqual([true, true])
    expect(opened).toEqual([{ tab: "tab-1.desktop", url: URL_HERE, hidden: false }])
    await openArtboard("tab-1.desktop", "http://localhost:5173/next", null, undefined)
    expect(opened).toHaveLength(2)
  })

  test("closing the browser tab closes its artboards' pages too", () => {
    const { threadId, tab } = pageOpen()
    setArtboards(tab, true)
    patchPreview(`${tab}.tablet`, { url: URL_HERE })
    closePanelTab(threadId, tab)
    expect(closed).toEqual([tab, `${tab}.phone`, `${tab}.tablet`, `${tab}.desktop`])
    expect(useArtboards.getState()[tab]).toBeUndefined()
    expect(usePreviews.getState()[`${tab}.tablet`]).toBeUndefined()
  })
})

describe("comments", () => {
  beforeEach(() => use(false))

  test("an element picked on an artboard says the width it was seen at", async () => {
    await startPicking("t1", "tab-1.tablet")
    const picked = usePicking.getState().picked
    expect(picked).toMatchObject({ tab: "tab-1.tablet", width: 820, name: "Sign up" })
    addPageComment("t1", picked!, "too wide here")
    await startPicking("t1", "tab-1")
    addPageComment("t1", usePicking.getState().picked!, "fine")
    const block = pageCommentsBlock(usePageComments.getState().t1 ?? [])
    expect(block).toContain("   Selector: main > form.signup > button.primary\n   Seen with the page 820 px wide\n   Comment: too wide here")
    expect(block).not.toContain("px wide\n   Comment: fine")
  })
})
