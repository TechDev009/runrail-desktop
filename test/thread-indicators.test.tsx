import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { DEFAULT_PREFS, type Project, type ThreadMeta } from "../src/app/persist"
import { emptyRuntime, get, set, setPrefs, useApp } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { Sidebar } from "../src/ui/shell/Sidebar"
import { WorkingFooter } from "../src/ui/thread/Timeline"

const project: Project = { id: "indicators-project", path: "/tmp/indicators", name: "Indicators", git: false, addedAt: 1 }
const thread: ThreadMeta = { id: "indicators-thread", projectId: project.id, title: "Checking indicators", titled: true, createdAt: 1, updatedAt: Date.now(), backend: "codex", mode: "agent", permission: "auto" }
let previous = { ...get() }
const initialState = useApp.getInitialState()
const originalInitialState = { ...initialState }

function render(node: ReactNode): string {
  // Server rendering reads Zustand's initial snapshot rather than its current state.
  Object.assign(initialState, get())
  return renderToStaticMarkup(node)
}

beforeEach(() => {
  previous = { ...get() }
  setHost(createFakeHost())
  set({ projects: [project], threads: [thread], prefs: DEFAULT_PREFS, runtime: { [thread.id]: { ...emptyRuntime(), engine: "starting" } }, view: { kind: "thread" }, layout: { ...previous.layout, collapsedProjects: [], activeThreadId: thread.id, activeProjectId: project.id } })
})
afterEach(() => {
  set(previous)
  Object.assign(initialState, originalInitialState)
})

describe("thread activity indicators", () => {
  test("the sidebar places running status after the title and hides timestamps until enabled", () => {
    const html = render(<Sidebar />)
    expect(html.indexOf("Checking indicators")).toBeLessThan(html.indexOf('class="thread-status"'))
    expect(html).not.toContain('class="thread-time"')
    setPrefs({ showThreadTimestamps: true })
    expect(render(<Sidebar />)).toContain('class="thread-time"')
  })
  test("starting and working lines put the spinner after their text", () => {
    const runtime = get().runtime[thread.id] ?? emptyRuntime()
    const starting = render(<WorkingFooter threadId={thread.id} runtime={runtime} />)
    const startingLine = starting.slice(starting.indexOf('class="row-working"'))
    expect(startingLine.indexOf("Starting agent")).toBeLessThan(startingLine.indexOf("spin"))
    const working = render(<WorkingFooter threadId={thread.id} runtime={{ ...runtime, engine: "ready", timeline: { ...runtime.timeline, status: "running", activeTurnId: "turn" } }} />)
    const workingLine = working.slice(working.indexOf('class="row-working"'))
    expect(workingLine.indexOf("Working")).toBeLessThan(workingLine.indexOf("spin"))
  })
})
