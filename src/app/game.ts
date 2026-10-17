import type { Timeline, ToolItem } from "../thread/reducer"
import { MAX_ANSWER_MS, MAX_ANSWER_TIMES, MAX_GAME_DAYS, MAX_QUEST_PROGRESS, MAX_XP, type Game, type GameDay, type GameEvent, type QuestProgress } from "./persist"
import { STARTER_QUESTS, type QuestPer, type QuestSpec, type Season } from "./quests"

/**
 * The game layer's ledger. Outcomes the app confirmed count toward quests; a quest pays its XP
 * once per period, and a day pays at most `DAY_XP_CAP`. Pure, so the floor, the shift report,
 * and the tests read the same answer.
 */

export const DAY_XP_CAP = 500
const RANKS = ["Intern", "Intern", "Junior", "Junior", "Regular", "Senior", "Senior", "Shift lead", "Floor manager", "Office lead"] as const

/** The XP a level starts at: 0 for level 1, then 100, 300, 600, ... (`100 * n * (n + 1) / 2`). */
export function levelStart(level: number): number {
  const n = Math.max(0, level - 1)
  return (100 * n * (n + 1)) / 2
}

export function levelOf(xp: number): number {
  let level = 1
  while (levelStart(level + 1) <= xp) level += 1
  return level
}

export function rankOf(level: number): string {
  return RANKS[Math.min(Math.max(level, 0), RANKS.length - 1)] ?? "Intern"
}

export interface LevelProgress {
  readonly level: number
  readonly rank: string
  /** XP earned into this level, and what the whole level takes. */
  readonly into: number
  readonly span: number
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelOf(xp)
  const start = levelStart(level)
  return { level, rank: rankOf(level), into: xp - start, span: levelStart(level + 1) - start }
}

const pad = (value: number): string => String(value).padStart(2, "0")

/** The local date, `YYYY-MM-DD`: a day is the person's day, not UTC's. */
export function dayKey(at: number): string {
  const date = new Date(at)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The ISO week of the local date, `2026-W40`. */
export function weekKey(at: number): string {
  const date = new Date(at)
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7))
  const week = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${String(thursday.getUTCFullYear())}-W${pad(week)}`
}

/** A quest in play: a starter, or one from a project's accepted quest file. */
export interface ActiveQuest extends QuestSpec {
  /** Unique in the ledger: `starter/<id>`, or `<project>/<season>/<id>`. */
  readonly key: string
  /** A file's quest counts only its own project's outcomes. */
  readonly projectId?: string
  readonly season?: { readonly id: string; readonly title: string }
}

/** The starters, and the quests of each accepted season that is on today. */
export function activeQuests(seasons: ReadonlyMap<string, Season>, at: number): readonly ActiveQuest[] {
  const today = dayKey(at)
  const quests: ActiveQuest[] = STARTER_QUESTS.map((quest) => ({ ...quest, key: `starter/${quest.id}` }))
  for (const [projectId, season] of seasons) {
    if ((season.starts !== undefined && today < season.starts) || (season.ends !== undefined && today > season.ends)) continue
    for (const quest of season.quests) quests.push({ ...quest, key: `${projectId}/${season.id}/${quest.id}`, projectId, season: { id: season.id, title: season.title } })
  }
  return quests
}

function periodOf(quest: ActiveQuest, at: number): string {
  if (quest.per === "day") return dayKey(at)
  if (quest.per === "week") return weekKey(at)
  return `season:${quest.season?.id ?? "starter"}`
}

export interface GameEventInput {
  readonly kind: GameEvent
  readonly projectId: string
  readonly at: number
  /** How long an answered request had waited. */
  readonly waitedMs?: number
}

export interface Award {
  readonly key: string
  readonly title: string
  /** What the quest paid: less than its XP, or none, once the day's cap is reached. */
  readonly xp: number
}

export interface GameStep {
  readonly game: Game
  readonly awards: readonly Award[]
  /** The new level, when this step reached one. */
  readonly level?: number
}

const EMPTY_DAY: GameDay = { xp: 0, counts: {}, answerMs: [], quests: [] }

export function applyGameEvent(game: Game, event: GameEventInput, quests: readonly ActiveQuest[]): GameStep {
  const today = dayKey(event.at)
  const before = game.days[today] ?? EMPTY_DAY
  const counts = { ...before.counts, [event.kind]: (before.counts[event.kind] ?? 0) + 1 }
  const answerMs = event.kind === "request-answered" && event.waitedMs !== undefined ? [...before.answerMs, Math.min(MAX_ANSWER_MS, Math.max(0, Math.round(event.waitedMs)))].slice(-MAX_ANSWER_TIMES) : before.answerMs
  const progress: Record<string, QuestProgress> = { ...game.progress }
  const finished = [...before.quests]
  const awards: Award[] = []
  let dayXp = before.xp
  for (const quest of quests) {
    if (quest.counts !== event.kind || (quest.projectId !== undefined && quest.projectId !== event.projectId)) continue
    if (quest.withinMs !== undefined && (event.waitedMs === undefined || event.waitedMs > quest.withinMs)) continue
    const period = periodOf(quest, event.at)
    const current = progress[quest.key]?.period === period ? progress[quest.key] : undefined
    if (current?.done === true) continue
    const count = (current?.count ?? 0) + 1
    const done = count >= quest.target
    // Re-inserted so the cap below drops the quests touched longest ago.
    delete progress[quest.key]
    progress[quest.key] = { period, count, done }
    if (!done) continue
    const xp = Math.min(quest.xp, Math.max(0, DAY_XP_CAP - dayXp))
    dayXp += xp
    if (!finished.includes(quest.key)) finished.push(quest.key)
    awards.push({ key: quest.key, title: quest.title, xp })
  }
  const xp = Math.min(MAX_XP, game.xp + dayXp - before.xp)
  const days = Object.fromEntries(Object.entries({ ...game.days, [today]: { xp: dayXp, counts, answerMs, quests: finished } }).sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_GAME_DAYS))
  const level = levelOf(xp)
  return {
    game: { ...game, xp, days, progress: Object.fromEntries(Object.entries(progress).slice(-MAX_QUEST_PROGRESS)) },
    awards,
    ...(level > levelOf(game.xp) ? { level } : {}),
  }
}

export interface QuestView {
  readonly key: string
  readonly title: string
  readonly counts: GameEvent
  readonly count: number
  readonly target: number
  readonly done: boolean
  readonly per: QuestPer
  readonly xp: number
  readonly season?: string
  readonly projectId?: string
}

/** Each quest's count in its current period; a period that has passed starts again at 0. */
export function questViews(game: Game, quests: readonly ActiveQuest[], at: number): readonly QuestView[] {
  return quests.map((quest) => {
    const saved = game.progress[quest.key]
    const current = saved?.period === periodOf(quest, at) ? saved : undefined
    return {
      key: quest.key,
      title: quest.title,
      counts: quest.counts,
      count: Math.min(current?.count ?? 0, quest.target),
      target: quest.target,
      done: current?.done === true,
      per: quest.per,
      xp: quest.xp,
      ...(quest.season === undefined ? {} : { season: quest.season.title }),
      ...(quest.projectId === undefined ? {} : { projectId: quest.projectId }),
    }
  })
}

export interface ShiftStats {
  readonly xp: number
  readonly answered: number
  readonly medianWaitMs?: number
  readonly reviewed: number
  readonly commits: number
  readonly pushes: number
  readonly prs: number
  readonly lessons: number
  readonly rescued: number
  readonly testsFixed: number
  readonly questsDone: number
}

export function shiftStats(game: Game, at: number): ShiftStats {
  const day = game.days[dayKey(at)] ?? EMPTY_DAY
  const count = (kind: GameEvent): number => day.counts[kind] ?? 0
  const wait = median(day.answerMs)
  return {
    xp: day.xp,
    answered: count("request-answered"),
    ...(wait === undefined ? {} : { medianWaitMs: wait }),
    reviewed: count("diff-reviewed"),
    commits: count("commit"),
    pushes: count("push"),
    prs: count("pr-opened"),
    lessons: count("lesson-read"),
    rescued: count("quiet-rescued"),
    testsFixed: count("tests-fixed"),
    questsDone: day.quests.length,
  }
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
}

/** A commit counts as reviewed only when every file it takes was marked viewed. */
export function reviewedAll(committed: readonly string[], viewed: readonly string[]): boolean {
  return committed.length > 0 && committed.every((path) => viewed.includes(path))
}

/** How far back a newly finished call is looked for, and how far back the run before it. */
const TEST_SCAN = 200
const HISTORY_SCAN = 2_000

/**
 * Test runs that just passed when the thread's previous test run had failed, by row key. Only a
 * row that was running before this change counts, so a timeline rebuilt from history pays nothing.
 */
export function testsFixed(before: Timeline, after: Timeline): readonly string[] {
  const fixed: string[] = []
  for (let index = after.items.length - 1; index >= Math.max(0, after.items.length - TEST_SCAN); index -= 1) {
    const item = after.items[index]
    if (item?.kind !== "tool" || item.status !== "ok" || item.presentation.intent !== "test") continue
    const position = before.index.get(item.key)
    const was = position === undefined ? undefined : before.items[position]
    if (was?.kind === "tool" && was.status === "running" && previousRun(after, index) === "failed") fixed.push(item.key)
  }
  return fixed
}

function previousRun(timeline: Timeline, index: number): ToolItem["status"] | undefined {
  for (let at = index - 1; at >= Math.max(0, index - HISTORY_SCAN); at -= 1) {
    const item = timeline.items[at]
    if (item?.kind === "tool" && item.presentation.intent === "test" && item.status !== "running") return item.status
  }
  return undefined
}
