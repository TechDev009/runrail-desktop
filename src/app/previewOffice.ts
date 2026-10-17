import { getHost } from "../host"
import { ensureEngine, send } from "./engines"

const STAGGER_MS = 150

/**
 * `?preview=office` in a plain browser: starts each scripted thread's engine, one after another,
 * and sends each its prompt when its time comes, so the office fills itself without a click. A
 * thread whose engine cannot start is left as it is.
 */
export function startPreviewOffice(): void {
  if (typeof window === "undefined" || getHost().kind !== "preview") return
  const loadedAt = Date.now()
  void (async () => {
    // Loaded only in a plain browser: the desktop app's bundle carries none of the scripted host.
    const [{ parsePreviewScenario }, { officeScripts }] = await Promise.all([import("../host/fakeConnections"), import("../host/fakeOffice")])
    const scripts = officeScripts(parsePreviewScenario(new URLSearchParams(window.location.search).get("preview")))
    for (const [threadId, script] of scripts) {
      await new Promise((resolve) => setTimeout(resolve, STAGGER_MS))
      // The next start waits for this one: an engine that is up but idle can be evicted to make room.
      await ensureEngine(threadId).then(
        () => void setTimeout(() => send(threadId, { text: script.prompt }), Math.max(0, script.startAfterMs - (Date.now() - loadedAt))),
        () => undefined,
      )
    }
  })().catch(() => undefined)
}
