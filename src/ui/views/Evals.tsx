import { Check, CircleAlert, CircleCheck, CircleDashed, CircleStop, CircleX, FlaskConical, LoaderCircle, Minus, Play, Plus, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { readCheckCommand } from "../../app/checks"
import {
  cell,
  evalCheckFrom,
  getSuite,
  loadEvalRuns,
  loadSuites,
  mineCases,
  rate,
  saveSuite,
  scoreboard,
  startEval,
  stopEval,
  suiteName,
  useEvals,
  validateCase,
  VERDICT_TEXT,
  type Candidate,
  type Verdict,
} from "../../app/evals"
import { loadSetups, useSetups } from "../../app/setups"
import { activeProject, set, useApp } from "../../app/store"
import { toHostError } from "../../host"
import { duration, timeAgo } from "../../lib/format"
import type { EvalJob, EvalRun, EvalSuiteInfo } from "../../protocol/schemas"
import { Button, cx, EmptyState, IconButton, Spinner, useTicker } from "../common"
import { ProjectPicker } from "./ProjectPicker"

/**
 * Evals: cases from the project's own history, each a commit whose tests the run does not
 * see, and runs that score setups against them. The engine runs and scores every case.
 */

type Selected = { readonly kind: "suite"; readonly name: string } | { readonly kind: "find" } | { readonly kind: "run"; readonly runId: string }

export function EvalsView({ runId }: { readonly runId?: string | undefined }) {
  const projects = useApp((state) => state.projects)
  const gitProjects = useMemo(() => projects.filter((project) => project.git), [projects])
  const [projectId, setProjectId] = useState(() => (activeProject()?.git === true ? activeProject()?.id : undefined) ?? gitProjects[0]?.id)
  const [selected, setSelected] = useState<Selected | undefined>(runId === undefined ? undefined : { kind: "run", runId })
  const listing = useEvals((state) => (projectId === undefined ? undefined : state.byProject[projectId]))
  const allRuns = useEvals((state) => state.runs)
  const runs = useMemo(
    () =>
      Object.values(allRuns)
        .filter((entry) => entry.projectId === projectId)
        .map((entry) => entry.run)
        .sort((a, b) => b.startedAt - a.startedAt),
    [allRuns, projectId],
  )
  const now = useTicker(
    runs.some((run) => run.state === "running"),
    1_000,
  )

  useEffect(() => {
    if (runId !== undefined) setSelected({ kind: "run", runId })
  }, [runId])
  useEffect(() => {
    if (projectId === undefined) return
    void loadSuites(projectId)
    void loadSetups(projectId)
  }, [projectId])

  if (projectId === undefined)
    return (
      <main className="agents" aria-label="Evals">
        <div className="agents-empty">
          <EmptyState icon={<FlaskConical size={20} />} title="Add a git project first">
            Eval cases come from a git repository's history. Add one from the threads list.
          </EmptyState>
        </div>
      </main>
    )

  const suites = listing?.suites ?? []
  return (
    <main className="agents" aria-label="Evals">
      <nav className="agents-list" aria-label="Suites and runs">
        <div className="agents-list-top" data-tauri-drag-region>
          <span className="agents-title">Evals</span>
        </div>
        <ProjectPicker projects={gitProjects} value={projectId} onChange={setProjectId} title="Cases come from this project's history" />
        <div className="agents-section">
          <span>Suites</span>
          <IconButton label="Find cases" size="sm" onClick={() => setSelected({ kind: "find" })}>
            <Plus size={14} />
          </IconButton>
        </div>
        {listing?.state === "error" && <p className="agents-note is-error">{listing.message}</p>}
        {listing?.state === "loading" && suites.length === 0 && (
          <p className="agents-note" role="status">
            <Spinner size={12} /> Reading suites…
          </p>
        )}
        {listing?.state === "ready" && suites.length === 0 && <p className="agents-note">No suites yet. Find cases in this project's history to make one.</p>}
        {suites.map((suite) => (
          <button key={suite.name} type="button" className={cx("agents-item", selected?.kind === "suite" && selected.name === suite.name && "is-active")} onClick={() => setSelected({ kind: "suite", name: suite.name })}>
            <span className="agents-item-title">{suite.name}</span>
            <span className="agents-item-meta">
              {suite.cases} case{suite.cases === 1 ? "" : "s"} · <span className="mono">{suite.check}</span>
            </span>
          </button>
        ))}
        {(listing?.skipped.length ?? 0) > 0 && (
          <p className="agents-note">
            {listing?.skipped.join(", ")} could not be read and {listing?.skipped.length === 1 ? "is" : "are"} left out.
          </p>
        )}
        <div className="agents-section">
          <span>Runs</span>
        </div>
        {runs.length === 0 && <p className="agents-note">No eval runs in this project yet.</p>}
        {runs.map((run) => {
          const board = scoreboard(run)
          return (
            <button key={run.runId} type="button" className={cx("agents-item", selected?.kind === "run" && selected.runId === run.runId && "is-active")} onClick={() => setSelected({ kind: "run", runId: run.runId })}>
              <span className="agents-item-title">
                <span className="agents-item-text">{run.suite}</span>
                <span className="agents-item-status">
                  <EvalIcon run={run} />
                </span>
              </span>
              <span className="agents-item-meta">
                {board.map((row) => `${row.name} ${String(row.passed)}/${String(row.scored)}`).join(" · ")} · {timeAgo(run.startedAt, now)}
              </span>
            </button>
          )
        })}
      </nav>
      <section className="agents-detail">
        <div className="agents-detail-top" data-tauri-drag-region />
        {selected?.kind === "run" ? (
          <RunDetail runId={selected.runId} projectId={projectId} now={now} />
        ) : selected?.kind === "find" ? (
          <FindCases key={projectId} projectId={projectId} existing={suites.map((suite) => suite.name)} onSaved={(name) => setSelected({ kind: "suite", name })} />
        ) : selected?.kind === "suite" ? (
          <SuiteDetail key={`${projectId}:${selected.name}`} projectId={projectId} name={selected.name} onStarted={(id) => setSelected({ kind: "run", runId: id })} />
        ) : (
          <div className="agents-empty">
            <EmptyState
              icon={<FlaskConical size={20} />}
              title="Score setups on your own code"
              actions={
                <Button size="sm" variant="primary" icon={<Search size={13} />} onClick={() => setSelected({ kind: "find" })}>
                  Find cases
                </Button>
              }
            >
              A case is a past commit that changed code and its tests. Each setup gets the code from before it with the tests hidden; it passes when the tests pass on what it wrote.
            </EmptyState>
          </div>
        )}
      </section>
    </main>
  )
}

function EvalIcon({ run }: { readonly run: EvalRun }) {
  if (run.state === "running") return <LoaderCircle size={12} className="spin" aria-label="Running" />
  if (run.state === "succeeded") return <CircleCheck size={12} className="tone-green" aria-label="Done" />
  if (run.state === "stopped") return <CircleStop size={12} className="muted" aria-label="Stopped" />
  return <CircleX size={12} className="tone-red" aria-label="Failed" />
}

// ---------------------------------------------------------------------------------------------
// Finding cases

type Row = Candidate & { readonly picked: boolean; readonly verdict?: Verdict | "checking" }

function FindCases({ projectId, existing, onSaved }: { readonly projectId: string; readonly existing: readonly string[]; readonly onSaved: (name: string) => void }) {
  const [check, setCheck] = useState("")
  const [limit, setLimit] = useState(10)
  const [rows, setRows] = useState<readonly Row[]>()
  const [finding, setFinding] = useState(false)
  const [validating, setValidating] = useState(false)
  const [name, setName] = useState("cases")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const stopRef = useRef(false)
  // Leaving the page ends a validation between cases instead of running the rest unseen.
  useEffect(
    () => () => {
      stopRef.current = true
    },
    [],
  )

  useEffect(() => {
    void readCheckCommand(projectId).then((found) => setCheck((current) => (current.length === 0 ? evalCheckFrom(found) : current)))
  }, [projectId])

  const find = async (): Promise<void> => {
    setFinding(true)
    setError(undefined)
    try {
      setRows((await mineCases(projectId, limit)).map((item) => ({ ...item, picked: true })))
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setFinding(false)
    }
  }

  const validate = async (): Promise<void> => {
    if (rows === undefined) return
    setValidating(true)
    setError(undefined)
    stopRef.current = false
    const mark = (id: string, verdict: Row["verdict"]): void => setRows((current) => current?.map((row) => (row.id === id ? { ...row, ...(verdict === undefined ? {} : { verdict }) } : row)))
    for (const row of rows.filter((item) => item.picked && item.verdict !== "valid")) {
      if (stopRef.current) break
      mark(row.id, "checking")
      try {
        mark(row.id, await validateCase(projectId, row, check.trim()))
      } catch (cause) {
        mark(row.id, "error")
        setError(toHostError(cause).message)
      }
    }
    setValidating(false)
  }

  const valid = rows?.filter((row) => row.picked && row.verdict === "valid") ?? []
  const save = async (): Promise<void> => {
    const target = suiteName(name)
    if (target.length === 0 || valid.length === 0) return
    setSaving(true)
    setError(undefined)
    try {
      // Saving under a suite's name adds to it.
      const before = existing.includes(target) ? (await getSuite(projectId, target)).cases : []
      const cases = [...before, ...valid.filter((row) => !before.some((item) => item.id === row.id)).map(({ id, base, fix, tests }) => ({ id, base, fix, tests }))]
      await saveSuite(projectId, { name: target, check: check.trim(), cases })
      onSaved(target)
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agents-body">
      <div className="form">
        <header className="agents-run-head">
          <h1>Find cases</h1>
          <p className="muted">Commits that changed code and its tests, newest first. A case is kept only when its tests fail before the commit and pass after it.</p>
        </header>
        <label className="field">
          <span className="field-label">Check</span>
          <input className="input mono" value={check} maxLength={4_000} spellCheck={false} placeholder="bun test {tests}" onChange={(event) => setCheck(event.target.value)} />
          <span className="form-hint">
            <span className="mono">{"{tests}"}</span> stands for the case's test files. Without it the whole check runs.
          </span>
        </label>
        <div className="agents-row">
          <label className="field evals-limit">
            <span className="field-label">Look for</span>
            <select className="select" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[5, 10, 20, 50].map((count) => (
                <option key={count} value={count}>
                  {count} cases
                </option>
              ))}
            </select>
          </label>
          <span className="agents-spacer" />
          <Button variant={rows === undefined ? "primary" : "secondary"} icon={<Search size={13} />} loading={finding} onClick={() => void find()}>
            Find
          </Button>
        </div>
        {rows !== undefined && rows.length === 0 && <p className="form-hint">No commit in the last 1000 changes both code and tests.</p>}
        {rows !== undefined && rows.length > 0 && (
          <>
            <ul className="evals-cases" aria-label="Candidates">
              {rows.map((row) => (
                <li key={row.id} className="evals-case">
                  <input
                    type="checkbox"
                    aria-label={`Use ${row.id}`}
                    checked={row.picked}
                    disabled={validating}
                    onChange={(event) => setRows((current) => current?.map((item) => (item.id === row.id ? { ...item, picked: event.target.checked } : item)))}
                  />
                  <span className="mono evals-case-id">{row.id}</span>
                  <span className="evals-case-tests" title={row.tests.join("\n")}>
                    {row.tests[0]}
                    {row.tests.length > 1 ? ` and ${String(row.tests.length - 1)} more` : ""}
                  </span>
                  <span className="agents-spacer" />
                  <VerdictMark verdict={row.verdict} />
                </li>
              ))}
            </ul>
            <div className="agents-row">
              {validating ? (
                <Button variant="ghost" icon={<CircleStop size={13} />} onClick={() => (stopRef.current = true)}>
                  Stop after this one
                </Button>
              ) : (
                <Button variant="secondary" icon={<Check size={13} />} disabled={check.trim().length === 0 || !rows.some((row) => row.picked && row.verdict !== "valid")} onClick={() => void validate()}>
                  Check the picked cases
                </Button>
              )}
              <span className="form-hint">Each check runs twice in a scratch worktree.</span>
            </div>
            <div className="agents-row">
              <label className="field evals-name">
                <span className="field-label">Suite</span>
                <input className="input" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
              </label>
              <span className="agents-spacer" />
              <Button variant="primary" loading={saving} disabled={valid.length === 0 || suiteName(name).length === 0 || validating} onClick={() => void save()}>
                Save {valid.length} valid case{valid.length === 1 ? "" : "s"}
              </Button>
            </div>
            <p className="form-hint">
              Saved to <span className="mono">.runrail/evals/{suiteName(name) || "…"}.yaml</span> in the project: commit ids and test paths only.
            </p>
          </>
        )}
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
      </div>
    </div>
  )
}

function VerdictMark({ verdict }: { readonly verdict: Row["verdict"] }): ReactNode {
  if (verdict === undefined) return null
  if (verdict === "checking")
    return (
      <span className="evals-verdict" role="status">
        <Spinner size={12} /> Checking
      </span>
    )
  return (
    <span className={cx("evals-verdict", verdict === "valid" ? "tone-green" : "muted")}>
      {verdict === "valid" ? <Check size={12} aria-hidden="true" /> : <Minus size={12} aria-hidden="true" />} {VERDICT_TEXT[verdict]}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// A suite and starting a run

function SuiteDetail({ projectId, name, onStarted }: { readonly projectId: string; readonly name: string; readonly onStarted: (runId: string) => void }) {
  const [suite, setSuite] = useState<EvalSuiteInfo>()
  const [error, setError] = useState<string>()
  const setups = useSetups((state) => state.byProject[projectId]?.setups ?? [])
  const [picked, setPicked] = useState<readonly string[]>([])
  const [repeats, setRepeats] = useState(1)
  const [parallel, setParallel] = useState(2)
  const [minutes, setMinutes] = useState(120)
  const [starting, setStarting] = useState(false)
  const running = useEvals((state) => Object.values(state.runs).some((entry) => entry.projectId === projectId && entry.run.state === "running"))

  useEffect(() => {
    void getSuite(projectId, name).then(setSuite, (cause: unknown) => setError(toHostError(cause).message))
  }, [projectId, name])

  const start = async (): Promise<void> => {
    setStarting(true)
    setError(undefined)
    try {
      const run = await startEval(projectId, { suite: name, setupIds: picked, repeats, parallel, maxMinutes: minutes })
      onStarted(run.runId)
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setStarting(false)
    }
  }

  const total = (suite?.cases.length ?? 0) * picked.length * repeats
  return (
    <div className="agents-body">
      <div className="form">
        <header className="agents-run-head">
          <h1>{name}</h1>
          {suite !== undefined && (
            <p className="muted">
              {suite.cases.length} case{suite.cases.length === 1 ? "" : "s"} · checked with <span className="mono">{suite.check}</span>
            </p>
          )}
        </header>
        <section className="agents-run-box">
          <span className="field-label">Setups to score</span>
          {setups.length === 0 && <p className="form-hint">No setups yet. Make one on Agents first.</p>}
          {setups.map((setup) => (
            <label key={setup.id} className="evals-setup">
              <input
                type="checkbox"
                checked={picked.includes(setup.id)}
                disabled={!picked.includes(setup.id) && picked.length >= 4}
                onChange={(event) => setPicked((current) => (event.target.checked ? [...current, setup.id] : current.filter((id) => id !== setup.id)))}
              />
              {setup.name}
            </label>
          ))}
          <div className="field-row">
            <label className="field">
              <span className="field-label">Runs of each</span>
              <select className="select" value={repeats} onChange={(event) => setRepeats(Number(event.target.value))}>
                {[1, 2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">At once</span>
              <select className="select" value={parallel} onChange={(event) => setParallel(Number(event.target.value))}>
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Most minutes</span>
              <input className="input" type="number" min={1} max={1440} value={minutes} onChange={(event) => setMinutes(Math.min(1_440, Math.max(1, Math.round(Number(event.target.value) || 1))))} />
            </label>
          </div>
          <div className="agents-row">
            <span className="form-hint">
              {total === 0 ? "Pick at least one setup." : `${String(total)} run${total === 1 ? "" : "s"}, each in its own copy of the project. They run unattended: plans are not held for approval, and executors have Full access in those copies.`}
            </span>
            <span className="agents-spacer" />
            <Button variant="primary" icon={<Play size={13} />} loading={starting} disabled={total === 0 || running} onClick={() => void start()}>
              Start eval
            </Button>
          </div>
          {running && <p className="form-hint">An eval is running in this project. One runs at a time.</p>}
        </section>
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
        {suite !== undefined && (
          <ul className="evals-cases" aria-label="Cases">
            {suite.cases.map((item) => (
              <li key={item.id} className="evals-case">
                <span className="mono evals-case-id">{item.id}</span>
                <span className="evals-case-tests" title={item.tests.join("\n")}>
                  {item.tests[0]}
                  {item.tests.length > 1 ? ` and ${String(item.tests.length - 1)} more` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A run: the scoreboard and every case

function RunDetail({ runId, projectId, now }: { readonly runId: string; readonly projectId: string; readonly now: number }) {
  const known = useEvals((state) => state.runs[runId])
  useEffect(() => {
    if (known === undefined) void loadEvalRuns(projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])
  if (known === undefined)
    return (
      <div className="agents-empty">
        <EmptyState icon={<FlaskConical size={20} />} title="This eval is not in the project">
          Its results may have been removed.
        </EmptyState>
      </div>
    )
  const run = known.run
  const board = scoreboard(run)
  const done = run.jobs.filter((job) => job.state !== "queued" && job.state !== "running" && job.state !== "checking").length
  return (
    <div className="agents-body">
      <header className="agents-run-head">
        <div className="agents-run-title">
          <EvalIcon run={run} />
          <h1>{run.suite}</h1>
        </div>
        <p className="muted">
          {run.state === "running" ? `${String(done)} of ${String(run.jobs.length)} done` : run.state === "succeeded" ? "done" : run.state} · {duration((run.endedAt ?? now) - run.startedAt)}
        </p>
        {run.state === "running" && (
          <Button size="sm" variant="ghost" icon={<CircleStop size={13} />} onClick={() => void stopEval(run.runId)}>
            Stop eval
          </Button>
        )}
      </header>
      {run.error !== undefined && run.error.code !== "EVAL_STOPPED" && (
        <p className="form-warning" role="alert">
          <CircleAlert size={13} /> {run.error.message}
        </p>
      )}
      <table className="evals-board">
        <thead>
          <tr>
            <th scope="col">Setup</th>
            <th scope="col">Passed</th>
            <th scope="col">Median time</th>
            <th scope="col">Turns</th>
          </tr>
        </thead>
        <tbody>
          {board.map((row, index) => (
            <tr key={row.setupId}>
              <th scope="row">
                {row.name}
                {index === 0 && board.length > 1 && row.scored > 0 && <span className="evals-best">Best</span>}
              </th>
              <td>
                <span className="evals-rate">
                  <span className="evals-rate-bar" aria-hidden="true">
                    <span style={{ width: `${String(Math.round(rate(row) * 100))}%` }} />
                  </span>
                  {row.passed}/{row.scored}
                  {row.scored < row.total && <span className="muted"> of {row.total}</span>}
                </span>
              </td>
              <td>{row.medianMs === undefined ? "-" : duration(row.medianMs)}</td>
              <td>{row.meanTurns === undefined ? "-" : row.meanTurns.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="evals-grid">
        <thead>
          <tr>
            <th scope="col">Case</th>
            {run.setups.map((setup) => (
              <th key={setup.id} scope="col">
                {setup.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.cases.map((caseId) => (
            <tr key={caseId}>
              <th scope="row" className="mono">
                {caseId}
              </th>
              {run.setups.map((setup) => (
                <td key={setup.id}>
                  <span className="evals-cell">
                    {cell(run, caseId, setup.id).map((job) => (
                      <JobMark key={job.index} job={job} />
                    ))}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="form-hint">Kept in ~/.runrail/evals: ids, states, counts and durations, never prompts or answers. A case opens its setup run.</p>
    </div>
  )
}

const JOB_TEXT: Readonly<Record<EvalJob["state"], string>> = { queued: "Waiting", running: "Working", checking: "Checking", passed: "Passed", failed: "Failed", skipped: "Skipped", error: "Could not run" }

function JobMark({ job }: { readonly job: EvalJob }) {
  const icon =
    job.state === "passed" ? (
      <Check size={12} />
    ) : job.state === "failed" ? (
      <X size={12} />
    ) : job.state === "running" || job.state === "checking" ? (
      <LoaderCircle size={12} className="spin" />
    ) : job.state === "error" ? (
      <CircleAlert size={12} />
    ) : (
      <CircleDashed size={12} />
    )
  const counts = job.check?.counts
  const label = `Run ${String(job.repeat)}: ${JOB_TEXT[job.state]}${counts === undefined ? "" : `, ${String(counts.passed)}/${String(counts.total)} tests`}${job.durationMs === undefined ? "" : `, ${duration(job.durationMs)}`}${job.error === undefined ? "" : ` (${job.error})`}`
  const setupRunId = job.setupRunId
  return (
    <button
      type="button"
      className={cx("evals-job", `is-${job.state}`)}
      title={label}
      aria-label={label}
      disabled={setupRunId === undefined}
      onClick={() => setupRunId !== undefined && set({ view: { kind: "agents", runId: setupRunId } })}
    >
      {icon}
    </button>
  )
}
