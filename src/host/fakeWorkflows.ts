import type { FakeSetups } from "./fakeSetups"
import { HostError } from "./types"

/**
 * The preview's workflows, kept as the engine keeps them: every project's in one list,
 * a proposal that refuses to run, and runs whose agent steps are setup runs the desktop answers.
 * The first project that lists them gets a few to show the screen.
 */

type Json = Record<string, unknown>

interface FakeWorkflow extends Json {
  id: string
  name: string
  state: "proposed" | "on" | "off"
  trigger: Json & { readonly kind: string }
  where: "worktree" | "checkout"
  steps: (Json & { readonly id: string; readonly kind: string; readonly title: string })[]
  budget: { readonly maxMinutes: number }
  root: string
  createdAt: number
  updatedAt: number
  enabledAt?: number
  runs: Json[]
}

interface FakeRun {
  readonly runId: string
  readonly workflow: FakeWorkflow
  readonly trigger: string
  readonly startedAt: number
  state: "running" | "waiting" | "succeeded" | "failed" | "stopped"
  endedAt?: number
  worktree?: string
  steps: { id: string; kind: string; title: string; status: string; note?: string; setupRuns: string[] }[]
  waiting?: Json & { readonly stepId: string }
  resolve?: (approved: boolean) => void
  notices: { readonly stepId: string; readonly text: string }[]
  openedPr?: { readonly number: number; readonly url: string }
  error?: { readonly code: string; readonly message: string }
}

const ROLE = { route: "claude-code", model: "sonnet", access: "auto-edit" }
const HOUR = 3_600_000

function seeds(root: string, now: number): FakeWorkflow[] {
  const base = { root, createdAt: now - 20 * 86_400_000, updatedAt: now - 2 * 86_400_000, budget: { maxMinutes: 120 } }
  return [
    {
      ...base,
      id: "fix-flaky-tests",
      name: "Fix flaky tests weekly",
      state: "proposed",
      proposedBy: { thread: "fix the build" },
      trigger: { kind: "schedule", schedule: { kind: "weekly", day: 1, hour: 9, minute: 0 } },
      where: "worktree",
      steps: [
        { id: "find", kind: "agent", title: "Find flaky tests", prompt: "Run bun test 5 times and list the tests whose result changes.", runsOn: ROLE },
        { id: "any", kind: "decision", title: "Any found?", question: "Did you find a flaky test?", stopWhen: "no" },
        { id: "fix", kind: "agent", title: "Fix each test", prompt: "Fix each flaky test you found so it passes every time.", runsOn: { ...ROLE, route: "codex", model: undefined } },
        { id: "check", kind: "check", title: "Run the tests until they're stable", command: "bun test", repeat: 5, timeoutMinutes: 15, retry: { step: "fix", times: 2 } },
        { id: "ok", kind: "approval", title: "You approve the diff" },
        { id: "pr", kind: "action", title: "Open a draft pull request", action: "open-pr", draft: true },
      ],
      runs: [],
    },
    {
      ...base,
      id: "review-prs",
      name: "Review PRs that ask for me",
      state: "on",
      enabledAt: now - 10 * 86_400_000,
      trigger: { kind: "pr-review-requested" },
      where: "worktree",
      steps: [
        { id: "review", kind: "agent", title: "Review the pull request", prompt: "Review {pr}. List what blocks merging, then what could be better.", runsOn: { ...ROLE, access: "ask" } },
        { id: "say", kind: "action", title: "Tell me", action: "notify", text: "Review of {pr} is ready" },
      ],
      runs: [
        {
          runId: "wf-past-1",
          trigger: "pr-review-requested",
          pr: 41,
          state: "succeeded",
          startedAt: now - 2 * HOUR - 300_000,
          endedAt: now - 2 * HOUR,
          steps: [
            { id: "review", status: "done" },
            { id: "say", status: "done" },
          ],
        },
      ],
    },
    {
      ...base,
      id: "nightly-bumps",
      name: "Nightly dependency bumps",
      state: "on",
      enabledAt: now - 10 * 86_400_000,
      trigger: { kind: "schedule", schedule: { kind: "weekdays", hour: 2, minute: 0 } },
      where: "worktree",
      steps: [
        { id: "bump", kind: "agent", title: "Bump dependencies", prompt: "Update the dependencies to their latest minor versions.", runsOn: ROLE },
        { id: "check", kind: "check", title: "Run the tests", command: "bun test", repeat: 1, timeoutMinutes: 15, retry: { step: "bump", times: 1 } },
        { id: "ok", kind: "approval", title: "You approve the bump" },
        { id: "pr", kind: "action", title: "Open a pull request", action: "open-pr", draft: false },
      ],
      runs: [
        {
          runId: "wf-past-2",
          trigger: "schedule",
          state: "failed",
          startedAt: now - 8 * HOUR,
          endedAt: now - 8 * HOUR + 600_000,
          steps: [
            { id: "bump", status: "done" },
            { id: "check", status: "failed", note: "failed" },
            { id: "ok", status: "skipped" },
            { id: "pr", status: "skipped" },
          ],
          error: "WORKFLOW_CHECK_FAILED",
        },
      ],
    },
    {
      ...base,
      id: "release-notes",
      name: "Release notes",
      state: "off",
      trigger: { kind: "manual" },
      where: "checkout",
      steps: [
        { id: "write", kind: "agent", title: "Write the release notes", prompt: "Write release notes for the commits since the last tag.", runsOn: ROLE },
        { id: "say", kind: "action", title: "Tell me", action: "notify", text: "Release notes are ready" },
      ],
      runs: [],
    },
  ]
}

export class FakeWorkflows {
  private readonly workflows: FakeWorkflow[] = []
  private readonly runs = new Map<string, FakeRun>()
  private seeded = false

  constructor(private readonly setups: FakeSetups) {}

  async rpc(method: string, params: Json, root: string): Promise<unknown> {
    if (!this.seeded && root !== "/preview/system") {
      this.seeded = true
      this.workflows.push(...seeds(root, Date.now()))
    }
    switch (method) {
      case "workflow.list":
        return { workflows: this.workflows.filter((item) => params.all === true || item.root === root) }
      case "workflow.get":
        return this.find(params.id)
      case "workflow.save": {
        const input = params.workflow as FakeWorkflow | undefined
        if (input === undefined || typeof input.name !== "string" || input.name.trim().length === 0) throw new HostError("CONTROL_WORKFLOW_INVALID", "workflow.name must be text up to 80 characters", 400)
        const decision = input.steps.findIndex((step) => step.kind === "decision")
        if (decision === 0 || (decision > 0 && input.steps[decision - 1]?.kind !== "agent")) throw new HostError("CONTROL_WORKFLOW_INVALID", "a decision must follow an agent step, whose answer it reads", 400)
        const before = this.workflows.find((item) => item.id === input.id)
        const saved: FakeWorkflow = {
          ...input,
          root,
          createdAt: before?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          ...(input.state === "on" ? { enabledAt: before?.state === "on" ? (before.enabledAt ?? Date.now()) : Date.now() } : {}),
          runs: before?.runs ?? [],
        }
        if (before === undefined) this.workflows.push(saved)
        else this.workflows.splice(this.workflows.indexOf(before), 1, saved)
        return saved
      }
      case "workflow.approve":
      case "workflow.enable": {
        const found = this.find(params.id)
        if (method === "workflow.enable" && found.state === "proposed") throw new HostError("CONTROL_WORKFLOW_PROPOSED", "approve a proposed workflow before turning it on or off", 409)
        found.state = method === "workflow.approve" || params.on === true ? "on" : "off"
        if (found.state === "on") found.enabledAt = Date.now()
        found.updatedAt = Date.now()
        return found
      }
      case "workflow.propose": {
        const raw = /```json\s*\n([\s\S]*?)\n```/.exec(String(params.message ?? ""))?.[1]
        const workflow = raw === undefined ? undefined : ((JSON.parse(raw) as { workflow?: FakeWorkflow }).workflow ?? undefined)
        if (workflow === undefined) throw new HostError("CONTROL_INVALID_INPUT", "workflow or a message ending with a workflow block is required", 400)
        let id = workflow.id
        for (let n = 2; this.workflows.some((item) => item.id === id); n += 1) id = `${workflow.id}-${String(n)}`
        const stored: FakeWorkflow = {
          ...workflow,
          budget: (workflow as Partial<FakeWorkflow>).budget ?? { maxMinutes: 120 },
          where: (workflow as Partial<FakeWorkflow>).where ?? "worktree",
          id,
          state: "proposed",
          proposedBy: { thread: String(params.thread ?? "a thread") },
          steps: workflow.steps.map((step) => withDefaults(step, params.runsOn)),
          root,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runs: [],
        }
        this.workflows.push(stored)
        return stored
      }
      case "workflow.delete": {
        const index = this.workflows.findIndex((item) => item.id === params.id)
        if (index >= 0) this.workflows.splice(index, 1)
        return { deleted: index >= 0 }
      }
      case "workflow.due":
        return { due: [] }
      case "workflow.upcoming":
        return { armed: 0 }
      case "workflow.run.start":
        return this.start(this.find(params.id), String(params.trigger ?? "manual"))
      case "workflow.run.status":
        return this.status(this.run(params.runId))
      case "workflow.run.list":
        return { runs: [...this.runs.values()].filter((run) => run.workflow.root === root).map((run) => this.status(run)) }
      case "workflow.run.answer": {
        const run = this.run(params.runId)
        if (run.waiting?.stepId !== params.stepId || run.resolve === undefined) throw new HostError("CONTROL_WORKFLOW_RUN_NOT_WAITING", "the run is not waiting on that step", 409)
        const resolve = run.resolve
        run.waiting = undefined
        run.resolve = undefined
        run.state = "running"
        resolve(params.approved === true)
        return this.status(run)
      }
      case "workflow.run.stop": {
        const run = this.run(params.runId)
        if (run.state === "running" || run.state === "waiting") this.end(run, "stopped", { code: "WORKFLOW_STOPPED", message: "the person stopped the run" })
        return this.status(run)
      }
      default:
        throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
    }
  }

  private find(id: unknown): FakeWorkflow {
    const found = this.workflows.find((item) => item.id === id)
    if (found === undefined) throw new HostError("CONTROL_WORKFLOW_NOT_FOUND", "no workflow has that id", 404)
    return found
  }

  private run(runId: unknown): FakeRun {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined
    if (run === undefined) throw new HostError("CONTROL_WORKFLOW_RUN_NOT_FOUND", "no workflow run has that id", 404)
    return run
  }

  private status(run: FakeRun): Json {
    const { resolve: _resolve, workflow, ...rest } = run
    return { ...rest, workflowId: workflow.id, workflowName: workflow.name, steps: run.steps.map((step) => ({ ...step, setupRuns: [...step.setupRuns] })), notices: [...run.notices] }
  }

  private start(workflow: FakeWorkflow, trigger: string): Json {
    if (workflow.state === "proposed") throw new HostError("CONTROL_WORKFLOW_PROPOSED", "an agent proposed this workflow; approve it before it runs", 409)
    if ([...this.runs.values()].some((run) => run.workflow.id === workflow.id && (run.state === "running" || run.state === "waiting")))
      throw new HostError("CONTROL_WORKFLOW_RUNNING", "this workflow is already running", 409)
    const runId = `wf-${crypto.randomUUID()}`
    const run: FakeRun = {
      runId,
      workflow,
      trigger,
      startedAt: Date.now(),
      state: "running",
      steps: workflow.steps.map((step) => ({ id: step.id, kind: step.kind, title: step.title, status: "pending", setupRuns: [] })),
      notices: [],
      ...(workflow.where === "worktree" ? { worktree: `wf-${runId.slice(3, 11)}` } : {}),
    }
    this.runs.set(runId, run)
    void this.execute(run)
    return this.status(run)
  }

  private async execute(run: FakeRun): Promise<void> {
    let answer = ""
    for (const [index, step] of run.workflow.steps.entries()) {
      const entry = run.steps[index]
      if (entry === undefined || run.state === "stopped") return
      entry.status = "running"
      if (step.kind === "agent") {
        const stepRun = this.setups.startStep(
          {
            id: "workflow-step",
            name: `${run.workflow.name}: ${step.title}`.slice(0, 80),
            roles: { executor: (step.runsOn as Json | undefined) ?? ROLE },
            rules: { approvePlan: false, reviewRounds: 0, budget: { maxTurns: 1, maxMinutes: 120 } },
          },
          String(step.prompt),
          {
            owner: { kind: "workflow", runId: run.runId, name: run.workflow.name },
            ...(run.worktree === undefined ? { checkout: true } : { worktree: { id: run.worktree, path: `/Users/preview/.runrail/worktrees/${run.worktree}`, cwd: `/Users/preview/.runrail/worktrees/${run.worktree}` } }),
          },
        )
        entry.setupRuns.push(stepRun)
        const done = await this.settle(stepRun, run)
        if (done === undefined) return
        answer = done
      } else if (step.kind === "decision") {
        const said = /"answer"\s*:\s*"(yes|no)"/.exec(answer)?.[1] ?? "yes"
        entry.note = said === step.stopWhen ? `answered ${said}; nothing more to do` : `answered ${said}`
        entry.status = "done"
        if (said === step.stopWhen) return this.end(run, "succeeded")
        continue
      } else if (step.kind === "check") {
        await delay(1_200)
        entry.note = Number(step.repeat) > 1 ? `passed ${String(step.repeat)} of ${String(step.repeat)}` : "passed"
      } else if (step.kind === "approval" || (step.kind === "action" && step.action === "slack")) {
        const approved = await new Promise<boolean>((resolve) => {
          run.state = "waiting"
          run.waiting =
            step.kind === "approval"
              ? { kind: "approve", stepId: step.id, title: step.title, ...(typeof step.detail === "string" ? { detail: step.detail } : {}) }
              : { kind: "slack", stepId: step.id, title: step.title, channel: String(step.channel), text: String(step.text) }
          run.resolve = resolve
        })
        if ((run.state as FakeRun["state"]) === "stopped") return
        if (!approved && step.kind === "approval") {
          entry.status = "failed"
          return this.end(run, "stopped", { code: "WORKFLOW_DECLINED", message: `"${step.title}" was declined` })
        }
        entry.note = step.kind === "approval" ? "approved" : approved ? "sent" : "not sent"
      } else if (step.kind === "action" && step.action === "open-pr") {
        await delay(800)
        run.openedPr = { number: 42, url: "https://github.com/example-org/web/pull/42" }
        entry.note = "opened #42"
      } else if (step.kind === "action") {
        run.notices.push({
          stepId: step.id,
          text: String(step.text)
            .split("{opened_pr}")
            .join(run.openedPr?.url ?? "")
            .split("{pr}")
            .join("#41"),
        })
      }
      entry.status = "done"
    }
    this.end(run, "succeeded")
  }

  /** Waits for a step's setup run; its last answer, or undefined when the workflow run ended. */
  private async settle(stepRun: string, run: FakeRun): Promise<string | undefined> {
    for (;;) {
      await delay(400)
      if (run.state === "stopped") {
        this.setups.stopStep(stepRun)
        return undefined
      }
      const state = this.setups.stepOf(stepRun)
      if (state === undefined || state.state === "running" || state.state === "waiting") continue
      if (state.state === "succeeded") return state.text ?? ""
      this.end(run, "failed", { code: "WORKFLOW_STEP_FAILED", message: `a step did not finish${state.error === undefined ? "" : `: ${state.error}`}` })
      return undefined
    }
  }

  private end(run: FakeRun, state: "succeeded" | "failed" | "stopped", error?: { readonly code: string; readonly message: string }): void {
    if (run.state === "succeeded" || run.state === "failed" || run.state === "stopped") return
    run.state = state
    run.endedAt = Date.now()
    run.waiting = undefined
    run.resolve?.(false)
    run.resolve = undefined
    if (error !== undefined) run.error = error
    for (const step of run.steps) if (step.status === "running") step.status = state === "succeeded" ? "done" : "failed"
    for (const step of run.steps) if (step.status === "pending") step.status = "skipped"
    run.workflow.runs = [
      {
        runId: run.runId,
        trigger: run.trigger,
        state,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        steps: run.steps.map((step) => ({ id: step.id, status: step.status, ...(step.note === undefined ? {} : { note: step.note }) })),
        ...(error === undefined ? {} : { error: error.code }),
      },
      ...run.workflow.runs,
    ].slice(0, 20)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FakeStep = FakeWorkflow["steps"][number]

/** The defaults the engine's parseWorkflow fills in, so a proposed block reads back like a stored one. */
function withDefaults(step: FakeStep, runsOn: unknown): FakeStep {
  if (step.kind === "agent" && step.runsOn === undefined) return { ...step, runsOn }
  if (step.kind === "check") return { ...step, repeat: step.repeat ?? 1, timeoutMinutes: step.timeoutMinutes ?? 15 }
  if (step.kind === "action" && step.action === "open-pr") return { ...step, draft: step.draft !== false }
  return step
}
