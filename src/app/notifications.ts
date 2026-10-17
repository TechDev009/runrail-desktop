import { create } from "zustand"
import { getHost, type NotifyStatus } from "../host"
import { playTone, type Tone } from "../lib/tones"
import type { Prefs } from "./persist"
import { get, openThread, set, threadById, threadOnScreen, toast, useApp } from "./store"
import { asksQuestion } from "../thread/reducer"
import { pushToPhones } from "./phonePush"

/**
 * Telling the person a thread finished, failed, or needs approval: a note in the window, a macOS
 * notification, and a tone, each by its own setting. A click on a macOS notification opens the
 * thread; opening a thread clears its notifications from Notification Center.
 */

export type NoteKind = "finished" | "failed" | "approval"

const BODY: Readonly<Record<NoteKind, string>> = {
  finished: "Finished",
  failed: "Stopped with an error",
  approval: "Needs your approval",
}

const TONES: Readonly<Record<NoteKind, Tone>> = { finished: "done", failed: "attention", approval: "raise" }

export const useNotifyStatus = create<{ readonly status?: NotifyStatus }>(() => ({}))

export function wants(prefs: Prefs, kind: NoteKind): boolean {
  return kind === "approval" ? prefs.notifyOn.approvals : prefs.notifyOn[kind]
}

export async function readNotifyStatus(): Promise<NotifyStatus> {
  const status = await getHost().notifyStatus()
  useNotifyStatus.setState({ status })
  return status
}

/** Shows macOS's permission prompt the first time. */
export async function requestNotifications(): Promise<NotifyStatus> {
  const status = await getHost().notifyRequest()
  useNotifyStatus.setState({ status })
  return status
}

function looking(threadId: string): boolean {
  return threadOnScreen() === threadId && typeof document !== "undefined" && document.hasFocus()
}

/** Whether Settings asks for a macOS notification now: always, or while Runrail is not in front. */
export function wantsSystemNote(prefs: Prefs, kind: NoteKind, focused: boolean): boolean {
  if (prefs.systemNotifications === "off" || !wants(prefs, kind)) return false
  return prefs.systemNotifications === "always" || !focused
}

async function postSystemNote(kind: NoteKind, threadId: string, title: string, body: string): Promise<boolean> {
  const prefs = get().prefs
  if (!wantsSystemNote(prefs, kind, typeof document !== "undefined" && document.hasFocus())) return false
  try {
    let status = useNotifyStatus.getState().status ?? (await readNotifyStatus())
    if (!status.available) return false
    if (status.permission === "unknown") status = await requestNotifications()
    if (status.permission !== "granted") return false
    await getHost().notifySend({ threadId, title, body, sound: prefs.sounds })
    return true
  } catch {
    return false
  }
}

/** Where a click on a run's notification goes, by its target. */
const runTargets = new Map<string, () => void>()

/**
 * A workflow, setup or eval run's news as a macOS notification, when Settings wants one now; its
 * toast is the caller's. Matters most with the window closed into the menu bar.
 */
export function announceRun(kind: NoteKind, runId: string, title: string, body: string, open: () => void): void {
  const target = `run.${runId}`
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(target)) return
  runTargets.set(target, open)
  void postSystemNote(kind, target, title, body)
}

/** Once: the window closed and Runrail stayed in the menu bar, and how to quit it. */
export async function tellMenuBar(body: string): Promise<boolean> {
  try {
    const status = useNotifyStatus.getState().status ?? (await readNotifyStatus())
    if (!status.available || status.permission !== "granted" || get().prefs.systemNotifications === "off") return false
    await getHost().notifySend({ threadId: "menu-bar", title: "Runrail is still running", body, sound: false })
    return true
  } catch {
    return false
  }
}

/** Tells the person about one event, in every way they turned on for it. */
export function announce(kind: NoteKind, threadId: string): void {
  const state = get()
  if (!wants(state.prefs, kind)) return
  const title = threadById(threadId)?.title ?? "A thread"
  const asking = kind === "approval" && asksQuestion(state.runtime[threadId]?.timeline)
  // A review of another thread's changes says what it found in a toast of its own (`selfReview.ts`).
  const ownToast = kind !== "approval" && threadById(threadId)?.reviewOf !== undefined
  if (state.prefs.notifications && threadOnScreen(state) !== threadId && !ownToast) {
    if (kind === "approval") toast("info", asking ? `${title} has a question for you` : `${title} needs approval`, { label: "Open", run: () => openThread(threadId) })
    else toast(kind === "failed" ? "error" : "success", `${title} ${kind}`, { label: "Open", run: () => openThread(threadId) })
  }
  const body = asking ? "Has a question for you" : BODY[kind]
  // Paired phones hear it while the person is away from Runrail.
  if (typeof document === "undefined" || !document.hasFocus()) void pushToPhones({ title, body, url: `/#t=${threadId}`, tag: threadId, urgency: kind === "approval" ? "high" : "normal" })
  void postSystemNote(kind, threadId, title, body).then((posted) => {
    // A macOS notification carries its own sound.
    if (posted || looking(threadId)) return
    const prefs = get().prefs
    if (prefs.sounds) playTone(TONES[kind], prefs.volume)
  })
}

/** A system notification's click: the thread opens where the person is, over Settings if it was open. */
export function openNotified(threadId: string): void {
  const run = runTargets.get(threadId)
  if (run !== undefined) {
    set({ settings: false })
    run()
    return
  }
  if (threadById(threadId) === undefined) return
  set({ settings: false })
  openThread(threadId)
}

export function initNotifications(): void {
  const host = getHost()
  host.onNotificationOpen(openNotified)
  void host
    .notifyTakeOpened()
    .then((threadId) => threadId !== null && openNotified(threadId))
    .catch(() => undefined)
  void readNotifyStatus().catch(() => undefined)
  useApp.subscribe((state, previous) => {
    const threadId = state.layout.activeThreadId
    if (threadId !== undefined && threadId !== previous.layout.activeThreadId) void host.notifyClear(threadId).catch(() => undefined)
  })
}
