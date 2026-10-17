import { create } from "zustand"
import { toHostError } from "../host"
import type { BackendId, Thinking } from "../host/types"
import { parseList, parseOr, SetupListSchema, SetupRunSchema, SetupSchema, type SetupInfo, type SetupPlanInfo, type SetupRole, type SetupRun } from "../protocol/schemas"
import type { TimelineItem } from "../thread/reducer"
import { onSendFailed, onTurnEnded, projectRpc, send } from "./engines"
import { announceRun } from "./notifications"
import type { PermissionPreset, ThreadMeta } from "./persist"
import { createThread, get, projectById, runtimeOf, set as setApp, threadById, toast } from "./store"
import { createWorktreeThread } from "./workflows"
import { HEAD_START } from "./worktreeStart"

/**
 * Setups on the desktop. The engine runs each setup and decides every next step;
 * the desktop lists and edits setups, shows runs, asks the person to approve plans, and runs each
 * turn the engine hands it as a thread the person can open and watch.
 */

export type SetupRoleName = "planner" | "executor" | "reviewer"
export const SETUP_ROLES: readonly SetupRoleName[] = ["planner", "executor", "reviewer"]
export const ROLE_NAMES: Readonly<Record<SetupRoleName, string>> = { planner: "Planner", executor: "Executor", reviewer: "Reviewer" }
const POLL_MS = 1_500

interface ProjectSetups {
  readonly state: "loading" | "ready" | "error"
  readonly setups: readonly SetupInfo[]
  readonly skipped: number
  readonly message?: string
}

interface SetupsState {
  readonly byProject: Readonly<Record<string, ProjectSetups>>
  /** Runs this app knows of, by run id, with the project that runs them. */
  readonly runs: Readonly<Record<string, { readonly projectId: string; readonly run: SetupRun }>>
}

export const useSetups = create<SetupsState>()(() => ({ byProject: {}, runs: {} }))

export async function loadSetups(projectId: string): Promise<void> {
  const before = useSetups.getState().byProject[projectId]
  patchProject(projectId, { state: "loading", setups: before?.setups ?? [], skipped: before?.skipped ?? 0 })
  try {
    const listed = parseOr(SetupListSchema, await projectRpc(projectId, "setup.list"))
    if (listed === undefined) throw new Error("The setups answer was malformed.")
    patchProject(projectId, { state: "ready", setups: parseList(SetupSchema, listed.setups, 128), skipped: listed.skipped })
  } catch (error) {
    patchProject(projectId, { state: "error", setups: before?.setups ?? [], skipped: 0, message: toHostError(error).message })
  }
  void loadRuns(projectId)
}

function patchProject(projectId: string, value: ProjectSetups): void {
  useSetups.setState((state) => ({ byProject: { ...state.byProject, [projectId]: value } }))
}

/** A setup as the editor holds it: what `setup.save` takes. */
export interface SetupDraft {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly roles: { readonly planner?: SetupRole; readonly executor: SetupRole; readonly reviewer?: SetupRole }
  readonly rules: { readonly approvePlan: boolean; readonly reviewRounds: number; readonly check?: string; readonly budget: { readonly maxTurns: number; readonly maxMinutes: number } }
}

export function draftOf(setup: SetupInfo): SetupDraft {
  const { planner, executor, reviewer } = setup.roles
  const { approvePlan, reviewRounds, check, budget } = setup.rules
  return {
    id: setup.id,
    name: setup.name,
    ...(setup.description === undefined ? {} : { description: setup.description }),
    roles: { ...(planner === undefined ? {} : { planner }), executor, ...(reviewer === undefined ? {} : { reviewer }) },
    rules: { approvePlan, reviewRounds, ...(check === undefined ? {} : { check }), budget: { maxTurns: budget.maxTurns, maxMinutes: budget.maxMinutes } },
  }
}

export async function saveSetup(projectId: string, setup: SetupDraft): Promise<SetupInfo> {
  const saved = parseOr(SetupSchema, await projectRpc(projectId, "setup.save", { setup }))
  await loadSetups(projectId)
  if (saved === undefined) throw new Error("The saved setup was malformed.")
  return saved
}

/** Trusts a project's setup as the person was shown it; a version changed since is refused. */
export async function trustSetup(projectId: string, id: string, digest: string): Promise<void> {
  await projectRpc(projectId, "setup.trust", { id, digest })
  await loadSetups(projectId)
}

export async function deleteSetup(projectId: string, id: string): Promise<void> {
  await projectRpc(projectId, "setup.delete", { id })
  await loadSetups(projectId)
}

function putRun(projectId: string, run: SetupRun): void {
  useSetups.setState((state) => ({ runs: { ...state.runs, [run.runId]: { projectId, run } } }))
}

/** Each run read on its own, so one this desktop cannot read does not hide the others or stall their turns. */
export function listedRuns(value: unknown): readonly SetupRun[] | undefined {
  const runs = typeof value === "object" && value !== null ? (value as { readonly runs?: unknown }).runs : undefined
  return Array.isArray(runs) ? parseList(SetupRunSchema, runs, 64) : undefined
}

export async function loadRuns(projectId: string): Promise<void> {
  const runs = listedRuns(await projectRpc(projectId, "setup.run.list").catch(() => undefined))
  if (runs === undefined) return
  for (const run of runs) putRun(projectId, run)
  for (const run of runs) if (active(run)) watch(projectId)
}

/** Starts a run in a new worktree of the project, or with `checkout` in the project's own folder. */
export async function startSetupRun(projectId: string, setupId: string, task: string, options: { readonly checkout?: boolean } = {}): Promise<SetupRun> {
  const run = parseOr(SetupRunSchema, await projectRpc(projectId, "setup.run.start", { setupId, task, ...(options.checkout === true ? { checkout: true } : {}) }))
  if (run === undefined) throw new Error("The run's answer was malformed.")
  putRun(projectId, run)
  watch(projectId)
  return run
}

export async function stopSetupRun(runId: string): Promise<void> {
  const known = useSetups.getState().runs[runId]
  if (known === undefined) return
  const run = parseOr(SetupRunSchema, await projectRpc(known.projectId, "setup.run.stop", { runId }))
  if (run !== undefined) putRun(known.projectId, run)
}

export async function answerApproval(runId: string, stepId: string, answer: { readonly approved: boolean; readonly plan?: SetupPlanInfo; readonly feedback?: string }): Promise<void> {
  const known = useSetups.getState().runs[runId]
  if (known === undefined) return
  const run = parseOr(SetupRunSchema, await projectRpc(known.projectId, "setup.run.answer", { runId, stepId, ...answer }))
  if (run !== undefined) putRun(known.projectId, run)
}

export function active(run: Pick<SetupRun, "state">): boolean {
  return run.state === "running" || run.state === "waiting"
}

// ---------------------------------------------------------------------------------------------
// The driver: polls active runs and runs each waiting turn as a thread.

const watched = new Set<string>()
const handled = new Set<string>()
/** Threads running a setup turn, and the step their answer goes to. */
const pending = new Map<string, { readonly projectId: string; readonly runId: string; readonly stepId: string }>()
const notified = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

/** Puts the threads of a run some other place started (an eval) in that place's group. */
type GroupFor = (runId: string) => { readonly id: string; readonly label: string; readonly title: string } | undefined
const groupers: GroupFor[] = []

export function groupSetupThreads(grouper: GroupFor): void {
  groupers.push(grouper)
}

/** A run some other place started and reports on: an eval's, or a workflow step's. */
export function startedElsewhere(runId: string): boolean {
  return useSetups.getState().runs[runId]?.run.owner !== undefined || groupers.some((grouper) => grouper(runId) !== undefined)
}

/** Runs the turns of this project's active setup runs, including ones the desktop did not start. */
export function watchSetupRuns(projectId: string): void {
  watch(projectId)
}

function watch(projectId: string): void {
  watched.add(projectId)
  timer ??= setInterval(() => void poll(), POLL_MS)
}

async function poll(): Promise<void> {
  for (const projectId of [...watched]) {
    const runs = listedRuns(await projectRpc(projectId, "setup.run.list").catch(() => undefined))
    if (runs === undefined) continue
    for (const run of runs) {
      const before = useSetups.getState().runs[run.runId]?.run
      putRun(projectId, run)
      if (run.waiting?.kind === "turn") void runTurn(projectId, run, run.waiting)
      if (run.waiting?.kind === "approve" && !notified.has(`${run.runId}:${run.waiting.stepId}`)) {
        notified.add(`${run.runId}:${run.waiting.stepId}`)
        toast("info", `${run.setupName}: the plan is ready for you`, { label: "Open", run: () => setApp({ view: { kind: "agents", runId: run.runId } }) })
        announceRun("approval", run.runId, run.setupName, "The plan is ready for you", () => setApp({ view: { kind: "agents", runId: run.runId } }))
      }
      // A run another place started (an eval) is that place's to report.
      if (before !== undefined && active(before) && !active(run) && !startedElsewhere(run.runId) && run.state !== "stopped")
        announceRun(run.state === "succeeded" ? "finished" : "failed", run.runId, run.setupName, run.state === "succeeded" ? "Done" : (run.error?.message ?? "Failed"), () => setApp({ view: { kind: "agents", runId: run.runId } }))
      if (before !== undefined && active(before) && !active(run) && !startedElsewhere(run.runId)) toast(run.state === "succeeded" ? "success" : run.state === "stopped" ? "info" : "error", `${run.setupName}: ${run.state === "succeeded" ? "done" : run.state === "stopped" ? "stopped" : (run.error?.message ?? "failed")}`)
    }
    if (!runs.some(active)) watched.delete(projectId)
  }
  if (watched.size === 0 && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

/** What a role's thread runs on, from the setup's role. */
export function roleSelection(role: SetupRole): { readonly backend: BackendId; readonly model?: string; readonly connectionId?: string; readonly thinking?: Thinking } {
  return { backend: role.route, ...(role.model === undefined ? {} : { model: role.model }), ...(role.connectionId === undefined ? {} : { connectionId: role.connectionId }), ...(role.effort === undefined ? {} : { thinking: role.effort }) }
}

async function runTurn(projectId: string, run: SetupRun, waiting: Extract<NonNullable<SetupRun["waiting"]>, { kind: "turn" }>): Promise<void> {
  const key = `${run.runId}:${waiting.stepId}`
  if (handled.has(key)) return
  handled.add(key)
  const answer = (value: Record<string, unknown>): Promise<unknown> => projectRpc(projectId, "setup.run.answer", { runId: run.runId, stepId: waiting.stepId, ...value }).catch(() => undefined)
  try {
    const thread = await threadForRole(projectId, run, waiting)
    pending.set(thread.id, { projectId, runId: run.runId, stepId: waiting.stepId })
    send(thread.id, { text: waiting.prompt })
  } catch (error) {
    await answer({ ok: false, error: toHostError(error).message })
  }
}

async function threadForRole(projectId: string, run: SetupRun, waiting: Extract<NonNullable<SetupRun["waiting"]>, { kind: "turn" }>): Promise<ThreadMeta> {
  const threads = get().threads.filter((thread) => thread.setup?.runId === run.runId)
  const mine = threads.find((thread) => thread.setup?.role === waiting.role)
  const mode = waiting.mode === "plan" ? ("plan" as const) : ("agent" as const)
  const permission: PermissionPreset = waiting.access
  if (mine !== undefined) return mine
  // A workflow's step is one turn, named by the workflow and the step (its setup's name).
  const outside = run.owner !== undefined ? { id: run.owner.runId, label: `Workflow: ${run.owner.name}`, title: run.setupName } : groupers.map((grouper) => grouper(run.runId)).find((group) => group !== undefined)
  const input = {
    projectId,
    ...roleSelection(waiting.runsOn),
    mode,
    permission,
    title: run.owner !== undefined ? run.setupName : `${ROLE_NAMES[waiting.role]}: ${outside?.title ?? firstLine(run.task)}`,
    group: outside === undefined ? { id: run.runId, label: `${run.setupName}: ${firstLine(run.task)}` } : { id: outside.id, label: outside.label },
    setup: { runId: run.runId, role: waiting.role },
    select: false,
  }
  // An eval's or a workflow's run names its worktree, or works in the checkout; otherwise the first role's thread makes one and the others share it.
  if (waiting.worktree !== undefined) return createThread({ ...input, worktree: waiting.worktree })
  if (waiting.checkout === true) return createThread(input)
  const shared = threads.find((thread) => thread.worktree !== undefined)?.worktree
  if (shared !== undefined) return createThread({ ...input, worktree: shared })
  return createWorktreeThread(input, HEAD_START, { firstMessage: run.task })
}

function firstLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** Every answer the turn gave, in order: a tool's final block may follow earlier messages. */
export function turnAnswer(items: readonly TimelineItem[], turnId: string): string {
  return items
    .filter((item) => item.kind === "assistant" && item.turnId === turnId)
    .map((item) => (item.kind === "assistant" ? item.text : ""))
    .join("\n\n")
}

onSendFailed((threadId, reason) => {
  const waiting = pending.get(threadId)
  if (waiting === undefined) return
  pending.delete(threadId)
  void projectRpc(waiting.projectId, "setup.run.answer", { runId: waiting.runId, stepId: waiting.stepId, ok: false, error: `the step's message could not be sent: ${reason}` }).catch(() => undefined)
})

onTurnEnded((threadId, turnId) => {
  const waiting = pending.get(threadId)
  if (waiting === undefined) return
  pending.delete(threadId)
  const timeline = runtimeOf(threadId).timeline
  const status = timeline.lastTurnEnd?.status
  const thread = threadById(threadId)
  void projectRpc(waiting.projectId, "setup.run.answer", {
    runId: waiting.runId,
    stepId: waiting.stepId,
    ok: status === "completed",
    text: turnAnswer(timeline.items, turnId),
    ...(thread?.worktree === undefined ? {} : { worktree: thread.worktree.id }),
    ...(status === "completed" ? {} : { error: status === "stopped" ? "the turn was stopped" : "the turn failed" }),
  }).catch(() => undefined)
})

/**
 * The roles in use with nothing to run on: Runrail's own loop with no model picked. Such a run's
 * first turn cannot start, so outside developer mode (where it is the test model) each needs one.
 */
export function rolesWithoutModel(roles: SetupDraft["roles"], developer: boolean): readonly SetupRoleName[] {
  if (developer) return []
  return SETUP_ROLES.filter((role) => {
    const value = roles[role]
    return value !== undefined && value.route === "native" && value.model === undefined
  })
}

/** "Pick a model for the planner, executor and reviewer". */
export function pickModelHint(roles: readonly SetupRoleName[]): string {
  const names = roles.map((role) => ROLE_NAMES[role].toLowerCase())
  const last = names[names.length - 1] ?? ""
  return `Pick a model for the ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${last}` : last}`
}

/** The setup a new one starts from: every role on what a new thread would run on. */
export function draftSetup(role: SetupRole, check?: string): SetupDraft {
  return {
    id: `setup-${Date.now().toString(36)}`,
    name: "Plan, execute, review",
    roles: { planner: role, executor: { ...role, access: "auto-edit" }, reviewer: role },
    rules: { approvePlan: true, reviewRounds: 1, ...(check === undefined ? {} : { check }), budget: { maxTurns: 40, maxMinutes: 120 } },
  }
}

export function projectOfRun(runId: string): string | undefined {
  const projectId = useSetups.getState().runs[runId]?.projectId
  return projectById(projectId)?.id
}
