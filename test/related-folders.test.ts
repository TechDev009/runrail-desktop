import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { loadFiles } from "../src/app/catalog"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, send } from "../src/app/engines"
import { folderKey, folderRpc, initFolderGit, NOT_A_REPOSITORY, refreshFolderGit, showFolder, useFolders } from "../src/app/folderGit"
import { defaultState, MAX_PROJECT_FOLDERS, parseState } from "../src/app/persist"
import { addProject, createThread, projectById, set, setProjectFolders } from "../src/app/store"
import { setHost, toHostError } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { EngineStartInput } from "../src/host/types"

/** A project's related folders. */

setDefaultTimeout(20_000)

const API = "/Users/preview/code/api"
const NOTES = "/Users/preview/notes"

test("a project's related folders are saved, and a bad list is dropped", () => {
  const project = { id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }
  expect(parseState({ ...defaultState(), projects: [{ ...project, folders: [API] }] }).projects[0]?.folders).toEqual([API])
  expect(parseState({ ...defaultState(), projects: [{ ...project, folders: ["code/api"] }] }).projects[0]?.folders).toBeUndefined()
  const many = Array.from({ length: MAX_PROJECT_FOLDERS + 1 }, (_, index) => `/code/f${String(index)}`)
  expect(parseState({ ...defaultState(), projects: [{ ...project, folders: many }] }).projects[0]?.folders).toBeUndefined()
})

test("setting the folders drops repeats, and none leaves no list", () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  setProjectFolders("p1", [API, NOTES, API])
  expect(projectById("p1")?.folders).toEqual([API, NOTES])
  setProjectFolders("p1", [])
  expect(projectById("p1") !== undefined && "folders" in (projectById("p1") ?? {})).toBe(false)
})

async function until(done: () => boolean, tries = 3_000): Promise<void> {
  for (let tried = 0; tried < tries && !done(); tried += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

describe("a thread in a project with related folders", () => {
  let stop: () => void = () => undefined
  let starts: EngineStartInput[] = []

  beforeEach(() => {
    stop()
    starts = []
    const host = createFakeHost({})
    const start = host.engineStart.bind(host)
    host.engineStart = (input) => {
      starts.push(input)
      return start(input)
    }
    setHost(host)
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    useFolders.setState({ shown: {}, git: {} }, true)
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    setProjectFolders("p1", [API, NOTES])
    const engines = initEngines()
    const folders = initFolderGit()
    stop = () => {
      folders()
      engines()
    }
  })

  test("starts its engine with them, and reads each folder's git and files by name", async () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    expect(starts.at(-1)?.folders).toEqual([API, NOTES])
    await refreshFolderGit(thread.id, API)
    const api = useFolders.getState().git[folderKey(thread.id, API)]
    expect(api?.error).toBeUndefined()
    expect(api?.status?.entries.map((entry) => entry.path)).toEqual(["src/routes.ts", "src/sessions.ts"])
    await refreshFolderGit(thread.id, NOTES)
    expect(useFolders.getState().git[folderKey(thread.id, NOTES)]?.error).toBe(NOT_A_REPOSITORY)
    const files = await loadFiles(thread.id, "p1", true, NOTES)
    expect(files.entries.map((entry) => entry.path)).toEqual(["meeting.md", "todo.md"])
    // The thread's own files are a separate index.
    expect((await loadFiles(thread.id, "p1", true)).entries.some((entry) => entry.path === "meeting.md")).toBe(false)
    const refused = await folderRpc(thread.id, "/code/elsewhere", "git.status").catch((error: unknown) => toHostError(error))
    expect(refused).toMatchObject({ code: "CONTROL_INVALID_INPUT" })
  })

  test("a related folder's changes are staged and committed there", async () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    await folderRpc(thread.id, API, "git.stage", { paths: ["src/routes.ts"] })
    const committed = (await folderRpc(thread.id, API, "git.commit", { message: "Route sessions" })) as { status: { entries: { path: string }[] } }
    expect(committed.status.entries.map((entry) => entry.path)).toEqual(["src/sessions.ts"])
    const own = (await folderRpc(thread.id, undefined, "git.log", { limit: 1 })) as { commits: { summary: string }[] }
    expect(own.commits[0]?.summary).not.toBe("Route sessions")
  })

  test("the folder a thread shows is read again when its turn ends", async () => {
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai", permission: "full" })
    await ensureEngine(thread.id)
    showFolder(thread.id, API)
    send(thread.id, { text: "route sessions" })
    await until(() => useFolders.getState().git[folderKey(thread.id, API)]?.status !== undefined)
    showFolder(thread.id, undefined)
    expect(useFolders.getState().shown[thread.id]).toBeUndefined()
  })

  test("a project without related folders starts its engine with none", async () => {
    setProjectFolders("p1", [])
    const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await ensureEngine(thread.id)
    expect(starts.at(-1)?.folders).toBeUndefined()
  })
})
