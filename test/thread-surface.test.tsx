import { beforeEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { highlightedThread } from "../src/app/sidebar"
import { get, openThread, selectThread, set, type QueuedPrompt } from "../src/app/store"
import { QueueCard } from "../src/ui/thread/Composer"

function queued(id: string, text: string, attachments = 0): QueuedPrompt {
  return { id, text, attachments: Array.from({ length: attachments }, (_, index) => ({ id: `${id}-a${String(index)}`, name: "shot.png", mime: "image/png", size: 1 })) } as unknown as QueuedPrompt
}

describe("one highlight between Office and the thread list", () => {
  beforeEach(() => set({ view: { kind: "office" }, officeDrawer: false, layout: { ...get().layout, activeThreadId: undefined } }))

  test("a thread picked anywhere but the floor leaves the floor, and only its row lights", () => {
    selectThread("t1")
    expect(get().view.kind).toBe("thread")
    expect(get().officeDrawer).toBe(false)
    expect(get().layout.activeThreadId).toBe("t1")
    expect(highlightedThread(get().view, get().layout.activeThreadId)).toBe("t1")
  })

  test("a click on the floor keeps the floor and opens its drawer, and no row lights", () => {
    openThread("t2")
    expect(get().view.kind).toBe("office")
    expect(get().officeDrawer).toBe(true)
    expect(get().layout.activeThreadId).toBe("t2")
    expect(highlightedThread(get().view, get().layout.activeThreadId)).toBeUndefined()
  })

  test("asking for the floor from another view still shows the thread on its own", () => {
    set({ view: { kind: "thread" } })
    selectThread("t3", true)
    expect(get().view.kind).toBe("thread")
    expect(get().officeDrawer).toBe(false)
  })

  test("other views light no row", () => {
    expect(highlightedThread({ kind: "compare" }, "t1")).toBeUndefined()
    expect(highlightedThread({ kind: "workflows" }, "t1")).toBeUndefined()
  })
})

describe("the queue card above the box", () => {
  const items = [queued("q1", "also add tests for the parser\nand the lexer"), queued("q2", "", 2)]
  const render = (canSteer: boolean, paused = false): string => renderToStaticMarkup(<QueueCard threadId="t" queue={items} paused={paused} canSteer={canSteer} steerKey="mod+enter" onEdit={() => undefined} />)

  test("each message offers Steer only where the thread steers mid-turn, and always delete", () => {
    const steering = render(true)
    expect(steering.match(/>Steer</g)?.length).toBe(2)
    expect(steering.match(/aria-label="Delete queued message"/g)?.length).toBe(2)
    expect(steering).toContain("2 queued, sent when this turn ends")
    expect(steering).toContain("steer")
    expect(render(false)).not.toContain(">Steer<")
    expect(render(false)).not.toContain(" steer")
  })

  test("a message shows its first line, or its attachments, and is a button that edits it", () => {
    const html = render(true)
    expect(html).toContain("also add tests for the parser")
    expect(html).not.toContain("and the lexer</button>")
    expect(html).toContain("2 attachment(s)")
    expect(html).toContain("+2")
    expect(html).toContain('class="queue-text"')
    expect(html).not.toContain("Move up")
    expect(html).not.toContain('aria-label="Edit"')
  })

  test("a paused queue says why and offers Resume instead of the keys", () => {
    const html = render(true, true)
    expect(html).toContain("Queue paused. The last turn stopped or failed.")
    expect(html).toContain("Resume")
    expect(html).not.toContain("sent when this turn ends")
  })

  test("nothing queued, no card", () => {
    expect(renderToStaticMarkup(<QueueCard threadId="t" queue={[]} paused={false} canSteer onEdit={() => undefined} steerKey="mod+enter" />)).toBe("")
  })
})
