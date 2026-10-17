import { beforeEach, describe, expect, test } from "bun:test"
import { noteBrowserFrames, takesBrowser } from "../src/app/browserAgent"
import { newPanelTab, panelOf } from "../src/app/panels"
import { defaultState, parseState, type ThreadMeta } from "../src/app/persist"
import { isLocalUrl, usePreviews } from "../src/app/previews"
import { addProject, createThread, get, patchThread, set } from "../src/app/store"
import { getHost, setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { PreviewScript, StreamFrame } from "../src/host/types"

/**
 * The desktop's half of browser use: a request announced by the engine is claimed once, checked
 * against the thread's own switch, carried out on the thread's browser tab, and answered. The
 * host is the in-memory preview host; pages never load.
 */

const PROJECT = "p1"
const ENGINE = "engine-1"
let tasks: Map<string, Record<string, unknown>>
let takes: string[]
let answers: { requestId: string; answer: { ok: boolean; code?: string; result?: { text: string } } }[]
let opened: { tab: string; url: string; hidden: boolean | undefined }[]
let scripts: PreviewScript[]

function use(): void {
  const host = createFakeHost()
  tasks = new Map()
  takes = []
  answers = []
  opened = []
  scripts = []
  const wrapped: Host = {
    ...host,
    rpc: async (engineId, method, params) => {
      const body = params as { requestId: string; answer?: never }
      if (method === "browser.take") {
        takes.push(body.requestId)
        const task = tasks.get(body.requestId)
        tasks.delete(body.requestId)
        if (task === undefined) throw new Error("BROWSER_REQUEST_NOT_FOUND")
        return task
      }
      if (method === "browser.respond") {
        answers.push({ requestId: body.requestId, answer: body.answer as never })
        return { ok: true }
      }
      return host.rpc(engineId, method, params)
    },
    previewOpen: async (tab, url, _bounds, hidden) => {
      opened.push({ tab, url, hidden })
      return { reachable: true }
    },
    previewScript: async (_tab, script) => {
      scripts.push(script)
      return { text: `did ${script.action}` }
    },
  }
  setHost(wrapped)
}

let counter = 0
function request(action: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): { frame: StreamFrame; requestId: string } {
  counter += 1
  const requestId = `br-${counter.toString(16).padStart(32, "0")}`
  tasks.set(requestId, { requestId, action, params, expiresAt: Date.now() + 30_000, ...extra })
  return { requestId, frame: { kind: "live", data: { type: "browser.request", liveSeq: counter, requestId, action } } }
}

async function answered(count: number): Promise<void> {
  for (let tries = 0; tries < 400 && answers.length < count; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(answers).toHaveLength(count)
}

function thread(browser?: ThreadMeta["browser"]): ThreadMeta {
  const created = createThread({ projectId: PROJECT, backend: "native" })
  if (browser !== undefined) patchThread(created.id, { browser })
  return created
}

beforeEach(() => {
  use()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  usePreviews.setState({}, true)
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
})

describe("browser requests", () => {
  test("a request is claimed once, opens out of sight in the thread's browser tab, and is answered", async () => {
    const shown = thread({ agent: true })
    set((state) => ({ layout: { ...state.layout, activeThreadId: shown.id } }))
    const { frame, requestId } = request("open", { url: "http://localhost:5173/app" })
    noteBrowserFrames(shown.id, ENGINE, [frame, frame])
    noteBrowserFrames(shown.id, ENGINE, [frame])
    await answered(1)
    expect(takes).toEqual([requestId])
    expect(answers[0]).toMatchObject({ requestId, answer: { ok: true } })
    expect(answers[0]?.answer.result?.text).toContain("http://localhost:5173/app")
    const tab = panelOf(shown.id).tabs.find((item) => item.kind === "browser")
    expect(tab).toBeDefined()
    expect(opened).toEqual([{ tab: tab!.id, url: "http://localhost:5173/app", hidden: true }])
    expect(usePreviews.getState()[tab!.id]).toMatchObject({ url: "http://localhost:5173/app" })
    expect(usePreviews.getState()[tab!.id]?.opened).toBeNumber()

    // Later actions use the same tab.
    const read = request("snapshot")
    noteBrowserFrames(shown.id, ENGINE, [read.frame])
    await answered(2)
    expect(answers[1]?.answer).toEqual({ ok: true, result: { text: "did snapshot" } })
    expect(panelOf(shown.id).tabs.filter((item) => item.kind === "browser")).toHaveLength(1)

    // The network log is a fixed read, like the console.
    const network = request("network")
    noteBrowserFrames(shown.id, ENGINE, [network.frame])
    await answered(3)
    expect(scripts.at(-1)).toEqual({ action: "network" })
    expect(answers[2]?.answer).toEqual({ ok: true, result: { text: "did network" } })
  })

  test("the thread's own switch decides, not the engine's word", async () => {
    const off = thread()
    const first = request("open", { url: "http://localhost:3000/" }, { anySite: true })
    noteBrowserFrames(off.id, ENGINE, [first.frame])
    await answered(1)
    expect(answers[0]?.answer).toMatchObject({ ok: false, code: "BROWSER_OFF" })

    // The engine claims any site is allowed; the thread allows this computer only.
    const local = thread({ agent: true })
    const urls = ["https://example.com/", "http://user:secret@localhost:3000/", "file:///etc/hosts", "http://10.0.0.5:8080/"]
    for (const url of urls) noteBrowserFrames(local.id, ENGINE, [request("open", { url }, { anySite: true }).frame])
    await answered(1 + urls.length)
    for (const entry of answers.slice(1)) expect(entry.answer).toMatchObject({ ok: false, code: "BROWSER_SITE_REFUSED" })
    expect(opened).toEqual([])
    expect(panelOf(off.id).tabs).toEqual([])
  })

  test("with any site allowed, a web page opens; a page action without a page is refused", async () => {
    const open = thread({ agent: true, anySite: true })
    noteBrowserFrames(open.id, ENGINE, [request("click", { ref: "e1" }).frame])
    await answered(1)
    expect(answers[0]?.answer).toMatchObject({ ok: false, code: "BROWSER_FAILED" })
    expect(scripts).toEqual([])
    noteBrowserFrames(open.id, ENGINE, [request("open", { url: "https://example.com/" }).frame])
    await answered(2)
    expect(answers[1]?.answer.ok).toBe(true)
    noteBrowserFrames(open.id, ENGINE, [request("type", { ref: "e3", text: "hello", submit: true }).frame])
    await answered(3)
    expect(scripts).toEqual([{ action: "type", ref: "e3", text: "hello", submit: true }])
  })

  test("a script the person declines reaches the agent as a refusal", async () => {
    const local = thread({ agent: true })
    noteBrowserFrames(local.id, ENGINE, [request("open", { url: "http://127.0.0.1:4000/" }).frame])
    noteBrowserFrames(local.id, ENGINE, [request("eval", { expression: "document.title" }).frame])
    await answered(2)
    expect(answers[1]?.answer).toMatchObject({ ok: false, code: "BROWSER_DENIED" })
  })

  test("a script the person allows is answered as approved, so the engine takes its result", async () => {
    const local = thread({ agent: true })
    setHost({ ...getHost(), previewEval: async () => ({ text: "Example" }) })
    noteBrowserFrames(local.id, ENGINE, [request("open", { url: "http://127.0.0.1:4000/" }).frame])
    noteBrowserFrames(local.id, ENGINE, [request("eval", { expression: "document.title" }).frame])
    await answered(2)
    expect(answers[1]?.answer).toEqual({ ok: true, approved: true, result: { text: "Example" } } as never)
  })

  test("in a thread not on screen the new tab joins the strip without taking the screen", async () => {
    const background = thread({ agent: true })
    const tasks = newPanelTab(background.id, "tasks")
    set((state) => ({ layout: { ...state.layout, activeThreadId: "elsewhere", inspectorOpen: false } }))
    noteBrowserFrames(background.id, ENGINE, [request("open", { url: "http://localhost:5173/" }).frame])
    await answered(1)
    expect(get().layout.inspectorOpen).toBe(false)
    expect(panelOf(background.id).tabs.map((tab) => tab.kind)).toEqual(["tasks", "browser"])
    expect(panelOf(background.id).active).toBe(tasks)
  })

  test("only Runrail's own loop, Codex, and Claude Code take browser tools", () => {
    expect(takesBrowser("native")).toBe(true)
    expect(takesBrowser("codex")).toBe(true)
    expect(takesBrowser("claude-code")).toBe(true)
    expect(takesBrowser("pi")).toBe(false)
    expect(takesBrowser("copilot")).toBe(false)
    expect(takesBrowser("replay")).toBe(false)
  })
})

describe("what counts as this computer", () => {
  test("localhost, its subdomains, 127.0.0.0/8, and [::1]", () => {
    for (const url of ["http://localhost:5173/", "http://app.localhost/", "http://127.0.0.1:3000/", "http://127.1.2.3/", "http://[::1]:8080/"]) expect(isLocalUrl(new URL(url))).toBe(true)
  })

  test("not names that only look local", () => {
    for (const url of ["http://localhost.example.com/", "http://10.0.0.1/", "http://0.0.0.0:3000/", "http://128.0.0.1/", "https://example.com/", "http://[::2]/"]) expect(isLocalUrl(new URL(url))).toBe(false)
  })
})

describe("saved browser use", () => {
  const saved = (browser: unknown) =>
    parseState({
      version: 1,
      projects: [{ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }],
      threads: [{ id: "t1", projectId: "p1", title: "T", titled: true, createdAt: 1, updatedAt: 1, mode: "agent", permission: "ask", backend: "native", browser }],
      prefs: {},
      layout: {},
    }).threads[0]

  test("on, and on for any site, are kept", () => {
    expect(saved({ agent: true })?.browser).toEqual({ agent: true })
    expect(saved({ agent: true, anySite: true })?.browser).toEqual({ agent: true, anySite: true })
  })

  test("anything else reads as off, and the thread is kept", () => {
    for (const value of [{ agent: false }, { anySite: true }, { agent: "yes" }, "on", 1]) {
      const thread = saved(value)
      expect(thread).toBeDefined()
      expect(thread?.browser).toBeUndefined()
    }
  })
})
