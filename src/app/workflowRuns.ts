import { create } from "zustand"
import { toHostError } from "../host"
import {
  parseList,
  parseOr,
  parseWorkflowInfo,
  WorkflowDueSchema,
  WorkflowListSchema,
  WorkflowRunListSchema,
  WorkflowRunSchema,
  WorkflowUpcomingSchema,
  type PullRequestRef,
  type SetupRole,
  type WorkflowInfo,
  type WorkflowRun,
  type WorkflowSchedule,
  type WorkflowStep,
  type WorkflowTrigger,
  type WorkflowUpcoming,
} from "../protocol/schemas"
import { systemRpc } from "./connections"
import { archiveThread, onTurnEnded, projectRpc, quietWhen, send } from "./engines"
import { syncStaleSources } from "./memory"
import { announceRun } from "./notifications"
import type { Project } from "./persist"
import { turnAnswer, watchSetupRuns } from "./setups"
import { createThread, get, runtimeOf, set, startingModel, threadById, toast } from "./store"

/**
 * Workflows on the desktop. The engine keeps and runs them; the desktop edits them,
 * asks the app-wide engine what is due while the app is open, starts those runs on the
 * project's engine, answers approvals, and turns an agent's proposal into a stored, proposed one.
 */

const TICK_MS = 30_000
const POLL_MS = 2_000

interface ProjectWorkflows {
  readonly state: "loading" | "ready" | "error"
  readonly workflows: readonly WorkflowInfo[]
  readonly message?: string
}

interface WorkflowsState {
  readonly byProject: Readonly<Record<string, ProjectWorkflows>>
  readonly runs: Readonly<Record<string, { readonly projectId: string; readonly run: WorkflowRun }>>
}

export const useWorkflows = create<WorkflowsState>()(() => ({ byProject: {}, runs: {} }))

/** Workflows that start by themselves across every project, and the next scheduled start; asked with each tick. */
export const useUpcoming = create<{ readonly upcoming?: WorkflowUpcoming }>(() => ({}))

export async function refreshUpcoming(): Promise<void> {
  const upcoming = parseOr(WorkflowUpcomingSchema, await systemRpc("workflow.upcoming").catch(() => undefined))
  if (upcoming !== undefined) useUpcoming.setState({ upcoming })
}

/** What `workflow.save` takes: a workflow without the store's fields. */
export interface WorkflowDraft {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly state: WorkflowInfo["state"]
  readonly trigger: WorkflowTrigger
  readonly where: "worktree" | "checkout"
  readonly steps: readonly WorkflowStep[]
  readonly budget: { readonly maxMinutes: number }
  readonly proposedBy?: { readonly thread: string }
}

export function draftOf(workflow: WorkflowInfo): WorkflowDraft {
  const { id, name, description, state, trigger, where, steps, budget, proposedBy } = workflow
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    state,
    trigger,
    where,
    steps,
    budget,
    ...(proposedBy === undefined ? {} : { proposedBy }),
  }
}

export async function loadWorkflows(projectId: string): Promise<void> {
  const before = useWorkflows.getState().byProject[projectId]
  patchProject(projectId, { state: "loading", workflows: before?.workflows ?? [] })
  try {
    const listed = parseOr(WorkflowListSchema, await projectRpc(projectId, "workflow.list"))
    if (listed === undefined) throw new Error("The workflows answer was malformed.")
    patchProject(projectId, { state: "ready", workflows: listed.workflows.flatMap((item) => parseWorkflowInfo(item) ?? []) })
  } catch (error) {
    patchProject(projectId, { state: "error", workflows: before?.workflows ?? [], message: toHostError(error).message })
  }
  void loadRuns(projectId)
}

function patchProject(projectId: string, value: ProjectWorkflows): void {
  useWorkflows.setState((state) => ({ byProject: { ...state.byProject, [projectId]: value } }))
}

async function saved(projectId: string, answer: unknown): Promise<WorkflowInfo> {
  await loadWorkflows(projectId)
  void refreshUpcoming()
  const parsed = parseWorkflowInfo(answer)
  if (parsed === undefined) throw new Error("The saved workflow was malformed.")
  return parsed
}

export async function saveWorkflow(projectId: string, workflow: WorkflowDraft): Promise<WorkflowInfo> {
  return saved(projectId, await projectRpc(projectId, "workflow.save", { workflow }))
}

export async function approveWorkflow(projectId: string, id: string): Promise<WorkflowInfo> {
  return saved(projectId, await projectRpc(projectId, "workflow.approve", { id }))
}

export async function enableWorkflow(projectId: string, id: string, on: boolean): Promise<WorkflowInfo> {
  return saved(projectId, await projectRpc(projectId, "workflow.enable", { id, on }))
}

export async function deleteWorkflow(projectId: string, id: string): Promise<void> {
  await projectRpc(projectId, "workflow.delete", { id })
  await loadWorkflows(projectId)
  void refreshUpcoming()
}

// ---------------------------------------------------------------------------------------------
// Runs

function putRun(projectId: string, run: WorkflowRun): void {
  useWorkflows.setState((state) => ({ runs: { ...state.runs, [run.runId]: { projectId, run } } }))
}

export function active(run: Pick<WorkflowRun, "state">): boolean {
  return run.state === "running" || run.state === "waiting"
}

export async function loadRuns(projectId: string): Promise<void> {
  const listed = parseOr(WorkflowRunListSchema, await projectRpc(projectId, "workflow.run.list").catch(() => undefined))
  if (listed === undefined) return
  const runs = parseList(WorkflowRunSchema, listed.runs, 64)
  for (const run of runs) putRun(projectId, run)
  if (runs.some(active)) watch(projectId)
}

export async function runWorkflow(projectId: string, id: string, trigger: WorkflowRun["trigger"] = "manual", pr?: PullRequestRef, input?: string): Promise<WorkflowRun> {
  const run = parseOr(WorkflowRunSchema, await projectRpc(projectId, "workflow.run.start", { id, trigger, ...(pr === undefined ? {} : { pr }), ...(input === undefined ? {} : { input }) }))
  if (run === undefined) throw new Error("The run's answer was malformed.")
  putRun(projectId, run)
  watch(projectId)
  return run
}

export async function answerWorkflow(runId: string, stepId: string, approved: boolean): Promise<void> {
  const known = useWorkflows.getState().runs[runId]
  if (known === undefined) return
  const run = parseOr(WorkflowRunSchema, await projectRpc(known.projectId, "workflow.run.answer", { runId, stepId, approved }))
  if (run !== undefined) putRun(known.projectId, run)
}

/**
 * A check's "on failure, back to" names an earlier step that does the work. After a step is moved
 * or removed, a check left pointing at a later step or none stops and tells the person instead.
 */
export function withValidRetries(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.map((step, index) => {
    if (step.kind !== "check" || step.retry === undefined) return step
    const target = step.retry.step
    if (steps.slice(0, index).some((item) => item.id === target && (item.kind === "agent" || item.kind === "setup"))) return step
    const { retry: _retry, ...rest } = step
    return rest
  })
}

export async function stopWorkflowRun(runId: string): Promise<void> {
  const known = useWorkflows.getState().runs[runId]
  if (known === undefined) return
  const run = parseOr(WorkflowRunSchema, await projectRpc(known.projectId, "workflow.run.stop", { runId }))
  if (run !== undefined) putRun(known.projectId, run)
}

const watched = new Set<string>()
const told = new Set<string>()
let poller: ReturnType<typeof setInterval> | undefined

function watch(projectId: string): void {
  watched.add(projectId)
  // A run's steps are setup runs whose turns the setups driver runs as threads.
  watchSetupRuns(projectId)
  poller ??= setInterval(() => void poll(), POLL_MS)
}

async function poll(): Promise<void> {
  for (const projectId of [...watched]) {
    const listed = parseOr(WorkflowRunListSchema, await projectRpc(projectId, "workflow.run.list").catch(() => undefined))
    if (listed === undefined) continue
    const runs = parseList(WorkflowRunSchema, listed.runs, 64)
    for (const run of runs) {
      const before = useWorkflows.getState().runs[run.runId]?.run
      putRun(projectId, run)
      if (active(run)) watchSetupRuns(projectId)
      report(projectId, run, before)
    }
    if (!runs.some(active)) {
      watched.delete(projectId)
      void loadWorkflows(projectId)
    }
  }
  if (watched.size === 0 && poller !== undefined) {
    clearInterval(poller)
    poller = undefined
  }
}

/** Tells the person once about each approval a run waits on, each notice, and how it ended. */
function report(projectId: string, run: WorkflowRun, before: WorkflowRun | undefined): void {
  const open = { label: "Open", run: () => set({ view: { kind: "workflows", projectId, workflowId: run.workflowId, runId: run.runId } }) }
  if (run.waiting !== undefined && !told.has(`${run.runId}:${run.waiting.stepId}`)) {
    told.add(`${run.runId}:${run.waiting.stepId}`)
    toast("info", run.waiting.kind === "slack" ? `${run.workflowName}: a Slack message waits for you` : `${run.workflowName}: ${run.waiting.title}`, open)
    announceRun("approval", run.runId, run.workflowName, run.waiting.kind === "slack" ? "A Slack message waits for you" : run.waiting.title, open.run)
  }
  for (const [index, notice] of run.notices.entries()) {
    if (told.has(`${run.runId}:notice:${String(index)}`)) continue
    told.add(`${run.runId}:notice:${String(index)}`)
    toast("info", `${run.workflowName}: ${notice.text}`, open)
  }
  if (before !== undefined && active(before) && !active(run) && run.state !== "stopped")
    announceRun(run.state === "succeeded" ? "finished" : "failed", run.runId, run.workflowName, run.state === "succeeded" ? "Done" : (run.error?.message ?? "Failed"), open.run)
  if (before !== undefined && active(before) && !active(run))
    toast(
      run.state === "succeeded" ? "success" : run.state === "stopped" ? "info" : "error",
      `${run.workflowName}: ${run.state === "succeeded" ? "done" : run.state === "stopped" ? "stopped" : (run.error?.message ?? "failed")}`,
      open,
    )
}

/** Groups a workflow run's setup threads under it in the Threads list. */
export function workflowGroup(owner: { readonly runId: string; readonly name: string }): { readonly id: string; readonly label: string } {
  return { id: owner.runId, label: `Workflow: ${owner.name}` }
}

// ---------------------------------------------------------------------------------------------
// The scheduler: what is due, asked of the app-wide engine, starts on the project's engine.

let ticker: ReturnType<typeof setInterval> | undefined
const starting = new Set<string>()
let lastTick: number | undefined

/**
 * Whether the Mac slept since the last tick. Timers stop with the Mac, so the
 * first tick after waking sees the gap; it asks what is due as always, and memory sync asks too.
 */
export function slept(previous: number | undefined, now: number): boolean {
  return previous !== undefined && now - previous > 3 * TICK_MS
}

export function initWorkflows(): void {
  if (ticker !== undefined) clearInterval(ticker)
  ticker = setInterval(() => void tick(), TICK_MS)
  setTimeout(() => void tick(), 3_000)
}

async function tick(): Promise<void> {
  const now = Date.now()
  if (slept(lastTick, now)) syncStaleSources(now)
  lastTick = now
  const due = parseOr(WorkflowDueSchema, await systemRpc("workflow.due").catch(() => undefined))
  for (const item of due?.due ?? []) {
    const project = projectForRoot(item.root)
    if (project === undefined || starting.has(item.workflowId)) continue
    starting.add(item.workflowId)
    void runWorkflow(project.id, item.workflowId, item.trigger, item.pr)
      .catch((error: unknown) => toast("error", `${item.name} did not start: ${toHostError(error).message}`))
      .finally(() => starting.delete(item.workflowId))
  }
  await refreshUpcoming()
}

/** The project at a folder the engine named; the engine names real paths (`/private/tmp` for `/tmp`). */
export function projectForRoot(root: string, projects: readonly Project[] = get().projects): Project | undefined {
  const plain = (path: string): string => path.replace(/^\/private(?=\/(?:tmp|var)\/)/, "").replace(/\/+$/, "")
  return projects.find((project) => plain(project.path) === plain(root))
}

// ---------------------------------------------------------------------------------------------
// Proposals: an agent's workflow block is stored as proposed; it never runs until approved.

const helpers = new Map<string, string>()
quietWhen((threadId) => helpers.has(threadId))

/** Whether a message ends with a json block holding a `workflow` object. */
export function proposalIn(message: string): boolean {
  const blocks = [...message.slice(-200_000).matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)]
  const raw = blocks[blocks.length - 1]?.[1]
  if (raw === undefined || !raw.includes('"workflow"')) return false
  try {
    const value = JSON.parse(raw) as { workflow?: unknown }
    return typeof value.workflow === "object" && value.workflow !== null && !Array.isArray(value.workflow)
  } catch {
    return false
  }
}

function runsOnOf(threadId: string): SetupRole {
  const thread = threadById(threadId)
  const start = startingModel(get().prefs)
  if (thread === undefined) return { route: "native", ...(start === undefined ? {} : { model: start.model }) }
  return {
    route: thread.backend as SetupRole["route"],
    ...(thread.model === undefined ? {} : { model: thread.model }),
    ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }),
    access: "auto-edit",
  }
}

async function propose(projectId: string, sourceThread: string, message: string): Promise<void> {
  const thread = threadById(sourceThread)
  try {
    const stored = parseWorkflowInfo(await projectRpc(projectId, "workflow.propose", { message, thread: thread?.title ?? "a thread", runsOn: runsOnOf(sourceThread) }))
    await loadWorkflows(projectId)
    toast("info", `Proposed a workflow${stored === undefined ? "" : `: ${stored.name}`}. It runs only after you approve it.`, {
      label: "Open",
      run: () => set({ view: { kind: "workflows", projectId, ...(stored === undefined ? {} : { workflowId: stored.id }) } }),
    })
  } catch (error) {
    toast("error", `The proposed workflow was not kept: ${toHostError(error).message}`)
  }
}

export const PROPOSE_PROMPT = [
  "Read this conversation from a coding thread. If its work is something that would be worth repeating on a schedule or when a pull request arrives, propose one workflow that does it.",
  "Keep it small: the fewest steps that do the job, a check where tests can prove it, and an approval before anything leaves this machine. Do not use tools.",
  "",
  "End your final message with exactly one fenced code block tagged json, and nothing after it, in this shape:",
  "```json",
  '{"workflow": {"id": "short-id", "name": "Short name", "trigger": {"kind": "schedule", "schedule": {"kind": "weekly", "day": 1, "hour": 9, "minute": 0}}, "steps": [{"id": "work", "kind": "agent", "title": "Do the work", "prompt": "What to do"}, {"id": "tests", "kind": "check", "title": "Run the tests", "command": "the test command", "retry": {"step": "work", "times": 2}}, {"id": "ok", "kind": "approval", "title": "Approve the change"}, {"id": "pr", "kind": "action", "title": "Open a draft pull request", "action": "open-pr"}]}}',
  "```",
  "Triggers: manual; schedule (interval minutes; daily, weekdays or weekly at hour and minute); pr-review-requested; pr-opened; webhook (a call to the workflow's own link). Step kinds: agent (title, prompt), check (command, repeat, retry), decision (right after an agent step: question, stopWhen yes or no), approval, action (open-pr after an approval; notify with text).",
].join("\n")

/** One turn on the thread's own tool, in a helper thread archived once it answers. */
export function proposeWorkflowFrom(threadId: string): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const lines = runtimeOf(threadId).timeline.items.flatMap((item) => (item.kind === "user" ? [`Person: ${item.text}`] : item.kind === "assistant" && item.text.trim().length > 0 ? [`Agent: ${item.text.trim()}`] : []))
  const conversation = lines.join("\n\n").slice(-24_000)
  if (conversation.length === 0) {
    toast("info", "This thread has nothing to make a workflow from yet.")
    return
  }
  const helper = createThread({
    projectId: thread.projectId,
    backend: thread.backend,
    ...(thread.model === undefined ? {} : { model: thread.model }),
    ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }),
    mode: "plan",
    permission: "ask",
    title: `Workflow from ${thread.title}`,
    select: false,
  })
  helpers.set(helper.id, threadId)
  toast("info", "Asking for a workflow from this thread…")
  send(helper.id, { text: `${PROPOSE_PROMPT}\n\n<conversation>\n${conversation}\n</conversation>` })
}

onTurnEnded((threadId, turnId) => {
  const timeline = runtimeOf(threadId).timeline
  const source = helpers.get(threadId)
  if (source !== undefined) {
    helpers.delete(threadId)
    const answer = turnAnswer(timeline.items, turnId)
    const thread = threadById(source)
    if (timeline.lastTurnEnd?.status === "completed" && proposalIn(answer) && thread !== undefined) void propose(thread.projectId, source, answer)
    else toast("info", "No workflow came of this thread.")
    void archiveThread(threadId, true)
    return
  }
  // A thread of the person's own that ends with a workflow block proposes it.
  const thread = threadById(threadId)
  if (thread === undefined || thread.setup !== undefined || thread.review !== undefined || timeline.lastTurnEnd?.status !== "completed") return
  const answer = turnAnswer(timeline.items, turnId)
  if (proposalIn(answer)) void propose(thread.projectId, threadId, answer)
})

// ---------------------------------------------------------------------------------------------
// Words

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]

export function describeSchedule(schedule: WorkflowSchedule): string {
  const time = (hour: number, minute: number): string => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  switch (schedule.kind) {
    case "interval":
      if (schedule.minutes % 1_440 === 0) return `Every ${schedule.minutes === 1_440 ? "day" : `${String(schedule.minutes / 1_440)} days`}`
      if (schedule.minutes % 60 === 0) return `Every ${schedule.minutes === 60 ? "hour" : `${String(schedule.minutes / 60)} hours`}`
      return `Every ${String(schedule.minutes)} minutes`
    case "daily":
      return `Daily at ${time(schedule.hour, schedule.minute)}`
    case "weekdays":
      return `Weekdays at ${time(schedule.hour, schedule.minute)}`
    case "weekly":
      return `${DAYS[schedule.day] ?? "Weekly"} at ${time(schedule.hour, schedule.minute)}`
  }
}

export function describeTrigger(trigger: WorkflowTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "Run by hand"
    case "schedule":
      return describeSchedule(trigger.schedule)
    case "pr-review-requested":
      return "When a review is requested"
    case "pr-opened":
      return "When a pull request is opened"
    case "webhook":
      return "When its link is called"
  }
}
