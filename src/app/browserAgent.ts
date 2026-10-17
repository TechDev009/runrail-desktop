import { getHost, toHostError } from "../host"
import type { BackendId, StreamFrame } from "../host/types"
import { BrowserTaskSchema, LiveFrameSchema, parseOr, type BrowserTask } from "../protocol/schemas"
import { ARTBOARDS, artboardTab, setArtboards } from "./artboards"
import { activeTab, newPanelTab, panelOf, setPanelUrl } from "./panels"
import { isLocalUrl, openArtboard, patchPreview, usePreviews } from "./previews"
import { signInProject } from "./signIns"
import { get, threadById, toast } from "./store"

/**
 * The agent's hands in the browser preview. The engine announces a request by id; this claims it
 * once, checks it against the thread's own switch (never the engine's word), acts on the agent's
 * browser tab, and answers. Requests run one at a time per thread. Nothing here is kept on disk.
 */

type Answer = { readonly ok: true; readonly approved?: true; readonly result: { readonly text: string; readonly image?: { readonly mediaType: string; readonly dataBase64: string } } } | { readonly ok: false; readonly code: string; readonly message: string }

const LOAD_TIMEOUT_MS = 15_000
const SETTLE_MS = 400
/** Request ids already seen, so a replayed frame is not claimed again. Bounded. */
const seen = new Set<string>()
const queues = new Map<string, Promise<void>>()
/** The tab the agent last used in each thread. Memory only; a reload starts from the tab on screen. */
const agentTabs = new Map<string, string>()
const noticed = new Set<string>()

const refuse = (code: string, message: string): Answer => ({ ok: false, code, message })

/** The agents the engine can hand browser tools to. */
export function takesBrowser(backend: BackendId): boolean {
  return backend === "native" || backend === "codex" || backend === "claude-code"
}

export function noteBrowserFrames(threadId: string, engineId: string, frames: readonly StreamFrame[]): void {
  for (const frame of frames) {
    const type = frame.kind === "event" ? undefined : (frame.data as { readonly type?: unknown } | null)?.type
    if (type !== "browser.request" && type !== "browser.notice") continue
    const parsed = LiveFrameSchema.safeParse(frame.data)
    if (!parsed.success) continue
    if (parsed.data.type === "browser.notice") {
      const key = `${engineId}:${parsed.data.sessionId}`
      if (noticed.has(key)) continue
      noticed.add(key)
      toast("info", "This Codex conversation started without browser tools, so Codex cannot use the browser here. Start a new thread to let it.")
      continue
    }
    if (parsed.data.type !== "browser.request" || seen.has(parsed.data.requestId)) continue
    seen.add(parsed.data.requestId)
    if (seen.size > 512) seen.delete(seen.values().next().value as string)
    const requestId = parsed.data.requestId
    const previous = queues.get(threadId) ?? Promise.resolve()
    const next = previous.then(() => handle(threadId, engineId, requestId)).catch(() => undefined)
    queues.set(threadId, next)
    void next.finally(() => {
      if (queues.get(threadId) === next) queues.delete(threadId)
    })
  }
}

async function handle(threadId: string, engineId: string, requestId: string): Promise<void> {
  const host = getHost()
  let task: BrowserTask | undefined
  try {
    task = parseOr(BrowserTaskSchema, await host.rpc(engineId, "browser.take", { requestId }))
  } catch {
    // Already claimed, expired, or the engine is gone: nothing to answer.
    return
  }
  if (task === undefined) return
  let answer: Answer
  try {
    answer = await act(threadId, task)
  } catch (error) {
    const failure = toHostError(error)
    answer = refuse(failure.code === "BROWSER_SITE_REFUSED" ? "BROWSER_SITE_REFUSED" : "BROWSER_FAILED", failure.message.slice(0, 500))
  }
  await host.rpc(engineId, "browser.respond", { requestId, answer }).catch(() => undefined)
}

/** The thread's browser tab for the agent: the one it used last, the one on screen, or a new one. */
function agentTab(threadId: string, create: boolean): string | undefined {
  const panel = panelOf(threadId)
  const browsers = panel.tabs.filter((tab) => tab.kind === "browser")
  const last = agentTabs.get(threadId)
  const chosen = browsers.find((tab) => tab.id === last) ?? (activeTab(panel)?.kind === "browser" ? activeTab(panel) : undefined) ?? browsers[browsers.length - 1]
  if (chosen !== undefined) {
    agentTabs.set(threadId, chosen.id)
    return chosen.id
  }
  if (!create) return undefined
  // In the thread on screen the new tab shows; elsewhere the panel is left as the person set it.
  const created = newPanelTab(threadId, "browser", undefined, { show: get().layout.activeThreadId === threadId })
  if (created !== undefined) agentTabs.set(threadId, created)
  return created
}

function allowed(url: string, anySite: boolean): Answer | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return refuse("BROWSER_FAILED", "The page's address could not be read.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return refuse("BROWSER_SITE_REFUSED", "The browser opens http and https pages only.")
  if (parsed.username !== "" || parsed.password !== "") return refuse("BROWSER_SITE_REFUSED", "Addresses with a user name or password are not opened.")
  if (!anySite && !isLocalUrl(parsed)) return refuse("BROWSER_SITE_REFUSED", "This thread lets the agent use pages on this computer only (localhost). The person can allow other sites in the browser tab.")
  return undefined
}

/**
 * Runs `start`, then waits for the page load it began: `load` always starts one, `maybe` (a click,
 * a key) might, `none` did not. False when the load was still going at the timeout.
 */
function loaded(tab: string, start: () => Promise<"load" | "maybe" | "none">): Promise<boolean> {
  const native = getHost().previewNative
  return new Promise((resolve, reject) => {
    let sawLoading = false
    let finished = false
    let settle: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      finished = true
      unsubscribe()
      clearTimeout(timer)
      clearTimeout(settle)
    }
    const finish = (value: boolean): void => {
      if (finished) return
      stop()
      resolve(value)
    }
    const unsubscribe = usePreviews.subscribe((state) => {
      const page = state[tab]
      if (page?.loading === true) sawLoading = true
      else if (sawLoading && page?.loading === false) finish(true)
    })
    const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS)
    start().then(
      (kind) => {
        if (!native || kind === "none") finish(true)
        else if (kind === "maybe")
          settle = setTimeout(() => {
            if (!sawLoading) finish(true)
          }, SETTLE_MS)
      },
      (error: unknown) => {
        if (finished) return
        stop()
        reject(error)
      },
    )
  })
}

/** Waits, up to the load timeout, until the tab's page is not loading. */
function settled(tab: string): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      unsubscribe()
      clearTimeout(timer)
      resolve()
    }
    const unsubscribe = usePreviews.subscribe((state) => {
      if (state[tab]?.loading !== true) done()
    })
    const timer = setTimeout(done, LOAD_TIMEOUT_MS)
    if (usePreviews.getState()[tab]?.loading !== true) done()
  })
}

const OFFSCREEN = { x: 0, y: 0, width: 1, height: 1 }

async function act(threadId: string, task: BrowserTask): Promise<Answer> {
  const host = getHost()
  const thread = threadById(threadId)
  if (thread?.browser?.agent !== true) return refuse("BROWSER_OFF", "The person has turned off browser use for this thread. They can turn it on in the browser tab.")
  const anySite = thread.browser.anySite === true
  const params = task.params
  if (task.action === "open") {
    const url = typeof params.url === "string" ? params.url : ""
    const refused = allowed(url, anySite)
    if (refused !== undefined) return refused
    const tab = agentTab(threadId, true)
    if (tab === undefined) return refuse("BROWSER_FAILED", "The side panel has no room for another browser tab. The person can close one.")
    let reachable = true
    const done = await loaded(tab, async () => {
      // Hidden: the tab, when on screen, places the page itself once it sees the agent opened it.
      reachable = (await host.previewOpen(tab, url, OFFSCREEN, true, signInProject(threadId))).reachable
      if (!reachable) return "none"
      setPanelUrl(threadId, tab, url)
      patchPreview(tab, { url, unloaded: false, opened: Date.now(), agentAt: Date.now() })
      return "load"
    })
    if (!reachable) return refuse("BROWSER_FAILED", `Nothing answers at ${new URL(url).host}. Is the server running?`)
    const page = usePreviews.getState()[tab]
    const title = page?.title !== undefined && page.title.length > 0 ? ` - "${page.title}"` : ""
    return { ok: true, result: { text: `${done ? "Opened" : "Still loading"} ${page?.url ?? url}${title}.` } }
  }
  const tab = agentTab(threadId, false)
  if (tab === undefined) return refuse("BROWSER_FAILED", "No page is open. Use browser_open first.")
  const current = usePreviews.getState()[tab]?.url ?? panelOf(threadId).tabs.find((item) => item.id === tab)?.url
  if (current === undefined) return refuse("BROWSER_FAILED", "No page is open. Use browser_open first.")
  const refused = allowed(current, anySite)
  if (refused !== undefined) return refused
  // A page closed to make room, or never loaded since a restart, loads again out of sight first.
  const page = usePreviews.getState()[tab]
  if (host.previewNative && (page === undefined || page.unloaded)) {
    await loaded(tab, async () => {
      if (!(await host.previewOpen(tab, current, OFFSCREEN, true, signInProject(threadId))).reachable) return "none"
      patchPreview(tab, { url: current, unloaded: false, opened: Date.now() })
      return "load"
    })
  }
  patchPreview(tab, { agentAt: Date.now() })
  switch (task.action) {
    case "screenshot": {
      const artboard = ARTBOARDS.find((entry) => entry.id === params.width)
      if (artboard === undefined) return { ok: true, result: { text: "", image: await host.previewScreenshot(tab, anySite) } }
      // At a width: the tab shows its artboards, so the person sees what the agent looks at.
      const art = artboardTab(tab, artboard.id)
      setArtboards(tab, true)
      const kept = usePreviews.getState()[art]
      if (host.previewNative && (kept?.url !== current || kept.unloaded)) {
        let reachable = true
        await loaded(art, async () => {
          reachable = await openArtboard(art, current, null, signInProject(threadId))
          return reachable ? "maybe" : "none"
        })
        if (!reachable) return refuse("BROWSER_FAILED", `Nothing answers at ${new URL(current).host}. Is the server running?`)
        // Room for the artboard on screen to take its place and scale.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      }
      await settled(art)
      const image = await host.previewScreenshot(art, anySite, artboard.width)
      return { ok: true, result: { text: `The page laid out ${String(artboard.width)} px wide (${artboard.label.toLowerCase()}).`, image } }
    }
    case "eval":
      try {
        // The host ran it only after the person allowed this script in its own dialog.
        return { ok: true, approved: true, result: await host.previewEval(tab, typeof params.expression === "string" ? params.expression : "", anySite) }
      } catch (error) {
        const failure = toHostError(error)
        if (failure.code === "PREVIEW_DENIED") return refuse("BROWSER_DENIED", "The person declined to run the script.")
        throw failure
      }
    case "snapshot":
    case "console":
    case "network":
      return { ok: true, result: await host.previewScript(tab, { action: task.action }, anySite) }
    case "click":
    case "type":
    case "press": {
      const script =
        task.action === "click"
          ? { action: "click" as const, ref: String(params.ref) }
          : task.action === "type"
            ? { action: "type" as const, ref: String(params.ref), text: String(params.text), ...(params.submit === true ? { submit: true } : {}) }
            : { action: "press" as const, key: String(params.key) }
      let result = { text: "" }
      // A click or a key may start loading another page; the answer waits for it.
      await loaded(tab, async () => {
        result = await host.previewScript(tab, script, anySite)
        return "maybe"
      })
      const after = usePreviews.getState()[tab]?.url
      return { ok: true, result: { text: after !== undefined && after !== current ? `${result.text} The page is now ${after}.` : result.text } }
    }
  }
}
