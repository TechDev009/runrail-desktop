import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleStop,
  CircleX,
  CornerDownRight,
  GitPullRequest,
  Link,
  LoaderCircle,
  MessagesSquare,
  Play,
  Plus,
  Repeat,
  Send,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { confirmAction } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import { readCheckCommand } from "../../app/checks"
import { hookUrl, makeHook, removeHook, usePhone } from "../../app/phone"
import { BACKEND_LABELS, PERMISSION_LABELS, type PermissionPreset } from "../../app/persist"
import type { Selection } from "../../app/picker"
import { loadSetups, roleSelection, useSetups } from "../../app/setups"
import { useWords } from "../../app/platformWords"
import { activeProject, openThread, projectById, set, startSelection, toast, useApp } from "../../app/store"
import {
  active,
  answerWorkflow,
  approveWorkflow,
  deleteWorkflow,
  describeSchedule,
  describeTrigger,
  draftOf,
  enableWorkflow,
  loadWorkflows,
  runWorkflow,
  saveWorkflow,
  stopWorkflowRun,
  withValidRetries,
  useWorkflows,
  type WorkflowDraft,
} from "../../app/workflowRuns"
import { toHostError } from "../../host"
import { duration, timeAgo } from "../../lib/format"
import type { SetupInfo, SetupRole, WorkflowInfo, WorkflowRun, WorkflowRunRecord, WorkflowSchedule, WorkflowStep, WorkflowTrigger } from "../../protocol/schemas"
import { Button, CopyButton, cx, EmptyState, IconButton, Menu, Segmented, Spinner, Tabs, Toggle, useTicker } from "../common"
import { RunsOnSelect } from "../RunsOnSelect"
import { ProjectPicker } from "./ProjectPicker"

/**
 * Workflows: a trigger and a vertical list of steps with side branches. The engine
 * runs them; this screen lists them, edits them, approves what agents propose, runs one by hand,
 * and answers a run's approvals.
 */

const NEW = "new"

export function WorkflowsView({ projectId: wantedProject, workflowId, runId }: { readonly projectId?: string | undefined; readonly workflowId?: string | undefined; readonly runId?: string | undefined }) {
  const projects = useApp((state) => state.projects)
  const words = useWords()
  const [projectId, setProjectId] = useState(() => wantedProject ?? activeProject()?.id ?? projects[0]?.id)
  const [selected, setSelected] = useState<string | undefined>(workflowId)
  const listing = useWorkflows((state) => (projectId === undefined ? undefined : state.byProject[projectId]))
  const liveRuns = useWorkflows((state) => state.runs)
  const now = useTicker(
    Object.values(liveRuns).some((entry) => active(entry.run)),
    1_000,
  )

  useEffect(() => {
    if (wantedProject !== undefined) setProjectId(wantedProject)
    if (workflowId !== undefined) setSelected(workflowId)
  }, [wantedProject, workflowId])
  useEffect(() => {
    if (projectId === undefined) return
    void loadWorkflows(projectId)
    void loadSetups(projectId)
  }, [projectId])

  if (projectId === undefined)
    return (
      <main className="agents" aria-label="Workflows">
        <div className="agents-empty">
          <EmptyState icon={<Workflow size={20} />} title="Add a project first">
            A workflow runs in a project. Add one from the threads list.
          </EmptyState>
        </div>
      </main>
    )

  const workflows = listing?.workflows ?? []
  const proposed = workflows.filter((item) => item.state === "proposed")
  const yours = workflows.filter((item) => item.state !== "proposed")
  const current = workflows.find((item) => item.id === selected)

  return (
    <main className="agents workflows" aria-label="Workflows">
      <nav className="agents-list" aria-label="Workflows">
        <div className="agents-list-top" data-tauri-drag-region>
          <span className="agents-title">Workflows</span>
          <IconButton label="New workflow" size="sm" onClick={() => setSelected(NEW)}>
            <Plus size={14} />
          </IconButton>
        </div>
        <ProjectPicker
          projects={projects}
          value={projectId}
          onChange={(id) => {
            setProjectId(id)
            setSelected(undefined)
          }}
        />
        {listing?.state === "error" && <p className="agents-note is-error">{listing.message}</p>}
        {listing?.state === "loading" && workflows.length === 0 && (
          <p className="agents-note" role="status">
            <Spinner size={12} /> Reading workflows…
          </p>
        )}
        {proposed.length > 0 && (
          <>
            <div className="agents-section">
              <span>
                Proposed by agents <span className="workflows-count">{proposed.length}</span>
              </span>
            </div>
            {proposed.map((item) => (
              <WorkflowItem key={item.id} workflow={item} active={item.id === selected} now={now} onSelect={() => setSelected(item.id)} />
            ))}
          </>
        )}
        <div className="agents-section">
          <span>
            Yours <span className="workflows-count">{yours.length}</span>
          </span>
        </div>
        {listing?.state === "ready" && yours.length === 0 && <p className="agents-note">No workflows yet. A workflow runs steps on a schedule, when a pull request arrives, or when you start it.</p>}
        {yours.map((item) => (
          <WorkflowItem key={item.id} workflow={item} active={item.id === selected} now={now} onSelect={() => setSelected(item.id)} />
        ))}
      </nav>
      <section className="agents-detail">
        <div className="agents-detail-top" data-tauri-drag-region />
        {selected === NEW ? (
          <WorkflowDetail key={`${projectId}:new`} projectId={projectId} now={now} onSaved={setSelected} onDeleted={() => setSelected(undefined)} />
        ) : current !== undefined ? (
          <WorkflowDetail key={`${projectId}:${current.id}`} projectId={projectId} workflow={current} runId={runId} now={now} onSaved={setSelected} onDeleted={() => setSelected(undefined)} />
        ) : (
          <div className="agents-empty">
            <EmptyState
              icon={<Workflow size={20} />}
              title="Steps that run themselves"
              actions={
                <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setSelected(NEW)}>
                  New workflow
                </Button>
              }
            >
              A trigger, then steps: an agent or a setup does the work, a check proves it, a decision or an approval decides what comes next, and an action opens a pull request or tells you. Runs on this {words.computer}
              while Runrail is open.
            </EmptyState>
          </div>
        )}
      </section>
    </main>
  )
}

function WorkflowItem({ workflow, active: isActive, now, onSelect }: { readonly workflow: WorkflowInfo; readonly active: boolean; readonly now: number; readonly onSelect: () => void }) {
  const chip = chipOf(workflow)
  return (
    <button type="button" className={cx("agents-item", isActive && "is-active")} onClick={onSelect}>
      <span className="agents-item-title">
        {workflow.state === "proposed" && <Sparkles size={12} className="tone-amber" aria-hidden />}
        <span className="workflows-item-name">{workflow.name}</span>
        {chip !== undefined && <span className={cx("workflows-chip", `is-${chip.toLowerCase()}`)}>{chip}</span>}
      </span>
      <span className="agents-item-meta">
        {workflow.state === "proposed" ? `From the thread "${workflow.proposedBy?.thread ?? "a thread"}" · not on` : `${describeTrigger(workflow.trigger)} · ${lastLine(workflow.runs[0], now)}`}
      </span>
    </button>
  )
}

function chipOf(workflow: WorkflowInfo): "On" | "Off" | "Manual" | undefined {
  if (workflow.state === "proposed") return undefined
  if (workflow.trigger.kind === "manual") return "Manual"
  return workflow.state === "on" ? "On" : "Off"
}

export function lastLine(run: WorkflowRunRecord | undefined, now: number): string {
  if (run === undefined) return "not run yet"
  if (run.state === "running" || run.state === "waiting") return "running now"
  if (run.state === "succeeded") return `last ran ${timeAgo(run.endedAt ?? run.startedAt, now)}`
  if (run.state === "stopped") return "last run stopped"
  return run.error === "WORKFLOW_CHECK_FAILED" ? "last run failed its check" : run.error === "WORKFLOW_INTERRUPTED" ? "last run ended with the app" : "last run failed"
}

// ---------------------------------------------------------------------------------------------
// One workflow: steps and runs

function blankDraft(runsOn: SetupRole, git: boolean): WorkflowDraft {
  return {
    id: `wf-${Date.now().toString(36)}`,
    name: "New workflow",
    state: "off",
    trigger: { kind: "manual" },
    where: git ? "worktree" : "checkout",
    steps: [{ id: "work", kind: "agent", title: "Do the work", prompt: "", runsOn: { ...runsOn, access: "auto-edit" } }],
    budget: { maxMinutes: 120 },
  }
}

function toRole(selection: Selection): SetupRole {
  return { route: selection.backend as SetupRole["route"], ...(selection.model === undefined ? {} : { model: selection.model }), ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }) }
}

function WorkflowDetail({
  projectId,
  workflow,
  runId,
  now,
  onSaved,
  onDeleted,
}: {
  readonly projectId: string
  readonly workflow?: WorkflowInfo
  readonly runId?: string | undefined
  readonly now: number
  readonly onSaved: (id: string) => void
  readonly onDeleted: () => void
}) {
  const prefs = useApp((state) => state.prefs)
  const words = useWords()
  const project = projectById(projectId)
  const [tab, setTab] = useState<"steps" | "runs">(runId === undefined ? "steps" : "runs")
  const [draft, setDraft] = useState<WorkflowDraft>(() => (workflow === undefined ? blankDraft(toRole(startSelection(prefs)), project?.git === true) : draftOf(workflow)))
  const [focus, setFocus] = useState<string>("trigger")
  const [busy, setBusy] = useState<"save" | "run" | "approve">()
  const [error, setError] = useState<string>()
  const saved = workflow === undefined ? undefined : draftOf(workflow)
  const dirty = saved === undefined || JSON.stringify(saved) !== JSON.stringify(draft)
  const proposedWorkflow = workflow?.state === "proposed"
  const setups = useSetups((state) => state.byProject[projectId]?.setups ?? [])
  const unrecorded = useWorkflows(
    (state) => Object.values(state.runs).filter((entry) => entry.projectId === projectId && entry.run.workflowId === workflow?.id && workflow.runs.every((record) => record.runId !== entry.run.runId)).length,
  )

  useEffect(() => {
    if (runId !== undefined) setTab("runs")
  }, [runId])

  const act = async (kind: "save" | "run" | "approve", work: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(undefined)
    try {
      await work()
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setBusy(undefined)
    }
  }
  const save = (): Promise<void> =>
    act("save", async () => {
      const stored = await saveWorkflow(projectId, { ...draft, name: draft.name.trim() })
      setDraft(draftOf(stored))
      toast("success", `Saved ${stored.name}`)
      onSaved(stored.id)
    })
  const runOnce = (): Promise<void> =>
    act("run", async () => {
      if (workflow === undefined) return
      await runWorkflow(projectId, workflow.id)
      setTab("runs")
    })

  return (
    <div className="agents-body workflows-body">
      {proposedWorkflow && workflow !== undefined && (
        <section className="workflows-proposal" aria-label="Proposed workflow">
          <Sparkles size={14} className="tone-amber" aria-hidden />
          <p>
            An agent proposed this in the thread <strong>{workflow.proposedBy?.thread ?? "a thread"}</strong>. Nothing runs until you turn it on.
          </p>
          <span className="agents-spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              confirmAction({
                title: `Discard ${workflow.name}?`,
                body: "The proposal is removed. The thread it came from stays.",
                confirm: "Discard",
                danger: true,
                onConfirm: () => void deleteWorkflow(projectId, workflow.id).then(onDeleted),
              })
            }
          >
            Discard
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Check size={13} />}
            loading={busy === "approve"}
            onClick={() => {
              const review = proposalReview(draft, setups)
              confirmAction({
                title: `Turn on ${draft.name}?`,
                body: review.body,
                confirm: "Approve and turn on",
                danger: review.danger,
                onConfirm: () =>
                  void act("approve", async () => {
                    if (dirty) await saveWorkflow(projectId, draft)
                    setDraft(draftOf(await approveWorkflow(projectId, workflow.id)))
                    toast("success", `${workflow.name} is on`)
                  }),
              })
            }}
          >
            Approve and turn on
          </Button>
        </section>
      )}
      <header className="agents-run-head workflows-head">
        <div className="agents-run-title">
          <input className="workflows-name" aria-label="Workflow name" value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <span className="muted">{project?.name}</span>
        </div>
        <div className="agents-row">
          <Tabs
            label="Workflow"
            value={tab}
            onChange={setTab}
            options={[
              { value: "steps", label: "Steps" },
              { value: "runs", label: "Runs", ...(workflow === undefined ? {} : { count: workflow.runs.length + unrecorded }) },
            ]}
          />
          <span className="agents-spacer" />
          {workflow !== undefined && !proposedWorkflow && draft.trigger.kind !== "manual" && (
            <span className="toggle-row workflows-on">
              <Toggle
                label="On"
                checked={workflow.state === "on"}
                onChange={(on) =>
                  void enableWorkflow(projectId, workflow.id, on)
                    .then((stored) => setDraft((current) => ({ ...current, state: stored.state })))
                    .catch((cause: unknown) => toast("error", toHostError(cause).message))
                }
              />
              <span>{workflow.state === "on" ? "On" : "Off"}</span>
            </span>
          )}
          <Button
            size="sm"
            icon={<Play size={13} />}
            loading={busy === "run"}
            disabled={workflow === undefined || proposedWorkflow || dirty}
            title={dirty && workflow !== undefined ? "Save your changes first" : undefined}
            onClick={() => void runOnce()}
          >
            Run once now
          </Button>
        </div>
      </header>
      {error !== undefined && (
        <p className="form-warning" role="alert">
          <CircleAlert size={13} /> {error}
        </p>
      )}
      {tab === "steps" ? (
        <>
          <div className="workflows-board">
            <Flow draft={draft} projectId={projectId} focus={focus} onFocus={setFocus} />
            <Inspector projectId={projectId} draft={draft} focus={focus} onChange={setDraft} onFocus={setFocus} />
          </div>
          <p className="form-hint">Runs on this {words.computer} while Runrail is open. A run missed while it was closed starts once when it opens.</p>
          <div className="agents-row">
            {workflow !== undefined && !proposedWorkflow && (
              <Button
                variant="ghost"
                icon={<Trash2 size={13} />}
                onClick={() =>
                  confirmAction({
                    title: `Delete ${workflow.name}?`,
                    body: "The workflow and its run history are removed. Threads its runs opened stay.",
                    confirm: "Delete",
                    danger: true,
                    onConfirm: () => void deleteWorkflow(projectId, workflow.id).then(onDeleted),
                  })
                }
              >
                Delete
              </Button>
            )}
            <span className="agents-spacer" />
            {workflow !== undefined && dirty && (
              <Button variant="ghost" onClick={() => setDraft(draftOf(workflow))}>
                Revert
              </Button>
            )}
            <Button variant={workflow === undefined ? "primary" : "secondary"} loading={busy === "save"} disabled={!dirty || draft.name.trim().length === 0} onClick={() => void save()}>
              {workflow === undefined ? "Save workflow" : "Save changes"}
            </Button>
          </div>
        </>
      ) : workflow === undefined ? (
        <p className="agents-note">Save the workflow to run it.</p>
      ) : (
        <Runs projectId={projectId} workflow={workflow} runId={runId} now={now} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The board: a vertical list of steps; a decision's stop and a check's way back sit to the side

function kindLabel(step: WorkflowStep, setups: readonly SetupInfo[]): string {
  switch (step.kind) {
    case "agent":
      return "Step · Solo"
    case "setup":
      return `Step · ${setups.find((setup) => setup.id === step.setupId)?.name ?? "Setup"}`
    case "check":
      return "Check"
    case "decision":
      return "Decision"
    case "approval":
      return "Approval"
    case "action":
      return step.action === "open-pr" ? "Action · GitHub" : step.action === "slack" ? "Action · Slack" : "Action · Notify"
  }
}

function firstLine(text: string, max = 90): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function runsOnLine(role: SetupRole): string {
  return `${BACKEND_LABELS[role.route]}${role.model === undefined ? "" : ` · ${role.model}`}`
}

/**
 * What turning on a proposed workflow lets it do, in full: when it runs, every command a check
 * runs, and the access each agent works with. Auto or full access, a command, or a push starts
 * the dialog on Cancel.
 */
export function proposalReview(draft: Pick<WorkflowDraft, "trigger" | "where" | "steps">, setups: readonly SetupInfo[]): { readonly body: string; readonly danger: boolean } {
  const lines = [`Runs: ${describeTrigger(draft.trigger)}, ${draft.where === "worktree" ? "in a new worktree each run" : "in the project's checkout"}`]
  let danger = false
  const access = (title: string, role: SetupRole | undefined): void => {
    const level = role?.access ?? "ask"
    if (level === "auto" || level === "full") danger = true
    lines.push(role === undefined ? `${title}: a setup that is not here` : `${title}: ${runsOnLine(role)}, ${PERMISSION_LABELS[level]}`)
  }
  for (const step of draft.steps) {
    switch (step.kind) {
      case "agent":
        access(step.title, step.runsOn)
        break
      case "setup":
        access(step.title, setups.find((item) => item.id === step.setupId)?.roles.executor)
        break
      case "check":
        danger = true
        lines.push(`${step.title} runs this command:\n${step.command}`)
        break
      case "action":
        if (step.action === "open-pr") {
          danger = true
          lines.push(`${step.title}: commits, pushes the run's branch, and opens a pull request`)
        } else if (step.action === "slack") lines.push(`${step.title}: posts to ${step.channel}`)
        break
      case "decision":
      case "approval":
        break
    }
  }
  return { body: lines.join("\n\n"), danger }
}

function stepLine(step: WorkflowStep, setups: readonly SetupInfo[]): string {
  switch (step.kind) {
    case "agent":
      return `${runsOnLine(step.runsOn)} · ${PERMISSION_LABELS[step.runsOn.access ?? "ask"]}${step.prompt.trim().length === 0 ? "" : ` · ${firstLine(step.prompt, 60)}`}`
    case "setup": {
      const setup = setups.find((item) => item.id === step.setupId)
      return setup === undefined
        ? "Pick a setup"
        : `${[setup.roles.planner, setup.roles.executor, setup.roles.reviewer].flatMap((role) => (role === undefined ? [] : [BACKEND_LABELS[role.route]])).join(" → ")} · own ${firstLine(step.task, 50) || "task"}`
    }
    case "check":
      return `${step.command}${step.repeat > 1 ? `, ${String(step.repeat)} times; every run must pass` : ""}`
    case "decision":
      return step.question
    case "approval":
      return step.detail ?? "Shows in your waiting list, like any approval"
    case "action":
      return step.action === "open-pr"
        ? step.draft
          ? "Commits, pushes the run's branch, opens a draft"
          : "Commits, pushes the run's branch, opens it"
        : step.action === "slack"
          ? `${step.channel}: ${firstLine(step.text, 60)}`
          : step.text
  }
}

function Flow({ draft, projectId, focus, onFocus }: { readonly draft: WorkflowDraft; readonly projectId: string; readonly focus: string; readonly onFocus: (id: string) => void }) {
  const setups = useSetups((state) => state.byProject[projectId]?.setups ?? [])
  return (
    <ol className="workflows-flow" aria-label="Steps">
      <li>
        <button type="button" className={cx("workflows-card", "is-trigger", focus === "trigger" && "is-focus")} onClick={() => onFocus("trigger")}>
          <span className="workflows-kind">Trigger</span>
          <span className="workflows-card-title">{describeTrigger(draft.trigger)}</span>
          <span className="workflows-card-line">{draft.where === "worktree" ? "In a new worktree each run" : "In the project's checkout"}</span>
        </button>
      </li>
      {draft.steps.map((step) => {
        const retryTo = step.kind === "check" && step.retry !== undefined ? draft.steps.find((item) => item.id === step.retry?.step) : undefined
        return (
          <li key={step.id}>
            <span className="workflows-joint" aria-hidden />
            <div className="workflows-row">
              <button type="button" className={cx("workflows-card", `is-${step.kind}`, focus === step.id && "is-focus")} onClick={() => onFocus(step.id)}>
                <span className="workflows-kind">{kindLabel(step, setups)}</span>
                <span className="workflows-card-title">{step.title}</span>
                <span className="workflows-card-line">{stepLine(step, setups)}</span>
              </button>
              {step.kind === "decision" && (
                <span className="workflows-side">
                  <CornerDownRight size={12} aria-hidden /> {step.stopWhen} → Stop · nothing to do
                </span>
              )}
              {step.kind === "check" && retryTo !== undefined && step.retry !== undefined && (
                <span className="workflows-side">
                  <Repeat size={12} aria-hidden /> fails: back to "{retryTo.title}", {step.retry.times} time{step.retry.times === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {step.kind === "decision" && <span className="workflows-branch">{step.stopWhen === "no" ? "yes" : "no"}</span>}
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------------------------
// The inspector: the focused trigger or step's fields

const STEP_KINDS: readonly { readonly kind: string; readonly label: string }[] = [
  { kind: "agent", label: "Step · Solo agent" },
  { kind: "setup", label: "Step · A setup" },
  { kind: "check", label: "Check" },
  { kind: "decision", label: "Decision" },
  { kind: "approval", label: "Approval" },
  { kind: "open-pr", label: "Action · Open a pull request" },
  { kind: "notify", label: "Action · Tell me" },
  { kind: "slack", label: "Action · Slack message" },
]

function freeId(steps: readonly WorkflowStep[], base: string): string {
  const taken = new Set(steps.map((step) => step.id))
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`
  return id
}

function newStep(kind: string, draft: WorkflowDraft, runsOn: SetupRole, check: string | undefined, setups: readonly SetupInfo[]): WorkflowStep {
  const id = freeId(draft.steps, kind)
  const before = [...draft.steps].reverse().find((step) => step.kind === "agent" || step.kind === "setup")
  switch (kind) {
    case "setup":
      return { id, kind: "setup", title: "Plan, execute, review", setupId: setups[0]?.id ?? "", task: "" }
    case "check":
      return { id, kind: "check", title: "Run the tests", command: check ?? "bun test", repeat: 1, timeoutMinutes: 15, ...(before === undefined ? {} : { retry: { step: before.id, times: 2 } }) }
    case "decision":
      return { id, kind: "decision", title: "Anything to do?", question: "Did you find anything to do?", stopWhen: "no" }
    case "approval":
      return { id, kind: "approval", title: "You approve the diff" }
    case "open-pr":
      return { id, kind: "action", title: "Open a draft pull request", action: "open-pr", draft: true }
    case "notify":
      return { id, kind: "action", title: "Tell me", action: "notify", text: "Done" }
    case "slack":
      return { id, kind: "action", title: "Post to Slack", action: "slack", channel: "#general", text: "" }
    default:
      return { id, kind: "agent", title: "Do the work", prompt: "", runsOn: { ...runsOn, access: "auto-edit" } }
  }
}

function Inspector({
  projectId,
  draft,
  focus,
  onChange,
  onFocus,
}: {
  readonly projectId: string
  readonly draft: WorkflowDraft
  readonly focus: string
  readonly onChange: (draft: WorkflowDraft) => void
  readonly onFocus: (id: string) => void
}) {
  const prefs = useApp((state) => state.prefs)
  const setups = useSetups((state) => state.byProject[projectId]?.setups ?? [])
  const [check, setCheck] = useState<string>()
  useEffect(() => {
    void readCheckCommand(projectId).then(setCheck)
  }, [projectId])
  const index = draft.steps.findIndex((step) => step.id === focus)
  const step = draft.steps[index]
  const patch = (next: WorkflowStep): void => onChange({ ...draft, steps: draft.steps.map((item, at) => (at === index ? next : item)) })
  const move = (by: number): void => {
    const steps = [...draft.steps]
    const [item] = steps.splice(index, 1)
    if (item === undefined) return
    steps.splice(index + by, 0, item)
    onChange({ ...draft, steps: withValidRetries(steps) })
  }
  const add = (kind: string): void => {
    const item = newStep(kind, draft, toRole(startSelection(prefs)), check, setups)
    const at = index < 0 ? draft.steps.length : index + 1
    onChange({ ...draft, steps: [...draft.steps.slice(0, at), item, ...draft.steps.slice(at)] })
    onFocus(item.id)
  }

  return (
    <aside className="workflows-inspector" aria-label="Step settings">
      {step === undefined ? (
        <TriggerFields draft={draft} projectId={projectId} onChange={onChange} />
      ) : (
        <>
          <div className="agents-row">
            <span className="workflows-kind">{kindLabel(step, setups)}</span>
            <span className="agents-spacer" />
            <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => move(-1)}>
              <ArrowUp size={13} />
            </IconButton>
            <IconButton label="Move down" size="sm" disabled={index === draft.steps.length - 1} onClick={() => move(1)}>
              <ArrowDown size={13} />
            </IconButton>
            <IconButton
              label="Remove step"
              size="sm"
              disabled={draft.steps.length === 1}
              onClick={() => {
                onChange({ ...draft, steps: withValidRetries(draft.steps.filter((_, at) => at !== index)) })
                onFocus(draft.steps[index - 1]?.id ?? "trigger")
              }}
            >
              <X size={13} />
            </IconButton>
          </div>
          <label className="field">
            <span className="field-label">Title</span>
            <input className="input" value={step.title} maxLength={80} onChange={(event) => patch({ ...step, title: event.target.value })} />
          </label>
          <StepFields projectId={projectId} draft={draft} step={step} setups={setups} onChange={patch} />
        </>
      )}
      <Menu
        trigger={({ toggle, ref }) => (
          <Button ref={ref} size="sm" variant="ghost" icon={<Plus size={13} />} onClick={toggle}>
            Add a step {step === undefined ? "at the end" : "after this"}
          </Button>
        )}
        items={STEP_KINDS.map((item) => ({ id: item.kind, label: item.label, onSelect: () => add(item.kind) }))}
      />
    </aside>
  )
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const INTERVALS = [15, 30, 60, 120, 240, 480, 720, 1_440]

function TriggerFields({ draft, projectId, onChange }: { readonly draft: WorkflowDraft; readonly projectId: string; readonly onChange: (draft: WorkflowDraft) => void }) {
  const git = projectById(projectId)?.git === true
  const trigger = draft.trigger
  const setTrigger = (next: WorkflowTrigger): void => onChange({ ...draft, trigger: next })
  const schedule: WorkflowSchedule = trigger.kind === "schedule" ? trigger.schedule : { kind: "weekdays", hour: 9, minute: 0 }
  const setSchedule = (next: WorkflowSchedule): void => setTrigger({ kind: "schedule", schedule: next })
  const time = schedule.kind === "interval" ? { hour: 9, minute: 0 } : { hour: schedule.hour, minute: schedule.minute }
  return (
    <>
      <span className="workflows-kind">Trigger</span>
      <div className="field">
        <span className="field-label">Runs</span>
        <select
          className="select"
          aria-label="Trigger"
          value={trigger.kind}
          onChange={(event) => setTrigger(event.target.value === "schedule" ? { kind: "schedule", schedule } : { kind: event.target.value as "manual" | "pr-review-requested" | "pr-opened" | "webhook" })}
        >
          <option value="manual">When I start it</option>
          <option value="schedule">On a schedule</option>
          <option value="pr-review-requested">When a pull request asks for my review</option>
          <option value="pr-opened">When a pull request is opened</option>
          <option value="webhook">When its link is called</option>
        </select>
      </div>
      {trigger.kind === "schedule" && (
        <div className="field">
          <span className="field-label">Schedule</span>
          <div className="schedule">
            <Segmented
              label="Schedule kind"
              size="sm"
              value={schedule.kind}
              onChange={(kind) => setSchedule(kind === "interval" ? { kind, minutes: 60 } : kind === "weekly" ? { kind, day: 1, ...time } : { kind, ...time })}
              options={[
                { value: "interval", label: "Every" },
                { value: "daily", label: "Daily" },
                { value: "weekdays", label: "Weekdays" },
                { value: "weekly", label: "Weekly" },
              ]}
            />
            {schedule.kind === "interval" ? (
              <select className="select" aria-label="Interval" value={schedule.minutes} onChange={(event) => setSchedule({ kind: "interval", minutes: Number(event.target.value) })}>
                {INTERVALS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {describeSchedule({ kind: "interval", minutes }).replace(/^Every /, "")}
                  </option>
                ))}
              </select>
            ) : (
              <>
                {schedule.kind === "weekly" && (
                  <select className="select" aria-label="Day" value={schedule.day} onChange={(event) => setSchedule({ ...schedule, day: Number(event.target.value) })}>
                    {DAYS.map((day, at) => (
                      <option key={day} value={at}>
                        {day}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  className="input time"
                  type="time"
                  aria-label="Time"
                  value={`${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(":").map(Number)
                    if (hour !== undefined && minute !== undefined && Number.isFinite(hour) && Number.isFinite(minute)) setSchedule({ ...schedule, hour, minute })
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
      {trigger.kind === "webhook" && <WebhookFields projectId={projectId} workflowId={draft.id} />}
      {(trigger.kind === "pr-review-requested" || trigger.kind === "pr-opened") && (
        <p className="form-hint">Asks GitHub through the gh command every 5 minutes. Pull requests already open when it is turned on do not start a run. Prompts can name the pull request with {"{pr}"}.</p>
      )}
      <div className="toggle-row">
        <Toggle label="Run in a worktree" checked={draft.where === "worktree"} disabled={!git} onChange={(on) => onChange({ ...draft, where: on ? "worktree" : "checkout" })} />
        <span>Each run in a new worktree{git ? "" : " (needs git)"}</span>
      </div>
      <label className="field">
        <span className="field-label">Most minutes per run</span>
        <input
          className="input"
          type="number"
          min={1}
          max={1_440}
          value={draft.budget.maxMinutes}
          onChange={(event) => onChange({ ...draft, budget: { maxMinutes: Math.min(1_440, Math.max(1, Math.round(Number(event.target.value)) || 1)) } })}
        />
      </label>
    </>
  )
}

/** A workflow's link: made, shown once, renewed, or removed here. */
function WebhookFields({ projectId, workflowId }: { readonly projectId: string; readonly workflowId: string }) {
  const words = useWords()
  const running = usePhone((state) => state.status?.running === true)
  const hook = usePhone((state) => state.status?.hooks.find((item) => item.projectId === projectId && item.workflowId === workflowId))
  const name = usePhone((state) => state.tailscale?.name)
  const saved = useWorkflows((state) => state.byProject[projectId]?.workflows.some((item) => item.id === workflowId && item.trigger.kind === "webhook") === true)
  // The secret lives only while this is open: Runrail keeps a fingerprint of it, never the link.
  const [fresh, setFresh] = useState<{ readonly id: string; readonly url: string }>()
  const [busy, setBusy] = useState(false)
  const make = (): void => {
    setBusy(true)
    void makeHook(projectId, workflowId)
      .then((made) => setFresh(made === undefined ? undefined : { id: made.id, url: hookUrl(made.token, usePhone.getState().tailscale?.name ?? name) }))
      .finally(() => setBusy(false))
  }
  const shown = fresh !== undefined && fresh.id === hook?.id ? fresh.url : undefined
  return (
    <div className="field">
      <span className="field-label">Link</span>
      <p className="form-hint">A POST to the workflow's link starts a run while Runrail is open and the workflow is on, at most every 10 seconds. Anyone on your tailnet with the link can call it; what they send (up to 16 KB of text, such as JSON) is given to its agents as outside data, not as your instructions.</p>
      {!running ? (
        <p className="form-hint">Turn on Phone access in Settings, General first: the link is served from this {words.computer} through your Tailscale.</p>
      ) : !saved ? (
        <p className="form-hint">Save the workflow, then make its link.</p>
      ) : (
        <>
          {shown !== undefined && (
            <>
              <div className="conn-command">
                <code className="conn-code mono">{shown}</code>
                <CopyButton text={shown} label="Copy the link" />
              </div>
              <p className="form-hint">Copy it now. Runrail keeps only a fingerprint of it, so it cannot show it again.</p>
            </>
          )}
          {hook !== undefined && shown === undefined && <p className="form-hint">It has a link, made {timeAgo(hook.createdAt)}{hook.usedAt === undefined ? ", not called yet" : `, last called ${timeAgo(hook.usedAt)}`}. A new link ends this one.</p>}
          <div className="agents-row">
            <Button size="sm" variant="ghost" icon={<Link size={13} />} disabled={busy} onClick={make}>
              {hook === undefined ? "Make a link" : "Make a new link"}
            </Button>
            {hook !== undefined && (
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} disabled={busy} onClick={() => void removeHook(hook.id)}>
                Remove the link
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const ACCESS_LEVELS: readonly PermissionPreset[] = ["ask", "auto-edit", "auto", "full"]

function StepFields({
  projectId,
  draft,
  step,
  setups,
  onChange,
}: {
  readonly projectId: string
  readonly draft: WorkflowDraft
  readonly step: WorkflowStep
  readonly setups: readonly SetupInfo[]
  readonly onChange: (step: WorkflowStep) => void
}) {
  const catalog = useCatalog(projectId)
  const developer = useApp((state) => state.prefs.developer)
  const earlier = draft.steps.slice(0, draft.steps.indexOf(step)).filter((item) => item.kind === "agent" || item.kind === "setup")
  switch (step.kind) {
    case "agent":
      return (
        <>
          <label className="field">
            <span className="field-label">Prompt</span>
            <textarea
              className="textarea"
              rows={5}
              value={step.prompt}
              maxLength={16_000}
              placeholder="What the agent does. {pr} names the pull request that started the run."
              onChange={(event) => onChange({ ...step, prompt: event.target.value })}
            />
          </label>
          <div className="field">
            <span className="field-label">Runs on</span>
            <div className="field-row">
              <RunsOnSelect
                className="grow"
                catalog={catalog}
                value={roleSelection(step.runsOn)}
                label="Runs on"
                unbound={{ label: developer ? "Test model" : "Pick a model", disabled: !developer }}
                onChange={(next) => onChange({ ...step, runsOn: { ...toRole(next), ...(step.runsOn.access === undefined ? {} : { access: step.runsOn.access }) } })}
              />
              <select className="select" aria-label="Access" value={step.runsOn.access ?? "ask"} onChange={(event) => onChange({ ...step, runsOn: { ...step.runsOn, access: event.target.value as PermissionPreset } })}>
                {ACCESS_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {PERMISSION_LABELS[level]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {step.runsOn.access === "ask" && <p className="form-hint">Ask stops at each change for you in the step's thread.</p>}
        </>
      )
    case "setup":
      return (
        <>
          <label className="field">
            <span className="field-label">Setup</span>
            <select className="select" value={step.setupId} onChange={(event) => onChange({ ...step, setupId: event.target.value })}>
              {step.setupId === "" && <option value="">Pick a setup</option>}
              {setups.map((setup) => (
                <option key={setup.id} value={setup.id}>
                  {setup.name}
                </option>
              ))}
            </select>
          </label>
          {setups.length === 0 && <p className="form-hint">Make a setup on Agents first.</p>}
          <label className="field">
            <span className="field-label">Task</span>
            <textarea className="textarea" rows={4} value={step.task} maxLength={16_000} placeholder="What the setup plans, executes and reviews." onChange={(event) => onChange({ ...step, task: event.target.value })} />
          </label>
        </>
      )
    case "check":
      return (
        <>
          <label className="field">
            <span className="field-label">Command</span>
            <input className="input mono" value={step.command} maxLength={4_000} spellCheck={false} onChange={(event) => onChange({ ...step, command: event.target.value })} />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Repeat</span>
              <input className="input" type="number" min={1} max={10} value={step.repeat} onChange={(event) => onChange({ ...step, repeat: Math.min(10, Math.max(1, Math.round(Number(event.target.value)) || 1)) })} />
            </label>
            <label className="field">
              <span className="field-label">Minutes per run</span>
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                value={step.timeoutMinutes}
                onChange={(event) => onChange({ ...step, timeoutMinutes: Math.min(120, Math.max(1, Math.round(Number(event.target.value)) || 1)) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field grow">
              <span className="field-label">If it fails</span>
              <select
                className="select"
                value={step.retry?.step ?? ""}
                onChange={(event) => {
                  const { retry: _retry, ...rest } = step
                  onChange(event.target.value === "" ? rest : { ...rest, retry: { step: event.target.value, times: step.retry?.times ?? 2 } })
                }}
              >
                <option value="">Stop and tell me</option>
                {earlier.map((item) => (
                  <option key={item.id} value={item.id}>
                    Send the log to "{item.title}"
                  </option>
                ))}
              </select>
            </label>
            {step.retry !== undefined && (
              <label className="field">
                <span className="field-label">Times</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={5}
                  value={step.retry.times}
                  onChange={(event) => step.retry !== undefined && onChange({ ...step, retry: { ...step.retry, times: Math.min(5, Math.max(1, Math.round(Number(event.target.value)) || 1)) } })}
                />
              </label>
            )}
          </div>
          <p className="form-hint">Every run must pass. {step.retry === undefined ? "" : "After the last fix, the run stops and tells you."}</p>
        </>
      )
    case "decision":
      return (
        <>
          <label className="field">
            <span className="field-label">Question</span>
            <input className="input" value={step.question} maxLength={300} onChange={(event) => onChange({ ...step, question: event.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Stop when the answer is</span>
            <Segmented
              label="Stop when"
              size="sm"
              value={step.stopWhen}
              onChange={(value) => onChange({ ...step, stopWhen: value })}
              options={[
                { value: "no", label: "No" },
                { value: "yes", label: "Yes" },
              ]}
            />
          </label>
          <p className="form-hint">The agent step right before it answers yes or no as it finishes.</p>
        </>
      )
    case "approval":
      return (
        <label className="field">
          <span className="field-label">What to look at (optional)</span>
          <input
            className="input"
            value={step.detail ?? ""}
            maxLength={500}
            onChange={(event) => {
              const { detail: _detail, ...rest } = step
              onChange(event.target.value.trim().length === 0 ? rest : { ...rest, detail: event.target.value })
            }}
          />
        </label>
      )
    case "action":
      if (step.action === "open-pr")
        return (
          <>
            <div className="toggle-row">
              <Toggle label="Draft" checked={step.draft} onChange={(value) => onChange({ ...step, draft: value })} />
              <span>Open it as a draft</span>
            </div>
            <p className="form-hint">Needs an approval before it and a worktree. Commits what the run changed, pushes the run's branch, and opens the pull request against the checkout's branch.</p>
          </>
        )
      if (step.action === "slack")
        return (
          <>
            <label className="field">
              <span className="field-label">Channel</span>
              <input className="input" value={step.channel} maxLength={80} onChange={(event) => onChange({ ...step, channel: event.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Message</span>
              <textarea className="textarea" rows={3} value={step.text} maxLength={4_000} onChange={(event) => onChange({ ...step, text: event.target.value })} />
            </label>
            <p className="form-hint">Asks you before it posts, showing the exact message.</p>
          </>
        )
      return (
        <label className="field">
          <span className="field-label">Message</span>
          <input className="input" value={step.text} maxLength={500} onChange={(event) => onChange({ ...step, text: event.target.value })} />
        </label>
      )
  }
}

// ---------------------------------------------------------------------------------------------
// Runs

function Runs({ projectId, workflow, runId, now }: { readonly projectId: string; readonly workflow: WorkflowInfo; readonly runId?: string | undefined; readonly now: number }) {
  const live = useWorkflows((state) => state.runs)
  const runs = useMemo(() => {
    const fromEngine = Object.values(live)
      .filter((entry) => entry.projectId === projectId && entry.run.workflowId === workflow.id)
      .map((entry) => entry.run)
    const seen = new Set(fromEngine.map((run) => run.runId))
    const past = workflow.runs.filter((record) => !seen.has(record.runId))
    const entries: RunEntry[] = [...fromEngine.map((run) => ({ runId: run.runId, startedAt: run.startedAt, live: run })), ...past.map((record) => ({ runId: record.runId, startedAt: record.startedAt, record }))]
    return entries.sort((a, b) => b.startedAt - a.startedAt)
  }, [live, projectId, workflow])
  const [selected, setSelected] = useState<string | undefined>(runId ?? runs[0]?.runId)
  useEffect(() => {
    if (runId !== undefined) setSelected(runId)
  }, [runId])
  if (runs.length === 0) return <p className="agents-note">No runs yet. Start one with Run once now.</p>
  const chosen = runs.find((run) => run.runId === selected) ?? runs[0]
  return (
    <div className="workflows-runs">
      <ul className="workflows-run-list" aria-label="Runs">
        {runs.map((entry) => {
          const state = entry.live?.state ?? entry.record?.state ?? "failed"
          return (
            <li key={entry.runId}>
              <button type="button" className={cx("agents-item", chosen?.runId === entry.runId && "is-active")} onClick={() => setSelected(entry.runId)}>
                <span className="agents-item-title">
                  <span className="agents-item-text">{timeAgo(entry.startedAt, now)}</span>
                  <span className="agents-item-status">
                    <StateIcon state={state} waiting={entry.live?.waiting !== undefined} />
                  </span>
                </span>
                <span className="agents-item-meta">{triggerWord(entry.live?.trigger ?? entry.record?.trigger ?? "manual")}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {chosen?.live !== undefined ? <LiveRun run={chosen.live} workflow={workflow} now={now} /> : chosen?.record !== undefined ? <PastRun record={chosen.record} workflow={workflow} now={now} /> : null}
    </div>
  )
}

interface RunEntry {
  readonly runId: string
  readonly startedAt: number
  /** A run the engine still holds, with its waiting step. */
  readonly live?: WorkflowRun
  /** A past run's record. */
  readonly record?: WorkflowRunRecord
}

function triggerWord(trigger: WorkflowRun["trigger"]): string {
  return trigger === "schedule" ? "On schedule" : trigger === "pr-review-requested" ? "Review requested" : trigger === "pr-opened" ? "Pull request opened" : trigger === "webhook" ? "Webhook" : "By hand"
}

function StateIcon({ state, waiting }: { readonly state: WorkflowRun["state"]; readonly waiting: boolean }): ReactNode {
  if (waiting) return <CircleAlert size={12} className="tone-amber" aria-label="Waiting for you" />
  if (state === "running" || state === "waiting") return <LoaderCircle size={12} className="spin" aria-label="Running" />
  if (state === "succeeded") return <CircleCheck size={12} className="tone-green" aria-label="Done" />
  if (state === "stopped") return <CircleStop size={12} className="muted" aria-label="Stopped" />
  return <CircleX size={12} className="tone-red" aria-label="Failed" />
}

function StepStatus({ status }: { readonly status: string }): ReactNode {
  if (status === "running") return <LoaderCircle size={13} className="spin" aria-label="Running" />
  if (status === "done") return <Check size={13} className="tone-green" aria-label="Done" />
  if (status === "failed") return <X size={13} className="tone-red" aria-label="Failed" />
  if (status === "pending") return <CircleDashed size={13} className="muted" aria-label="Not yet" />
  return <CircleDashed size={13} className="muted" aria-label="Skipped" />
}

function LiveRun({ run, workflow, now }: { readonly run: WorkflowRun; readonly workflow: WorkflowInfo; readonly now: number }) {
  const threads = useApp((state) => state.threads)
  const [busy, setBusy] = useState<"yes" | "no">()
  const answer = async (approved: boolean): Promise<void> => {
    const waiting = run.waiting
    if (waiting === undefined) return
    setBusy(approved ? "yes" : "no")
    try {
      await answerWorkflow(run.runId, waiting.stepId, approved)
    } catch (cause) {
      toast("error", toHostError(cause).message)
    } finally {
      setBusy(undefined)
    }
  }
  const openStepThread = (setupRuns: readonly string[]): void => {
    const thread = [...threads].reverse().find((item) => item.setup !== undefined && setupRuns.includes(item.setup.runId))
    if (thread === undefined) return
    set({ view: { kind: "thread" } })
    openThread(thread.id)
  }
  return (
    <div className="workflows-run">
      <header className="agents-run-head">
        <div className="agents-run-title">
          <StateIcon state={run.state} waiting={run.waiting !== undefined} />
          <h2>{run.state === "waiting" ? "Waiting for you" : run.state === "running" ? "Running" : run.state === "succeeded" ? "Done" : run.state === "stopped" ? "Stopped" : "Failed"}</h2>
        </div>
        <p className="muted">
          {triggerWord(run.trigger)}
          {run.pr === undefined ? "" : ` · #${String(run.pr.number)}${run.pr.title === undefined ? "" : ` ${run.pr.title}`}`} · {duration((run.endedAt ?? now) - run.startedAt)}
          {run.worktree === undefined ? "" : ` · worktree ${run.worktree}`}
        </p>
        {active(run) && (
          <Button size="sm" variant="ghost" icon={<CircleStop size={13} />} onClick={() => void stopWorkflowRun(run.runId).catch((error: unknown) => toast("error", `Could not stop the run: ${toHostError(error).message}`))}>
            Stop run
          </Button>
        )}
      </header>
      {run.error !== undefined && (
        <p className="form-warning" role="alert">
          <CircleAlert size={13} /> {run.error.message}
        </p>
      )}
      {run.waiting !== undefined && (
        <section className="agents-approval" aria-label={run.waiting.kind === "slack" ? "Send this Slack message?" : run.waiting.title}>
          {run.waiting.kind === "slack" ? (
            <>
              <h2>Send this to {run.waiting.channel}?</h2>
              <pre className="workflows-message">{run.waiting.text}</pre>
            </>
          ) : (
            <>
              <h2>{run.waiting.title}</h2>
              {run.waiting.detail !== undefined && <p>{run.waiting.detail}</p>}
              <p className="muted">The steps before this one worked in {run.worktree === undefined ? "the project's checkout" : `the worktree ${run.worktree}`}; their threads show what changed.</p>
            </>
          )}
          <div className="agents-row">
            <Button variant="ghost" loading={busy === "no"} disabled={busy !== undefined} onClick={() => void answer(false)}>
              {run.waiting.kind === "slack" ? "Don't send" : "Decline"}
            </Button>
            <span className="agents-spacer" />
            <Button variant="primary" icon={run.waiting.kind === "slack" ? <Send size={13} /> : <Check size={13} />} loading={busy === "yes"} disabled={busy !== undefined} onClick={() => void answer(true)}>
              {run.waiting.kind === "slack" ? "Send" : "Approve"}
            </Button>
          </div>
        </section>
      )}
      <section className="agents-steps">
        <ol>
          {run.steps.map((step) => (
            <li key={step.id} className={cx("agents-step", `is-${step.status}`)}>
              <StepStatus status={step.status} />
              <span className="agents-step-title">{step.title}</span>
              {step.note !== undefined && <span className="muted">{step.note}</span>}
              <span className="agents-spacer" />
              {step.setupRuns.length > 0 && (
                <button type="button" className="link-button" onClick={() => openStepThread(step.setupRuns)}>
                  <MessagesSquare size={12} aria-hidden /> Thread
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>
      {run.notices.length > 0 && (
        <section className="workflows-notices" aria-label="What it said">
          {run.notices.map((notice, at) => (
            <p key={`${notice.stepId}-${String(at)}`}>{notice.text}</p>
          ))}
        </section>
      )}
      {run.openedPr !== undefined && (
        <p className="workflows-opened">
          <GitPullRequest size={13} aria-hidden /> Opened #{run.openedPr.number}
          {run.openedPr.url === undefined ? "" : ` · ${run.openedPr.url}`}
        </p>
      )}
      <p className="form-hint">{workflow.where === "worktree" ? "Each run works in a worktree of its own; Apply it from a step's thread." : "Runs in the project's checkout."}</p>
    </div>
  )
}

function PastRun({ record, workflow, now }: { readonly record: WorkflowRunRecord; readonly workflow: WorkflowInfo; readonly now: number }) {
  const titles = new Map(workflow.steps.map((step) => [step.id, step.title]))
  return (
    <div className="workflows-run">
      <header className="agents-run-head">
        <div className="agents-run-title">
          <StateIcon state={record.state} waiting={false} />
          <h2>
            {lastLine(record, now)
              .replace(/^last /, "")
              .replace(/^ran /, "Ran ")
              .replace(/^run /, "Run ")}
          </h2>
        </div>
        <p className="muted">
          {triggerWord(record.trigger)}
          {record.pr === undefined ? "" : ` · #${String(record.pr)}`} · {duration((record.endedAt ?? record.startedAt) - record.startedAt)}
        </p>
      </header>
      <section className="agents-steps">
        <ol>
          {record.steps.map((step) => (
            <li key={step.id} className={cx("agents-step", `is-${step.status}`)}>
              <StepStatus status={step.status} />
              <span className="agents-step-title">{titles.get(step.id) ?? step.id}</span>
              {step.note !== undefined && <span className="muted">{step.note}</span>}
            </li>
          ))}
        </ol>
      </section>
      <p className="form-hint">A past run keeps its steps' states only; its threads are in the Threads list.</p>
    </div>
  )
}
