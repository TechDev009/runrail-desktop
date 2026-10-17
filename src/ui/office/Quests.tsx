import { ArrowUpFromLine, FileDiff, FlaskConical, GitCommitHorizontal, GitPullRequest, GraduationCap, Hand, MoonStar, TriangleAlert, Trophy, X } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import { openDialog } from "../../app/actions"
import { levelProgress, questViews, type QuestView } from "../../app/game"
import type { GameEvent, Project } from "../../app/persist"
import { questPrompt, questsInPlay, useQuestFiles, type QuestFile } from "../../app/play"
import type { QuestPer, QuestSpec } from "../../app/quests"
import { useApp } from "../../app/store"
import { duration, plural } from "../../lib/format"
import { Button, cx, IconButton, Popover, useTicker } from "../common"

/** The game layer on the floor: the level chip, today's quests, and a repository's quest file. */

const ICONS: Readonly<Record<GameEvent, (size: number) => ReactNode>> = {
  "request-answered": (size) => <Hand size={size} />,
  "diff-reviewed": (size) => <FileDiff size={size} />,
  commit: (size) => <GitCommitHorizontal size={size} />,
  push: (size) => <ArrowUpFromLine size={size} />,
  "pr-opened": (size) => <GitPullRequest size={size} />,
  "lesson-read": (size) => <GraduationCap size={size} />,
  "quiet-rescued": (size) => <MoonStar size={size} />,
  "tests-fixed": (size) => <FlaskConical size={size} />,
}

export function questIcon(counts: GameEvent, size = 14): ReactNode {
  return ICONS[counts](size)
}

const PER: Readonly<Record<QuestPer, string>> = { day: "each day", week: "each week", season: "this season" }

/** A quest's rule in words: "Answer 10 requests within 10m each day". */
export function questRule(quest: Pick<QuestSpec, "counts" | "target" | "per" | "withinMs">): string {
  const n = quest.target
  const what: Readonly<Record<GameEvent, string>> = {
    "request-answered": `Answer ${plural(n, "request")}${quest.withinMs === undefined ? "" : ` within ${duration(quest.withinMs)}`}`,
    "diff-reviewed": `Review ${plural(n, "diff")} before committing`,
    commit: `Commit from Review ${plural(n, "time")}`,
    push: `Push from Review ${plural(n, "time")}`,
    "pr-opened": `Open ${plural(n, "pull request")}`,
    "lesson-read": `Read ${plural(n, "lesson")}`,
    "quiet-rescued": `Rescue ${plural(n, "quiet thread")}`,
    "tests-fixed": `Get failing tests passing ${plural(n, "time")}`,
  }
  return `${what[quest.counts]} ${PER[quest.per]}`
}

function Meter({ value, max, done }: { readonly value: number; readonly max: number; readonly done?: boolean }) {
  return (
    <span className={cx("meter", done === true && "is-done")} aria-hidden>
      <span style={{ width: `${String(Math.round((100 * Math.min(value, max)) / Math.max(1, max)))}%` }} />
    </span>
  )
}

/** One quest's progress, as the floor's strip and the shift report show it. */
export function QuestMeter({ quest }: { readonly quest: QuestView }) {
  return (
    <span className={cx("quest-meter", quest.done && "is-done")} title={quest.season === undefined ? undefined : quest.season}>
      <span className="quest-meter-icon" aria-hidden>
        {questIcon(quest.counts, 13)}
      </span>
      <span className="quest-meter-title">{quest.title}</span>
      <Meter value={quest.count} max={quest.target} done={quest.done} />
      <span className="quest-meter-count">{quest.done ? "Done" : `${String(quest.count)}/${String(quest.target)}`}</span>
    </span>
  )
}

/** Opens the shift report; the bar is the way to the next level. */
export function LevelChip() {
  const xp = useApp((state) => state.game.xp)
  const { level, rank, into, span } = levelProgress(xp)
  const left = span - into
  return (
    <button type="button" className="level-chip" title={`${rank}. ${plural(left, "XP", "")} to level ${String(level + 1)}`} aria-label={`Level ${String(level)}, ${rank}. Open the shift report`} onClick={() => openDialog({ kind: "shift-report" })}>
      <Trophy size={14} className="level-chip-icon" aria-hidden />
      <span className="level-chip-level">Level {level}</span>
      <Meter value={into} max={span} />
      <span className="level-chip-xp">{xp} XP</span>
    </button>
  )
}

export function useQuestViews(): readonly QuestView[] {
  const game = useApp((state) => state.game)
  const files = useQuestFiles()
  // A minute is enough for a day or a week to turn over.
  const now = useTicker(true, 60_000)
  return useMemo(() => questViews(game, questsInPlay(game, now), now), [game, files, now])
}

/** How far today's quests are, counted in steps: "3/10". */
export function questTotals(views: readonly Pick<QuestView, "count" | "target">[]): { readonly done: number; readonly total: number } {
  return views.reduce((sum, quest) => ({ done: sum.done + Math.min(quest.count, quest.target), total: sum.total + quest.target }), { done: 0, total: 0 })
}

/**
 * The header's Today pill: today's progress, and in its panel the level, every quest, and any
 * repository quest file waiting to be reviewed, which also puts a dot on the pill.
 */
export function TodayPill() {
  const views = useQuestViews()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const notices = useQuestNotices(dismissed)
  const { done, total } = questTotals(views)
  return (
    <Popover
      align="end"
      width={360}
      room={320}
      className="today-panel"
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx("today-pill", open && "is-active")} aria-expanded={open} aria-label={`Today's quests, ${String(done)} of ${String(total)}${notices.length > 0 ? ", a quest file to review" : ""}`} onClick={toggle}>
          <Trophy size={13} className="today-pill-icon" aria-hidden />
          Today
          <Meter value={done} max={total} done={total > 0 && done >= total} />
          <span className="today-pill-count">
            {done}/{total}
          </span>
          {notices.length > 0 && <span className="today-pill-dot" aria-hidden />}
        </button>
      )}
    >
      {(close) => (
        <div className="today-body">
          <LevelChip />
          <div className="today-quests" role="list" aria-label="Today's quests">
            {[...views]
              .sort((a, b) => Number(a.done) - Number(b.done))
              .map((quest) => (
                <span key={quest.key} role="listitem">
                  <QuestMeter quest={quest} />
                </span>
              ))}
          </div>
          <QuestNotices notices={notices} onDismiss={(key) => setDismissed((current) => new Set([...current, key]))} />
          <Button
            size="sm"
            onClick={() => {
              close()
              openDialog({ kind: "shift-report" })
            }}
          >
            End shift
          </Button>
        </div>
      )}
    </Popover>
  )
}

interface QuestNoticeView {
  readonly key: string
  readonly project: Project
  readonly file: QuestFile
}

/** Repositories whose quest file is new to this version, or could not be used, less those dismissed. */
function useQuestNotices(dismissed: ReadonlySet<string>): readonly QuestNoticeView[] {
  const files = useQuestFiles()
  const seasons = useApp((state) => state.game.seasons)
  const projects = useApp((state) => state.projects)
  return projects.flatMap((project) => {
    const file = files[project.id]
    const kind = questPrompt(project.id, file, seasons)
    const key = file === undefined || file === null ? "" : `${project.id}:${file.hash}`
    return kind === undefined || file === undefined || file === null || dismissed.has(key) ? [] : [{ key, project, file }]
  })
}

/** A repository's quest file: asked about once per version, or named with its problem. */
function QuestNotices({ notices, onDismiss }: { readonly notices: readonly QuestNoticeView[]; readonly onDismiss: (key: string) => void }) {
  return (
    <>
      {notices.map(({ key, project, file }) =>
        file.result.ok ? (
          <section key={project.id} className="quest-notice" aria-label={`${project.name} sets quests`}>
            <Trophy size={14} className="quest-notice-icon" aria-hidden />
            <span className="quest-notice-text">
              <strong>{project.name}</strong> sets quests: {file.result.season.title}, {plural(file.result.season.quests.length, "quest")}
            </span>
            {file.localEdits && <span className="quest-badge">Local edits</span>}
            <Button size="sm" onClick={() => openDialog({ kind: "quests", projectId: project.id })}>
              Review
            </Button>
          </section>
        ) : (
          <section key={project.id} className="quest-notice is-invalid" aria-label={`${project.name} quest file problem`}>
            <TriangleAlert size={14} className="quest-notice-icon" aria-hidden />
            <span className="quest-notice-text">
              The quest file in <strong>{project.name}</strong> was not used. Line {file.result.line}: {file.result.reason}
            </span>
            <IconButton label="Dismiss" size="sm" onClick={() => onDismiss(key)}>
              <X size={13} />
            </IconButton>
          </section>
        ),
      )}
    </>
  )
}
