import { useEffect, useMemo } from "react"
import { toHostError } from "../host"
import type { SetupInfo, WorkflowInfo } from "../protocol/schemas"
import { loadSetups, startSetupRun, useSetups } from "./setups"
import { set, toast } from "./store"
import { loadWorkflows, runWorkflow, useWorkflows } from "./workflowRuns"

/**
 * Saved setups and workflows in the composer's / menu. A setup runs with the message as its task; a
 * workflow starts at once. Both start on the thread's project.
 */

export interface Runnables {
  readonly setups: readonly SetupInfo[]
  readonly workflows: readonly WorkflowInfo[]
}

const NONE: Runnables = { setups: [], workflows: [] }

/** The project's setups and the workflows that may run; each list is read once, when first wanted. */
export function useRunnables(projectId: string, wanted: boolean): Runnables {
  const setups = useSetups((state) => state.byProject[projectId]?.setups)
  const workflows = useWorkflows((state) => state.byProject[projectId]?.workflows)
  useEffect(() => {
    if (!wanted) return
    if (useSetups.getState().byProject[projectId] === undefined) void loadSetups(projectId)
    if (useWorkflows.getState().byProject[projectId] === undefined) void loadWorkflows(projectId)
  }, [wanted, projectId])
  return useMemo(() => (setups === undefined && workflows === undefined ? NONE : { setups: setups ?? [], workflows: (workflows ?? []).filter((workflow) => workflow.state !== "proposed") }), [setups, workflows])
}

/** A name as a / command: "Plan, execute, review" is /plan-execute-review. */
export function commandName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "run"
  )
}

export async function runSetupOn(project: { readonly id: string; readonly name: string }, setup: { readonly id: string; readonly name: string }, task: string, checkout: boolean): Promise<void> {
  try {
    const run = await startSetupRun(project.id, setup.id, task, { checkout })
    toast("success", `${setup.name} started in ${project.name}${checkout ? "'s checkout" : ", in a new worktree"}`, { label: "Open", run: () => set({ view: { kind: "agents", runId: run.runId } }) })
  } catch (error) {
    toast("error", `${setup.name} did not start: ${toHostError(error).message}`)
  }
}

export async function runWorkflowNow(projectId: string, workflow: Pick<WorkflowInfo, "id" | "name">): Promise<void> {
  try {
    const run = await runWorkflow(projectId, workflow.id, "manual")
    toast("success", `${workflow.name} started`, { label: "Open", run: () => set({ view: { kind: "workflows", projectId, workflowId: workflow.id, runId: run.runId } }) })
  } catch (error) {
    toast("error", `${workflow.name} did not start: ${toHostError(error).message}`)
  }
}
