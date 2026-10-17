import { beforeEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { expandPeek, openPerson, usePeek } from "../src/app/office"
import { defaultState, type ThreadMeta } from "../src/app/persist"
import { get, openThread, set } from "../src/app/store"
import { emptyTimeline, type Timeline, type TimelineItem } from "../src/thread/reducer"
import { PeekBody, peekPlacement } from "../src/ui/office/PeekCard"

function thread(id: string, extra: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, projectId: "p1", title: `Thread ${id}`, titled: true, createdAt: 0, updatedAt: 0, backend: "claude-code", mode: "agent", permission: "ask", ...extra }
}

function timelineOf(items: TimelineItem[]): Timeline {
  const base = emptyTimeline()
  return { ...base, items, index: new Map(items.map((item, position) => [item.key, position])), approvals: new Map(items.filter((item) => item.kind === "approval").map((item) => [(item as { approvalId: string }).approvalId, item.key])) }
}

beforeEach(() => {
  usePeek.setState({ threadId: undefined })
  set({
    ...defaultState(),
    projects: [{ id: "p1", path: "/code/shop", name: "shop", git: true, addedAt: 0 }],
    threads: [thread("t1"), thread("t2"), thread("t3", { lastStatus: "failed" })],
    runtime: {},
    toasts: [],
    view: { kind: "office" },
    officeDrawer: false,
  })
})

describe("a person on the floor opens as a Peek card", () => {
  test("pressing a person peeks without leaving the floor, and pressing them again closes it", () => {
    openPerson("t1")
    expect(usePeek.getState().threadId).toBe("t1")
    expect(get().officeDrawer).toBe(false)
    openPerson("t2")
    expect(usePeek.getState().threadId).toBe("t2")
    openPerson("t2")
    expect(usePeek.getState().threadId).toBeUndefined()
  })

  test("Open thread moves the card's thread to the drawer", () => {
    openPerson("t1")
    expandPeek("t1")
    expect(usePeek.getState().threadId).toBeUndefined()
    expect(get().officeDrawer).toBe(true)
    expect(get().layout.activeThreadId).toBe("t1")
  })

  test("with the drawer open a person goes to the drawer, and the drawer's own person closes it", () => {
    openThread("t1")
    openPerson("t2")
    expect(usePeek.getState().threadId).toBeUndefined()
    expect(get().layout.activeThreadId).toBe("t2")
    openPerson("t2")
    expect(get().officeDrawer).toBe(false)
  })

  test("a thread opened from the tray, a toast, the palette or a notification falls back to the drawer", () => {
    openThread("t3")
    expect(usePeek.getState().threadId).toBeUndefined()
    expect(get().officeDrawer).toBe(true)
    expect(get().layout.activeThreadId).toBe("t3")
  })
})

describe("the Peek card", () => {
  test("sits right of its person, flips left at the floor's edge, and stays inside it", () => {
    const floor = { top: 100, left: 50, right: 1050 }
    expect(peekPlacement({ top: 300, left: 100, right: 220 }, floor, { top: 40, left: 0, width: 1000 })).toEqual({ top: 234, left: 180 })
    expect(peekPlacement({ top: 300, left: 800, right: 920 }, floor, { top: 0, left: 0, width: 1000 })).toEqual({ top: 194, left: 400 })
    expect(peekPlacement({ top: 90, left: 100, right: 220 }, floor, { top: 0, left: 0, width: 300 })).toEqual({ top: 8, left: 8 })
  })

  test("shows the status, title, latest reply, an approval to answer, and a reply box", () => {
    const runtime = {
      queue: [],
      engine: "ready",
      timeline: timelineOf([
        { kind: "user", key: "u1", text: "Fix the build", at: 1 } as TimelineItem,
        { kind: "assistant", key: "a1", turnId: "x", text: "I'll run **the tests** first.", streaming: false, at: 2 },
        { kind: "approval", key: "ap1", approvalId: "ap-1", turnId: "x", action: "bun test", capability: "process.spawn", status: "pending", at: 3 },
      ]),
    } as never
    const html = renderToStaticMarkup(<PeekBody thread={thread("t1")} projectName="shop" runtime={runtime} onClose={() => {}} />)
    expect(html).toContain("Needs you")
    expect(html).toContain("Thread t1")
    expect(html).toContain("shop · Claude Code")
    expect(html).toContain("I&#x27;ll run the tests first.")
    expect(html).toContain("bun test")
    expect(html).toContain("Approve")
    expect(html).toContain("Open thread")
    expect(html).toContain('aria-label="Reply to Thread t1"')
  })

  test("a failed thread says why and offers to try again", () => {
    const runtime = { queue: [], engine: "ready", timeline: timelineOf([{ kind: "user", key: "u1", text: "Go", at: 1 } as TimelineItem, { kind: "notice", key: "n1", level: "error", code: "HARNESS_AUTH_FAILED", message: "Sign in to Claude Code again.", at: 2 }]) } as never
    const html = renderToStaticMarkup(<PeekBody thread={thread("t3", { lastStatus: "failed" })} runtime={runtime} onClose={() => {}} />)
    expect(html).toContain("Failed")
    expect(html).toContain("Sign in to Claude Code again.")
    expect(html).toContain("Try again")
  })
})

describe("the header's Today pill", () => {
  test("counts today's quests in steps, a finished quest counting no more than its target", async () => {
    const { questTotals } = await import("../src/ui/office/Quests")
    expect(questTotals([{ count: 2, target: 5 }, { count: 4, target: 3 }, { count: 0, target: 2 }])).toEqual({ done: 5, total: 10 })
    expect(questTotals([])).toEqual({ done: 0, total: 0 })
  })
})
