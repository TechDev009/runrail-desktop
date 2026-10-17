import { pendingApprovals, type ApprovalItem, type Timeline, type ToolItem } from "../thread/reducer"
import type { ThreadMeta } from "./persist"
import type { ThreadRuntime } from "./store"

/**
 * What is waiting on the person across every project: approvals first, then failures, quiet
 * threads, and finished turns, the longest-waiting first within each. Pure, so the tray, the
 * header count, and the tests all read the same answer.
 */

export type WaitingKind = "approval" | "failed" | "quiet" | "finished"

export interface WaitingItem {
  readonly key: string
  readonly kind: WaitingKind
  readonly threadId: string
  readonly projectId: string
  readonly title: string
  /** When it started waiting: the approval was asked, the turn ended, or the thread went silent. */
  readonly since: number
  readonly approval?: ApprovalItem
  /** The call an approval gates, or the call a quiet thread is still running. */
  readonly tool?: ToolItem
}

export interface AttentionInput {
  readonly threads: readonly ThreadMeta[]
  readonly runtime: Readonly<Record<string, ThreadRuntime>>
  /** When each thread's engine last sent anything. */
  readonly activity: Readonly<Record<string, number>>
  /** Threads with a background subagent still working, whose turn may wait on it without a sound. */
  readonly agentsRunning: ReadonlySet<string>
  /** Silence that makes a running turn quiet; 0 never does. */
  readonly quietMs: number
  /** Quiet threads the person already saw, by the silence they saw: new activity brings them back. */
  readonly acknowledged: Readonly<Record<string, number>>
  readonly now: number
}

const ORDER: Readonly<Record<WaitingKind, number>> = { approval: 0, failed: 1, quiet: 2, finished: 3 }

/** How far back a quiet thread's running call is looked for. */
const TOOL_SCAN = 200

export function waitingItems(input: AttentionInput): readonly WaitingItem[] {
  const items: WaitingItem[] = []
  for (const thread of input.threads) {
    if (thread.archived === true) continue
    const base = { threadId: thread.id, projectId: thread.projectId, title: thread.titled ? thread.title : "New thread" }
    const timeline = input.runtime[thread.id]?.timeline
    const approvals = timeline === undefined ? [] : pendingApprovals(timeline)
    for (const approval of approvals) {
      const gate = toolAt(timeline, approval.callKey)
      items.push({ ...base, key: `approval:${thread.id}:${approval.approvalId}`, kind: "approval", since: approval.at, approval, ...(gate === undefined ? {} : { tool: gate }) })
    }
    if (timeline !== undefined && approvals.length === 0 && isQuiet(thread.id, timeline, input)) {
      const since = input.activity[thread.id] ?? input.now
      const running = runningTool(timeline)
      items.push({ ...base, key: `quiet:${thread.id}`, kind: "quiet", since, ...(running === undefined ? {} : { tool: running }) })
    }
    if (thread.unread === true && (thread.lastStatus === "failed" || thread.lastStatus === "completed")) {
      const kind = thread.lastStatus === "failed" ? "failed" : "finished"
      items.push({ ...base, key: `${kind}:${thread.id}`, kind, since: thread.updatedAt })
    }
  }
  return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.since - b.since)
}

function isQuiet(threadId: string, timeline: Timeline, input: AttentionInput): boolean {
  if (input.quietMs <= 0 || timeline.activeTurnId === undefined || input.agentsRunning.has(threadId)) return false
  const last = input.activity[threadId]
  // No stamp yet means the engine has not spoken since it started; nothing to measure from.
  if (last === undefined || input.now - last < input.quietMs) return false
  return input.acknowledged[threadId] !== last
}

function toolAt(timeline: Timeline | undefined, key: string | undefined): ToolItem | undefined {
  if (timeline === undefined || key === undefined) return undefined
  const position = timeline.index.get(key)
  const item = position === undefined ? undefined : timeline.items[position]
  return item?.kind === "tool" ? item : undefined
}

/** The latest call still running in the active turn. */
export function runningTool(timeline: Timeline): ToolItem | undefined {
  const stop = Math.max(0, timeline.items.length - TOOL_SCAN)
  for (let position = timeline.items.length - 1; position >= stop; position -= 1) {
    const item = timeline.items[position]
    if (item?.kind === "tool" && item.status === "running" && item.turnId === timeline.activeTurnId) return item
  }
  return undefined
}

export type TriageAction =
  | { readonly kind: "move"; readonly by: 1 | -1 }
  | { readonly kind: "edge"; readonly to: "first" | "last" }
  | { readonly kind: "approve"; readonly session?: true }
  | { readonly kind: "deny" }
  | { readonly kind: "feedback" }
  | { readonly kind: "open" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "close" }

export interface TriageKey {
  readonly key: string
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly repeat?: boolean
}

/**
 * How long an approval is on screen before a key may answer it. Answering one moves the next
 * into its place, so a second press, or a held key, would otherwise answer one never read.
 */
export const APPROVAL_SETTLE_MS = 500

/**
 * The tray's single-key commands. They only reach here while the tray has focus, so typing in the
 * composer never triggers them, and any chord with Command, Control, or Option passes through.
 */
export function triageKey(event: TriageKey, item: WaitingItem | undefined, sessionOffered: boolean, settled = true): TriageAction | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (key === "ArrowDown" || (key === "j" && !event.shiftKey)) return { kind: "move", by: 1 }
  if (key === "ArrowUp" || (key === "k" && !event.shiftKey)) return { kind: "move", by: -1 }
  if (key === "Home") return { kind: "edge", to: "first" }
  if (key === "End") return { kind: "edge", to: "last" }
  if (key === "Escape") return { kind: "close" }
  if (item === undefined || event.repeat === true) return undefined
  if (key === "o" && !event.shiftKey) return { kind: "open" }
  if (item.kind !== "approval") {
    if (key === "Enter" && !event.shiftKey) return { kind: "open" }
    return key === "x" && !event.shiftKey ? { kind: "dismiss" } : undefined
  }
  if (!settled) return undefined
  // A question is answered in its thread: Enter opens it, and d skips it.
  if (item.approval?.questions !== undefined) return key === "Enter" && !event.shiftKey ? { kind: "open" } : key === "d" && !event.shiftKey ? { kind: "deny" } : undefined
  if ((key === "Enter" || key === "a") && !event.shiftKey) return { kind: "approve" }
  if (key === "a" && event.shiftKey) return sessionOffered ? { kind: "approve", session: true } : undefined
  if (key === "d") return event.shiftKey ? { kind: "feedback" } : { kind: "deny" }
  return undefined
}
