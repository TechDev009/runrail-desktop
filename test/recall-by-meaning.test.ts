import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { loadCatalog } from "../src/app/catalog"
import { connectionModels, connectionsChanged } from "../src/app/connections"
import { initEngines } from "../src/app/engines"
import { readSettings, setEmbeddingModel, useMemory } from "../src/app/memory"
import { defaultState } from "../src/app/persist"
import { addProject, set } from "../src/app/store"
import { setHost, toHostError } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Recall by meaning: an embedding model picked from the person's own connections, off until then. */

setDefaultTimeout(20_000)

const PROJECT = "p1"
let stop: () => void = () => undefined

beforeEach(() => {
  stop()
  setHost(createFakeHost())
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
  useMemory.setState({ byProject: {}, suggestions: {}, syncing: {} })
  stop = initEngines()
})

describe("recall by meaning", () => {
  test("offers the embedding models each connection's own list names, apart from its chat models", async () => {
    const openai = await connectionModels("openai")
    expect(openai.embeddings.map((model) => model.id)).toEqual(["text-embedding-3-large", "text-embedding-3-small"])
    expect(openai.models.map((model) => model.id)).not.toContain("text-embedding-3-small")
    expect((await connectionModels("anthropic")).embeddings).toEqual([])
    const catalog = await loadCatalog(PROJECT, true)
    expect(catalog.embeddingModels.filter((model) => model.connectionId === "openai").map((model) => model.id)).toEqual(["text-embedding-3-large", "text-embedding-3-small"])
  })

  test("is off until a model is picked; a pick shows its progress, a model that cannot embed is refused, and it turns off again", async () => {
    expect((await readSettings(PROJECT))?.embeddings).toBeUndefined()
    const refused = await setEmbeddingModel(PROJECT, { connectionId: "openai", model: "gpt-5.5" }).catch((error: unknown) => toHostError(error).code)
    expect(refused).toBe("CONTROL_MEMORY_UNAVAILABLE")
    expect((await readSettings(PROJECT))?.embeddings).toBeUndefined()

    await setEmbeddingModel(PROJECT, { connectionId: "openai", model: "text-embedding-3-small" })
    expect((await readSettings(PROJECT))?.embeddings).toEqual({ connectionId: "openai", model: "text-embedding-3-small" })
    expect(useMemory.getState().byProject[PROJECT]?.status?.semantic).toMatchObject({ connectionId: "openai", model: "text-embedding-3-small", pending: 0 })

    await setEmbeddingModel(PROJECT, undefined)
    expect((await readSettings(PROJECT))?.embeddings).toBeUndefined()
    expect(useMemory.getState().byProject[PROJECT]?.status?.semantic).toBeUndefined()
  })
})
