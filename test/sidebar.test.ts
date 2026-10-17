import { describe, expect, test } from "bun:test"
import { serviceLine } from "../src/app/gitHosts"
import { DEFAULT_SIDEBAR_VIEW, parseState, type Project, type SidebarView, type ThreadMeta } from "../src/app/persist"
import { sidebarModel, timeGroup, type Section } from "../src/app/sidebar"

// Noon on 4 October 2026 on this computer's clock; calendar days are local.
const NOW = new Date(2026, 9, 4, 12, 0).getTime()
const at = (day: number, hour = 9): number => new Date(2026, 9, day, hour, 0).getTime()

function project(id: string, name: string, addedAt: number): Project {
  return { id, path: `/code/${id}`, name, git: true, addedAt }
}

function thread(id: string, projectId: string, title: string, fields: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, projectId, title, titled: true, createdAt: at(1), updatedAt: at(1), backend: "native", mode: "agent", permission: "ask", ...fields }
}

const PROJECTS = [project("web", "web app", 1), project("api", "Api", 2), project("cli", "cli tools", 3)]
const THREADS = [
  thread("t1", "web", "Fix the login form", { createdAt: at(1), updatedAt: at(4, 11) }),
  thread("t2", "web", "Add dark mode", { createdAt: at(3), updatedAt: at(3) }),
  thread("t3", "api", "Rate limits", { createdAt: at(2), updatedAt: at(4, 8), pinned: true }),
  thread("t4", "api", "Old migration", { createdAt: at(1), updatedAt: at(2), archived: true }),
  thread("t5", "web", "Compare models", { createdAt: at(1, 10), updatedAt: at(4, 10), group: { id: "g1", label: "Compare models" } }),
  thread("t6", "web", "Compare models", { createdAt: at(1, 9), updatedAt: at(3), group: { id: "g1", label: "Compare models" } }),
]

function model(view: Partial<SidebarView> = {}, query = "", collapsed: readonly string[] = []) {
  return sidebarModel({ projects: PROJECTS, threads: THREADS, view: { ...DEFAULT_SIDEBAR_VIEW, ...view }, collapsed, query, now: NOW })
}

function ids(section: Section | undefined): string[] {
  return (section?.rows ?? []).map((row) => (row.kind === "thread" ? row.thread.id : `group:${row.threads.map((member) => member.id).join("+")}`))
}

describe("sidebar by project", () => {
  test("pinned threads sit in one list above the projects; projects stay in the order added; a comparison is one row", () => {
    const { sections, order } = model()
    expect(sections.map((section) => (section.kind === "project" ? section.project.id : section.label))).toEqual(["Pinned", "web", "api", "cli"])
    expect(ids(sections[0])).toEqual(["t3"])
    expect(ids(sections[1])).toEqual(["t1", "group:t6+t5", "t2"])
    // Every thread of api is pinned: nothing left to list, but the project is not empty.
    expect(sections[2]).toMatchObject({ kind: "project", empty: false, rows: [] })
    expect(sections[3]).toMatchObject({ kind: "project", empty: true, rows: [] })
    expect(order).toEqual(["t3", "t1", "t6", "t5", "t2"])
  })

  test("pins show while their project is collapsed, newest first; pinning one run pins its comparison", () => {
    const threads = THREADS.map((item) => (item.id === "t6" ? { ...item, pinned: true } : item))
    const { sections } = sidebarModel({ projects: PROJECTS, threads, view: DEFAULT_SIDEBAR_VIEW, collapsed: ["web", "api"], now: NOW })
    expect(ids(sections[0])).toEqual(["group:t6+t5", "t3"])
    expect(ids(sections[1])).toEqual(["t1", "t2"])
    expect(sections[1]).toMatchObject({ open: false })
  })

  test("an archived thread leaves Pinned, and comes back when restored", () => {
    const threads = THREADS.map((item) => (item.id === "t3" ? { ...item, archived: true } : item))
    const view = { ...DEFAULT_SIDEBAR_VIEW, showArchived: true }
    const { sections } = sidebarModel({ projects: PROJECTS, threads, view, collapsed: [], now: NOW })
    expect(sections.map((section) => (section.kind === "project" ? section.project.id : section.label))).toEqual(["web", "api", "cli"])
    expect(ids(sections[1])).toEqual(["t3", "t4"])
  })

  test("threads sort by when they were created when asked", () => {
    expect(ids(model({ threadSort: "created" }).sections[1])).toEqual(["t2", "group:t6+t5", "t1"])
  })

  test("projects sort by name or by their latest activity", () => {
    const names = (sections: readonly Section[]) => sections.flatMap((section) => (section.kind === "project" ? [section.project.name] : []))
    expect(names(model({ projectSort: "name" }).sections)).toEqual(["Api", "cli tools", "web app"])
    // web's newest thread is today 11:00, api's today 08:00; cli has none and falls back to when it was added.
    expect(names(model({ projectSort: "activity" }).sections)).toEqual(["web app", "Api", "cli tools"])
  })

  test("archived threads show only when asked, after the live ones", () => {
    expect(ids(model({ showArchived: true }).sections[2])).toEqual(["t4"])
    expect(model({ showArchived: true }).order).not.toContain("t4")
  })

  test("a collapsed project stays closed, but previous and next still reach its threads", () => {
    const { sections, order } = model({}, "", ["web"])
    expect(sections[1]).toMatchObject({ open: false })
    expect(order).toContain("t2")
  })
})

describe("a project's service mark", () => {
  test("names a service or a guess at one; a repository with no remote or an unknown host shows none", () => {
    expect(serviceLine({ service: "github", certain: true, host: "github.com", path: "example-org/web" })?.short).toBe("GitHub")
    expect(serviceLine({ service: "gitlab", certain: false, host: "git.corp.example", path: "ops/api" })?.short).toBe("GitLab?")
    expect(serviceLine({ service: "local", certain: true })?.short).toBeUndefined()
    expect(serviceLine({ service: "unknown", certain: false, host: "code.example", path: "example-org/web" })?.short).toBeUndefined()
    expect(serviceLine(undefined)).toBeUndefined()
  })
})

describe("sidebar search", () => {
  test("every word must appear in the title or the project name, in any order", () => {
    const { sections } = model({}, "form LOGIN")
    expect(sections.map((section) => (section.kind === "project" ? section.project.id : ""))).toEqual(["web"])
    expect(ids(sections[0])).toEqual(["t1"])
    expect(ids(model({}, "web dark").sections[0])).toEqual(["t2"])
  })

  test("a project found by name shows all its threads, and a search opens a collapsed project", () => {
    const { sections } = model({}, "web", ["web"])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ open: true })
    expect(ids(sections[0])).toEqual(["t1", "group:t6+t5", "t2"])
  })

  test("a pin found by a search shows under Pinned alone, not under an empty project", () => {
    const { sections } = model({}, "api", ["api"])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ kind: "time", label: "Pinned" })
    expect(ids(sections[0])).toEqual(["t3"])
    expect(model({}, "cli").sections).toMatchObject([{ kind: "project", empty: true }])
  })

  test("archived threads are found only when they are shown", () => {
    expect(model({}, "migration").noMatches).toBe(true)
    expect(ids(model({ showArchived: true }, "migration").sections[0])).toEqual(["t4"])
  })

  test("nothing found says so", () => {
    expect(model({}, "zzz")).toMatchObject({ sections: [], noMatches: true })
    expect(model().noMatches).toBe(false)
  })
})

describe("sidebar in time order", () => {
  test("pinned first, then calendar days, across projects", () => {
    const { sections, order } = model({ organize: "chronological" })
    expect(sections.map((section) => (section.kind === "time" ? section.label : ""))).toEqual(["Pinned", "Today", "Yesterday"])
    expect(ids(sections[0])).toEqual(["t3"])
    expect(ids(sections[1])).toEqual(["t1", "group:t6+t5"])
    expect(ids(sections[2])).toEqual(["t2"])
    expect(order).toEqual(["t3", "t1", "t6", "t5", "t2"])
  })

  test("archived threads come last, under their own heading", () => {
    const { sections } = model({ organize: "chronological", showArchived: true })
    expect(sections.at(-1)).toMatchObject({ kind: "time", label: "Archived" })
    expect(ids(sections.at(-1))).toEqual(["t4"])
  })

  test("days are counted on the local calendar", () => {
    expect(timeGroup(at(4, 0), NOW)).toBe("Today")
    expect(timeGroup(at(3, 23), NOW)).toBe("Yesterday")
    expect(timeGroup(at(3, 0), NOW)).toBe("Yesterday")
    expect(timeGroup(at(2, 23), NOW)).toBe("Previous 7 days")
    expect(timeGroup(new Date(2026, 8, 10).getTime(), NOW)).toBe("Previous 30 days")
    expect(timeGroup(new Date(2026, 7, 1).getTime(), NOW)).toBe("Older")
  })
})

describe("saved sidebar view", () => {
  const load = (sidebarView: unknown) => parseState({ version: 1, projects: [], threads: [], prefs: {}, layout: { sidebarView, panels: {} } }).layout.sidebarView

  test("a saved view is kept, and a missing one is the default", () => {
    expect(load({ organize: "chronological", threadSort: "created", projectSort: "name", showArchived: true })).toEqual({ organize: "chronological", threadSort: "created", projectSort: "name", showArchived: true })
    expect(load(undefined)).toEqual(DEFAULT_SIDEBAR_VIEW)
  })

  test("unknown values fall back one field at a time", () => {
    expect(load({ organize: "by-color", threadSort: "created", projectSort: 3, showArchived: "yes" })).toEqual({ organize: "project", threadSort: "created", projectSort: "added", showArchived: false })
    expect(load("chronological")).toEqual(DEFAULT_SIDEBAR_VIEW)
  })
})
