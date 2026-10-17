import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { WaitingItem } from "../src/app/attention"
import { announce, openNotified } from "../src/app/notifications"
import type { ThreadMeta } from "../src/app/persist"
import { steppedThread } from "../src/app/sidebar"
import { get, openThread, set } from "../src/app/store"
import { openWaiting, setTrayOpen, useTray } from "../src/app/triage"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

// A toast's Open reaches the host; this file must not depend on another one having set it.
beforeAll(() => setHost(createFakeHost()))

function thread(id: string): ThreadMeta {
  return { id, projectId: "p1", title: `Thread ${id}`, titled: true, createdAt: 0, updatedAt: 0, backend: "native", mode: "agent", permission: "ask" }
}

function onFloor(): void {
  set({ view: { kind: "office" }, officeDrawer: false, settings: false, toasts: [], threads: [thread("t1"), thread("t2"), thread("t3")], layout: { ...get().layout, activeThreadId: undefined } })
}

function expectOnFloorWith(id: string): void {
  expect(get().view.kind).toBe("office")
  expect(get().officeDrawer).toBe(true)
  expect(get().layout.activeThreadId).toBe(id)
}

describe("every way into a thread keeps the office floor", () => {
  beforeEach(onFloor)

  test("openThread opens the drawer on the floor, and the thread view anywhere else", () => {
    openThread("t1")
    expectOnFloorWith("t1")
    set({ view: { kind: "reviews" }, officeDrawer: false })
    openThread("t2")
    expect(get().view.kind).toBe("thread")
    expect(get().officeDrawer).toBe(false)
  })

  test("the tray's Open closes the tray and keeps the floor", () => {
    setTrayOpen(true)
    openWaiting({ key: "k", kind: "approval", threadId: "t2", projectId: "p1", title: "Thread t2", since: 1 } as WaitingItem)
    expect(useTray.getState().open).toBe(false)
    expectOnFloorWith("t2")
  })

  test("a toast's Open keeps the floor", () => {
    set({ prefs: { ...get().prefs, notifications: true, sounds: false } })
    announce("approval", "t3")
    const action = get().toasts.at(-1)?.action
    expect(action?.label).toBe("Open")
    action?.run()
    expectOnFloorWith("t3")
  })

  test("a system notification's click keeps the floor, and leaves Settings", () => {
    set({ settings: "general" })
    openNotified("t1")
    expect(get().settings).toBe(false)
    expectOnFloorWith("t1")
    openNotified("gone")
    expect(get().layout.activeThreadId).toBe("t1")
  })

  test("next and previous thread step through the list's order and wrap", () => {
    const order = ["t1", "t2", "t3"]
    expect(steppedThread(order, undefined, 1)).toBe("t1")
    expect(steppedThread(order, undefined, -1)).toBe("t2")
    expect(steppedThread(order, "t3", 1)).toBe("t1")
    expect(steppedThread(order, "t1", -1)).toBe("t3")
    expect(steppedThread([], "t1", 1)).toBeUndefined()
  })
})

/** Every .ts and .tsx file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

describe("one opening path", () => {
  const root = join(import.meta.dir, "..", "src")

  test("only the thread list picks a thread without openThread", () => {
    const callers = sources(root)
      .filter((path) => /\bselectThread\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length + 1))
      .sort()
    expect(callers).toEqual(["app/store.ts", "ui/shell/Sidebar.tsx"])
  })

  test("the palette, the inbox, the header's switcher, the keyboard and the stopped toast open through it", () => {
    for (const path of ["ui/shell/Palette.tsx", "ui/shell/Account.tsx", "ui/thread/ThreadHeader.tsx", "ui/shell/App.tsx", "app/engines.ts", "app/office.ts"]) {
      expect({ path, opens: /\bopenThread\(/.test(readFileSync(join(root, path), "utf8")) }).toEqual({ path, opens: true })
    }
  })
})
