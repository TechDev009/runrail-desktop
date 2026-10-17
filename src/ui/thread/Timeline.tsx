import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, ChevronDown, ChevronRight, History, MessageSquare } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { create } from "zustand"
import { pinsFor, useLessonPins } from "../../app/learning"
import { learnLevel, placeLessons, type Lesson } from "../../app/lessons"
import { paneFocused, useApp, type ThreadRuntime } from "../../app/store"
import { findMatches, stepMatch } from "../../thread/find"
import { API_RETRY, isBusy, type ApprovalItem, type PlanItem, type TimelineItem, type ToolItem } from "../../thread/reducer"
import { duration, plural } from "../../lib/format"
import { cx, EmptyState, Spinner, useTicker } from "../common"
import { FlowerMark } from "../seasonal"
import { FindBar } from "./FindBar"
import { clearFind, paintFind, revealRange } from "./findPaint"
import { LessonCard } from "./Lesson"
import { QuestionCard } from "./QuestionCard"
import { AgentRow, ApprovalCard, AssistantRow, gateLabel, needsAttention, NoticeRow, PlanCard, proposedPlan, ReasoningRow, ReviewRow, StepsGroup, toolTitle, ToolRow, TurnEndRow, UserRow } from "./rows"
import { placeCards } from "../../app/prStatus"
import type { ThreadPullRequest } from "../../app/persist"
import { PullRequestCard } from "./PullRequests"
import { RememberCard } from "./Remember"
import { offersSuggestions, useMemory } from "../../app/memory"
import { openPanel } from "../../app/panels"
import { useTaskRows, type TaskRow } from "../../app/tasks"
import type { AgentChildItem } from "./rows"
import { runLabel } from "../../app/modelText"

/**
 * Virtualized conversation. Rows are derived from reducer items: subagent tool calls nest under
 * their parent, a run of tool calls folds into one row that says what it did, and a footer row
 * shows what the agent is doing right now. The list sticks to the bottom until the user
 * scrolls up, then offers a jump back.
 */

export type Row =
  | { readonly type: "history"; readonly key: string }
  | { readonly type: "item"; readonly key: string; readonly item: Exclude<TimelineItem, ToolItem>; readonly checks?: string; readonly folded?: boolean }
  | { readonly type: "tool"; readonly key: string; readonly item: ToolItem; readonly children?: readonly AgentChildItem[]; readonly approved?: boolean }
  /** Consecutive tool calls, folded into one line; `approved` holds the calls the user approved. */
  | { readonly type: "steps"; readonly key: string; readonly items: readonly ToolItem[]; readonly approved: ReadonlySet<string> }
  /** Learn mode's card for the call `anchor`, right after that call's row. */
  | { readonly type: "lesson"; readonly key: string; readonly anchor: string; readonly lesson: Lesson }
  /** A finished turn's work before its answer, folded into one line that opens. */
  | { readonly type: "work"; readonly key: string; readonly turnId: string; readonly took: number; readonly steps: number; readonly rows: readonly Row[]; readonly answerMissing?: boolean }
  | { readonly type: "footer"; readonly key: string }
  /** A pull request this thread saw appear, after the turn it appeared in. */
  | { readonly type: "pr"; readonly key: string; readonly number: number }
  /** "Remember this?" at the end of a thread at rest. */
  | { readonly type: "memory"; readonly key: string }

/** Browser actions (Runrail's own, or another MCP server's) click and type, so each keeps its own row. */
const BROWSER_TOOL = /(?:^|__)browser_[a-z_]+$/

/** A call joins a run unless it is a subagent, a proposed plan, a browser action, a push or PR (they leave this computer), or a failure to act on. */
function joinsRun(item: ToolItem): boolean {
  const { kind, intent } = item.presentation
  return kind !== "agent" && kind !== "plan" && item.agent === undefined && !BROWSER_TOOL.test(item.name) && intent !== "push" && intent !== "pr" && !needsAttention(item)
}

const STICK_THRESHOLD = 40

/**
 * A passed check next to its turn's end reads as part of that line, not as a row of its own. A
 * failed check stays a row: it is something to act on.
 */
function foldChecks(rows: Row[]): Row[] {
  const isEnd = (row: Row | undefined): row is Row & { type: "item" } => row?.type === "item" && row.item.kind === "turn-end" && row.checks === undefined
  const folded: Row[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const passed = row.type === "item" && row.item.kind === "notice" && row.item.code === "verification.passed" ? row.item : undefined
    if (passed !== undefined) {
      const label = `${gateLabel(passed.name)} passed`
      const before = folded[folded.length - 1]
      if (isEnd(before)) {
        folded[folded.length - 1] = { ...before, checks: label }
        continue
      }
      const after = rows[index + 1]
      if (isEnd(after)) {
        rows[index + 1] = { ...after, checks: label }
        continue
      }
    }
    folded.push(row)
  }
  return folded
}

interface RowContext {
  readonly children: ReadonlyMap<string, AgentChildItem[]>
  /** Calls the user approved; the call's row carries a quiet mark instead of an "Approved" line. */
  readonly approved: ReadonlySet<string>
  /** Calls waiting on an approval; the approval card shows them, so their own row waits. */
  readonly waiting: ReadonlySet<string>
  /** The latest plan of each turn, drawn once where the turn first planned. */
  readonly plans: ReadonlyMap<string, PlanItem>
  readonly planned: Set<string>
  readonly showReasoning: boolean
  readonly activeTurnId: string | undefined
  /** Learn mode's cards by the key of the call each explains. */
  readonly lessons: ReadonlyMap<string, Lesson>
  readonly tools: ReadonlyMap<string, ToolItem>
}

const NO_LESSONS: ReadonlyMap<string, Lesson> = new Map()

function turnKey(turnId: string | undefined): string {
  return turnId ?? ""
}

function rowContext(items: readonly TimelineItem[], showReasoning: boolean, activeTurnId: string | undefined, lessons: ReadonlyMap<string, Lesson>): RowContext {
  const children = new Map<string, AgentChildItem[]>()
  const approved = new Set<string>()
  const waiting = new Set<string>()
  const plans = new Map<string, PlanItem>()
  const tools = new Map<string, ToolItem>()
  for (const item of items) {
    if (item.kind === "tool") tools.set(item.key, item)
    if ((item.kind === "tool" || item.kind === "assistant" || item.kind === "reasoning") && item.parentCallId !== undefined) {
      const list = children.get(item.parentCallId) ?? []
      list.push(item)
      children.set(item.parentCallId, list)
    }
    if (item.kind === "approval" && item.callKey !== undefined) {
      // A question's card stands for the call that asked it, answered or not.
      if (item.questions !== undefined) waiting.add(item.callKey)
      else if (item.status === "approved") approved.add(item.callKey)
      else if (item.status === "pending") waiting.add(item.callKey)
    }
    const key = turnKey("turnId" in item ? item.turnId : undefined)
    if (item.kind === "plan") plans.set(key, { ...item, key: `plan:${key}` })
    if (item.kind === "tool" && item.presentation.kind === "plan" && item.presentation.plan !== undefined && item.presentation.plan.length > 0) {
      const explanation = plans.get(key)?.explanation
      plans.set(key, { kind: "plan", key: `plan:${key}`, ...(item.turnId === undefined ? {} : { turnId: item.turnId }), ...(explanation === undefined ? {} : { explanation }), steps: item.presentation.plan, at: item.at })
    }
  }
  return { children, approved, waiting, plans, planned: new Set(), showReasoning, activeTurnId, lessons, tools }
}

/** Rows for a run of items: subagent calls nest, consecutive calls fold, and each turn's plan shows once. */
function emitRows(list: readonly TimelineItem[], context: RowContext): Row[] {
  const rows: Row[] = []
  let run: ToolItem[] = []
  // A run holds at most one call with a card (see below), so one card follows each row.
  const teach = (calls: readonly ToolItem[]): void => {
    for (const call of calls) {
      const lesson = context.lessons.get(call.key)
      if (lesson === undefined) continue
      rows.push({ type: "lesson", key: `lesson:${call.key}`, anchor: call.key, lesson })
      return
    }
  }
  const flush = (): void => {
    if (run.length === 0) return
    const first = run[0]
    if (run.length === 1 && first !== undefined) rows.push({ type: "tool", key: first.key, item: first, ...(context.approved.has(first.key) ? { approved: true } : {}) })
    else if (first !== undefined) rows.push({ type: "steps", key: `x:${first.key}`, items: run, approved: new Set(run.filter((call) => context.approved.has(call.key)).map((call) => call.key)) })
    teach(run)
    run = []
  }
  // While its turn runs, the plan is pinned above the composer instead.
  const plan = (turnId: string | undefined): void => {
    const key = turnKey(turnId)
    const latest = context.plans.get(key)
    if (latest === undefined || context.planned.has(key) || (turnId !== undefined && turnId === context.activeTurnId)) return
    context.planned.add(key)
    flush()
    rows.push({ type: "item", key: latest.key, item: latest })
  }
  for (const item of list) {
    if ((item.kind === "assistant" || item.kind === "reasoning") && item.parentCallId !== undefined) continue
    if (item.kind === "tool") {
      if (item.parentCallId !== undefined) continue
      if (item.presentation.kind === "plan" && proposedPlan(item) === undefined) {
        plan(item.turnId)
        continue
      }
      if (context.waiting.has(item.key)) continue
      const direct = context.children.get(item.callId)
      const nested = direct === undefined ? undefined : [...direct]
      if (nested !== undefined) {
        const visited = new Set([item.callId])
        for (let at = 0; at < nested.length && at < 4096; at += 1) {
          const child = nested[at]
          if (child?.kind !== "tool" || visited.has(child.callId)) continue
          visited.add(child.callId)
          nested.push(...(context.children.get(child.callId) ?? []))
        }
      }
      if (nested === undefined && joinsRun(item)) {
        // A run carries one Learn card, so a call with a second one starts the next run.
        if (context.lessons.has(item.key) && run.some((call) => context.lessons.has(call.key))) flush()
        run.push(item)
        continue
      }
      flush()
      rows.push({ type: "tool", key: item.key, item, ...(nested === undefined ? {} : { children: nested }), ...(context.approved.has(item.key) ? { approved: true } : {}) })
      teach([item])
      continue
    }
    if (item.kind === "plan") {
      plan(item.turnId)
      continue
    }
    // An answered approval shows on its call's row; one with no call keeps its own line.
    if (item.kind === "approval" && item.status !== "pending" && item.callKey !== undefined && item.questions === undefined) continue
    if (item.kind === "reasoning" && (!context.showReasoning || (!item.streaming && item.text.trim().length === 0))) continue
    flush()
    rows.push({ type: "item", key: item.key, item })
    // A call waiting on approval shows as its approval card, so its lesson follows the card.
    const gate = item.kind === "approval" && item.callKey !== undefined ? context.tools.get(item.callKey) : undefined
    if (gate !== undefined) teach([gate])
  }
  flush()
  return rows
}

function countSteps(list: readonly TimelineItem[]): number {
  return list.filter((item) => item.kind === "tool" && item.parentCallId === undefined && (item.presentation.kind !== "plan" || proposedPlan(item) !== undefined)).length
}

/** Errors, check results, a call a reviewer stopped, and a reviewer that is off stay in view when a turn's work folds. */
function staysOut(item: TimelineItem): boolean {
  if (item.kind === "review") return item.decision === "denied" || item.decision === "timed-out"
  return item.kind === "notice" && (item.level === "error" || item.code.startsWith("agent.") || item.code.startsWith("verification.") || item.code === "reviewer.unavailable" || item.code === "model.changed" || item.code === "session.continued" || item.code === API_RETRY)
}

/**
 * The timeline as rows. A finished turn folds its work (thinking, commentary, tool calls) into one
 * "Worked for" line above its answer; important notices stay visible when work folds.
 */
export function buildRows(items: readonly TimelineItem[], showReasoning: boolean, truncated: boolean, footer: boolean, activeTurnId?: string, lessons: ReadonlyMap<string, Lesson> = NO_LESSONS): Row[] {
  const context = rowContext(items, showReasoning, activeTurnId, lessons)
  const rows: Row[] = []
  if (truncated) rows.push({ type: "history", key: "history" })
  let segment: TimelineItem[] = []
  for (const item of items) {
    if (item.kind === "user") {
      rows.push(...emitRows(segment, context), ...emitRows([item], context))
      segment = []
      continue
    }
    if (item.kind !== "turn-end") {
      segment.push(item)
      continue
    }
    let answer = -1
    for (let index = segment.length - 1; index >= 0; index -= 1) {
      const candidate = segment[index]
      if (candidate?.kind === "assistant" && candidate.parentCallId === undefined && candidate.text.trim().length > 0) {
        answer = index
        break
      }
    }
    const work = answer < 0 ? segment : segment.slice(0, answer)
    const inner = emitRows(work.filter((entry) => !staysOut(entry)), context)
    if (inner.length > 0) rows.push({ type: "work", key: `w:${item.key}`, turnId: item.turnId, took: Math.max(0, item.endedAt - item.startedAt), steps: countSteps(work), rows: inner, ...(answer < 0 && item.status === "completed" ? { answerMissing: true } : {}) })
    rows.push(...emitRows(work.filter(staysOut), context), ...emitRows(answer < 0 ? [] : segment.slice(answer), context), { type: "item", key: item.key, item, ...(inner.length > 0 ? { folded: true } : {}) })
    segment = []
  }
  rows.push(...emitRows(segment, context))
  if (footer) rows.push({ type: "footer", key: "footer" })
  return foldChecks(rows)
}

export interface RowPlace {
  readonly index: number
  /** The folded turn the item sits in. */
  readonly turnId?: string
  /** The folded run of calls the item sits in. */
  readonly group?: string
}

/** Where each item is drawn: its row, and the folds it sits in, if any. Items not drawn are absent. */
export function rowIndex(rows: readonly Row[]): ReadonlyMap<string, RowPlace> {
  const where = new Map<string, RowPlace>()
  const visit = (row: Row, place: RowPlace): void => {
    switch (row.type) {
      case "item":
        where.set(row.item.key, place)
        return
      case "tool":
        for (const item of [row.item, ...(row.children ?? [])]) where.set(item.key, place)
        return
      case "steps":
        for (const item of row.items) where.set(item.key, { ...place, group: row.key })
        return
      case "work":
        for (const inner of row.rows) visit(inner, { index: place.index, turnId: row.turnId })
        return
      default:
        return
    }
  }
  rows.forEach((row, index) => visit(row, { index }))
  return where
}

/** PR cards are off for now: the thread bar's PR chip already shows the PR and its checks. */
const SHOW_PR_CARDS = false

/** Puts each PR card after its turn's end, or by time when that turn is not loaded. */
export function withPullRequestCards(rows: Row[], cards: readonly ThreadPullRequest[] | undefined): Row[] {
  if (cards === undefined || !cards.some((card) => card.card)) return rows
  const shape = rows.map((row) => ({
    ...(row.type === "item" && row.item.kind === "turn-end" ? { turnEnd: row.item.turnId } : {}),
    ...((row.type === "item" || row.type === "tool") && "at" in row.item && typeof row.item.at === "number" ? { at: row.item.at } : row.type === "item" && row.item.kind === "turn-end" ? { at: row.item.endedAt } : {}),
    ...(row.type === "footer" ? { footer: true } : {}),
  }))
  const out = [...rows]
  for (const place of [...placeCards(shape, cards)].reverse()) out.splice(place.before, 0, { type: "pr", key: `pr:${String(place.number)}`, number: place.number })
  return out
}

/** Which rhythm a row keeps: tool rows sit close together, a new message has room above it. */
function rowKind(row: Row): string {
  if (row.type === "item") return row.item.kind
  return row.type === "steps" ? "tool" : row.type
}

/** Open folds are remembered per turn, so scrolling a folded turn out of view and back keeps it open. */
const useOpenWork = create<Readonly<Record<string, boolean>>>()(() => ({}))
/** Open runs of calls, by row key, kept the same way. */
const useOpenSteps = create<Readonly<Record<string, boolean>>>()(() => ({}))

function StepsRow({ row, workspace }: { readonly row: Row & { readonly type: "steps" }; readonly workspace?: string }) {
  const open = useOpenSteps((state) => state[row.key] === true)
  return <StepsGroup items={row.items} approved={row.approved} open={open} onToggle={() => useOpenSteps.setState({ [row.key]: !open })} {...(workspace === undefined ? {} : { workspace })} />
}

function WorkRow({ row, render }: { readonly row: Row & { readonly type: "work" }; readonly render: (row: Row) => ReactNode }) {
  const open = useOpenWork((state) => state[row.turnId] === true)
  return (
    <div className={cx("row-work", open && "is-open")}>
      <button type="button" className="disclosure work-head" onClick={() => useOpenWork.setState({ [row.turnId]: !open })} aria-expanded={open}>
        <span>{row.took < 1_000 ? "Worked" : `Worked for ${duration(row.took)}`}</span>
        {row.steps > 0 && <span className="work-steps">{plural(row.steps, "step")}</span>}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {row.answerMissing === true && <div className="muted">The agent finished without a final reply.</div>}
      {open && (
        <div className="work-body">
          {row.rows.map((inner) => (
            <div key={inner.key} className="work-row" data-kind={rowKind(inner)}>
              {render(inner)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AgentActivitySummary({ threadId, agents }: { readonly threadId: string; readonly agents: readonly TaskRow[] }) {
  if (agents.length === 0) return null
  const running = agents.filter((agent) => agent.status === "running").length
  return <button type="button" className="disclosure work-head" onClick={() => openPanel(threadId, "tasks")} aria-label={`Open agents: ${String(agents.length)} spawned, ${String(running)} running`}>
    <span>{plural(agents.length, "agent")} spawned</span>
    <span className="work-steps">{String(running)} running</span>
    <ChevronRight size={12} />
  </button>
}

function estimate(row: Row | undefined): number {
  if (row === undefined) return 40
  switch (row.type) {
    case "item":
      return row.item.kind === "assistant" ? 120 : row.item.kind === "user" ? 64 : row.item.kind === "approval" ? 150 : 40
    case "tool":
    case "steps":
      return 36
    case "lesson":
      return 64
    default:
      return 40
  }
}

export function WorkingFooter({ threadId, runtime }: { readonly threadId: string; readonly runtime: ThreadRuntime }) {
  const timeline = runtime.timeline
  const busy = isBusy(timeline)
  const now = useTicker(busy || runtime.engine === "starting")
  const thread = useApp((state) => state.threads.find((item) => item.id === threadId))
  if (runtime.engine === "starting")
    return (
      <div className="row-working">
        <span className="shimmer">Starting agent…</span> <Spinner size={13} />
      </div>
    )
  const since = timeline.turnStartedAt
  const run = timeline.activeRun ?? (thread === undefined ? undefined : { backend: thread.backend, model: thread.model, connectionId: thread.connectionId })
  return (
    <div className="row-working">
      <span className="shimmer">Working</span>
      {since !== undefined && <span className="muted">· {duration(now - since)}</span>}
      {run !== undefined && <span className="muted working-model">· {runLabel(run)}</span>}
      <span className="muted working-hint">Esc to stop</span>
      <Spinner size={13} />
    </div>
  )
}

export function Timeline({ threadId, runtime, workspace }: { readonly threadId: string; readonly runtime: ThreadRuntime; readonly workspace?: string }) {
  const tasks = useTaskRows(threadId)
  const agentTurn = runtime.timeline.activeTurnId ?? runtime.timeline.lastTurnEnd?.turnId
  const agentItems = runtime.timeline.items.filter((item): item is ToolItem => item.kind === "tool" && (item.agent !== undefined || item.presentation.kind === "agent") && item.turnId === agentTurn)
  const agents: TaskRow[] = agentItems.map((item) => ({ id: item.callId, kind: "agent", status: (item.agentStatus ?? item.status) === "running" ? "running" : (item.agentStatus ?? item.status) === "failed" ? "failed" : "completed", label: item.agent?.title ?? item.presentation.title }))
  for (const task of tasks.running) if (task.kind === "agent" && !agentItems.some((item) => item.callId === task.callId)) agents.push(task)
  const showReasoning = useApp((state) => state.prefs.reasoning !== "hidden")
  const compact = useApp((state) => state.prefs.density === "compact")
  const palette = useApp((state) => state.prefs.palette)
  const timeline = runtime.timeline
  const firstPending = useMemo(() => timeline.items.find((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending")?.key, [timeline.items])
  // A pending approval card says what the agent waits for; the working line would only repeat it.
  const footer = (isBusy(timeline) && firstPending === undefined) || runtime.engine === "starting"
  const activeTurnId = isBusy(timeline) ? timeline.activeTurnId : undefined
  const level = useApp((state) => learnLevel(state.prefs))
  const seen = useApp((state) => state.learning.seen)
  const pins = useLessonPins()
  const lessons = useMemo(() => (level === "off" ? NO_LESSONS : placeLessons(timeline.items, { level, seen: new Set(seen), pinned: pinsFor(pins, threadId) })), [timeline.items, level, seen, pins, threadId])
  const cards = useApp((state) => (SHOW_PR_CARDS ? state.threads.find((thread) => thread.id === threadId)?.pullRequests : undefined))
  const suggestions = useMemory((state) => state.suggestions[threadId])
  const remember = suggestions !== "dismissed" && (suggestions !== undefined || (!isBusy(timeline) && offersSuggestions(threadId, timeline.items)))
  const rows = useMemo(() => {
    const built = withPullRequestCards(buildRows(timeline.items, showReasoning, timeline.historyTruncated, footer, activeTurnId, lessons), cards)
    return remember ? [...built, { type: "memory" as const, key: "memory" }] : built
  }, [timeline.items, showReasoning, timeline.historyTruncated, footer, activeTurnId, lessons, cards, remember])

  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [detached, setDetached] = useState(false)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimate(rows[index]),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
    paddingStart: 20,
    paddingEnd: 24,
  })

  const toBottom = useCallback(() => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [])

  // New thread: reset stickiness and jump to the end once history is in.
  useLayoutEffect(() => {
    stick.current = true
    setDetached(false)
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, runtime.historyLoaded])

  const total = virtualizer.getTotalSize()
  useLayoutEffect(() => {
    if (stick.current) toBottom()
  }, [total, rows.length, toBottom])

  // The latest reply of a thread at rest keeps its actions in view.
  const lastAnswer = useMemo(() => {
    if (isBusy(timeline)) return undefined
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index]
      if (item?.kind === "user") return undefined
      if (item?.kind === "assistant" && item.text.trim().length > 0) return item.key
    }
    return undefined
  }, [timeline])

  // A new user message always snaps back to the bottom.
  const lastUser = useMemo(() => {
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index]
      if (item?.kind === "user") return item.key
    }
    return undefined
  }, [timeline.items])
  useEffect(() => {
    if (lastUser === undefined) return
    stick.current = true
    setDetached(false)
    toBottom()
  }, [lastUser, toBottom])

  // Find in thread: the shortcut opens the bar on the thread on screen.
  const findSignal = useApp((state) => state.findSignal)
  const asked = useRef(findSignal)
  const [find, setFind] = useState<{ readonly query: string; readonly current: number; readonly focus: number } | undefined>(undefined)
  useEffect(() => {
    if (findSignal === asked.current) return
    asked.current = findSignal
    if (!paneFocused(threadId)) return
    setFind((open) => ({ query: open?.query ?? "", current: open?.current ?? 0, focus: (open?.focus ?? 0) + 1 }))
  }, [findSignal])
  useEffect(() => setFind(undefined), [threadId])
  const where = useMemo(() => rowIndex(rows), [rows])
  const findQuery = find?.query ?? ""
  const matches = useMemo(() => findMatches(timeline.items, findQuery, toolTitle).filter((match) => where.has(match.key)), [timeline.items, findQuery, where])
  const current = find === undefined || matches.length === 0 ? undefined : Math.min(find.current, matches.length - 1)
  const match = current === undefined ? undefined : matches[current]
  const found = match === undefined ? undefined : where.get(match.key)
  // Which of the matches drawn in the current row this one is.
  const rank = current === undefined || found === undefined ? 0 : matches.slice(0, current).filter((other) => where.get(other.key)?.index === found.index).length

  useEffect(() => {
    if (found === undefined) return
    if (found.turnId !== undefined) useOpenWork.setState({ [found.turnId]: true })
    if (found.group !== undefined) useOpenSteps.setState({ [found.group]: true })
    virtualizer.scrollToIndex(found.index, { align: "center" })
    requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element === null) return
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD
      stick.current = atBottom
      setDetached(!atBottom)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.key, match?.nth, findQuery])

  // Rows mount as they scroll into view, so the marks are drawn again after each render. Each
  // match's words are brought into view once, the first time they are drawn.
  const revealed = useRef<string | undefined>(undefined)
  const matchId = match === undefined ? undefined : `${findQuery}\u0000${match.key}\u0000${String(match.nth)}`
  useEffect(() => {
    const element = scrollRef.current
    if (find === undefined || element === null) return
    const frame = requestAnimationFrame(() => {
      const range = paintFind(element, find.query, found?.index, rank)
      if (range === undefined || matchId === undefined || revealed.current === matchId) return
      revealed.current = matchId
      revealRange(element, range)
    })
    return () => cancelAnimationFrame(frame)
  })
  useEffect(() => {
    if (find === undefined) clearFind()
  }, [find === undefined])
  useEffect(() => clearFind, [])

  const onFindQuery = (query: string): void => {
    const next = findMatches(timeline.items, query, toolTitle).filter((other) => where.has(other.key))
    // The search starts at the top of the view, as a browser's does.
    const top = virtualizer.getVirtualItems().find((virtual) => virtual.end > (virtualizer.scrollOffset ?? 0))?.index ?? 0
    const from = next.findIndex((other) => (where.get(other.key)?.index ?? 0) >= top)
    setFind((open) => ({ query, current: Math.max(0, from < 0 ? next.length - 1 : from), focus: open?.focus ?? 0 }))
  }

  const onScroll = (): void => {
    const element = scrollRef.current
    if (element === null) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD
    stick.current = atBottom
    if (detached === atBottom) setDetached(!atBottom)
  }

  const renderRow = (row: Row): ReactNode => {
    switch (row.type) {
      case "work":
        return <WorkRow row={row} render={renderRow} />
      case "history":
        return (
          <div className="row-history">
            <History size={13} /> Earlier messages are not shown. The agent still has the full context.
          </div>
        )
      case "footer":
        return <WorkingFooter threadId={threadId} runtime={runtime} />
      case "pr":
        return <PullRequestCard threadId={threadId} number={row.number} />
      case "memory":
        return <RememberCard threadId={threadId} />
      case "lesson":
        return level === "off" ? null : <LessonCard threadId={threadId} anchor={row.anchor} lesson={row.lesson} level={level} />
      case "steps":
        return <StepsRow row={row} {...(workspace === undefined ? {} : { workspace })} />
      case "tool":
        return row.item.agent !== undefined || row.item.presentation.kind === "agent" ? (
          <AgentRow item={row.item} childItems={row.children ?? []} {...(workspace === undefined ? {} : { workspace })} />
        ) : (
          <ToolRow item={row.item} approved={row.approved === true} {...(row.children === undefined ? {} : { childItems: row.children.filter((child): child is ToolItem => child.kind === "tool") })} {...(workspace === undefined ? {} : { workspace })} />
        )
      case "item": {
        const item = row.item
        switch (item.kind) {
          case "user":
            return <UserRow item={item} threadId={threadId} />
          case "assistant":
            return <AssistantRow item={item} threadId={threadId} last={item.key === lastAnswer} {...(workspace === undefined ? {} : { workspace })} />
          case "reasoning":
            return <ReasoningRow item={item} />
          case "approval": {
            if (item.questions !== undefined) return <QuestionCard item={item} threadId={threadId} primary={item.key === firstPending} />
            const position = item.callKey === undefined ? undefined : timeline.index.get(item.callKey)
            const gate = position === undefined ? undefined : timeline.items[position]
            return <ApprovalCard item={item} threadId={threadId} primary={item.key === firstPending} {...(gate?.kind === "tool" ? { gate } : {})} />
          }
          case "plan":
            return <PlanCard item={item} />
          case "review":
            return <ReviewRow item={item} />
          case "notice":
            return <NoticeRow item={item} threadId={threadId} />
          case "turn-end": {
            const changes = runtime.changes[item.turnId]
            return <TurnEndRow item={item} folded={row.folded === true} {...(changes === undefined ? {} : { changes })} {...(row.checks === undefined ? {} : { checks: row.checks })} />
          }
        }
      }
    }
  }

  if (!runtime.historyLoaded && runtime.engine !== "failed" && timeline.items.length === 0)
    return (
      <div className="timeline" aria-busy>
        <div className="timeline-skeleton" aria-label="Loading conversation">
          <div className="skeleton skeleton-user" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
          <div className="skeleton skeleton-tool" />
          <div className="skeleton skeleton-line" />
        </div>
      </div>
    )

  if (rows.length === 0)
    return (
      <div className="timeline">
        <EmptyState icon={<MessageSquare size={18} />} {...(palette === "default" ? {} : { art: <FlowerMark flower={palette} /> })} title="No messages yet">
          Describe the change below. Type @ to attach files or / for commands.
        </EmptyState>
      </div>
    )

  return (
    <div className={cx("timeline", compact && "is-compact")}>
      <AgentActivitySummary threadId={threadId} agents={agents} />
      {find !== undefined && (
        <FindBar
          query={find.query}
          count={matches.length}
          current={current ?? 0}
          focus={find.focus}
          onQuery={onFindQuery}
          onStep={(step) => setFind((open) => (open === undefined ? open : { ...open, current: stepMatch(matches.length, current ?? 0, step) }))}
          onClose={() => setFind(undefined)}
        />
      )}
      <div ref={scrollRef} className="timeline-scroll" onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
        <div className="timeline-canvas" style={{ height: total }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const row = rows[virtual.index]
            if (row === undefined) return null
            return (
              <div key={virtual.key} ref={virtualizer.measureElement} data-index={virtual.index} data-kind={rowKind(row)} className={cx("timeline-row", found?.index === virtual.index && "is-find-current")} style={{ transform: `translateY(${String(virtual.start)}px)` }}>
                <div className="timeline-column">{renderRow(row)}</div>
              </div>
            )
          })}
        </div>
      </div>
      {detached && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            stick.current = true
            setDetached(false)
            virtualizer.scrollToIndex(rows.length - 1, { align: "end" })
            requestAnimationFrame(toBottom)
          }}
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
    </div>
  )
}
