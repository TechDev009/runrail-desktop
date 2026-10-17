import { create } from "zustand"
import { getHost } from "../host"
import type { BackendId, ComputerAccess, ComputerApp, StreamFrame } from "../host/types"
import { ComputerTaskSchema, LiveFrameSchema, parseOr, type ComputerTask } from "../protocol/schemas"
import { onTurnEnded } from "./engines"
import { platformWords } from "./platformWords"
import { threadById } from "./store"

/**
 * Computer use. The engine announces a request by id; this claims it once and
 * answers only for a thread the person turned computer use on in. The host does the rest, and acts
 * only on apps the person allowed in Settings, a list the page cannot add to without the person
 * agreeing in the system's own dialog.
 */

type Answer = { readonly ok: false; readonly code: string; readonly message: string } | { readonly ok: true; readonly result: unknown }

/** The routes whose tool results carry a screenshot. */
export function takesComputer(backend: BackendId): boolean {
  return backend === "codex" || backend === "claude-code"
}

interface ComputerSetup {
  /** Absent until read from the host. */
  readonly access?: ComputerAccess
  readonly allowed?: readonly ComputerApp[]
}

/** What Settings and the composer show; the host keeps the allowed list itself. */
export const useComputerSetup = create<ComputerSetup>()(() => ({}))

export async function loadComputerSetup(): Promise<void> {
  const host = getHost()
  const [access, allowed] = await Promise.all([host.computerAccess(), host.computerAllowed()])
  useComputerSetup.setState({ access, allowed })
}

export async function requestComputerAccess(kind: "screen" | "accessibility"): Promise<void> {
  useComputerSetup.setState({ access: await getHost().computerRequestAccess(kind) })
}

export async function allowComputerApp(bundleId: string): Promise<void> {
  useComputerSetup.setState({ allowed: await getHost().computerAllow(bundleId) })
}

export async function disallowComputerApp(bundleId: string): Promise<void> {
  useComputerSetup.setState({ allowed: await getHost().computerDisallow(bundleId) })
}

/** The one window the person shared on Wayland, as the host names it. */
export const SHARED_WINDOW = "wayland.shared-window"

/** Where agents use apps, in the composer's words. */
export function computerPlace(platform: string): string {
  return `this ${platformWords(platform).computer}`
}

/** On Wayland the person picks the window in the desktop's own dialog; false when they shared none. */
export async function shareComputerWindow(): Promise<boolean> {
  await requestComputerAccess("screen")
  return useComputerSetup.getState().access?.portal === "shared"
}

export async function stopSharingComputerWindow(): Promise<void> {
  await disallowComputerApp(SHARED_WINDOW)
  useComputerSetup.setState({ access: await getHost().computerAccess() })
}

/** The app each thread's agent last used in its running turn, for the strip above the composer. */
export const useComputerActivity = create<Readonly<Record<string, { readonly app?: string; readonly action: string }>>>()(() => ({}))

const seen = new Set<string>()
// One screen: requests from every thread run one after another.
let queue: Promise<void> = Promise.resolve()

export function noteComputerFrames(threadId: string, engineId: string, frames: readonly StreamFrame[]): void {
  for (const frame of frames) {
    if (frame.kind === "event" || (frame.data as { readonly type?: unknown } | null)?.type !== "computer.request") continue
    const parsed = LiveFrameSchema.safeParse(frame.data)
    if (!parsed.success || parsed.data.type !== "computer.request" || seen.has(parsed.data.requestId)) continue
    seen.add(parsed.data.requestId)
    if (seen.size > 512) seen.delete(seen.values().next().value as string)
    const requestId = parsed.data.requestId
    queue = queue.then(() => handle(threadId, engineId, requestId)).catch(() => undefined)
  }
}

async function handle(threadId: string, engineId: string, requestId: string): Promise<void> {
  const host = getHost()
  let task: ComputerTask | undefined
  try {
    task = parseOr(ComputerTaskSchema, await host.rpc(engineId, "computer.take", { requestId }))
  } catch {
    // Already claimed, expired, or the engine is gone: nothing to answer.
    return
  }
  if (task === undefined) return
  let answer: Answer
  const thread = threadById(threadId)
  if (thread?.computer !== true || !takesComputer(thread.backend)) answer = { ok: false, code: "COMPUTER_OFF", message: "The person has turned off computer use for this thread." }
  else {
    const app = typeof task.params.app === "string" ? task.params.app : undefined
    useComputerActivity.setState({ [threadId]: { ...(app === undefined ? {} : { app }), action: task.action } })
    try {
      answer = (await host.computerAct(task.action, task.params)) as Answer
    } catch (error) {
      answer = { ok: false, code: "COMPUTER_FAILED", message: error instanceof Error ? error.message.slice(0, 500) : "The computer could not do that." }
    }
  }
  await host.rpc(engineId, "computer.respond", { requestId, answer }).catch(() => undefined)
}

export function initComputerActivity(): () => void {
  return onTurnEnded((threadId) => {
    if (useComputerActivity.getState()[threadId] === undefined) return
    useComputerActivity.setState((state) => {
      const next = { ...state }
      delete next[threadId]
      return next
    }, true)
  })
}
