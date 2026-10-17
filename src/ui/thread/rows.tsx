import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  CornerDownRight,
  Download,
  FileCode,
  FilePen,
  FilePlus,
  FileSearch,
  FolderTree,
  GitBranch,
  Globe,
  History,
  Hourglass,
  ListChecks,
  MessagesSquare,
  Pencil,
  Plug,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Shrink,
  Square,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from "lucide-react"
import { memo, useEffect, useState, type ReactNode } from "react"
import { askAgain, offersSessionApproval, resolveApproval, restartEngine, retry } from "../../app/engines"
import { APPROVAL_SETTLE_MS } from "../../app/attention"
import { forkThread } from "../../app/workflows"
import { openPanelHere } from "../../app/panels"
import { get, openThread, setPrefs, threadById, useApp } from "../../app/store"
import { openRewind } from "../../app/rewind"
import { forkAt } from "../../app/fork"
import { continueAfterReset, dropResume, isLimitNotice, limitReset, openLimit, readLimitMessage, repeatsMessage, resumeNow } from "../../app/limitResume"
import { resetText } from "../../app/limits"
import { PLAN_LIMIT_CODE } from "../../app/limitCheck"
import { clock } from "../../app/stayRunning"
import { hasCapability } from "../../protocol/schemas"
import { API_RETRY, isBusy } from "../../thread/reducer"
import { ReadAloudButton } from "./Voice"
import { openFileMenu } from "../../app/fileMenu"
import { previewWorkspaceChanges, previewWorkspaceFile } from "../../app/filePreview"
import { THINKING_NAME } from "../../app/picker"
import { runLabel } from "../../app/modelText"
import type { ApprovalItem, AssistantItem, NoticeItem, PlanItem, ReasoningItem, ReviewItem, ToolItem, TurnEndItem, UserItem } from "../../thread/reducer"
import { displayPrompt, isQuestion } from "../../thread/reducer"
import { ciLogsOf } from "../../thread/ciLogs"
import { messageFrom, threadsIn } from "../../thread/threadContext"
import type { ApiRetry, CommandIntent, PlanStep, ToolKind } from "../../protocol/schemas"
import type { TurnChanges } from "../../app/store"
import { countLines, editLines, type DiffLine } from "../../lib/diff"
import { basename, compact as tokens, duration, firstLine, plural } from "../../lib/format"
import { Button, CopyButton, cx, IconButton, Spinner, useOverlays, useTicker } from "../common"
import { DiffLines, PatchView } from "../diff/DiffView"
import { Markdown } from "./Markdown"

/** Timeline rows. Each row is memoized on its item object; the reducer replaces changed items. */

export const UserRow = memo(function UserRow({ item, threadId }: { readonly item: UserItem; readonly threadId: string }) {
  const text = displayPrompt(item.text)
  const mentioned = threadsIn(item.text)
  const from = messageFrom(item.text)
  const ci = ciLogsOf(item.text)
  return (
    <div className={cx("row-user", item.state === "sending" && "is-sending", item.state === "failed" && "is-failed")}>
      <div className="user-bubble">
        {item.steer === true && <span className="user-tag">Steer</span>}
        {item.images !== undefined && item.images.length > 0 && (
          <div className="user-images">
            {item.images.map((url) => (
              <img key={url} src={url} alt="Attached image" />
            ))}
          </div>
        )}
        {text.length > 0 && <div className="user-text">{text}</div>}
        {item.attachments > (item.images?.length ?? 0) && <div className="user-attach">{plural(item.attachments - (item.images?.length ?? 0), "attachment")}</div>}
      </div>
      <div className="row-hover-actions">
        <CopyButton text={text} label="Copy message" />
        {item.state === "sent" && item.steer !== true && (
          <>
            <RewindActions threadId={threadId} itemKey={item.key} />
            <ForkButton threadId={threadId} itemKey={item.key} label="Fork from before this message" />
          </>
        )}
      </div>
      {(item.recalled !== undefined || item.recallNote !== undefined) && <RecallCard recalled={item.recalled ?? []} {...(item.recallNote === undefined ? {} : { note: item.recallNote })} />}
      {from !== undefined && <FromThread id={from.id} title={from.title} />}
      {ci !== undefined && (
        <div className="user-context">
          <CircleX size={12} aria-hidden="true" /> With the failing checks' logs from #{ci.number}
        </div>
      )}
      {mentioned.length > 0 && (
        <div className="user-context">
          <MessagesSquare size={12} aria-hidden="true" /> Context from {mentioned.join(", ")}
        </div>
      )}
      {item.state === "sending" && <div className="user-state">Sending…</div>}
      {item.state === "failed" && (
        <div className="user-state is-error" role="alert" title={item.errorCode}>
          <TriangleAlert size={12} /> {notSent(item)}
          {/* A message held for a used-up plan goes on its own when the limit resets; this sends it now regardless. */}
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => retry(threadId, item.key, item.errorCode === PLAN_LIMIT_CODE)}>
            {item.errorCode === PLAN_LIMIT_CODE ? "Send anyway" : "Retry"}
          </Button>
        </div>
      )}
    </div>
  )
})

/** A message another thread's agent sent; opens that thread while it still exists. */
function FromThread({ id, title }: { readonly id: string; readonly title: string }) {
  const exists = useApp((state) => state.threads.some((thread) => thread.id === id))
  return (
    <div className="user-context">
      <Bot size={12} aria-hidden="true" /> Sent by the agent in{" "}
      {exists ? (
        <button type="button" className="user-context-link" onClick={() => openThread(id)} title="Open that thread">
          {threadById(id)?.title ?? title}
        </button>
      ) : (
        title
      )}
    </div>
  )
}

/** Edit and go back, on a message that started a turn, while the thread is between turns. */
function RewindActions({ threadId, itemKey }: { readonly threadId: string; readonly itemKey: string }) {
  const ready = useApp((state) => {
    const runtime = state.runtime[threadId]
    return runtime !== undefined && hasCapability(runtime.contract, "session.rewind") && !isBusy(runtime.timeline) && runtime.queue.length === 0
  })
  if (!ready) return null
  return (
    <>
      <IconButton size="sm" label="Edit and resend" onClick={() => void openRewind(threadId, itemKey, true)}>
        <Pencil size={13} />
      </IconButton>
      <IconButton size="sm" label="Go back to before this message" onClick={() => void openRewind(threadId, itemKey, false)}>
        <History size={13} />
      </IconButton>
    </>
  )
}

/**
 * Fork from any message. An engine that lists rewind also copies threads from a
 * cut. A reply in the turn still running is not forked from.
 */
function ForkButton({ threadId, itemKey, turnId, label }: { readonly threadId: string; readonly itemKey: string; readonly turnId?: string; readonly label: string }) {
  const ready = useApp((state) => {
    const runtime = state.runtime[threadId]
    if (runtime?.contract?.capabilities["session.rewind"] === undefined) return false
    return turnId === undefined || !isBusy(runtime.timeline) || runtime.timeline.activeTurnId !== turnId
  })
  if (!ready) return null
  return (
    <IconButton size="sm" label={label} onClick={() => void forkAt(threadId, itemKey)}>
      <GitBranch size={13} />
    </IconButton>
  )
}

/** The memories sent with a message, folded to one line until opened. */
function RecallCard({ recalled, note }: { readonly recalled: readonly { readonly n: number; readonly label: string; readonly text: string }[]; readonly note?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="recall-card">
      {recalled.length > 0 && (
        <button type="button" className="disclosure recall-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Brain size={12} aria-hidden="true" /> Recalled {recalled.length === 1 ? "1 memory" : `${String(recalled.length)} memories`}
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
      {open && (
        <ol className="recall-list">
          {recalled.map((memory) => (
            <li key={memory.n}>
              <span className="recall-n">m{memory.n}</span>
              <span className="recall-text">{memory.text}</span>
              <span className="recall-label">{memory.label}</span>
            </li>
          ))}
        </ol>
      )}
      {note !== undefined && (
        <p className="recall-note" role="status">
          <TriangleAlert size={12} aria-hidden="true" /> {note}
        </p>
      )}
    </div>
  )
}

/**
 * A reply. The latest one, once its turn is over, keeps its actions in view: copy, ask again, and
 * continue in a new thread. Older replies show copy, and fork from there, on hover.
 */
export const AssistantRow = memo(function AssistantRow({ item, workspace, threadId, last = false }: { readonly item: AssistantItem; readonly workspace?: string; readonly threadId?: string; readonly last?: boolean }) {
  // Trailing blank lines would draw as empty lines under a paragraph that keeps line breaks.
  const text = item.text.trimEnd()
  return (
    <div className={cx("row-assistant", item.streaming && "is-streaming", last && "is-last")}>
      <Markdown text={text} {...(workspace === undefined ? {} : { workspace })} streaming={item.streaming} />
      {!item.streaming && text.length > 0 && (
        <div className="row-hover-actions">
          <CopyButton text={text} label="Copy reply" />
          <ReadAloudButton text={text} itemKey={item.key} />
          {last && threadId !== undefined && (
            <>
              <IconButton size="sm" label="Ask again" onClick={() => askAgain(threadId)}>
                <RotateCcw size={13} />
              </IconButton>
              <IconButton size="sm" label="Continue in a new thread" onClick={() => void forkThread(threadId)}>
                <GitBranch size={13} />
              </IconButton>
            </>
          )}
          {!last && threadId !== undefined && <ForkButton threadId={threadId} itemKey={item.key} {...(item.turnId === undefined ? {} : { turnId: item.turnId })} label="Fork from here" />}
        </div>
      )}
    </div>
  )
})

/** "Thought for 0s" says nothing: under a second, it just thought. */
export function reasoningLabel(item: ReasoningItem): string {
  if (item.streaming) return "Thinking"
  const took = item.endedAt === undefined ? 0 : item.endedAt - item.at
  return took < 1_000 ? "Thought" : `Thought for ${duration(took)}`
}

export const ReasoningRow = memo(function ReasoningRow({ item }: { readonly item: ReasoningItem }) {
  const [toggled, setToggled] = useState<boolean | undefined>()
  const open = toggled ?? (item.streaming && get().prefs.reasoning === "open")
  useEffect(() => {
    if (!item.streaming) setToggled(undefined)
  }, [item.streaming])
  const label = reasoningLabel(item)
  return (
    <div className="row-reasoning">
      <button type="button" className="disclosure" onClick={() => setToggled(!open)} aria-expanded={open}>
        <Brain size={13} />
        <span className={cx(item.streaming && "shimmer")}>{label}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <div className="reasoning-text">{item.text}</div>}
    </div>
  )
})

const KIND_ICON: Record<ToolKind, (size: number) => ReactNode> = {
  read: (size) => <FileSearch size={size} />,
  write: (size) => <FilePlus size={size} />,
  edit: (size) => <FilePen size={size} />,
  patch: (size) => <FileCode size={size} />,
  shell: (size) => <SquareTerminal size={size} />,
  search: (size) => <FileSearch size={size} />,
  list: (size) => <FolderTree size={size} />,
  web: (size) => <Globe size={size} />,
  agent: (size) => <Bot size={size} />,
  plan: (size) => <ListChecks size={size} />,
  verify: (size) => <ShieldCheck size={size} />,
  mcp: (size) => <Plug size={size} />,
  other: (size) => <Wrench size={size} />,
}

function toolDetail(item: ToolItem): string | undefined {
  const p = item.presentation
  if (p.kind === "shell" && p.command !== undefined) return p.title.includes(firstLine(p.command, 80)) ? undefined : firstLine(p.command, 160)
  if (p.path !== undefined && p.path !== "." && !p.title.includes(p.path)) return p.path
  if (p.query !== undefined && !p.title.includes(p.query)) return p.query
  if (p.url !== undefined && !p.title.includes(p.url)) return p.url
  if (p.kind === "mcp" && p.server !== undefined) return `${p.server}${p.tool === undefined ? "" : ` · ${p.tool}`}`
  return undefined
}

function editDiff(item: ToolItem): DiffLine[] | undefined {
  const p = item.presentation
  if (p.edits !== undefined && p.edits.length > 0) return p.edits.flatMap((edit) => editLines(edit.oldText, edit.newText))
  // A trailing newline ends the last line; it is not one more line. An overwrite shows the file as
  // written, not as all new lines: the old text is not here to compare, and the counts say what changed.
  if (p.kind === "write" && p.content !== undefined) {
    const kind = item.created === false ? ("context" as const) : ("add" as const)
    return p.content.replace(/\n$/, "").split("\n").slice(0, 2_000).map((text) => ({ kind, text }))
  }
  return undefined
}

/** Lines added and removed: the engine's count for a file write when it gave one, else the shown diff's. */
export function toolCounts(item: ToolItem, diff: readonly DiffLine[] | undefined): { readonly additions: number; readonly deletions: number } | undefined {
  if (item.additions !== undefined && item.deletions !== undefined) return { additions: item.additions, deletions: item.deletions }
  const { additions, deletions } = item.presentation
  if (additions !== undefined && deletions !== undefined) return { additions, deletions }
  return diff === undefined ? undefined : countLines(diff)
}

function looksLikePatch(value: string | undefined): value is string {
  return value !== undefined && /^@@ -\d+/m.test(value)
}

const FAILURE_LABELS: Record<string, string> = {
  APPROVAL_DENIED: "Denied",
  REVIEW_DENIED: "Denied",
  QUESTION_IN_REPLY: "Asked in reply",
  APPROVAL_TIMEOUT: "No answer",
  APPROVAL_CANCELLED: "Stopped",
  APPROVAL_CLOSED: "Stopped",
  INTERRUPTED: "Stopped",
  TURN_ENDED: "Stopped",
}

/**
 * Codes for work a stop cut short. The turn says "Stopped" once, in its own line; the work it cut
 * short is marked quietly, not as a failure.
 */
export const STOP_CODES: ReadonlySet<string> = new Set(["APPROVAL_CANCELLED", "APPROVAL_CLOSED", "INTERRUPTED", "TURN_ENDED"])

/** An approval that did not go through reads as what happened to it; a denial carries the user's feedback. */
function failureText(item: Pick<ToolItem, "errorCode" | "errorMessage">): string {
  const message = item.errorMessage ?? ""
  switch (item.errorCode) {
    case "APPROVAL_DENIED": {
      const feedback = /^approval denied for [^:]+: (.+)$/s.exec(message)?.[1]?.trim()
      return feedback === undefined || feedback.length === 0 ? "You denied this." : `You denied this: ${feedback}`
    }
    // The coding tool's own reviewer, rules, or mode refused it; the engine's words name which tool.
    case "REVIEW_DENIED":
      return message.length > 0 ? `${message}.` : "Denied without asking you."
    case "APPROVAL_TIMEOUT":
      return "No one answered in time."
    default:
      return message
  }
}

/** Why a call or a subagent failed, in words; work a stop cut short says nothing more than the stop does. */
export function failureLine(item: Pick<ToolItem, "errorCode" | "errorMessage">): string | undefined {
  if (item.errorMessage === undefined || (item.errorCode !== undefined && STOP_CODES.has(item.errorCode))) return undefined
  return failureText(item)
}

/** Failed calls read as words; the stable code stays on hover for diagnostics. */
function FailedStatus({ code }: { readonly code: string | undefined }) {
  return (
    <span className={code !== undefined && (STOP_CODES.has(code) || code === "QUESTION_IN_REPLY") ? "status-stopped" : "status-failed"} title={code}>
      {(code === undefined ? undefined : FAILURE_LABELS[code]) ?? "Failed"}
    </span>
  )
}

/** Present tense with -ing while a call runs, past tense once it is done: "Running git status", "Ran git status". */
const TENSES: readonly (readonly [string, string, string])[] = [
  ["Run ", "Running ", "Ran "],
  ["Read ", "Reading ", "Read "],
  ["Write ", "Writing ", "Wrote "],
  ["Edit ", "Editing ", "Edited "],
  ["Patch ", "Patching ", "Patched "],
  ["Apply patch", "Applying patch", "Applied patch"],
  ["List ", "Listing ", "Listed "],
  ["Search ", "Searching ", "Searched "],
  ["Fetch ", "Fetching ", "Fetched "],
  ["Verify ", "Verifying ", "Verified "],
]

export function toolTitle(item: ToolItem): string {
  const title = item.presentation.title || item.name
  if (item.status === "failed") return title
  for (const [base, running, done] of TENSES) {
    if (title.startsWith(base)) return `${item.status === "running" ? running : done}${title.slice(base.length)}`
  }
  return title
}

/** `asking`: the call waits on an approval, so it reads as the question (what it would do), not as running. */
export function ToolSummary({ item, children, approved = false, asking = false }: { readonly item: ToolItem; readonly children?: number; readonly approved?: boolean; readonly asking?: boolean }) {
  const diff = editDiff(item)
  const counts = toolCounts(item, diff)
  const detail = toolDetail(item)
  return (
    <>
      <span className={cx("tool-icon", `kind-${item.presentation.kind}`)}>{KIND_ICON[item.presentation.kind](13)}</span>
      <span className="tool-title">{asking ? item.presentation.title || item.name : toolTitle(item)}</span>
      {detail !== undefined && <span className="tool-detail">{detail}</span>}
      {counts !== undefined && (counts.additions > 0 || counts.deletions > 0) && (
        <span className="tool-counts">
          <span className="add">+{counts.additions}</span> <span className="del">-{counts.deletions}</span>
        </span>
      )}
      {children !== undefined && children > 0 && <span className="tool-detail">{plural(children, "step")}</span>}
      {approved && (
        <span className="tool-approved" title="You approved this">
          <ShieldCheck size={12} aria-label="You approved this" />
        </span>
      )}
      <span className="tool-status">
        {asking ? null : item.status === "running" ? (
          <Spinner size={12} />
        ) : item.status === "failed" ? (
          <FailedStatus code={item.errorCode} />
        ) : item.endedAt !== undefined && item.endedAt - item.at >= 2_000 ? (
          <span className="muted">{duration(item.endedAt - item.at)}</span>
        ) : null}
      </span>
    </>
  )
}

/** A failure the person has to act on (a sign-in, a limit, a policy), so its row opens and stays out of a run. */
export function needsAttention(item: ToolItem): boolean {
  return item.status === "failed" && /RATE_LIMIT|QUOTA|AUTH|SECURITY|POLICY|REVIEW_DENIED|APPROVAL_DENIED|QUESTION_IN_REPLY/.test(item.errorCode ?? "")
}

export const ToolRow = memo(function ToolRow({
  item,
  childItems,
  workspace,
  compact,
  approved = false,
}: {
  readonly item: ToolItem
  readonly childItems?: readonly ToolItem[]
  readonly workspace?: string
  readonly compact?: boolean
  readonly approved?: boolean
}) {
  const autoOpen = item.status === "running" && item.presentation.kind === "shell"
  const [toggled, setToggled] = useState<boolean | undefined>()
  const open = toggled ?? (autoOpen || needsAttention(item))
  return (
    <div className={cx("row-tool", compact === true && "is-compact", item.status === "failed" && "is-failed")}>
      <button type="button" className="tool-head" onClick={() => setToggled(!open)} aria-expanded={open}>
        <ToolSummary item={item} approved={approved} {...(childItems === undefined ? {} : { children: childItems.length })} />
        <span className="tool-chevron">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
      </button>
      {open && <ToolBody item={item} {...(childItems === undefined ? {} : { childItems })} {...(workspace === undefined ? {} : { workspace })} />}
    </div>
  )
})

function Output({ text, label }: { readonly text: string; readonly label?: string }) {
  return (
    <div className="tool-output">
      <div className="tool-output-head">
        <span>{label ?? "Output"}</span>
        <CopyButton text={text} label="Copy output" />
      </div>
      <pre>{text}</pre>
    </div>
  )
}

function ToolBody({ item, childItems, workspace }: { readonly item: ToolItem; readonly childItems?: readonly ToolItem[]; readonly workspace?: string }) {
  const p = item.presentation
  const diff = editDiff(item)
  const parts: ReactNode[] = []
  if (p.kind === "shell" && p.command !== undefined) {
    parts.push(
      <pre key="cmd" className="tool-command">
        <span className="prompt">$ </span>
        {p.command}
      </pre>,
    )
  }
  if (diff !== undefined) parts.push(<DiffLines key="diff" lines={diff} numbers={false} {...(p.path === undefined ? {} : { path: p.path })} />)
  else if (p.kind === "patch" && looksLikePatch(p.content)) parts.push(<PatchView key="patch" patch={p.content} numbers={false} />)
  if (p.kind === "plan" && p.plan !== undefined) parts.push(<PlanSteps key="plan" steps={p.plan} />)
  if (p.kind === "other" && p.title.startsWith("Message agent") && p.content !== undefined) parts.push(<Output key="message" text={p.content} label="Message" />)
  const proposed = proposedPlan(item)
  if (proposed !== undefined)
    parts.push(
      <div key="proposed" className="tool-plan">
        <Markdown text={proposed} {...(workspace === undefined ? {} : { workspace })} />
      </div>,
    )
  if (childItems !== undefined && childItems.length > 0)
    parts.push(
      <div key="children" className="tool-children">
        {childItems.map((child) => (
          <ToolRow key={child.key} item={child} compact {...(workspace === undefined ? {} : { workspace })} />
        ))}
      </div>,
    )
  const failure = failureLine(item)
  if (failure !== undefined) parts.push(<div key="error" className="tool-error" role="alert">{failure}</div>)
  if (item.output !== undefined && item.output.length > 0 && diff === undefined && p.kind !== "plan") parts.push(<Output key="out" text={item.output} {...(p.kind === "read" ? { label: "Content" } : {})} />)
  const paths = p.path !== undefined ? [p.path] : (p.paths ?? [])
  if (workspace !== undefined && paths.length > 0 && (p.kind === "read" || p.kind === "write" || p.kind === "edit" || p.kind === "patch"))
    parts.push(
      <div key="files" className="tool-files">
        {paths.slice(0, 12).map((path) => (
          <button key={path} type="button" className="chip" onClick={() => previewToolFile(item, workspace, path)} onContextMenu={(event) => openFileMenu(event, workspace, path)} title={`${p.kind === "read" ? "Open" : "View changes to"} ${path}. Right-click for more.`}>
            {basename(path)}
          </button>
        ))}
      </div>,
    )
  if (parts.length === 0) parts.push(<div key="none" className="muted tool-none">{item.status === "running" ? "Running…" : "No output"}</div>)
  return <div className="tool-body">{parts}</div>
}

export function previewToolFile(item: ToolItem, workspace: string, path: string): void {
  const p = item.presentation
  if (p.kind === "read") return previewWorkspaceFile(workspace, path)
  const paths = p.path === undefined ? (p.paths ?? []) : [p.path]
  const diff = editDiff(item)
  const change = diff !== undefined && paths.length === 1 && (p.kind !== "write" || item.created === true) ? { lines: diff } : p.kind === "patch" && paths.length === 1 && looksLikePatch(p.content) ? { patch: p.content } : undefined
  previewWorkspaceChanges(workspace, path, change)
}

/** A delegated subagent: its own nested tool calls and final report, collapsed by default. */
export type AgentChildItem = ToolItem | AssistantItem | ReasoningItem

export function AgentTranscript({ items, parentCallId, workspace }: { readonly items: readonly AgentChildItem[]; readonly parentCallId: string; readonly workspace?: string }) {
  return <>{items.filter((child) => child.parentCallId === parentCallId).map((child) => child.kind === "assistant" ? (
    <div key={child.key} className="agent-report"><Markdown text={child.text} {...(workspace === undefined ? {} : { workspace })} /></div>
  ) : child.kind === "reasoning" ? (
    <ReasoningRow key={child.key} item={child} />
  ) : child.agent !== undefined || child.presentation.kind === "agent" ? (
    <AgentRow key={child.key} item={child} childItems={items.filter((entry) => entry.key !== child.key)} {...(workspace === undefined ? {} : { workspace })} />
  ) : <ToolRow key={child.key} item={child} compact {...(workspace === undefined ? {} : { workspace })} />)}</>
}

export const AgentRow = memo(function AgentRow({ item, childItems, workspace }: { readonly item: ToolItem; readonly childItems: readonly AgentChildItem[]; readonly workspace?: string }) {
  const [open, setOpen] = useState(false)
  const running = (item.agentStatus ?? item.status) === "running"
  const current = running ? [...childItems].reverse().find((child): child is ToolItem => child.kind === "tool" && child.status === "running") : undefined
  const title = item.agent?.title ?? item.presentation.title
  const failure = failureLine(item)
  return (
    <div className={cx("row-agent", running && "is-running", item.status === "failed" && "is-failed")}>
      <button type="button" className="agent-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon kind-agent">
          <Bot size={13} />
        </span>
        <span className="agent-type">{item.agent?.agentType ?? "Subagent"}</span>
        <span className="tool-title">{title}</span>
        <span className="tool-detail">{current === undefined ? plural(childItems.length, "step") : firstLine(current.presentation.title, 80)}</span>
        <span className="tool-status">
          {running ? <Spinner size={12} /> : item.status === "failed" ? <FailedStatus code={item.errorCode} /> : item.endedAt === undefined ? null : <span className="muted">{duration(item.endedAt - item.at)}</span>}
        </span>
        <span className="tool-chevron">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
      </button>
      {open && (
        <div className="agent-body">
          {childItems.length === 0 ? (
            <div className="muted tool-none">{running ? "Starting…" : "No tool calls"}</div>
          ) : (
            <AgentTranscript items={childItems} parentCallId={item.callId} {...(workspace === undefined ? {} : { workspace })} />
          )}
          {failure !== undefined && <div className="tool-error" role="alert">{failure}</div>}
          {item.output !== undefined && item.output.length > 0 && (
            <div className="agent-report">
              <Markdown text={item.output} {...(workspace === undefined ? {} : { workspace })} />
            </div>
          )}
        </div>
      )}
    </div>
  )
})

const OUTCOMES: Readonly<Record<CommandIntent, readonly [passed: string, failed: string]>> = {
  test: ["tests passed", "tests failed"],
  build: ["build passed", "build failed"],
  lint: ["lint passed", "lint failed"],
  typecheck: ["types passed", "types failed"],
  commit: ["committed", "commit failed"],
  push: ["pushed", "push failed"],
  pr: ["opened a PR", "PR failed"],
}

export interface StepsSummary {
  readonly text: string
  /** The latest result of each kind of check or commit in the run, in the order each first ran. */
  readonly outcomes: readonly { readonly label: string; readonly ok: boolean }[]
  /** Calls that failed and are not a check or commit, which an outcome already reports. */
  readonly failed: number
  readonly additions: number
  readonly deletions: number
  /** The kinds of call in the run, in the order each first appears. */
  readonly kinds: readonly ToolKind[]
}

function times(count: number): string {
  return count === 1 ? "once" : count === 2 ? "twice" : `${String(count)} times`
}

export function stepsSummary(items: readonly ToolItem[]): StepsSummary {
  let commands = 0
  let reads = 0
  let searches = 0
  let web = 0
  let tools = 0
  let unnamed = 0
  let additions = 0
  let deletions = 0
  let failed = 0
  const edited = new Set<string>()
  const outcomes = new Map<CommandIntent, boolean>()
  const kinds = new Set<ToolKind>()
  for (const item of items) {
    const p = item.presentation
    kinds.add(p.kind)
    if (p.kind === "shell" || p.kind === "verify") commands += 1
    else if (p.kind === "read") reads += 1
    else if (p.kind === "search" || p.kind === "list") searches += 1
    else if (p.kind === "web") web += 1
    else if (p.kind === "write" || p.kind === "edit" || p.kind === "patch") {
      const paths = p.path !== undefined ? [p.path] : (p.paths ?? [])
      if (paths.length === 0) unnamed += 1
      for (const path of paths) edited.add(path)
      const counts = toolCounts(item, editDiff(item))
      additions += counts?.additions ?? 0
      deletions += counts?.deletions ?? 0
    } else tools += 1
    if (item.status === "running" || (item.errorCode !== undefined && STOP_CODES.has(item.errorCode))) continue
    if (p.intent !== undefined) outcomes.set(p.intent, item.status !== "failed")
    else if (item.status === "failed") failed += 1
  }
  const clauses = [
    commands > 0 && `ran ${plural(commands, "command")}`,
    reads > 0 && `read ${plural(reads, "file")}`,
    searches > 0 && `searched ${times(searches)}`,
    web > 0 && `made ${plural(web, "web lookup")}`,
    edited.size + unnamed > 0 && `edited ${plural(edited.size + unnamed, "file")}`,
    tools > 0 && `used ${plural(tools, "tool")}`,
  ].filter((clause): clause is string => clause !== false)
  const text = clauses.join(", ")
  return {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    outcomes: [...outcomes].map(([intent, ok]) => ({ label: OUTCOMES[intent][ok ? 0 : 1], ok })),
    failed,
    additions,
    deletions,
    kinds: [...kinds],
  }
}

/** A run of tool calls folded into one line that says what it did and how its checks went; it opens to each call's row. */
export const StepsGroup = memo(function StepsGroup({
  items,
  approved,
  open,
  onToggle,
  workspace,
}: {
  readonly items: readonly ToolItem[]
  readonly approved: ReadonlySet<string>
  readonly open: boolean
  readonly onToggle: () => void
  readonly workspace?: string
}) {
  let running: ToolItem | undefined
  for (const item of items) if (item.status === "running") running = item
  const now = useTicker(running !== undefined)
  const summary = stepsSummary(items)
  return (
    <div className={cx("row-steps", open && "is-open")}>
      <button type="button" className="disclosure steps-head" onClick={onToggle} aria-expanded={open}>
        {running !== undefined ? (
          <Spinner size={12} />
        ) : (
          <span className="steps-icons" aria-hidden="true">
            {summary.kinds.slice(0, 3).map((kind) => (
              <span key={kind} className={cx("tool-icon", `kind-${kind}`)}>
                {KIND_ICON[kind](11)}
              </span>
            ))}
          </span>
        )}
        {running !== undefined ? (
          <>
            <span className="shimmer">{toolTitle(running)}</span>
            <span className="steps-meta">
              {duration(Math.max(0, now - running.at))} · {plural(items.length, "step")}
            </span>
          </>
        ) : (
          <>
            <span>{summary.text}</span>
            {(summary.additions > 0 || summary.deletions > 0) && (
              <span className="tool-counts">
                <span className="add">+{summary.additions}</span> <span className="del">-{summary.deletions}</span>
              </span>
            )}
          </>
        )}
        {summary.outcomes.map((outcome) => (
          <span key={outcome.label} className={cx("steps-outcome", outcome.ok ? "is-ok" : "is-failed")}>
            {outcome.label}
          </span>
        ))}
        {summary.failed > 0 && <span className="steps-outcome is-failed">{String(summary.failed)} failed</span>}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="steps-items">
          {items.map((item) => (
            <ToolRow key={item.key} item={item} compact approved={approved.has(item.key)} {...(workspace === undefined ? {} : { workspace })} />
          ))}
        </div>
      )}
    </div>
  )
})

const CAPABILITY_LABELS: Record<string, string> = {
  "filesystem.write": "Write files",
  "filesystem.read": "Read files",
  "fs.write": "Write files",
  "fs.read": "Read files",
  write: "Write files",
  read: "Read files",
  process: "Run a command",
  "process.exec": "Run a command",
  shell: "Run a command",
  "shell.exec": "Run a command",
  network: "Use the network",
  "net.fetch": "Use the network",
  "connector.read": "Read from a connected service",
  "connector.search": "Search a connected service",
  "connector.write": "Change a connected service",
  "connector.notify": "Send a notification",
  "sandbox.permission": "Allow wider access",
  mcp: "Call an MCP tool",
}

/** Why a message did not go: the engine's words when it gave some, else its code. */
export function notSent(item: Pick<UserItem, "errorCode" | "errorMessage">): string {
  const words = item.errorMessage?.trim()
  // An older engine words every failure the same way; its code says more.
  if (words !== undefined && words.length > 0 && words !== "control operation failed") return `Not sent: ${words}`
  return item.errorCode === undefined ? "Not sent" : `Not sent (${item.errorCode})`
}

/** Short question for an approval, e.g. "Run a command?". */
export function approvalQuestion(item: ApprovalItem): string {
  const [first, ...rest] = item.questions ?? []
  // A coding tool's question leads with what it asks, not with a permission.
  if (first !== undefined) return rest.length === 0 ? first.question : `${first.question} (and ${String(rest.length)} more)`
  if (item.action === "plan") return "Start on this plan?"
  if (isQuestion(item) && item.reason !== undefined) return visibleText(item.reason)
  return `${CAPABILITY_LABELS[item.capability] ?? "Allow this action"}?`
}

/** The engine's words for a kind of approval, not for what is being approved. */
const ACTION_KINDS: ReadonlySet<string> = new Set(["command", "file_change", "permission", "plan"])

/** A reason as a tool's call names it: "Bash: npm test" is Bash and the command. */
export function reasonParts(reason: string | undefined): { readonly tool: string; readonly detail: string } | undefined {
  const match = reason === undefined ? null : /^([A-Za-z][\w.-]{0,63}): (\S[\s\S]*)$/.exec(reason)
  return match === null ? undefined : { tool: match[1] ?? "", detail: match[2] ?? "" }
}

/**
 * What is being approved: the action when it names one, else the command, file, or address the
 * reason names. Never the action's kind ("command"), nor only the tool's name the call row shows.
 */
/** The plan a coding tool asks to carry out (Claude Code's ExitPlanMode), as markdown; not a step list. */
export function proposedPlan(item: Pick<ToolItem, "presentation">): string | undefined {
  const p = item.presentation
  return p.kind === "plan" && p.plan === undefined && p.content !== undefined && p.content.trim().length > 0 ? p.content : undefined
}

export function approvalDetail(item: Pick<ApprovalItem, "action" | "reason" | "questions"> & { readonly capability?: string }, gate: Pick<ToolItem, "name"> | undefined): string | undefined {
  if (isQuestion(item)) return undefined
  const action = item.action.trim()
  if (action.length > 0 && action !== gate?.name && !ACTION_KINDS.has(action)) return visibleText(action)
  const detail = reasonParts(item.reason)?.detail
  return detail === undefined ? undefined : visibleText(detail)
}

/** The reason line under the detail, unless the detail already says it. */
export function approvalReasonLine(item: Pick<ApprovalItem, "action" | "reason" | "questions"> & { readonly capability?: string }, detail: string | undefined): string | undefined {
  if (item.reason === undefined || isQuestion(item)) return undefined
  const fromReason = reasonParts(item.reason)?.detail
  return detail !== undefined && fromReason !== undefined && visibleText(fromReason) === detail ? undefined : visibleText(item.reason)
}

/**
 * Controls other than line breaks and tabs, bidirectional overrides, and zero-width characters,
 * written out as `\u{202E}`: a right-to-left override can make a destructive command read as a safe one.
 */
export function visibleText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`)
}

export interface ApprovalKeyTarget {
  readonly tagName?: string
  readonly isContentEditable?: boolean
  readonly closest?: (selectors: string) => unknown
}

export interface ApprovalKeyPress {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly isComposing: boolean
  readonly defaultPrevented: boolean
  readonly target: ApprovalKeyTarget | null
}

/**
 * What mod+Enter (approve) or mod+Shift+Enter (deny) answers for the thread's approval. Never a
 * held key, a press in the first moments the card is up, or one typed in a field other than the
 * composer (which keeps the keys while it has text to send).
 */
export function approvalShortcut(event: ApprovalKeyPress, shownFor: number): "approve" | "deny" | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.key !== "Enter" || event.altKey || !(event.metaKey || event.ctrlKey)) return undefined
  if (shownFor < APPROVAL_SETTLE_MS) return undefined
  const target = event.target
  const tag = target?.tagName?.toUpperCase()
  const field = target?.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
  if (field && target?.closest?.(".composer-dock") == null) return undefined
  return event.shiftKey ? "deny" : "approve"
}

export const ApprovalCard = memo(function ApprovalCard({ item, threadId, gate, primary }: { readonly item: ApprovalItem; readonly threadId: string; readonly gate?: ToolItem; readonly primary: boolean }) {
  const [busy, setBusy] = useState<"approve" | "session" | "deny" | undefined>()
  const [feedback, setFeedback] = useState<string | undefined>()
  const detail = approvalDetail(item, gate)
  const reasonLine = approvalReasonLine(item, detail)
  const plan = gate === undefined ? undefined : proposedPlan(gate)
  const tool = reasonLine === undefined ? reasonParts(item.reason)?.tool : undefined
  const session = offersSessionApproval(threadId)
  // A question whose choices did not arrive is still a question: only the person's answer settles it, so it is never approved.
  const question = isQuestion(item)
  const armed = primary && item.status === "pending" && feedback === undefined && busy === undefined
  // The keys shown on the buttons, while nothing covers the thread.
  useEffect(() => {
    if (!armed) return
    const armedAt = Date.now()
    const key = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const answer = approvalShortcut({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing, defaultPrevented: event.defaultPrevented, target }, Date.now() - armedAt)
      if (answer === undefined || (question && answer === "approve")) return
      const state = get()
      if (state.dialog !== undefined || state.settings !== false || state.palette || useOverlays.getState().length > 0) return
      event.preventDefault()
      const approved = answer === "approve"
      setBusy(approved ? "approve" : "deny")
      void resolveApproval(threadId, item.approvalId, approved).then(() => setBusy(undefined))
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [armed, question, threadId, item.approvalId])
  // A question the stop cut short was never answered: it is neither a denial nor a second "Stopped".
  const unanswered = item.status === "rejected" && (item.withdrawn === true || (gate?.errorCode !== undefined && STOP_CODES.has(gate.errorCode)))
  if (item.status !== "pending") {
    const done = (
      <div className={cx("row-approval-done", item.status === "approved" ? "is-approved" : unanswered ? "is-unanswered" : "is-rejected")}>
        {item.status === "approved" ? <ShieldCheck size={13} /> : unanswered ? <ShieldAlert size={13} /> : <ShieldX size={13} />}
        <span>{item.status === "approved" ? "Approved" : item.withdrawn === true ? "Withdrawn" : unanswered ? "Not answered" : ((gate?.errorCode === undefined ? undefined : FAILURE_LABELS[gate.errorCode]) ?? "Denied")}</span>
        {detail !== undefined && <span className="muted">{firstLine(detail, 100)}</span>}
      </div>
    )
    return item.denial === undefined ? done : (
      <div className="row-approval-denied">
        {done}
        <div className="approval-denial">{visibleText(item.denial)}</div>
      </div>
    )
  }
  const decide = async (approved: boolean, reason?: string, scope?: "session"): Promise<void> => {
    setBusy(scope === "session" ? "session" : approved ? "approve" : "deny")
    await resolveApproval(threadId, item.approvalId, approved, reason, scope)
    setBusy(undefined)
  }
  return (
    <div className="row-approval" role="group" aria-label="Approval needed" data-primary-approval={primary ? "true" : undefined}>
      <div className="approval-head">
        <ShieldAlert size={15} />
        <span className="approval-title">{approvalQuestion(item)}</span>
        {tool !== undefined && <span className="approval-tool">{tool}</span>}
      </div>
      {gate !== undefined && (
        <div className="approval-gate">
          <ToolSummary item={gate} asking />
        </div>
      )}
      {plan !== undefined && (
        <div className="approval-plan">
          <Markdown text={plan} />
        </div>
      )}
      {detail !== undefined && <pre className="approval-action">{detail}</pre>}
      {reasonLine !== undefined && <div className="approval-reason">{reasonLine}</div>}
      {question && item.status === "pending" ? (
        <div className="approval-actions">
          <span className="muted">Runrail could not show this question's choices. Decline it, and the agent asks in its reply instead.</span>
          <Button size="sm" loading={busy === "deny"} disabled={busy !== undefined} onClick={() => void decide(false, "Ask this in your reply")} {...(primary ? { kbd: "mod+shift+enter" } : {})}>
            Decline
          </Button>
        </div>
      ) : feedback === undefined ? (
        <div className="approval-actions">
          <Button variant="primary" size="sm" loading={busy === "approve"} disabled={busy !== undefined} onClick={() => void decide(true)} {...(primary ? { kbd: "mod+enter" } : {})}>
            Approve
          </Button>
          {session && (
            <Button size="sm" loading={busy === "session"} disabled={busy !== undefined} title="Claude Code allows calls like this one for the rest of the session, by the rule it suggests" onClick={() => void decide(true, undefined, "session")}>
              Allow for this session
            </Button>
          )}
          <Button size="sm" loading={busy === "deny"} disabled={busy !== undefined} onClick={() => void decide(false)} {...(primary ? { kbd: "mod+shift+enter" } : {})}>
            {item.action === "plan" ? "Keep planning" : "Deny"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => setFeedback("")}>
            Deny with feedback…
          </Button>
        </div>
      ) : (
        <div className="approval-feedback">
          <input
            autoFocus
            value={feedback}
            maxLength={2_000}
            placeholder="Tell the agent what to do instead"
            aria-label="Feedback for the agent"
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && feedback.trim().length > 0) void decide(false, feedback.trim())
              if (event.key === "Escape") setFeedback(undefined)
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => setFeedback(undefined)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" disabled={feedback.trim().length === 0 || busy !== undefined} loading={busy === "deny"} onClick={() => void decide(false, feedback.trim())}>
            Deny
          </Button>
        </div>
      )}
    </div>
  )
})

/** Who decided a call without asking the person: Codex's reviewer, or Claude Code's auto mode, a rule, or its mode. */
function reviewWho(item: ReviewItem): string {
  if (item.reviewer === "codex") return "Codex's reviewer"
  if (item.source === "reviewer") return "Claude Code's auto mode"
  if (item.source === "rule") return "A Claude Code rule"
  if (item.source === "mode") return "Claude Code's mode"
  return "Claude Code"
}

const REVIEW_VERB: Record<ReviewItem["decision"], string> = {
  reviewing: "is checking",
  approved: "approved",
  denied: "denied",
  "timed-out": "ran out of time on",
  aborted: "stopped checking",
}

const REVIEW_TARGET: Readonly<Record<string, string>> = {
  "process.exec": "a command",
  "filesystem.write": "a file change",
  "network.request": "a network request",
  "sandbox.permission": "wider access",
}

/** E.g. "Codex's reviewer approved" when the row names the call, "... approved a command" when it cannot. */
export function reviewTitle(item: ReviewItem): string {
  const lead = `${reviewWho(item)} ${REVIEW_VERB[item.decision]}`
  return item.detail === undefined ? `${lead} ${REVIEW_TARGET[item.capability] ?? "a tool call"}` : lead
}

export const ReviewRow = memo(function ReviewRow({ item }: { readonly item: ReviewItem }) {
  const tone = item.decision === "approved" ? "is-approved" : item.decision === "denied" ? "is-rejected" : "is-unanswered"
  // An approval's reasons stay a hover away; a call that did not run says why under it.
  const why = item.decision === "approved" || item.decision === "reviewing" ? undefined : item.rationale
  return (
    <div className="row-review">
      <div className={cx("row-approval-done", tone)} title={item.rationale}>
        {item.decision === "reviewing" ? <Spinner size={13} /> : item.decision === "approved" ? <ShieldCheck size={13} /> : item.decision === "denied" ? <ShieldX size={13} /> : <ShieldAlert size={13} />}
        <span>{reviewTitle(item)}</span>
        {item.detail !== undefined && <span className="muted review-detail">{firstLine(item.detail, 120)}</span>}
        {item.risk !== undefined && item.decision !== "reviewing" && <span className={cx("pill", item.risk === "low" ? "is-muted" : item.risk === "medium" ? "is-warn" : "is-error")}>{item.risk} risk</span>}
      </div>
      {why !== undefined && <div className="review-why">{why}</div>}
    </div>
  )
})

export function PlanSteps({ steps }: { readonly steps: readonly PlanStep[] }) {
  return (
    <ol className="plan-steps">
      {steps.map((step, index) => (
        <li key={index} className={cx("plan-step", `is-${step.status}`)}>
          {step.status === "completed" ? <CircleCheck size={13} /> : step.status === "in_progress" ? <CircleDot size={13} /> : <Circle size={13} />}
          <span>{step.text}</span>
        </li>
      ))}
    </ol>
  )
}

/** The running turn's plan, pinned above the composer; the step in progress shows when folded. */
export function LivePlan({ steps, explanation }: { readonly steps: readonly PlanStep[]; readonly explanation?: string }) {
  const [open, setOpen] = useState(true)
  const done = steps.filter((step) => step.status === "completed").length
  const current = steps.find((step) => step.status === "in_progress") ?? steps.find((step) => step.status === "pending")
  return (
    <div className={cx("live-plan", open && "is-open")} role="status" aria-label="Plan">
      <button type="button" className="live-plan-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ListChecks size={13} />
        <span className="live-plan-count">
          {done} of {steps.length}
        </span>
        <span className="live-plan-current">{open ? (explanation ?? "Plan") : (current?.text ?? "Plan done")}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <PlanSteps steps={steps} />}
    </div>
  )
}

export const PlanCard = memo(function PlanCard({ item }: { readonly item: PlanItem }) {
  const done = item.steps.filter((step) => step.status === "completed").length
  return (
    <div className="row-plan">
      <div className="plan-head">
        <ListChecks size={14} />
        <span>Plan</span>
        <span className="muted">
          {done} of {item.steps.length} done
        </span>
        <span className="plan-progress" aria-hidden>
          <span style={{ width: `${String(item.steps.length === 0 ? 0 : Math.round((done / item.steps.length) * 100))}%` }} />
        </span>
      </div>
      {item.explanation !== undefined && <div className="plan-explanation">{item.explanation}</div>}
      <PlanSteps steps={item.steps} />
    </div>
  )
})

/** The engine names its verification gates `check`, `test`, and `assure`; any other name is shown as given. */
export function gateLabel(name: string | undefined): string {
  if (name === undefined || name === "check") return "Checks"
  if (name === "test") return "Tests"
  if (name === "assure") return "Assurance checks"
  return `Checks (${name})`
}

function turnCount(turns: number): string {
  return `${String(turns)} new turn${turns === 1 ? "" : "s"}`
}

const RETRY_CAUSE: Readonly<Record<string, string>> = {
  overloaded: "the API was overloaded",
  server_error: "the API had a server error",
  billing_error: "the account has a billing problem",
  invalid_request: "the API refused the request",
  model_not_found: "the API did not find the model",
  max_output_tokens: "the reply hit its output limit",
  cloud_credential_error: "the cloud credentials failed",
  oauth_org_not_allowed: "the organization is not allowed",
  account_on_hold: "the account is on hold",
  verification_required: "the account needs verifying",
}

function retryCopy(retry: ApiRetry): string {
  const cause = retry.waitedMs !== undefined
    ? `the API sent nothing for ${duration(retry.waitedMs)}`
    : ((retry.error === undefined ? undefined : RETRY_CAUSE[retry.error]) ?? (retry.status === undefined ? "the request got no answer" : "the request failed"))
  const status = retry.status === undefined ? "" : ` (status ${String(retry.status)})`
  const when = retry.delayMs === 0 ? "at once" : `after ${duration(retry.delayMs)}`
  return `Claude Code retried ${when}, attempt ${String(retry.attempt)} of ${String(Math.max(retry.attempt, retry.maxRetries))}: ${cause}${status}.`
}

export function noticeCopy(item: NoticeItem): string {
  switch (item.code) {
    case "ENGINE_EXITED":
      return "The agent process stopped before the turn finished."
    case "stopped":
      return "Stopped"
    case "compacted": {
      const lead = item.name === "threshold" ? "Context was nearly full, so it was compacted" : "Context compacted"
      return item.sizes === undefined ? `${lead} to make room for more work.` : `${lead}: ${tokens(item.sizes.before)} to ${tokens(item.sizes.after)} tokens.`
    }
    case "verification.passed":
      return `${gateLabel(item.name)} passed`
    case "verification.failed":
      return `${gateLabel(item.name)} failed`
    case "repair.required":
      return `Repair needed${item.message === undefined ? "" : `: ${item.message}`}`
    case "session.imported":
      return item.inTool === true
        ? `Imported from ${item.name ?? "another tool"}. New turns continue a copy of that session in ${item.name ?? "the tool"}, with its own context; the original is left as it was.`
        : `Imported from ${item.name ?? "another tool"}. New turns continue on Runrail with this history as context.`
    case "session.refreshed":
      return `Brought in ${turnCount(item.turns ?? 1)} the session gained in ${item.name ?? "its tool"} since the import.`
    case "session.continued":
      return "Continued here from another thread. The conversation above came along."
    case "model.changed":
      return item.message ?? "Model changed for the next turn."
    case "session.rewound":
      return "The thread went back to here. The turns that followed are in a copy in Archived."
    case "extensions.reloaded":
      return item.level === "error" ? "Extension reload failed and was rolled back." : "Extensions reloaded."
    case API_RETRY:
      return item.retry === undefined ? "Claude Code retried a request." : retryCopy(item.retry)
    case "reviewer.unavailable":
      return item.name === "claude-code"
        ? "Claude Code's auto mode is not available here (the model, its settings, or fast mode), so Runrail asks you instead."
        : "Codex did not turn on its reviewer, so Runrail asks you instead."
    case "reviewer.warning":
      return item.message === undefined ? "Codex's reviewer sent a warning." : `Codex's reviewer: ${item.message}`
    case "thinking.refused": {
      const level = item.name !== undefined && item.name in THINKING_NAME ? THINKING_NAME[item.name as keyof typeof THINKING_NAME] : undefined
      if (item.name === "off") return "The model cannot turn reasoning off, so this turn ran without that setting."
      return `The model refused ${level ?? "this"} reasoning, so this turn ran without a level. The level is hidden for this model.`
    }
    default:
      return item.message ?? (item.level === "error" ? `Something went wrong (${item.code})` : item.code)
  }
}

export const NoticeRow = memo(function NoticeRow({ item, threadId }: { readonly item: NoticeItem; readonly threadId: string }) {
  if (isLimitNotice(item)) return <LimitCard item={item} threadId={threadId} />
  return <PlainNotice item={item} threadId={threadId} />
})

/**
 * A usage limit: when it resets, and, until a message follows, a way to continue
 * then without coming back for it.
 */
function LimitCard({ item, threadId }: { readonly item: NoticeItem; readonly threadId: string }) {
  const open = useApp((state) => openLimit(state.runtime[threadId]?.timeline.items ?? [])?.key === item.key)
  const resume = useApp((state) => state.threads.find((thread) => thread.id === threadId)?.resume)
  const always = useApp((state) => state.prefs.continueAfterLimit)
  const now = useTicker(open, 30_000)
  const { text } = readLimitMessage(item.message)
  const resetAt = limitReset(threadId, item, now)
  const passed = resetAt !== undefined && resetAt <= now
  return (
    <div className="row-notice is-limit" role="status">
      <Hourglass size={13} />
      <div className="limit-body">
        <span>
          {text}
          {resetAt !== undefined && !passed && ` ${resetText(resetAt, now) ?? ""} (${clock(resetAt, now)}).`}
          {passed && " It has reset since."}
        </span>
        {open && (
          <div className="limit-actions">
            {resume !== undefined ? (
              <>
                <span className="limit-when">Continues {clock(resume.at, now)}.</span>
                <Button size="sm" variant="ghost" onClick={() => dropResume(threadId)}>
                  Don't continue
                </Button>
              </>
            ) : resetAt !== undefined && !passed ? (
              <Button size="sm" variant="secondary" onClick={() => continueAfterReset(threadId, item, resetAt)}>
                Continue when the limit resets
              </Button>
            ) : (
              <>
                {resetAt === undefined && <span className="limit-when">Runrail could not tell when it resets.</span>}
                <Button size="sm" variant="secondary" icon={<RotateCcw size={12} />} onClick={() => void resumeNow(threadId, repeatsMessage(threadId, item))}>
                  {passed ? "Continue now" : "Try again"}
                </Button>
              </>
            )}
            <label className="limit-always">
              <input
                type="checkbox"
                checked={always}
                onChange={(event) => {
                  setPrefs({ continueAfterLimit: event.target.checked })
                  if (event.target.checked && resume === undefined && resetAt !== undefined && !passed) continueAfterReset(threadId, item, resetAt)
                }}
              />
              Always continue after a limit resets
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

function PlainNotice({ item, threadId }: { readonly item: NoticeItem; readonly threadId: string }) {
  const [restarting, setRestarting] = useState(false)
  const icon =
    item.code === "verification.passed" ? (
      <ShieldCheck size={13} />
    ) : item.level === "error" ? (
      <TriangleAlert size={13} />
    ) : item.code === "session.imported" || item.code === "session.refreshed" ? (
      <Download size={12} />
    ) : item.code === "session.continued" ? (
      <CornerDownRight size={12} />
    ) : item.code === "session.rewound" ? (
      <History size={12} />
    ) : item.code === "stopped" ? (
      <Square size={11} />
    ) : item.code === "thinking.refused" ? (
      <Brain size={12} />
    ) : item.code === "compacted" ? (
      <Shrink size={12} />
    ) : item.code.startsWith("reviewer.") ? (
      <ShieldAlert size={12} />
    ) : item.code === "request.refused" ? (
      <ShieldX size={12} />
    ) : (
      <RefreshCw size={12} />
    )
  return (
    <div className={cx("row-notice", item.level === "error" ? "is-error" : "is-quiet", item.code === "verification.passed" && "is-ok")} role={item.level === "error" ? "alert" : undefined}>
      {icon}
      <span>{noticeCopy(item)}</span>
      {item.code === "ENGINE_EXITED" && (
        <Button
          size="sm"
          variant="ghost"
          loading={restarting}
          icon={<RotateCcw size={12} />}
          onClick={() => {
            setRestarting(true)
            void restartEngine(threadId).finally(() => setRestarting(false))
          }}
        >
          Restart agent
        </Button>
      )}
    </div>
  )
}

/**
 * The end of a turn. When the turn's work folded into a "Worked for" line above the answer, this
 * line only carries what changed and the checks, and is left out when there is neither.
 */
export const TurnEndRow = memo(function TurnEndRow({ item, changes, checks, folded = false }: { readonly item: TurnEndItem; readonly changes?: TurnChanges; readonly checks?: string; readonly folded?: boolean }) {
  const took = duration(item.endedAt - item.startedAt)
  const changed = changes !== undefined && changes.files > 0
  const run = item.backend === undefined && item.model === undefined && item.connectionId === undefined ? undefined : { backend: item.backend, model: item.model, connectionId: item.connectionId }
  if (folded && !changed && checks === undefined && run === undefined) return null
  // "Worked for 0s" reads as a fault; a turn under a second just worked.
  const quick = item.endedAt - item.startedAt < 1_000
  const cause = item.stopCause === "timeout" ? ": ran out of time" : item.stopCause === "closed" ? ": the session closed" : ""
  const verb = folded ? undefined : item.status === "completed" ? (quick ? "Done" : `Worked for ${took}`) : item.status === "failed" ? (quick ? "Failed" : `Failed after ${took}`) : `${quick ? "Stopped" : `Stopped after ${took}`}${cause}`
  return (
    <div className={cx("row-turn-end", `is-${item.status}`, folded && "is-folded")}>
      <span className="turn-end-line" aria-hidden />
      <span className="turn-end-text">
        {verb}
        {changed && (
          <>
            {verb === undefined ? "" : " · "}
            {plural(changes.files, "file")} changed <span className="add">+{changes.additions}</span> <span className="del">-{changes.deletions}</span>
          </>
        )}
        {run !== undefined && <span className="turn-end-model">{verb === undefined || changed ? " · " : ""}{runLabel(run)}</span>}
      </span>
      {changed && (
        <Button size="sm" variant="ghost" onClick={() => openPanelHere("review")}>
          Review
        </Button>
      )}
      {checks !== undefined && (
        <span className="turn-end-checks">
          <CircleCheck size={12} aria-hidden />
          {checks}
        </span>
      )}
      <span className="turn-end-line" aria-hidden />
    </div>
  )
})
