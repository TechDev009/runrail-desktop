import { beforeEach, describe, expect, test } from "bun:test"
import { useActivity } from "../src/app/activity"
import { resolveApproval } from "../src/app/engines"
import { activeQuests, applyGameEvent, DAY_XP_CAP, dayKey, levelOf, levelProgress, levelStart, median, questViews, rankOf, reviewedAll, shiftStats, testsFixed, weekKey, type ActiveQuest, type Award } from "../src/app/game"
import { lessonDismissed, lessonOpened } from "../src/app/learning"
import { defaultState, EMPTY_GAME, parseState, type Game, type GameEvent } from "../src/app/persist"
import { noteCommit, noteRescue, noteTimeline, noteTurnEnd, recordGame } from "../src/app/play"
import type { Season } from "../src/app/quests"
import { addProject, createThread, get, patchRuntime, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, type Timeline } from "../src/thread/reducer"

/** A local time on a date, so a day is the person's day whatever the zone. */
function on(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime()
}

function quest(fields: Partial<ActiveQuest> & Pick<ActiveQuest, "key" | "counts">): ActiveQuest {
  return { id: fields.key, title: fields.key, target: 1, per: "day", xp: 10, ...fields }
}

interface Played {
  readonly kind: GameEvent
  readonly at: number
  readonly projectId?: string
  readonly waitedMs?: number
}

function play(game: Game, events: readonly Played[], quests: readonly ActiveQuest[]): { readonly game: Game; readonly awards: readonly Award[] } {
  let current = game
  const awards: Award[] = []
  for (const event of events) {
    const step = applyGameEvent(current, { projectId: "p1", ...event }, quests)
    current = step.game
    awards.push(...step.awards)
  }
  return { game: current, awards }
}

describe("levels", () => {
  test("each level takes 100 XP more than the one before, and has a rank", () => {
    expect([1, 2, 3, 4, 5].map(levelStart)).toEqual([0, 100, 300, 600, 1000])
    expect([0, 99, 100, 299, 300, 599, 600].map(levelOf)).toEqual([1, 1, 2, 2, 3, 3, 4])
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map(rankOf)).toEqual(["Intern", "Junior", "Junior", "Regular", "Senior", "Senior", "Shift lead", "Floor manager", "Office lead", "Office lead"])
    expect(levelProgress(150)).toEqual({ level: 2, rank: "Junior", into: 50, span: 200 })
  })
})

describe("the ledger", () => {
  test("a daily quest pays once a day and starts again the next day", () => {
    const answers = quest({ key: "starter/answer", counts: "request-answered", target: 3, xp: 20 })
    const monday = on(2026, 10, 5, 9)
    const first = play(EMPTY_GAME, [0, 1, 2, 3].map((n) => ({ kind: "request-answered", at: monday + n * 60_000 })), [answers])
    expect(first.awards).toEqual([{ key: "starter/answer", title: "starter/answer", xp: 20 }])
    expect(first.game.xp).toBe(20)
    expect(first.game.progress["starter/answer"]).toEqual({ period: "2026-10-05", count: 3, done: true })
    // Every answer is counted for the report; the quest stops at its target.
    expect(first.game.days["2026-10-05"]?.counts["request-answered"]).toBe(4)
    const tuesday = on(2026, 10, 6, 9)
    expect(questViews(first.game, [answers], tuesday)[0]).toMatchObject({ count: 0, done: false })
    const second = play(first.game, [0, 1, 2].map((n) => ({ kind: "request-answered", at: tuesday + n })), [answers])
    expect(second.awards).toHaveLength(1)
    expect(second.game.xp).toBe(40)
  })

  test("weeks are ISO weeks of the local date", () => {
    expect(weekKey(on(2026, 10, 5))).toBe("2026-W41")
    expect(weekKey(on(2026, 10, 11, 23))).toBe("2026-W41")
    expect(weekKey(on(2026, 10, 12, 0))).toBe("2026-W42")
    expect(weekKey(on(2025, 12, 29))).toBe("2026-W01")
    expect(weekKey(on(2026, 12, 31))).toBe("2026-W53")
    expect(weekKey(on(2027, 1, 1))).toBe("2026-W53")
    expect(weekKey(on(2027, 1, 4))).toBe("2027-W01")
    expect(dayKey(on(2026, 10, 5, 0))).toBe("2026-10-05")
    expect(dayKey(on(2026, 10, 5, 23))).toBe("2026-10-05")
  })

  test("a weekly quest counts across its week and starts again the next", () => {
    const reviews = quest({ key: "p1/q4/reviews", counts: "diff-reviewed", target: 3, per: "week", xp: 50 })
    const week = play(EMPTY_GAME, [on(2026, 10, 5), on(2026, 10, 7), on(2026, 10, 11)].map((at) => ({ kind: "diff-reviewed", at })), [reviews])
    expect(week.awards.map((award) => award.xp)).toEqual([50])
    expect(week.game.progress["p1/q4/reviews"]).toEqual({ period: "2026-W41", count: 3, done: true })
    const next = play(week.game, [{ kind: "diff-reviewed", at: on(2026, 10, 12) }], [reviews])
    expect(next.awards).toEqual([])
    expect(next.game.progress["p1/q4/reviews"]).toEqual({ period: "2026-W42", count: 1, done: false })
  })

  test("a season quest pays once for the whole season", () => {
    const ship = quest({ key: "p1/q4/ship", counts: "pr-opened", target: 2, per: "season", xp: 80, projectId: "p1", season: { id: "q4", title: "Q4" } })
    const season = play(EMPTY_GAME, [on(2026, 10, 5), on(2026, 10, 20), on(2026, 11, 2), on(2026, 11, 30)].map((at) => ({ kind: "pr-opened", at })), [ship])
    expect(season.awards.map((award) => award.xp)).toEqual([80])
    expect(season.game.progress["p1/q4/ship"]).toEqual({ period: "season:q4", count: 2, done: true })
  })

  test("a day pays at most 500 XP; quests past the cap still finish", () => {
    const quests = Array.from({ length: 7 }, (_, n) => quest({ key: `p1/q4/q${String(n)}`, counts: "commit", xp: 100 }))
    const step = applyGameEvent(EMPTY_GAME, { kind: "commit", projectId: "p1", at: on(2026, 10, 5) }, quests)
    expect(step.awards.map((award) => award.xp)).toEqual([100, 100, 100, 100, 100, 0, 0])
    expect(step.game.xp).toBe(DAY_XP_CAP)
    expect(step.game.days["2026-10-05"]).toMatchObject({ xp: DAY_XP_CAP })
    expect(step.game.days["2026-10-05"]?.quests).toHaveLength(7)
    expect(step.level).toBe(3)
    const next = applyGameEvent(step.game, { kind: "commit", projectId: "p1", at: on(2026, 10, 6) }, quests)
    expect(next.game.xp).toBe(2 * DAY_XP_CAP)
    expect(next.level).toBe(5)
    // No new level, no level in the step.
    expect(applyGameEvent(next.game, { kind: "commit", projectId: "p1", at: on(2026, 10, 6) }, quests).level).toBeUndefined()
  })

  test("a project's quests count only that project's outcomes", () => {
    const own = quest({ key: "p1/q4/commit", counts: "commit", projectId: "p1" })
    expect(play(EMPTY_GAME, [{ kind: "commit", at: on(2026, 10, 5), projectId: "p2" }], [own]).awards).toEqual([])
    expect(play(EMPTY_GAME, [{ kind: "commit", at: on(2026, 10, 5), projectId: "p1" }], [own]).awards).toHaveLength(1)
  })

  test("a quest with `within` counts only answers given in time", () => {
    const quick = quest({ key: "p1/q4/quick", counts: "request-answered", withinMs: 600_000 })
    const at = on(2026, 10, 5)
    expect(play(EMPTY_GAME, [{ kind: "request-answered", at, waitedMs: 600_001 }], [quick]).awards).toEqual([])
    expect(play(EMPTY_GAME, [{ kind: "request-answered", at }], [quick]).awards).toEqual([])
    expect(play(EMPTY_GAME, [{ kind: "request-answered", at, waitedMs: 600_000 }], [quick]).awards).toHaveLength(1)
  })

  test("a season is on from its first day to its last, both included", () => {
    const season: Season = { id: "q4", title: "Q4", starts: "2026-10-05", ends: "2026-10-09", quests: [{ id: "ship", title: "Ship", counts: "commit", target: 1, per: "season", xp: 50 }] }
    const keys = (at: number): readonly string[] => activeQuests(new Map([["p1", season]]), at).map((active) => active.key)
    expect(keys(on(2026, 10, 4, 23))).not.toContain("p1/q4/ship")
    expect(keys(on(2026, 10, 5, 0))).toContain("p1/q4/ship")
    expect(keys(on(2026, 10, 9, 23))).toContain("p1/q4/ship")
    expect(keys(on(2026, 10, 10, 0))).not.toContain("p1/q4/ship")
    expect(keys(on(2026, 10, 4)).filter((key) => key.startsWith("starter/"))).toHaveLength(4)
    expect(activeQuests(new Map([["p1", season]]), on(2026, 10, 6)).find((active) => active.key === "p1/q4/ship")).toMatchObject({ projectId: "p1", season: { id: "q4", title: "Q4" } })
  })

  test("the shift report counts the day's outcomes and the median wait", () => {
    const at = on(2026, 10, 5)
    const events: Played[] = [
      ...[10_000, 30_000, 20_000, 40_000].map((waitedMs) => ({ kind: "request-answered" as const, at, waitedMs })),
      { kind: "diff-reviewed", at },
      { kind: "commit", at },
      { kind: "push", at },
      { kind: "tests-fixed", at },
    ]
    const { game } = play(EMPTY_GAME, events, [quest({ key: "starter/fix", counts: "tests-fixed", xp: 20 })])
    expect(shiftStats(game, at)).toEqual({ xp: 20, answered: 4, medianWaitMs: 25_000, reviewed: 1, commits: 1, pushes: 1, prs: 0, lessons: 0, rescued: 0, testsFixed: 1, questsDone: 1 })
    expect(shiftStats(game, on(2026, 10, 6))).toEqual({ xp: 0, answered: 0, reviewed: 0, commits: 0, pushes: 0, prs: 0, lessons: 0, rescued: 0, testsFixed: 0, questsDone: 0 })
    expect([median([]), median([3, 1, 2]), median([4, 1])]).toEqual([undefined, 2, 3])
  })

  test("keeps the last 30 days", () => {
    const days = Array.from({ length: 35 }, (_, n) => ({ kind: "commit" as const, at: on(2026, 9, 1 + n) }))
    const kept = Object.keys(play(EMPTY_GAME, days, []).game.days)
    expect(kept).toHaveLength(30)
    expect(kept[0]).toBe(dayKey(on(2026, 9, 6)))
  })

  test("a commit is reviewed only when every file it takes was viewed", () => {
    expect(reviewedAll(["a.ts", "b.ts"], ["b.ts", "a.ts", "c.ts"])).toBe(true)
    expect(reviewedAll(["a.ts", "b.ts"], ["a.ts"])).toBe(false)
    expect(reviewedAll([], ["a.ts"])).toBe(false)
  })
})

let seq = 0
const base = Date.now() - 60_000
function event(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: base + seq, type, ...fields } }
}

function frames(list: readonly StreamFrame[]): Timeline {
  return applyFrames(emptyTimeline(), list)
}

function today(): Game["days"][string] | undefined {
  return get().game.days[dayKey(Date.now())]
}

function count(kind: GameEvent): number {
  return today()?.counts[kind] ?? 0
}

describe("outcomes the app confirmed", () => {
  beforeEach(() => {
    setHost(createFakeHost({}))
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    set({ prefs: { ...get().prefs, officeMode: "office" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    useActivity.setState({}, true)
  })

  test("approving and denying a request earn the same; one the engine no longer had earns nothing", async () => {
    const thread = createThread({ projectId: "p1", backend: "native" })
    const resolved: string[] = []
    const fake = createFakeHost({})
    setHost({
      ...fake,
      rpc: async (engineId, method, params) => {
        if (method !== "approval.resolve") return fake.rpc(engineId, method, params)
        const id = String((params as { approvalId?: unknown }).approvalId)
        resolved.push(id)
        return id === "gone" ? false : {}
      },
    })
    const ids = ["a1", "a2", "a3", "a4", "a5", "gone"]
    patchRuntime(thread.id, {
      engine: "ready",
      engineId: "e1",
      timeline: frames([event("turn.started", { turnId: "t1", prompt: "go" }), ...ids.map((approvalId) => event("approval.required", { turnId: "t1", approvalId, action: "bun test", capability: "shell" }))]),
    })
    await resolveApproval(thread.id, "a1", true)
    await resolveApproval(thread.id, "a2", false, "not now")
    expect(count("request-answered")).toBe(2)
    // The same card answered twice counts once.
    await resolveApproval(thread.id, "a2", false)
    await resolveApproval(thread.id, "gone", true)
    expect(count("request-answered")).toBe(2)
    expect(resolved).toEqual(["a1", "a2", "a2", "gone"])
    await resolveApproval(thread.id, "a3", false)
    await resolveApproval(thread.id, "a4", false)
    await resolveApproval(thread.id, "a5", true)
    expect(count("request-answered")).toBe(5)
    expect(get().game.progress["starter/answer-requests"]).toMatchObject({ count: 5, done: true })
    expect(get().game.xp).toBe(20)
    expect(get().toasts.map((item) => item.text)).toContain("Quest done: Answer 5 requests, +20 XP")
    // Each wait is how long the card had been asked, not how long the test took.
    expect(today()?.answerMs).toHaveLength(5)
    for (const wait of today()?.answerMs ?? []) expect(wait).toBeGreaterThanOrEqual(59_000)
  })

  test("a commit counts, and counts as reviewed only when every file it takes was viewed", () => {
    const thread = createThread({ projectId: "p1", backend: "native" })
    noteCommit(thread.id, ["a.ts", "b.ts"], ["a.ts"])
    expect([count("commit"), count("diff-reviewed")]).toEqual([1, 0])
    noteCommit(thread.id, ["a.ts", "b.ts"], ["b.ts", "a.ts", "c.ts"])
    expect([count("commit"), count("diff-reviewed")]).toEqual([2, 1])
    noteCommit(thread.id, [], [])
    expect([count("commit"), count("diff-reviewed")]).toEqual([3, 1])
  })

  test("a lesson counts the first time it is read", () => {
    const thread = createThread({ projectId: "p1", backend: "native" })
    lessonOpened(thread.id, "row-1", "standard", "test")
    lessonOpened(thread.id, "row-2", "standard", "test")
    expect(count("lesson-read")).toBe(1)
    // Dismissed at a glance is not read; dismissed after reading is.
    lessonDismissed(thread.id, "standard", "build", 500)
    expect(count("lesson-read")).toBe(1)
    lessonDismissed(thread.id, "standard", "lint", 10_000)
    expect(count("lesson-read")).toBe(2)
  })

  test("a test run that passes after a failing one counts once; history and unchecked engines never do", () => {
    const thread = createThread({ projectId: "p1", backend: "native" })
    const run = (callId: string, intent?: "test"): StreamFrame => event("tool.started", { turnId: "t1", callId, name: "run_command", presentation: { kind: "shell", title: "bun test", command: "bun test", ...(intent === undefined ? {} : { intent }) } })
    const end = (callId: string, ok: boolean): StreamFrame => event("tool.completed", { turnId: "t1", callId, name: "run_command", ok, ...(ok ? {} : { error: { code: "COMMAND_FAILED", message: "command exited with status 1" } }) })
    const failing = frames([event("turn.started", { turnId: "t1", prompt: "fix" }), run("c1", "test"), end("c1", false), run("c2", "test")])
    const passed = applyFrames(failing, [end("c2", true)])
    const fixedRow = passed.items.find((item) => item.kind === "tool" && item.callId === "c2")?.key
    expect(testsFixed(failing, passed)).toEqual([fixedRow ?? "missing"])
    noteTimeline(thread.id, failing, passed)
    noteTimeline(thread.id, failing, passed)
    expect(count("tests-fixed")).toBe(1)
    expect(get().game.progress["starter/fix-tests"]).toMatchObject({ count: 1, done: true })
    // Passing again after a pass is not a fix.
    const again = applyFrames(passed, [run("c3", "test")])
    expect(testsFixed(again, applyFrames(again, [end("c3", true)]))).toEqual([])
    // A timeline rebuilt from history never saw the row running.
    expect(testsFixed(emptyTimeline(), passed)).toEqual([])
    // A failed command that is not a test run does not make the next pass a fix.
    const other = frames([event("turn.started", { turnId: "t1", prompt: "fix" }), run("d1"), end("d1", false), run("d2", "test")])
    expect(testsFixed(other, applyFrames(other, [end("d2", true)]))).toEqual([])
    // Pi and ACP tools report what each tool says; their failures were not checked.
    const pi = createThread({ projectId: "p1", backend: "pi" })
    noteTimeline(pi.id, failing, passed)
    expect(count("tests-fixed")).toBe(1)
  })

  test("steering a quiet thread counts once a later turn completes", () => {
    const quiet = createThread({ projectId: "p1", backend: "native" })
    patchRuntime(quiet.id, { timeline: frames([event("turn.started", { turnId: "t1", prompt: "go" })]) })
    useActivity.setState({ [quiet.id]: Date.now() - 10 * 60_000 })
    noteRescue(quiet.id)
    // Stopping the quiet turn itself waits for the turn after it.
    noteTurnEnd(quiet.id, { turnId: "t1", status: "stopped" })
    expect(count("quiet-rescued")).toBe(0)
    noteTurnEnd(quiet.id, { turnId: "t2", status: "completed" })
    expect(count("quiet-rescued")).toBe(1)
    noteTurnEnd(quiet.id, { turnId: "t3", status: "completed" })
    expect(count("quiet-rescued")).toBe(1)

    // A thread that was not quiet is not rescued, and a rescue whose next turn fails earns nothing.
    const busy = createThread({ projectId: "p1", backend: "native" })
    patchRuntime(busy.id, { timeline: frames([event("turn.started", { turnId: "t1", prompt: "go" })]) })
    useActivity.setState({ [busy.id]: Date.now() - 1_000 })
    noteRescue(busy.id)
    noteTurnEnd(busy.id, { turnId: "t2", status: "completed" })
    const failed = createThread({ projectId: "p1", backend: "native" })
    patchRuntime(failed.id, { timeline: frames([event("turn.started", { turnId: "t1", prompt: "go" })]) })
    useActivity.setState({ [failed.id]: Date.now() - 10 * 60_000 })
    noteRescue(failed.id)
    noteTurnEnd(failed.id, { turnId: "t2", status: "failed" })
    noteTurnEnd(failed.id, { turnId: "t3", status: "completed" })
    expect(count("quiet-rescued")).toBe(1)
  })

  test("a quest that reaches a level says so", () => {
    const thread = createThread({ projectId: "p1", backend: "native" })
    set({ game: { ...EMPTY_GAME, xp: 90 } })
    recordGame("tests-fixed", thread.id)
    expect(get().game.xp).toBe(110)
    expect(get().toasts.map((item) => item.text)).toEqual(["Quest done: Get failing tests passing, +20 XP", "Level 2: Junior"])
  })

  test("nothing is counted while the game layer is off", () => {
    const thread = createThread({ projectId: "p1", backend: "native" })
    set({ prefs: { ...get().prefs, officeMode: "off" } })
    recordGame("commit", thread.id)
    expect(get().game).toEqual(EMPTY_GAME)
    set({ prefs: { ...get().prefs, officeMode: "office", game: false } })
    recordGame("commit", thread.id)
    expect(get().game).toEqual(EMPTY_GAME)
    // Its level and quests live on the floor, so it is off without office mode whatever the switch says.
    set({ prefs: { ...get().prefs, officeMode: "off", game: true } })
    recordGame("commit", thread.id)
    expect(get().game).toEqual(EMPTY_GAME)
    set({ prefs: { ...get().prefs, officeMode: "list", game: undefined } })
    recordGame("commit", thread.id)
    expect(count("commit")).toBe(1)
    recordGame("commit", "th-missing")
    expect(count("commit")).toBe(1)
  })
})

describe("the saved ledger", () => {
  const saved = (game: unknown): Game => parseState({ version: 1, projects: [], threads: [], prefs: {}, layout: {}, game }).game

  const game: Game = {
    xp: 140,
    days: { "2026-10-05": { xp: 40, counts: { commit: 2, "request-answered": 5 }, answerMs: [1_000, 2_000], quests: ["starter/answer-requests"] } },
    progress: { "starter/answer-requests": { period: "2026-10-05", count: 5, done: true } },
    seasons: { p1: { season: "q4", hash: "0123456789abcdef", accepted: true, text: "---" } },
  }

  test("reads back what was saved", () => {
    expect(saved(JSON.parse(JSON.stringify(game)))).toEqual(game)
    expect(saved(undefined)).toEqual(EMPTY_GAME)
  })

  test("drops what is malformed entry by entry, and keeps the last 30 days", () => {
    const day = game.days["2026-10-05"]
    const messy = saved({
      xp: -5,
      days: { ...game.days, yesterday: day, "2026-10-06": { xp: "lots", counts: { commit: -1 }, answerMs: "slow", quests: ["ok/key", "bad key"] } },
      progress: { ...game.progress, "bad key": { period: "2026-10-05", count: 1, done: true }, "starter/x": { period: "2026-10-05", count: -1, done: true } },
      seasons: { ...game.seasons, p2: { season: "q4", hash: "not-hex", accepted: true } },
    })
    expect(messy.xp).toBe(0)
    expect(messy.days).toEqual({ "2026-10-05": day, "2026-10-06": { xp: 0, counts: {}, answerMs: [], quests: [] } })
    expect(Object.keys(messy.progress)).toEqual(["starter/answer-requests"])
    expect(Object.keys(messy.seasons)).toEqual(["p1"])
    const many = Object.fromEntries(Array.from({ length: 35 }, (_, n) => [dayKey(on(2026, 9, 1 + n)), day]))
    const kept = Object.keys(saved({ ...game, days: many }).days)
    expect(kept).toHaveLength(30)
    expect(kept[0]).toBe(dayKey(on(2026, 9, 6)))
  })
})
