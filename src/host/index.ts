import { createTauriHost } from "./tauriHost"
import type { Host } from "./types"

let host: Host | undefined

function inDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Picks the host before the app runs: the Tauri host inside the desktop shell, a scripted preview
 * host in a plain browser. The preview host is its own chunk, so the desktop app never loads it.
 */
export async function initHost(): Promise<Host> {
  if (host !== undefined) return host
  if (inDesktopShell()) return (host = createTauriHost())
  const [{ createFakeHost }, { parsePreviewScenario }] = await Promise.all([import("./fakeHost"), import("./fakeConnections")])
  // In a plain browser, `?preview=empty,port-busy` picks which states the scripted host shows.
  host ??= createFakeHost(parsePreviewScenario(typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("preview")))
  return host
}

/** The host `initHost` picked, or the one a test set. */
export function getHost(): Host {
  if (host !== undefined) return host
  if (inDesktopShell()) return (host = createTauriHost())
  throw new Error("getHost before initHost: the preview host has not loaded")
}

export function setHost(value: Host): void {
  host = value
}

export * from "./types"
