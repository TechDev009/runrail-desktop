import { afterEach, beforeEach, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, retry, send } from "../src/app/engines"
import { HELD_FOR_LIMIT, PLAN_LIMIT_CODE } from "../src/app/limitCheck"
import { continueAfterReset, initLimitResume, limitReset, openLimit, repeatsMessage } from "../src/app/limitResume"
import { notePlanReading, usePlanLimits } from "../src/app/limits"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, patchRuntime, patchThread, runtimeOf, set, setPrefs, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { emptyTimeline, type NoticeItem, type TimelineItem, type UserItem } from "../src/thread/reducer"

/** A message to a plan already used up is held at once instead of waiting a minute on Claude Code. */

const ACCOUNT = { key: "claude-code", source: "claude-code" } as const
const HOUR = 60 * 60_000
let calls: { readonly method: string; readonly params: Record<string, unknown> | undefined }[] = []
let reading: () => unknown = () => undefined
let stop: () => void = () => undefined

async function until(done: () => boolean, tries = 2_000): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

const plan = (weekly: number, resetsAt: number, extraUsage?: boolean) => ({ type: "plan.limits", source: "claude-code", plan: "max", windows: [{ id: "five-hour", usedPercent: 20, resetsAt: Date.now() + HOUR }, { id: "weekly", usedPercent: weekly, resetsAt }], ...(extraUsage === undefined ? {} : { extraUsage }) })
const called = (method: string) => calls.filter((call) => call.method === method)
const users = (threadId: string) => runtimeOf(threadId).timeline.items.filter((item): item is UserItem => item.kind === "user")

beforeEach(() => {
  stop()
  calls = []
  const base = createFakeHost({})
  setHost({
    ...base,
    rpc: async (engineId, method, params) => {
      calls.push({ method, params: params as Record<string, unknown> | undefined })
      if (method === "usage.read") {
        const answer = reading()
        if (answer === undefined) throw Object.assign(new Error("Claude Code did not report usage"), { code: "USAGE_UNAVAILABLE" })
        return { plan: answer }
      }
      return base.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  setPrefs({ planLimits: "on" })
  usePlanLimits.setState({}, true)
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const engines = initEngines()
  const resumes = initLimitResume(0)
  stop = () => {
    resumes()
    engines()
  }
})

afterEach(() => {
  reading = () => undefined
  setPrefs({ planLimits: "ask" })
})

async function held() {
  const resetAt = Date.now() + 3 * HOUR
  notePlanReading(ACCOUNT, plan(100, resetAt, false) as never)
  reading = () => plan(100, resetAt, false)
  const thread = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(thread.id)
  const started = Date.now()
  send(thread.id, { text: "fix the parser" })
  await until(() => users(thread.id)[0]?.state === "failed")
  return { thread, resetAt, tookMs: Date.now() - started }
}

test("a message to a plan the tool confirms used up is held at once with the limit's card, and goes itself after the reset", async () => {
  const { thread, resetAt, tookMs } = await held()
  expect(tookMs).toBeLessThan(2_000)
  expect(called("usage.read").map((call) => call.params)).toEqual([{ tool: "claude-code", refresh: true }])
  expect(called("turn.enqueue")).toEqual([])
  const [message] = users(thread.id)
  expect(message).toMatchObject({ text: "fix the parser", state: "failed", errorCode: PLAN_LIMIT_CODE, errorMessage: HELD_FOR_LIMIT })
  const card = openLimit(runtimeOf(thread.id).timeline.items) as NoticeItem
  expect(card).toMatchObject({ level: "error", code: PLAN_LIMIT_CODE, message: `Claude Code weekly usage limit reached. Resets at ${new Date(resetAt).toISOString()}.` })
  expect(limitReset(thread.id, card)).toBe(resetAt)
  // No turn ran, so going on sends the message, not "Continue".
  expect(repeatsMessage(thread.id, card)).toBe(true)
  continueAfterReset(thread.id, card, resetAt)
  expect(threadById(thread.id)?.resume?.again).toBe(true)

  // The limit resets; brought forward, so the test does not wait for it.
  notePlanReading(ACCOUNT, plan(0, Date.now() + 7 * 24 * HOUR, false) as never)
  reading = () => plan(0, Date.now() + 7 * 24 * HOUR, false)
  patchThread(thread.id, { resume: { at: Date.now() + 20, again: true } })
  await until(() => called("turn.enqueue").length === 1 && users(thread.id).length === 1 && users(thread.id)[0]?.state === "sent")
  // The held message went in its own place, under the key it was first given.
  expect(users(thread.id).map((item) => item.text)).toEqual(["fix the parser"])
  expect(called("turn.enqueue")[0]?.params?.idempotencyKey).toBe(message?.requestId)
})

test("a held message not kept after Runrail quit is not replaced at the reset by the message before it", async () => {
  const { thread, resetAt } = await held()
  const card = openLimit(runtimeOf(thread.id).timeline.items) as NoticeItem
  continueAfterReset(thread.id, card, resetAt)
  // What a restart leaves: the history holds an earlier answered turn, and nothing held.
  const earlier: TimelineItem[] = [{ kind: "user", key: "u0", turnId: "t0", text: "an earlier request", attachments: 0, state: "sent", at: 1 }, { kind: "turn-end", key: "e0", turnId: "t0", status: "completed", startedAt: 1, endedAt: 2 }]
  patchRuntime(thread.id, { timeline: { ...emptyTimeline(), items: earlier, index: new Map(earlier.map((item, at) => [item.key, at])) } })
  notePlanReading(ACCOUNT, plan(0, Date.now() + 7 * 24 * HOUR, false) as never)
  patchThread(thread.id, { resume: { at: Date.now() + 20, again: true } })
  await until(() => threadById(thread.id)?.resume === undefined)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(called("turn.enqueue")).toEqual([])
})

test("Send anyway sends a held message without reading the plan again", async () => {
  const { thread } = await held()
  const key = users(thread.id)[0]?.key ?? ""
  retry(thread.id, key, true)
  await until(() => called("turn.enqueue").length === 1)
  expect(called("usage.read")).toHaveLength(1)
})

test("a message goes when the fresh reading says extra usage covers it, or no fresh reading comes", async () => {
  const resetAt = Date.now() + 3 * HOUR
  notePlanReading(ACCOUNT, plan(100, resetAt) as never)
  reading = () => plan(100, resetAt, true)
  const thread = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(thread.id)
  send(thread.id, { text: "first" })
  await until(() => called("turn.enqueue").length === 1)
  expect(called("usage.read")).toHaveLength(1)
  await until(() => runtimeOf(thread.id).timeline.items.some((item) => item.kind === "turn-end"))

  usePlanLimits.setState({}, true)
  notePlanReading(ACCOUNT, plan(100, resetAt, false) as never)
  reading = () => undefined
  send(thread.id, { text: "second" })
  await until(() => called("turn.enqueue").length === 2)
  expect(called("usage.read")).toHaveLength(2)
  expect(users(thread.id).every((item) => item.state !== "failed")).toBe(true)
})

test("a plan that does not read as used up is not read again before a send", async () => {
  notePlanReading(ACCOUNT, plan(99, Date.now() + HOUR, false) as never)
  const thread = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(thread.id)
  send(thread.id, { text: "go" })
  await until(() => called("turn.enqueue").length === 1)
  expect(called("usage.read")).toEqual([])
})

test("with Always on, a held message waits for the reset without asking", async () => {
  setPrefs({ continueAfterLimit: true })
  const { thread } = await held()
  await until(() => threadById(thread.id)?.resume !== undefined)
  expect(threadById(thread.id)?.resume?.again).toBe(true)
})

test("with plan limits not turned on, a send never reads the plan and is never held", async () => {
  setPrefs({ planLimits: "off" })
  const resetAt = Date.now() + 3 * HOUR
  notePlanReading(ACCOUNT, plan(100, resetAt, false) as never)
  reading = () => plan(100, resetAt, false)
  const thread = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(thread.id)
  send(thread.id, { text: "go" })
  await until(() => called("turn.enqueue").length === 1)
  expect(called("usage.read")).toEqual([])
  expect(users(thread.id)[0]?.state).not.toBe("failed")
})
