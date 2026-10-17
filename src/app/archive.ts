import { confirmAction } from "./actions"
import { archiveThread, deleteThread } from "./engines"
import { set, threadById, toast } from "./store"

/** The Archived list; the sidebar stays beside it. */
export function showArchivedThreads(): void {
  set({ view: { kind: "archived" }, officeDrawer: false })
}

/** Archives a thread the person chose to, and says where it went, with Undo. */
export function archiveWithUndo(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined) return Promise.resolve()
  const archived = archiveThread(threadId, true)
  toast("info", `Archived ${thread.title}`, { label: "Undo", run: () => void archiveThread(threadId, false) })
  return archived
}

/** Deleting forever is always confirmed, and says what goes with the thread. */
export function confirmDeleteForever(threadId: string): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  confirmAction({
    title: `Delete ${thread.title} forever?`,
    body:
      thread.worktree === undefined
        ? "Its conversation history is deleted from this machine. This cannot be undone."
        : "Its conversation history and its worktree are deleted from this machine. Uncommitted work in the worktree is lost. This cannot be undone.",
    confirm: "Delete forever",
    danger: true,
    onConfirm: () => void deleteThread(threadId),
  })
}
