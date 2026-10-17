import { expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { describeSupport, terminalSupport } from "../src/ui/inspector/TerminalPane"

test("an engine that cannot answer yet is asked again instead of showing Connecting for good", async () => {
  const host = createFakeHost({})
  let asked = 0
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method !== "terminal.describe") return host.rpc(engineId, method, params)
      asked += 1
      if (asked < 2) throw Object.assign(new Error("timed out"), { code: "CONTROL_TIMEOUT" })
      return { shells: [] }
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  await ensureEngine(thread.id)
  describeSupport(thread.id)
  for (let tries = 0; tries < 60 && terminalSupport(thread.id) !== "yes"; tries += 1) await Bun.sleep(50)
  expect(terminalSupport(thread.id)).toBe("yes")
  expect(asked).toBe(2)
})
