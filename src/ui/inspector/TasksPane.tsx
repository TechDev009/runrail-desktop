import { ArrowLeft, Bot, Globe, ListChecks, RefreshCw, Square, SquareTerminal } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { readBackgroundOutput, refreshBackground, stopAllBackground, stopBackground, useBackground } from "../../app/background"
import { workspaceOf } from "../../app/actions"
import { cancel } from "../../app/engines"
import { newPanelTab } from "../../app/panels"
import { toast, useApp } from "../../app/store"
import { plainOutput, useTaskRows, type TaskRow, type TaskStatus } from "../../app/tasks"
import { toHostError } from "../../host"
import { compact, duration, plural } from "../../lib/format"
import type { ToolItem } from "../../thread/reducer"
import { Button, CopyButton, cx, EmptyState, IconButton, Spinner, StatusIcon, useTicker } from "../common"
import { Markdown } from "../thread/Markdown"
import { AgentTranscript, type AgentChildItem } from "../thread/rows"

/**
 * Tasks: subagents and commands the agent started, with the ones still running first. A row opens
 * its detail in place: an agent's steps and report, or a command's output.
 */

const LIST_POLL_MS = 3_000
const OUTPUT_POLL_MS = 1_500
const OUTPUT_BYTES = 65_536

const STATUS_TEXT: Readonly<Record<TaskStatus, string>> = { running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped", unknown: "Ended" }

function statusIcon(status: TaskStatus): "running" | "completed" | "failed" | "stopped" | "idle" {
  return status === "unknown" ? "idle" : status
}

/** Lists again every few seconds while the tab shows, so ports and ends show without waiting on a turn. */
function usePolling(threadId: string): void {
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === "visible") void refreshBackground(threadId, { servers: true })
    }
    tick()
    const timer = setInterval(tick, LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [threadId])
}

/** Stops a row: an engine entry by its id, a subagent tied to its turn by stopping the turn. */
function useStopper(threadId: string): { readonly stopping: ReadonlySet<string>; readonly stop: (row: TaskRow) => void } {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const stop = (row: TaskRow): void => {
    setStopping((current) => new Set(current).add(row.id))
    const done = (): void =>
      setStopping((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
    const work = row.entry?.stoppable === true ? stopBackground(threadId, row.id) : cancel(threadId)
    work.catch((error: unknown) => {
      toast("error", `Could not stop “${row.label}”: ${toHostError(error).message}`)
      done()
    })
  }
  // A row stays "Stopping…" until the engine reports its end.
  const rows = useTaskRows(threadId)
  useEffect(() => {
    if (stopping.size === 0) return
    const running = new Set(rows.running.map((row) => row.id))
    if ([...stopping].some((id) => !running.has(id))) setStopping(new Set([...stopping].filter((id) => running.has(id))))
  }, [rows, stopping])
  return { stopping, stop }
}

function canStop(row: TaskRow, busy: boolean): boolean {
  if (row.status !== "running") return false
  if (row.entry !== undefined) return row.entry.stoppable || (row.entry.stopHint === "turn" && busy)
  return busy
}

export function TasksPane({ threadId }: { readonly threadId: string }) {
  const { running, finished } = useTaskRows(threadId)
  const servers = useBackground((state) => state[threadId]?.servers)
  const busy = useApp((state) => state.runtime[threadId]?.timeline.activeTurnId !== undefined)
  const engine = useApp((state) => state.runtime[threadId]?.engine)
  const [selected, setSelected] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(false)
  const stopper = useStopper(threadId)
  usePolling(threadId)

  const row = selected === undefined ? undefined : [...running, ...finished].find((item) => item.id === selected)
  if (row !== undefined) return <TaskDetail threadId={threadId} row={row} busy={busy} stopping={stopper.stopping.has(row.id)} onStop={() => stopper.stop(row)} onBack={() => setSelected(undefined)} />

  const stoppable = running.filter((item) => item.entry?.stoppable === true).length
  const stopAll = (): void => {
    void stopAllBackground(threadId).then(({ failed }) => {
      if (failed > 0) toast("error", `${plural(failed, "task")} could not be stopped`)
    })
  }

  return (
    <div className="tasks">
      <div className="pane-toolbar">
        <span className="tasks-summary">{running.length === 0 ? "Nothing running" : `${String(running.length)} running`}</span>
        <div className="pane-toolbar-spacer" />
        {stoppable > 1 && (
          <Button size="sm" variant="secondary" className="task-stop" icon={<Square size={11} />} onClick={stopAll}>
            Stop all
          </Button>
        )}
        <IconButton
          label="Refresh"
          size="sm"
          disabled={engine !== "ready" || refreshing}
          onClick={() => {
            setRefreshing(true)
            void refreshBackground(threadId, { servers: true }).finally(() => setRefreshing(false))
          }}
        >
          {refreshing ? <Spinner size={11} /> : <RefreshCw size={12} />}
        </IconButton>
      </div>
      <div className="tasks-scroll">
        {running.length === 0 && finished.length === 0 && (servers === undefined || servers.length === 0) ? (
          <EmptyState icon={<ListChecks size={20} />} title="No tasks yet">
            Subagents and commands the agent leaves running show here, with their output and a way to stop them.
          </EmptyState>
        ) : (
          <>
            {running.length > 0 && (
              <TaskSection title="Running">
                {running.map((item) => (
                  <TaskLine key={item.id} row={item} busy={busy} stopping={stopper.stopping.has(item.id)} onOpen={() => setSelected(item.id)} onStop={() => stopper.stop(item)} />
                ))}
              </TaskSection>
            )}
            {servers !== undefined && servers.length > 0 && (
              <TaskSection title="Servers">
                {servers.map((server) => (
                  <div key={server.port} className="task-row">
                    <span className="task-icon">
                      <Globe size={14} />
                    </span>
                    <span className="task-main">
                      <span className="task-label">localhost:{server.port}</span>
                      <span className="task-meta">{server.process}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => newPanelTab(threadId, "browser", `http://localhost:${String(server.port)}/`)}>
                      Open
                    </Button>
                  </div>
                ))}
              </TaskSection>
            )}
            {finished.length > 0 && (
              <TaskSection title="Finished">
                {finished.map((item) => (
                  <TaskLine key={item.id} row={item} busy={busy} stopping={false} onOpen={() => setSelected(item.id)} onStop={() => undefined} />
                ))}
              </TaskSection>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TaskSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="task-section" aria-label={title}>
      <div className="task-section-title">{title}</div>
      <div className="task-list">{children}</div>
    </section>
  )
}

function meta(row: TaskRow, now: number): string {
  const parts: string[] = []
  if (row.kind === "agent") parts.push(row.agentType ?? "Subagent")
  else parts.push("Command")
  if (row.toolUses !== undefined && row.toolUses > 0) parts.push(plural(row.toolUses, "tool"))
  if (row.tokens !== undefined && row.tokens > 0) parts.push(`${compact(row.tokens)} tokens`)
  if (row.exitCode !== undefined && row.status !== "running") parts.push(`exit ${String(row.exitCode)}`)
  if (row.startedAt !== undefined) parts.push(duration(Math.max(0, (row.endedAt ?? now) - row.startedAt)))
  return parts.join(" · ")
}

function TaskLine({ row, busy, stopping, onOpen, onStop }: { readonly row: TaskRow; readonly busy: boolean; readonly stopping: boolean; readonly onOpen: () => void; readonly onStop: () => void }) {
  const now = useTicker(row.status === "running", 1_000)
  return (
    <div className={cx("task-row", row.status === "running" && "is-running")}>
      <button type="button" className="task-open" onClick={onOpen} title={row.label}>
        <span className="task-icon">{row.kind === "agent" ? <Bot size={14} /> : <SquareTerminal size={14} />}</span>
        <span className="task-main">
          <span className="task-label">{row.label}</span>
          <span className="task-meta">{meta(row, now)}</span>
          {row.detail !== undefined && row.status === "running" && <span className="task-detail">{row.detail}</span>}
        </span>
        <span className="task-status" title={STATUS_TEXT[row.status]}>
          {row.status === "running" ? <Spinner size={12} /> : <StatusIcon status={statusIcon(row.status)} size={13} />}
        </span>
      </button>
      {canStop(row, busy) && <TaskStopButton row={row} stopping={stopping} onStop={onStop} />}
    </div>
  )
}

function TaskDetail({ threadId, row, busy, stopping, onStop, onBack }: { readonly threadId: string; readonly row: TaskRow; readonly busy: boolean; readonly stopping: boolean; readonly onStop: () => void; readonly onBack: () => void }) {
  const now = useTicker(row.status === "running", 1_000)
  return (
    <div className="tasks">
      <div className="pane-toolbar">
        <IconButton label="All tasks" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
        </IconButton>
        <span className="tasks-summary">{row.kind === "agent" ? "Subagent" : "Command"}</span>
        <div className="pane-toolbar-spacer" />
        {canStop(row, busy) && <TaskStopButton row={row} stopping={stopping} onStop={onStop} />}
      </div>
      <div className="tasks-scroll">
        <div className="task-head">
          <span className="task-status">{row.status === "running" ? <Spinner size={12} /> : <StatusIcon status={statusIcon(row.status)} size={13} />}</span>
          <span className="task-head-label">{row.label}</span>
        </div>
        <div className="task-head-meta">
          {STATUS_TEXT[row.status]} · {meta(row, now)}
        </div>
        {row.kind === "command" ? <CommandOutput threadId={threadId} row={row} /> : <AgentSteps threadId={threadId} row={row} />}
      </div>
    </div>
  )
}

export function TaskStopButton({ row, stopping, onStop }: { readonly row: TaskRow; readonly stopping: boolean; readonly onStop: () => void }) {
  return <Button size="sm" variant="secondary" className="task-stop" icon={<Square size={11} />} loading={stopping} onClick={onStop} title={row.entry?.stoppable === true ? "Stop this task" : "Stops the turn this task belongs to"}>
    {stopping ? "Stopping..." : row.entry?.stoppable === true ? "Stop" : "Stop turn"}
  </Button>
}

function AgentSteps({ threadId, row }: { readonly threadId: string; readonly row: TaskRow }) {
  const items = useApp((state) => state.runtime[threadId]?.timeline.items)
  const workspace = workspaceOf(threadId)
  const { steps, transcript, item } = useMemo(() => {
    const tools = (items ?? []).filter((entry): entry is ToolItem => entry.kind === "tool")
    const transcript = (items ?? []).filter((entry): entry is AgentChildItem => (entry.kind === "tool" || entry.kind === "assistant" || entry.kind === "reasoning") && entry.parentCallId !== undefined)
    return { steps: transcript.filter((entry) => entry.parentCallId === row.callId), transcript, item: tools.find((tool) => tool.callId === row.callId) }
  }, [items, row.callId])
  const report = row.status === "running" ? undefined : (item?.output ?? row.detail)
  return (
    <>
      {row.detail !== undefined && row.status === "running" && <p className="task-note">{row.detail}</p>}
      <div className="task-steps">
        {steps.length === 0 ? (
          <p className="inspect-empty">{row.status === "running" ? "Its steps show here as it works." : "Its steps were not shared with Runrail."}</p>
        ) : (
          <AgentTranscript items={transcript} parentCallId={row.callId ?? ""} workspace={workspace} />
        )}
      </div>
      {report !== undefined && report.length > 0 && (
        <div className="agent-report">
          <Markdown text={report.length > 20_000 ? `${report.slice(0, 20_000)}\n\n…` : report} workspace={workspace} />
        </div>
      )}
    </>
  )
}

function CommandOutput({ threadId, row }: { readonly threadId: string; readonly row: TaskRow }) {
  const [output, setOutput] = useState<{ readonly text: string; readonly truncated: boolean } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const view = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  const readable = row.entry?.hasOutput === true
  const running = row.status === "running"

  useEffect(() => {
    if (!readable) return
    let live = true
    const read = (): void => {
      readBackgroundOutput(threadId, row.id, OUTPUT_BYTES)
        .then((value) => {
          if (!live) return
          setError(undefined)
          setOutput({ text: plainOutput(value.text), truncated: value.truncated })
        })
        .catch((failure: unknown) => live && setError(toHostError(failure).message))
    }
    read()
    if (!running) return () => void (live = false)
    const timer = setInterval(read, OUTPUT_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [threadId, row.id, readable, running])

  // New output keeps the view at the bottom unless the person scrolled up to read.
  useEffect(() => {
    const node = view.current
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight
  }, [output])

  return (
    <>
      <div className="task-command">
        <pre>
          <span className="prompt">$ </span>
          {row.label}
        </pre>
        <CopyButton text={row.label} label="Copy command" />
      </div>
      {!readable ? (
        <p className="inspect-empty">{row.id.startsWith("claude:") ? "Its output stays in Claude Code." : "Its output was not shared with Runrail."}</p>
      ) : error !== undefined ? (
        <p className="inspect-empty is-error">{error}</p>
      ) : output === undefined ? (
        <div className="pane-loading">
          <Spinner size={12} /> Reading output…
        </div>
      ) : (
        <div className="tool-output task-output">
          <div className="tool-output-head">
            <span>{output.truncated ? "Output (latest part)" : "Output"}</span>
            <CopyButton text={output.text} label="Copy output" />
          </div>
          <pre
            ref={view}
            onScroll={(event) => {
              const node = event.currentTarget
              pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
            }}
          >
            {output.text.length === 0 ? <span className="muted">{running ? "No output yet" : "No output"}</span> : output.text}
          </pre>
        </div>
      )}
    </>
  )
}
