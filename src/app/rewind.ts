import { z } from "zod"
import { getHost, HostError, toHostError } from "../host"
import { ConversationSchema, parseOr, type Conversation } from "../protocol/schemas"
import { beginEpoch, isBusy, loadHistory, type SentAttachment, type TimelineItem } from "../thread/reducer"
import { systemRpc } from "./connections"
import { deleteThread, threadRpc } from "./engines"
import { newId, type ThreadMeta } from "./persist"
import { createThread, get, openThread, patchRuntime, patchThread, runtimeOf, set, threadById, toast } from "./store"

/**
 * Rewind and Edit: a thread goes back to before one of its messages,
 * with the files ticked in the confirmation, and a copy of the thread as it was is kept in
 * Archived. Edit is a rewind that puts the message back in the composer.
 */

export type FileChange = "modified" | "added" | "deleted"

export interface RewindFile {
  readonly path: string
  readonly change: FileChange
}

/** What the confirmation shows and the rewind needs. */
export interface RewindPlan {
  readonly threadId: string
  /** The message's seq in the transcript: names it whatever the turn ids repeat. */
  readonly userSeq: number
  readonly edit: boolean
  readonly text: string
  /** The message's attachments, as far as this app session sent them. */
  readonly attachments: readonly SentAttachment[]
  /** How many it had that this app session did not send, such as after a restart. */
  readonly attachmentsUnknown: number
  readonly files: readonly RewindFile[]
  /** Why files cannot go back: no snapshot was taken before that message. */
  readonly skipped?: "too-large" | "failed"
  /** Other threads that worked in the same checkout since: putting files back can undo their work. */
  readonly sharers: readonly string[]
}

const HISTORY_ITEMS = 2_048
const MAX_TITLE = 256
const BEFORE_REWIND = " (before rewind)"

const ChangesSchema = z.looseObject({
  checkpoint: z.looseObject({ at: z.number(), skipped: z.enum(["too-large", "failed"]).optional() }),
  files: z.array(z.looseObject({ path: z.string().min(1).max(4_096), change: z.enum(["modified", "added", "deleted"]) })).max(5_000),
})

const RewindResultSchema = z.looseObject({
  removed: z.number().int(),
  restored: z.array(z.string()).max(5_000),
  failed: z.array(z.looseObject({ path: z.string(), reason: z.string() })).max(5_000),
})

const HistoryUserSchema = z.looseObject({ kind: z.literal("user"), seq: z.number().int(), text: z.string(), steer: z.boolean().optional() })

/** The thread's conversation as its transcript holds it now. */
export async function readHistory(threadId: string): Promise<Conversation> {
  const history = parseOr(ConversationSchema, await threadRpc(threadId, "session.conversation.read", { source: "auto", maxItems: HISTORY_ITEMS }))
  if (history === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "conversation response was malformed")
  return history
}

/** Messages that started a turn, newest first: the ones a rewind can go back to. */
function prompts<T extends { readonly kind: string; readonly steer?: boolean }>(items: readonly T[]): T[] {
  return items.filter((item) => item.kind === "user" && item.steer !== true).reverse()
}

/**
 * The transcript seq of the timeline's message `key`, from history read now. The timeline and the
 * history list the same messages in the same order, though either may start later, so the message
 * is found by its place counted from the newest, and its words must match.
 */
export function messageSeq(timeline: readonly TimelineItem[], key: string, history: readonly unknown[]): number | undefined {
  const sent = prompts(timeline.filter((item) => item.kind !== "user" || item.state === "sent"))
  const place = sent.findIndex((item) => item.key === key)
  const target = sent[place]
  if (place < 0 || target?.kind !== "user") return undefined
  const users = prompts(history.flatMap((raw) => {
    const parsed = HistoryUserSchema.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  }))
  const match = users[place]
  return match !== undefined && match.text.trim() === target.text.trim() ? match.seq : undefined
}

/**
 * Other threads in the same folder or worktree that ran since `since`, by title. One that never
 * started a turn, such as a rewind's kept copy, changed no files.
 */
export function checkoutSharers(threads: readonly ThreadMeta[], thread: ThreadMeta, since: number): string[] {
  return threads
    .filter((other) => other.id !== thread.id && other.lastStatus !== undefined && other.projectId === thread.projectId && other.worktree?.id === thread.worktree?.id && other.updatedAt > since)
    .map((other) => other.title)
}

export function changeLabel(change: FileChange): string {
  return change === "added" ? "new since, deleted" : change === "deleted" ? "deleted since, comes back" : "changed since, goes back"
}

/** Opens the confirmation for going back to before the message `key`; Edit puts its words back after. */
export async function openRewind(threadId: string, key: string, edit: boolean): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const runtime = runtimeOf(threadId)
  if (isBusy(runtime.timeline) || runtime.queue.length > 0) {
    toast("info", "Wait for the turn to finish, or stop it, before going back.")
    return
  }
  try {
    const history = await readHistory(threadId)
    const userSeq = messageSeq(runtime.timeline.items, key, history.items)
    const item = runtime.timeline.items.find((entry) => entry.key === key)
    if (userSeq === undefined || item?.kind !== "user") throw new HostError("REWIND_MESSAGE_UNKNOWN", "That message could not be found in the thread's history.")
    const changes = parseOr(ChangesSchema, await threadRpc(threadId, "session.checkpoint.changes", { userSeq }))
    if (changes === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "checkpoint response was malformed")
    const plan: RewindPlan = {
      threadId,
      userSeq,
      edit,
      text: item.text,
      attachments: item.sent ?? [],
      attachmentsUnknown: Math.max(0, item.attachments - (item.sent?.length ?? 0)),
      files: changes.files.map((file) => ({ path: file.path, change: file.change })),
      ...(changes.checkpoint.skipped === undefined ? {} : { skipped: changes.checkpoint.skipped }),
      sharers: checkoutSharers(get().threads, thread, changes.checkpoint.at),
    }
    set({ dialog: { kind: "rewind", plan } })
  } catch (error) {
    toast("error", rewindError(toHostError(error).code, toHostError(error).message))
  }
}

function rewindError(code: string, message: string): string {
  if (code === "CONTROL_GIT_NOT_FOUND" || code === "CONTROL_REWIND_UNAVAILABLE") return "This message was sent before Runrail kept a checkpoint for it, so the thread cannot go back to it."
  if (code === "CONTROL_SESSION_BUSY") return "Wait for the turn to finish, or stop it, before going back."
  return `Could not go back: ${message}`
}

/**
 * Keeps a copy of the thread as it is, then takes the thread back with the `files` ticked. The copy
 * is made first: a rewind that cannot keep one does not run, and one that fails takes its copy away.
 */
export async function runRewind(plan: RewindPlan, files: readonly string[]): Promise<void> {
  const thread = threadById(plan.threadId)
  if (thread === undefined) return
  const copy = keepCopy(thread)
  try {
    await systemRpc("thread.copy", { from: thread.id, to: copy.id })
    const result = parseOr(RewindResultSchema, await threadRpc(thread.id, "session.rewind", { userSeq: plan.userSeq, files }))
    if (result === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "rewind response was malformed")
    await reloadAfterRewind(thread.id)
    if (plan.edit) {
      const attachments = plan.attachments.map((attachment) => ({ id: newId("a"), ...attachment }))
      set((state) => ({
        drafts: { ...state.drafts, [thread.id]: plan.text },
        ...(attachments.length === 0 ? {} : { editAttachments: { ...state.editAttachments, [thread.id]: attachments } }),
        focusComposer: state.focusComposer + 1,
      }))
      if (plan.attachmentsUnknown > 0) toast("info", `${plan.attachmentsUnknown === 1 ? "An attachment" : `${String(plan.attachmentsUnknown)} attachments`} from before Runrail restarted could not be put back. Attach again before sending.`)
    }
    const failed = result.failed.filter((file) => file.reason !== "unchanged since then")
    if (failed.length > 0) toast("error", `${String(failed.length)} ${failed.length === 1 ? "file" : "files"} could not be put back: ${failed.slice(0, 3).map((file) => file.path).join(", ")}${failed.length > 3 ? ", ..." : ""}`)
    toast("success", plan.edit ? "Back to before your message. Edit it and send." : "Back to before your message.", { label: "Open copy", run: () => openThread(copy.id) })
  } catch (error) {
    await deleteThread(copy.id).catch(() => undefined)
    toast("error", rewindError(toHostError(error).code, toHostError(error).message))
  }
}

/** An archived thread that will hold the conversation as it is now. */
function keepCopy(thread: ThreadMeta): ThreadMeta {
  const copy = createThread({
    projectId: thread.projectId,
    backend: thread.backend,
    ...(thread.model === undefined ? {} : { model: thread.model }),
    ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }),
    ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
    mode: thread.mode,
    permission: thread.permission,
    title: `${thread.title.slice(0, MAX_TITLE - BEFORE_REWIND.length)}${BEFORE_REWIND}`,
    ...(thread.worktree === undefined ? {} : { worktree: thread.worktree }),
    select: false,
  })
  patchThread(copy.id, { archived: true, archivedAt: Date.now() })
  return copy
}

/**
 * The engine started its session again, so its events count from zero: the timeline takes the
 * history and a new epoch, and the stream starts over from there.
 */
async function reloadAfterRewind(threadId: string): Promise<void> {
  const history = await readHistory(threadId)
  const current = runtimeOf(threadId)
  // Nothing is waiting to send while a thread goes back, so the history replaces every item.
  const timeline = beginEpoch(loadHistory({ ...current.timeline, items: [] }, history.items, history.truncated === true), -1, current.timeline.lastLiveSeq)
  patchRuntime(threadId, { timeline, historyLoaded: true })
  if (current.engineId !== undefined) await getHost().streamStart(current.engineId, -1, timeline.lastLiveSeq)
}
