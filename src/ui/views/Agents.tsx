import { ArrowDown, ArrowUp, Bot, Check, ChevronsUpDown, CircleAlert, CircleCheck, CircleDashed, CircleStop, CircleX, FolderGit2, FolderOpen, GitBranch, Hammer, ListChecks, LoaderCircle, Play, Plus, SearchCheck, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { confirmAction } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import { readCheckCommand } from "../../app/checks"
import { PERMISSION_LABELS, type PermissionPreset, type Project } from "../../app/persist"
import { reasoningView, selectionLabel, THINKING_NAME, type Selection } from "../../app/picker"
import { active, answerApproval, deleteSetup, draftOf, draftSetup, loadRuns, loadSetups, pickModelHint, ROLE_NAMES, roleSelection, rolesWithoutModel, saveSetup, SETUP_ROLES, startedElsewhere, startSetupRun, stopSetupRun, trustSetup, useSetups, type SetupDraft, type SetupRoleName } from "../../app/setups"
import { activeProject, openThread, set, startSelection, toast, useApp } from "../../app/store"
import { toHostError } from "../../host"
import type { Thinking } from "../../host/types"
import { duration, timeAgo } from "../../lib/format"
import type { SetupInfo, SetupPlanInfo, SetupRole, SetupRun } from "../../protocol/schemas"
import { Button, cx, EmptyState, IconButton, Spinner, statusLabel, StatusIcon, Toggle, useTicker } from "../common"
import { useStatuses } from "../hooks"
import { RunsOnSelect } from "../RunsOnSelect"
import { ProjectPicker } from "./ProjectPicker"

/**
 * Agents: setups that plan, execute, and review, and their runs. The engine runs each
 * setup; this screen edits setups, starts runs, shows their steps, and asks for plan approvals.
 */

type Selected = { readonly kind: "setup"; readonly id: string } | { readonly kind: "new" } | { readonly kind: "run"; readonly runId: string }

const ROLE_ICONS: Readonly<Record<SetupRoleName, ReactNode>> = {
  planner: <ListChecks size={14} aria-hidden />,
  executor: <Hammer size={14} aria-hidden />,
  reviewer: <SearchCheck size={14} aria-hidden />,
}
const ROLE_WORK: Readonly<Record<SetupRoleName, string>> = { planner: "Reads the code and plans", executor: "Changes the code", reviewer: "Reads and reviews the result" }

export function AgentsView({ runId }: { readonly runId?: string | undefined }) {
  const projects = useApp((state) => state.projects)
  const gitProjects = useMemo(() => projects.filter((project) => project.git), [projects])
  const [projectId, setProjectId] = useState(() => (activeProject()?.git === true ? activeProject()?.id : undefined) ?? gitProjects[0]?.id)
  const [selected, setSelected] = useState<Selected | undefined>(runId === undefined ? undefined : { kind: "run", runId })
  const listing = useSetups((state) => (projectId === undefined ? undefined : state.byProject[projectId]))
  const allRuns = useSetups((state) => state.runs)
  // An eval's runs are listed on Evals.
  const runs = useMemo(() => Object.values(allRuns).filter((entry) => entry.projectId === projectId && !startedElsewhere(entry.run.runId)).map((entry) => entry.run).sort((a, b) => b.startedAt - a.startedAt), [allRuns, projectId])
  const now = useTicker(runs.some(active), 1_000)
  const catalog = useCatalog(projectId)
  const developer = useApp((state) => state.prefs.developer)

  useEffect(() => {
    if (runId !== undefined) setSelected({ kind: "run", runId })
  }, [runId])
  useEffect(() => {
    if (projectId !== undefined) void loadSetups(projectId)
  }, [projectId])

  if (projectId === undefined)
    return (
      <main className="agents" aria-label="Agents">
        <div className="agents-empty">
          <EmptyState icon={<Bot size={20} />} title="Add a git project first">
            A setup works in a worktree of a git repository. Add one from the threads list.
          </EmptyState>
        </div>
      </main>
    )

  const setups = listing?.setups ?? []
  const current = selected?.kind === "setup" ? setups.find((setup) => setup.id === selected.id) : undefined

  return (
    <main className="agents" aria-label="Agents">
      <nav className="agents-list" aria-label="Setups and runs">
        <div className="agents-list-top" data-tauri-drag-region>
          <span className="agents-title">Agents</span>
        </div>
        <ProjectPicker projects={gitProjects} value={projectId} onChange={setProjectId} title="Setups run in a worktree of this project" />
        <div className="agents-section">
          <span>Setups</span>
          <IconButton label="New setup" size="sm" onClick={() => setSelected({ kind: "new" })}>
            <Plus size={14} />
          </IconButton>
        </div>
        {listing?.state === "error" && <p className="agents-note is-error">{listing.message}</p>}
        {listing?.state === "loading" && setups.length === 0 && (
          <p className="agents-note" role="status">
            <Spinner size={12} /> Reading setups…
          </p>
        )}
        {listing?.state === "ready" && setups.length === 0 && <p className="agents-note">No setups yet. A setup names who plans, who executes, and who reviews.</p>}
        {setups.map((setup) => (
          <button key={setup.id} type="button" className={cx("agents-item", selected?.kind === "setup" && selected.id === setup.id && "is-active")} onClick={() => setSelected({ kind: "setup", id: setup.id })}>
            <span className="agents-item-title">
              <span className="agents-item-text">{setup.name}</span>
            </span>
            <span className="agents-item-meta">{rolesLine(setup, catalog, developer)}</span>
          </button>
        ))}
        {(listing?.skipped ?? 0) > 0 && <p className="agents-note">{listing?.skipped} setup{listing?.skipped === 1 ? "" : "s"} in the files could not be read and are left out.</p>}
        <div className="agents-section">
          <span>Runs</span>
        </div>
        {runs.length === 0 && <p className="agents-note">No runs in this project since the app started.</p>}
        {runs.map((run) => (
          <button key={run.runId} type="button" className={cx("agents-item", selected?.kind === "run" && selected.runId === run.runId && "is-active")} title={run.task} onClick={() => setSelected({ kind: "run", runId: run.runId })}>
            <span className="agents-item-title">
              <span className="agents-item-text">{run.task}</span>
              <span className="agents-item-status">
                <RunIcon run={run} />
              </span>
            </span>
            <span className="agents-item-meta">
              {run.setupName} · {timeAgo(run.startedAt, now)}
            </span>
          </button>
        ))}
      </nav>
      <section className="agents-detail">
        <div className="agents-detail-top" data-tauri-drag-region />
        {selected?.kind === "run" ? (
          <RunDetail runId={selected.runId} projectId={projectId} now={now} />
        ) : selected?.kind === "new" ? (
          <SetupEditor key="new" projectId={projectId} projects={gitProjects} onSaved={(id) => setSelected({ kind: "setup", id })} />
        ) : current !== undefined ? (
          <SetupEditor
            key={current.id}
            projectId={projectId}
            projects={gitProjects}
            existing={current}
            onSaved={(id) => setSelected({ kind: "setup", id })}
            onStarted={(id, where) => {
              setProjectId(where)
              setSelected({ kind: "run", runId: id })
            }}
            onDeleted={() => setSelected(undefined)}
          />
        ) : (
          <div className="agents-empty">
            <EmptyState icon={<Bot size={20} />} title="Plan, execute, review" actions={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setSelected({ kind: "new" })}>New setup</Button>}>
              A setup has one tool plan the task, another carry out each step with a check after it, and a third review the result. You approve the plan before anything changes.
            </EmptyState>
          </div>
        )}
      </section>
    </main>
  )
}

/** What a setup's roles run on, in a few words: one name when every role runs on the same. */
/** What a project's setup would do without asking, in the words of the trust prompt. */
function trustRisk(setup: SetupInfo): string {
  const full = SETUP_ROLES.filter((role) => setup.roles[role]?.access === "full").map((role) => ROLE_NAMES[role].toLowerCase())
  const check = setup.rules.check === undefined ? undefined : `It runs \`${setup.rules.check}\` as its check, in your project.`
  const access = full.length === 0 ? undefined : `It lets the ${full.join(" and the ")} run commands and edits with no approval.`
  return [check, access].filter((line) => line !== undefined).join(" ")
}

function rolesLine(setup: SetupInfo, catalog: ReturnType<typeof useCatalog>, developer: boolean): string {
  const names = SETUP_ROLES.flatMap((role) => {
    const value = setup.roles[role]
    return value === undefined ? [] : [selectionLabel(roleSelection(value), developer, catalog.models, catalog.harnesses)]
  })
  const distinct = [...new Set(names)]
  return distinct.length === 1 && names.length > 1 ? `${distinct[0] ?? ""} for every role` : names.join(" → ")
}

function RunIcon({ run }: { readonly run: SetupRun }) {
  if (run.state === "waiting" && run.waiting?.kind === "approve") return <CircleAlert size={13} className="tone-amber" aria-label="Waiting for you" />
  if (active(run)) return <LoaderCircle size={13} className="spin" aria-label="Running" />
  if (run.state === "succeeded") return <CircleCheck size={13} className="tone-green" aria-label="Done" />
  if (run.state === "stopped") return <CircleStop size={13} className="muted" aria-label="Stopped" />
  return <CircleX size={13} className="tone-red" aria-label="Failed" />
}

/** A role's mark: its icon on its own tint, the same in the editor, a run's roles, and its steps. */
function RoleMark({ role }: { readonly role: SetupRoleName }) {
  return <span className={cx("agents-role-mark", `is-${role}`)}>{ROLE_ICONS[role]}</span>
}

// ---------------------------------------------------------------------------------------------
// Editor

const ACCESS_LEVELS: readonly PermissionPreset[] = ["ask", "auto-edit", "auto", "full"]

function SetupEditor({
  projectId,
  projects,
  existing,
  onSaved,
  onStarted,
  onDeleted,
}: {
  readonly projectId: string
  /** The git projects a run can start in. */
  readonly projects: readonly Project[]
  readonly existing?: SetupInfo
  readonly onSaved: (id: string) => void
  readonly onStarted?: (runId: string, projectId: string) => void
  readonly onDeleted?: () => void
}) {
  const prefs = useApp((state) => state.prefs)
  const catalog = useCatalog(projectId)
  const readOnly = existing?.source === "project"
  const [draft, setDraft] = useState<SetupDraft>(() => (existing === undefined ? draftSetup(toRole(startSelection(prefs))) : draftOf(existing)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [task, setTask] = useState("")
  const [starting, setStarting] = useState(false)
  // A project's own setup lives in its repository, so it runs only there.
  const runProjects = readOnly ? projects.filter((project) => project.id === projectId) : projects
  const [runProjectId, setRunProjectId] = useState(projectId)
  const runProject = runProjects.find((project) => project.id === runProjectId) ?? runProjects[0]
  const [separate, setSeparate] = useState(true)
  useEffect(() => setRunProjectId(projectId), [projectId])

  useEffect(() => {
    if (existing !== undefined || draft.rules.check !== undefined) return
    void readCheckCommand(projectId).then((found) => found !== undefined && setDraft((current) => (current.rules.check === undefined ? { ...current, rules: { ...current.rules, check: found } } : current)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const setRole = (role: SetupRoleName, value: SetupRole | undefined): void =>
    setDraft((current) => {
      const roles = { ...current.roles }
      if (value === undefined) delete roles[role as "planner" | "reviewer"]
      else roles[role] = value
      const rules = role === "reviewer" && value === undefined ? { ...current.rules, reviewRounds: 0 } : role === "planner" && value === undefined ? { ...current.rules, approvePlan: false } : current.rules
      return { ...current, roles: roles as SetupDraft["roles"], rules }
    })
  const setRules = (patch: Partial<SetupDraft["rules"]>): void => setDraft((current) => ({ ...current, rules: { ...current.rules, ...patch } }))

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const saved = await saveSetup(projectId, { ...draft, name: draft.name.trim() })
      toast("success", `Saved ${saved.name}`)
      onSaved(saved.id)
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (existing === undefined || runProject === undefined || task.trim().length === 0 || starting || rolesWithoutModel(existing.roles, prefs.developer).length > 0) return
    if (untrusted !== undefined) return askTrust()
    setStarting(true)
    setError(undefined)
    try {
      const started = await startSetupRun(runProject.id, existing.id, task.trim(), { checkout: !separate })
      setTask("")
      onStarted?.(started.runId, runProject.id)
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setStarting(false)
    }
  }

  const untrusted = existing?.trust?.trusted === false ? existing.trust.digest : undefined
  const askTrust = (): void => {
    if (existing === undefined || untrusted === undefined) return
    confirmAction({
      title: `Trust "${existing.name}" from this repository?`,
      body: `${trustRisk(existing)} Whoever can change this repository wrote it. Trust only this version: a later change to it asks again.`,
      confirm: "Trust this version",
      danger: true,
      onConfirm: () => void trustSetup(projectId, existing.id, untrusted).catch((cause: unknown) => setError(toHostError(cause).message)),
    })
  }

  const approves = existing !== undefined && existing.rules.approvePlan && existing.roles.planner !== undefined
  const unbound = rolesWithoutModel(draft.roles, prefs.developer)
  const savedUnbound = existing === undefined ? [] : rolesWithoutModel(existing.roles, prefs.developer)
  return (
    <div className="agents-body">
      <header className="agents-page-head">
        <h1>{existing?.name ?? "New setup"}</h1>
        <p>{existing !== undefined ? rolesLine(existing, catalog, prefs.developer) : "Who plans, who executes, who reviews, and the rules between them."}</p>
      </header>
      {existing !== undefined && (
        <section className="agents-launch" aria-label="Run it on a task">
          <div className="agents-launch-head">
            <span className="agents-launch-icon">
              <Play size={14} aria-hidden />
            </span>
            <div>
              <h2>Run it on a task</h2>
              <p>{approves ? "The planner reads the code and proposes steps. You approve them before anything changes." : "The planner reads the code and proposes steps, and the executor carries them out."}</p>
            </div>
          </div>
          <textarea
            className="agents-launch-input"
            rows={4}
            value={task}
            aria-label="Task"
            placeholder="Describe the change you want…"
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void run()
              }
            }}
          />
          <div className="agents-launch-options">
            <label className="agents-launch-field">
              <span className="agents-launch-label">Project</span>
              <span className={cx("agents-launch-picker", runProjects.length < 2 && "is-fixed")}>
                <FolderGit2 size={13} aria-hidden />
                <select aria-label="Project to run in" value={runProject?.id} disabled={runProjects.length < 2} onChange={(event) => setRunProjectId(event.target.value)}>
                  {runProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                {runProjects.length > 1 && <ChevronsUpDown size={12} className="agents-launch-chevron" aria-hidden />}
              </span>
            </label>
            <div className="agents-launch-field">
              <span className="agents-launch-label" id="agents-launch-where">
                Works in
              </span>
              <div className="agents-segment" role="radiogroup" aria-labelledby="agents-launch-where">
                <button type="button" role="radio" aria-checked={separate} className={cx("agents-segment-item", separate && "is-on")} onClick={() => setSeparate(true)}>
                  <GitBranch size={12} aria-hidden /> New worktree
                </button>
                <button type="button" role="radio" aria-checked={!separate} className={cx("agents-segment-item", !separate && "is-on")} onClick={() => setSeparate(false)}>
                  <FolderOpen size={12} aria-hidden /> Main checkout
                </button>
              </div>
            </div>
          </div>
          <div className="agents-launch-foot">
            {savedUnbound.length > 0 ? (
              <span className="agents-launch-where is-warn">
                <CircleAlert size={13} aria-hidden /> {pickModelHint(savedUnbound)} below, then save.
              </span>
            ) : (
              <span className="agents-launch-where">{separate ? "Changes stay on a new branch in a folder of their own until you merge them." : `Changes land in ${runProject?.name ?? "the project"}'s own folder, on the branch it has checked out.`}</span>
            )}
            {untrusted !== undefined ? (
              <Button variant="primary" icon={<CircleAlert size={13} />} onClick={askTrust}>
                Trust this setup to run it
              </Button>
            ) : (
              <Button variant="primary" icon={<Play size={13} />} kbd="mod+enter" loading={starting} disabled={task.trim().length === 0 || runProject === undefined || savedUnbound.length > 0} onClick={() => void run()}>
                Start in {runProject?.name ?? "this project"}
              </Button>
            )}
          </div>
        </section>
      )}
      {readOnly && <p className="form-hint">From the project's .runrail/setups.json. Edit it there; it is shared through the repository.</p>}
      <section className="agents-card" aria-label="Roles">
        <div className="agents-card-head">
          <h2>Roles</h2>
          <span>The planner and the reviewer only read</span>
        </div>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={draft.name} maxLength={80} disabled={readOnly} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <div className="agents-roles-list">
          {SETUP_ROLES.map((role) => (
            <RoleField key={role} role={role} value={draft.roles[role]} catalog={catalog} developer={prefs.developer} disabled={readOnly} onChange={(value) => setRole(role, value)} />
          ))}
        </div>
      </section>
      <section className="agents-card" aria-label="Rules">
        <div className="agents-card-head">
          <h2>Rules</h2>
          <span>Ask stops at each change for you in the executor's thread</span>
        </div>
        <div className="agents-toggle-row">
          <div>
            <span className="agents-toggle-title">Approve the plan first</span>
            <span className="agents-toggle-hint">Nothing changes until you approve the planner's steps.</span>
          </div>
          <Toggle label="Approve the plan first" checked={draft.rules.approvePlan && draft.roles.planner !== undefined} disabled={readOnly || draft.roles.planner === undefined} onChange={(value) => setRules({ approvePlan: value })} />
        </div>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Review rounds</span>
            <select className="select" value={draft.rules.reviewRounds} disabled={readOnly || draft.roles.reviewer === undefined} onChange={(event) => setRules({ reviewRounds: Number(event.target.value) })}>
              {[0, 1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count === 0 ? "No review" : String(count)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Most turns</span>
            <input className="input" type="number" min={1} max={500} value={draft.rules.budget.maxTurns} disabled={readOnly} onChange={(event) => setRules({ budget: { ...draft.rules.budget, maxTurns: clamp(event.target.value, 1, 500) } })} />
          </label>
          <label className="field">
            <span className="field-label">Most minutes</span>
            <input className="input" type="number" min={1} max={1440} value={draft.rules.budget.maxMinutes} disabled={readOnly} onChange={(event) => setRules({ budget: { ...draft.rules.budget, maxMinutes: clamp(event.target.value, 1, 1_440) } })} />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Check after each step (optional)</span>
          <input
            className="input mono"
            value={draft.rules.check ?? ""}
            maxLength={4_000}
            spellCheck={false}
            placeholder="bun test"
            disabled={readOnly}
            onChange={(event) => {
              const check = event.target.value
              setDraft((current) => {
                const { check: _old, ...rest } = current.rules
                return { ...current, rules: check.trim().length === 0 ? rest : { ...rest, check } }
              })
            }}
          />
        </label>
      </section>
      {error !== undefined && (
        <p className="form-warning" role="alert">
          <CircleAlert size={13} /> {error}
        </p>
      )}
      {!readOnly && (
        <div className="agents-row agents-editor-foot">
          {existing !== undefined && (
            <Button
              variant="ghost"
              icon={<Trash2 size={13} />}
              onClick={() =>
                confirmAction({
                  title: `Delete ${existing.name}?`,
                  body: "The setup is removed from ~/.runrail/setups.json. Its past runs' threads stay.",
                  confirm: "Delete",
                  danger: true,
                  onConfirm: () => void deleteSetup(projectId, existing.id).then(() => onDeleted?.()),
                })
              }
            >
              Delete
            </Button>
          )}
          <span className="agents-spacer" />
          {unbound.length > 0 && (
            <span className="agents-launch-where is-warn">
              <CircleAlert size={13} aria-hidden /> {pickModelHint(unbound)}
            </span>
          )}
          <Button variant={existing === undefined ? "primary" : "secondary"} loading={busy} disabled={draft.name.trim().length === 0 || unbound.length > 0} onClick={() => void save()}>
            {existing === undefined ? "Save setup" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  )
}

function clamp(value: string, min: number, max: number): number {
  const number = Math.round(Number(value))
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min
}

function toRole(selection: Selection): SetupRole {
  return { route: selection.backend, ...(selection.model === undefined ? {} : { model: selection.model }), ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }) }
}

function RoleField({ role, value, catalog, developer, disabled, onChange }: { readonly role: SetupRoleName; readonly value: SetupRole | undefined; readonly catalog: ReturnType<typeof useCatalog>; readonly developer: boolean; readonly disabled: boolean; readonly onChange: (value: SetupRole | undefined) => void }) {
  const optional = role !== "executor"
  const selection = value === undefined ? undefined : roleSelection(value)
  const reasoning = selection === undefined ? undefined : reasoningView({ ...selection, thinking: value?.effort ?? "medium" }, catalog.models, catalog.harnesses)
  return (
    <fieldset className={cx("agents-role", value === undefined && "is-off")} disabled={disabled}>
      <legend className="sr-only">{ROLE_NAMES[role]}</legend>
      <div className="agents-role-head">
        <RoleMark role={role} />
        <span className="agents-role-text">
          <span className="agents-role-name">{ROLE_NAMES[role]}</span>
          <span className="agents-role-work">{optional && value === undefined ? "Off" : ROLE_WORK[role]}</span>
        </span>
        {optional && <Toggle label={`Use a ${ROLE_NAMES[role].toLowerCase()}`} checked={value !== undefined} disabled={disabled} onChange={(on) => onChange(on ? (value ?? { route: "native" }) : undefined)} />}
      </div>
      {value !== undefined && selection !== undefined && (
        <div className="field-row">
          <RunsOnSelect className="grow" catalog={catalog} value={selection} label={`${ROLE_NAMES[role]} runs on`} unbound={{ label: developer ? "Test model" : "Pick a model", disabled: !developer }} onChange={(next) => onChange({ ...toRole(next), ...(value.effort === undefined ? {} : { effort: value.effort }), ...(value.access === undefined ? {} : { access: value.access }) })} />
          {reasoning?.shown === true && (
            <select className="select" aria-label={`${ROLE_NAMES[role]} effort`} value={value.effort ?? "medium"} disabled={!reasoning.enabled} onChange={(event) => onChange({ ...value, effort: event.target.value as Thinking })}>
              {reasoning.levels.map((level) => (
                <option key={level} value={level}>
                  {THINKING_NAME[level]}
                </option>
              ))}
            </select>
          )}
          {role === "executor" && (
            <select className="select" aria-label="Executor access" value={value.access ?? "ask"} onChange={(event) => {
                const access = event.target.value as PermissionPreset
                if (access !== "full") onChange({ ...value, access })
                else confirmAction({ title: "Let the executor run everything without asking?", body: "With full access the executor's commands and edits run with no approval. Use it only for projects you can throw away.", confirm: "Use full access", danger: true, onConfirm: () => onChange({ ...value, access }) })
              }}>
              {ACCESS_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {PERMISSION_LABELS[level]}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </fieldset>
  )
}

// ---------------------------------------------------------------------------------------------
// A run

function RunDetail({ runId, projectId, now }: { readonly runId: string; readonly projectId: string; readonly now: number }) {
  const known = useSetups((state) => state.runs[runId])
  const setups = useSetups((state) => state.byProject[projectId]?.setups)
  const threads = useApp((state) => state.threads)
  const developer = useApp((state) => state.prefs.developer)
  const statuses = useStatuses()
  const catalog = useCatalog(projectId)
  useEffect(() => {
    if (known === undefined) void loadRuns(projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])
  if (known === undefined)
    return (
      <div className="agents-empty">
        <EmptyState icon={<Bot size={20} />} title="This run is not in the engine">
          Runs live in the project's engine and end with it.
        </EmptyState>
      </div>
    )
  const run = known.run
  const setup = setups?.find((item) => item.id === run.setupId)
  const threadOf = (role: SetupRoleName) => threads.find((item) => item.setup?.runId === run.runId && item.setup.role === role)
  const openRole = (role: SetupRoleName): void => {
    const thread = threadOf(role)
    if (thread === undefined) return
    set({ view: { kind: "thread" } })
    openThread(thread.id)
  }
  const roles = SETUP_ROLES.filter((role) => (setup === undefined ? run.steps.some((step) => step.role === role) : setup.roles[role] !== undefined))
  const elapsed = (run.endedAt ?? now) - run.startedAt
  const finished = run.steps.filter((step) => step.status === "done").length
  return (
    <div className="agents-body">
      <header className="agents-run-head">
        <div className="agents-run-top">
          <span className={cx("agents-state", `is-${runTone(run)}`)}>
            <RunIcon run={run} />
            {stateLabel(run)}
          </span>
          <span className="agents-run-stats">
            {run.setupName} · {run.checkout === true ? "main checkout" : "own worktree"} · {run.turns} turn{run.turns === 1 ? "" : "s"} · {duration(elapsed)}
          </span>
          <span className="agents-spacer" />
          {active(run) && (
            <Button size="sm" variant="secondary" icon={<CircleStop size={13} />} onClick={() => void stopSetupRun(run.runId)}>
              Stop run
            </Button>
          )}
        </div>
        <h1 className="agents-run-task" title={run.task}>
          {run.task}
        </h1>
      </header>
      {run.error !== undefined && (
        <p className="form-warning" role="alert">
          <CircleAlert size={13} /> {run.error.message}
        </p>
      )}
      {roles.length > 0 && (
        <div className="agents-run-roles" aria-label="Roles">
          {roles.map((role) => {
            const thread = threadOf(role)
            const status = thread === undefined ? undefined : statuses[thread.id]
            const runsOn = setup?.roles[role]
            return (
              <button key={role} type="button" className={cx("agents-run-role", `is-${role}`)} disabled={thread === undefined} title={thread === undefined ? `The ${ROLE_NAMES[role].toLowerCase()} has not started` : `Open the ${ROLE_NAMES[role].toLowerCase()}'s thread`} onClick={() => openRole(role)}>
                <RoleMark role={role} />
                <span className="agents-role-text">
                  <span className="agents-role-name">{ROLE_NAMES[role]}</span>
                  <span className="agents-role-work">{runsOn === undefined ? ROLE_WORK[role] : selectionLabel(roleSelection(runsOn), developer, catalog.models, catalog.harnesses)}</span>
                </span>
                <span className="agents-run-role-state">
                  {status === undefined ? (
                    "Not started"
                  ) : (
                    <>
                      <StatusIcon status={status} size={12} />
                      {statusLabel(status)}
                    </>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {run.waiting?.kind === "approve" && <Approval key={run.waiting.stepId} runId={run.runId} stepId={run.waiting.stepId} plan={run.waiting.plan} />}
      {run.plan !== undefined && run.waiting?.kind !== "approve" && (
        <section className="agents-card" aria-label="Plan">
          <div className="agents-card-head">
            <h2>Plan</h2>
            <span>
              {run.plan.steps.length} step{run.plan.steps.length === 1 ? "" : "s"}
            </span>
          </div>
          {run.plan.summary !== undefined && <p className="agents-plan-summary">{run.plan.summary}</p>}
          <ol className="agents-numbered">
            {run.plan.steps.map((step, index) => (
              <li key={`${String(index)}-${step.title}`}>
                <span className="agents-num">{index + 1}</span>
                <span className="agents-numbered-text">{step.title}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="agents-card" aria-label="Steps">
        <div className="agents-card-head">
          <h2>Steps</h2>
          <span>
            {finished} of {run.steps.length} done
          </span>
        </div>
        <ol className="agents-timeline">
          {run.steps.map((step) => (
            <li key={step.id} className={cx("agents-step", `is-${step.status}`)}>
              <span className="agents-step-icon">
                <StepIcon status={step.status} />
              </span>
              <span className="agents-step-title">{step.title}</span>
              {step.note !== undefined && <span className={cx("agents-step-note", step.status === "failed" && "is-bad")}>{step.note}</span>}
              <span className="agents-spacer" />
              {step.role !== undefined && (
                <button type="button" className={cx("agents-role-chip", `is-${step.role}`)} title={`Open the ${ROLE_NAMES[step.role].toLowerCase()}'s thread`} onClick={() => step.role !== undefined && openRole(step.role)}>
                  {ROLE_ICONS[step.role]}
                  {ROLE_NAMES[step.role]}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function runTone(run: SetupRun): "working" | "waiting" | "done" | "failed" | "stopped" {
  if (run.state === "waiting" && run.waiting?.kind === "approve") return "waiting"
  if (active(run)) return "working"
  return run.state === "succeeded" ? "done" : run.state === "stopped" ? "stopped" : "failed"
}

function stateLabel(run: SetupRun): string {
  if (run.state === "waiting") return run.waiting?.kind === "approve" ? "Waiting for you" : "Working"
  return run.state === "running" ? "Working" : run.state === "succeeded" ? "Done" : run.state === "stopped" ? "Stopped" : "Failed"
}

function StepIcon({ status }: { readonly status: SetupRun["steps"][number]["status"] }): ReactNode {
  if (status === "running") return <LoaderCircle size={13} className="spin" aria-label="Running" />
  if (status === "done") return <Check size={13} aria-label="Done" />
  if (status === "failed") return <X size={13} aria-label="Failed" />
  return <CircleDashed size={13} aria-label="Skipped" />
}

/** The plan as the planner wrote it, editable: rename, reorder, remove, or send back with a note. */
function Approval({ runId, stepId, plan }: { readonly runId: string; readonly stepId: string; readonly plan: SetupPlanInfo }) {
  const [steps, setSteps] = useState(plan.steps)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<"approve" | "back">()
  const move = (index: number, by: number): void =>
    setSteps((current) => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      if (item !== undefined) next.splice(index + by, 0, item)
      return next
    })
  const answer = async (approved: boolean): Promise<void> => {
    setBusy(approved ? "approve" : "back")
    try {
      await answerApproval(runId, stepId, approved ? { approved: true, plan: { ...(plan.summary === undefined ? {} : { summary: plan.summary }), steps: steps.filter((step) => step.title.trim().length > 0) } } : { approved: false, ...(note.trim().length === 0 ? {} : { feedback: note.trim() }) })
    } catch (cause) {
      toast("error", toHostError(cause).message)
      setBusy(undefined)
    }
  }
  return (
    <section className="agents-card agents-approval" aria-label="Approve the plan">
      <div className="agents-card-head">
        <h2>
          <CircleAlert size={14} aria-hidden /> The plan is ready for you
        </h2>
        <span>Edit, reorder, or remove steps before you approve</span>
      </div>
      {plan.summary !== undefined && <p className="agents-plan-summary">{plan.summary}</p>}
      <ol className="agents-approval-steps">
        {steps.map((step, index) => (
          <li key={`${String(index)}`}>
            <span className="agents-num">{index + 1}</span>
            <div className="agents-approval-text">
              <input className="input" aria-label={`Step ${String(index + 1)}`} value={step.title} maxLength={200} onChange={(event) => setSteps((current) => current.map((item, at) => (at === index ? { ...item, title: event.target.value } : item)))} />
              {step.detail !== undefined && <p className="muted">{step.detail}</p>}
            </div>
            <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp size={13} />
            </IconButton>
            <IconButton label="Move down" size="sm" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown size={13} />
            </IconButton>
            <IconButton label="Remove step" size="sm" disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, at) => at !== index))}>
              <X size={13} />
            </IconButton>
          </li>
        ))}
      </ol>
      <label className="field">
        <span className="field-label">Note for the planner (to send it back)</span>
        <textarea className="textarea" rows={2} value={note} placeholder="What to change in the plan" onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="agents-row">
        <Button variant="ghost" loading={busy === "back"} disabled={busy !== undefined} onClick={() => void answer(false)}>
          {note.trim().length === 0 ? "Decline" : "Send back"}
        </Button>
        <span className="agents-spacer" />
        <Button variant="primary" icon={<Check size={13} />} loading={busy === "approve"} disabled={busy !== undefined || steps.every((step) => step.title.trim().length === 0)} onClick={() => void answer(true)}>
          Approve
        </Button>
      </div>
    </section>
  )
}
