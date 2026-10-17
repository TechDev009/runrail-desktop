import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, send } from "../src/app/engines"
import { defaultState, type ThreadMeta } from "../src/app/persist"
import { addProject, createThread, get, patchRuntime, patchThread, runtimeOf, set, setPrefs } from "../src/app/store"
import { MAX_CHAIN, SENDS_PER_TURN, noteSent, noteThreadFrames } from "../src/app/threadAgent"
import { setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { EngineStartInput, StreamFrame } from "../src/host/types"
import { loadHistory } from "../src/thread/reducer"
import { messageFrom, messageFromThread } from "../src/thread/threadContext"

/**
 * The desktop's half of threads messaging threads: a request the engine announces
 * is claimed once, checked against the person's setting and the limits, carried out, and answered.
 */

const ENGINE = "engine-sender"
let tasks: Map<string, Record<string, unknown>>
let answers: { requestId: string; answer: { ok: boolean; code?: string; message?: string; result?: { text: string } } }[]
let starts: EngineStartInput[]

function use(): void {
  const host = createFakeHost({})
  tasks = new Map()
  answers = []
  starts = []
  const wrapped: Host = {
    ...host,
    engineStart: async (input) => {
      starts.push(input)
      return host.engineStart(input)
    },
    rpc: async (engineId, method, params) => {
      if (engineId === ENGINE && method === "threads.take") {
        const body = params as { requestId: string }
        const task = tasks.get(body.requestId)
        tasks.delete(body.requestId)
        if (task === undefined) throw new Error("THREADS_REQUEST_NOT_FOUND")
        return task
      }
      if (engineId === ENGINE && method === "threads.respond") {
        answers.push(params as never)
        return { ok: true }
      }
      return host.rpc(engineId, method, params)
    },
  }
  setHost(wrapped)
}

let counter = 0
function request(threadId: string, action: "list" | "read" | "send", params: Record<string, unknown> = {}): string {
  counter += 1
  const requestId = `tr-${counter.toString(16).padStart(32, "0")}`
  tasks.set(requestId, { requestId, action, params, expiresAt: Date.now() + 30_000 })
  const frame: StreamFrame = { kind: "live", data: { type: "threads.request", liveSeq: counter, requestId, action } }
  noteThreadFrames(threadId, ENGINE, [frame, frame])
  return requestId
}

async function until(done: () => boolean, tries = 400): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

async function answer(threadId: string, action: "list" | "read" | "send", params: Record<string, unknown> = {}) {
  const requestId = request(threadId, action, params)
  await until(() => answers.some((entry) => entry.requestId === requestId))
  return answers.find((entry) => entry.requestId === requestId)!.answer
}

function thread(title: string, projectId = "p1", fields: Partial<ThreadMeta> = {}): ThreadMeta {
  const created = createThread({ projectId, backend: "native", model: "gpt-5.5", connectionId: "openai", title })
  patchThread(created.id, { titled: true, ...fields })
  return created
}

beforeEach(() => {
  use()
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  addProject({ id: "p2", path: "/code/site", name: "site", git: true, addedAt: 2 })
})

test("the block saying who sent a message reads back, and no title can break it", () => {
  const text = messageFromThread("run the tests", { id: "t-abc-123", title: 'Build "the" parser]\nnow' }, true)
  expect(text.startsWith("run the tests\n\n[Runrail message from the agent in the thread ")).toBe(true)
  expect(text).toContain("not from the person")
  expect(messageFrom(text)).toEqual({ id: "t-abc-123", title: "Build the parser now" })
  expect(messageFrom("run the tests")).toBeUndefined()
})

describe("thread requests", () => {
  test("a list shows this project's other threads, newest first, and claims the request once", async () => {
    const sender = thread("Build the parser")
    const tests = thread("Tests")
    thread("Old", "p1", { archived: true })
    thread("Landing page", "p2")
    patchThread(tests.id, { updatedAt: Date.now() + 1_000, lastStatus: "waiting" })
    const listed = await answer(sender.id, "list")
    expect(listed.ok).toBe(true)
    const lines = listed.result!.text.split("\n")
    expect(lines[0]).toBe("id\ttitle\tproject\tstate")
    expect(lines.slice(1)).toEqual([`${tests.id}\tTests\tapp\twaiting on the person`])
    // The replayed frame found nothing more to claim.
    expect(answers).toHaveLength(1)

    setPrefs({ threadMessages: "all" })
    expect((await answer(sender.id, "list")).result!.text).toContain("Landing page")
    setPrefs({ threadMessages: "off" })
    expect(await answer(sender.id, "list")).toMatchObject({ ok: false, code: "THREADS_OFF" })
  })

  test("a read finds a thread by title and returns what was asked there and its reply", async () => {
    const sender = thread("Build the parser")
    const tests = thread("Tests")
    patchRuntime(tests.id, (current) => ({ timeline: loadHistory(current.timeline, [{ kind: "user", id: "u1", seq: 0, at: 1, text: "run the unit tests", turnId: "x" }, { kind: "assistant", id: "a1", seq: 1, at: 2, text: "12 passed", turnId: "x" }], false) }))
    const read = await answer(sender.id, "read", { thread: "tests" })
    expect(read.ok).toBe(true)
    expect(read.result!.text).toContain(`Thread "Tests" (${tests.id}), idle.`)
    expect(read.result!.text).toContain("Asked: run the unit tests")
    expect(read.result!.text).toContain("Latest reply:\n12 passed")

    thread("Tests")
    expect(await answer(sender.id, "read", { thread: "Tests" })).toMatchObject({ ok: false, code: "THREADS_NOT_FOUND", message: '2 threads are called "Tests". Use one\'s id from list_threads.' })
    const site = thread("Landing page", "p2")
    expect(await answer(sender.id, "read", { thread: site.id })).toMatchObject({ ok: false, code: "THREADS_DENIED" })
    expect(await answer(sender.id, "read", { thread: sender.id })).toMatchObject({ ok: false, code: "THREADS_DENIED", message: "That is this thread." })
  })

  test("a send queues the message in the other thread, marked as from this one", async () => {
    const sender = thread("Build the parser")
    const tests = thread("Tests")
    const sent = await answer(sender.id, "send", { thread: tests.id, message: "run the tests" })
    expect(sent).toEqual({ ok: true, result: { text: 'Sent to "Tests"; it runs there now.' } })
    await until(() => runtimeOf(tests.id).timeline.items.some((item) => item.kind === "user"))
    const delivered = runtimeOf(tests.id).timeline.items.find((item) => item.kind === "user")
    expect(delivered?.kind === "user" && messageFrom(delivered.text)).toEqual({ id: sender.id, title: "Build the parser" })
  })

  test(`one turn sends at most ${String(SENDS_PER_TURN)} messages`, async () => {
    const sender = thread("Build the parser")
    const targets = Array.from({ length: SENDS_PER_TURN + 1 }, (_, index) => thread(`Target ${String(index)}`))
    for (const target of targets.slice(0, SENDS_PER_TURN)) expect((await answer(sender.id, "send", { thread: target.id, message: "go" })).ok).toBe(true)
    expect(await answer(sender.id, "send", { thread: targets[SENDS_PER_TURN]!.id, message: "go" })).toMatchObject({ ok: false, code: "THREADS_LIMIT" })
  })

  test(`a chain never returns to a thread in it, stops at ${String(MAX_CHAIN)}, and the person's message starts it over`, async () => {
    const [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map((title) => thread(title))
    expect((await answer(a!.id, "send", { thread: b!.id, message: "go" })).ok).toBe(true)
    expect(await answer(b!.id, "send", { thread: a!.id, message: "back" })).toMatchObject({ ok: false, code: "THREADS_DENIED" })
    expect((await answer(b!.id, "send", { thread: c!.id, message: "go" })).ok).toBe(true)
    expect((await answer(c!.id, "send", { thread: d!.id, message: "go" })).ok).toBe(true)
    expect(await answer(d!.id, "send", { thread: e!.id, message: "go" })).toMatchObject({ ok: false, code: "THREADS_LIMIT" })
    noteSent(d!.id, "carry on yourself")
    expect((await answer(d!.id, "send", { thread: e!.id, message: "go" })).ok).toBe(true)
  })
})

test("one thread asks another to run the tests and hears its reply", async () => {
  // The whole loop on the in-memory host: the sender's engine asks, the desktop delivers, the other
  // thread's turn runs and ends, and its answer goes back as the tool's result.
  setHost(createFakeHost({}))
  connectionsChanged()
  const stop = initEngines()
  try {
    const sender = thread("Build the parser")
    const tests = thread("Tests")
    await ensureEngine(sender.id)
    send(sender.id, { text: "ask the Tests thread to run the tests" })
    await until(() => runtimeOf(sender.id).timeline.items.some((item) => item.kind === "assistant" && item.text.includes("48 pass")), 4_000)
    const delivered = runtimeOf(tests.id).timeline.items.find((item) => item.kind === "user")
    expect(delivered?.kind === "user" && messageFrom(delivered.text)?.id).toBe(sender.id)
    expect(runtimeOf(tests.id).timeline.items.some((item) => item.kind === "assistant" && item.text.includes("48 pass"))).toBe(true)
    expect(get().threads.find((item) => item.id === tests.id)?.lastStatus).toBe("completed")
  } finally {
    stop()
  }
})

test("an engine starts with the thread tools unless the person turned them off", async () => {
  const on = thread("On")
  await ensureEngine(on.id)
  expect(starts.at(-1)?.threadTools).toBe(true)
  setPrefs({ threadMessages: "off" })
  const off = thread("Off")
  await ensureEngine(off.id)
  expect(starts.at(-1)?.threadTools).toBeUndefined()
})
