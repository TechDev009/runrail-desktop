import { ConversationSchema, parseOr } from "../protocol/schemas"
import { threadBlock } from "../thread/threadContext"
import { systemCapability, systemRpc } from "./connections"
import { projectById, runtimeOf, threadById } from "./store"

/** How much of a thread's conversation is read for its `@thread` block. */
const READ_ITEMS = 512

/** The context block for `@thread`. */
export async function threadContext(threadId: string): Promise<string | undefined> {
  const thread = threadById(threadId)
  return thread === undefined ? undefined : threadBlock(thread.title, await threadItems(threadId))
}

/** A thread's latest conversation items, from its transcript or else from the timeline on screen. */
export async function threadItems(threadId: string): Promise<readonly unknown[]> {
  const thread = threadById(threadId)
  const workspace = thread === undefined ? undefined : (thread.worktree?.cwd ?? projectById(thread.projectId)?.path)
  if (workspace !== undefined && (await systemCapability("conversation.peek").catch(() => false))) {
    const items = parseOr(ConversationSchema, await systemRpc("conversation.peek", { threadId, workspace, maxItems: READ_ITEMS }).catch(() => undefined))?.items
    if (items !== undefined && items.length > 0) return items
  }
  return runtimeOf(threadId).timeline.items
}
