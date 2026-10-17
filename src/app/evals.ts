import { create } from "zustand"
import { toHostError } from "../host"
import {
  EvalCandidatesSchema,
  EvalCaseSchema,
  EvalRunListSchema,
  EvalRunSchema,
  EvalSuiteListSchema,
  EvalSuiteSchema,
  EvalVerdictSchema,
  parseList,
  parseOr,
  type EvalCaseInfo,
  type EvalJob,
  type EvalRun,
  type EvalSuiteInfo,
} from "../protocol/schemas"
import { projectRpc } from "./engines"
import { announceRun } from "./notifications"
import { groupSetupThreads, watchSetupRuns } from "./setups"
import { set as setApp, toast } from "./store"

/**
 * Evals on the desktop. The engine mines cases, keeps suites, and runs and scores every
 * case; the desktop finds and validates cases with the person, starts runs, runs each
 * setup turn as a thread like any setup run, and shows the scoreboard.
 */

const POLL_MS = 2_000

export type Verdict = "valid" | "passes-before" | "fails-after" | "error"
export const VERDICT_TEXT: Readonly<Record<Verdict, string>> = { valid: "Valid", "passes-before": "Tests pass before the fix", "fails-after": "Tests fail at the fix", error: "Could not check" }

interface ProjectSuites {
  readonly state: "loading" | "ready" | "error"
  readonly suites: readonly { readonly name: string; readonly cases: number; readonly check: string }[]
  readonly skipped: readonly string[]
  readonly message?: string
}

interface EvalsState {
  readonly byProject: Readonly<Record<string, ProjectSuites>>
  readonly runs: Readonly<Record<string, { readonly projectId: string; readonly run: EvalRun }>>
}

export const useEvals = create<EvalsState>()(() => ({ byProject: {}, runs: {} }))

export async function loadSuites(projectId: string): Promise<void> {
  const before = useEvals.getState().byProject[projectId]
  patchProject(projectId, { state: "loading", suites: before?.suites ?? [], skipped: before?.skipped ?? [] })
  try {
    const listed = parseOr(EvalSuiteListSchema, await projectRpc(projectId, "eval.suites"))
    if (listed === undefined) throw new Error("The suites answer was malformed.")
    patchProject(projectId, { state: "ready", suites: listed.suites, skipped: listed.skipped })
  } catch (error) {
    patchProject(projectId, { state: "error", suites: before?.suites ?? [], skipped: [], message: toHostError(error).message })
  }
  void loadEvalRuns(projectId)
}

function patchProject(projectId: string, value: ProjectSuites): void {
  useEvals.setState((state) => ({ byProject: { ...state.byProject, [projectId]: value } }))
}

export async function getSuite(projectId: string, name: string): Promise<EvalSuiteInfo> {
  const suite = parseOr(EvalSuiteSchema, await projectRpc(projectId, "eval.suite.get", { name }))
  if (suite === undefined) throw new Error("The suite was malformed.")
  return suite
}

export async function saveSuite(projectId: string, suite: EvalSuiteInfo): Promise<void> {
  await projectRpc(projectId, "eval.suite.save", { suite })
  await loadSuites(projectId)
}

export interface Candidate extends EvalCaseInfo {
  readonly sources: number
}

export async function mineCases(projectId: string, limit: number): Promise<readonly Candidate[]> {
  const listed = parseOr(EvalCandidatesSchema, await projectRpc(projectId, "eval.mine", { limit, scan: 1_000 }))
  if (listed === undefined) throw new Error("The engine's answer was malformed.")
  return parseList(EvalCaseSchema, listed.candidates, 50).map((item) => ({ ...item, sources: typeof item.sources === "number" ? item.sources : 0 }))
}

export async function validateCase(projectId: string, item: EvalCaseInfo, check: string): Promise<Verdict> {
  const { id, base, fix, tests } = item
  return parseOr(EvalVerdictSchema, await projectRpc(projectId, "eval.validate", { case: { id, base, fix, tests }, check }))?.verdict ?? "error"
}

/** The check a suite starts with: a Bun project's runs only the case's tests; others run as they are. */
export function evalCheckFrom(command: string | undefined): string {
  if (command === undefined) return ""
  return /^bun test\b/.test(command) ? "bun test {tests}" : command
}

/** A suite name from free text: lowercase, dashes, at most 64 characters. */
export function suiteName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64)
}

// ---------------------------------------------------------------------------------------------
// Runs

export interface EvalStartInput {
  readonly suite: string
  readonly setupIds: readonly string[]
  readonly repeats: number
  readonly parallel: number
  readonly maxMinutes: number
}

function putRun(projectId: string, run: EvalRun): void {
  useEvals.setState((state) => ({ runs: { ...state.runs, [run.runId]: { projectId, run } } }))
}

export async function loadEvalRuns(projectId: string): Promise<void> {
  const listed = parseOr(EvalRunListSchema, await projectRpc(projectId, "eval.list").catch(() => undefined))
  if (listed === undefined) return
  for (const run of parseList(EvalRunSchema, listed.runs, 500)) {
    putRun(projectId, run)
    if (run.state === "running") watch(projectId)
  }
}

export async function startEval(projectId: string, input: EvalStartInput): Promise<EvalRun> {
  const run = parseOr(EvalRunSchema, await projectRpc(projectId, "eval.run", { ...input }))
  if (run === undefined) throw new Error("The eval's answer was malformed.")
  putRun(projectId, run)
  watch(projectId)
  return run
}

export async function stopEval(runId: string): Promise<void> {
  const known = useEvals.getState().runs[runId]
  if (known === undefined) return
  const run = parseOr(EvalRunSchema, await projectRpc(known.projectId, "eval.stop", { runId }))
  if (run !== undefined) putRun(known.projectId, run)
}

const watched = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

function watch(projectId: string): void {
  watched.add(projectId)
  // The eval's setup runs wait on this app for their turns.
  watchSetupRuns(projectId)
  timer ??= setInterval(() => void poll(), POLL_MS)
}

async function poll(): Promise<void> {
  for (const projectId of [...watched]) {
    const listed = parseOr(EvalRunListSchema, await projectRpc(projectId, "eval.list").catch(() => undefined))
    if (listed === undefined) continue
    const runs = parseList(EvalRunSchema, listed.runs, 500)
    for (const run of runs) {
      const before = useEvals.getState().runs[run.runId]?.run
      putRun(projectId, run)
      if (run.state === "running") watchSetupRuns(projectId)
      if (before?.state === "running" && run.state !== "running") {
        const score = totals(run.jobs)
        announceRun(run.state === "succeeded" ? "finished" : "failed", run.runId, `Eval ${run.suite}`, `${String(score.passed)} of ${String(score.scored)} passed`, () => setApp({ view: { kind: "evals", runId: run.runId } }))
        toast(run.state === "succeeded" ? "success" : "info", `Eval ${run.suite}: ${String(score.passed)} of ${String(score.scored)} passed${run.state === "succeeded" ? "" : ` (${run.error?.message ?? run.state})`}`, {
          label: "Open",
          run: () => setApp({ view: { kind: "evals", runId: run.runId } }),
        })
      }
    }
    if (!runs.some((run) => run.state === "running")) watched.delete(projectId)
  }
  if (watched.size === 0 && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

/** An eval's setup-run threads sit in one group per eval, titled by case and setup. */
groupSetupThreads((setupRunId) => {
  for (const { run } of Object.values(useEvals.getState().runs)) {
    const job = run.jobs.find((entry) => entry.setupRunId === setupRunId)
    if (job === undefined) continue
    const setup = run.setups.find((entry) => entry.id === job.setupId)?.name ?? job.setupId
    return { id: run.runId, label: `Eval: ${run.suite}`, title: `${job.caseId}, ${setup}${run.repeats > 1 ? ` #${String(job.repeat)}` : ""}` }
  }
  return undefined
})

// ---------------------------------------------------------------------------------------------
// Scores

const SCORED: ReadonlySet<EvalJob["state"]> = new Set(["passed", "failed", "error"])

export interface Score {
  /** Jobs that ended with a verdict: passed, failed, or errored. */
  readonly scored: number
  readonly passed: number
  readonly total: number
  readonly medianMs?: number
  readonly meanTurns?: number
}

export function totals(jobs: readonly EvalJob[]): Score {
  const scored = jobs.filter((job) => SCORED.has(job.state))
  const durations = scored.flatMap((job) => (job.durationMs === undefined ? [] : [job.durationMs])).sort((a, b) => a - b)
  const turns = scored.flatMap((job) => (job.turns === undefined ? [] : [job.turns]))
  const middle = Math.floor(durations.length / 2)
  return {
    scored: scored.length,
    passed: scored.filter((job) => job.state === "passed").length,
    total: jobs.length,
    ...(durations.length === 0 ? {} : { medianMs: durations.length % 2 === 1 ? (durations[middle] ?? 0) : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2 }),
    ...(turns.length === 0 ? {} : { meanTurns: turns.reduce((sum, value) => sum + value, 0) / turns.length }),
  }
}

/** One row per setup, best pass rate first; ties go to the faster setup. */
export function scoreboard(run: EvalRun): readonly ({ readonly setupId: string; readonly name: string } & Score)[] {
  return run.setups
    .map((setup) => ({ setupId: setup.id, name: setup.name, ...totals(run.jobs.filter((job) => job.setupId === setup.id)) }))
    .sort((a, b) => rate(b) - rate(a) || (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity))
}

export function rate(score: Pick<Score, "passed" | "scored">): number {
  return score.scored === 0 ? 0 : score.passed / score.scored
}

/** The jobs of one case and setup, by repeat. */
export function cell(run: EvalRun, caseId: string, setupId: string): readonly EvalJob[] {
  return run.jobs.filter((job) => job.caseId === caseId && job.setupId === setupId).sort((a, b) => a.repeat - b.repeat)
}
