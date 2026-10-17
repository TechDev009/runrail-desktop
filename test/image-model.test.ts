import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { connectionModels, connectionsChanged } from "../src/app/connections"
import { imageToolsOn, listConnectionSettings, setImageModel, updateConnectionSettings } from "../src/app/connectionSettings"
import { ensureEngine, initEngines } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, set } from "../src/app/store"
import { setHost, toHostError } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { EngineStartInput } from "../src/host/types"

/** The image model agents make pictures with, picked from the person's own connections. */

setDefaultTimeout(20_000)

const PROJECT = "p1"
let starts: EngineStartInput[] = []
let stop: () => void = () => undefined

beforeEach(() => {
  stop()
  starts = []
  const host = createFakeHost()
  const start = host.engineStart.bind(host)
  host.engineStart = (input) => {
    starts.push(input)
    return start(input)
  }
  setHost(host)
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
  stop = initEngines()
})

describe("the list", () => {
  test("is what each connection's own list names, apart from its chat models", async () => {
    const openai = await connectionModels("openai")
    expect(openai.images).toEqual([{ id: "dall-e-3", route: "images" }, { id: "gpt-image-1", route: "images" }])
    expect(openai.models.map((model) => model.id)).not.toContain("gpt-image-1")
    expect((await connectionModels("anthropic")).images).toEqual([])
  })

  test("a pick is kept by the engine, and a model the connection does not list is refused", async () => {
    expect((await listConnectionSettings())?.image).toBeUndefined()
    const refused = await setImageModel({ connectionId: "anthropic", model: "claude-opus-5-5" }).catch((error: unknown) => toHostError(error).code)
    expect(refused).toBe("CONNECTION_MODEL_NOT_CHOSEN")
    await setImageModel({ connectionId: "openai", model: "gpt-image-1" })
    expect((await listConnectionSettings())?.image).toEqual({ connectionId: "openai", model: "gpt-image-1", route: "images", usable: true })
    await setImageModel(undefined)
    expect((await listConnectionSettings())?.image).toBeUndefined()
  })
})

describe("threads", () => {
  test("get the image tool only once a usable image model is picked, and only on the routes that take it", async () => {
    const before = createThread({ projectId: PROJECT, backend: "codex", model: "gpt-5.5" })
    await ensureEngine(before.id)
    expect(starts.at(-1)?.imageTools).toBeUndefined()
    expect(await imageToolsOn()).toBe(false)

    await setImageModel({ connectionId: "openai", model: "gpt-image-1" })
    expect(await imageToolsOn()).toBe(true)
    for (const backend of ["codex", "claude-code"] as const) {
      const thread = createThread({ projectId: PROJECT, backend, model: "gpt-5.5" })
      await ensureEngine(thread.id)
      expect(starts.at(-1)?.imageTools).toBe(true)
    }
    const pi = createThread({ projectId: PROJECT, backend: "pi" })
    await ensureEngine(pi.id)
    expect(starts.at(-1)).toMatchObject({ backend: "pi" })
    expect(starts.at(-1)?.imageTools).toBeUndefined()

    // Its connection turned off, the pick stays but no thread is offered a tool that can only refuse.
    await updateConnectionSettings("openai", { enabled: false })
    expect(await imageToolsOn()).toBe(false)
    expect((await listConnectionSettings())?.image).toMatchObject({ usable: false })
    const later = createThread({ projectId: PROJECT, backend: "claude-code", model: "claude-opus-5-5" })
    await ensureEngine(later.id)
    expect(starts.at(-1)?.imageTools).toBeUndefined()
  })
})
