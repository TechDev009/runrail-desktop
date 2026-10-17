import type { ThemedToken } from "shiki/core"
import { langFor, MAX_CODE } from "./highlightLangs"

/**
 * Lazy syntax highlighting, done in a worker so a code block scrolling into view never stalls the
 * window. Results are kept for the most recent blocks, so scrolling back shows them at once. If the
 * worker cannot start, the same engine runs here instead.
 */

type Kind = "html" | "tokens"
type Result<K extends Kind> = K extends "html" ? string : ThemedToken[][]

const MAX_KEPT = 200
const kept = new Map<string, Promise<unknown>>()
/** Finished results by the same key, so a block scrolling back into view paints highlighted. */
const settled = new Map<string, unknown>()
const waiting = new Map<number, (result: unknown) => void>()
let worker: Worker | false | undefined
let nextId = 0
const ANSWER_MS = 5_000

function startWorker(): Worker | false {
  try {
    const started = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
    started.onmessage = (event: MessageEvent<{ readonly id: number; readonly result?: unknown }>) => {
      waiting.get(event.data.id)?.(event.data.result)
      waiting.delete(event.data.id)
    }
    started.onerror = () => {
      // A worker that fails to load answers nothing; what it was asked is done here instead.
      worker = false
      for (const resolve of waiting.values()) resolve(undefined)
      waiting.clear()
      kept.clear()
      settled.clear()
    }
    return started
  } catch {
    return false
  }
}

async function inWindow<K extends Kind>(kind: K, code: string, lang: string): Promise<Result<K> | undefined> {
  const engine = await import("./highlightEngine")
  return (kind === "html" ? engine.renderHtml(code, lang) : engine.renderTokens(code, lang)) as Promise<Result<K> | undefined>
}

function keyOf(kind: Kind, code: string, language: string | undefined): string | undefined {
  const lang = langFor(language)
  return lang === undefined || code.length > MAX_CODE ? undefined : `${kind}\0${lang}\0${code}`
}

function render<K extends Kind>(kind: K, code: string, language: string | undefined): Promise<Result<K> | undefined> {
  const key = keyOf(kind, code, language)
  const lang = langFor(language)
  if (key === undefined || lang === undefined) return Promise.resolve(undefined)
  const hit = kept.get(key)
  if (hit !== undefined) {
    kept.delete(key)
    kept.set(key, hit)
    return hit as Promise<Result<K> | undefined>
  }
  worker ??= typeof Worker === "function" ? startWorker() : false
  const active = worker
  const result: Promise<Result<K> | undefined> =
    active === false
      ? inWindow(kind, code, lang)
      : new Promise((resolve) => {
          const id = (nextId += 1)
          const timer = setTimeout(() => {
            if (!waiting.has(id)) return
            // One worker answers in order, so a grammar stuck on one block would hold every block
            // behind it. That worker goes; the blocks it held show plain, and the next ask starts another.
            if (worker === active) {
              active.terminate()
              worker = undefined
            }
            for (const settle of waiting.values()) settle(undefined)
            waiting.clear()
          }, ANSWER_MS)
          waiting.set(id, (value) => {
            clearTimeout(timer)
            resolve(value as Result<K> | undefined)
          })
          active.postMessage({ id, kind, code, lang })
        })
  kept.set(key, result)
  void result.then((value) => {
    if (value !== undefined && kept.get(key) === result) settled.set(key, value)
  })
  if (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value as string
    kept.delete(oldest)
    settled.delete(oldest)
  }
  return result
}

/** Highlighted HTML whose colors are `var(--syn-*)`; undefined when unsupported. */
export function highlightHtml(code: string, language: string | undefined): Promise<string | undefined> {
  return render("html", code, language)
}

/** The highlighted HTML already made for this code, if any; never starts work. */
export function highlightedHtml(code: string, language: string | undefined): string | undefined {
  const key = keyOf("html", code, language)
  return key === undefined ? undefined : (settled.get(key) as string | undefined)
}

/** The token lines already made for this code, if any; never starts work. */
export function tokenized(code: string, language: string | undefined): ThemedToken[][] | undefined {
  const key = keyOf("tokens", code, language)
  return key === undefined ? undefined : (settled.get(key) as ThemedToken[][] | undefined)
}

/** Token lines for custom renderers (diffs). */
export function tokenize(code: string, language: string | undefined): Promise<ThemedToken[][] | undefined> {
  return render("tokens", code, language)
}

/** A token's inline style: its `var(--syn-*)` color, and italics or bold when the grammar asks. */
export function tokenStyle(token: ThemedToken): { color?: string; fontStyle?: "italic"; fontWeight?: 600 } | undefined {
  const flags = token.fontStyle ?? 0
  if (token.color === undefined && flags <= 0) return undefined
  return { ...(token.color === undefined ? {} : { color: token.color }), ...((flags & 1) !== 0 ? { fontStyle: "italic" as const } : {}), ...((flags & 2) !== 0 ? { fontWeight: 600 as const } : {}) }
}

export { langFor }
export type { ThemedToken }
