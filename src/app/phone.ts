import { create } from "zustand"
import { getHost, toHostError, type NewPhoneHook, type PhoneCall, type PhoneShare, type PhoneStatus, type TailscaleStatus, type Unsubscribe } from "../host"
import { isQuestion, pendingApprovals, type TimelineItem } from "../thread/reducer"
import { systemRpc } from "./connections"
import { cancel, ensureEngine, resolveApproval, send, threadStatus } from "./engines"
import type { ThreadMeta } from "./persist"
import { words } from "./platformWords"
import { get, projectById, runtimeOf, threadById, toast } from "./store"
import { loadWorkflows, runWorkflow, useWorkflows } from "./workflowRuns"

/**
 * Phone access: what a paired phone may do, run here with the window's own code.
 * A phone lists threads, reads one, sends a message, stops a turn, and answers an approval; nothing
 * else. Calls and their answers are never logged.
 */

const MAX_THREADS = 100
const MAX_ITEMS = 200
const MAX_TEXT = 20_000

export class PhoneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type PhoneItem =
  | { readonly kind: "user"; readonly key: string; readonly text: string; readonly failed?: true }
  | { readonly kind: "assistant"; readonly key: string; readonly text: string; readonly streaming?: true }
  | { readonly kind: "tool"; readonly key: string; readonly title: string; readonly status: string }
  | { readonly kind: "approval"; readonly key: string; readonly approvalId: string; readonly action: string; readonly reason?: string; readonly status: "pending" | "approved" | "rejected"; readonly question?: true }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

/** The conversation as a phone shows it: messages, tool calls by title, approvals, and errors. */
export function phoneItems(items: readonly TimelineItem[]): readonly PhoneItem[] {
  const shown: PhoneItem[] = []
  for (const item of items.slice(-MAX_ITEMS)) {
    switch (item.kind) {
      case "user":
        shown.push({ kind: "user", key: item.key, text: clip(item.text), ...(item.state === "failed" ? { failed: true as const } : {}) })
        break
      case "assistant":
        if (item.text.length > 0) shown.push({ kind: "assistant", key: item.key, text: clip(item.text), ...(item.streaming ? { streaming: true as const } : {}) })
        break
      case "tool":
        shown.push({ kind: "tool", key: item.key, title: item.presentation.title.slice(0, 300), status: item.status })
        break
      case "approval":
        if (item.withdrawn !== true)
          shown.push({ kind: "approval", key: item.key, approvalId: item.approvalId, action: item.action.slice(0, 2_000), ...(item.reason === undefined ? {} : { reason: item.reason.slice(0, 2_000) }), status: item.status, ...(isQuestion(item) ? { question: true as const } : {}) })
        break
      case "notice":
        if (item.level === "error") shown.push({ kind: "notice", key: item.key, text: (item.message ?? item.code).slice(0, 2_000) })
        break
      default:
        break
    }
  }
  return shown
}

function summary(thread: ThreadMeta) {
  const runtime = get().runtime[thread.id]
  const project = projectById(thread.projectId)
  return {
    id: thread.id,
    title: thread.title,
    project: project?.name ?? "",
    ...(project?.remote === undefined ? {} : { machine: project.remote.host }),
    status: threadStatus(thread, runtime),
    updatedAt: thread.updatedAt,
  }
}

function threadParam(params: Readonly<Record<string, unknown>>): ThreadMeta {
  const thread = typeof params.threadId === "string" ? threadById(params.threadId) : undefined
  if (thread === undefined || thread.archived === true) throw new PhoneError("PHONE_NO_THREAD", `That thread is not on your ${words().computer} any more.`)
  return thread
}

/** What only a paired phone may call; the host relays them from paired phones alone, and this checks again. */
const PAIRED_METHODS: ReadonlySet<string> = new Set(["push.key", "push.subscribe", "push.unsubscribe", "threads", "thread", "send", "stop", "approve"])

/** Runs one call from paired phone `device`; a refusal is a `PhoneError` the phone shows as it is. */
export async function runPhoneCall(method: string, params: Readonly<Record<string, unknown>>, device: string): Promise<unknown> {
  if (PAIRED_METHODS.has(method) && !device.startsWith("ph-")) throw new PhoneError("PHONE_UNKNOWN_METHOD", "Runrail does not do that from a phone.")
  switch (method) {
    case "push.key": {
      const answer = (await systemRpc("push.vapid").catch(() => undefined)) as { publicKey?: unknown } | undefined
      if (typeof answer?.publicKey !== "string") throw new PhoneError("PHONE_PUSH_UNAVAILABLE", `Runrail on your ${words().computer} cannot send notifications yet. Update it and try again.`)
      return { publicKey: answer.publicKey }
    }
    case "push.subscribe": {
      const { subscription, origin } = params
      if (typeof subscription !== "object" || subscription === null || typeof origin !== "string") throw new PhoneError("PHONE_PUSH_INVALID", "That notification subscription is not valid.")
      await getHost().phoneSetPush(device, { subscription, origin })
      return { subscribed: true }
    }
    case "push.unsubscribe":
      await getHost().phoneSetPush(device, null)
      return { subscribed: false }
    case "threads": {
      const threads = get()
        .threads.filter((thread) => thread.archived !== true)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_THREADS)
      return { threads: threads.map(summary) }
    }
    case "share.thread": {
      // Someone with the thread's read-only link: what it says, and nothing to act on.
      if (!device.startsWith("sh-")) throw new PhoneError("PHONE_UNKNOWN_METHOD", "Runrail does not do that from a phone.")
      const thread = threadParam(params)
      if (runtimeOf(thread.id).timeline.items.length === 0) await ensureEngine(thread.id).catch(() => undefined)
      const items = phoneItems(runtimeOf(thread.id).timeline.items).map((item) => (item.kind === "approval" && item.status === "pending" ? { ...item, question: true as const } : item))
      return { title: thread.title, status: threadStatus(thread, get().runtime[thread.id]), items }
    }
    case "thread": {
      const thread = threadParam(params)
      // A thread not opened since launch has no conversation here until its engine loads it.
      if (runtimeOf(thread.id).timeline.items.length === 0) await ensureEngine(thread.id).catch(() => undefined)
      return { ...summary(thread), items: phoneItems(runtimeOf(thread.id).timeline.items) }
    }
    case "send": {
      const thread = threadParam(params)
      const text = typeof params.text === "string" ? params.text.trim() : ""
      if (text.length === 0 || text.length > MAX_TEXT) throw new PhoneError("PHONE_BAD_MESSAGE", "Write a message of up to 20,000 characters.")
      send(thread.id, { text })
      return { sent: true }
    }
    case "stop": {
      const thread = threadParam(params)
      await cancel(thread.id)
      return { stopped: true }
    }
    case "approve": {
      const thread = threadParam(params)
      const pending = pendingApprovals(runtimeOf(thread.id).timeline).find((item) => item.approvalId === params.approvalId)
      if (pending === undefined) throw new PhoneError("PHONE_NOT_WAITING", "That is no longer waiting for an answer.")
      if (isQuestion(pending)) throw new PhoneError("PHONE_QUESTION", `Answer this question on your ${words().computer}.`)
      if (typeof params.approved !== "boolean") throw new PhoneError("PHONE_BAD_ANSWER", "Say yes or no.")
      if (!(await resolveApproval(thread.id, pending.approvalId, params.approved))) throw new PhoneError("PHONE_ANSWER_FAILED", "The answer did not go through.")
      return { answered: true }
    }
    case "hook.fire": {
      // A call to a workflow's link; the host names the workflow, not the caller.
      if (!device.startsWith("hk-")) throw new PhoneError("PHONE_UNKNOWN_METHOD", "Runrail does not do that from a phone.")
      const project = typeof params.projectId === "string" ? projectById(params.projectId) : undefined
      // Only a list that was read, or projects that were, can show the workflow is gone; anything
      // less is answered with a retry, so a passing failure never removes the link.
      const unsure = new PhoneError("PHONE_HOOK_UNAVAILABLE", `Runrail on the ${words().computer} could not read its workflows just now. Try again in a minute.`)
      if (project === undefined) {
        if (!get().loaded || get().stateHeld !== undefined) throw unsure
        throw await hookGone(device)
      }
      await loadWorkflows(project.id)
      const listed = useWorkflows.getState().byProject[project.id]
      if (listed?.state !== "ready") throw unsure
      const workflow = listed.workflows.find((item) => item.id === params.workflowId)
      if (workflow === undefined) throw await hookGone(device)
      if (workflow.trigger.kind !== "webhook" || workflow.state !== "on") throw new PhoneError("PHONE_HOOK_OFF", `This workflow is off or no longer starts from its link. Turn it on in Runrail on the ${words().computer}.`)
      const input = typeof params.input === "string" && params.input.length > 0 ? params.input : undefined
      const run = await runWorkflow(project.id, workflow.id, "webhook", undefined, input)
      return { started: true, runId: run.runId }
    }
    default:
      throw new PhoneError("PHONE_UNKNOWN_METHOD", `This phone page is newer or older than Runrail on your ${words().computer}. Reload it.`)
  }
}

/** Removes a link whose workflow is gone for certain; the refusal its caller is answered with. */
async function hookGone(device: string): Promise<PhoneError> {
  // A link that could not be removed now is tried again on its next call.
  await getHost()
    .phoneHookRemove(device)
    .catch(() => undefined)
  return new PhoneError("PHONE_HOOK_GONE", `This workflow is not on the ${words().computer} any more.`)
}

/** Answers paired phones' calls while the app runs, and keeps phone access's state current. */
export function initPhone(): Unsubscribe {
  const host = getHost()
  void loadPhone()
  const watching = watchPhone()
  const answering = host.onPhoneCall((call: PhoneCall) => {
    void runPhoneCall(call.method, call.params, call.device).then(
      (result) => host.phoneAnswer(call.id, true, result ?? null),
      (error: unknown) => {
        const { code, message } = error instanceof PhoneError ? error : toHostError(error)
        return host.phoneAnswer(call.id, false, { code, message })
      },
    )
  })
  return () => {
    watching()
    answering()
  }
}

/** The HTTPS port on the tailnet; 443 is left for whatever else the person serves. */
export const PHONE_HTTPS_PORT = 8443

/** What brings the loopback server to the person's tailnet. */
export function serveCommand(port: number): string {
  return `tailscale serve --bg --https=${String(PHONE_HTTPS_PORT)} http://127.0.0.1:${String(port)}`
}

/**
 * The address a phone opens to pair: the code rides in the fragment, which the browser never sends,
 * and the page drops it from the address once paired.
 */
export function pairingUrl(name: string, code: string): string {
  return `https://${name}:${String(PHONE_HTTPS_PORT)}/#pair=${code}`
}

/** Phone access as Settings shows it, with the person's Tailscale. */
export const usePhone = create<{ readonly status?: PhoneStatus; readonly tailscale?: TailscaleStatus; readonly error?: string }>()(() => ({}))

export function loadTailscale(): Promise<void> {
  return getHost()
    .tailscaleStatus()
    .then(
      (tailscale) => usePhone.setState({ tailscale }),
      () => usePhone.setState({ tailscale: undefined }),
    )
}

/** Shares phone access on the tailnet, which the host asks the person about first, or stops. */
export async function shareOnTailnet(on: boolean): Promise<void> {
  try {
    usePhone.setState({ tailscale: await getHost().tailscaleServe(on), error: undefined })
  } catch (error) {
    const failure = toHostError(error)
    if (failure.code !== "TAILSCALE_DECLINED") usePhone.setState({ error: failure.message })
  }
}

function track(next: Promise<PhoneStatus>): Promise<void> {
  return next.then(
    (status) => usePhone.setState({ status, error: undefined }),
    (error: unknown) => usePhone.setState({ error: toHostError(error).message }),
  )
}

export function loadPhone(): Promise<void> {
  return track(getHost().phoneStatus())
}

export function setPhone(on: boolean): Promise<void> {
  return track(getHost().setPhone(on))
}

export function pairPhone(): Promise<void> {
  return track(getHost().phonePair())
}

export function forgetPhone(id: string): Promise<void> {
  return track(getHost().phoneForget(id))
}

/** Keeps Settings current when a phone pairs. */
export function watchPhone(): Unsubscribe {
  return getHost().onPhoneChanged((status) => usePhone.setState({ status, error: undefined }))
}

/** A link's address on the tailnet, or just its path when this Mac's tailnet name is not known. */
export function shareUrl(share: Pick<PhoneShare, "kind" | "token">, name: string | undefined): string {
  const path = share.kind === "thread" ? `/s/${share.token}` : `/p/${share.token}/`
  return name === undefined ? path : `https://${name}:${String(PHONE_HTTPS_PORT)}${path}`
}

async function copyLink(share: PhoneShare, said: string): Promise<void> {
  await loadPhone()
  if (usePhone.getState().tailscale === undefined) await loadTailscale()
  const url = shareUrl(share, usePhone.getState().tailscale?.name)
  const copied = await Promise.resolve()
    .then(() => navigator.clipboard.writeText(url))
    .then(
    () => true,
    () => false,
  )
  toast("success", copied ? said : `Copy this link: ${url}`)
}

/** Copies a thread's read-only link, making it the first time. */
export async function copyThreadLink(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined) return
  try {
    await copyLink(await getHost().phoneShareThread(threadId, thread.title), "Read-only link copied. Anyone on your tailnet with it can read this thread until you revoke it in Settings, General, Phone access.")
  } catch (error) {
    toast("error", toHostError(error).message)
  }
}

/** Publishes a folder the person picks as a read-only page, and copies its link. */
export async function publishPage(): Promise<void> {
  try {
    const share = await getHost().phonePublish()
    if (share !== null) await copyLink(share, "Page published and its link copied. Anyone on your tailnet with it can open it until you unpublish it.")
  } catch (error) {
    usePhone.setState({ error: toHostError(error).message })
  }
}

export function unshare(id: string): Promise<void> {
  return track(getHost().phoneUnshare(id))
}

/** A workflow's webhook address: this Mac's tailnet name, or just the path when it is not known. */
export function hookUrl(token: string, name: string | undefined): string {
  const path = `/hook/${token}`
  return name === undefined ? path : `https://${name}:${String(PHONE_HTTPS_PORT)}${path}`
}

/** Makes a workflow's link, ending its old one; the secret is returned only here, to show once. */
export async function makeHook(projectId: string, workflowId: string): Promise<NewPhoneHook | undefined> {
  try {
    const made = await getHost().phoneHookCreate(projectId, workflowId)
    await loadPhone()
    if (usePhone.getState().tailscale === undefined) await loadTailscale()
    return made
  } catch (error) {
    toast("error", toHostError(error).message)
    return undefined
  }
}

export function removeHook(id: string): Promise<void> {
  return track(getHost().phoneHookRemove(id))
}
