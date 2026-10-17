import { beforeEach, describe, expect, test } from "bun:test"
import { defaultState } from "../src/app/persist"
import { acceptedSeasons, answerQuests, questPrompt, useQuestFiles, type QuestFile } from "../src/app/play"
import { readQuestFile } from "../src/app/questFiles"
import { MAX_QUESTS, parseQuests, QUEST_FILE, questHash, STARTER_QUESTS } from "../src/app/quests"
import { addProject, get, set } from "../src/app/store"
import { HostError, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

const VALID = `---
season: q4-onboarding
title: Ship safely
ends: 2026-12-19
---

## Review before you commit
- counts: diff-reviewed
- target: 5
- per: week
- xp: 50

## Keep threads unblocked
- counts: request-answered
- target: 10
- per: day
- xp: 20
- within: 10m
`

/** The valid file with one line replaced, or with lines added after the last quest. */
function edit(find: string, replace: string): string {
  expect(VALID.includes(find)).toBe(true)
  return VALID.replace(find, replace)
}

function rejected(text: string): { readonly line: number; readonly reason: string } {
  const result = parseQuests(text)
  if (result.ok) throw new Error("expected the file to be rejected")
  return { line: result.line, reason: result.reason }
}

describe("a quest file", () => {
  test("reads the season and its quests", () => {
    const result = parseQuests(VALID)
    expect(result).toEqual({
      ok: true,
      season: {
        id: "q4-onboarding",
        title: "Ship safely",
        ends: "2026-12-19",
        quests: [
          { id: "review-before-you-commit", title: "Review before you commit", counts: "diff-reviewed", target: 5, per: "week", xp: 50 },
          { id: "keep-threads-unblocked", title: "Keep threads unblocked", counts: "request-answered", target: 10, per: "day", xp: 20, withinMs: 600_000 },
        ],
      },
    })
  })

  test("takes Windows line endings and a byte order mark", () => {
    const result = parseQuests(`\uFEFF${VALID.replaceAll("\n", "\r\n")}`)
    expect(result.ok && result.season.quests.length).toBe(2)
  })

  test("each mistake rejects the whole file and names its line", () => {
    const cases: readonly (readonly [string, number, RegExp])[] = [
      [VALID.replace("---\n", "# Quests\n---\n"), 1, /must start with/],
      [edit("ends: 2026-12-19", "ends: 2026-12-19\nowner: me"), 5, /Unknown front matter key `owner`/],
      [edit("title: Ship safely", "title: Ship safely\ntitle: Again"), 4, /set twice/],
      [edit("season: q4-onboarding\n", ""), 4, /needs a `season`/],
      [edit("season: q4-onboarding", "season: Q4 Onboarding"), 2, /lower-case letters/],
      [edit("title: Ship safely\n", ""), 4, /needs a `title`/],
      [edit("title: Ship safely", `title: ${"x".repeat(81)}`), 3, /at most 80/],
      [edit("ends: 2026-12-19", "ends: 2026-02-30"), 4, /a date such as/],
      [edit("ends: 2026-12-19", "starts: 2026-12-20\nends: 2026-12-19"), 5, /comes before `starts`/],
      ["---\nseason: s\ntitle: T\n", 4, /never ends/],
      [edit("## Review before you commit", "Some words for the team\n\n## Review before you commit"), 7, /only `## Quest title` headings/],
      [edit("\n## Review before you commit", "\n- counts: commit\n## Review before you commit"), 7, /go under its `## Quest title` heading/],
      [edit("- xp: 50", "- xp: 50\n- reward: pizza"), 12, /Unknown quest key `reward`/],
      [edit("- xp: 50", "- xp: 50\n- xp: 60"), 12, /set twice/],
      [edit("- xp: 50\n", ""), 7, /"Review before you commit" needs `xp`/],
      [edit("- counts: diff-reviewed", "- counts: lines-written"), 8, /`counts` is one of/],
      [edit("- target: 5", "- target: 0"), 9, /whole number from 1 to 100/],
      [edit("- target: 5", "- target: 101"), 9, /whole number from 1 to 100/],
      [edit("- target: 5", "- target: five"), 9, /whole number from 1 to 100/],
      [edit("- per: week", "- per: month"), 10, /day, week, or season/],
      [edit("- xp: 50", "- xp: 4"), 11, /whole number from 5 to 100/],
      [edit("- xp: 50", "- xp: 500"), 11, /whole number from 5 to 100/],
      [edit("- xp: 50", "- xp: 50\n- within: 10m"), 12, /only for `request-answered`/],
      [edit("- within: 10m", "- within: 5s"), 18, /from 10s to 24h/],
      [edit("- within: 10m", "- within: 25h"), 18, /from 10s to 24h/],
      [edit("- within: 10m", "- within: soon"), 18, /from 10s to 24h/],
      [edit("## Keep threads unblocked", "## review BEFORE you commit"), 13, /Two quests have this title/],
      [edit("## Keep threads unblocked", "##"), 13, /only `## Quest title` headings/],
      [edit("## Keep threads unblocked", "## "), 13, /only `## Quest title` headings/],
      [edit("title: Ship safely", "title: Ship\u0007 safely"), 3, /Control characters/],
    ]
    for (const [text, line, reason] of cases) {
      const result = rejected(text)
      expect({ text, line: result.line }).toEqual({ text, line })
      expect(result.reason).toMatch(reason)
    }
  })

  test("is bounded in size and in quests", () => {
    expect(rejected(`${VALID}${"\n".repeat(33 * 1024)}`)).toEqual({ line: 1, reason: "The file is larger than 32 KB." })
    const quest = (n: number): string => `## Quest ${String(n)}\n- counts: commit\n- target: 1\n- per: day\n- xp: 5\n`
    const many = `---\nseason: s\ntitle: Many\n---\n${Array.from({ length: MAX_QUESTS + 1 }, (_, n) => quest(n)).join("\n")}`
    expect(rejected(many)).toMatchObject({ reason: "A file sets at most 20 quests." })
    expect(parseQuests(`---\nseason: s\ntitle: Many\n---\n${Array.from({ length: MAX_QUESTS }, (_, n) => quest(n)).join("\n")}`).ok).toBe(true)
    expect(rejected("---\nseason: s\ntitle: Empty\n---\n")).toMatchObject({ reason: "The file sets no quests." })
  })

  test("keeps markup-shaped titles as plain text", () => {
    const titles = ['<img src=x onerror="alert(1)">', "**Bold** and [a link](javascript:alert(1))", "{{constructor}} ${process.env.HOME}"]
    for (const title of titles) {
      const result = parseQuests(edit("## Review before you commit", `## ${title}`))
      expect(result.ok && result.season.quests[0]?.title).toBe(title)
    }
  })

  test("starter quests are well formed and ask for outcomes, not volume", () => {
    for (const quest of STARTER_QUESTS) {
      expect(quest.xp).toBeGreaterThanOrEqual(5)
      expect(quest.xp).toBeLessThanOrEqual(100)
      expect(quest.target).toBeGreaterThanOrEqual(1)
    }
    expect(new Set(STARTER_QUESTS.map((quest) => quest.id)).size).toBe(STARTER_QUESTS.length)
  })
})

function file(text: string, localEdits = false): QuestFile {
  return { hash: questHash(text), text, result: parseQuests(text), localEdits }
}

describe("asking about a repository's quests", () => {
  beforeEach(() => {
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    useQuestFiles.setState({}, true)
  })

  test("asks once per version of the file, and says when a file has a problem", () => {
    const first = file(VALID)
    expect(questPrompt("p1", first, {})).toBe("ask")
    useQuestFiles.setState({ p1: first })
    answerQuests("p1", true)
    expect(questPrompt("p1", first, get().game.seasons)).toBeUndefined()
    // Any change to the content asks again.
    const changed = file(VALID.replace("- target: 5", "- target: 6"))
    expect(questPrompt("p1", changed, get().game.seasons)).toBe("ask")
    expect(questPrompt("p1", file("not a quest file"), get().game.seasons)).toBe("invalid")
    expect(questPrompt("p1", null, get().game.seasons)).toBeUndefined()
  })

  test("accepted quests count while the file is unchanged; a changed or removed file stops them", () => {
    const accepted = file(VALID)
    useQuestFiles.setState({ p1: accepted })
    answerQuests("p1", true)
    const seasons = get().game.seasons
    expect(seasons.p1).toEqual({ season: "q4-onboarding", hash: accepted.hash, accepted: true, text: VALID })
    expect(acceptedSeasons(seasons, {}).get("p1")?.quests).toHaveLength(2)
    expect(acceptedSeasons(seasons, { p1: accepted }).has("p1")).toBe(true)
    expect(acceptedSeasons(seasons, { p1: file(VALID.replace("- xp: 50", "- xp: 60")) }).has("p1")).toBe(false)
    expect(acceptedSeasons(seasons, { p1: null }).has("p1")).toBe(false)
    answerQuests("p1", false)
    expect(get().game.seasons.p1).toEqual({ season: "q4-onboarding", hash: accepted.hash, accepted: false })
    expect(acceptedSeasons(get().game.seasons, {}).has("p1")).toBe(false)
  })

  test("reads the file from the project's working tree, with local edits from git", async () => {
    let content: string | undefined = VALID
    let changed = true
    let refusal: string | undefined
    const calls: string[] = []
    const host = createFakeHost({})
    setHost({
      ...host,
      rpc: async (engineId, method, params) => {
        calls.push(`${method}${method === "workspace.read" ? ` ${String((params as { path?: unknown }).path)}` : ""}`)
        if (method === "workspace.read") {
          if (refusal !== undefined) throw new HostError(refusal, "workspace read was refused")
          if (content === undefined) throw new HostError("CONTROL_WORKSPACE_NOT_FOUND", "workspace path was not found")
          return { path: QUEST_FILE, bytes: content.length, content }
        }
        if (method === "git.diff") return { scope: "head", files: changed ? [{ path: QUEST_FILE, change: "modified", additions: 1, deletions: 0, patch: "" }] : [], totals: { files: changed ? 1 : 0, additions: changed ? 1 : 0, deletions: 0 }, truncated: false }
        return host.rpc(engineId, method, params)
      },
    })
    set({ prefs: { ...get().prefs, officeMode: "office" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    await readQuestFile("p1", true)
    expect(calls).toContain(`workspace.read ${QUEST_FILE}`)
    expect(useQuestFiles.getState().p1).toMatchObject({ hash: questHash(VALID), localEdits: true, result: { ok: true } })
    // Read again within a minute: nothing is asked of the engine.
    const before = calls.length
    await readQuestFile("p1")
    expect(calls.length).toBe(before)
    changed = false
    content = undefined
    await readQuestFile("p1", true)
    expect(useQuestFiles.getState().p1).toBeNull()
    content = `${VALID}${" ".repeat(33 * 1024)}`
    await readQuestFile("p1", true)
    expect(useQuestFiles.getState().p1?.result).toEqual({ ok: false, line: 1, reason: "The file is larger than 32 KB." })
    // The engine refuses a file over its limit without sending it, and one that is not text.
    refusal = "CONTROL_WORKSPACE_LIMIT"
    await readQuestFile("p1", true)
    expect(useQuestFiles.getState().p1?.result).toEqual({ ok: false, line: 1, reason: "The file is larger than 32 KB." })
    refusal = "CONTROL_WORKSPACE_BINARY"
    await readQuestFile("p1", true)
    expect(useQuestFiles.getState().p1?.result).toEqual({ ok: false, line: 1, reason: "The file is not text." })
    // Any other failure keeps what was read before.
    refusal = "CONTROL_WORKSPACE_FORBIDDEN"
    await readQuestFile("p1", true)
    expect(useQuestFiles.getState().p1?.result).toEqual({ ok: false, line: 1, reason: "The file is not text." })
  })

  test("reads nothing while the game layer is off", async () => {
    const calls: string[] = []
    const host = createFakeHost({})
    setHost({ ...host, rpc: async (engineId, method, params) => (calls.push(method), host.rpc(engineId, method, params)) })
    set({ prefs: { ...get().prefs, officeMode: "office", game: false } })
    addProject({ id: "p2", path: "/code/other", name: "other", git: true, addedAt: 1 })
    await readQuestFile("p2", true)
    expect(calls).toEqual([])
  })
})
