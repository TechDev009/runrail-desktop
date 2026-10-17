import { GAME_EVENTS, MAX_QUEST_FILE_BYTES, type GameEvent } from "./persist"

/**
 * A repository's quest file, `.runrail/quests.md`, is untrusted input: a strict, bounded format
 * with a closed vocabulary. Any line this parser does not know rejects the whole file with that
 * line's number. Titles are kept as plain text and nothing in the file changes a setting.
 */

export const QUEST_FILE = ".runrail/quests.md"
export const MAX_QUESTS = 20
export const MAX_TITLE = 80

export type QuestPer = "day" | "week" | "season"

export interface QuestSpec {
  /** Unique within its file, from the title. */
  readonly id: string
  readonly title: string
  readonly counts: GameEvent
  readonly target: number
  readonly per: QuestPer
  readonly xp: number
  /** For `request-answered`: only answers given within this long count. */
  readonly withinMs?: number
}

export interface Season {
  readonly id: string
  readonly title: string
  /** Local dates, `YYYY-MM-DD`, inclusive. */
  readonly starts?: string
  readonly ends?: string
  readonly quests: readonly QuestSpec[]
}

export type QuestFileResult = { readonly ok: true; readonly season: Season } | { readonly ok: false; readonly line: number; readonly reason: string }

/** Quests that work without a file, so the layer has something to count from the first day. */
export const STARTER_QUESTS: readonly QuestSpec[] = [
  { id: "answer-requests", title: "Answer 5 requests", counts: "request-answered", target: 5, per: "day", xp: 20 },
  { id: "review-diffs", title: "Review 2 diffs before committing", counts: "diff-reviewed", target: 2, per: "day", xp: 30 },
  { id: "read-lessons", title: "Read 3 lessons", counts: "lesson-read", target: 3, per: "day", xp: 15 },
  { id: "fix-tests", title: "Get failing tests passing", counts: "tests-fixed", target: 1, per: "day", xp: 20 },
]

const FRONT_KEYS = new Set(["season", "title", "starts", "ends"])
const QUEST_KEYS = new Set(["counts", "target", "per", "xp", "within"])
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DURATION = /^(\d{1,5})(s|m|h)$/
const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 }
const MIN_WITHIN_MS = 10_000
const MAX_WITHIN_MS = 86_400_000
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/

class Reject extends Error {
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(reason)
  }
}

export function parseQuests(text: string): QuestFileResult {
  try {
    return { ok: true, season: parse(text) }
  } catch (error) {
    if (error instanceof Reject) return { ok: false, line: error.line, reason: error.reason }
    throw error
  }
}

function parse(text: string): Season {
  if (new TextEncoder().encode(text).length > MAX_QUEST_FILE_BYTES) throw new Reject(1, "The file is larger than 32 KB.")
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)
  lines.forEach((line, index) => {
    if (CONTROL.test(line)) throw new Reject(index + 1, "Control characters are not allowed.")
  })
  if (lines[0]?.trim() !== "---") throw new Reject(1, "The file must start with `---` and the season's front matter.")
  const front = new Map<string, string>()
  let index = 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line === "---") break
    if (line.length === 0) continue
    const [key, value] = pair(line, index + 1, "Front matter lines are `key: value`.")
    if (!FRONT_KEYS.has(key)) throw new Reject(index + 1, `Unknown front matter key \`${key}\`. Use season, title, starts, or ends.`)
    if (front.has(key)) throw new Reject(index + 1, `\`${key}\` is set twice.`)
    front.set(key, value)
  }
  if (index >= lines.length) throw new Reject(lines.length, "The front matter never ends: close it with `---`.")
  const closing = index + 1
  const season = front.get("season")
  if (season === undefined) throw new Reject(closing, "The front matter needs a `season`.")
  if (!SLUG.test(season)) throw new Reject(lineOf(lines, "season"), "`season` is lower-case letters, digits, and hyphens, at most 48.")
  const title = front.get("title")
  if (title === undefined) throw new Reject(closing, "The front matter needs a `title`.")
  if (title.length > MAX_TITLE) throw new Reject(lineOf(lines, "title"), `\`title\` is at most ${String(MAX_TITLE)} characters.`)
  const starts = date(front.get("starts"), lineOf(lines, "starts"), "starts")
  const ends = date(front.get("ends"), lineOf(lines, "ends"), "ends")
  if (starts !== undefined && ends !== undefined && starts > ends) throw new Reject(lineOf(lines, "ends"), "`ends` comes before `starts`.")

  const quests: QuestSpec[] = []
  let current: { readonly line: number; readonly title: string; readonly values: Map<string, readonly [string, number]> } | undefined
  const finish = (): void => {
    if (current !== undefined) quests.push(quest(current.title, current.line, current.values, quests))
  }
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.length === 0) continue
    if (line.startsWith("## ")) {
      finish()
      const heading = line.slice(3).trim()
      if (heading.length > MAX_TITLE) throw new Reject(index + 1, `A quest title is at most ${String(MAX_TITLE)} characters.`)
      if (quests.length >= MAX_QUESTS) throw new Reject(index + 1, `A file sets at most ${String(MAX_QUESTS)} quests.`)
      if (quests.some((other) => other.title.toLowerCase() === heading.toLowerCase())) throw new Reject(index + 1, "Two quests have this title.")
      current = { line: index + 1, title: heading, values: new Map() }
      continue
    }
    if (!line.startsWith("- ")) throw new Reject(index + 1, "After the front matter, only `## Quest title` headings and `- key: value` lines are allowed.")
    if (current === undefined) throw new Reject(index + 1, "A quest's `- key: value` lines go under its `## Quest title` heading.")
    const [key, value] = pair(line.slice(2).trim(), index + 1, "Quest lines are `- key: value`.")
    if (!QUEST_KEYS.has(key)) throw new Reject(index + 1, `Unknown quest key \`${key}\`. Use counts, target, per, xp, or within.`)
    if (current.values.has(key)) throw new Reject(index + 1, `\`${key}\` is set twice.`)
    current.values.set(key, [value, index + 1])
  }
  finish()
  if (quests.length === 0) throw new Reject(lines.length, "The file sets no quests.")
  return { id: season, title, ...(starts === undefined ? {} : { starts }), ...(ends === undefined ? {} : { ends }), quests }
}

function quest(title: string, line: number, values: ReadonlyMap<string, readonly [string, number]>, earlier: readonly QuestSpec[]): QuestSpec {
  const need = (key: string): readonly [string, number] => {
    const value = values.get(key)
    if (value === undefined) throw new Reject(line, `"${title}" needs \`${key}\`.`)
    return value
  }
  const [counts, countsLine] = need("counts")
  if (!(GAME_EVENTS as readonly string[]).includes(counts)) throw new Reject(countsLine, `\`counts\` is one of ${GAME_EVENTS.join(", ")}.`)
  const target = whole(need("target"), 1, 100, "target")
  const [per, perLine] = need("per")
  if (per !== "day" && per !== "week" && per !== "season") throw new Reject(perLine, "`per` is day, week, or season.")
  const xp = whole(need("xp"), 5, 100, "xp")
  const within = values.get("within")
  let withinMs: number | undefined
  if (within !== undefined) {
    if (counts !== "request-answered") throw new Reject(within[1], "`within` is only for `request-answered`.")
    const match = DURATION.exec(within[0])
    withinMs = match === null ? undefined : Number(match[1]) * (UNIT_MS[match[2]!] ?? 0)
    if (withinMs === undefined || withinMs < MIN_WITHIN_MS || withinMs > MAX_WITHIN_MS) throw new Reject(within[1], "`within` is a time from 10s to 24h, such as 30s, 10m, or 2h.")
  }
  return { id: questId(title, earlier), title, counts: counts as GameEvent, target, per, xp, ...(withinMs === undefined ? {} : { withinMs }) }
}

function pair(line: string, number: number, reason: string): readonly [string, string] {
  const colon = line.indexOf(":")
  if (colon <= 0) throw new Reject(number, reason)
  const key = line.slice(0, colon).trim()
  const value = line.slice(colon + 1).trim()
  if (!/^[a-z]+$/.test(key) || value.length === 0) throw new Reject(number, reason)
  return [key, value]
}

function whole([value, line]: readonly [string, number], min: number, max: number, key: string): number {
  if (!/^\d{1,3}$/.test(value) || Number(value) < min || Number(value) > max) throw new Reject(line, `\`${key}\` is a whole number from ${String(min)} to ${String(max)}.`)
  return Number(value)
}

function date(value: string | undefined, line: number, key: string): string | undefined {
  if (value === undefined) return undefined
  const match = DATE.exec(value)
  const parsed = match === null ? undefined : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (parsed === undefined || parsed.toISOString().slice(0, 10) !== value) throw new Reject(line, `\`${key}\` is a date such as 2026-12-19.`)
  return value
}

/** The line a front matter key was written on, for its error. */
function lineOf(lines: readonly string[], key: string): number {
  const index = lines.findIndex((line, at) => at > 0 && line.trim().startsWith(`${key}:`))
  return index < 0 ? 1 : index + 1
}

function questId(title: string, earlier: readonly QuestSpec[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "quest"
  let id = base
  for (let suffix = 2; earlier.some((quest) => quest.id === id); suffix += 1) id = `${base}-${String(suffix)}`
  return id
}

/** A short content hash: any change to the file asks the person again. Not a security check. */
export function questHash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`
}
