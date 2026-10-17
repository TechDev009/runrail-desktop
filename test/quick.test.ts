import { beforeEach, describe, expect, test } from "bun:test"
import { defaultState } from "../src/app/persist"
import { describeShortcut, initQuick, setQuick, shortcutOf, startQuick, useQuick } from "../src/app/quick"
import { addProject, get, set } from "../src/app/store"
import { getHost, setHost, type QuickMessage } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Quick chat: the shortcut, and what a message from its window starts. */

let saved: { workspace: string; mediaType: string; size: number }[] = []

beforeEach(() => {
  saved = []
  const host = createFakeHost()
  host.attachmentSave = async (workspace, mediaType, data) => {
    saved.push({ workspace, mediaType, size: data.length })
    return `${workspace}/.runrail/attachments/a.jpg`
  }
  setHost(host)
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  useQuick.setState({ status: undefined, error: undefined })
})

describe("quick chat", () => {
  test("records a shortcut only with a modifier, and says it as macOS does", () => {
    expect(shortcutOf({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: "Space" })).toBe("Alt+Space")
    expect(shortcutOf({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: true, code: "KeyK" })).toBe("Command+Shift+KeyK")
    expect(shortcutOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: "KeyK" })).toBeUndefined()
    expect(shortcutOf({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: "AltLeft" })).toBeUndefined()
    expect(describeShortcut("Alt+Space")).toBe("Option Space")
    expect(describeShortcut("Command+Shift+KeyK")).toBe("Command Shift K")
    // Linux writes keys as its desktops do.
    expect(describeShortcut("Ctrl+Alt+Space", "linux")).toBe("Ctrl+Alt+Space")
    expect(describeShortcut("Command+Shift+KeyK", "linux")).toBe("Super+Shift+K")
  })

  test("changes the shortcut, and shows a refusal without losing the old one", async () => {
    await setQuick(true, "Command+Shift+KeyK")
    expect(useQuick.getState().status).toEqual({ enabled: true, shortcut: "Command+Shift+KeyK" })
    await setQuick(true, "KeyK")
    expect(useQuick.getState().error).toContain("Option, Command, Control or Shift")
    expect(useQuick.getState().status?.shortcut).toBe("Command+Shift+KeyK")
  })

  test("starts a thread in the project in front with the window's picture, from the window's message", async () => {
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    set((state) => ({ prefs: { ...state.prefs, developer: true } }))
    let deliver: (message: QuickMessage) => void = () => undefined
    getHost().onQuickSubmit = (listener) => {
      deliver = listener
      return () => undefined
    }
    initQuick()
    deliver({ text: "why is this red?", image: { dataBase64: btoa("jpeg-bytes"), mediaType: "image/jpeg", width: 10, height: 10, name: "Safari window" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const thread = get().threads[0]
    expect(thread).toMatchObject({ projectId: "p1", title: "why is this red?" })
    expect(saved).toEqual([{ workspace: "/code/app", mediaType: "image/jpeg", size: "jpeg-bytes".length }])
  })

  test("without a model to send on, keeps the message as the new thread's draft; without a project, says so", async () => {
    await startQuick({ text: "hello" })
    expect(get().threads).toHaveLength(0)
    expect(get().toasts.map((item) => item.text)).toEqual(["Add a project, then quick chat can start threads in it."])
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    await startQuick({ text: "hello" })
    const thread = get().threads[0]
    expect(thread?.title).toBe("New thread")
    expect(get().drafts[thread?.id ?? ""]).toBe("hello")
  })
})
