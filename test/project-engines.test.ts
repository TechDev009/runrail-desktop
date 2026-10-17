import { beforeEach, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { closeProject, ensureEngine, projectRpc, restartProjectService, stopProjectService } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

let stopped: string[]
let setupState: string

beforeEach(async () => {
  await stopProjectService("p1")
  const host = createFakeHost({})
  stopped = []
  setupState = "running"
  setHost({
    ...host,
    engineStop: async (engineId) => {
      stopped.push(engineId)
      return host.engineStop(engineId)
    },
    rpc: async (engineId, method, params) => {
      if (method === "setup.run.list") return { runs: [{ runId: "r1", state: setupState }] }
      if (method === "workflow.run.list") return { runs: [] }
      return host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
})

test("a settings change waits to restart a project's engine while a setup runs in it", async () => {
  await projectRpc("p1", "setup.run.list")
  await restartProjectService("p1")
  expect(stopped).toEqual([])
  setupState = "succeeded"
  await restartProjectService("p1")
  expect(stopped).toHaveLength(1)
})

test("removing a project stops its threads' engines too", async () => {
  const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  const engineId = await ensureEngine(thread.id)
  await closeProject("p1")
  expect(stopped).toContain(engineId)
  expect(get().projects).toHaveLength(0)
})
