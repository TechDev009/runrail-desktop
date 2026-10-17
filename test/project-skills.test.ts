import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, setSkillEnabled, stopProjectService } from "../src/app/engines"
import { defaultState, parseState } from "../src/app/persist"
import { addProject, createThread, projectById, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Skill switches per project: saved with the project, and applied to every engine the project starts. */

let calls: { engineId: string; id: unknown; enabled: unknown }[]
let refuse: string | undefined

beforeEach(async () => {
  // Each test has its own host; a project engine from the last one is not in it.
  await stopProjectService("p1")
  await stopProjectService("p2")
  const host = createFakeHost({})
  const seen: typeof calls = []
  calls = seen
  refuse = undefined
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "skills.setEnabled") {
        seen.push({ engineId, id: params?.id, enabled: params?.enabled })
        if (params?.id === refuse) throw Object.assign(new Error("unknown skill"), { code: "CONTROL_INVALID_INPUT" })
      }
      return host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  addProject({ id: "p2", path: "/code/other", name: "other", git: true, addedAt: 2 })
})

describe("turning a skill off for a project", () => {
  test("is saved with the project and reaches its running threads, not another project's", async () => {
    const mine = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    const theirs = createThread({ projectId: "p2", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    const mineEngine = await ensureEngine(mine.id)
    const theirEngine = await ensureEngine(theirs.id)
    calls.length = 0
    await setSkillEnabled("p1", "review", false)
    expect(projectById("p1")?.disabledSkills).toEqual(["review"])
    expect(projectById("p2")?.disabledSkills).toBeUndefined()
    const engines = calls.map((call) => call.engineId)
    expect(engines).toContain(mineEngine)
    expect(engines).not.toContain(theirEngine)
    expect(calls.every((call) => call.id === "review" && call.enabled === false)).toBe(true)

    await setSkillEnabled("p1", "review", true)
    expect(projectById("p1")?.disabledSkills).toBeUndefined()
  })

  test("a new thread's engine starts with the project's disabled skills off, before it is ready", async () => {
    await setSkillEnabled("p1", "review", false)
    await setSkillEnabled("p1", "release-notes", false)
    calls.length = 0
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    const engineId = await ensureEngine(thread.id)
    expect(calls.filter((call) => call.engineId === engineId).map((call) => [call.id, call.enabled])).toEqual([["review", false], ["release-notes", false]])
  })

  test("a refused switch changes nothing, and a list the engine does not know is skipped at start", async () => {
    refuse = "gone"
    await expect(setSkillEnabled("p1", "gone", false)).rejects.toThrow()
    expect(projectById("p1")?.disabledSkills).toBeUndefined()
    // Saved earlier, since removed: the engine still starts.
    set((state) => ({ projects: state.projects.map((project) => (project.id === "p1" ? { ...project, disabledSkills: ["gone", "review"] } : project)) }))
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await expect(ensureEngine(thread.id)).resolves.toBeString()
  })

  test("a saved list that is not skill ids is dropped, and the project kept", () => {
    const base = { id: "p9", path: "/code/x", name: "x", git: false, addedAt: 1 }
    expect(parseState({ version: 1, projects: [{ ...base, disabledSkills: ["review", "test-writer"] }] }).projects[0]?.disabledSkills).toEqual(["review", "test-writer"])
    const bad = parseState({ version: 1, projects: [{ ...base, disabledSkills: ["../../etc", 3] }] }).projects
    expect(bad).toHaveLength(1)
    expect(bad[0]?.disabledSkills).toBeUndefined()
  })
})
