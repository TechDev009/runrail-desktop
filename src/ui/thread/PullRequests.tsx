import { CircleCheck, CircleDashed, CircleMinus, CircleX, Copy, ExternalLink, GitMerge, GitPullRequest, RefreshCw, Wrench } from "lucide-react"
import { useEffect, useState } from "react"
import { openUrl } from "../../app/actions"
import { fixFailingChecks, MAX_WATCH_ROUNDS, mergeWhenGreen, watchChecks } from "../../app/ciFix"
import { connectGitHubCli, gitHubCliStatus, gitHubHostOf, refreshPullRequests } from "../../app/gitBar"
import { keepPolling, PR_POLL_MS, prChip, type PrChip, type PrTone } from "../../app/prStatus"
import { threadOnScreen, toast, useApp } from "../../app/store"
import { pullRequestsOffered } from "../../app/gitHosts"
import { toHostError } from "../../host"
import { hasCapability, type CodeHostStatus, type PullRequestStatusEntry } from "../../protocol/schemas"
import { Button, cx, Popover, Spinner } from "../common"
import { useGit, useProject, useThread } from "../hooks"
import { PrDialog } from "../inspector/ReviewPane"
import { openProjectSettings } from "../shell/revealSetting"

/** The thread bar's pull request chip: status, the popover with checks, Create PR, or Connect GitHub. */

const REVIEW_TEXT: Readonly<Record<NonNullable<PullRequestStatusEntry["review"]>, string>> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  required: "Review required",
  none: "No review yet",
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible")
  useEffect(() => {
    const change = (): void => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", change)
    return () => document.removeEventListener("visibilitychange", change)
  }, [])
  return visible
}

/** One 60-second read at a time per thread, while a check runs and the thread is on screen. */
function usePullRequestPolling(threadId: string): void {
  const view = useGit(threadId).pr
  const selected = useApp((state) => threadOnScreen(state) === threadId)
  const visible = useDocumentVisible()
  const onScreen = selected && visible
  useEffect(() => {
    if (!keepPolling({ view, onScreen, now: Date.now() })) return
    const timer = setTimeout(() => void refreshPullRequests(threadId, "poll"), PR_POLL_MS)
    return () => clearTimeout(timer)
  }, [threadId, view, onScreen])
}

export function PullRequestChip({ threadId }: { readonly threadId: string }) {
  const thread = useThread(threadId)
  const project = useProject(thread?.projectId)
  const git = useGit(threadId)
  const [creating, setCreating] = useState(false)
  const branch = git.status?.branch ?? undefined
  usePullRequestPolling(threadId)

  // Opening the thread reads its PRs at most once per five minutes per branch.
  useEffect(() => {
    if (branch !== undefined) void refreshPullRequests(threadId, "open")
  }, [threadId, branch])

  const offered = project?.connectedTo === undefined || pullRequestsOffered(project.connectedTo)
  const chip = prChip({ view: git.pr, branch, published: git.status?.upstream != null, offered, now: Date.now() })
  if (chip === undefined) return null
  if (chip.kind === "create")
    return (
      <>
        <button type="button" className="bar-pr is-create" onClick={() => setCreating(true)}>
          <GitPullRequest size={12} />
          Create PR
        </button>
        {creating && <PrDialog threadId={threadId} onClose={() => setCreating(false)} onCreated={() => setCreating(false)} />}
      </>
    )
  if (chip.kind === "connect") return <ConnectGitHub threadId={threadId} />
  return <PullRequestPopover threadId={threadId} chip={chip} />
}

function PullRequestPopover({ threadId, chip }: { readonly threadId: string; readonly chip: PrChip & { readonly kind: "pr" } }) {
  const loading = useGit(threadId).pr?.state === "loading"
  return (
    <Popover
      side="top"
      width={340}
      room={320}
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          className={cx("bar-pr", `tone-${chip.tone}`, open && "is-active")}
          title={chip.pull.title}
          onClick={() => {
            if (!open) void refreshPullRequests(threadId, "click")
            toggle()
          }}
        >
          <GitPullRequest size={12} />
          <span>{chip.label}</span>
          {chip.checks !== undefined && <span className={cx("bar-pr-checks", `tone-${chip.checks.tone}`)}>· {chip.checks.text}</span>}
          {chip.notes.map((note) => (
            <span key={note.text} className={cx("bar-pr-note", `tone-${note.tone}`)}>
              · {note.text}
            </span>
          ))}
        </button>
      )}
    >
      {(close) => <PullRequestDetails threadId={threadId} pull={chip.pull} loading={loading} onDialog={close} />}
    </Popover>
  )
}

const CHECK_ICONS: Readonly<Record<"passed" | "failed" | "pending" | "skipped", { readonly icon: typeof CircleCheck; readonly tone: PrTone }>> = {
  failed: { icon: CircleX, tone: "red" },
  pending: { icon: CircleDashed, tone: "amber" },
  passed: { icon: CircleCheck, tone: "green" },
  skipped: { icon: CircleMinus, tone: "gray" },
}

/** What the popover and the thread's PR card show: read-only, merging stays on GitHub. */
export function PullRequestDetails({ threadId, pull, loading = false, card = false, onDialog }: { readonly threadId: string; readonly pull: PullRequestStatusEntry; readonly loading?: boolean; readonly card?: boolean; readonly onDialog?: () => void }) {
  const state = pull.state === "merged" ? "Merged" : pull.state === "closed" ? "Closed" : pull.draft === true ? "Draft" : "Open"
  const checks = pull.checks?.items ?? []
  return (
    <div className={cx("pr-details", card && "is-card")}>
      <div className="pr-details-head">
        <GitPullRequest size={14} className={cx("pr-state", `state-${state.toLowerCase()}`)} />
        <div className="pr-details-title">
          <div className="pr-details-name">
            {pull.title ?? "Pull request"} <span className="muted">#{pull.number}</span>
          </div>
          <div className="pr-details-meta">
            {state}
            {pull.base !== undefined && pull.head !== undefined && (
              <>
                {" · "}
                <code>{pull.base}</code> ← <code>{pull.head}</code>
              </>
            )}
            {pull.review !== undefined && pull.state === "open" && ` · ${REVIEW_TEXT[pull.review]}`}
            {pull.mergeable === "conflicts" && pull.state === "open" && " · Conflicts with base"}
          </div>
        </div>
      </div>
      {checks.length > 0 && (
        <ul className="pr-checks">
          {checks.map((check, index) => {
            const { icon: Icon, tone } = CHECK_ICONS[check.state]
            return (
              <li key={`${check.name}:${String(index)}`}>
                <button type="button" className="pr-check" disabled={check.url === undefined} onClick={() => check.url !== undefined && void openUrl(check.url)} title={check.url === undefined ? check.name : `Open ${check.name}`}>
                  <Icon size={12} className={`tone-${tone}`} />
                  <span className="pr-check-name">{check.name}</span>
                  {check.url !== undefined && <ExternalLink size={11} className="muted" />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {!card && pull.state === "open" && <CiActions threadId={threadId} pull={pull} {...(onDialog === undefined ? {} : { onDialog })} />}
      <div className="pr-details-actions">
        {pull.url !== undefined && (
          <Button size="sm" variant="secondary" icon={<ExternalLink size={12} />} onClick={() => pull.url !== undefined && void openUrl(pull.url)}>
            Open on GitHub
          </Button>
        )}
        {pull.url !== undefined && (
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => pull.url !== undefined && void navigator.clipboard.writeText(pull.url).then(() => toast("success", "Link copied"))}>
            Copy link
          </Button>
        )}
        {!card && (
          <Button size="sm" variant="ghost" icon={loading ? <Spinner size={11} /> : <RefreshCw size={12} />} onClick={() => void refreshPullRequests(threadId, "click")}>
            Refresh
          </Button>
        )}
      </div>
    </div>
  )
}

/** Fixing CI from the chip: once, or for each new failure while watched; and auto-merge. */
function CiActions({ threadId, pull, onDialog }: { readonly threadId: string; readonly pull: PullRequestStatusEntry; readonly onDialog?: () => void }) {
  const contract = useApp((state) => state.runtime[threadId]?.contract)
  const watch = useThread(threadId)?.ciWatch
  const [fixing, setFixing] = useState(false)
  const readsLogs = hasCapability(contract, "git.pr.checks")
  const merges = hasCapability(contract, "git.pr.merge")
  const checks = pull.checks
  const failing = (checks?.failed ?? 0) > 0
  const green = checks !== undefined && checks.failed === 0 && checks.pending === 0
  const watching = watch?.number === pull.number
  if (!readsLogs && !merges) return null
  return (
    <div className="pr-ci">
      {readsLogs && (
        <>
          {failing && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Wrench size={12} />}
              loading={fixing}
              onClick={() => {
                setFixing(true)
                void fixFailingChecks(threadId, pull.number).finally(() => setFixing(false))
              }}
            >
              Fix failing checks
            </Button>
          )}
          <label className="pr-ci-watch" title={`The agent is sent each new failure's logs, fixes it and pushes; after ${String(MAX_WATCH_ROUNDS)} fixes that still fail, watching stops.`}>
            <input type="checkbox" checked={watching} onChange={(event) => watchChecks(threadId, pull.number, event.currentTarget.checked)} />
            <span>
              Watch checks and fix failures
              {watching && watch.rounds > 0 && <span className="muted"> · {String(watch.rounds)} of {String(MAX_WATCH_ROUNDS)} fixes sent</span>}
            </span>
          </label>
        </>
      )}
      {merges && pull.draft !== true && !green && (
        <Button
          size="sm"
          variant="ghost"
          icon={<GitMerge size={12} />}
          onClick={() => {
            // The confirmation opens over the window, so the popover makes way for it.
            onDialog?.()
            void mergeWhenGreen(threadId, pull.number)
          }}
        >
          Merge when green
        </Button>
      )}
    </div>
  )
}

/** "Connect GitHub": asks gh who is signed in, and offers to use it in one click. */
function ConnectGitHub({ threadId }: { readonly threadId: string }) {
  const host = gitHubHostOf(threadId)
  const projectId = useThread(threadId)?.projectId
  const [status, setStatus] = useState<CodeHostStatus | "checking" | "failed" | undefined>()
  const [connecting, setConnecting] = useState(false)
  const check = (): void => {
    setStatus("checking")
    gitHubCliStatus(host)
      .then((value) => setStatus(value ?? "failed"))
      .catch(() => setStatus("failed"))
  }
  const connect = async (): Promise<void> => {
    setConnecting(true)
    try {
      await connectGitHubCli(threadId, host)
    } catch (error) {
      toast("error", toHostError(error).message)
      setConnecting(false)
    }
  }
  return (
    <Popover
      side="top"
      width={320}
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          className={cx("bar-pr is-connect", open && "is-active")}
          onClick={() => {
            if (!open) check()
            toggle()
          }}
        >
          <GitPullRequest size={12} />
          Connect GitHub
        </button>
      )}
    >
      {() => (
        <div className="pr-connect">
          <p>
            Pull request status for <code>{host}</code> comes from your own GitHub CLI sign-in. Runrail never sees its token.
          </p>
          {status === "checking" || status === undefined ? (
            <p className="muted">
              <Spinner size={11} /> Checking the GitHub CLI…
            </p>
          ) : status === "failed" ? (
            <p className="muted">The GitHub CLI could not be asked. Try again from this project's settings.</p>
          ) : status.state === "ready" ? (
            <Button size="sm" variant="primary" loading={connecting} onClick={() => void connect()}>
              Use GitHub CLI (signed in as {status.login ?? "you"})
            </Button>
          ) : status.state === "signed-out" ? (
            <p className="muted">
              The GitHub CLI is not signed in. Run <code>gh auth login</code> in a terminal, then open this again.
            </p>
          ) : (
            <p className="muted">Install the GitHub CLI (gh), sign in with gh auth login, then open this again.</p>
          )}
          {projectId !== undefined && (
            <button type="button" className="link-button" onClick={() => openProjectSettings(projectId)}>
              Project settings
            </button>
          )}
        </div>
      )}
    </Popover>
  )
}

/** The read-only card in the timeline for a PR this thread saw appear, kept live by the bar's reads. */
export function PullRequestCard({ threadId, number }: { readonly threadId: string; readonly number: number }) {
  const known = useGit(threadId).pr?.pullRequests.find((pull) => pull.number === number)
  const stored = useThread(threadId)?.pullRequests?.find((entry) => entry.number === number)
  const pull: PullRequestStatusEntry = known ?? { number, state: "open", ...(stored?.url === undefined ? {} : { url: stored.url }) }
  return (
    <div className="row-pr">
      <PullRequestDetails threadId={threadId} pull={pull} card />
    </div>
  )
}
