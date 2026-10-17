import { create } from "zustand"

/**
 * What happened in threads you were not looking at: a background turn that finished, failed, or
 * stopped, or a thread waiting for approval. One entry per thread, the latest; it is read once
 * that thread is opened. Kept for this run of the app only.
 */

export type InboxKind = "finished" | "failed" | "stopped" | "approval"

export interface InboxItem {
  readonly id: string
  readonly kind: InboxKind
  readonly threadId: string
  readonly title: string
  readonly at: number
  readonly read: boolean
}

interface InboxState {
  readonly items: readonly InboxItem[]
  readonly open: boolean
}

export const MAX_INBOX = 50

export const useInbox = create<InboxState>()(() => ({ items: [], open: false }))

export function notify(kind: InboxKind, threadId: string, title: string, at = Date.now()): void {
  useInbox.setState((state) => ({
    items: [{ id: `${threadId}:${String(at)}`, kind, threadId, title, at, read: false }, ...state.items.filter((item) => item.threadId !== threadId)].slice(0, MAX_INBOX),
  }))
}

export function markThreadRead(threadId: string | undefined): void {
  if (threadId === undefined || !useInbox.getState().items.some((item) => item.threadId === threadId && !item.read)) return
  useInbox.setState((state) => ({ items: state.items.map((item) => (item.threadId === threadId ? { ...item, read: true } : item)) }))
}

export function markAllRead(): void {
  useInbox.setState((state) => ({ items: state.items.map((item) => (item.read ? item : { ...item, read: true })) }))
}

/** A thread that is gone has nothing to open. */
export function forgetThread(threadId: string): void {
  useInbox.setState((state) => ({ items: state.items.filter((item) => item.threadId !== threadId) }))
}

export function unreadCount(state: InboxState): number {
  return state.items.filter((item) => !item.read).length
}

export function setInboxOpen(open: boolean): void {
  useInbox.setState({ open })
}
