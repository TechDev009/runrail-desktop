import { beforeEach, describe, expect, test } from "bun:test"
import { stopProjectService } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { get, set } from "../src/app/store"
import { holds, importFromFolder, listExternal, projectForFolder } from "../src/app/workflows"
import { setHost, type WorkspaceInfo, type WorkspacePickOptions } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { ExternalSession } from "../src/protocol/schemas"

let imports: Record<string, unknown>[]
let lists: Record<string, unknown>[]
let picks: (WorkspacePickOptions | undefined)[]
/** What the person picks in the native folder dialog; null is Cancel. */
let picked: WorkspaceInfo | null
/** Folders the host has approved, and the links it resolves. */
let approved: string[]
const LINKS: Readonly<Record<string, string>> = { "/tmp/notes": "/private/tmp/notes" }

beforeEach(() => {
  const host = createFakeHost({})
  imports = []
  lists = []
  picks = []
  picked = null
  approved = ["/code/shop"]
  setHost({
    ...host,
    workspacePick: async (options) => {
      picks.push(options)
      if (picked !== null) approved.push(picked.path)
      return picked
    },
    // Like the host: a folder resolves through its links, and answers only inside an approved folder.
    workspaceInspect: async (path) => {
      const real = LINKS[path] ?? path
      if (!approved.some((folder) => holds(folder, real))) throw new Error("WORKSPACE_NOT_APPROVED")
      return { path: real, name: real.split("/").pop() ?? real, git: false }
    },
    rpc: async (engineId, method, params) => {
      if (method === "session.external.list") lists.push(params as Record<string, unknown>)
      if (method === "session.external.import") {
        imports.push(params as Record<string, unknown>)
        return { sessionId: engineId, source: (params as { source: string }).source, imported: 2, historyMessages: 2 }
      }
      return host.rpc(engineId, method, params)
    },
  })
  set({
    ...defaultState(),
    projects: [
      { id: "fold-1", path: "/code/shop", name: "shop", git: true, addedAt: 0 },
      { id: "fold-2", path: "/code/shop/packages/app", name: "app", git: true, addedAt: 0 },
    ],
    runtime: {},
    git: {},
    drafts: {},
    toasts: [],
    view: { kind: "thread" },
  })
})

const elsewhere: ExternalSession = { source: "claude-code", id: "cc-9", title: "Prototype the CSV importer", updatedAt: 1, cwd: "/scratch/csv" }

describe("importing a session from any folder", () => {
  test("a folder belongs to the innermost project that holds it, and a name that only starts the same is another folder", () => {
    expect(holds("/code/shop", "/code/shop")).toBe(true)
    expect(holds("/code/shop", "/code/shop/src")).toBe(true)
    expect(holds("/code/shop", "/code/shopfront")).toBe(false)
    expect(projectForFolder("/code/shop/packages/app/src")?.id).toBe("fold-2")
    expect(projectForFolder("/code/shop/docs")?.id).toBe("fold-1")
    expect(projectForFolder("/scratch/csv")).toBeUndefined()
  })

  test("the dialog asks the engine for every folder's sessions only when it shows all folders", async () => {
    // Its own project id: another file's engine for a shared id would outlive that file's host.
    await listExternal("fold-1")
    await listExternal("fold-1", "all")
    expect(lists.map((params) => params.scope)).toEqual([undefined, "all"])
    await stopProjectService("fold-1")
  })

  test("without the folder's approval nothing is imported: Cancel adds no project and starts no thread", async () => {
    expect(await importFromFolder(elsewhere)).toBeUndefined()
    expect(picks).toEqual([{ near: "/scratch/csv" }])
    expect(get().projects).toHaveLength(2)
    expect(get().threads).toHaveLength(0)
    expect(imports).toEqual([])
  })

  test("approved in the native dialog, the folder becomes a project and the session imports into a thread there", async () => {
    picked = { path: "/scratch/csv", name: "csv", git: false }
    const thread = await importFromFolder(elsewhere, "tool")
    const project = get().projects.find((item) => item.path === "/scratch/csv")
    expect(project?.name).toBe("csv")
    expect(thread).toMatchObject({ projectId: project?.id, backend: "claude-code", importedFrom: { source: "claude-code", id: "cc-9" } })
    expect(imports).toEqual([{ source: "claude-code", id: "cc-9", continueIn: "tool" }])
    await stopProjectService(project?.id ?? "")
  })

  test("a folder that does not hold the session is refused, and a link to the one that does is not", async () => {
    picked = { path: "/scratch/other", name: "other", git: false }
    await expect(importFromFolder(elsewhere)).rejects.toMatchObject({ code: "IMPORT_FOLDER_MISMATCH" })
    expect(get().projects).toHaveLength(2)
    expect(imports).toEqual([])

    picked = { path: "/private/tmp/notes", name: "notes", git: false }
    const thread = await importFromFolder({ ...elsewhere, id: "cc-10", cwd: "/tmp/notes" })
    expect(get().projects.find((item) => item.id === thread?.projectId)?.path).toBe("/private/tmp/notes")
    expect(imports).toHaveLength(1)
    await stopProjectService(thread?.projectId ?? "")
  })

  test("a session whose folder is gone never opens the folder dialog", async () => {
    await expect(importFromFolder({ ...elsewhere, missing: true })).rejects.toMatchObject({ code: "IMPORT_FOLDER_MISSING" })
    expect(picks).toEqual([])
  })
})
