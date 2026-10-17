import { beforeEach, describe, expect, test } from "bun:test"
import { archiveWithUndo, confirmDeleteForever, showArchivedThreads } from "../src/app/archive"
import { connectionsChanged } from "../src/app/connections"
import { archiveThread } from "../src/app/engines"
import { defaultState, type Project, type ThreadMeta } from "../src/app/persist"
import { placeOf } from "../src/app/rail"
import { archivedCount, archivedList } from "../src/app/sidebar"
import { addProject, createThread, get, set, threadById } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { paletteCommands } from "../src/ui/shell/Palette"

/** Archived threads have their own place, and deleting one forever is confirmed. */

function project(id: string, name: string): Project {
  return { id, path: `/code/${id}`, name, git: true, addedAt: 1 }
}

function thread(id: string, projectId: string, title: string, fields: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, projectId, title, titled: true, createdAt: 1, updatedAt: 1, backend: "native", mode: "agent", permission: "ask", ...fields }
}

describe("the Archived list", () => {
  const projects = [project("p1", "example-web"), project("p2", "mobile-app")]
  const threads = [
    thread("t1", "p1", "Fix the login bug", { archived: true, archivedAt: 300 }),
    thread("t2", "p2", "Ship the release notes", { archived: true, archivedAt: 500 }),
    thread("t3", "p1", "Tidy the README", { archived: true, updatedAt: 400 }),
    thread("t4", "p1", "Still going"),
    thread("t5", "gone", "From a closed project", { archived: true, archivedAt: 900 }),
  ]

  test("by project, newest archived first, a project placed by its newest; a closed project's threads are left out", () => {
    const list = archivedList({ projects, threads })
    expect(list.groups.map((group) => [group.project.name, group.threads.map((item) => item.id)])).toEqual([
      ["mobile-app", ["t2"]],
      ["example-web", ["t3", "t1"]],
    ])
    expect(list.total).toBe(3)
    expect(archivedCount(projects, threads)).toBe(3)
  })

  test("every word typed must appear in the title or the project's name", () => {
    expect(archivedList({ projects, threads, query: "example login" }).groups.flatMap((group) => group.threads.map((item) => item.id))).toEqual(["t1"])
    expect(archivedList({ projects, threads, query: "web" }).groups.flatMap((group) => group.threads.map((item) => item.id))).toEqual(["t3", "t1"])
    const none = archivedList({ projects, threads, query: "nothing like this" })
    expect(none.groups).toEqual([])
    expect(none.total).toBe(3)
  })

  test("it sits under Threads, so the sidebar stays beside it", () => {
    expect(placeOf({ kind: "archived" })).toBe("threads")
  })
})

describe("archiving, restoring, and deleting forever", () => {
  beforeEach(() => {
    setHost(createFakeHost({}))
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  })

  test("archiving notes when, which orders the list", async () => {
    const before = Date.now()
    const created = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await archiveThread(created.id, true)
    expect(threadById(created.id)?.archived).toBe(true)
    expect(threadById(created.id)?.archivedAt).toBeGreaterThanOrEqual(before)
    await archiveThread(created.id, false)
    expect(threadById(created.id)?.archived).toBe(false)
    showArchivedThreads()
    expect(get().view).toEqual({ kind: "archived" })
  })

  test("archiving says where the thread went, and Undo puts it back", async () => {
    const created = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await archiveWithUndo(created.id)
    expect(threadById(created.id)?.archived).toBe(true)
    const told = get().toasts.at(-1)
    expect(told).toMatchObject({ level: "info", text: `Archived ${created.title}`, action: { label: "Undo" } })
    told?.action?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(threadById(created.id)?.archived).toBe(false)
  })

  test("delete forever asks first, says the history goes, and only then deletes", async () => {
    const created = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    await archiveThread(created.id, true)
    confirmDeleteForever(created.id)
    const dialog = get().dialog
    expect(dialog).toMatchObject({ kind: "confirm", confirm: "Delete forever", danger: true })
    expect(dialog?.kind === "confirm" ? dialog.body : "").toContain("conversation history is deleted")
    expect(threadById(created.id)).toBeDefined()
    if (dialog?.kind !== "confirm") throw new Error("no confirmation")
    dialog.onConfirm()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(threadById(created.id)).toBeUndefined()
  })

  test("a thread in a worktree warns that uncommitted work there is lost", () => {
    const created = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
    set((state) => ({ threads: state.threads.map((item) => (item.id === created.id ? { ...item, archived: true, worktree: { id: "w1", path: "/wt/1", cwd: "/wt/1", branch: "runrail/x" } } : item)) }))
    confirmDeleteForever(created.id)
    const dialog = get().dialog
    expect(dialog?.kind === "confirm" ? dialog.body : "").toContain("Uncommitted work in the worktree is lost")
  })
})

describe("the command palette", () => {
  test("Show archived threads opens the Archived list, found by archive words too", () => {
    setHost(createFakeHost({}))
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    // The palette's theme entry reads the page's theme; tests have no page.
    const page = "document" in globalThis
    if (!page) Object.assign(globalThis, { document: { documentElement: { dataset: {} } } })
    let entry: ReturnType<typeof paletteCommands>[number] | undefined
    try {
      entry = paletteCommands([]).find((item) => item.id === "archived")
    } finally {
      if (!page) Reflect.deleteProperty(globalThis, "document")
    }
    expect(entry).toMatchObject({ group: "Commands", label: "Show archived threads" })
    expect(entry?.keywords).toContain("restore")
    entry?.run()
    expect(get().view).toEqual({ kind: "archived" })
  })
})
