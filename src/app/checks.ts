import { create } from "zustand"
import { toHostError } from "../host"
import { duration } from "../lib/format"
import { CheckResultSchema, parseOr, WorkspaceReadSchema, type CheckResult } from "../protocol/schemas"
import { onTurnEnded, projectRpc, send } from "./engines"
import { newId } from "./persist"
import { runtimeOf, threadById } from "./store"

/**
 * Checks on Best of N: each run's worktree is checked with the command the
 * person typed, through the engine's `check.run`. Results are kept for this session only.
 */

export const CHECK_TIMEOUT_MS = 10 * 60_000

export type CheckState =
  | { readonly state: "running"; readonly runId: string; readonly startedAt: number }
  | { readonly state: "done"; readonly result: CheckResult; readonly at: number }
  | { readonly state: "error"; readonly message: string }

export const useChecks = create<{ readonly byThread: Readonly<Record<string, CheckState>> }>()(() => ({ byThread: {} }))

function setCheck(threadId: string, state: CheckState): void {
  useChecks.setState((current) => ({ byThread: { ...current.byThread, [threadId]: state } }))
}

export async function runCheck(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const command = thread?.group?.check
  if (thread?.worktree === undefined || command === undefined) return
  const current = useChecks.getState().byThread[threadId]
  if (current?.state === "running") return
  const runId = newId("chk").slice(0, 60)
  setCheck(threadId, { state: "running", runId, startedAt: Date.now() })
  try {
    const result = parseOr(CheckResultSchema, await projectRpc(thread.projectId, "check.run", { id: runId, worktree: thread.worktree.id, command, timeoutMs: CHECK_TIMEOUT_MS }))
    setCheck(threadId, result === undefined ? { state: "error", message: "The check's answer was malformed." } : { state: "done", result, at: Date.now() })
  } catch (error) {
    setCheck(threadId, { state: "error", message: toHostError(error).message })
  }
}

export async function stopCheck(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const current = useChecks.getState().byThread[threadId]
  if (thread === undefined || current?.state !== "running") return
  await projectRpc(thread.projectId, "check.stop", { id: current.runId }).catch(() => undefined)
}

// A run that finished its turn is checked, when its group asks for that; a failed or stopped turn is not.
onTurnEnded((threadId) => {
  const thread = threadById(threadId)
  if (thread?.group?.check === undefined || thread.group.autoCheck === false || thread.worktree === undefined) return
  if (runtimeOf(threadId).timeline.lastTurnEnd?.status !== "completed") return
  void runCheck(threadId)
})

export type CheckTone = "green" | "red" | "amber" | "gray"

/** One line for a run's header: "Passed 128/128 · 41s", "Failed 2 of 128", or what stopped it. */
export function checkLine(state: CheckState | undefined, now = Date.now()): { readonly tone: CheckTone; readonly text: string } {
  if (state === undefined) return { tone: "gray", text: "Not checked" }
  if (state.state === "running") return { tone: "amber", text: `Checking… ${duration(now - state.startedAt)}` }
  if (state.state === "error") return { tone: "red", text: `Could not check: ${state.message}` }
  const result = state.result
  const time = duration(result.durationMs)
  if (result.stopped) return { tone: "gray", text: `Stopped after ${time}` }
  if (result.timedOut) return { tone: "red", text: `Timed out after ${time}` }
  const counts = result.counts
  if (result.passed) return { tone: "green", text: counts === undefined || counts.total === 0 ? `Passed · ${time}` : `Passed ${String(counts.passed)}/${String(counts.total)} · ${time}` }
  if (counts !== undefined && counts.failed > 0) return { tone: "red", text: `Failed ${String(counts.failed)} of ${String(counts.total)} · ${time}` }
  return { tone: "red", text: `Failed${result.exitCode === undefined ? "" : ` (exit ${String(result.exitCode)})`} · ${time}` }
}

/** The run that passed with the smallest change; a suggestion only, the person still applies. */
export function suggestedRun(runs: readonly { readonly threadId: string; readonly passed: boolean; readonly lines?: number }[]): string | undefined {
  let best: { readonly threadId: string; readonly lines: number } | undefined
  for (const run of runs) if (run.passed && run.lines !== undefined && run.lines > 0 && (best === undefined || run.lines < best.lines)) best = { threadId: run.threadId, lines: run.lines }
  return best?.threadId
}

/** What a failed run is sent: the command and the end of its output. */
export function failurePrompt(command: string, result: CheckResult): string {
  const why = result.timedOut ? "timed out" : result.counts !== undefined && result.counts.failed > 0 ? `failed ${String(result.counts.failed)} of ${String(result.counts.total)}` : `failed${result.exitCode === undefined ? "" : ` with exit code ${String(result.exitCode)}`}`
  const fence = result.tail.includes("```") ? "~~~~" : "```"
  return [`The check \`${command}\` ${why}. The end of its output:`, "", fence, result.tail, fence, "", "Fix what it reports, then stop; the check runs again when you finish."].join("\n")
}

export function sendFailures(threadId: string): void {
  const thread = threadById(threadId)
  const state = useChecks.getState().byThread[threadId]
  if (thread?.group?.check === undefined || state?.state !== "done" || state.result.passed) return
  send(threadId, { text: failurePrompt(thread.group.check, state.result) })
}

/**
 * A check command from the project: `package.json`'s `check` script, else its `test` script, run
 * with the package manager its lockfile names; else `cargo test` for a Cargo project.
 */
export function checkCommandFrom(files: { readonly packageJson?: string; readonly lockfiles: readonly string[]; readonly cargo: boolean }): string | undefined {
  if (files.packageJson !== undefined) {
    let scripts: Record<string, unknown> = {}
    let manager: string | undefined
    try {
      const parsed = JSON.parse(files.packageJson) as { scripts?: unknown; packageManager?: unknown }
      if (typeof parsed.scripts === "object" && parsed.scripts !== null && !Array.isArray(parsed.scripts)) scripts = parsed.scripts as Record<string, unknown>
      if (typeof parsed.packageManager === "string") manager = /^(npm|pnpm|yarn|bun)@/.exec(parsed.packageManager)?.[1]
    } catch {
      // A package.json that does not parse names no script.
    }
    manager ??= files.lockfiles.includes("bun.lock") || files.lockfiles.includes("bun.lockb") ? "bun" : files.lockfiles.includes("pnpm-lock.yaml") ? "pnpm" : files.lockfiles.includes("yarn.lock") ? "yarn" : "npm"
    const script = typeof scripts.check === "string" ? "check" : typeof scripts.test === "string" && !/no test specified/.test(scripts.test) ? "test" : undefined
    if (script !== undefined) return manager === "npm" ? (script === "test" ? "npm test" : "npm run check") : `${manager} run ${script}`
  }
  return files.cargo ? "cargo test" : undefined
}

const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"] as const

/** Reads the few files `checkCommandFrom` needs from the project folder. */
export async function readCheckCommand(projectId: string): Promise<string | undefined> {
  const read = async (path: string, maxBytes: number): Promise<string | undefined> => parseOr(WorkspaceReadSchema, await projectRpc(projectId, "workspace.read", { path, maxBytes }).catch(() => undefined))?.content
  const [packageJson, cargo, ...locks] = await Promise.all([read("package.json", 256 * 1024), read("Cargo.toml", 1), ...LOCKFILES.map((path) => read(path, 1))])
  return checkCommandFrom({ ...(packageJson === undefined ? {} : { packageJson }), cargo: cargo !== undefined, lockfiles: LOCKFILES.filter((_, index) => locks[index] !== undefined) })
}
