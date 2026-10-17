import { beforeEach, describe, expect, test } from "bun:test"
import { createProject, pickProject } from "../src/app/actions"
import { defaultState } from "../src/app/persist"
import { cleanProjectName, createProblem, shownProjectName } from "../src/app/projectForm"
import { addProject, createThread, get, renameProject, set } from "../src/app/store"

const folder = { path: "/code/shop", name: "shop", git: true }

beforeEach(() => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" }, dialog: undefined })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
})

describe("Create project", () => {
  test("additional picked folders belong to the new project and new threads default to Auto", () => {
    createProject(folder, "Shop", ["/code/api", "/code/mobile"])
    expect(get().projects.at(-1)?.folders).toEqual(["/code/api", "/code/mobile"])
    expect(createThread({ projectId: get().projects.at(-1)!.id }).permission).toBe("auto")
  })
  test("adding a project opens the dialog; nothing is added until Create", async () => {
    await pickProject()
    expect(get().dialog).toEqual({ kind: "create-project" })
    expect(get().projects).toHaveLength(1)
  })

  test("the name follows the folder until the person types one", () => {
    expect(shownProjectName("", false, undefined)).toBe("")
    expect(shownProjectName("", false, folder)).toBe("shop")
    expect(shownProjectName("Storefront", true, folder)).toBe("Storefront")
    expect(shownProjectName("", true, folder)).toBe("")
    expect(shownProjectName("", false, { ...folder, name: "x".repeat(200) })).toHaveLength(80)
  })

  test("it needs a folder not already added and a name", () => {
    const projects = get().projects
    expect(createProblem("shop", undefined, projects)).toBe("no-folder")
    expect(createProblem("again", { path: "/code/app", name: "app", git: true }, projects)).toBe("duplicate")
    expect(createProblem("   ", folder, projects)).toBe("no-name")
    expect(createProblem("shop", folder, projects)).toBeUndefined()
  })

  test("Create adds the project, closes the dialog, and opens its empty thread", () => {
    set({ dialog: { kind: "create-project" } })
    createProject(folder, "Storefront")
    const state = get()
    expect(state.dialog).toBeUndefined()
    expect(state.projects.map((project) => [project.name, project.path, project.git])).toEqual([
      ["app", "/code/app", true],
      ["Storefront", "/code/shop", true],
    ])
    expect(state.layout.activeProjectId).toBe(state.projects[1]?.id)
    expect(state.layout.activeThreadId).toBeUndefined()
  })
})

describe("project names", () => {
  test("whitespace is tidied; empty and overlong names are refused", () => {
    expect(cleanProjectName("  my   app \n")).toBe("my app")
    expect(cleanProjectName(" \t ")).toBeUndefined()
    expect(cleanProjectName("x".repeat(80))).toHaveLength(80)
    expect(cleanProjectName("x".repeat(81))).toBeUndefined()
  })

  test("Rename keeps the old name when the new one is refused", () => {
    renameProject("p1", "  Web   shop ")
    expect(get().projects[0]?.name).toBe("Web shop")
    renameProject("p1", "   ")
    expect(get().projects[0]?.name).toBe("Web shop")
    renameProject("missing", "Other")
    expect(get().projects.map((project) => project.name)).toEqual(["Web shop"])
  })
})
