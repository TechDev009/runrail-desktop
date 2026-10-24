import { getHost } from "../host"
import type { StreamFrame } from "../host/types"
import { LiveFrameSchema, ThreadsTaskSchema, parseOr, type ThreadsTask } from "../protocol/schemas"
import { appendNotice, isBusy } from "../thread/reducer"
import { cleanTitle, messageFrom, messageFromThread, threadDigest } from "../thread/threadContext"
import { ACCESS_LABELS, accessOf, effectivePermission, type Access } from "./access"
import type { ThreadMeta } from "./persist"
import { onSendFailed, onTurnEnded, quiet, send } from "./engines"
import { get, patchRuntime, projectById, runtimeOf, threadById } from "./store"
import { threadItems } from "./threadMention"

/**
 * The agent's way to the person's other threads (unattended). The engine
 * announces a request by id; this claims it once, applies the rules below (never the engine's
 * word), and answers.
 *
 * - Settings pick which threads an agent reaches: none, its own project's, or any.
 * - A message runs only in a thread on the same access as the sender's, so no agent reaches past
 *   its own approvals through another thread. A refused message shows in that thread with why.
 * - One turn sends at most `SENDS_PER_TURN` messages.
 * - A thread that was messaged carries the chain that led to it. A chain grows to `MAX_CHAIN`
 *   threads at most and never comes back to a thread already in it. The person's own message
 *   starts the thread's chain over.
 */

type Answer = { readonly ok: true; readonly result: { readonly text: string } } | { readonly ok: false; readonly code: string; readonly message: string }

export const SENDS_PER_TURN = 5
export const MAX_CHAIN = 3
const MAX_LISTED = 50
const READ_BYTES = 12 * 1024
const REPLY_CHARS = 16 * 1024
const REFUSED_SHOWN = 500
// Inside the engine's own 15 minutes, so the agent hears this answer rather than its timeout.
const WAIT_MS = 14 * 60_000 + 30_000

const seen = new Set<string>()
const queues = new Map<string, Promise<void>>()
/** For each thread an agent messaged, the threads that led to it, first first. Memory only. */
const chains = new Map<string, readonly string[]>()
/** Messages sent per turn, by `<thread>:<turn>`. Bounded. */
const sentInTurn = new Map<string, number>()

const refuse = (code: string, message: string): Answer => ({ ok: false, code, message })

export function noteThreadFrames(threadId: string, engineId: string, frames: readonly StreamFrame[]): void {
  for (const frame of frames) {
    if (frame.kind === "event" || (frame.data as { readonly type?: unknown } | null)?.type !== "threads.request") continue
    const parsed = LiveFrameSchema.safeParse(frame.data)
    if (!parsed.success || parsed.data.type !== "threads.request" || seen.has(parsed.data.requestId)) continue
    seen.add(parsed.data.requestId)
    if (seen.size > 512) seen.delete(seen.values().next().value as string)
    const requestId = parsed.data.requestId
    // One at a time per thread, so its sends are counted in order.
    const previous = queues.get(threadId) ?? Promise.resolve()
    const next = previous.then(() => handle(threadId, engineId, requestId)).catch(() => undefined)
    queues.set(threadId, next)
    void next.finally(() => {
      if (queues.get(threadId) === next) queues.delete(threadId)
    })
  }
}

/** Every message reaches `send`; one not from another thread starts the thread's chain over. */
export function noteSent(threadId: string, text: string): void {
  if (messageFrom(text) === undefined) chains.delete(threadId)
}

async function handle(threadId: string, engineId: string, requestId: string): Promise<void> {
  const host = getHost()
  let task: ThreadsTask | undefined
  try {
    task = parseOr(ThreadsTaskSchema, await host.rpc(engineId, "threads.take", { requestId }))
  } catch {
    // Already claimed, expired, or the engine is gone: nothing to answer.
    return
  }
  if (task === undefined) return
  let answer: Answer
  try {
    answer = await act(threadId, task)
  } catch (error) {
    answer = refuse("THREADS_FAILED", error instanceof Error ? error.message.slice(0, 500) : "The other thread could not be reached.")
  }
  await host.rpc(engineId, "threads.respond", { requestId, answer }).catch(() => undefined)
}

/** The threads `from`'s agent may reach under the person's setting, newest first. */
export function reachable(from: ThreadMeta): ThreadMeta[] {
  const scope = get().prefs.threadMessages
  if (scope === "off") return []
  return get()
    .threads.filter((thread) => thread.id !== from.id && thread.archived !== true && !quiet(thread.id) && (scope === "all" || thread.projectId === from.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function stateOf(thread: ThreadMeta): string {
  if (thread.lastStatus === "waiting") return "waiting on the person"
  const runtime = get().runtime[thread.id]
  if (thread.lastStatus === "running" || (runtime !== undefined && isBusy(runtime.timeline))) return "working"
  return "idle"
}

/** A thread by its id, or by its exact title when no other reachable thread shares it. */
function resolve(from: ThreadMeta, ref: string): ThreadMeta | Answer {
  if (ref === from.id) return refuse("THREADS_DENIED", "That is this thread.")
  const options = reachable(from)
  const byId = options.find((thread) => thread.id === ref)
  if (byId !== undefined) return byId
  const named = options.filter((thread) => thread.title.trim().toLowerCase() === ref.trim().toLowerCase())
  if (named.length === 1) return named[0] as ThreadMeta
  if (named.length > 1) return refuse("THREADS_NOT_FOUND", `${String(named.length)} threads are called "${cleanTitle(ref)}". Use one's id from list_threads.`)
  const elsewhere = threadById(ref) ?? get().threads.find((thread) => thread.title.trim().toLowerCase() === ref.trim().toLowerCase())
  if (elsewhere !== undefined && elsewhere.archived !== true && get().prefs.threadMessages === "project" && elsewhere.projectId !== from.projectId)
    return refuse("THREADS_DENIED", "That thread is in another project. The person can let agents reach every project's threads in Settings.")
  return refuse("THREADS_NOT_FOUND", `No thread you can reach is called "${cleanTitle(ref)}". list_threads shows them.`)
}

async function act(threadId: string, task: ThreadsTask): Promise<Answer> {
  const from = threadById(threadId)
  if (from === undefined) return refuse("THREADS_FAILED", "This thread is gone.")
  if (get().prefs.threadMessages === "off") return refuse("THREADS_OFF", "The person has turned off messaging between threads. They can turn it on in Settings.")
  if (task.action === "list") return { ok: true, result: { text: listText(from) } }
  const target = resolve(from, typeof task.params.thread === "string" ? task.params.thread : "")
  if ("ok" in target) return target
  if (task.action === "read") return { ok: true, result: { text: await readText(target) } }
  return sendTo(from, target, typeof task.params.message === "string" ? task.params.message : "", task.params.wait === true)
}

function listText(from: ThreadMeta): string {
  const threads = reachable(from)
  if (threads.length === 0) return get().prefs.threadMessages === "project" ? "This project has no other threads." : "There are no other threads."
  const lines = threads.slice(0, MAX_LISTED).map((thread) => [thread.id, cleanTitle(thread.title), projectById(thread.projectId)?.name ?? "", stateOf(thread)].join("\t"))
  const more = threads.length > MAX_LISTED ? `\n(${String(threads.length - MAX_LISTED)} older threads not listed.)` : ""
  return `id\ttitle\tproject\tstate\n${lines.join("\n")}${more}`
}

async function readText(target: ThreadMeta): Promise<string> {
  const digest = threadDigest(await threadItems(target.id), READ_BYTES)
  const head = `Thread "${cleanTitle(target.title)}" (${target.id}), ${stateOf(target)}.`
  return digest === undefined ? `${head}\nIt has no messages yet.` : `${head}\n${digest.trimEnd()}`
}

async function sendTo(from: ThreadMeta, target: ThreadMeta, message: string, wait: boolean): Promise<Answer> {
  if (message.trim().length === 0) return refuse("THREADS_FAILED", "The message is empty.")
  const chain = [...(chains.get(from.id) ?? []), from.id]
  if (chain.includes(target.id)) return refuse("THREADS_DENIED", "That thread is waiting on this one, earlier in the chain. Answer it in your reply instead of messaging it.")
  if (chain.length > MAX_CHAIN) return refuse("THREADS_LIMIT", `Threads messaging threads stop at ${String(MAX_CHAIN)} in a row. Finish this turn with what you have.`)
  const turn = `${from.id}:${runtimeOf(from.id).timeline.activeTurnId ?? "idle"}`
  const count = sentInTurn.get(turn) ?? 0
  if (count >= SENDS_PER_TURN) return refuse("THREADS_LIMIT", `This turn has sent ${String(SENDS_PER_TURN)} messages to other threads already.`)
  sentInTurn.set(turn, count + 1)
  if (sentInTurn.size > 256) sentInTurn.delete(sentInTurn.keys().next().value as string)
  // Counted above, so refused sends cannot flood the other thread with notices.
  const ours = accessFor(from)
  const theirs = accessFor(target)
  if (ours !== theirs) {
    noteRefused(target, from, message.trim(), theirs, ours)
    return refuse("THREADS_DENIED", `"${cleanTitle(target.title)}" is on ${ACCESS_LABELS[theirs]} and this thread is on ${ACCESS_LABELS[ours]}. A thread runs another's message only when both are on the same access, so it was not sent; that thread shows the person why.`)
  }

  const requestId = `tm-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
  const busy = isBusy(runtimeOf(target.id).timeline) || runtimeOf(target.id).queue.length > 0
  const reply = wait ? replyTo(target.id, requestId) : undefined
  chains.set(target.id, chain)
  send(target.id, { text: messageFromThread(message.trim(), from, wait), requestId })
  const name = `"${cleanTitle(target.title)}"`
  if (reply === undefined) return { ok: true, result: { text: busy ? `Queued in ${name}; it runs when that thread's current turn ends.` : `Sent to ${name}; it runs there now.` } }
  return reply
}

/** The access a thread's turns run with: Plan, or its permission as its tool applies it. */
function accessFor(thread: ThreadMeta): Access {
  return accessOf(thread.mode, effectivePermission(thread.permission, thread.backend))
}

/** Tells the person, in the thread that was messaged, what another thread's agent asked and why it did not run. */
function noteRefused(target: ThreadMeta, from: ThreadMeta, message: string, theirs: Access, ours: Access): void {
  const asked = message.length > REFUSED_SHOWN ? `${message.slice(0, REFUSED_SHOWN).trimEnd()}...` : message
  const sender = `"${cleanTitle(from.title)}"`
  patchRuntime(target.id, (current) => ({
    timeline: appendNotice(current.timeline, {
      code: "thread.message.refused",
      message: `The agent in ${sender} sent this thread a message, and it was not run: "${asked}". This thread is on ${ACCESS_LABELS[theirs]} and ${sender} is on ${ACCESS_LABELS[ours]}; a message from another thread runs only when both are on the same access.`,
    }),
  }))
}

/**
 * The reply of the turn `requestId`'s message starts in `threadId`: its last answer when the turn
 * completes, or why there is none.
 */
function replyTo(threadId: string, requestId: string): Promise<Answer> {
  return new Promise((resolve) => {
    let done = false
    const finish = (answer: Answer): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      offEnd()
      offFail()
      resolve(answer)
    }
    const offEnd = onTurnEnded((thread, turnId) => {
      if (thread !== threadId) return
      const items = runtimeOf(threadId).timeline.items
      const started = items.some((item) => item.kind === "user" && item.requestId === requestId && item.turnId === turnId)
      if (!started) return
      const end = runtimeOf(threadId).timeline.lastTurnEnd
      const answers = items.filter((item) => item.kind === "assistant" && item.turnId === turnId)
      const last = answers[answers.length - 1]
      const text = last?.kind === "assistant" ? last.text.trim() : ""
      if (end?.turnId === turnId && end.status !== "completed") finish(refuse("THREADS_FAILED", `That thread's turn ${end.status === "stopped" ? "was stopped" : "failed"}${text.length > 0 ? ` after writing: ${text.slice(0, 2_000)}` : "."}`))
      else finish({ ok: true, result: { text: text.length > 0 ? text.slice(0, REPLY_CHARS) : "That thread finished without a reply." } })
    })
    const offFail = onSendFailed((thread, reason) => {
      if (thread !== threadId) return
      const failed = runtimeOf(threadId).timeline.items.some((item) => item.kind === "user" && item.requestId === requestId && item.state === "failed")
      if (failed) finish(refuse("THREADS_FAILED", `The message could not reach that thread: ${reason.slice(0, 300)}`))
    })
    const timer = setTimeout(() => finish(refuse("THREADS_TIMEOUT", "That thread is still working. Read it later with read_thread.")), WAIT_MS)
  })
}
