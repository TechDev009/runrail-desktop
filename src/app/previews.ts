import { create } from "zustand"
import { getHost } from "../host"
import type { PreviewBounds, PreviewState } from "../host/types"
import { artboardOf } from "./artboards"
import { setPanelUrl } from "./panels"
import { get } from "./store"

/** Whether an address is on this computer: `localhost`, `*.localhost`, `127.0.0.0/8`, or `[::1]`. */
export function isLocalUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true
  const parts = host.split(".")
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * What each browser tab's page is doing, as the host reports it. Memory only: the address a tab
 * reopens at is kept in the panel state, as origin and path.
 */

export interface PreviewView {
  readonly url?: string
  readonly title?: string
  readonly loading: boolean
  /** The page was closed to make room for others; showing its tab loads it again. */
  readonly unloaded: boolean
  /** When the agent last loaded a page here, so a tab on screen shows it instead of its own. */
  readonly opened?: number
  /** When the agent last acted on this page; the tab shows that it is in use. */
  readonly agentAt?: number
}

export const usePreviews = create<Readonly<Record<string, PreviewView>>>()(() => ({}))

export function patchPreview(tab: string, patch: Partial<PreviewView>): void {
  usePreviews.setState((state) => ({ [tab]: { ...(state[tab] ?? { loading: false, unloaded: false }), ...patch } }))
}

const artboardLoads = new Map<string, { readonly url: string; readonly done: Promise<boolean> }>()

/**
 * Loads an artboard's page once, whoever asks first: its box on screen, or the agent out of sight
 * (null bounds). Both asking for one address share one load. True when something answered.
 */
export function openArtboard(previewTab: string, url: string, bounds: PreviewBounds | null, project: string | undefined): Promise<boolean> {
  const pending = artboardLoads.get(previewTab)
  if (pending?.url === url) return pending.done
  const done = getHost()
    .previewOpen(previewTab, url, bounds ?? { x: 0, y: 0, width: 1, height: 1 }, bounds === null, project)
    .then((result) => {
      if (result.reachable) patchPreview(previewTab, { url, unloaded: false })
      return result.reachable
    })
    .finally(() => {
      if (artboardLoads.get(previewTab)?.done === done) artboardLoads.delete(previewTab)
    })
  artboardLoads.set(previewTab, { url, done })
  return done
}

export function dropPreview(tab: string): void {
  usePreviews.setState((state) => {
    const { [tab]: _gone, ...rest } = state
    return rest
  }, true)
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|(?:[a-z0-9-]+\.)+localhost)(?::\d{1,5})?(?=[/?#]|$)/i
const NAMED_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?=[/?#]|$)/i

/**
 * Turns what the person typed into an address: `5173` and `localhost:5173` mean http on this
 * computer, a bare domain means https. Anything with a scheme is left as typed, so the host's own
 * policy refuses what it must. Undefined when it is not an address at all.
 */
export function typedAddress(input: string): string | undefined {
  const text = input.trim()
  if (text.length === 0 || text.length > 2_048 || /\s/.test(text)) return undefined
  let candidate: string | undefined
  if (/^\d{2,5}$/.test(text)) candidate = `http://localhost:${text}`
  else if (/^:\d{2,5}(?=[/?#]|$)/.test(text)) candidate = `http://localhost${text}`
  else if (LOCAL_HOST.test(text)) candidate = `http://${text}`
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:javascript|data|blob|about|file|mailto):/i.test(text)) candidate = text
  else if (NAMED_HOST.test(text)) candidate = `https://${text}`
  if (candidate === undefined) return undefined
  try {
    return new URL(candidate).href
  } catch {
    return undefined
  }
}

/** The thread whose browser tab this is; an artboard belongs to its browser tab's thread. */
function ownerOf(tab: string): string | undefined {
  const own = artboardOf(tab)?.tab ?? tab
  for (const [threadId, panel] of Object.entries(get().layout.panels)) if (panel.tabs.some((item) => item.id === own && item.kind === "browser")) return threadId
  return undefined
}

function applyState(state: PreviewState): void {
  const threadId = ownerOf(state.tab)
  if (threadId === undefined) {
    void getHost().previewClose(state.tab).catch(() => undefined)
    return
  }
  patchPreview(state.tab, {
    ...(state.url === undefined ? {} : { url: state.url }),
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.loading === undefined ? {} : { loading: state.loading }),
    unloaded: state.unloaded === true,
  })
  // The tab reopens at its own address; an artboard's follows it.
  if (state.url !== undefined && artboardOf(state.tab) === undefined) setPanelUrl(threadId, state.tab, state.url)
}

export function initPreviews(): () => void {
  const host = getHost()
  // Pages left from before the window reloaded are closed; their tabs load again when shown.
  void host.previewRetain([]).catch(() => undefined)
  return host.onPreview(applyState)
}
