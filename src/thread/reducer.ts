import {
  AgentEventSchema,
  ConversationItemSchema,
  LiveFrameSchema,
  type AgentEvent,
  type ApiRetry,
  type ConversationItem,
  type LiveFrame,
  type PlanStep,
  type Question,
  type ReviewFrame,
  type SessionStatus,
  type ToolPresentation,
} from "../protocol/schemas"
import type { StreamFrame } from "../host/types"
import { recalledIn, type RecalledMemory } from "./recall"

/**
 * Pure timeline reducer. Engine frames arrive in batches; each batch is applied once, producing
 * a new timeline whose changed items are new objects so memoized rows re-render precisely.
 * Semantics mirror the engine's ConversationBuilder, so a reopened thread (rebuilt from the
 * transcript) and a live thread render the same way.
 */

export type ToolStatus = "running" | "ok" | "failed"

export interface UserItem {
  readonly kind: "user"
  readonly key: string
  readonly turnId?: string
  readonly text: string
  readonly attachments: number
  /** Object URLs for images attached in this app session; never persisted. */
  readonly images?: readonly string[]
  /** What was attached, when sent in this app session, so Edit can put it back; never persisted. */
  readonly sent?: readonly SentAttachment[]
  readonly state: "sending" | "sent" | "failed"
  readonly steer?: boolean
  readonly errorCode?: string
  /** The engine's words for why it was not sent. */
  readonly errorMessage?: string
  /** The key the message went to the engine under; sending it again under it cannot start a second turn. */
  readonly requestId?: string
  /** Memories the engine sent with the message, read back from its text. */
  readonly recalled?: readonly RecalledMemory[]
  /** Why local memory answered instead of the external server. */
  readonly recallNote?: string
  readonly at: number
}

export interface AssistantItem {
  readonly kind: "assistant"
  readonly key: string
  readonly turnId?: string
  readonly text: string
  readonly streaming: boolean
  readonly parentCallId?: string
  readonly eventSeq?: number
  readonly at: number
}

export interface ReasoningItem {
  readonly kind: "reasoning"
  readonly key: string
  readonly turnId?: string
  readonly text: string
  readonly streaming: boolean
  readonly parentCallId?: string
  readonly at: number
  readonly endedAt?: number
}

export interface ToolItem {
  readonly kind: "tool"
  readonly key: string
  readonly callId: string
  readonly turnId?: string
  readonly name: string
  readonly presentation: ToolPresentation
  readonly status: ToolStatus
  readonly output?: string
  /** Lines a file write added and removed, as the engine counted them against the old file. */
  readonly additions?: number
  readonly deletions?: number
  /** Whether a file write made a new file; unknown from engines that do not say. */
  readonly created?: boolean
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly parentCallId?: string
  readonly agent?: { readonly title: string; readonly agentType?: string }
  readonly agentStatus?: ToolStatus
  readonly at: number
  readonly endedAt?: number
}

export interface ApprovalItem {
  readonly kind: "approval"
  readonly key: string
  readonly approvalId: string
  readonly turnId?: string
  readonly action: string
  readonly capability: string
  readonly reason?: string
  readonly status: "pending" | "approved" | "rejected"
  /** A question the coding tool asks; the person answers it instead of approving. */
  readonly questions?: readonly Question[]
  /** The answers given, by question id; a secret's answer never comes back. */
  readonly answers?: Readonly<Record<string, readonly string[]>>
  /** The coding tool took the request back before anyone answered it. */
  readonly withdrawn?: true
  /** Why it was denied, when the denial said: the person's note, or why Runrail declined it unasked. */
  readonly denial?: string
  /** The tool may be asked for more questions instead of all the answers; the person did, with what they wrote. */
  readonly takesFollowUp?: true
  readonly followUp?: true
  readonly note?: string
  /** Tool call the approval most likely gates (the latest running call in the turn). */
  readonly callKey?: string
  readonly at: number
}

/** Whether an approval is a coding tool's question: settled by the person's answers or refusal, never by approving it. */
export function isQuestion(item: Pick<ApprovalItem, "action" | "questions"> & { readonly capability?: string }): boolean {
  return item.questions !== undefined || (item.action === "question" && item.capability === "user.input")
}

/** A call the coding tool's own reviewer, rules, or mode decided without asking; its decision updates the row in place. */
export interface ReviewItem {
  readonly kind: "review"
  readonly key: string
  readonly turnId?: string
  readonly reviewId: string
  readonly reviewer: ReviewFrame["reviewer"]
  readonly decision: ReviewFrame["decision"]
  readonly action: string
  readonly capability: string
  readonly risk?: NonNullable<ReviewFrame["risk"]>
  readonly source?: NonNullable<ReviewFrame["source"]>
  readonly detail?: string
  readonly rationale?: string
  readonly at: number
}

export interface PlanItem {
  readonly kind: "plan"
  readonly key: string
  readonly turnId?: string
  readonly explanation?: string
  readonly steps: readonly PlanStep[]
  readonly at: number
}

export interface NoticeItem {
  readonly kind: "notice"
  readonly key: string
  readonly level: "info" | "error"
  readonly code: string
  readonly turnId?: string
  readonly name?: string
  readonly message?: string
  /** A compaction's token counts, when the tool reported both. */
  readonly sizes?: { readonly before: number; readonly after: number }
  /** An import its own tool continues from a copy of the session. */
  readonly inTool?: true
  /** `session.refreshed`: the turns brought in from the session's tool. */
  readonly turns?: number
  /** `api.retry`: the latest of the coding tool's retries of one request. */
  readonly retry?: ApiRetry
  readonly at: number
}

/** The route and model that handled one turn. Engines may omit fields they do not know. */
export interface TurnRun {
  readonly backend?: string
  readonly model?: string
  readonly connectionId?: string
}

export interface TurnRunRecord extends TurnRun {
  readonly turnId: string
}

export interface TurnEndItem {
  readonly kind: "turn-end"
  readonly key: string
  readonly turnId: string
  readonly status: "completed" | "failed" | "stopped"
  readonly startedAt: number
  readonly endedAt: number
  /** Why a stop the person did not ask for happened: the turn ran out of time, or its session closed. */
  readonly stopCause?: "timeout" | "closed"
  /** Selection used for this turn, captured before a later model switch. */
  readonly backend?: string
  readonly model?: string
  readonly connectionId?: string
}

export type TimelineItem = UserItem | AssistantItem | ReasoningItem | ToolItem | ApprovalItem | ReviewItem | PlanItem | NoticeItem | TurnEndItem

export interface TimelineCounters {
  readonly events: number
  readonly live: number
  readonly rejected: number
  readonly duplicates: number
}

export interface ContextUsage {
  readonly usedTokens: number
  readonly windowTokens?: number
  /** Where the coding tool compacts on its own, when it says. */
  readonly autoCompactAt?: number
  readonly estimated: boolean
}

export interface Timeline {
  readonly items: readonly TimelineItem[]
  readonly index: ReadonlyMap<string, number>
  readonly calls: ReadonlyMap<string, string>
  readonly approvals: ReadonlyMap<string, string>
  readonly reasoning: ReadonlyMap<string, string>
  readonly lineage: ReadonlyMap<string, string>
  readonly openAssistant?: string
  readonly status: SessionStatus
  readonly activeTurnId?: string
  readonly turnStartedAt?: number
  readonly activeRun?: TurnRun
  readonly lastTurnEnd?: { readonly turnId: string; readonly status: TurnEndItem["status"]; readonly at: number }
  /** How full the model's context was after its latest request, as the engine counted it. */
  readonly context?: ContextUsage
  readonly epoch: number
  readonly lastSeq: number
  readonly lastLiveSeq: number
  readonly counters: TimelineCounters
  readonly historyTruncated: boolean
}

const OUTPUT_TAIL = 32 * 1024
const MAX_ITEMS = 20_000

export function emptyTimeline(): Timeline {
  return {
    items: [],
    index: new Map(),
    calls: new Map(),
    approvals: new Map(),
    reasoning: new Map(),
    lineage: new Map(),
    status: "idle",
    epoch: 0,
    lastSeq: -1,
    lastLiveSeq: 0,
    counters: { events: 0, live: 0, rejected: 0, duplicates: 0 },
    historyTruncated: false,
  }
}

/** Starts a new engine process epoch: sequence numbers restart, keys stay unique. */
export function beginEpoch(timeline: Timeline, afterSeq = -1, afterLiveSeq = 0): Timeline {
  return { ...timeline, epoch: timeline.epoch + 1, lastSeq: afterSeq, lastLiveSeq: afterLiveSeq, openAssistant: undefined, reasoning: new Map() }
}

class Draft {
  items: TimelineItem[]
  index: Map<string, number>
  calls: Map<string, string>
  approvals: Map<string, string>
  reasoning: Map<string, string>
  lineage: Map<string, string>
  openAssistant?: string
  status: SessionStatus
  activeTurnId?: string
  turnStartedAt?: number
  activeRun?: TurnRun
  lastTurnEnd?: Timeline["lastTurnEnd"]
  context?: ContextUsage
  epoch: number
  lastSeq: number
  lastLiveSeq: number
  counters: { events: number; live: number; rejected: number; duplicates: number }
  historyTruncated: boolean

  constructor(source: Timeline) {
    this.items = source.items.slice()
    this.index = new Map(source.index)
    this.calls = new Map(source.calls)
    this.approvals = new Map(source.approvals)
    this.reasoning = new Map(source.reasoning)
    this.lineage = new Map(source.lineage)
    this.openAssistant = source.openAssistant
    this.status = source.status
    this.activeTurnId = source.activeTurnId
    this.turnStartedAt = source.turnStartedAt
    this.activeRun = source.activeRun
    this.lastTurnEnd = source.lastTurnEnd
    this.context = source.context
    this.epoch = source.epoch
    this.lastSeq = source.lastSeq
    this.lastLiveSeq = source.lastLiveSeq
    this.counters = { ...source.counters }
    this.historyTruncated = source.historyTruncated
  }

  key(kind: string, id: string | number): string {
    return `${String(this.epoch)}.${kind}.${String(id)}`
  }

  get(key: string | undefined): TimelineItem | undefined {
    if (key === undefined) return undefined
    const position = this.index.get(key)
    return position === undefined ? undefined : this.items[position]
  }

  push(item: TimelineItem): void {
    if (this.index.has(item.key)) {
      this.set(item)
      return
    }
    this.index.set(item.key, this.items.length)
    this.items.push(item)
  }

  set(item: TimelineItem): void {
    const position = this.index.get(item.key)
    if (position !== undefined) this.items[position] = item
  }

  /**
   * Adds a finished turn's late item, such as its check result, above the messages sent after it
   * that no turn has started on yet: a queued message is sent the moment the turn ends.
   */
  pushBeforeWaiting(item: TimelineItem): void {
    let position = this.items.length
    while (this.activeTurnId === undefined && position > 0 && this.items[position - 1]!.kind === "user") position -= 1
    if (position === this.items.length || this.index.has(item.key)) {
      this.push(item)
      return
    }
    this.items.splice(position, 0, item)
    for (let at = position; at < this.items.length; at += 1) this.index.set(this.items[at]!.key, at)
  }

  finish(): Timeline {
    if (this.items.length > MAX_ITEMS) {
      this.items = this.items.slice(this.items.length - MAX_ITEMS)
      this.index = new Map(this.items.map((item, position) => [item.key, position]))
      this.historyTruncated = true
    }
    return {
      items: this.items,
      index: this.index,
      calls: this.calls,
      approvals: this.approvals,
      reasoning: this.reasoning,
      lineage: this.lineage,
      openAssistant: this.openAssistant,
      status: this.status,
      activeTurnId: this.activeTurnId,
      turnStartedAt: this.turnStartedAt,
      ...(this.activeRun === undefined ? {} : { activeRun: this.activeRun }),
      lastTurnEnd: this.lastTurnEnd,
      ...(this.context === undefined ? {} : { context: this.context }),
      epoch: this.epoch,
      lastSeq: this.lastSeq,
      lastLiveSeq: this.lastLiveSeq,
      counters: this.counters,
      historyTruncated: this.historyTruncated,
    }
  }
}

/** Strips attachment bodies the engine appends to a prompt, leaving what the user typed. */
export function displayPrompt(text: string): string {
  const marker = text.indexOf("\n\n[Runrail ")
  return marker < 0 ? text : text.slice(0, marker)
}

export function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined
  const value = output as { stdout?: unknown; stderr?: unknown; output?: unknown; text?: unknown; content?: unknown }
  const parts = [value.stdout, value.stderr, value.output, value.text, value.content].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  )
  return parts.length === 0 ? undefined : parts.join("\n")
}

/**
 * The line counts and new-file flag a file write reported; nothing unless both counts are whole,
 * non-negative numbers. The engine's own loop sends a tool's result as JSON text, so a short
 * object in text counts too.
 */
export function writeCounts(result: unknown): { readonly additions?: number; readonly deletions?: number; readonly created?: boolean } {
  const output = typeof result === "string" ? smallJson(result) : result
  if (output === null || typeof output !== "object" || Array.isArray(output)) return {}
  const value = output as { additions?: unknown; deletions?: unknown; created?: unknown }
  const count = (entry: unknown): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0
  if (!count(value.additions) || !count(value.deletions)) return {}
  return { additions: value.additions, deletions: value.deletions, ...(typeof value.created === "boolean" ? { created: value.created } : {}) }
}

function smallJson(text: string): unknown {
  if (text.length > 1_024 || !text.startsWith("{")) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function tail(value: string, max = OUTPUT_TAIL): string {
  return value.length <= max ? value : value.slice(value.length - max)
}

function fallbackPresentation(name: string): ToolPresentation {
  return { kind: name === "agent" || name === "task" ? "agent" : "other", title: name }
}

function closeReasoning(draft: Draft, turnId: string | undefined, at: number): void {
  for (const [id, key] of draft.reasoning) {
    const item = draft.get(key)
    if (item?.kind !== "reasoning") continue
    if (turnId !== undefined && item.turnId !== undefined && item.turnId !== turnId) continue
    draft.set({ ...item, streaming: false, endedAt: item.endedAt ?? at })
    draft.reasoning.delete(id)
  }
}

function closeAssistant(draft: Draft, turnId?: string): void {
  for (const item of draft.items) {
    if (item.kind === "assistant" && item.streaming && (turnId === undefined || item.turnId === turnId)) draft.set({ ...item, streaming: false })
  }
  const open = draft.get(draft.openAssistant)
  if (turnId === undefined || (open?.kind === "assistant" && open.turnId === turnId)) draft.openAssistant = undefined
}

/** The native loop reports a turn the user stopped as a failure; on screen it is a stop. */
const TURN_CANCELLED = "TURN_CANCELLED"
export const API_RETRY = "api.retry"

/** The engine names a stop the person asked for "user", "cancelled", or "interrupted"; others say why. */
export function stopCause(reason: string | undefined): TurnEndItem["stopCause"] {
  if (reason === undefined) return undefined
  if (/time(?:d)?\s*out|timeout/i.test(reason)) return "timeout"
  return /\bclosed\b/i.test(reason) ? "closed" : undefined
}

type RunCarrier = Pick<TurnRun, "backend" | "model" | "connectionId">

function runFor(value: RunCarrier | undefined, fallback?: TurnRun): TurnRun | undefined {
  const backend = value?.backend ?? fallback?.backend
  const model = value?.model ?? fallback?.model
  const connectionId = value?.connectionId ?? fallback?.connectionId
  if (backend === undefined && model === undefined && connectionId === undefined) return undefined
  return { ...(backend === undefined ? {} : { backend }), ...(model === undefined ? {} : { model }), ...(connectionId === undefined ? {} : { connectionId }) }
}

function runFields(run: TurnRun | undefined): TurnRun {
  return run === undefined ? {} : run
}

function closeTurn(draft: Draft, at: number, status: TurnEndItem["status"], stopCause?: TurnEndItem["stopCause"]): void {
  closeAssistant(draft)
  closeReasoning(draft, undefined, at)
  for (const [callId, key] of draft.calls) {
    const item = draft.get(key)
    if (item?.kind === "tool" && item.agentStatus === "running") draft.set({ ...item, agentStatus: status === "completed" ? "ok" : "failed", endedAt: at })
    if (item?.kind === "tool" && item.status === "running") {
      draft.set({ ...item, ...(item.agentStatus === undefined ? {} : { agentStatus: status === "completed" ? "ok" : "failed" }), status: "failed", errorCode: item.errorCode ?? (status === "stopped" ? "INTERRUPTED" : "TURN_ENDED"), endedAt: at })
    }
    void callId
  }
  for (const key of draft.approvals.values()) {
    const item = draft.get(key)
    if (item?.kind === "approval" && item.status === "pending") draft.set({ ...item, status: "rejected" })
  }
  for (const item of draft.items) if (item.kind === "review" && item.decision === "reviewing") draft.set({ ...item, decision: "aborted" })
  const turnId = draft.activeTurnId
  if (turnId !== undefined) {
    const run = draft.activeRun
    draft.push({ kind: "turn-end", key: draft.key("te", turnId), turnId, status, startedAt: draft.turnStartedAt ?? at, endedAt: at, ...(stopCause === undefined ? {} : { stopCause }), ...runFields(run) })
    draft.lastTurnEnd = { turnId, status, at }
  }
  draft.activeTurnId = undefined
  draft.turnStartedAt = undefined
  draft.activeRun = undefined
}

/** The row a review opened, live or loaded from history in this turn, or the key for a new one. */
function reviewKey(draft: Draft, reviewId: string): string {
  const live = draft.key("rv", reviewId)
  if (draft.index.has(live)) return live
  for (let position = draft.items.length - 1; position >= 0; position -= 1) {
    const item = draft.items[position]
    if (item?.kind === "review" && item.reviewId === reviewId) return item.key
    if (item?.kind === "turn-end") break
  }
  return live
}

function latestRunningCall(draft: Draft, turnId: string): string | undefined {
  for (let position = draft.items.length - 1; position >= 0; position -= 1) {
    const item = draft.items[position]
    if (item?.kind === "tool" && item.turnId === turnId && item.status === "running") return item.key
    if (item?.kind === "user") break
  }
  return undefined
}

function matchUser(draft: Draft, prompt: string): UserItem | undefined {
  const wanted = displayPrompt(prompt).trim()
  for (let position = draft.items.length - 1; position >= 0; position -= 1) {
    const item = draft.items[position]
    if (item?.kind !== "user" || item.turnId !== undefined) continue
    if (item.state === "sending" || item.text.trim() === wanted) return item
  }
  return undefined
}

function applyEvent(draft: Draft, event: AgentEvent, fallbackRun?: TurnRun): void {
  switch (event.type) {
    case "session.started":
    case "session.updated": {
      draft.status = event.snapshot.status
      if (event.snapshot.status === "running" && event.snapshot.activeTurnId !== undefined && draft.activeTurnId === undefined) {
        draft.activeTurnId = event.snapshot.activeTurnId
        draft.turnStartedAt = event.at
        draft.activeRun = fallbackRun
      }
      return
    }
    case "turn.started": {
      if (draft.activeTurnId !== undefined && draft.activeTurnId !== event.turnId) closeTurn(draft, event.at, "completed")
      draft.status = "running"
      draft.activeTurnId = event.turnId
      draft.turnStartedAt = event.at
      draft.activeRun = runFor(event, fallbackRun)
      const pending = matchUser(draft, event.prompt)
      const recall = recalledIn(event.prompt)
      if (pending !== undefined) {
        draft.set({ ...pending, turnId: event.turnId, state: "sent", ...recall })
        return
      }
      const text = displayPrompt(event.prompt)
      if (text.trim().length === 0) return
      draft.push({ kind: "user", key: draft.key("u", event.turnId), turnId: event.turnId, text, attachments: 0, state: "sent", ...recall, at: event.at })
      return
    }
    case "assistant.delta": {
      if (event.text.length === 0) return
      closeReasoning(draft, event.turnId, event.at)
      const open = [...draft.items].reverse().find((item) => item.kind === "assistant" && item.streaming && item.turnId === event.turnId)
      const parentCallId = draft.lineage.get(`event:${String(event.seq)}`)
      if (open?.kind === "assistant" && open.turnId === event.turnId) {
        draft.set({ ...open, text: open.text + event.text, eventSeq: event.seq, ...(parentCallId === undefined ? {} : { parentCallId }) })
        return
      }
      const key = draft.key("a", event.seq)
      draft.push({ kind: "assistant", key, turnId: event.turnId, text: event.text, streaming: true, eventSeq: event.seq, ...(parentCallId === undefined ? {} : { parentCallId }), at: event.at })
      draft.openAssistant = key
      return
    }
    case "assistant.message": {
      closeReasoning(draft, event.turnId, event.at)
      const open = [...draft.items].reverse().find((item) => item.kind === "assistant" && item.streaming && item.turnId === event.turnId)
      const parentCallId = draft.lineage.get(`event:${String(event.seq)}`)
      draft.openAssistant = undefined
      if (open?.kind === "assistant" && open.turnId === event.turnId) {
        draft.set({ ...open, text: event.text.length > 0 ? event.text : open.text, streaming: false, eventSeq: event.seq, ...(parentCallId === undefined ? {} : { parentCallId }) })
        return
      }
      if (event.text.length === 0) return
      draft.push({ kind: "assistant", key: draft.key("a", event.seq), turnId: event.turnId, text: event.text, streaming: false, eventSeq: event.seq, ...(parentCallId === undefined ? {} : { parentCallId }), at: event.at })
      return
    }
    case "tool.started": {
      closeAssistant(draft, event.turnId)
      closeReasoning(draft, event.turnId, event.at)
      const existingKey = draft.calls.get(event.callId)
      const existing = draft.get(existingKey)
      const parentCallId = draft.lineage.get(event.callId)
      const presentation = event.presentation ?? fallbackPresentation(event.name)
      if (existing?.kind === "tool") {
        draft.set({ ...existing, name: event.name, presentation, turnId: event.turnId, ...(parentCallId === undefined ? {} : { parentCallId }) })
        return
      }
      const key = draft.key("t", event.callId)
      draft.calls.set(event.callId, key)
      draft.push({
        kind: "tool",
        key,
        callId: event.callId,
        turnId: event.turnId,
        name: event.name,
        presentation,
        status: "running",
        ...(parentCallId === undefined ? {} : { parentCallId }),
        at: event.at,
      })
      return
    }
    case "tool.delta": {
      const item = draft.get(draft.calls.get(event.callId))
      if (item?.kind === "tool") draft.set({ ...item, output: tail((item.output ?? "") + event.text) })
      return
    }
    case "tool.completed": {
      let item = draft.get(draft.calls.get(event.callId))
      if (item?.kind !== "tool") {
        const key = draft.key("t", event.callId)
        draft.calls.set(event.callId, key)
        item = {
          kind: "tool",
          key,
          callId: event.callId,
          turnId: event.turnId,
          name: event.name,
          presentation: fallbackPresentation(event.name),
          status: "running",
          at: event.at,
        }
        draft.push(item)
      }
      const output = outputText(event.output)
      if (event.ok && item.presentation.title.startsWith("Message agent") && item.presentation.content !== undefined) {
        const sender = item.parentCallId === undefined ? undefined : draft.get(draft.calls.get(item.parentCallId))
        const name = sender?.kind === "tool" ? sender.agent?.title ?? sender.presentation.title : "Main agent"
        const target = item.presentation.title.slice("Message agent".length).replace(/^:\s*/, "") || "another agent"
        draft.push({ kind: "notice", key: draft.key("n", `agent.message:${event.callId}`), turnId: event.turnId, level: "info", code: "agent.message", message: `${name} sent a message to ${target}: ${item.presentation.content}`, at: event.at })
      }
      draft.set({
        ...item,
        status: event.ok ? "ok" : "failed",
        ...(output === undefined ? {} : { output: tail(output) }),
        ...(event.ok ? writeCounts(event.output) : {}),
        ...(!event.ok && event.error?.code !== undefined ? { errorCode: event.error.code } : {}),
        ...(!event.ok && event.error?.message !== undefined ? { errorMessage: event.error.message.slice(0, 1024) } : {}),
        endedAt: event.at,
      })
      return
    }
    case "approval.required": {
      const key = draft.key("ap", event.approvalId)
      draft.approvals.set(event.approvalId, key)
      draft.status = "waiting"
      const callKey = latestRunningCall(draft, event.turnId)
      draft.push({
        kind: "approval",
        key,
        approvalId: event.approvalId,
        turnId: event.turnId,
        action: event.action,
        capability: event.capability,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        status: "pending",
        ...(event.questions === undefined ? {} : { questions: event.questions }),
        ...(event.questions !== undefined && event.takesFollowUp === true ? { takesFollowUp: true } : {}),
        ...(callKey === undefined ? {} : { callKey }),
        at: event.at,
      })
      return
    }
    case "approval.resolved": {
      const item = draft.get(draft.approvals.get(event.approvalId))
      const withdrawn = event.withdrawn === true && !event.approved
      const denial = !event.approved && !withdrawn ? event.reason : undefined
      const followUp = event.approved && event.followUp === true ? { followUp: true as const, ...(event.note === undefined || event.note.length === 0 ? {} : { note: event.note }) } : {}
      if (item?.kind === "approval") draft.set({ ...item, status: event.approved ? "approved" : "rejected", ...(event.answers === undefined ? {} : { answers: event.answers }), ...(withdrawn ? { withdrawn: true } : {}), ...(denial === undefined ? {} : { denial }), ...followUp })
      if (draft.status === "waiting") draft.status = "running"
      return
    }
    case "repair.required":
      draft.push({ kind: "notice", key: draft.key("n", event.seq), level: "error", code: "repair.required", ...(event.task.reason === undefined ? {} : { message: event.task.reason.slice(0, 1024) }), at: event.at })
      return
    case "verification.completed":
      draft.pushBeforeWaiting({
        kind: "notice",
        key: draft.key("n", event.seq),
        level: event.ok ? "info" : "error",
        code: event.ok ? "verification.passed" : "verification.failed",
        name: event.name,
        at: event.at,
      })
      return
    case "memory.compacted": {
      const sized = event.before > 0 && event.after > 0 && event.after < event.before
      draft.push({ kind: "notice", key: draft.key("n", event.seq), level: "info", code: "compacted", name: event.reason, ...(sized ? { sizes: { before: event.before, after: event.after } } : {}), at: event.at })
      return
    }
    case "extension.reloaded":
      draft.push({ kind: "notice", key: draft.key("n", event.seq), level: event.rolledBack === true ? "error" : "info", code: "extensions.reloaded", at: event.at })
      return
    case "session.completed":
      draft.status = event.snapshot.status === "running" ? "completed" : event.snapshot.status
      closeTurn(draft, event.at, "completed")
      return
    case "session.failed":
      if (event.error.code === TURN_CANCELLED) {
        draft.status = "stopped"
        closeTurn(draft, event.at, "stopped")
        return
      }
      draft.status = "failed"
      closeTurn(draft, event.at, "failed")
      draft.push({
        kind: "notice",
        key: draft.key("n", event.seq),
        level: "error",
        code: event.error.code ?? "SESSION_FAILED",
        ...(event.error.message === undefined ? {} : { message: event.error.message.slice(0, 1024) }),
        at: event.at,
      })
      return
    case "session.stopped":
      draft.status = "stopped"
      closeTurn(draft, event.at, "stopped", stopCause(event.reason))
      return
  }
}

function applyLive(draft: Draft, frame: LiveFrame): void {
  const at = frame.at ?? Date.now()
  switch (frame.type) {
    case "reasoning.delta": {
      if (frame.text.length === 0) return
      const id = `${frame.turnId ?? "-"}.${frame.itemId ?? "-"}.${frame.parentCallId ?? "-"}`
      const item = draft.get(draft.reasoning.get(id))
      if (item?.kind === "reasoning") {
        draft.set({ ...item, text: item.text + frame.text })
        return
      }
      const key = draft.key("r", `${id}.${String(frame.liveSeq)}`)
      draft.reasoning.set(id, key)
      draft.push({ kind: "reasoning", key, ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }), ...(frame.parentCallId === undefined ? {} : { parentCallId: frame.parentCallId }), text: frame.text, streaming: true, at })
      return
    }
    case "reasoning.completed": {
      const id = `${frame.turnId ?? "-"}.${frame.itemId ?? "-"}.${frame.parentCallId ?? "-"}`
      const item = draft.get(draft.reasoning.get(id))
      draft.reasoning.delete(id)
      if (item?.kind === "reasoning") draft.set({ ...item, text: frame.text ?? item.text, streaming: false, endedAt: at })
      else if (frame.text !== undefined && frame.text.length > 0)
        draft.push({ kind: "reasoning", key: draft.key("r", `${id}.${String(frame.liveSeq)}`), ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }), ...(frame.parentCallId === undefined ? {} : { parentCallId: frame.parentCallId }), text: frame.text, streaming: false, at, endedAt: at })
      return
    }
    case "plan.updated": {
      const key = draft.key("pl", frame.turnId ?? frame.callId ?? "session")
      const existing = draft.get(key)
      const next: PlanItem = {
        kind: "plan",
        key,
        ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }),
        ...(frame.explanation === undefined ? {} : { explanation: frame.explanation }),
        steps: frame.steps,
        at: existing?.kind === "plan" ? existing.at : at,
      }
      draft.push(next)
      return
    }
    case "agent.spawned": {
      const agent = { title: frame.title, ...(frame.agentType === undefined ? {} : { agentType: frame.agentType }) }
      if (frame.parentCallId !== undefined) draft.lineage.set(frame.callId, frame.parentCallId)
      const item = draft.get(draft.calls.get(frame.callId))
      if (item?.kind === "tool") {
        draft.set({ ...item, agent, agentStatus: "running", ...(frame.parentCallId === undefined ? {} : { parentCallId: frame.parentCallId }) })
        return
      }
      const key = draft.key("t", frame.callId)
      draft.calls.set(frame.callId, key)
      draft.push({
        kind: "tool",
        key,
        callId: frame.callId,
        ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }),
        name: "agent",
        presentation: { kind: "agent", title: frame.title },
        status: "running",
        agent,
        agentStatus: "running",
        ...(frame.parentCallId === undefined ? {} : { parentCallId: frame.parentCallId }),
        at,
      })
      return
    }
    case "agent.completed": {
      const item = draft.get(draft.calls.get(frame.callId))
      if (item?.kind === "tool" && item.agentStatus !== (frame.ok ? "ok" : "failed")) {
        draft.push({ kind: "notice", key: draft.key("n", `agent.completed:${frame.callId}:${String(item.at)}`), ...(item.turnId === undefined ? {} : { turnId: item.turnId }), level: frame.ok ? "info" : "error", code: "agent.completed", name: item.agent?.title ?? item.presentation.title, message: frame.ok ? `${item.agent?.title ?? item.presentation.title} completed its work.` : `${item.agent?.title ?? item.presentation.title} failed.`, at })
      }
      if (item?.kind === "tool") draft.set({ ...item, status: frame.ok ? "ok" : "failed", agentStatus: frame.ok ? "ok" : "failed", endedAt: at })
      for (const child of draft.items) {
        if ((child.kind === "assistant" || child.kind === "reasoning") && child.parentCallId === frame.callId && child.streaming) draft.set({ ...child, streaming: false, ...(child.kind === "reasoning" ? { endedAt: at } : {}) })
      }
      for (const [id, key] of draft.reasoning) {
        const thought = draft.get(key)
        if (thought?.kind === "reasoning" && thought.parentCallId === frame.callId) draft.reasoning.delete(id)
      }
      return
    }
    case "background.state": {
      const entry = frame.entry
      if (entry.kind !== "agent" || entry.callId === undefined) return
      const item = draft.get(draft.calls.get(entry.callId))
      if (item?.kind !== "tool") return
      const agentStatus = entry.status === "running" ? "running" : entry.status === "completed" ? "ok" : "failed"
      draft.set({ ...item, agentStatus, ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }) })
      return
    }
    case "context.usage": {
      // A tool that names the window only at the end of a turn sends counts without it in between.
      const previous = draft.context
      const windowTokens = frame.windowTokens ?? previous?.windowTokens
      // Only a full read names the auto-compact point; it holds while the window stays the same.
      const autoCompactAt = frame.autoCompactAt ?? (windowTokens === previous?.windowTokens ? previous?.autoCompactAt : undefined)
      draft.context = { usedTokens: frame.usedTokens, ...(windowTokens === undefined ? {} : { windowTokens }), ...(autoCompactAt === undefined ? {} : { autoCompactAt }), estimated: frame.estimated }
      return
    }
    case "model.notice":
      draft.push({ kind: "notice", key: draft.key("n", `live.${String(frame.liveSeq)}`), level: "info", code: "thinking.refused", name: frame.thinking, at })
      return
    // The engine records the refusal too; a reload rebuilds the timeline from that record and resumes past this frame.
    case "request.refused":
      draft.push({ kind: "notice", key: draft.key("n", `live.${String(frame.liveSeq)}`), level: "info", code: "request.refused", name: frame.source, message: frame.message, at })
      return
    // Recorded like a refusal. A decision after a reload finds the row history rebuilt, so the review stays one row.
    case "approval.reviewed": {
      const key = reviewKey(draft, frame.reviewId)
      const open = draft.get(key)
      const was = open?.kind === "review" ? open : undefined
      // A late start never takes back a decision.
      if (was !== undefined && frame.decision === "reviewing") return
      draft.push({
        ...was,
        kind: "review",
        key,
        reviewId: frame.reviewId,
        ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }),
        reviewer: frame.reviewer,
        decision: frame.decision,
        action: frame.action,
        capability: frame.capability,
        ...(frame.risk === undefined ? {} : { risk: frame.risk }),
        ...(frame.source === undefined ? {} : { source: frame.source }),
        ...(frame.detail === undefined ? {} : { detail: frame.detail }),
        ...(frame.rationale === undefined ? {} : { rationale: frame.rationale }),
        at: was?.at ?? at,
      })
      return
    }
    case "reviewer.notice":
      draft.push({ kind: "notice", key: draft.key("n", `live.${String(frame.liveSeq)}`), level: "info", code: `reviewer.${frame.notice}`, name: frame.reviewer, ...(frame.message === undefined ? {} : { message: frame.message }), at })
      return
    // Folded as the engine folds them when it rebuilds from its record: one request's retries count up in one row.
    case "api.retry": {
      const retry: ApiRetry = { attempt: frame.attempt, maxRetries: frame.maxRetries, delayMs: frame.delayMs, ...(frame.status === undefined ? {} : { status: frame.status }), ...(frame.error === undefined ? {} : { error: frame.error }), ...(frame.waitedMs === undefined ? {} : { waitedMs: frame.waitedMs }) }
      const last = draft.items[draft.items.length - 1]
      // A row rebuilt from the record has no turn; the last item is still this turn's.
      const counting = last?.kind === "notice" && last.code === API_RETRY && (last.turnId ?? frame.turnId) === frame.turnId && (last.retry?.attempt ?? Infinity) < retry.attempt ? last : undefined
      draft.push({ kind: "notice", key: counting?.key ?? draft.key("n", `live.${String(frame.liveSeq)}`), ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }), level: "info", code: API_RETRY, name: frame.source, retry, at: counting?.at ?? at })
      return
    }
    case "lineage": {
      if (frame.eventSeq !== undefined) {
        const key = `event:${String(frame.eventSeq)}`
        draft.lineage.set(key, frame.parentCallId)
        if (draft.lineage.size > MAX_ITEMS) draft.lineage.delete(draft.lineage.keys().next().value!)
        const item = draft.items.find((entry) => entry.kind === "assistant" && entry.eventSeq === frame.eventSeq)
        if (item?.kind === "assistant") draft.set({ ...item, parentCallId: frame.parentCallId })
      }
      if (frame.callId === undefined) return
      draft.lineage.set(frame.callId, frame.parentCallId)
      const item = draft.get(draft.calls.get(frame.callId))
      if (item?.kind === "tool" && item.parentCallId !== frame.parentCallId) draft.set({ ...item, parentCallId: frame.parentCallId })
      return
    }
  }
}

/** Applies one batch of stream frames. Duplicates (by sequence) and invalid frames are counted and dropped. */
export function applyFrames(timeline: Timeline, frames: readonly StreamFrame[], fallbackRun?: TurnRun): Timeline {
  if (frames.length === 0) return timeline
  const draft = new Draft(timeline)
  for (const frame of frames) {
    if (frame.kind === "event") {
      const parsed = AgentEventSchema.safeParse(frame.data)
      if (!parsed.success) {
        draft.counters.rejected += 1
        continue
      }
      if (parsed.data.seq <= draft.lastSeq) {
        draft.counters.duplicates += 1
        continue
      }
      draft.lastSeq = parsed.data.seq
      draft.counters.events += 1
      applyEvent(draft, parsed.data, fallbackRun)
    } else {
      const parsed = LiveFrameSchema.safeParse(frame.data)
      if (!parsed.success) {
        draft.counters.rejected += 1
        continue
      }
      if (parsed.data.liveSeq <= draft.lastLiveSeq) {
        draft.counters.duplicates += 1
        continue
      }
      draft.lastLiveSeq = parsed.data.liveSeq
      draft.counters.live += 1
      applyLive(draft, parsed.data)
    }
  }
  return draft.finish()
}

/**
 * Replaces the timeline with history rebuilt by the engine, keeping any not-yet-matched sends.
 * `live` means the engine that wrote the history is still in its last turn (the window reloaded and
 * reattached): that turn's open work is running, not interrupted.
 */
export function loadHistory(
  timeline: Timeline,
  rawItems: readonly unknown[],
  truncated: boolean,
  live = false,
  fallbackRun?: TurnRun,
  runHistory?: readonly TurnRunRecord[],
): Timeline {
  const draft = new Draft(emptyTimeline())
  draft.epoch = timeline.epoch
  draft.lastSeq = timeline.lastSeq
  draft.lastLiveSeq = timeline.lastLiveSeq
  draft.counters = { ...timeline.counters }
  draft.historyTruncated = truncated
  const parsedItems: ConversationItem[] = []
  for (const raw of rawItems) {
    const parsed = ConversationItemSchema.safeParse(raw)
    if (parsed.success) parsedItems.push(parsed.data)
    else draft.counters.rejected += 1
  }
  const recordedRuns = new Map((runHistory ?? []).map((run) => [run.turnId, run] as const))
  const liveTurn = live ? parsedItems[parsedItems.length - 1]?.turnId : undefined
  // The transcript keeps no turn ends, so a finished turn gets one here and folds as it did live.
  let open: { readonly turnId: string; readonly startedAt: number; endedAt: number; clean: boolean; run?: TurnRun } | undefined
  const closeTurn = (): void => {
    if (open !== undefined && open.clean && open.turnId !== liveTurn) draft.push({ kind: "turn-end", key: `h.end.${open.turnId}`, turnId: open.turnId, status: "completed", startedAt: open.startedAt, endedAt: open.endedAt, ...runFields(open.run) })
    open = undefined
  }
  for (const data of parsedItems) {
    if (data.turnId !== undefined && data.turnId !== open?.turnId) {
      closeTurn()
      open = { turnId: data.turnId, startedAt: data.at, endedAt: data.at, clean: true, run: runFor(data, recordedRuns.get(data.turnId) ?? fallbackRun) }
    }
    if (open !== undefined && data.turnId === open.turnId) {
      open.endedAt = data.at
      open.run = runFor(data, open.run)
      // A stopped or failed turn already says so in its own notice; an interrupted one never finished.
      if (data.kind === "notice" && (data.code === TURN_CANCELLED || data.level === "error")) open.clean = false
      if ((data.kind === "tool" && data.status === "running") || (data.kind === "approval" && data.status === "pending")) open.clean = false
    }
    // Where a thread moved or went back, the turn before it has ended.
    if (data.kind === "notice" && (data.code === "session.rewound" || data.code === "session.continued")) closeTurn()
    const item = historyItem(data, liveTurn, recordedRuns.get(data.turnId ?? "") ?? fallbackRun)
    if (liveTurn !== undefined && data.turnId === liveTurn) {
      if (draft.activeTurnId === undefined) draft.turnStartedAt = data.at
      draft.activeTurnId = liveTurn
      draft.activeRun = open?.run
      draft.status = item.kind === "approval" && item.status === "pending" ? "waiting" : "running"
    }
    if (item.kind === "tool") draft.calls.set(item.callId, item.key)
    if (item.kind === "approval") {
      draft.approvals.set(item.approvalId, item.key)
      // History keeps order, so the call an approval gated is the one just before it in its turn.
      const gate = item.turnId === undefined ? undefined : draft.items[draft.items.length - 1]
      draft.push(gate?.kind === "tool" && gate.turnId === item.turnId ? { ...item, callKey: gate.key } : item)
      continue
    }
    draft.push(item)
  }
  closeTurn()
  for (const item of timeline.items) if (item.kind === "user" && item.turnId === undefined && item.key.startsWith("p.")) draft.push(item)
  for (const item of timeline.items) if (item.kind === "notice" && item.code === "model.changed") draft.push(item)
  return draft.finish()
}

function historyItem(item: ConversationItem, liveTurn?: string, fallbackRun?: TurnRun): TimelineItem {
  const key = `h.${item.id}`
  const turn = item.turnId === undefined ? {} : { turnId: item.turnId }
  const run = runFor(item, fallbackRun)
  const open = liveTurn !== undefined && item.turnId === liveTurn
  switch (item.kind) {
    case "user":
      return { kind: "user", key, ...turn, ...runFields(run), text: displayPrompt(item.text), attachments: item.attachments ?? 0, state: "sent", ...(item.steer === true ? { steer: true } : {}), ...recalledIn(item.text), at: item.at }
    case "assistant":
      return { kind: "assistant", key, ...turn, ...runFields(run), text: item.text, streaming: false, at: item.at }
    case "tool":
      return {
        kind: "tool",
        key,
        callId: item.callId,
        ...turn,
        ...runFields(run),
        name: item.name,
        presentation: item.presentation,
        status: item.status === "running" && !open ? "failed" : item.status,
        ...(item.status === "running" && !open ? { errorCode: "INTERRUPTED" } : {}),
        ...(item.output === undefined ? {} : { output: item.output }),
        ...writeCounts(item),
        ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
        at: item.at,
      }
    case "approval":
      return {
        kind: "approval",
        key,
        approvalId: item.approvalId,
        ...turn,
        ...runFields(run),
        action: item.action,
        capability: item.capability,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        status: item.status === "pending" && !open ? "rejected" : item.status,
        ...(item.questions === undefined ? {} : { questions: item.questions }),
        ...(item.answers === undefined ? {} : { answers: item.answers }),
        ...(item.withdrawn === true && item.status === "rejected" ? { withdrawn: true } : {}),
        ...(item.denial === undefined || item.status !== "rejected" ? {} : { denial: item.denial }),
        ...(item.questions !== undefined && item.takesFollowUp === true ? { takesFollowUp: true } : {}),
        ...(item.followUp === true && item.status === "approved" ? { followUp: true, ...(item.note === undefined || item.note.length === 0 ? {} : { note: item.note }) } : {}),
        at: item.at,
      }
    case "review":
      return {
        kind: "review",
        key,
        ...turn,
        ...runFields(run),
        reviewId: item.reviewId,
        reviewer: item.reviewer,
        decision: item.decision === "reviewing" && !open ? "aborted" : item.decision,
        action: item.action,
        capability: item.capability,
        ...(item.risk === undefined ? {} : { risk: item.risk }),
        ...(item.source === undefined ? {} : { source: item.source }),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.rationale === undefined ? {} : { rationale: item.rationale }),
        at: item.at,
      }
    case "notice":
      if (item.code === TURN_CANCELLED) return { kind: "notice", key, level: "info", code: "stopped", at: item.at }
      return { kind: "notice", key, ...runFields(run), level: item.level, code: item.code, ...(item.name === undefined ? {} : { name: item.name }), ...(item.message === undefined ? {} : { message: item.message }), ...(item.inTool === true ? { inTool: true as const } : {}), ...(item.turns === undefined ? {} : { turns: item.turns }), ...(item.retry === undefined ? {} : { retry: item.retry }), at: item.at }
  }
}

export interface SentAttachment {
  readonly path: string
  readonly kind: "file" | "image"
  readonly name: string
  readonly mediaType?: string
}

let pendingOrdinal = 0
let noticeOrdinal = 0

/** Adds a local informational row that is not supplied by the engine transcript. */
export function appendNotice(
  timeline: Timeline,
  input: { readonly code: string; readonly message?: string; readonly level?: NoticeItem["level"]; readonly turnId?: string; readonly at?: number },
): Timeline {
  noticeOrdinal += 1
  const draft = new Draft(timeline)
  draft.push({
    kind: "notice",
    key: draft.key("n", `local.${input.code}.${String(Date.now())}.${String(noticeOrdinal)}`),
    level: input.level ?? "info",
    code: input.code,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.message === undefined ? {} : { message: input.message }),
    at: input.at ?? Date.now(),
  })
  return draft.finish()
}

/** Adds an optimistic user message; `turn.started` claims it. */
export function addPendingUser(
  timeline: Timeline,
  input: { readonly text: string; readonly attachments: number; readonly images?: readonly string[]; readonly sent?: readonly SentAttachment[]; readonly steer?: boolean; readonly requestId?: string },
): { readonly timeline: Timeline; readonly key: string } {
  pendingOrdinal += 1
  const key = `p.${String(Date.now())}.${String(pendingOrdinal)}`
  const draft = new Draft(timeline)
  draft.push({
    kind: "user",
    key,
    text: input.text,
    attachments: input.attachments,
    ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
    ...(input.sent === undefined || input.sent.length === 0 ? {} : { sent: input.sent }),
    state: input.steer === true ? "sent" : "sending",
    ...(input.steer === true ? { steer: true } : {}),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    at: Date.now(),
  })
  return { timeline: draft.finish(), key }
}

export function markUser(timeline: Timeline, key: string, state: UserItem["state"], errorCode?: string, errorMessage?: string): Timeline {
  const draft = new Draft(timeline)
  const item = draft.get(key)
  if (item?.kind !== "user") return timeline
  if (state === "failed" && item.turnId !== undefined) return timeline
  if (state === "sent" && item.state !== "sending") return timeline
  draft.set({ ...item, state, ...(errorCode === undefined ? {} : { errorCode }), ...(errorMessage === undefined ? {} : { errorMessage: errorMessage.slice(0, 512) }) })
  return draft.finish()
}

export function removeItem(timeline: Timeline, key: string): Timeline {
  if (!timeline.index.has(key)) return timeline
  const items = timeline.items.filter((item) => item.key !== key)
  return { ...timeline, items, index: new Map(items.map((item, position) => [item.key, position])) }
}

/** Marks the engine as gone: running work cannot finish anymore. */
export function markEngineExited(timeline: Timeline, at = Date.now()): Timeline {
  if (timeline.activeTurnId === undefined && timeline.status !== "running" && timeline.status !== "waiting") return timeline
  const draft = new Draft(timeline)
  closeTurn(draft, at, "failed")
  draft.status = "failed"
  draft.push({ kind: "notice", key: draft.key("n", `exit.${String(at)}`), level: "error", code: "ENGINE_EXITED", at })
  return draft.finish()
}

/** Whether what the thread waits on is a coding tool's question, which is answered rather than approved. */
export function asksQuestion(timeline: Timeline | undefined): boolean {
  return timeline !== undefined && pendingApprovals(timeline).some((item) => item.questions !== undefined)
}

export function pendingApprovals(timeline: Timeline): readonly ApprovalItem[] {
  const result: ApprovalItem[] = []
  for (const key of timeline.approvals.values()) {
    const position = timeline.index.get(key)
    const item = position === undefined ? undefined : timeline.items[position]
    if (item?.kind === "approval" && item.status === "pending") result.push(item)
  }
  return result
}

export function latestPlan(timeline: Timeline): { readonly steps: readonly PlanStep[]; readonly explanation?: string; readonly turnId?: string } | undefined {
  for (let position = timeline.items.length - 1; position >= 0; position -= 1) {
    const item = timeline.items[position]
    if (item?.kind === "plan") return item
    if (item?.kind === "tool" && item.presentation.plan !== undefined && item.presentation.plan.length > 0)
      return { steps: item.presentation.plan, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }
    if (item?.kind === "user" && position < timeline.items.length - 64) return undefined
  }
  return undefined
}

export function isBusy(timeline: Timeline): boolean {
  return timeline.activeTurnId !== undefined || timeline.status === "running" || timeline.status === "waiting"
}
