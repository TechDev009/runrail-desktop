import { create } from "zustand"
import type { Timeline } from "../thread/reducer"
import { useActivity } from "./activity"
import { waitingItems } from "./attention"
import { isRunning, useBackground } from "./background"
import { activeQuests, applyGameEvent, levelProgress, reviewedAll, testsFixed, type ActiveQuest } from "./game"
import { MAX_SEASONS, type Game, type GameEvent, type Prefs, type SeasonChoice } from "./persist"
import { parseQuests, type QuestFileResult, type Season } from "./quests"
import { get, set, threadById, toast } from "./store"

/**
 * Where outcomes the app confirmed reach the ledger. Each hook is called by the code that saw the
 * outcome succeed; nothing here reads a model's text or counts volume.
 */

/** The layer's level, quests, and report live on the office floor, so it is on only with the floor. */
export function gameOn(prefs: Prefs): boolean {
  return prefs.officeMode !== "off" && prefs.game !== false
}

/** A project's quest file as read this session, and whether git sees it changed locally. */
export interface QuestFile {
  readonly hash: string
  readonly text: string
  readonly result: QuestFileResult
  readonly localEdits: boolean
}

/** By project id; `null` when the project has no quest file. Filled by `readQuestFile`. */
export const useQuestFiles = create<Readonly<Record<string, QuestFile | null>>>()(() => ({}))

let parsed: { readonly game?: Game["seasons"]; readonly files?: Readonly<Record<string, QuestFile | null>>; readonly seasons: ReadonlyMap<string, Season> } = { seasons: new Map() }

/**
 * The seasons in play: each one the person accepted, while the project's file is still the one
 * they accepted. A file not read yet this session counts as unchanged; a removed one stops.
 */
export function acceptedSeasons(seasons: Game["seasons"], files: Readonly<Record<string, QuestFile | null>> = useQuestFiles.getState()): ReadonlyMap<string, Season> {
  if (parsed.game === seasons && parsed.files === files) return parsed.seasons
  const result = new Map<string, Season>()
  for (const [projectId, choice] of Object.entries(seasons)) {
    const file = files[projectId]
    if (!choice.accepted || choice.text === undefined || file === null || (file !== undefined && file.hash !== choice.hash)) continue
    const read = parseQuests(choice.text)
    if (read.ok && read.season.id === choice.season) result.set(projectId, read.season)
  }
  parsed = { game: seasons, files, seasons: result }
  return result
}

export function questsInPlay(game: Game, at = Date.now()): readonly ActiveQuest[] {
  return activeQuests(acceptedSeasons(game.seasons), at)
}

/** A quest file asks the person once per content hash; a file with a problem only says so. */
export function questPrompt(projectId: string, file: QuestFile | null | undefined, seasons: Game["seasons"]): "ask" | "invalid" | undefined {
  if (file === null || file === undefined) return undefined
  if (!file.result.ok) return "invalid"
  return seasons[projectId]?.hash === file.hash ? undefined : "ask"
}

export function answerQuests(projectId: string, accepted: boolean): void {
  const file = useQuestFiles.getState()[projectId]
  if (file === null || file === undefined || !file.result.ok) return
  const choice: SeasonChoice = { season: file.result.season.id, hash: file.hash, accepted, ...(accepted ? { text: file.text } : {}) }
  set((state) => {
    const others = Object.entries(state.game.seasons).filter(([id]) => id !== projectId)
    return { game: { ...state.game, seasons: Object.fromEntries([...others.slice(-(MAX_SEASONS - 1)), [projectId, choice]]) } }
  })
}

export function recordGame(kind: GameEvent, threadId: string, extra: { readonly waitedMs?: number } = {}): void {
  const state = get()
  const thread = threadById(threadId)
  if (!gameOn(state.prefs) || thread === undefined) return
  const at = Date.now()
  const step = applyGameEvent(state.game, { kind, projectId: thread.projectId, at, ...extra }, questsInPlay(state.game, at))
  set({ game: step.game })
  for (const award of step.awards) toast("success", award.xp > 0 ? `Quest done: ${award.title}, +${String(award.xp)} XP` : `Quest done: ${award.title}. Today's XP is already full.`)
  if (step.level !== undefined) toast("success", `Level ${String(step.level)}: ${levelProgress(step.game.xp).rank}`)
}

/** Approvals already counted, so a second click on the same card earns nothing. */
const answered = new Set<string>()

/** An approval the engine took; approving and denying earn the same. */
export function noteAnswered(threadId: string, approvalId: string, askedAt: number | undefined): void {
  const key = `${threadId}:${approvalId}`
  if (answered.has(key)) return
  answered.add(key)
  if (answered.size > 1_000) answered.delete(answered.values().next().value ?? key)
  recordGame("request-answered", threadId, askedAt === undefined ? {} : { waitedMs: Math.max(0, Date.now() - askedAt) })
}

export function noteCommit(threadId: string, committed: readonly string[], viewed: readonly string[]): void {
  if (reviewedAll(committed, viewed)) recordGame("diff-reviewed", threadId)
  recordGame("commit", threadId)
}

/** Quiet threads the person steered or stopped, by the turn that was quiet. */
const rescues = new Map<string, { readonly turnId: string; readonly at: number }>()
const RESCUE_MS = 6 * 3_600_000

/** Called before a steer or stop goes out: a thread quiet right now is being rescued. */
export function noteRescue(threadId: string): void {
  const state = get()
  const thread = threadById(threadId)
  const turnId = state.runtime[threadId]?.timeline.activeTurnId
  if (thread === undefined || turnId === undefined || !gameOn(state.prefs)) return
  const agents = useBackground.getState()[threadId]?.entries.some((entry) => entry.kind === "agent" && isRunning(entry)) === true ? new Set([threadId]) : new Set<string>()
  // Already seen in the tray or not, a quiet thread is quiet.
  const quiet = waitingItems({ threads: [thread], runtime: state.runtime, activity: useActivity.getState(), agentsRunning: agents, quietMs: state.prefs.quietMinutes * 60_000, acknowledged: {}, now: Date.now() })
  if (quiet.some((item) => item.kind === "quiet")) rescues.set(threadId, { turnId, at: Date.now() })
}

/** A rescue counts once a turn after it completes; stopping the quiet turn itself waits for the next. */
export function noteTurnEnd(threadId: string, end: { readonly turnId: string; readonly status: string }): void {
  const rescue = rescues.get(threadId)
  if (rescue === undefined) return
  const fresh = Date.now() - rescue.at < RESCUE_MS
  if (fresh && end.status === "stopped" && end.turnId === rescue.turnId) return
  rescues.delete(threadId)
  if (fresh && end.status === "completed") recordGame("quiet-rescued", threadId)
}

/** Engines whose failed command reads as failed. Pi and ACP tools report what each tool says, which was not checked. */
const TRUSTED_STATUS: ReadonlySet<string> = new Set(["native", "codex", "claude-code"])
const fixed = new Set<string>()

export function noteTimeline(threadId: string, before: Timeline, after: Timeline): void {
  if (before.items === after.items || !gameOn(get().prefs)) return
  const backend = threadById(threadId)?.backend
  if (backend === undefined || !TRUSTED_STATUS.has(backend)) return
  for (const key of testsFixed(before, after)) {
    const id = `${threadId}:${key}`
    if (fixed.has(id)) continue
    fixed.add(id)
    recordGame("tests-fixed", threadId)
  }
}

/** When an approval was asked, from the thread's timeline. */
export function askedAt(timeline: Timeline, approvalId: string): number | undefined {
  const key = timeline.approvals.get(approvalId)
  const position = key === undefined ? undefined : timeline.index.get(key)
  const item = position === undefined ? undefined : timeline.items[position]
  return item?.kind === "approval" ? item.at : undefined
}
