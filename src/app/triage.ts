import { useSyncExternalStore } from "react"
import { create } from "zustand"
import { useActivity } from "./activity"
import { waitingItems, type WaitingItem } from "./attention"
import { isRunning, useBackground } from "./background"
import { cancel, resolveApproval } from "./engines"
import { isQuestion } from "../thread/reducer"
import { markThreadRead } from "./inbox"
import { get, openThread, patchThread, useApp } from "./store"

/** The tray: whether it is open, the quiet threads already seen, and what its actions do. */

interface TrayState {
  readonly open: boolean
  readonly quietSeen: Readonly<Record<string, number>>
}

export const useTray = create<TrayState>()(() => ({ open: false, quietSeen: {} }))

/** A quiet thread can cross its threshold with no event at all, so the list is re-read this often. */
const QUIET_TICK_MS = 15_000

export function setTrayOpen(open: boolean): void {
  if (useTray.getState().open !== open) useTray.setState({ open })
}

export function readWaiting(now = Date.now()): readonly WaitingItem[] {
  const state = get()
  const agents = new Set<string>()
  for (const [threadId, background] of Object.entries(useBackground.getState())) if (background.entries.some((entry) => entry.kind === "agent" && isRunning(entry))) agents.add(threadId)
  return waitingItems({
    threads: state.threads,
    runtime: state.runtime,
    activity: useActivity.getState(),
    agentsRunning: agents,
    quietMs: state.prefs.quietMinutes * 60_000,
    acknowledged: useTray.getState().quietSeen,
    now,
  })
}

let cached: { readonly signature: string; readonly items: readonly WaitingItem[] } = { signature: "", items: [] }

// The app store changes on every streamed frame; the list keeps its identity until what it shows changes.
function snapshot(): readonly WaitingItem[] {
  const items = readWaiting()
  const signature = items.map((item) => `${item.key}@${String(item.since)}:${item.title}:${item.tool?.key ?? ""}`).join("|")
  if (signature !== cached.signature) cached = { signature, items }
  return cached.items
}

function subscribe(listener: () => void): () => void {
  const stops = [useApp.subscribe(listener), useActivity.subscribe(listener), useBackground.subscribe(listener), useTray.subscribe(listener)]
  const timer = setInterval(listener, QUIET_TICK_MS)
  return () => {
    for (const stop of stops) stop()
    clearInterval(timer)
  }
}

export function useWaiting(): readonly WaitingItem[] {
  return useSyncExternalStore(subscribe, snapshot)
}

export async function approve(item: WaitingItem, session = false): Promise<void> {
  // Approving a question would send no answers; it opens where it can be answered instead.
  if (item.approval !== undefined && isQuestion(item.approval)) return openWaiting(item)
  if (item.approval === undefined) return
  await resolveApproval(item.threadId, item.approval.approvalId, true, undefined, session ? "session" : undefined)
}

export async function deny(item: WaitingItem, feedback?: string): Promise<void> {
  if (item.approval === undefined) return
  const reason = feedback?.trim()
  await resolveApproval(item.threadId, item.approval.approvalId, false, reason === undefined || reason.length === 0 ? undefined : reason)
}

export function openWaiting(item: WaitingItem): void {
  setTrayOpen(false)
  openThread(item.threadId)
}

/** A finished or failed turn is marked read; a quiet thread is set aside until it next sends something. */
export function dismissWaiting(item: WaitingItem): void {
  if (item.kind === "quiet") {
    useTray.setState((state) => ({ quietSeen: { ...state.quietSeen, [item.threadId]: item.since } }))
    return
  }
  if (item.kind === "approval") return
  markThreadRead(item.threadId)
  patchThread(item.threadId, { unread: false })
}

export function stopQuiet(item: WaitingItem): void {
  void cancel(item.threadId)
}
