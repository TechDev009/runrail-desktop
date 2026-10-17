import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadMeta } from "../src/app/persist"
import { personState, type PersonInput } from "../src/app/personState"
import { emptyRuntime, type ThreadRuntime } from "../src/app/store"
import type { StreamFrame } from "../src/host/types"
import { TOOL_KINDS } from "../src/protocol/schemas"
import { applyFrames, emptyTimeline, type Timeline } from "../src/thread/reducer"
import { lookFor } from "../src/ui/office/looks"
import { PersonCard } from "../src/ui/office/Person"

let seq = -1
let liveSeq = 0
function event(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}
function live(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  liveSeq += 1
  return { kind: "live", data: { version: 1, sessionId: "s", liveSeq, at: 1_000 + liveSeq, type, ...fields } }
}

function thread(patch: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id: "t", projectId: "p", title: "Fix the parser", titled: true, createdAt: 0, updatedAt: 0, backend: "native", mode: "agent", permission: "ask", ...patch }
}

function runtime(timeline: Timeline, engine: ThreadRuntime["engine"] = "ready"): ThreadRuntime {
  return { ...emptyRuntime(), engine, timeline }
}

/** A fresh turn; events are numbered in the order given, since arguments are made before the turn starts. */
function turn(...frames: StreamFrame[]): Timeline {
  let next = 0
  const ordered = [event("turn.started", { turnId: "t1", prompt: "go" }), ...frames].map((frame) => (frame.kind === "event" ? { ...frame, data: { ...(frame.data as Record<string, unknown>), seq: next++ } } : frame))
  return applyFrames(emptyTimeline(), ordered)
}

function tool(callId: string, kind: string, extra: Record<string, unknown> = {}): StreamFrame {
  return event("tool.started", { turnId: "t1", callId, name: kind, presentation: { kind, title: `${kind} title`, ...extra } })
}

function state(patch: Partial<PersonInput> & { readonly timeline?: Timeline }) {
  const { timeline, ...rest } = patch
  return personState({ thread: thread(), backgroundAgents: 0, ...(timeline === undefined ? {} : { runtime: runtime(timeline) }), ...rest })
}

describe("a person's pose comes from the thread's real state", () => {
  test("the call running now picks the pose and names what it is about", () => {
    expect(state({ timeline: turn(tool("c1", "edit", { path: "src/a.ts" })) })).toMatchObject({ pose: "typing", label: "Editing", detail: "src/a.ts", tone: "work", moving: true })
    expect(state({ timeline: turn(tool("c1", "read", { path: "README.md" })) })).toMatchObject({ pose: "reading", label: "Reading", detail: "README.md" })
    expect(state({ timeline: turn(tool("c1", "search", { query: "parseSession" })) })).toMatchObject({ pose: "reading", label: "Searching", detail: "parseSession" })
    expect(state({ timeline: turn(tool("c1", "shell", { command: "bun test" })) })).toMatchObject({ pose: "running", label: "Running a command", detail: "bun test" })
    expect(state({ timeline: turn(tool("c1", "verify", { command: "bun run typecheck" })) })).toMatchObject({ pose: "running", label: "Running checks" })
    expect(state({ timeline: turn(tool("c1", "web", { url: "http://localhost:5173/" })) })).toMatchObject({ pose: "browsing", detail: "http://localhost:5173/" })
  })

  test("every kind of call moves the person", () => {
    for (const kind of TOOL_KINDS) {
      const person = state({ timeline: turn(tool("c1", kind)) })
      expect([kind, person.moving, person.tone]).toEqual([kind, true, "work"])
    }
  })

  test("a finished call no longer drives the pose", () => {
    const timeline = turn(tool("c1", "edit", { path: "a.ts" }), event("tool.completed", { turnId: "t1", callId: "c1", name: "edit", ok: true }))
    expect(state({ timeline })).toMatchObject({ pose: "thinking", label: "Thinking" })
  })

  test("a streaming answer is typing; a turn with nothing running is thinking", () => {
    expect(state({ timeline: turn(event("assistant.delta", { turnId: "t1", text: "Hel" })) })).toMatchObject({ pose: "typing", label: "Writing the answer" })
    expect(state({ timeline: turn(live("reasoning.delta", { turnId: "t1", itemId: "r1", text: "hmm" })) })).toMatchObject({ pose: "thinking" })
  })

  test("a pending approval raises the hand over anything else, quiet included", () => {
    const timeline = turn(tool("c1", "shell", { command: "git push" }), event("approval.required", { turnId: "t1", approvalId: "a1", action: "git push", capability: "shell" }))
    expect(state({ timeline, quietSince: 1 })).toMatchObject({ pose: "raised", label: "Needs you", tone: "ask", detail: "git push", moving: true })
  })

  test("a quiet turn holds still", () => {
    expect(state({ timeline: turn(tool("c1", "shell")), quietSince: 5 })).toMatchObject({ pose: "quiet", tone: "ask", moving: false })
  })

  test("helpers count subagents running in the turn and in the background", () => {
    const timeline = turn(tool("a1", "agent"), tool("a2", "agent"), event("tool.completed", { turnId: "t1", callId: "a2", name: "agent", ok: true }), tool("c1", "read"))
    expect(state({ timeline }).helpers).toBe(1)
    expect(state({ timeline, backgroundAgents: 2 }).helpers).toBe(3)
  })

  test("between turns: failed, done but unread, idle, and still and grey with no engine", () => {
    const ended = turn(event("session.completed", { snapshot: { id: "s", backend: "native", status: "idle" } }))
    expect(personState({ thread: thread({ lastStatus: "failed" }), runtime: runtime(ended), backgroundAgents: 0 })).toMatchObject({ pose: "failed", tone: "fail", moving: false })
    expect(personState({ thread: thread({ lastStatus: "completed", unread: true }), runtime: runtime(ended), backgroundAgents: 0 })).toMatchObject({ pose: "done", tone: "done", moving: false })
    expect(personState({ thread: thread({ lastStatus: "completed" }), runtime: runtime(ended), backgroundAgents: 0 })).toMatchObject({ pose: "idle", label: "Idle", moving: false })
    expect(personState({ thread: thread({ lastStatus: "completed" }), backgroundAgents: 0 })).toMatchObject({ pose: "offline", tone: "idle", moving: false })
    expect(personState({ thread: thread({ lastStatus: "stopped" }), runtime: runtime(emptyTimeline(), "stopped"), backgroundAgents: 0 })).toMatchObject({ pose: "offline", label: "Stopped" })
  })

  test("an engine starting up with no turn yet is starting, not idle", () => {
    expect(personState({ thread: thread(), runtime: runtime(emptyTimeline(), "starting"), backgroundAgents: 0 })).toMatchObject({ pose: "thinking", label: "Starting", moving: true })
  })
})

describe("a person's look and name", () => {
  test("keeps one look per thread id, made only of tokens", () => {
    expect(lookFor("thread-a")).toEqual(lookFor("thread-a"))
    const look = lookFor("thread-b")
    for (const color of [look.skin, look.hair, look.shirt]) expect(color).toMatch(/^var\(--px-(skin|hair|shirt)-\d\)$/)
    const looks = new Set(Array.from({ length: 40 }, (_, index) => JSON.stringify(lookFor(`thread-${String(index)}`))))
    expect(looks.size).toBeGreaterThan(20)
  })

  test("its accessible name says who it is, what it is doing, and where", () => {
    const timeline = turn(tool("c1", "shell", { command: "git push" }), event("approval.required", { turnId: "t1", approvalId: "a1", action: "git push", capability: "shell" }))
    const person = personState({ thread: thread(), runtime: runtime(timeline), backgroundAgents: 0 })
    const tag = { title: "Fix the parser", unread: false, model: "Opus 5.5", worktree: false, pinned: false, background: 0 }
    const html = renderToStaticMarkup(<PersonCard threadId="t" project="runrail" now={0} selected={false} filter="all" focusable onOpen={() => undefined} onKeyDown={() => undefined} person={person} tag={tag} />)
    expect(html).toContain('aria-label="Fix the parser, Needs you: git push, runrail"')
    expect(html).toContain('data-pose="raised"')
    expect(html).toContain("Needs you")
    // The scene is decoration; the name and the bubble carry the facts.
    expect(html).toContain('class="person-scene" aria-hidden="true"')
  })
})
