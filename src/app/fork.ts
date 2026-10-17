import { HostError, toHostError } from "../host"
import { isBusy, type TimelineItem } from "../thread/reducer"
import { systemCapability, systemRpc } from "./connections"
import { deleteThread } from "./engines"
import { messageSeq, readHistory } from "./rewind"
import { createThread, openThread, runtimeOf, set, threadById, toast } from "./store"

/**
 * Fork from any message. From a message: a new thread holds the conversation
 * before it, with the message in the composer to change. From a reply: the new thread holds the
 * conversation through that reply's turn. The thread forked from, and the files, stay as they are.
 */

const FORK = " (fork)"
const MAX_TITLE = 256

/** The first message after `key` that started a turn: a fork from a reply copies everything before it. */
export function nextPrompt(items: readonly TimelineItem[], key: string): Extract<TimelineItem, { kind: "user" }> | undefined {
  const at = items.findIndex((item) => item.key === key)
  if (at < 0) return undefined
  for (const item of items.slice(at + 1)) if (item.kind === "user" && item.steer !== true) return item
  return undefined
}

/** Forks the thread at the message or reply `key`, and opens the fork. */
export async function forkAt(threadId: string, key: string): Promise<void> {
  const thread = threadById(threadId)
  const timeline = runtimeOf(threadId).timeline
  const item = timeline.items.find((entry) => entry.key === key)
  if (thread === undefined || (item?.kind !== "user" && item?.kind !== "assistant")) return
  const before = item.kind === "user" ? item : nextPrompt(timeline.items, key)
  if (before === undefined && isBusy(timeline)) {
    toast("info", "Wait for the turn to finish before forking from it.")
    return
  }
  try {
    if (!(await systemCapability("thread.copy"))) throw new HostError("FORK_UNAVAILABLE", "this version of the engine cannot fork from an earlier message")
    let beforeSeq: number | undefined
    if (before !== undefined) {
      beforeSeq = messageSeq(timeline.items, before.key, (await readHistory(threadId)).items)
      if (beforeSeq === undefined) throw new HostError("REWIND_MESSAGE_UNKNOWN", "that message could not be found in the thread's history")
    }
    const base = thread.title.endsWith(FORK) ? thread.title.slice(0, -FORK.length) : thread.title
    const fork = createThread({
      projectId: thread.projectId,
      backend: thread.backend,
      ...(thread.model === undefined ? {} : { model: thread.model }),
      ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }),
      ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
      mode: thread.mode,
      permission: thread.permission,
      title: `${base.slice(0, MAX_TITLE - FORK.length)}${FORK}`,
      ...(thread.worktree === undefined ? {} : { worktree: thread.worktree }),
      select: false,
    })
    // Copied before the fork's engine starts, which then finds its conversation already there.
    await systemRpc("thread.copy", { from: thread.id, to: fork.id, ...(beforeSeq === undefined ? {} : { beforeSeq }) }).catch(async (error: unknown) => {
      await deleteThread(fork.id).catch(() => undefined)
      throw error
    })
    if (item.kind === "user") set((state) => ({ drafts: { ...state.drafts, [fork.id]: item.text } }))
    openThread(fork.id)
  } catch (error) {
    toast("error", `Could not fork: ${toHostError(error).message}`)
  }
}
