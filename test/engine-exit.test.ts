import { expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, startFailureText } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, runtimeOf, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

test("an engine killed by a signal shows as failed, not as a clean stop", async () => {
  const host = createFakeHost({})
  const exits: ((engineId: string, code: number | null, signal?: number) => void)[] = []
  setHost({
    ...host,
    onEngineExit: (listener) => {
      exits.push(listener)
      return () => undefined
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const stop = initEngines()
  try {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    const engineId = await ensureEngine(thread.id)
    for (const exit of exits) exit(engineId, null, 9)
    expect(runtimeOf(thread.id)).toMatchObject({ engine: "stopped", engineError: "ENGINE_EXITED", lastError: "engine was stopped by signal 9" })
  } finally {
    stop()
  }
})

test("a deleted folder is said plainly; any other failure keeps the host's own words", () => {
  expect(startFailureText("WORKSPACE_MISSING", "workspace does not exist", true)).toBe("This thread's worktree folder was deleted, so its agent cannot start here. Archive the thread and start a new one.")
  expect(startFailureText("WORKSPACE_MISSING", "workspace does not exist", false)).toBe("This project's folder was moved or deleted, so the agent cannot start.")
  expect(startFailureText("ENGINE_EXITED", "the engine stopped with code 1", false)).toBe("The agent could not start: the engine stopped with code 1")
  expect(startFailureText("WORKSPACE_INVALID", undefined, false)).toBe("The agent could not start: WORKSPACE_INVALID")
})
