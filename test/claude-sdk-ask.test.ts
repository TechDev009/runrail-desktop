import { afterEach, expect, test } from "bun:test"
import { CLAUDE_SDK_CODE, CLAUDE_SDK_NOTICE, HELD_FOR_SDK, useClaudeSdk } from "../src/app/claudeSdk"
import { connectionsChanged } from "../src/app/connections"
import { answerClaudeSdk, ensureEngine, initEngines, send } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, runtimeOf, set, setPrefs } from "../src/app/store"
import { SYSTEM_ENGINE_ID, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { PreviewScenario } from "../src/host/fakeConnections"
import type { UserItem } from "../src/thread/reducer"

/** Claude Code's first message asks before the Claude Agent SDK is downloaded; nothing downloads unasked. */

let calls: { readonly engineId: string; readonly method: string; readonly params: Record<string, unknown> | undefined }[] = []
let starts: string[] = []
let stop: () => void = () => undefined

async function until(done: () => boolean, tries = 2_000): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

const called = (method: string) => calls.filter((call) => call.method === method)
const users = (threadId: string) => runtimeOf(threadId).timeline.items.filter((item): item is UserItem => item.kind === "user")
const cards = (threadId: string) => runtimeOf(threadId).timeline.items.filter((item) => item.kind === "notice" && item.code === CLAUDE_SDK_NOTICE)

function start(scenario: PreviewScenario): void {
  stop()
  calls = []
  starts = []
  const base = createFakeHost(scenario)
  setHost({
    ...base,
    rpc: async (engineId, method, params) => {
      calls.push({ engineId, method, params: params as Record<string, unknown> | undefined })
      return base.rpc(engineId, method, params)
    },
    engineStart: async (input) => {
      starts.push(input.engineId)
      return base.engineStart(input)
    },
  })
  connectionsChanged()
  useClaudeSdk.setState({ installing: false }, true)
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  stop = initEngines()
}

async function heldThread(scenario: PreviewScenario = { claudeSdk: "missing" }) {
  start(scenario)
  const thread = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(thread.id)
  send(thread.id, { text: "fix the parser" })
  await until(() => users(thread.id)[0]?.state === "failed")
  return thread
}

afterEach(() => {
  setPrefs({ claudeSdk: "ask" })
})

test("Claude Code's first message waits on one card, and Install and continue downloads the SDK, restarts the engine, and sends what waited", async () => {
  const thread = await heldThread()
  expect(users(thread.id)[0]).toMatchObject({ state: "failed", errorCode: CLAUDE_SDK_CODE, errorMessage: HELD_FOR_SDK })
  send(thread.id, { text: "and the tests" })
  await until(() => users(thread.id)[1]?.state === "failed")
  expect(cards(thread.id)).toHaveLength(1)
  expect([called("turn.enqueue"), called("claude.sdk.install")]).toEqual([[], []])

  const engineStarts = starts.length
  await answerClaudeSdk(thread.id, true)
  expect(called("claude.sdk.install")).toEqual([{ engineId: SYSTEM_ENGINE_ID, method: "claude.sdk.install", params: { confirm: true } }])
  expect(starts.length).toBeGreaterThan(engineStarts)
  // The fake's first turn runs for seconds, and the second message waits behind it like any follow-up.
  await until(() => called("turn.enqueue").length === 2, 4_000)
  await until(() => users(thread.id).length === 2 && users(thread.id).every((item) => item.state === "sent"))
  expect(cards(thread.id)).toEqual([])
  expect(users(thread.id).map((item) => item.text)).toEqual(["fix the parser", "and the tests"])

  // Ready now: the next Claude Code thread is not asked.
  const next = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(next.id)
  send(next.id, { text: "go" })
  await until(() => called("turn.enqueue").length === 3)
}, 30_000)

test("Continue without it sends at once, downloads nothing, and stops asking", async () => {
  const thread = await heldThread()
  await answerClaudeSdk(thread.id, false)
  expect(get().prefs.claudeSdk).toBe("without")
  await until(() => called("turn.enqueue").length === 1)
  expect(cards(thread.id)).toEqual([])

  const next = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(next.id)
  send(next.id, { text: "go" })
  await until(() => called("turn.enqueue").length === 2)
  expect(called("claude.sdk.install")).toEqual([])
})

test("a failed download keeps the card with its reason, and nothing is sent", async () => {
  const thread = await heldThread({ claudeSdk: "offline" })
  await answerClaudeSdk(thread.id, true)
  expect(useClaudeSdk.getState()).toMatchObject({ installing: false, error: "agent SDK download failed: fetch failed" })
  expect(cards(thread.id)).toHaveLength(1)
  expect(users(thread.id)[0]?.state).toBe("failed")
  expect(called("turn.enqueue")).toEqual([])
})

test("other backends never ask the engine, and a ready SDK never holds a message", async () => {
  start({ claudeSdk: "missing" })
  const codex = createThread({ projectId: "p1", backend: "codex", model: "gpt-5.5" })
  await ensureEngine(codex.id)
  send(codex.id, { text: "go" })
  await until(() => called("turn.enqueue").length === 1)
  expect(called("claude.sdk.status")).toEqual([])

  start({})
  const claude = createThread({ projectId: "p1", backend: "claude-code" })
  await ensureEngine(claude.id)
  send(claude.id, { text: "go" })
  await until(() => called("turn.enqueue").length === 1)
  expect(cards(claude.id)).toEqual([])
})
