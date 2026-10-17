import { HostError } from "./types"

/**
 * The preview's setups: kept in memory, and a run that walks plan, approval, steps with a check
 * after each, and one review, asking the desktop for each turn as the engine's `setup.run.*` does.
 */

type Role = "planner" | "executor" | "reviewer"

interface FakeSetup {
  readonly id: string
  readonly name: string
  readonly roles: Partial<Record<Role, Record<string, unknown>>> & { readonly executor: Record<string, unknown> }
  readonly rules: { readonly approvePlan: boolean; readonly reviewRounds: number; readonly check?: string; readonly budget: { readonly maxTurns: number; readonly maxMinutes: number } }
}

interface Step {
  readonly id: string
  readonly kind: "plan" | "approve" | "step" | "check" | "review" | "fix"
  readonly title: string
  status: "running" | "done" | "failed" | "skipped"
  role?: Role
  note?: string
}

interface FakeRun {
  readonly runId: string
  readonly setup: FakeSetup
  readonly task: string
  readonly startedAt: number
  state: "running" | "waiting" | "succeeded" | "failed" | "stopped"
  endedAt?: number
  turns: number
  worktree?: string
  /** An eval's run: every role works in this worktree. */
  given?: Record<string, unknown> & { readonly id: string }
  plan?: { readonly summary?: string; readonly steps: readonly { readonly title: string; readonly detail?: string }[] }
  steps: Step[]
  waiting?: Record<string, unknown> & { readonly kind: "turn" | "approve"; readonly stepId: string }
  /** What comes after the waiting step is answered. */
  next?: (answer: Record<string, unknown>) => void
  error?: { readonly code: string; readonly message: string }
  /** A workflow step's run: the workflow run it belongs to, and whether it works in the checkout. */
  owner?: { readonly kind: "workflow"; readonly runId: string; readonly name: string }
  checkout?: boolean
  /** The last turn's answer, for a workflow's decision. */
  lastText?: string
}

const PLAN_FORMAT = 'End your final message with exactly one fenced code block tagged json: {"summary": "...", "steps": [{"title": "...", "detail": "..."}]}'

// A project's setup from the `project-setup` preview: it runs a check with full access, so it waits for trust.
const REPO_SETUP: FakeSetup = { id: "repo-team", name: "Repo team", roles: { executor: { route: "claude-code", access: "full" } }, rules: { approvePlan: false, reviewRounds: 0, check: "bun test", budget: { maxTurns: 40, maxMinutes: 120 } } }
const REPO_DIGEST = "5e7c".repeat(16)

export class FakeSetups {
  private readonly setups = new Map<string, FakeSetup>()
  private readonly runs = new Map<string, FakeRun>()
  private project: FakeSetup | undefined
  private trusted = false

  /** The `project-setup` preview: the repository brings one setup that needs the person's trust. */
  seedProject(on: boolean): void {
    this.project = on ? REPO_SETUP : undefined
    this.trusted = false
  }

  rpc(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "setup.list":
        return { setups: [...this.setups.values()].map((setup) => ({ ...setup, source: "user" })).concat(this.project === undefined ? [] : [{ ...this.project, source: "project", trust: { digest: REPO_DIGEST, trusted: this.trusted } } as never]), skipped: 0 }
      case "setup.trust":
        if (this.project === undefined || params.id !== this.project.id) throw new HostError("CONTROL_SETUP_INVALID", "only a project's setup that runs a check or with full access needs trust", 400)
        if (params.digest !== REPO_DIGEST) throw new HostError("CONTROL_SETUP_INVALID", "the setup changed since it was shown; look it over again", 400)
        this.trusted = true
        return { ...this.project, source: "project", trust: { digest: REPO_DIGEST, trusted: true } }
      case "setup.save": {
        const setup = params.setup as FakeSetup | undefined
        if (setup === undefined || typeof setup.id !== "string" || typeof setup.name !== "string" || setup.name.trim().length === 0) throw new HostError("CONTROL_SETUP_INVALID", "setup.name must be text up to 80 characters", 400)
        if (setup.rules.reviewRounds > 0 && setup.roles.reviewer === undefined) throw new HostError("CONTROL_SETUP_INVALID", "review rounds need a reviewer", 400)
        this.setups.set(setup.id, setup)
        return { ...setup, source: "user" }
      }
      case "setup.delete":
        return { deleted: this.setups.delete(String(params.id)) }
      case "setup.run.start": {
        const setup = this.setups.get(String(params.setupId)) ?? (params.setupId === this.project?.id ? this.project : undefined)
        if (setup === undefined) throw new HostError("CONTROL_SETUP_NOT_FOUND", "no setup has that id", 404)
        if (setup === this.project && !this.trusted) throw new HostError("CONTROL_SETUP_UNTRUSTED", `"${setup.name}" comes from this project and runs a check command and gives a role full access; look it over and trust it before it runs`, 409)
        const given = typeof params.worktree === "object" && params.worktree !== null ? (params.worktree as FakeRun["given"]) : undefined
        const run: FakeRun = { runId: `setup-${crypto.randomUUID()}`, setup, task: String(params.task), startedAt: Date.now(), state: "running", turns: 0, steps: [], ...(given === undefined ? { checkout: params.checkout === true } : { given, worktree: given.id }) }
        this.runs.set(run.runId, run)
        if (setup.roles.planner !== undefined) this.plan(run)
        else this.execute(run, 0)
        return this.status(run)
      }
      case "setup.run.status":
        return this.status(this.find(params.runId))
      case "setup.run.list":
        return { runs: [...this.runs.values()].map((run) => this.status(run)) }
      case "setup.run.answer": {
        const run = this.find(params.runId)
        if (run.waiting === undefined || run.waiting.stepId !== params.stepId || run.next === undefined) throw new HostError("CONTROL_SETUP_RUN_NOT_WAITING", "the run is not waiting on that step", 409)
        const next = run.next
        run.waiting = undefined
        run.next = undefined
        run.state = "running"
        if (typeof params.worktree === "string") run.worktree ??= params.worktree
        // A beat between steps, as the engine's checks take.
        setTimeout(() => next(params), 600)
        return this.status(run)
      }
      case "setup.run.stop": {
        const run = this.find(params.runId)
        if (run.state === "running" || run.state === "waiting") this.end(run, "stopped", { code: "SETUP_STOPPED", message: "the person stopped the run" })
        return this.status(run)
      }
      default:
        throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
    }
  }

  /** A workflow's step: a one-role setup of its own, run like any other (engine `WorkflowRuns`). */
  startStep(setup: FakeSetup, task: string, options: { readonly owner: NonNullable<FakeRun["owner"]>; readonly worktree?: Record<string, unknown> & { readonly id: string }; readonly checkout?: boolean }): string {
    const run: FakeRun = { runId: `setup-${crypto.randomUUID()}`, setup, task, startedAt: Date.now(), state: "running", turns: 0, steps: [], owner: options.owner, ...(options.worktree === undefined ? { checkout: options.checkout === true } : { given: options.worktree, worktree: options.worktree.id }) }
    this.runs.set(run.runId, run)
    this.execute(run, 0)
    return run.runId
  }

  /** How a step's run is doing, and its last answer. */
  stepOf(runId: string): { readonly state: FakeRun["state"]; readonly text?: string; readonly error?: string } | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : { state: run.state, ...(run.lastText === undefined ? {} : { text: run.lastText }), ...(run.error === undefined ? {} : { error: run.error.message }) }
  }

  stopStep(runId: string): void {
    const run = this.runs.get(runId)
    if (run !== undefined && (run.state === "running" || run.state === "waiting")) this.end(run, "stopped", { code: "SETUP_STOPPED", message: "the workflow run stopped" })
  }

  private find(runId: unknown): FakeRun {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined
    if (run === undefined) throw new HostError("CONTROL_SETUP_RUN_NOT_FOUND", "no setup run has that id", 404)
    return run
  }

  private status(run: FakeRun): unknown {
    const { next: _next, setup, given: _given, checkout: _checkout, lastText: _lastText, ...rest } = run
    return { ...rest, setupId: setup.id, setupName: setup.name, ...(run.checkout === true ? { checkout: true } : {}), steps: run.steps.map((step) => ({ ...step })) }
  }

  private end(run: FakeRun, state: "succeeded" | "failed" | "stopped", error?: { readonly code: string; readonly message: string }): void {
    run.state = state
    run.endedAt = Date.now()
    run.waiting = undefined
    run.next = undefined
    for (const step of run.steps) if (step.status === "running") step.status = state === "succeeded" ? "done" : "failed"
    if (error !== undefined) run.error = error
  }

  private step(run: FakeRun, kind: Step["kind"], title: string, role?: Role): Step {
    const step: Step = { id: String(run.steps.length + 1), kind, title, status: "running", ...(role === undefined ? {} : { role }) }
    run.steps.push(step)
    return step
  }

  private turn(run: FakeRun, step: Step, role: Role, prompt: string, next: (answer: Record<string, unknown>) => void): void {
    if (run.state === "stopped") return
    run.turns += 1
    run.state = "waiting"
    const runsOn = run.setup.roles[role] ?? run.setup.roles.executor
    run.waiting = { kind: "turn", stepId: `${step.id}-${String(run.turns)}`, role, thread: `${run.runId}:${role}`, runsOn, mode: role === "executor" ? "agent" : "plan", access: role === "executor" ? (runsOn.access ?? "ask") : "ask", title: `${run.setup.name}: ${role}`, prompt, ...(run.given === undefined ? {} : { worktree: run.given }), ...(run.checkout === true ? { checkout: true } : {}) }
    run.next = (answer) => {
      run.lastText = typeof answer.text === "string" ? answer.text : ""
      if (answer.ok !== true) return this.end(run, "failed", { code: "SETUP_TURN_FAILED", message: `the ${role}'s turn did not finish` })
      next(answer)
    }
  }

  private plan(run: FakeRun): void {
    const step = this.step(run, "plan", "Plan", "planner")
    this.turn(run, step, "planner", `Plan this task. Read the code you need; do not change anything.\n\n${run.task}\n\n${PLAN_FORMAT}`, (answer) => {
      const raw = /```json\s*\n([\s\S]*?)\n```/.exec(String(answer.text ?? ""))?.[1]
      let plan: FakeRun["plan"]
      try {
        plan = raw === undefined ? undefined : (JSON.parse(raw) as FakeRun["plan"])
      } catch {
        plan = undefined
      }
      if (plan === undefined || plan.steps.length === 0) {
        step.status = "failed"
        return this.end(run, "failed", { code: "SETUP_PLAN_FORMAT", message: "the planner did not end with a plan in the expected format" })
      }
      run.plan = plan
      step.status = "done"
      step.note = `${String(plan.steps.length)} steps`
      if (!run.setup.rules.approvePlan) return this.execute(run, 0)
      const approve = this.step(run, "approve", "Approve the plan")
      run.state = "waiting"
      run.waiting = { kind: "approve", stepId: `approve-${approve.id}`, plan }
      run.next = (reply) => {
        if (reply.approved !== true) {
          approve.status = "failed"
          return this.end(run, "failed", { code: "SETUP_PLAN_DECLINED", message: "the plan was declined" })
        }
        if (typeof reply.plan === "object" && reply.plan !== null) run.plan = reply.plan as FakeRun["plan"]
        approve.status = "done"
        this.execute(run, 0)
      }
    })
  }

  private execute(run: FakeRun, index: number): void {
    const steps = run.plan?.steps ?? [{ title: run.task }]
    const item = steps[index]
    if (item === undefined) return this.review(run, 1)
    const step = this.step(run, "step", `${String(index + 1)}. ${item.title}`, "executor")
    this.turn(run, step, "executor", `Do step ${String(index + 1)} of ${String(steps.length)}: ${item.title}\n\nDo only this step, then stop. Runrail runs the checks after it.`, () => {
      step.status = "done"
      if (run.setup.rules.check !== undefined) {
        const check = this.step(run, "check", `Check after step ${String(index + 1)}`)
        check.status = "done"
        check.note = "passed 128/128"
      }
      this.execute(run, index + 1)
    })
  }

  private review(run: FakeRun, round: number): void {
    if (round > run.setup.rules.reviewRounds || run.setup.roles.reviewer === undefined) return this.end(run, "succeeded")
    const step = this.step(run, "review", `Review, round ${String(round)}`, "reviewer")
    this.turn(run, step, "reviewer", "Review the changes in this worktree against the task. You are reviewing only: do not edit files.", () => {
      step.status = "done"
      step.note = "nothing blocking"
      this.end(run, "succeeded")
    })
  }
}
