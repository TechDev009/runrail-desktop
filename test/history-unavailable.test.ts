import { beforeEach, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, HISTORY_UNAVAILABLE, initEngines } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, runtimeOf, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { NoticeItem } from "../src/thread/reducer"

/** An engine that could not read a thread's transcript says so, and the thread shows it instead of quietly forgetting. */

let unavailable = false
let stop: () => void = () => undefined

beforeEach(() => {
  stop()
  const base = createFakeHost({})
  setHost({
    ...base,
    rpc: async (engineId, method, params) => (method === "session.snapshot" && unavailable ? { active: false, historyUnavailable: true } : base.rpc(engineId, method, params)),
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  stop = initEngines()
})

const notices = (threadId: string) => runtimeOf(threadId).timeline.items.filter((item): item is NoticeItem => item.kind === "notice" && item.code === HISTORY_UNAVAILABLE)

test("a thread whose history the engine could not restore shows that the model goes on without it", async () => {
  unavailable = true
  const thread = createThread({ projectId: "p1", backend: "native" })
  await ensureEngine(thread.id)
  expect(notices(thread.id)).toEqual([expect.objectContaining({ level: "error", message: "Runrail could not read this thread's earlier messages, so the model goes on without them." })])
})

test("a thread whose history came back shows no such notice", async () => {
  unavailable = false
  const thread = createThread({ projectId: "p1", backend: "native" })
  await ensureEngine(thread.id)
  expect(notices(thread.id)).toEqual([])
})
