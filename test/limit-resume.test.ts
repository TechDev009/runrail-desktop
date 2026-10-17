import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, send } from "../src/app/engines"
import { continueAfterReset, CONTINUE_PROMPT, initLimitResume, openLimit, readLimitMessage, repeatsMessage, resetFromPlan, RESUME_DELAY_MS } from "../src/app/limitResume"
import { defaultState, parseState } from "../src/app/persist"
import { stayLines, stayReasons } from "../src/app/stayRunning"
import { addProject, createThread, get, patchRuntime, patchThread, runtimeOf, set, setPrefs, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { emptyTimeline, type NoticeItem, type TimelineItem } from "../src/thread/reducer"

/** Continue when a usage limit resets. */

const notice = (key: string, message?: string): NoticeItem => ({ kind: "notice", key, level: "error", code: "COMMAND_AGENT_RATE_LIMITED", ...(message === undefined ? {} : { message }), at: 1 })
const user = (key: string, text: string): TimelineItem => ({ kind: "user", key, text, attachments: 0, state: "sent", turnId: key, at: 1 })
const end = (turnId: string): TimelineItem => ({ kind: "turn-end", key: `e.${turnId}`, turnId, status: "failed", startedAt: 1, endedAt: 2 })

async function until(done: () => boolean, tries = 2_000): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

test("the reset is read from the engine's words, which the card shows without it", () => {
  expect(readLimitMessage("Claude Code five-hour usage limit reached. Resets at 2026-10-10T15:40:00.000Z.")).toEqual({ text: "Claude Code five-hour usage limit reached.", resetAt: Date.parse("2026-10-10T15:40:00.000Z") })
  expect(readLimitMessage("Codex weekly usage limit reached.")).toEqual({ text: "Codex weekly usage limit reached." })
  expect(readLimitMessage("Limit reached. Resets at not-a-date.").resetAt).toBeUndefined()
  expect(readLimitMessage(undefined).text).toBe("The usage limit was reached.")
})

test("without it, the plan's full windows say when, the latest of them counting", () => {
  const now = 1_000_000
  const limits = {
    "claude-code": { at: now, windows: [{ id: "five-hour" as const, usedPercent: 100, resetsAt: now + 60_000 }, { id: "weekly" as const, usedPercent: 100, resetsAt: now + 600_000 }, { id: "weekly-opus" as const, usedPercent: 40, resetsAt: now + 900_000 }] },
    "claude-code:work": { at: now, windows: [{ id: "five-hour" as const, usedPercent: 100, resetsAt: now + 30_000 }] },
    codex: { at: now, windows: [{ id: "primary" as const, usedPercent: 99, resetsAt: now + 60_000 }] },
  }
  expect(resetFromPlan(limits, "claude-code", undefined, now)).toBe(now + 600_000)
  expect(resetFromPlan(limits, "claude-code", "work", now)).toBe(now + 30_000)
  expect(resetFromPlan(limits, "claude-code", "other", now)).toBe(now + 600_000)
  expect(resetFromPlan(limits, "codex", undefined, now)).toBeUndefined()
  expect(resetFromPlan(limits, "claude-code", undefined, now + 700_000)).toBeUndefined()
  expect(resetFromPlan(limits, undefined, undefined, now)).toBeUndefined()
})

test("only the last limit, with no message after it, is open", () => {
  const first = notice("n1")
  const last = notice("n2")
  expect(openLimit([user("u1", "a"), end("u1"), first, user("u2", "b"), end("u2"), last])?.key).toBe("n2")
  expect(openLimit([user("u1", "a"), end("u1"), first, user("u2", "b")])).toBeUndefined()
})

test("a wait is saved with the thread, and a bad one is dropped", () => {
  const thread = { id: "t1", projectId: "p1", title: "x", titled: true, createdAt: 1, updatedAt: 1, backend: "native", mode: "agent", permission: "ask" }
  const kept = parseState({ ...defaultState(), projects: [{ id: "p1", path: "/a", name: "a", git: false, addedAt: 1 }], threads: [{ ...thread, resume: { at: 5_000, again: true } }] })
  expect(kept.threads[0]?.resume).toEqual({ at: 5_000, again: true })
  const dropped = parseState({ ...defaultState(), projects: [{ id: "p1", path: "/a", name: "a", git: false, addedAt: 1 }], threads: [{ ...thread, resume: { at: "soon" } }] })
  expect(dropped.threads[0]?.resume).toBeUndefined()
  expect(parseState({ ...defaultState(), prefs: { ...defaultState().prefs, continueAfterLimit: "yes" } }).prefs.continueAfterLimit).toBe(false)
})

test("while a thread waits, Runrail stays in the menu bar and says so", () => {
  const input = { runtime: {}, workflowRuns: [], setupRuns: [], evalRuns: [], sources: false, limitWaits: 1 }
  expect(stayReasons(input)).toEqual(["limit-wait"])
  expect(stayLines(input, 0)[0]).toBe("1 waiting for a usage limit")
  expect(stayReasons({ ...input, limitWaits: 0 })).toEqual([])
})

describe("continuing", () => {
  let stop: () => void = () => undefined

  beforeEach(() => {
    stop()
    setHost(createFakeHost({}))
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    const engines = initEngines()
    const resumes = initLimitResume(0)
    stop = () => {
      resumes()
      engines()
    }
  })

  async function limited() {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    send(thread.id, { text: "please hit the usage limit" })
    await until(() => openLimit(runtimeOf(thread.id).timeline.items) !== undefined)
    return { thread, card: openLimit(runtimeOf(thread.id).timeline.items) as NoticeItem }
  }

  test("a turn that got nothing back goes again with its message, 30 seconds after the reset", async () => {
    const { thread, card } = await limited()
    expect(repeatsMessage(thread.id, card)).toBe(true)
    const resetAt = readLimitMessage(card.message).resetAt as number
    continueAfterReset(thread.id, card, resetAt)
    expect(threadById(thread.id)?.resume).toEqual({ at: resetAt + RESUME_DELAY_MS, again: true })
    // Brought forward, so the test does not wait for the reset.
    patchThread(thread.id, { resume: { at: Date.now() + 20, again: true } })
    await until(() => runtimeOf(thread.id).timeline.items.filter((item) => item.kind === "user" && item.state === "sent").length === 2)
    const sent = runtimeOf(thread.id).timeline.items.filter((item) => item.kind === "user").map((item) => (item.kind === "user" ? item.text : ""))
    expect(sent).toEqual(["please hit the usage limit", "please hit the usage limit"])
    expect(threadById(thread.id)?.resume).toBeUndefined()
    expect(openLimit(runtimeOf(thread.id).timeline.items)).toBeUndefined()
  })

  test("a turn that had begun to answer goes on with Continue", () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    const card = notice("n1")
    const items: TimelineItem[] = [user("t1", "refactor it"), { kind: "assistant", key: "a1", turnId: "t1", text: "Starting with the parser.", streaming: false, at: 1 }, end("t1"), card]
    patchRuntime(thread.id, { timeline: { ...emptyTimeline(), items, index: new Map(items.map((item, at) => [item.key, at])) } })
    expect(repeatsMessage(thread.id, card)).toBe(false)
    continueAfterReset(thread.id, card, Date.now() + 60_000)
    expect(threadById(thread.id)?.resume?.again).toBe(false)
    expect(CONTINUE_PROMPT).toBe("Continue")
  })

  test("a message sent before the reset takes the wait's place", async () => {
    const { thread, card } = await limited()
    continueAfterReset(thread.id, card, Date.now() + 60_000)
    expect(threadById(thread.id)?.resume).toBeDefined()
    send(thread.id, { text: "never mind, do this instead" })
    expect(threadById(thread.id)?.resume).toBeUndefined()
  })

  test("with Always on, a limit is waited out without asking", async () => {
    setPrefs({ continueAfterLimit: true })
    const { thread } = await limited()
    await until(() => threadById(thread.id)?.resume !== undefined)
    expect(threadById(thread.id)?.resume?.again).toBe(true)
    expect(get().prefs.continueAfterLimit).toBe(true)
  })
})
