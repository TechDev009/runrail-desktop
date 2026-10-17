import { expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine } from "../src/app/engines"
import { suggestMemories, useMemory } from "../src/app/memory"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, patchRuntime, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

test("a helper whose message cannot be sent reports the failure instead of running for good", async () => {
  const host = createFakeHost({})
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "turn.enqueue") throw Object.assign(new Error("the connection was refused"), { code: "CONTROL_UNAVAILABLE" })
      return host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  patchRuntime(thread.id, (current) => ({ timeline: { ...current.timeline, items: [{ kind: "user", key: "u1", turnId: "t1", text: "We deploy with make ship.", attachments: 0, state: "sent", at: 1 }] } }))
  suggestMemories(thread.id)
  const helperId = (useMemory.getState().suggestions[thread.id] as { helperId?: string }).helperId ?? ""
  await ensureEngine(helperId).catch(() => undefined)
  for (let tries = 0; tries < 100 && (useMemory.getState().suggestions[thread.id] as { state?: string } | undefined)?.state === "running"; tries += 1) await Bun.sleep(10)
  expect(useMemory.getState().suggestions[thread.id]).toMatchObject({ state: "error" })
})

test("a failed message sent again goes under the key it first went under", async () => {
  const { retry, send } = await import("../src/app/engines")
  const { runtimeOf } = await import("../src/app/store")
  const host = createFakeHost({})
  const keys: unknown[] = []
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method !== "turn.enqueue") return host.rpc(engineId, method, params)
      keys.push(params?.idempotencyKey)
      if (keys.length === 1) throw Object.assign(new Error("timed out"), { code: "CONTROL_TIMEOUT" })
      return { events: [] }
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  await ensureEngine(thread.id)
  send(thread.id, { text: "ship it" })
  for (let tries = 0; tries < 100 && keys.length === 0; tries += 1) await Bun.sleep(5)
  await Bun.sleep(10)
  const failed = runtimeOf(thread.id).timeline.items.find((item) => item.kind === "user" && item.state === "failed")
  expect(failed).toBeDefined()
  retry(thread.id, failed?.key ?? "")
  for (let tries = 0; tries < 100 && keys.length < 2; tries += 1) await Bun.sleep(5)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
})
