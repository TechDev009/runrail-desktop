import { create } from "zustand"
import { getHost } from "../host"
import { HostError } from "../host/types"
import { BackgroundListSchema, BackgroundOutputSchema, hasCapability, parseOr, type BackgroundEntry, type ListeningServer } from "../protocol/schemas"
import type { ParsedFrame } from "../thread/reducer"
import { runtimeOf, useApp } from "./store"

/**
 * Work an agent left running, per thread: subagents and shell commands. The engine owns it and
 * reports each change as a `background.state` frame; `background.list` fills in what happened before
 * the stream attached. Memory only, and it ends with the engine.
 */

export interface ThreadBackground {
  readonly entries: readonly BackgroundEntry[]
  readonly servers?: readonly ListeningServer[]
  readonly serversAvailable?: boolean
}

const NONE: ThreadBackground = { entries: [] }

export const useBackground = create<Readonly<Record<string, ThreadBackground>>>()(() => ({}))

/** The live sequence each entry was last written at, so an older list never overwrites a newer frame. */
const written = new Map<string, Map<string, number>>()

export function backgroundOf(threadId: string | undefined): ThreadBackground {
  return threadId === undefined ? NONE : useBackground.getState()[threadId] ?? NONE
}

/** Shown in Tasks: commands still tied to their turn show in the timeline until they detach. */
export function listed(entry: BackgroundEntry): boolean {
  return !(entry.kind === "command" && entry.status === "running" && entry.foreground === true)
}

export function isRunning(entry: BackgroundEntry): boolean {
  return entry.status === "running" && listed(entry)
}

export function runningCount(background: ThreadBackground): number {
  return background.entries.filter(isRunning).length
}

export function useRunningCount(threadId: string | undefined): number {
  return useBackground((state) => (threadId === undefined ? 0 : runningCount(state[threadId] ?? NONE)))
}

function patch(threadId: string, next: Partial<ThreadBackground>): void {
  useBackground.setState((state) => ({ [threadId]: { ...(state[threadId] ?? NONE), ...next } }))
}

function withEntry(entries: readonly BackgroundEntry[], entry: BackgroundEntry): readonly BackgroundEntry[] {
  const at = entries.findIndex((item) => item.id === entry.id)
  return at < 0 ? [...entries, entry] : entries.map((item, index) => (index === at ? entry : item))
}

/** Takes a batch `parseFrames` already read, as the reducer does. */
export function noteBackgroundFrames(threadId: string, frames: readonly ParsedFrame[]): void {
  let entries: readonly BackgroundEntry[] | undefined
  for (const frame of frames) {
    if (frame.kind === "event") {
      const type = frame.event.type
      if (type === "session.completed" || type === "session.failed" || type === "session.stopped") entries = (entries ?? backgroundOf(threadId).entries).map((entry) => entry.status === "running" && entry.stopHint === "turn" ? { ...entry, status: "stopped", endedAt: Date.now() } : entry)
      continue
    }
    if (frame.kind !== "live") continue
    const live = frame.live
    const seqs = written.get(threadId) ?? new Map<string, number>()
    written.set(threadId, seqs)
    if (live.type === "agent.completed") {
      const completed = live
      entries = (entries ?? backgroundOf(threadId).entries).map((entry) => {
        if (entry.kind !== "agent" || entry.callId !== completed.callId || (seqs.get(entry.id) ?? -1) >= completed.liveSeq) return entry
        seqs.set(entry.id, completed.liveSeq)
        return { ...entry, status: completed.ok ? "completed" : "failed", endedAt: completed.at ?? Date.now() }
      })
      continue
    }
    if (live.type !== "background.state") continue
    if ((seqs.get(live.entry.id) ?? -1) >= live.liveSeq) continue
    seqs.set(live.entry.id, live.liveSeq)
    entries = withEntry(entries ?? backgroundOf(threadId).entries, live.entry)
  }
  if (entries !== undefined) patch(threadId, { entries })
}

function engineOf(threadId: string): string | undefined {
  const runtime = runtimeOf(threadId)
  return runtime.engine === "ready" && hasCapability(runtime.contract, "background") ? runtime.engineId : undefined
}

/** Reads the engine's list without starting an engine; a thread without one has nothing running. */
export async function refreshBackground(threadId: string, options: { readonly servers?: boolean } = {}): Promise<void> {
  const engineId = engineOf(threadId)
  if (engineId === undefined) return
  const result = parseOr(BackgroundListSchema, await getHost().rpc(engineId, "background.list", { servers: options.servers === true }).catch(() => undefined))
  if (result === undefined || runtimeOf(threadId).engineId !== engineId) return
  const seqs = written.get(threadId) ?? new Map<string, number>()
  written.set(threadId, seqs)
  const since = result.lastLiveSeq ?? -1
  const current = new Map(backgroundOf(threadId).entries.map((entry) => [entry.id, entry]))
  // A frame newer than the list wins; an entry the list no longer has was let go by the engine.
  const entries = result.entries.map((entry) => ((seqs.get(entry.id) ?? -1) > since ? current.get(entry.id) ?? entry : entry))
  const kept = [...current.values()].filter((entry) => !result.entries.some((item) => item.id === entry.id) && (seqs.get(entry.id) ?? -1) > since)
  for (const entry of result.entries) if ((seqs.get(entry.id) ?? -1) <= since) seqs.set(entry.id, since)
  patch(threadId, {
    entries: [...entries, ...kept],
    ...(result.servers === undefined ? {} : { servers: result.servers, serversAvailable: result.serversAvailable === true }),
  })
}

export async function stopBackground(threadId: string, id: string): Promise<void> {
  const engineId = engineOf(threadId)
  if (engineId === undefined) return
  await getHost().rpc(engineId, "background.stop", { id })
}

/** Stops everything that can be stopped; answers how many could not be (they end with the turn or stay with their tool). */
export async function stopAllBackground(threadId: string): Promise<{ readonly failed: number; readonly unstoppable: number }> {
  const running = backgroundOf(threadId).entries.filter(isRunning)
  const results = await Promise.allSettled(running.filter((entry) => entry.stoppable).map((entry) => stopBackground(threadId, entry.id)))
  return { failed: results.filter((result) => result.status === "rejected").length, unstoppable: running.filter((entry) => !entry.stoppable).length }
}

export async function readBackgroundOutput(threadId: string, id: string, maxBytes = 65_536): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const engineId = engineOf(threadId)
  if (engineId === undefined) throw new HostError("ENGINE_NOT_RUNNING", "The engine is not running")
  const result = parseOr(BackgroundOutputSchema, await getHost().rpc(engineId, "background.output", { id, maxBytes }))
  if (result === undefined) throw new HostError("BACKGROUND_OUTPUT_UNAVAILABLE", "The output could not be read")
  return { text: result.text, truncated: result.truncated === true }
}

/** Background work lives in its engine: when the engine is gone, so is the work. */
export function initBackground(): () => void {
  return useApp.subscribe((state, previous) => {
    if (state.runtime === previous.runtime && state.threads === previous.threads) return
    // An engine that just came up may already have work running (the window reloaded under it).
    for (const [threadId, runtime] of Object.entries(state.runtime)) {
      const before = previous.runtime[threadId]
      if (runtime.engine === "ready" && (before?.engine !== "ready" || before.instance !== runtime.instance)) void refreshBackground(threadId)
    }
    const known = Object.keys(useBackground.getState())
    if (known.length === 0) return
    const threads = new Set(state.threads.map((thread) => thread.id))
    const gone = new Set(
      known.filter((threadId) => {
        const runtime = state.runtime[threadId]
        return runtime === undefined || runtime.engine !== "ready" || runtime.engineId !== previous.runtime[threadId]?.engineId || !threads.has(threadId)
      }),
    )
    if (gone.size === 0) return
    for (const threadId of gone) written.delete(threadId)
    useBackground.setState((current) => Object.fromEntries(Object.entries(current).filter(([threadId]) => !gone.has(threadId))), true)
  })
}
