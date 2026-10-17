import { Check, ChevronDown, ChevronRight, CircleStop, Columns3, Ellipsis, ExternalLink, FlaskConical, GitMerge, RefreshCw, Send, ShieldQuestion, TriangleAlert, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction } from "../../app/actions"
import { checkLine, runCheck, sendFailures, stopCheck, suggestedRun, useChecks, type CheckState } from "../../app/checks"
import { ensureEngine, resolveApproval, threadStatus } from "../../app/engines"
import { connectionLabel, useCatalog } from "../../app/catalog"
import type { ThreadMeta } from "../../app/persist"
import { selectionLabel } from "../../app/picker"
import { openThread, set, toast, useApp } from "../../app/store"
import { applyWinner, candidateDiff, discardWorktree } from "../../app/workflows"
import { QuestionForm } from "../thread/QuestionCard"
import { toHostError } from "../../host"
import { duration, firstLine, plural } from "../../lib/format"
import type { GitDiff, WorktreeApply } from "../../protocol/schemas"
import type { ApprovalItem, TimelineItem } from "../../thread/reducer"
import { PatchView } from "../diff/DiffView"
import { Markdown } from "../thread/Markdown"
import { approvalDetail, approvalQuestion } from "../thread/rows"
import { Button, cx, EmptyState, IconButton, Menu, Spinner, StatusIcon, statusLabel, useTicker } from "../common"

/**
 * Best-of-N comparison. Each candidate ran the same prompt in its own worktree; this view lines
 * them up with their change sets, marks files only one candidate touched, and applies the winner
 * to the project checkout with a three-way merge.
 */

interface DiffState {
  readonly loading: boolean
  readonly diff?: GitDiff
  readonly error?: string
}

export function CompareView({ groupId }: { readonly groupId: string }) {
  const allThreads = useApp((state) => state.threads)
  const diffMode = useApp((state) => state.prefs.diffView)
  const threads = useMemo(() => allThreads.filter((thread) => thread.group?.id === groupId).sort((a, b) => a.createdAt - b.createdAt), [allThreads, groupId])
  // Only this group's runtimes: another thread's streaming would otherwise redraw every candidate.
  const runtime = useApp(useShallow((state) => Object.fromEntries(threads.map((thread) => [thread.id, state.runtime[thread.id]]))))
  const [diffs, setDiffs] = useState<Readonly<Record<string, DiffState>>>({})
  const [applied, setApplied] = useState<{ readonly threadId: string; readonly result: WorktreeApply } | undefined>()
  const [applying, setApplying] = useState<string | undefined>()
  const statuses = useMemo(() => Object.fromEntries(threads.map((thread) => [thread.id, threadStatus(thread, runtime[thread.id])])), [threads, runtime])
  const statusKey = threads.map((thread) => `${thread.id}:${statuses[thread.id] ?? ""}:${thread.worktree === undefined ? "-" : "w"}`).join("|")
  const checks = useChecks((state) => state.byThread)
  const anyRunning = Object.values(statuses).some((status) => status === "running" || status === "waiting") || threads.some((thread) => checks[thread.id]?.state === "running")
  const now = useTicker(anyRunning)

  // Keep candidate engines attached so live status flows while this view is open.
  useEffect(() => {
    for (const thread of threads) if (thread.worktree !== undefined && runtime[thread.id] === undefined) void ensureEngine(thread.id).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, threads.length])

  const loadDiff = useCallback((threadId: string) => {
    setDiffs((current) => ({ ...current, [threadId]: { ...current[threadId], loading: true, error: undefined } }))
    candidateDiff(threadId)
      .then((diff) => setDiffs((current) => ({ ...current, [threadId]: { loading: false, ...(diff === undefined ? { error: "The diff response was malformed." } : { diff }) } })))
      .catch((error: unknown) => setDiffs((current) => ({ ...current, [threadId]: { loading: false, error: toHostError(error).message } })))
  }, [])

  // Reload diffs whenever a candidate settles.
  useEffect(() => {
    for (const thread of threads) {
      const status = statuses[thread.id]
      if (thread.worktree !== undefined && status !== "running" && status !== "waiting") loadDiff(thread.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey])

  // Files touched by more than one candidate, for the "only here" marker.
  const touchCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const state of Object.values(diffs)) for (const file of state.diff?.files ?? []) counts.set(file.path, (counts.get(file.path) ?? 0) + 1)
    return counts
  }, [diffs])

  const label = threads[0]?.group?.label ?? "Comparison"
  const command = threads[0]?.group?.check
  const suggested = useMemo(
    () =>
      suggestedRun(
        threads.map((thread) => {
          const check = checks[thread.id]
          const totals = diffs[thread.id]?.diff?.totals
          return { threadId: thread.id, passed: check?.state === "done" && check.result.passed && statuses[thread.id] !== "running", ...(totals === undefined ? {} : { lines: totals.additions + totals.deletions }) }
        }),
      ),
    [threads, checks, diffs, statuses],
  )

  const apply = async (thread: ThreadMeta, discardOthers: boolean): Promise<void> => {
    setApplying(thread.id)
    try {
      const result = await applyWinner(thread.id, discardOthers)
      setApplied({ threadId: thread.id, result })
    } catch (error) {
      toast("error", `Apply failed: ${toHostError(error).message}`)
    } finally {
      setApplying(undefined)
    }
  }

  const header = (
    <header className="view-header" data-tauri-drag-region>
      <Columns3 size={15} />
      <h1 className="view-title-bounded" title={label}>
        {label}
      </h1>
      <span className="view-subtitle">
        {plural(threads.length, "run")}
        {command === undefined ? "" : " · checked with "}
        {command !== undefined && <code>{firstLine(command, 60)}</code>}
      </span>
      <div className="pane-toolbar-spacer" data-tauri-drag-region />
      <IconButton label="Close comparison" size="sm" onClick={() => set({ view: { kind: "thread" } })}>
        <X size={14} />
      </IconButton>
    </header>
  )

  if (threads.length === 0)
    return (
      <main className="view">
        {header}
        <EmptyState icon={<Columns3 size={20} />} title="This comparison has no runs left">
          Its threads were deleted. Start a new Best of N from the command palette.
        </EmptyState>
      </main>
    )

  return (
    <main className="view view-wide">
      {header}
      {applied !== undefined && (
        <div className={cx("apply-banner", applied.result.conflicts.length > 0 ? "is-warn" : "is-ok")} role="status">
          {applied.result.conflicts.length > 0 ? <TriangleAlert size={14} /> : <Check size={14} />}
          <div className="apply-text">
            <strong>
              {applied.result.conflicts.length > 0
                ? `Applied with ${String(applied.result.conflicts.length)} conflict${applied.result.conflicts.length === 1 ? "" : "s"}`
                : applied.result.files.length === 0
                  ? "Nothing to apply"
                  : `Applied ${String(applied.result.files.length)} file${applied.result.files.length === 1 ? "" : "s"} to the project`}
            </strong>
            <span>Changes are staged in the project checkout. Review them before committing.</span>
            {applied.result.conflicts.length > 0 && (
              <ul className="apply-conflicts">
                {applied.result.conflicts.slice(0, 20).map((path) => (
                  <li key={path} className="mono">
                    {path}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <IconButton label="Dismiss" size="sm" onClick={() => setApplied(undefined)}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${String(Math.min(threads.length, 3))}, minmax(300px, 1fr))` }}>
        {threads.map((thread, index) => (
          <Candidate
            key={thread.id}
            index={index}
            thread={thread}
            status={statuses[thread.id] ?? "idle"}
            items={runtime[thread.id]?.timeline.items}
            turnStartedAt={runtime[thread.id]?.timeline.turnStartedAt}
            diff={diffs[thread.id]}
            check={command === undefined ? undefined : { state: checks[thread.id], suggested: suggested === thread.id }}
            touchCounts={touchCounts}
            candidates={threads.length}
            now={now}
            diffMode={diffMode}
            applying={applying === thread.id}
            appliedHere={applied?.threadId === thread.id || appliedRun(thread)}
            busy={applying !== undefined}
            onReload={() => loadDiff(thread.id)}
            onApply={(discardOthers) =>
              confirmAction({
                title: discardOthers ? "Apply this run and discard the others?" : "Apply this run to the project?",
                body: discardOthers
                  ? "Its changes are merged into the project checkout and staged. The other runs' worktrees are removed; their threads stay as records."
                  : "Its changes are merged into the project checkout and staged. All worktrees stay so you can still compare.",
                confirm: "Apply",
                danger: discardOthers,
                onConfirm: () => void apply(thread, discardOthers),
              })
            }
          />
        ))}
      </div>
    </main>
  )
}

function lastAnswer(items: readonly TimelineItem[] | undefined): string | undefined {
  if (items === undefined) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "assistant" && item.text.trim().length > 0) return item.text
  }
  return undefined
}

function pendingApproval(items: readonly TimelineItem[] | undefined): ApprovalItem | undefined {
  if (items === undefined) return undefined
  for (const item of items) if (item.kind === "approval" && item.status === "pending") return item
  return undefined
}

/** Lets a waiting candidate be unblocked without leaving the comparison. */
function CandidateApproval({ threadId, item, items }: { readonly threadId: string; readonly item: ApprovalItem; readonly items: readonly TimelineItem[] | undefined }) {
  const gate = item.callKey === undefined ? undefined : items?.find((candidate) => candidate.kind === "tool" && candidate.key === item.callKey)
  const tool = gate?.kind === "tool" ? gate : undefined
  const what = approvalDetail(item, tool) ?? (tool?.presentation.title || item.action)
  const [busy, setBusy] = useState<"approve" | "reject" | undefined>()
  const resolve = (approved: boolean): void => {
    setBusy(approved ? "approve" : "reject")
    void resolveApproval(threadId, item.approvalId, approved).finally(() => setBusy(undefined))
  }
  return (
    <div className="candidate-approval" role="group" aria-label="Approval needed">
      <div className="candidate-approval-head">
        <ShieldQuestion size={13} />
        <span>{approvalQuestion(item)}</span>
      </div>
      {item.questions !== undefined ? (
        <QuestionForm item={item} threadId={threadId} primary={false} compact />
      ) : (
        <>
          <pre className="candidate-approval-action">{what}</pre>
          <div className="candidate-approval-actions">
            <Button size="sm" variant="ghost" loading={busy === "reject"} disabled={busy !== undefined} onClick={() => resolve(false)}>
              Deny
            </Button>
            <Button size="sm" variant="primary" loading={busy === "approve"} disabled={busy !== undefined} onClick={() => resolve(true)}>
              Approve
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * How long the run's last turn took. A thread read back from history has no turn-end rows, so the
 * time runs from its last message to the last thing that happened after it.
 */
export function lastElapsed(items: readonly TimelineItem[] | undefined): number | undefined {
  if (items === undefined) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "turn-end") return item.endedAt - item.startedAt
    if (item?.kind === "user" && !item.steer) {
      let end = item.at
      for (const later of items.slice(index + 1)) if (later.kind !== "turn-end") end = Math.max(end, later.at, ("endedAt" in later ? later.endedAt : undefined) ?? 0)
      return end > item.at ? end - item.at : undefined
    }
  }
  return undefined
}

/** Whether this run's changes are in the project and it has not worked since. */
export function appliedRun(thread: Pick<ThreadMeta, "group" | "updatedAt">): boolean {
  const at = thread.group?.appliedAt
  return at !== undefined && thread.updatedAt <= at
}

function Candidate({
  index,
  thread,
  status,
  items,
  turnStartedAt,
  diff,
  check,
  touchCounts,
  candidates,
  now,
  diffMode,
  applying,
  appliedHere,
  busy,
  onReload,
  onApply,
}: {
  readonly index: number
  readonly thread: ThreadMeta
  readonly status: ReturnType<typeof threadStatus>
  readonly items?: readonly TimelineItem[]
  readonly turnStartedAt?: number
  readonly diff?: DiffState
  /** Present when the comparison has a check command. */
  readonly check?: { readonly state: CheckState | undefined; readonly suggested: boolean }
  readonly touchCounts: ReadonlyMap<string, number>
  readonly candidates: number
  readonly now: number
  readonly diffMode: "unified" | "split"
  readonly applying: boolean
  readonly appliedHere: boolean
  readonly busy: boolean
  readonly onReload: () => void
  readonly onApply: (discardOthers: boolean) => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const developer = useApp((state) => state.prefs.developer)
  // Two runs can share a model and differ only in the connection it is reached through.
  const catalog = useCatalog(thread.projectId)
  const running = status === "running" || status === "waiting"
  const answer = useMemo(() => lastAnswer(items), [items])
  const approval = useMemo(() => pendingApproval(items), [items])
  const elapsed = running && turnStartedAt !== undefined ? now - turnStartedAt : lastElapsed(items)
  const toolCalls = useMemo(() => items?.filter((item) => item.kind === "tool").length ?? 0, [items])
  const files = diff?.diff?.files ?? []
  const totals = diff?.diff?.totals
  const discarded = thread.worktree === undefined
  const [logOpen, setLogOpen] = useState(false)
  const checkState = check?.state
  const line = check === undefined ? undefined : checkLine(checkState, now)
  const failed = checkState?.state === "done" && !checkState.result.passed && !checkState.result.stopped

  const toggle = (path: string): void =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <section className={cx("candidate", appliedHere && "is-winner", discarded && "is-discarded")} aria-label={`Run ${String(index + 1)}`}>
      <header className="candidate-head">
        <span className="candidate-index">{index + 1}</span>
        <div className="candidate-who">
          <span className="candidate-runs-on" title={thread.model}>
            {selectionLabel(thread, developer, [], catalog.harnesses)}
          </span>
          <span className="candidate-model">{thread.backend === "native" ? (thread.connectionId === undefined ? "" : connectionLabel(thread.connectionId, catalog.connections)) : thread.backend === "replay" ? "Plays back, no model" : thread.model === undefined ? "Own model and login" : "Own login"}</span>
        </div>
        <span className={cx("candidate-status", !discarded && `is-${status}`)}>
          {discarded ? <X size={12} /> : <StatusIcon status={status} size={12} />}
          {discarded ? "Discarded" : statusLabel(status)}
        </span>
      </header>

      <div className="candidate-stats">
        <div className="stat">
          <span className="stat-value">{elapsed === undefined ? "-" : duration(elapsed)}</span>
          <span className="stat-label">Time</span>
        </div>
        <div className="stat">
          <span className="stat-value">{items === undefined ? "-" : toolCalls}</span>
          <span className="stat-label">Tool calls</span>
        </div>
        <div className="stat">
          <span className="stat-value">{totals === undefined ? "-" : totals.files}</span>
          <span className="stat-label">Files</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {totals === undefined ? (
              "-"
            ) : (
              <>
                <span className={totals.additions > 0 ? "add" : "muted"}>+{totals.additions}</span> <span className={totals.deletions > 0 ? "del" : "muted"}>-{totals.deletions}</span>
              </>
            )}
          </span>
          <span className="stat-label">Lines</span>
        </div>
      </div>

      {line !== undefined && !discarded && (
        <div className={cx("candidate-check", `tone-${line.tone}`)}>
          <FlaskConical size={12} aria-hidden="true" />
          <span>{line.text}</span>
          {check?.suggested === true && (
            <span className="pill is-accent" title="Passed with the smallest change. A suggestion; you still choose.">
              Suggested
            </span>
          )}
          <div className="pane-toolbar-spacer" />
          {checkState?.state === "done" && checkState.result.tail.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setLogOpen(!logOpen)}>
              {logOpen ? "Hide log" : "Log"}
            </Button>
          )}
          {checkState?.state === "running" ? (
            <Button size="sm" variant="ghost" icon={<CircleStop size={12} />} onClick={() => void stopCheck(thread.id)}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={running} onClick={() => void runCheck(thread.id)}>
              {checkState === undefined ? "Check" : "Check again"}
            </Button>
          )}
        </div>
      )}
      {logOpen && checkState?.state === "done" && (
        <pre className="candidate-check-log">
          {checkState.result.truncated ? "…\n" : ""}
          {checkState.result.tail}
        </pre>
      )}

      {approval !== undefined && !discarded && <CandidateApproval threadId={thread.id} item={approval} items={items} />}

      {answer !== undefined && (
        <div className="candidate-answer">
          <Markdown text={answer.slice(0, 4_000)} />
        </div>
      )}

      <div className="candidate-files">
        {discarded ? (
          <div className="pane-note">This run's worktree was removed.</div>
        ) : diff === undefined || (diff.loading && diff.diff === undefined) ? (
          running ? (
            <div className="pane-loading">
              <Spinner size={12} /> Working…
            </div>
          ) : (
            <div className="pane-loading">
              <Spinner size={12} /> Loading changes…
            </div>
          )
        ) : diff.error !== undefined ? (
          <div className="pane-note is-error">
            {diff.error}
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={onReload}>
              Retry
            </Button>
          </div>
        ) : files.length === 0 ? (
          <div className="pane-note">{running ? "No changes yet." : "This run made no changes."}</div>
        ) : (
          <ul className="candidate-file-list">
            {files.map((file) => {
              const expanded = open.has(file.path)
              const unique = candidates > 1 && (touchCounts.get(file.path) ?? 0) === 1
              return (
                <li key={file.path}>
                  <button type="button" className="candidate-file" aria-expanded={expanded} onClick={() => toggle(file.path)}>
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="candidate-file-path" title={file.path}>
                      {file.path}
                    </span>
                    {unique && (
                      <span className="pill is-accent" title="Only this run changed this file">
                        Only here
                      </span>
                    )}
                    <span className={file.additions > 0 ? "add" : "muted"}>+{file.additions}</span>
                    <span className={file.deletions > 0 ? "del" : "muted"}>-{file.deletions}</span>
                  </button>
                  {expanded && (
                    <div className="candidate-patch">
                      {file.binary === true ? (
                        <div className="pane-note">Binary file</div>
                      ) : file.sensitive === true ? (
                        <div className="pane-note">Hidden: this path looks like it holds secrets.</div>
                      ) : file.patch === undefined || file.patch.length === 0 ? (
                        <div className="pane-note">No text changes</div>
                      ) : (
                        <PatchView patch={file.patch} path={file.path} mode={diffMode} />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
            {diff.diff?.truncated === true && <li className="pane-note">Some files were left out. Open the thread to review everything.</li>}
          </ul>
        )}
      </div>

      <footer className="candidate-foot">
        <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={() => openThread(thread.id)}>
          Open thread
        </Button>
        <div className="pane-toolbar-spacer" />
        <Button
          size="sm"
          variant={appliedHere ? "ghost" : "primary"}
          icon={appliedHere ? <Check size={12} /> : <GitMerge size={12} />}
          loading={applying}
          disabled={busy || running || discarded || appliedHere || files.length === 0}
          onClick={() => onApply(false)}
        >
          {appliedHere ? "Applied" : "Apply"}
        </Button>
        <Menu
          align="end"
          side="top"
          trigger={({ toggle: toggleMenu, ref }) => (
            <IconButton ref={ref} label="More actions" size="sm" disabled={busy} onClick={toggleMenu}>
              <Ellipsis size={14} />
            </IconButton>
          )}
          items={[
            { id: "apply-discard", label: "Apply and discard the others", icon: <GitMerge size={13} />, disabled: running || discarded || files.length === 0, onSelect: () => onApply(true) },
            { id: "reload", label: "Refresh changes", icon: <RefreshCw size={13} />, disabled: discarded, onSelect: onReload },
            ...(check === undefined
              ? []
              : [{ id: "send-failures", label: "Send failures to this run", icon: <Send size={13} />, disabled: discarded || running || !failed, onSelect: () => sendFailures(thread.id) }]),
            { separator: true, id: "sep" },
            {
              id: "discard",
              label: "Discard this run",
              icon: <X size={13} />,
              danger: true,
              disabled: discarded,
              onSelect: () =>
                confirmAction({
                  title: "Discard this run?",
                  body: "Its worktree and uncommitted changes are deleted. The thread stays as a record.",
                  confirm: "Discard",
                  danger: true,
                  onConfirm: () => void discardWorktree(thread.id),
                }),
            },
          ]}
        />
      </footer>
    </section>
  )
}
