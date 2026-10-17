import { CircleAlert, GitMerge, LoaderCircle, MessagesSquare, Send, TriangleAlert, Wrench, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { openUrl, pickProject, startNewThread } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import { archiveThread, peekThread, send, threadStatus } from "../../app/engines"
import { BACKEND_LABELS } from "../../app/persist"
import type { ThreadMeta } from "../../app/persist"
import { anyConnected, reasoningView, selectionProblem, THINKING_NAME, type Selection } from "../../app/picker"
import { FINDINGS_FORMAT, planPost, type Finding, type Severity } from "../../app/reviewFindings"
import {
  findingsOf,
  fixPrompt,
  loadDetail,
  loadDiff,
  markFinding,
  mergeLine,
  mergePullRequest,
  postFindings,
  projectForPullRequest,
  reviewKey,
  reviewThreadsOf,
  startReview,
  useFindingMarks,
  useReviews,
  type FindingMark,
  type ReviewRef,
} from "../../app/reviews"
import { openThread, set, startSelection, toast, useApp } from "../../app/store"
import type { Thinking } from "../../host/types"
import { toHostError } from "../../host"
import type { ReviewDetail } from "../../protocol/schemas"
import { Button, cx, Modal } from "../common"
import { knownConnections, runProblemText, useStartModel } from "../dialogs/Dialogs"
import { Markdown } from "../thread/Markdown"
import { RunsOnSelect } from "../RunsOnSelect"

/**
 * Reviews: a coding tool reviews a pull request in a worktree at its head, its findings
 * stay here until the person includes and posts them, and a merge is always confirmed.
 */

const NO_MARKS: Readonly<Record<number, FindingMark>> = {}

/** What each route can do to the worktree while it reviews. */
function readOnlyNote(backend: Selection["backend"]): string {
  if (backend === "claude-code") return "Claude Code runs in plan mode: it reads and does not change files."
  if (backend === "codex") return "Codex runs in its read-only sandbox, without network."
  if (backend === "pi") return "Pi has no read-only mode: it asks before each change. Turn changes down."
  return `${backend === "native" ? "It" : BACKEND_LABELS[backend]} runs in Plan mode: it reads and does not change files.`
}

export function ReviewDialog({ detail, refOf, onClose }: { readonly detail: ReviewDetail; readonly refOf: ReviewRef; readonly onClose: () => void }) {
  const projects = useApp((state) => state.projects)
  const prefs = useApp((state) => state.prefs)
  const project = useMemo(() => projectForPullRequest(projects, refOf), [projects, refOf])
  const catalog = useCatalog(project?.id)
  const [runsOn, setRunsOn] = useState<Selection>(() => startSelection(prefs))
  const [thinking, setThinking] = useState<Thinking>(prefs.defaultThinking)
  const [focus, setFocus] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useStartModel(catalog, prefs.developer, (start, needs) => setRunsOn((current) => (needs(current) ? start : current)))
  const problem = selectionProblem(runsOn, knownConnections(catalog), prefs.developer)
  const reasoning = reasoningView({ ...runsOn, thinking }, catalog.models, catalog.harnesses)

  if (project === undefined)
    return (
      <Modal
        title="Review with"
        onClose={onClose}
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onClose()
                void pickProject()
              }}
            >
              Add this repository as a project
            </Button>
          </>
        }
      >
        <p>
          A review runs in a worktree of {refOf.owner}/{refOf.repo}. Add your clone of it as a project, then review from here.
        </p>
        <p className="form-hint">
          A fork works too, when its upstream remote is {refOf.owner}/{refOf.repo}.
        </p>
      </Modal>
    )

  const start = async (): Promise<void> => {
    if (problem !== undefined || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await startReview(refOf, detail, {
        projectId: project.id,
        projectPath: project.path,
        selection: runsOn,
        ...(reasoning.enabled ? { thinking } : {}),
        ...(focus.trim().length === 0 ? {} : { focus: focus.trim().slice(0, 2_000) }),
      })
      onClose()
    } catch (cause) {
      setError(toHostError(cause).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Review #${String(refOf.number)}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={problem !== undefined} onClick={() => void start()}>
            Start review
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="field-row">
          <label className="field grow">
            <span className="field-label">Review with</span>
            <RunsOnSelect
              catalog={catalog}
              value={runsOn}
              unbound={{
                label: prefs.developer ? "Test model" : "Pick a model",
                disabled: !prefs.developer,
              }}
              onChange={setRunsOn}
            />
          </label>
          {reasoning.shown && (
            <label className="field">
              <span className="field-label">Effort</span>
              <select className="select" value={thinking} disabled={!reasoning.enabled} onChange={(event) => setThinking(event.target.value as Thinking)}>
                {reasoning.levels.map((level) => (
                  <option key={level} value={level}>
                    {THINKING_NAME[level]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {problem !== undefined && (
          <p className="form-warning" role="status">
            <TriangleAlert size={13} />{" "}
            {runProblemText(
              problem,
              anyConnected(catalog),
              "this review",
            )}
          </p>
        )}
        <label className="field">
          <span className="field-label">Focus (optional)</span>
          <textarea className="textarea" rows={3} value={focus} placeholder="What to look at most closely" onChange={(event) => setFocus(event.target.value)} />
        </label>
        <p className="form-hint">
          In {project.name}, a new worktree at the pull request's head. {readOnlyNote(runsOn.backend)} The findings stay in Runrail until you post them.
        </p>
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** The latest review of this pull request: its progress, then its findings. */
export function ReviewFindings({ detail, refOf, onOpenFile }: { readonly detail: ReviewDetail; readonly refOf: ReviewRef; readonly onOpenFile: (path: string) => void }) {
  const threads = useApp((state) => state.threads)
  const reviews = useMemo(() => reviewThreadsOf(threads, refOf), [threads, refOf])
  const latest = reviews[0]
  if (latest === undefined) return null
  return <ReviewResult key={latest.id} thread={latest} earlier={reviews.length - 1} detail={detail} refOf={refOf} onOpenFile={onOpenFile} />
}

function ReviewResult({
  thread,
  earlier,
  detail,
  refOf,
  onOpenFile,
}: {
  readonly thread: ThreadMeta
  readonly earlier: number
  readonly detail: ReviewDetail
  readonly refOf: ReviewRef
  readonly onOpenFile: (path: string) => void
}) {
  const runtime = useApp((state) => state.runtime[thread.id])
  const marks = useFindingMarks((state) => state.marks[thread.id] ?? NO_MARKS)
  const [posting, setPosting] = useState(false)
  useEffect(() => {
    void peekThread(thread.id)
  }, [thread.id])
  const status = threadStatus(thread, runtime)
  const items = runtime?.timeline.items
  const result = useMemo(() => (items === undefined ? undefined : findingsOf(items)), [items])
  const tool = BACKEND_LABELS[thread.backend]
  const moved = thread.review?.headCommit !== undefined && detail.headCommit !== undefined && thread.review.headCommit !== detail.headCommit
  const findings = result?.state === "ok" ? result.findings : []
  const included = findings.filter((_, index) => marks[index] === "included")
  const busy = status === "running" || status === "waiting"

  return (
    <section className="review-result" aria-label="Review">
      <header className="review-result-head">
        <h2>Review by {tool}</h2>
        <span className="muted">{earlier > 0 ? `${String(earlier)} earlier` : ""}</span>
        <span className="reviews-bar-spacer" />
        <Button size="sm" variant="ghost" icon={<MessagesSquare size={13} />} onClick={() => openThread(thread.id)}>
          Open thread
        </Button>
      </header>
      {status === "waiting" ? (
        <p className="review-result-note">
          <CircleAlert size={13} /> {tool} is waiting for your answer in the thread.
        </p>
      ) : busy ? (
        <p className="review-result-note" role="status">
          <LoaderCircle size={13} className="spin" /> Reviewing…
        </p>
      ) : result === undefined ? (
        <p className="review-result-note muted">{status === "failed" || status === "stopped" ? "The review stopped before it answered." : "No answer yet."}</p>
      ) : result.state !== "ok" ? (
        <div className="review-result-note">
          <span>The review did not end with its findings in the expected format; its answer is in the thread.</span>
          <Button
            size="sm"
            onClick={() =>
              send(thread.id, {
                text: `End your answer with the findings block, as asked.\n\n${FINDINGS_FORMAT}`,
              })
            }
          >
            Ask again for the format
          </Button>
        </div>
      ) : (
        <>
          {result.summary !== undefined && <p className="review-result-summary">{result.summary}</p>}
          {moved && (
            <p className="form-warning">
              <TriangleAlert size={13} /> The pull request changed since this review. Review it again to post findings on the new head.
            </p>
          )}
          {findings.length === 0 ? (
            <p className="muted">No findings.</p>
          ) : (
            <ul className="review-findings">
              {findings.map((finding, index) => (
                <FindingCard
                  key={`${String(index)}-${finding.title}`}
                  finding={finding}
                  mark={marks[index]}
                  onMark={(mark) => markFinding(thread.id, index, mark)}
                  onOpenFile={onOpenFile}
                  onFix={() => fixInThread(thread.projectId, refOf, finding)}
                />
              ))}
            </ul>
          )}
          {result.dropped > 0 && (
            <p className="form-hint">
              {result.dropped} more {result.dropped === 1 ? "entry was" : "entries were"} not well formed and left out.
            </p>
          )}
          {findings.length > 0 && (
            <footer className="review-result-foot">
              <span className="muted">
                {included.length} of {findings.length} included
              </span>
              <Button size="sm" variant="primary" icon={<Send size={13} />} disabled={included.length === 0 || moved || thread.review?.headCommit === undefined} onClick={() => setPosting(true)}>
                Post to GitHub…
              </Button>
            </footer>
          )}
        </>
      )}
      {posting && thread.review?.headCommit !== undefined && <PostDialog refOf={refOf} commit={thread.review.headCommit} findings={included} tool={tool} onClose={() => setPosting(false)} />}
    </section>
  )
}

const SEVERITY: Record<Severity, { readonly label: string; readonly tone: "red" | "amber" | "gray" }> = {
  high: { label: "High", tone: "red" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "gray" },
}

function FindingCard({
  finding,
  mark,
  onMark,
  onOpenFile,
  onFix,
}: {
  readonly finding: Finding
  readonly mark: FindingMark | undefined
  readonly onMark: (mark: FindingMark | undefined) => void
  readonly onOpenFile: (path: string) => void
  readonly onFix: () => void
}) {
  const severity = SEVERITY[finding.severity]
  const dismissed = mark === "dismissed"
  return (
    <li className={cx("review-finding", dismissed && "is-dismissed")}>
      <div className="review-finding-head">
        <span className={cx("reviews-badge", `tone-${severity.tone}`)}>{severity.label}</span>
        <span className="review-finding-title">{finding.title}</span>
      </div>
      {finding.path !== undefined && (
        <button type="button" className="link-button review-finding-where" onClick={() => finding.path !== undefined && onOpenFile(finding.path)}>
          {finding.path}
          {finding.line === undefined ? "" : `:${String(finding.line)}`}
        </button>
      )}
      {!dismissed && finding.body !== undefined && <Markdown text={finding.body} />}
      <div className="review-finding-actions">
        {!dismissed && (
          <label className="reviews-viewed">
            <input type="checkbox" checked={mark === "included"} onChange={(event) => onMark(event.target.checked ? "included" : undefined)} />
            Include in post
          </label>
        )}
        <span className="reviews-bar-spacer" />
        {!dismissed && (
          <Button size="sm" variant="ghost" icon={<Wrench size={13} />} onClick={onFix}>
            Fix in a new thread
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={dismissed ? undefined : <X size={13} />} onClick={() => onMark(dismissed ? undefined : "dismissed")}>
          {dismissed ? "Restore" : "Dismiss"}
        </Button>
      </div>
    </li>
  )
}

/** A new thread in the project, its prompt written and not sent: the person picks the model and sends. */
function fixInThread(projectId: string, refOf: ReviewRef, finding: Finding): void {
  const key = `new:${projectId}`
  set((state) => ({
    drafts: { ...state.drafts, [key]: fixPrompt(refOf, finding) },
  }))
  startNewThread(projectId)
}

/** The host's code when the person cancels its native confirmation for a GitHub write. */
const WRITE_DECLINED = "PR_WRITE_DECLINED"

function PostDialog({ refOf, commit, findings, tool, onClose }: { readonly refOf: ReviewRef; readonly commit: string; readonly findings: readonly Finding[]; readonly tool: string; readonly onClose: () => void }) {
  const diff = useReviews((state) => state.diffs[reviewKey(refOf)])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (diff === undefined || diff.state === "error") void loadDiff(refOf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const ready = diff?.state === "ready"
  const post = useMemo(() => (ready ? planPost(findings, diff.files, tool) : undefined), [ready, diff, findings, tool])

  const confirm = async (): Promise<void> => {
    if (post === undefined || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const answer = await postFindings(refOf, commit, post)
      onClose()
      toast("success", `Posted the review on #${String(refOf.number)}`, answer.url === undefined ? undefined : { label: "Open", run: () => void openUrl(answer.url ?? "") })
      void loadDetail(refOf, true)
    } catch (cause) {
      const failure = toHostError(cause)
      // Cancelled in the app's own confirmation: nothing was sent, so nothing to report.
      if (failure.code !== WRITE_DECLINED) setError(failure.message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Post to GitHub"
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Send size={13} />} loading={busy} disabled={post === undefined} onClick={() => void confirm()}>
            Post review
          </Button>
        </>
      }
    >
      <div className="form">
        <p className="form-hint">
          One review on {refOf.owner}/{refOf.repo} #{refOf.number}, as a comment, under your GitHub name. This is exactly what is sent, once you confirm it in the dialog that follows.
        </p>
        {post === undefined ? (
          <div className="pane-loading" role="status">
            {diff?.state === "error" ? (
              diff.message
            ) : (
              <>
                <LoaderCircle size={12} className="spin" /> Reading the changes to place comments on lines…
              </>
            )}
          </div>
        ) : (
          <div className="review-post">
            <h3>Review</h3>
            <pre className="review-post-text">{post.body}</pre>
            {post.comments.length > 0 && (
              <>
                <h3>On lines ({post.comments.length})</h3>
                {post.comments.map((comment, index) => (
                  <div key={`${comment.path}:${String(comment.line)}:${String(index)}`} className="review-post-comment">
                    <code>
                      {comment.path}:{comment.line}
                    </code>
                    <pre className="review-post-text">{comment.body}</pre>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

const METHOD_NAMES: Record<"merge" | "squash" | "rebase", string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
}

export function MergeDialog({ detail, refOf, onClose }: { readonly detail: ReviewDetail; readonly refOf: ReviewRef; readonly onClose: () => void }) {
  const threads = useApp((state) => state.threads)
  const reviews = useMemo(() => reviewThreadsOf(threads, refOf), [threads, refOf])
  const methods = (["squash", "merge", "rebase"] as const).filter((method) => detail.mergeMethods.includes(method))
  const [method, setMethod] = useState(methods[0])
  const [subject, setSubject] = useState(`${detail.title ?? `Pull request #${String(detail.number)}`} (#${String(detail.number)})`)
  const [deleteBranch, setDeleteBranch] = useState(!detail.crossRepository)
  const [archive, setArchive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const merge = mergeLine(detail)
  const headCommit = detail.headCommit

  const confirm = async (): Promise<void> => {
    if (method === undefined || headCommit === undefined || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await mergePullRequest(refOf, {
        method,
        headCommit,
        deleteBranch: deleteBranch && !detail.crossRepository,
        ...(method === "rebase" || subject.trim().length === 0 ? {} : { subject: subject.trim().slice(0, 256) }),
      })
      if (archive) for (const thread of reviews) void archiveThread(thread.id, true)
      onClose()
      toast("success", `Merged #${String(refOf.number)}`)
      void loadDetail(refOf, true)
    } catch (cause) {
      const failure = toHostError(cause)
      if (failure.code !== WRITE_DECLINED) setError(failure.message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Merge #${String(refOf.number)}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<GitMerge size={13} />} loading={busy} disabled={method === undefined || headCommit === undefined} onClick={() => void confirm()}>
            {method === undefined ? "Merge" : METHOD_NAMES[method]}
          </Button>
        </>
      }
    >
      <div className="form">
        {(detail.checksState === "failed" || detail.checksState === "pending") && (
          <p className="form-warning" role="status">
            <TriangleAlert size={13} /> {detail.checksState === "failed" ? "Some checks failed on the head commit." : "Checks are still running on the head commit."}
          </p>
        )}
        {merge.tone !== "green" && <p className={cx("reviews-line", `tone-${merge.tone}`)}>{merge.text}</p>}
        {methods.length === 0 ? (
          <p className="form-warning">
            <CircleAlert size={13} /> This repository allows no merge method this sign-in can use.
          </p>
        ) : (
          <label className="field">
            <span className="field-label">Method</span>
            <select className="select" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
              {methods.map((item) => (
                <option key={item} value={item}>
                  {METHOD_NAMES[item]}
                </option>
              ))}
            </select>
          </label>
        )}
        {method !== undefined && method !== "rebase" && (
          <label className="field">
            <span className="field-label">Commit message</span>
            <input className="input" value={subject} maxLength={256} onChange={(event) => setSubject(event.target.value)} />
          </label>
        )}
        <label className="toggle-row">
          <input type="checkbox" checked={deleteBranch && !detail.crossRepository} disabled={detail.crossRepository} onChange={(event) => setDeleteBranch(event.target.checked)} />
          <span>
            Delete the branch {detail.head === undefined ? "" : <code>{detail.head}</code>}
            {detail.crossRepository ? " (it is in a fork)" : ""}
          </span>
        </label>
        {reviews.length > 0 && (
          <label className="toggle-row">
            <input type="checkbox" checked={archive} onChange={(event) => setArchive(event.target.checked)} />
            <span>Archive its review {reviews.length === 1 ? "thread" : "threads"}</span>
          </label>
        )}
        <p className="form-hint">Merges on GitHub only if the head is still {headCommit === undefined ? "the one read here" : <code>{headCommit.slice(0, 7)}</code>}.</p>
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
