import type { ToolKind, ToolPresentation } from "../protocol/schemas"
import { isBusy, pendingApprovals, type Timeline } from "../thread/reducer"
import { runningTool } from "./attention"
import { lessonFor } from "./lessons"
import type { ThreadMeta } from "./persist"
import type { ThreadRuntime } from "./store"

/**
 * What a thread's person on the office floor is doing, read only from the thread's real state: the
 * call running now, a pending approval, how the last turn ended, and whether an engine is attached.
 * A pose moves only while work is happening; nothing here is timed or random.
 */

export type Pose = "typing" | "reading" | "running" | "browsing" | "thinking" | "delegating" | "raised" | "quiet" | "failed" | "done" | "idle" | "offline"

export type PersonTone = "work" | "ask" | "fail" | "done" | "idle"

export interface PersonState {
  readonly pose: Pose
  readonly label: string
  /** The path, command, or page the label is about, when there is one. */
  readonly detail?: string
  readonly tone: PersonTone
  /** Whether the pose animates; only poses that real work drives do. */
  readonly moving: boolean
  /** Subagents working for the thread, in the turn or in the background. */
  readonly helpers: number
  /** Learn mode's lesson for the call it is making or asking about. */
  readonly lesson?: string
}

export interface PersonInput {
  readonly thread: ThreadMeta
  readonly runtime?: ThreadRuntime
  /** Background subagents still running for the thread. */
  readonly backgroundAgents: number
  /** When the thread went quiet, as the waiting list decided; absent while it is not quiet. */
  readonly quietSince?: number
}

const TOOL_POSES: Readonly<Record<ToolKind, { readonly pose: Pose; readonly label: string }>> = {
  edit: { pose: "typing", label: "Editing" },
  write: { pose: "typing", label: "Writing a file" },
  patch: { pose: "typing", label: "Editing" },
  read: { pose: "reading", label: "Reading" },
  search: { pose: "reading", label: "Searching" },
  list: { pose: "reading", label: "Looking through files" },
  shell: { pose: "running", label: "Running a command" },
  verify: { pose: "running", label: "Running checks" },
  web: { pose: "browsing", label: "Browsing" },
  agent: { pose: "delegating", label: "Delegating" },
  plan: { pose: "typing", label: "Planning" },
  mcp: { pose: "typing", label: "Using a tool" },
  other: { pose: "typing", label: "Working" },
}

const MOVING: ReadonlySet<Pose> = new Set(["typing", "reading", "running", "browsing", "thinking", "delegating", "raised"])

export function personState(input: PersonInput): PersonState {
  const { thread, runtime } = input
  const timeline = runtime?.timeline
  const helpers = (timeline === undefined ? 0 : agentsWorking(timeline)) + input.backgroundAgents
  const state = (pose: Pose, label: string, tone: PersonTone, detail?: string, lesson?: string): PersonState => ({
    pose,
    label,
    tone,
    moving: MOVING.has(pose),
    helpers,
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    ...(lesson === undefined ? {} : { lesson }),
  })

  const asking = timeline === undefined ? undefined : pendingApprovals(timeline)[0]
  if (timeline !== undefined && asking !== undefined) {
    const position = asking.callKey === undefined ? undefined : timeline.index.get(asking.callKey)
    const gate = position === undefined ? undefined : timeline.items[position]
    return state("raised", "Needs you", "ask", asking.action.trim(), gate?.kind === "tool" ? lessonFor(gate.presentation).id : undefined)
  }

  const busy = runtime !== undefined && timeline !== undefined && (isBusy(timeline) || runtime.engine === "starting" || (runtime.queue.length > 0 && !runtime.queuePaused))
  if (busy) {
    if (input.quietSince !== undefined) return state("quiet", "Quiet", "ask")
    const tool = runningTool(timeline)
    if (tool !== undefined) {
      const known = TOOL_POSES[tool.presentation.kind]
      return state(known.pose, known.label, "work", toolDetail(tool.presentation), lessonFor(tool.presentation).id)
    }
    const last = timeline.items[timeline.items.length - 1]
    if (last?.kind === "assistant" && last.streaming) return state("typing", "Writing the answer", "work")
    if (runtime.engine === "starting" && timeline.activeTurnId === undefined) return state("thinking", "Starting", "work")
    return state("thinking", "Thinking", "work")
  }

  if (thread.lastStatus === "failed") return state("failed", "Failed", "fail")
  if (thread.lastStatus === "completed" && thread.unread === true) return state("done", "Done", "done")
  const live = runtime !== undefined && runtime.engine === "ready"
  if (!live) return state("offline", thread.lastStatus === "stopped" ? "Stopped" : "Idle", "idle")
  return state("idle", thread.lastStatus === "stopped" ? "Stopped" : "Idle", "idle")
}

/** How far back the active turn is looked through; its items are the last ones in the timeline. */
const TURN_SCAN = 2_000

function agentsWorking(timeline: Timeline): number {
  const turnId = timeline.activeTurnId
  if (turnId === undefined) return 0
  let count = 0
  const stop = Math.max(0, timeline.items.length - TURN_SCAN)
  for (let position = timeline.items.length - 1; position >= stop; position -= 1) {
    const item = timeline.items[position]
    if (item === undefined) break
    const itemTurn = "turnId" in item ? item.turnId : undefined
    if (itemTurn !== undefined && itemTurn !== turnId) break
    if (item.kind === "tool" && item.status === "running" && item.presentation.kind === "agent") count += 1
  }
  return count
}

function toolDetail(presentation: ToolPresentation): string {
  return presentation.path ?? presentation.command ?? presentation.url ?? presentation.query ?? presentation.title
}
