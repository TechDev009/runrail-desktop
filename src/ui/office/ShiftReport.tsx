import { GraduationCap, Trophy } from "lucide-react"
import { useState } from "react"
import { closeDialog } from "../../app/actions"
import { dayKey, levelOf, levelProgress, shiftStats, type QuestView } from "../../app/game"
import { lessonById, type Lesson } from "../../app/lessons"
import { useApp } from "../../app/store"
import { duration, plural } from "../../lib/format"
import { Button, Modal } from "../common"
import { withCode } from "../thread/Lesson"
import { QuestMeter, useQuestViews } from "./Quests"

/**
 * Today's outcomes: what the person answered, reviewed, shipped, and learned, and the quests they
 * finished. Only what the app confirmed is counted, all of it from this machine.
 */

const LESSONS_SHOWN = 6

export function ShiftReport() {
  const game = useApp((state) => state.game)
  const read = useApp((state) => state.learning.read)
  const [now] = useState(() => Date.now())
  const views = useQuestViews()
  const projects = useApp((state) => state.projects)
  // Starters first, then each repository's season, so two similar quests read apart.
  const groups = new Map<string, QuestView[]>()
  for (const quest of views) {
    const project = projects.find((candidate) => candidate.id === quest.projectId)?.name
    const source = quest.season === undefined ? "Starter quests" : project === undefined ? quest.season : `${quest.season} · ${project}`
    groups.set(source, [...(groups.get(source) ?? []), quest])
  }
  const stats = shiftStats(game, now)
  const { level, rank, into, span } = levelProgress(game.xp)
  const leveledToday = levelOf(game.xp - stats.xp) < level
  const today = dayKey(now)
  const lessons = [...new Map(read.filter((entry) => dayKey(entry.at) === today).flatMap((entry) => {
    const lesson = lessonById(entry.id)
    return lesson === undefined ? [] : [[lesson.id, lesson] as const]
  })).values()]
  const cards: readonly (readonly [string, number, string?])[] = [
    ["requests answered", stats.answered, stats.medianWaitMs === undefined ? undefined : `median wait ${duration(stats.medianWaitMs)}`],
    ["diffs reviewed before committing", stats.reviewed],
    ["commits from Review", stats.commits, stats.pushes > 0 ? `${plural(stats.pushes, "push", "es")}` : undefined],
    ["pull requests opened", stats.prs],
    ["lessons read", stats.lessons],
    ["quiet threads rescued", stats.rescued],
    ["failing tests fixed", stats.testsFixed],
    ["quests done", stats.questsDone, stats.xp > 0 ? `+${String(stats.xp)} XP today` : undefined],
  ]
  const quiet = cards.every(([, value]) => value === 0)
  return (
    <Modal
      title="Shift report"
      onClose={closeDialog}
      width={760}
      footer={
        <Button variant="primary" data-autofocus="" onClick={closeDialog}>
          Done
        </Button>
      }
    >
      <div className="shift">
        <div className="shift-head">
          <span className="shift-date">{new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span>
          <div className="shift-level">
            <span className="shift-level-icon" aria-hidden>
              <Trophy size={18} />
            </span>
            <div className="shift-level-text">
              <span className="shift-level-name">
                Level {level} <span className="shift-level-rank">{rank}</span>
              </span>
              <span className="shift-level-next">{leveledToday ? "New level reached today" : `${plural(span - into, "XP", "")} to level ${String(level + 1)}`}</span>
              <span className="meter" aria-hidden>
                <span style={{ width: `${String(Math.round((100 * into) / Math.max(1, span)))}%` }} />
              </span>
            </div>
          </div>
        </div>
        {quiet && <p className="shift-empty">Nothing counted yet today. Answering a request, reviewing a diff before you commit, or reading a lesson all count.</p>}
        <div className="shift-cards">
          {cards.map(([label, value, detail]) => (
            <div key={label} className="shift-card">
              <span className="shift-card-value">{value}</span>
              <span className="shift-card-label">{label}</span>
              {detail !== undefined && <span className="shift-card-detail">{detail}</span>}
            </div>
          ))}
        </div>
        <section className="shift-section" aria-label="Quests">
          <h3 className="shift-section-title">Quests</h3>
          {[...groups].map(([source, quests]) => (
            <div key={source} className="shift-quest-group">
              <span className="shift-quest-source">{source}</span>
              <div className="shift-quests">
                {quests.map((quest) => (
                  <QuestMeter key={quest.key} quest={quest} />
                ))}
              </div>
            </div>
          ))}
        </section>
        {lessons.length > 0 && (
          <section className="shift-section" aria-label="What you learned today">
            <h3 className="shift-section-title">
              <GraduationCap size={14} aria-hidden /> What you learned today <span className="shift-section-count">{plural(lessons.length, "lesson")}</span>
            </h3>
            <div className="shift-lessons">
              {lessons.slice(0, LESSONS_SHOWN).map((lesson: Lesson) => (
                <div key={lesson.id} className="shift-lesson">
                  <span className="shift-lesson-title">{lesson.title}</span>
                  <span className="shift-lesson-body">{withCode(lesson.body)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
