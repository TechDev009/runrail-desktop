import type { FakeSetups } from "./fakeSetups"
import { HostError } from "./types"

/**
 * The preview's evals: a few mined cases, suites in memory, and runs that start each case as a
 * setup run in its own worktree and score it once that run ends, as the engine's `eval.*` does.
 */

interface FakeCase {
  readonly id: string
  readonly base: string
  readonly fix: string
  readonly tests: readonly string[]
}

interface FakeJob {
  readonly index: number
  readonly caseId: string
  readonly setupId: string
  readonly repeat: number
  state: "queued" | "running" | "checking" | "passed" | "failed" | "skipped" | "error"
  setupRunId?: string
  setupState?: string
  worktree?: string
  turns?: number
  durationMs?: number
  startedAt?: number
  check?: { readonly exitCode: number; readonly timedOut: boolean; readonly counts: { readonly runner: string; readonly passed: number; readonly failed: number; readonly skipped: number; readonly total: number } }
}

interface FakeEval {
  readonly runId: string
  readonly suite: string
  readonly setups: readonly { readonly id: string; readonly name: string }[]
  readonly cases: readonly string[]
  readonly repeats: number
  readonly parallel: number
  state: "running" | "succeeded" | "stopped" | "failed"
  readonly startedAt: number
  endedAt?: number
  readonly jobs: FakeJob[]
  error?: { readonly code: string; readonly message: string }
}

const hex = (seed: number): string => Array.from({ length: 40 }, (_, index) => "0123456789abcdef"[(seed * 7 + index * 13 + index * index) % 16]).join("")

const MINED: readonly (FakeCase & { readonly sources: number; readonly verdict: string; readonly message: string })[] = [
  { id: "4f1c2a9e07d3", base: hex(1), fix: hex(2), tests: ["test/session.test.ts"], sources: 2, verdict: "valid", message: "Skip blank lines when parsing a session" },
  { id: "9b03e5d1c2aa", base: hex(3), fix: hex(4), tests: ["test/picker.test.ts", "test/catalog.test.ts"], sources: 3, verdict: "valid", message: "Keep the chosen model when the catalog reloads" },
  { id: "c7d2e8f40b19", base: hex(5), fix: hex(6), tests: ["test/format.test.ts"], sources: 1, verdict: "passes-before", message: "Format durations over an hour" },
  { id: "1e6a7b2c9d04", base: hex(7), fix: hex(8), tests: ["test/rail.test.ts"], sources: 2, verdict: "valid", message: "Show the waiting count on the rail" },
  { id: "8a5f3c1d6e72", base: hex(9), fix: hex(10), tests: ["src/__tests__/diff.test.ts"], sources: 4, verdict: "fails-after", message: "Collapse unchanged diff hunks" },
  { id: "3d9e0f4a5b81", base: hex(11), fix: hex(12), tests: ["test/checks.test.ts"], sources: 1, verdict: "valid", message: "Parse vitest counts from a check's output" },
]

export class FakeEvals {
  private readonly suites = new Map<string, { readonly check: string; readonly cases: readonly FakeCase[] }>()
  private readonly runs = new Map<string, FakeEval>()

  constructor(private readonly setups: FakeSetups) {}

  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "eval.mine":
        await new Promise((resolve) => setTimeout(resolve, 700))
        return { candidates: MINED.slice(0, typeof params.limit === "number" ? params.limit : 20).map(({ verdict: _verdict, message: _message, ...item }) => item) }
      case "eval.validate": {
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        const item = params.case as FakeCase | undefined
        return { id: item?.id ?? "", verdict: MINED.find((entry) => entry.id === item?.id)?.verdict ?? "error" }
      }
      case "eval.suites":
        return { suites: [...this.suites.entries()].map(([name, suite]) => ({ name, cases: suite.cases.length, check: suite.check })), skipped: [] }
      case "eval.suite.get": {
        const suite = this.suites.get(String(params.name))
        if (suite === undefined) throw new HostError("CONTROL_EVAL_NOT_FOUND", "no suite has that name", 404)
        return { name: params.name, ...suite }
      }
      case "eval.suite.save": {
        const suite = params.suite as { readonly name: string; readonly check: string; readonly cases: readonly FakeCase[] }
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(suite.name)) throw new HostError("CONTROL_EVAL_INVALID", "a suite name is 1-64 lowercase letters, digits, dots, dashes or underscores", 400)
        this.suites.set(suite.name, { check: suite.check, cases: suite.cases })
        return suite
      }
      case "eval.run":
        return this.start(params)
      case "eval.status":
        return this.find(params.runId)
      case "eval.list":
        return { runs: [...this.runs.values()] }
      case "eval.stop": {
        const run = this.find(params.runId)
        if (run.state === "running") {
          run.error = { code: "EVAL_STOPPED", message: "the person stopped the eval" }
          for (const job of run.jobs) if (job.setupRunId !== undefined && (job.state === "running" || job.state === "checking")) this.setups.rpc("setup.run.stop", { runId: job.setupRunId })
          for (const job of run.jobs) if (job.state !== "passed" && job.state !== "failed" && job.state !== "error") job.state = "skipped"
          run.state = "stopped"
          run.endedAt = Date.now()
        }
        return run
      }
      default:
        throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
    }
  }

  private find(runId: unknown): FakeEval {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined
    if (run === undefined) throw new HostError("CONTROL_EVAL_RUN_NOT_FOUND", "no eval run has that id", 404)
    return run
  }

  private start(params: Record<string, unknown>): FakeEval {
    if ([...this.runs.values()].some((run) => run.state === "running")) throw new HostError("CONTROL_EVAL_LIMIT", "an eval is already running in this project; stop it first", 429)
    const name = String(params.suite)
    const suite = this.suites.get(name)
    if (suite === undefined) throw new HostError("CONTROL_EVAL_NOT_FOUND", "no suite has that name", 404)
    const listed = this.setups.rpc("setup.list", {}) as { readonly setups: readonly { readonly id: string; readonly name: string }[] }
    const setups = (params.setupIds as string[]).map((id) => {
      const setup = listed.setups.find((entry) => entry.id === id)
      if (setup === undefined) throw new HostError("CONTROL_SETUP_NOT_FOUND", "no setup has that id", 404)
      return { id: setup.id, name: setup.name }
    })
    const repeats = typeof params.repeats === "number" ? params.repeats : 1
    const jobs: FakeJob[] = []
    for (const item of suite.cases) for (const setup of setups) for (let repeat = 1; repeat <= repeats; repeat += 1) jobs.push({ index: jobs.length, caseId: item.id, setupId: setup.id, repeat, state: "queued" })
    const run: FakeEval = {
      runId: `eval-${crypto.randomUUID()}`,
      suite: name,
      setups,
      cases: suite.cases.map((item) => item.id),
      repeats,
      parallel: typeof params.parallel === "number" ? params.parallel : 1,
      state: "running",
      startedAt: Date.now(),
      jobs,
    }
    this.runs.set(run.runId, run)
    this.tick(run)
    return run
  }

  /** Starts queued cases up to `parallel`, scores ended ones, and comes back until every case is done. */
  private tick(run: FakeEval): void {
    if (run.state !== "running") return
    for (const job of run.jobs.filter((entry) => entry.state === "running" && entry.setupRunId !== undefined)) {
      const status = this.setups.rpc("setup.run.status", { runId: job.setupRunId }) as { readonly state: string; readonly turns: number }
      if (status.state === "running" || status.state === "waiting") continue
      job.setupState = status.state
      job.turns = status.turns
      job.state = "checking"
      setTimeout(() => {
        // Some cases pass for every setup, some for none, the rest depend on the setup.
        const seed = [...`${job.caseId}${job.setupId}${String(job.repeat)}`].reduce((sum, char) => sum + char.charCodeAt(0), 0)
        const passed = status.state === "succeeded" && seed % 3 !== 0
        job.check = { exitCode: passed ? 0 : 1, timedOut: false, counts: { runner: "bun", passed: passed ? 24 : 21, failed: passed ? 0 : 3, skipped: 0, total: 24 } }
        if (job.state === "checking") job.state = passed ? "passed" : "failed"
        job.durationMs = Date.now() - (job.startedAt ?? run.startedAt)
      }, 900)
    }
    const busy = run.jobs.filter((entry) => entry.state === "running" || entry.state === "checking").length
    for (const job of run.jobs.filter((entry) => entry.state === "queued").slice(0, Math.max(0, run.parallel - busy))) {
      const item = MINED.find((entry) => entry.id === job.caseId)
      const worktree = { id: `ev-${run.runId.slice(5, 13)}-${String(job.index)}`, path: `/preview/worktrees/ev-${String(job.index)}`, cwd: `/preview/worktrees/ev-${String(job.index)}` }
      const started = this.setups.rpc("setup.run.start", { setupId: job.setupId, task: item?.message ?? "Make the change this repository is missing.", worktree }) as { readonly runId: string }
      job.state = "running"
      job.setupRunId = started.runId
      job.worktree = worktree.id
      job.startedAt = Date.now()
    }
    if (run.jobs.every((entry) => entry.state !== "queued" && entry.state !== "running" && entry.state !== "checking")) {
      run.state = "succeeded"
      run.endedAt = Date.now()
      return
    }
    setTimeout(() => this.tick(run), 500)
  }
}
