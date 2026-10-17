import { create } from "zustand"

/**
 * Content-free diagnostics for the developer panel: stable codes and counters only. Nothing
 * here holds prompts, paths, payloads, or messages, and nothing is persisted.
 */

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/
const MAX_CODES = 128

/** How long a thread's engine took to open, step by step: step names and numbers only. */
export interface OpenTiming {
  readonly backend: string
  readonly steps: readonly (readonly [string, number])[]
  readonly totalMs: number
  /** Timeline items on screen once open. */
  readonly items: number
  readonly at: number
}

/** From a thread being chosen to the frame that drew its history: "first" when the history had to load. */
export interface PaintTiming {
  readonly kind: "first" | "revisit"
  readonly ms: number
  readonly items: number
  readonly at: number
}

export interface Diagnostics {
  readonly startedAt: number
  readonly counters: Readonly<Record<string, number>>
  readonly lastCodes: readonly { readonly code: string; readonly at: number }[]
  readonly opens: readonly OpenTiming[]
  readonly paints: readonly PaintTiming[]
}

const MAX_OPENS = 20

export const useDiagnostics = create<Diagnostics>(() => ({ startedAt: Date.now(), counters: {}, lastCodes: [], opens: [], paints: [] }))

/** Increments a counter such as "engine.start" or "rpc.error.ENGINE_NOT_RUNNING". */
export function bump(code: string, by = 1): void {
  if (!CODE.test(code)) return
  useDiagnostics.setState((state) => {
    if (state.counters[code] === undefined && Object.keys(state.counters).length >= MAX_CODES) return state
    return { counters: { ...state.counters, [code]: (state.counters[code] ?? 0) + by } }
  })
}

/** Records an error code (never a message) in a short ring for the developer panel. */
export function recordError(code: string): void {
  if (!CODE.test(code)) return
  bump(`error.${code}`)
  useDiagnostics.setState((state) => ({ lastCodes: [{ code, at: Date.now() }, ...state.lastCodes].slice(0, 20) }))
}

export function resetDiagnostics(): void {
  useDiagnostics.setState({ startedAt: Date.now(), counters: {}, lastCodes: [], opens: [], paints: [] })
  chosen = undefined
  watched = undefined
}

export function noteOpen(timing: OpenTiming): void {
  useDiagnostics.setState((state) => ({ opens: [timing, ...state.opens].slice(0, MAX_OPENS) }))
}

/** Marks the end of each step since the last mark; `steps` and `total` read them back in milliseconds. */
export function stepClock(now: () => number = () => performance.now()): { readonly mark: (name: string) => void; readonly steps: () => readonly (readonly [string, number])[]; readonly total: () => number } {
  const started = now()
  let last = started
  const steps: (readonly [string, number])[] = []
  return {
    mark: (name) => {
      const at = now()
      steps.push([name, Math.round(at - last)])
      last = at
    },
    steps: () => steps.slice(),
    total: () => Math.round(last - started),
  }
}

/** A chosen thread is timed from the click when there was one this recently, else from when it was shown. */
const CLICK_WINDOW_MS = 1_000

let chosen: { readonly threadId: string; readonly at: number } | undefined
let watched: { readonly threadId: string; readonly at: number; readonly loaded: boolean } | undefined

export function noteThreadChosen(threadId: string, now = performance.now()): void {
  chosen = { threadId, at: now }
}

/** The thread is on screen; `loaded` says whether its history already was. */
export function watchPaint(threadId: string, loaded: boolean, now = performance.now()): void {
  const click = chosen?.threadId === threadId && now - chosen.at <= CLICK_WINDOW_MS ? chosen.at : now
  chosen = undefined
  watched = { threadId, at: click, loaded }
}

/** Its history is in the timeline: the time is taken once the frame that draws it has painted. */
export function notePainted(threadId: string, items: number, afterPaint: (done: () => void) => void = nextPaint, now = () => performance.now()): void {
  const pending = watched
  if (pending?.threadId !== threadId) return
  watched = undefined
  afterPaint(() => {
    const timing: PaintTiming = { kind: pending.loaded ? "revisit" : "first", ms: Math.round(now() - pending.at), items, at: Date.now() }
    useDiagnostics.setState((state) => ({ paints: [timing, ...state.paints].slice(0, MAX_OPENS) }))
  })
}

function nextPaint(done: () => void): void {
  requestAnimationFrame(() => setTimeout(done, 0))
}
