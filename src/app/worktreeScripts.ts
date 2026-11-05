import { toHostError } from "../host"
import { WorktreeScriptResultSchema, WorktreeScriptsSchema, parseOr, type WorktreeScriptResult, type WorktreeScripts } from "../protocol/schemas"
import { confirmAction } from "./actions"
import { projectRpc } from "./engines"
import { projectById, set, toast } from "./store"

/**
 * A project's `.runrail/worktree.json` holds `setup`, `run`, and `archive` commands. The file is
 * part of the repository, so anyone who can change the repository can change it: nothing runs
 * until the person has seen the commands and approved them, and the approval is the hash of the
 * file as approved, so an edit asks again. The engine checks the hash on every run.
 */

const NAMES = ["setup", "run", "archive"] as const
const ARCHIVE_TIMEOUT_MS = 120_000
const ASK_TIMEOUT_MS = 10 * 60_000

/** Hashes declined this session, per project, so a Best of N run does not ask once per candidate. */
const declined = new Set<string>()

/** The project's scripts, or undefined when the engine has none to give or cannot be asked. */
export async function readWorktreeScripts(projectId: string): Promise<WorktreeScripts | undefined> {
  try {
    const read = parseOr(WorktreeScriptsSchema, await projectRpc(projectId, "worktree.scripts"))
    return read !== undefined && NAMES.some((name) => read.scripts[name] !== undefined) ? read : undefined
  } catch (error) {
    // An engine without the capability, or a file the engine refused: no scripts run.
    const failure = toHostError(error)
    if (failure.code === "CONTROL_INVALID_INPUT") toast("error", `.runrail/worktree.json was not used: ${failure.message}`)
    return undefined
  }
}

/** The commands as the approval shows them, one line each. */
export function scriptsSummary(read: WorktreeScripts): string {
  return NAMES.flatMap((name) => {
    const command = read.scripts[name]
    return command === undefined ? [] : [`${name}:\n${command}`]
  }).join("\n\n")
}

export function scriptsApproved(projectId: string, hash: string): boolean {
  return projectById(projectId)?.worktreeScriptsApproved === hash
}

/** True once the person approves these exact commands; false when they decline or do not answer. */
export function approveScripts(projectId: string, read: WorktreeScripts): Promise<boolean> {
  if (scriptsApproved(projectId, read.hash)) return Promise.resolve(true)
  const key = `${projectId}:${read.hash}`
  if (declined.has(key)) return Promise.resolve(false)
  const project = projectById(projectId)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ASK_TIMEOUT_MS)
    const finish = (answer: boolean): void => {
      clearTimeout(timer)
      if (!answer) declined.add(key)
      resolve(answer)
    }
    confirmAction({
      title: "Run this project's worktree scripts?",
      body: `${project?.name ?? "This project"} has .runrail/worktree.json. These commands run on this computer, in each new worktree, with your permissions:\n\n${scriptsSummary(read)}\n\nThey come from the repository, so read them first. If the file changes, Runrail asks again.`,
      confirm: "Approve and run",
      onConfirm: () => {
        set((state) => ({ projects: state.projects.map((item) => (item.id === projectId ? { ...item, worktreeScriptsApproved: read.hash } : item)) }))
        finish(true)
      },
      onCancel: () => finish(false),
    })
  })
}

const lastLine = (output: string): string => {
  const lines = output.trim().split("\n")
  return (lines[lines.length - 1] ?? "").slice(0, 160)
}

/**
 * Runs the project's setup script in a new worktree, asking first when it is new or changed.
 * A script that fails or is declined never stops the thread from starting; the person is told.
 */
export async function runSetupScript(projectId: string, worktreeId: string): Promise<WorktreeScriptResult | undefined> {
  const read = await readWorktreeScripts(projectId)
  if (read?.scripts.setup === undefined || !(await approveScripts(projectId, read))) return undefined
  toast("info", "Setting up the worktree…")
  try {
    const result = parseOr(WorktreeScriptResultSchema, await projectRpc(projectId, "worktree.script.run", { id: worktreeId, kind: "setup", approvedHash: read.hash }))
    if (result === undefined) return undefined
    if (result.ok) toast("info", `Setup finished in ${String(Math.max(1, Math.round(result.durationMs / 1_000)))} s`)
    else toast("error", result.timedOut ? "Setup ran out of time and was stopped." : `Setup failed (exit ${String(result.exitCode)}): ${lastLine(result.output)}`)
    return result
  } catch (error) {
    toast("error", `Setup did not run: ${toHostError(error).message}`)
    return undefined
  }
}

/**
 * Runs the archive script before a worktree is deleted. Only for commands already approved: a
 * delete never opens a question.
 */
export async function runArchiveScript(projectId: string, worktreeId: string): Promise<void> {
  const read = await readWorktreeScripts(projectId)
  if (read?.scripts.archive === undefined || !scriptsApproved(projectId, read.hash)) return
  try {
    const result = parseOr(WorktreeScriptResultSchema, await projectRpc(projectId, "worktree.script.run", { id: worktreeId, kind: "archive", approvedHash: read.hash, timeoutMs: ARCHIVE_TIMEOUT_MS }))
    if (result !== undefined && !result.ok) toast("error", result.timedOut ? "The archive script ran out of time and was stopped." : `The archive script failed (exit ${String(result.exitCode)}): ${lastLine(result.output)}`)
  } catch (error) {
    toast("error", `The archive script did not run: ${toHostError(error).message}`)
  }
}

/** The `run` command, once approved, for a terminal tab to type; undefined when there is none or it was declined. */
export async function runCommandFor(projectId: string): Promise<string | undefined> {
  const read = await readWorktreeScripts(projectId)
  if (read?.scripts.run === undefined || !(await approveScripts(projectId, read))) return undefined
  return read.scripts.run
}

/** Types the project's approved `run` command into a new terminal tab of the thread on screen. */
export async function runScriptInTerminal(projectId: string): Promise<void> {
  const command = await runCommandFor(projectId)
  if (command === undefined) return void toast("info", "This project has no run script, or it was not approved.")
  // The terminal emulator loads on demand, so it is not part of this module's chunk.
  const { typeInNewTerminal } = await import("../ui/inspector/TerminalPane")
  if (!typeInNewTerminal(command)) toast("info", "Open a thread first, then run the script.")
}
