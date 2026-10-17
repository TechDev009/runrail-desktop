import { useVirtualizer } from "@tanstack/react-virtual"
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX, ExternalLink, FileDiff, GitBranch, GitMerge, GitPullRequest, LoaderCircle, MessagesSquare, RefreshCw, ScanSearch, Search, Users } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { openUrl } from "../../app/actions"
import {
  checksBadge,
  connectGitHub,
  fileGroups,
  loadReviews,
  loadTeams,
  mergeLine,
  parsePullRequestLink,
  refreshReviews,
  REVIEW_GROUPS,
  REVIEWS_POLL_MS,
  reviewBadge,
  reviewKey,
  reviewThreadsOf,
  selectReview,
  setReviewQuery,
  setReviewTab,
  setReviewTeam,
  threadForPullRequest,
  toggleViewed,
  useReviews,
  viewedKey,
  type ReviewGroup,
  type ReviewRef,
  type Tone,
} from "../../app/reviews"
import { openThread, useApp } from "../../app/store"
import { relativeTime, timeAgo } from "../../lib/format"
import type { ReviewDetail, ReviewEntry } from "../../protocol/schemas"
import { Button, CopyButton, cx, EmptyState, IconButton, Menu, Spinner, Tabs, useTicker, type MenuEntry } from "../common"
import { patchHeight, patchShape, PatchView, type PatchShape } from "../diff/DiffView"
import { Markdown } from "../thread/Markdown"
import { useListOffset } from "../virtual"
import { MergeDialog, ReviewDialog, ReviewFindings } from "./ReviewActions"

/**
 * Reviews: the person's pull requests across every repository, Codex style, read
 * through their own `gh` on the app-wide engine. Only a confirmed post or merge writes to GitHub.
 */

export function ReviewsView() {
  const connection = useReviews((state) => state.connection)

  useEffect(() => {
    void loadReviews()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshReviews()
    }, REVIEWS_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <main className="reviews" aria-label="Reviews">
      <ReviewList />
      <section className="reviews-detail">
        <div className="reviews-detail-top" data-tauri-drag-region />
        {connection.state === "ready" ? <Detail /> : <Connect />}
      </section>
    </main>
  )
}

function ReviewList() {
  const connection = useReviews((state) => state.connection)
  const query = useReviews((state) => state.query)
  const readAt = useReviews((state) => state.readAt)
  const now = useTicker(true, 30_000)
  const [busy, setBusy] = useState(false)
  const link = parsePullRequestLink(query)

  const refresh = (): void => {
    setBusy(true)
    void refreshReviews().finally(() => setBusy(false))
  }
  const submit = (): void => {
    if (link !== undefined) {
      selectReview(link)
      setReviewQuery("")
      return
    }
    void loadReviews()
  }

  return (
    <aside className="reviews-list" aria-label="Pull requests">
      <div className="reviews-list-top" data-tauri-drag-region>
        <span className="reviews-title">Reviews</span>
        <IconButton label="Read again" size="sm" disabled={busy || connection.state !== "ready"} onClick={refresh}>
          {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      <form
        className="reviews-search"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Search size={13} aria-hidden="true" />
        <input
          value={query}
          maxLength={200}
          placeholder="Search, or paste a pull request link"
          aria-label="Search pull requests, or paste a pull request link"
          disabled={connection.state !== "ready"}
          onChange={(event) => setReviewQuery(event.target.value)}
        />
        {link !== undefined && <span className="reviews-search-hint">Enter opens #{link.number}</span>}
      </form>
      <div className="reviews-groups">
        {connection.state === "checking" ? (
          <div className="reviews-note">
            <Spinner size={12} /> Checking GitHub…
          </div>
        ) : connection.state !== "ready" ? (
          <div className="reviews-note">Connect GitHub to see your pull requests here.</div>
        ) : (
          REVIEW_GROUPS.map((group) => <Group key={group.id} id={group.id} label={group.label} empty={group.empty} />)
        )}
      </div>
      {connection.state === "ready" && (
        <div className="reviews-foot">
          {readAt === undefined ? "Reading…" : `Read ${timeAgo(readAt, now)} · again every minute while open`}
        </div>
      )}
    </aside>
  )
}

function Group({ id, label, empty }: { readonly id: ReviewGroup; readonly label: string; readonly empty: string }) {
  const group = useReviews((state) => state.groups[id])
  const selected = useReviews((state) => state.selected)
  const [open, setOpen] = useState(true)
  const now = useTicker(true, 60_000)
  return (
    <section className="reviews-group" aria-label={label}>
      <div className="reviews-group-head">
        <button type="button" className="reviews-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{label}</span>
          {group.state === "ready" && <span className="reviews-count">{group.total}</span>}
          {group.state === "loading" && <Spinner size={11} />}
        </button>
        {id === "team" && <TeamFilter />}
      </div>
      {open &&
        (group.state === "error" ? (
          <div className="reviews-note is-error">{group.message ?? "Could not read this list."}</div>
        ) : group.state === "ready" && group.entries.length === 0 ? (
          <div className="reviews-note">{empty}</div>
        ) : (
          <ul className="reviews-rows">
            {group.entries.map((entry) => (
              <Row key={reviewKey(entry)} entry={entry} active={selected !== undefined && reviewKey(selected) === reviewKey(entry)} now={now} />
            ))}
            {group.state === "ready" && group.total > group.entries.length && <li className="reviews-more">{group.total - group.entries.length} more on GitHub; search to narrow</li>}
          </ul>
        ))}
    </section>
  )
}

function Row({ entry, active, now }: { readonly entry: ReviewEntry; readonly active: boolean; readonly now: number }) {
  const checks = checksBadge(entry.checks)
  const review = reviewBadge(entry)
  return (
    <li>
      <button type="button" className={cx("reviews-row", active && "is-active")} aria-current={active ? "true" : undefined} onClick={() => selectReview(entry)}>
        <span className="reviews-row-title">{entry.title ?? `Pull request #${String(entry.number)}`}</span>
        <span className="reviews-row-meta">
          <span>
            {entry.repo} #{entry.number}
          </span>
          {entry.author !== undefined && <span>· {entry.author}</span>}
          {entry.updatedAt !== undefined && <span>· {relativeTime(entry.updatedAt, now)}</span>}
          {review !== undefined && <Badge tone={review.tone}>{review.text}</Badge>}
          {checks !== undefined && <ChecksIcon state={entry.checks} label={checks.text} />}
        </span>
      </button>
    </li>
  )
}

function TeamFilter() {
  const teams = useReviews((state) => state.teams)
  const team = useReviews((state) => state.team)
  const items: MenuEntry[] =
    teams === "scope-missing"
      ? [{ heading: "Listing teams needs the read:org scope: run gh auth refresh -s read:org", id: "scope" }]
      : teams === undefined
        ? [{ heading: "Reading your teams…", id: "loading" }]
        : [
            { id: "all", label: "All my teams", ...(team === undefined ? { hint: <Check size={13} /> } : {}), onSelect: () => setReviewTeam(undefined) },
            ...teams.map((item) => ({ id: `${item.org}/${item.slug}`, label: `${item.org}/${item.slug}`, ...(team?.org === item.org && team.slug === item.slug ? { hint: <Check size={13} /> } : {}), onSelect: () => setReviewTeam(item) })),
          ]
  return (
    <Menu
      align="end"
      width={260}
      items={items}
      trigger={({ open, toggle, ref }) => (
        <IconButton
          ref={ref}
          label={team === undefined ? "Filter by team" : `Team ${team.org}/${team.slug}`}
          size="sm"
          active={open || team !== undefined}
          onClick={() => {
            void loadTeams()
            toggle()
          }}
        >
          <Users size={12} />
        </IconButton>
      )}
    />
  )
}

function Connect() {
  const connection = useReviews((state) => state.connection)
  const steps: readonly { readonly done: boolean; readonly title: string; readonly body: ReactNode }[] = [
    { done: connection.state !== "gh-missing", title: "GitHub CLI installed", body: connection.state === "gh-missing" ? <>Install it with <code>brew install gh</code>, then check again.</> : <>Found <code>gh</code> on this computer.</> },
    {
      done: connection.state === "not-connected",
      title: "Sign in to the GitHub CLI",
      body: (
        <>
          Runrail reads pull requests with your own <code>gh</code> sign-in and keeps no GitHub token.
          {connection.state === "signed-out" && (
            <span className="reviews-command">
              <code>gh auth login</code>
              <CopyButton text="gh auth login" label="Copy the command" />
            </span>
          )}
        </>
      ),
    },
    { done: false, title: "Use it for pull requests on github.com", body: "Applies to every project on github.com, as the switch in Settings → Projects does." },
  ]
  if (connection.state === "unavailable")
    return (
      <div className="reviews-connect">
        <EmptyState icon={<GitPullRequest size={20} />} title="This engine cannot read the inbox">
          The engine running here is older than this screen. Update Runrail, then open Reviews again.
        </EmptyState>
      </div>
    )
  const next = steps.findIndex((step) => !step.done)
  return (
    <div className="reviews-connect">
      <section className="reviews-connect-card" aria-labelledby="reviews-connect-title">
        <div className="reviews-connect-hero">
          <span className="reviews-connect-mark" aria-hidden="true">
            <GitPullRequest size={20} />
          </span>
          <h1 id="reviews-connect-title">See your pull requests in Runrail</h1>
          <p>Reviews lists the pull requests you opened, the ones waiting on your review, and your teams', across every repository your GitHub account can see.</p>
        </div>
        {connection.state === "error" && <p className="reviews-note is-error">{connection.message}</p>}
        <ol className="reviews-steps">
          {steps.map((step, index) => (
            <li key={step.title} className={cx("reviews-step", step.done && "is-done", index === next && "is-next")}>
              <span className="reviews-step-icon" aria-hidden="true">
                {step.done ? <Check size={13} /> : index + 1}
              </span>
              <span className="reviews-step-text">
                <span className="reviews-step-title">
                  {step.title}
                  <span className="sr-only">{step.done ? ", done" : ", to do"}</span>
                </span>
                <span className="reviews-step-body">{step.body}</span>
              </span>
              <span className="reviews-step-state" aria-hidden="true">
                {step.done ? "Done" : index === next ? "Next" : ""}
              </span>
            </li>
          ))}
        </ol>
        <div className="reviews-connect-actions">
          {connection.state === "not-connected" ? (
            <Button variant="primary" icon={<GitPullRequest size={14} />} onClick={() => void connectGitHub()}>
              Connect github.com
            </Button>
          ) : (
            <Button icon={<RefreshCw size={13} />} loading={connection.state === "checking"} onClick={() => void loadReviews()}>
              Check again
            </Button>
          )}
        </div>
      </section>
      <p className="reviews-connect-foot">GitLab and Bitbucket are not supported yet.</p>
    </div>
  )
}

function Detail() {
  const selected = useReviews((state) => state.selected)
  const state = useReviews((value) => (value.selected === undefined ? undefined : value.details[reviewKey(value.selected)]))
  const tab = useReviews((value) => value.tab)
  const [dialog, setDialog] = useState<"review" | "merge">()
  const [focusFile, setFocusFile] = useState<string>()
  if (selected === undefined)
    return (
      <div className="reviews-empty">
        <EmptyState icon={<GitPullRequest size={20} />} title="Pick a pull request">
          Open one from the list, or paste its link in the search box.
        </EmptyState>
      </div>
    )
  const detail = state?.detail
  if (detail === undefined)
    return (
      <div className="reviews-empty">
        {state?.state === "error" ? (
          <EmptyState icon={<CircleX size={20} />} title="Could not read this pull request" actions={<Button size="sm" onClick={() => selectReview(selected)}>Try again</Button>}>
            {state.message}
          </EmptyState>
        ) : (
          <div className="pane-loading" role="status">
            <Spinner size={12} /> Reading {selected.owner}/{selected.repo} #{selected.number}…
          </div>
        )}
      </div>
    )
  return (
    <>
      <div className="reviews-bar">
        <Tabs
          label="Pull request"
          value={tab}
          onChange={setReviewTab}
          options={[
            { value: "summary", label: "Summary" },
            { value: "changes", label: <>Changes <span className="reviews-add">+{detail.additions}</span> <span className="reviews-del">−{detail.deletions}</span></> },
          ]}
        />
        <span className="reviews-bar-spacer" />
        {state?.state === "error" && <span className="reviews-note is-error">Could not read it again: {state.message}</span>}
        {detail.url !== undefined && (
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => detail.url !== undefined && void openUrl(detail.url)}>
            GitHub
          </Button>
        )}
        {detail.state === "open" && mayMerge(detail) && (
          <Button size="sm" icon={<GitMerge size={13} />} disabled={detail.draft} title={detail.draft ? "A draft cannot be merged" : undefined} onClick={() => setDialog("merge")}>
            Merge…
          </Button>
        )}
        {detail.state === "open" && (
          <Button size="sm" variant="primary" icon={<ScanSearch size={13} />} onClick={() => setDialog("review")}>
            Review with…
          </Button>
        )}
      </div>
      <div className="reviews-body">
        {tab === "summary" ? (
          <Summary
            detail={detail}
            refOf={selected}
            onOpenFile={(path) => {
              setFocusFile(path)
              setReviewTab("changes")
            }}
          />
        ) : (
          <Changes detail={detail} refOf={selected} focusFile={focusFile} />
        )}
      </div>
      {dialog === "review" && <ReviewDialog detail={detail} refOf={selected} onClose={() => setDialog(undefined)} />}
      {dialog === "merge" && <MergeDialog detail={detail} refOf={selected} onClose={() => setDialog(undefined)} />}
    </>
  )
}

/** GitHub decides; this only hides Merge from a sign-in that can only read. */
function mayMerge(detail: ReviewDetail): boolean {
  return detail.permission === undefined || ["write", "maintain", "admin"].includes(detail.permission)
}

function Summary({ detail, refOf, onOpenFile }: { readonly detail: ReviewDetail; readonly refOf: ReviewRef; readonly onOpenFile: (path: string) => void }) {
  const now = useTicker(true, 60_000)
  const threads = useApp((state) => state.threads)
  const thread = useMemo(() => threadForPullRequest(threads, detail.url), [threads, detail.url])
  const reviews = useMemo(() => reviewThreadsOf(threads, refOf), [threads, refOf])
  const merge = mergeLine(detail)
  const checks = detail.checks
  const total = checks.passed + checks.failed + checks.pending + checks.skipped
  return (
    <div className="reviews-summary">
      <article className="reviews-main">
        <div className="reviews-kicker">
          <Badge tone={detail.state === "merged" ? "purple" : detail.state === "closed" ? "gray" : detail.draft ? "gray" : "green"}>{detail.state === "open" ? (detail.draft ? "Draft" : "Open") : detail.state === "merged" ? "Merged" : "Closed"}</Badge>
          <span>
            {detail.owner}/{detail.repo} #{detail.number}
          </span>
        </div>
        <h1 className="reviews-heading">{detail.title ?? `Pull request #${String(detail.number)}`}</h1>
        <p className="reviews-byline">
          {detail.author ?? "Someone"} opened it{detail.createdAt === undefined ? "" : ` ${timeAgo(detail.createdAt, now)}`}
          {detail.head !== undefined && detail.base !== undefined && (
            <>
              {" · "}
              <GitBranch size={12} aria-hidden="true" /> <code>{detail.headRepository === undefined ? detail.head : `${detail.headRepository}:${detail.head}`}</code> → <code>{detail.base}</code>
            </>
          )}
        </p>
        <ReviewFindings detail={detail} refOf={refOf} onOpenFile={onOpenFile} />
        {detail.body.trim().length === 0 ? <p className="muted">No description.</p> : <Markdown text={detail.body} />}
        {detail.bodyTruncated && <p className="setting-hint">The description is longer than this; the rest is on GitHub.</p>}
      </article>
      <aside className="reviews-side" aria-label="Status">
        <section>
          <h2>Merge status</h2>
          <p className={cx("reviews-line", `tone-${merge.tone}`)}>{merge.text}</p>
        </section>
        <section>
          <h2>Checks {total > 0 && <span className="muted">{checks.passed + checks.skipped} of {total} passed</span>}</h2>
          {total === 0 ? (
            <p className="muted">No checks on the head commit</p>
          ) : (
            <ul className="reviews-checks">
              {checks.items.map((item, index) => (
                <li key={`${item.name}-${String(index)}`}>
                  <ChecksIcon state={item.state === "skipped" ? "none" : item.state} label={item.state} />
                  {item.url === undefined ? <span>{item.name}</span> : <button type="button" className="link-button" onClick={() => item.url !== undefined && void openUrl(item.url)}>{item.name}</button>}
                  <span className="muted">{item.state === "passed" ? "Passed" : item.state === "failed" ? "Failed" : item.state === "pending" ? "Running" : "Skipped"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2>Reviews</h2>
          {detail.reviews.length === 0 && detail.requested.length === 0 ? (
            <p className="muted">No reviews yet</p>
          ) : (
            <ul className="reviews-people">
              {detail.reviews.map((review, index) => (
                <li key={`r-${String(index)}`}>
                  <span>{review.author ?? "Someone"}</span>
                  <Badge tone={review.state === "approved" ? "green" : review.state === "changes-requested" ? "red" : "gray"}>{review.state === "approved" ? "Approved" : review.state === "changes-requested" ? "Changes requested" : review.state === "commented" ? "Commented" : review.state === "dismissed" ? "Dismissed" : "Pending"}</Badge>
                </li>
              ))}
              {detail.requested.map((request) => (
                <li key={request.kind === "user" ? request.login : `${request.org}/${request.slug}`}>
                  <span>{request.kind === "user" ? request.login : `${request.org}/${request.slug}`}</span>
                  <Badge tone="amber">Requested</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2>In Runrail</h2>
          {thread === undefined && reviews.length === 0 ? (
            <p className="muted">No thread here opened or reviewed this pull request.</p>
          ) : (
            [...(thread === undefined ? [] : [thread]), ...reviews].map((item) => (
              <button key={item.id} type="button" className="reviews-thread" onClick={() => openThread(item.id)}>
                <MessagesSquare size={13} aria-hidden="true" />
                <span>{item.title}</span>
              </button>
            ))
          )}
        </section>
      </aside>
    </div>
  )
}

function Changes({ detail, refOf, focusFile }: { readonly detail: ReviewDetail; readonly refOf: ReviewRef; readonly focusFile?: string | undefined }) {
  const diff = useReviews((state) => state.diffs[reviewKey(refOf)])
  const key = viewedKey(refOf, detail.headCommit)
  const viewed = useReviews((state) => state.viewed[key] ?? NONE_VIEWED)
  const groups = useMemo(() => fileGroups(detail.files), [detail.files])
  const files = useMemo(() => groups.flatMap((group) => group.files), [groups])
  const [shown, setShown] = useState<string | undefined>()
  // A file is open unless viewed; a toggle holds until its viewed mark changes.
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({})
  const [large, setLarge] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => setToggled({}), [key])
  const ready = diff?.state === "ready"
  const patches = ready ? diff.files : undefined
  const shapes = useMemo(() => new Map([...(patches ?? NO_PATCHES)].map(([path, patch]) => [path, patchShape(patch)])), [patches])
  const isOpen = (path: string): boolean => toggled[path] ?? !viewed.includes(path)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const offset = useListOffset(scrollRef, listRef, `${String(ready)}:${String(diff?.truncated)}`)
  const virtualizer = useVirtualizer({
    count: ready ? files.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const file = files[index]
      if (file === undefined || !isOpen(file.path)) return DIFF_HEAD
      return DIFF_HEAD + patchHeight(shapes.get(file.path) ?? NO_SHAPE, large.has(file.path))
    },
    getItemKey: (index) => files[index]?.path ?? index,
    overscan: 3,
    gap: 12,
    scrollMargin: offset,
    scrollPaddingStart: 12,
  })
  const jump = (path: string): void => {
    setShown(path)
    const index = files.findIndex((file) => file.path === path)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" })
  }
  useEffect(() => {
    if (ready && focusFile !== undefined) jump(focusFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focusFile, offset])
  return (
    <div className="reviews-changes">
      <nav className="reviews-files" aria-label="Changed files">
        <div className="reviews-files-head">
          {detail.changedFiles} files · {viewed.length} of {detail.files.length} viewed
        </div>
        {groups.map((group) => (
          <div key={group.dir} className="reviews-dir">
            {group.dir.length > 0 && <div className="reviews-dir-name">{group.dir}</div>}
            {group.files.map((file) => (
              <button key={file.path} type="button" className={cx("reviews-file", shown === file.path && "is-active", viewed.includes(file.path) && "is-viewed")} onClick={() => jump(file.path)}>
                <span className="reviews-file-name">{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
                {file.change === "added" && <span className="muted">new</span>}
                <span className="reviews-add">+{file.additions}</span>
                {file.deletions > 0 && <span className="reviews-del">−{file.deletions}</span>}
              </button>
            ))}
          </div>
        ))}
        {detail.filesTruncated && <div className="reviews-note">GitHub lists the first 100 files here.</div>}
      </nav>
      <div ref={scrollRef} className="reviews-diffs">
        {diff === undefined || diff.state === "loading" ? (
          <div className="pane-loading" role="status">
            <LoaderCircle size={12} className="spin" /> Reading the changes…
          </div>
        ) : diff.state === "error" ? (
          <div className="reviews-note is-error">{diff.message}</div>
        ) : (
          <>
            {diff.truncated && <div className="reviews-note">The changes are larger than 2 MB; the files past that point are on GitHub.</div>}
            <div ref={listRef} className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const file = files[item.index]
                return file === undefined ? null : (
                  <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="virtual-row" style={{ top: item.start - offset }}>
                    <FileChanges
                      file={file}
                      patch={diff.files.get(file.path)}
                      viewed={viewed.includes(file.path)}
                      open={isOpen(file.path)}
                      showLarge={large.has(file.path)}
                      onToggle={() => setToggled((current) => ({ ...current, [file.path]: !isOpen(file.path) }))}
                      onViewed={() => {
                        toggleViewed(key, file.path)
                        setToggled((current) => {
                          const next = { ...current }
                          delete next[file.path]
                          return next
                        })
                      }}
                      onShowLarge={() => setLarge((current) => new Set(current).add(file.path))}
                    />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function FileChanges({
  file,
  patch,
  viewed,
  open,
  showLarge,
  onToggle,
  onViewed,
  onShowLarge,
}: {
  readonly file: ReviewDetail["files"][number]
  readonly patch: string | undefined
  readonly viewed: boolean
  readonly open: boolean
  readonly showLarge: boolean
  readonly onToggle: () => void
  readonly onViewed: () => void
  readonly onShowLarge: () => void
}) {
  return (
    <section id={fileAnchor(file.path)} className="reviews-diff" aria-label={file.path}>
      <header className="reviews-diff-head">
        <button type="button" className="reviews-diff-toggle" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FileDiff size={13} aria-hidden="true" />
          <span className="reviews-diff-path">{file.path}</span>
          <span className="reviews-add">+{file.additions}</span>
          <span className="reviews-del">−{file.deletions}</span>
        </button>
        <label className="reviews-viewed">
          <input type="checkbox" checked={viewed} onChange={onViewed} />
          Viewed
        </label>
      </header>
      {open && (patch === undefined ? <div className="diff-empty">Not in the part of the changes that was read</div> : <PatchView patch={patch} path={file.path} showLarge={showLarge} onShowLarge={onShowLarge} />)}
    </section>
  )
}

/** A file's header row, borders included. */
const DIFF_HEAD = 40
const NO_SHAPE: PatchShape = { lines: 0, hunks: 0 }
const NO_PATCHES: ReadonlyMap<string, string> = new Map()

/** One empty list, so the selector above returns the same value while nothing is viewed. */
const NONE_VIEWED: readonly string[] = []

/** An element id per file; the hash keeps `a/b.ts` and `a-b.ts` apart. */
export function fileAnchor(path: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < path.length; index += 1) hash = Math.imul(hash ^ path.charCodeAt(index), 0x01000193) >>> 0
  return `review-file-${path.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80)}-${hash.toString(36)}`
}

function Badge({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={cx("reviews-badge", `tone-${tone}`)}>{children}</span>
}

function ChecksIcon({ state, label }: { readonly state: ReviewEntry["checks"]; readonly label: string }) {
  const icon = state === "passed" ? <CircleCheck size={12} /> : state === "failed" ? <CircleX size={12} /> : state === "pending" ? <CircleDashed size={12} /> : <CircleDashed size={12} />
  return (
    <span className={cx("reviews-checks-icon", `tone-${state === "passed" ? "green" : state === "failed" ? "red" : state === "pending" ? "amber" : "gray"}`)} role="img" aria-label={label} title={label}>
      {icon}
    </span>
  )
}
