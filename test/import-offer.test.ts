import { beforeEach, describe, expect, test } from "bun:test"
import { createProject } from "../src/app/actions"
import { stopProjectService } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { get, set } from "../src/app/store"
import { importNote } from "../src/app/workflows"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

const session = (source: "claude-code" | "codex" | "pi", index: number) => ({ source, id: `${source}-${String(index)}`, updatedAt: index })
let listed: { sessions: ReturnType<typeof session>[]; truncated?: boolean }
let asked: string[]

beforeEach(() => {
  const host = createFakeHost({})
  listed = { sessions: [] }
  asked = []
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "session.external.list") {
        asked.push(engineId)
        return listed
      }
      return host.rpc(engineId, method, params)
    },
  })
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" }, dialog: undefined })
})

async function settled(): Promise<void> {
  for (let index = 0; index < 50 && get().toasts.length === 0; index += 1) await Bun.sleep(10)
}

describe("the note a new project gets about other tools' sessions", () => {
  test("names each tool with its count, the busiest first", () => {
    expect(importNote([session("claude-code", 1)], false)).toBe("Claude Code has 1 session here")
    expect(importNote([...Array.from({ length: 14 }, (_, index) => session("claude-code", index)), session("codex", 1), session("codex", 2), session("pi", 1)], false)).toBe("Claude Code has 14 sessions here, Codex has 2, and Pi has 1")
    expect(importNote([session("codex", 1), session("codex", 2)], true)).toBe("Codex has 2+ sessions here")
    expect(importNote([], false)).toBeUndefined()
  })

  test("a new project with sessions gets the note once, and its Import opens the dialog for it", async () => {
    listed = { sessions: [session("claude-code", 1), session("claude-code", 2), session("codex", 3)] }
    createProject({ path: "/code/shop", name: "shop", git: true }, "shop")
    await settled()
    const project = get().projects.find((item) => item.path === "/code/shop")
    expect(get().toasts.map((toast) => toast.text)).toEqual(["Claude Code has 2 sessions here, and Codex has 1."])
    get().toasts[0]?.action?.run()
    expect(get().dialog).toEqual({ kind: "import", projectId: project?.id ?? "" })
    // Picking the same folder again adds nothing and says nothing again.
    set({ toasts: [] })
    createProject({ path: "/code/shop", name: "shop", git: true }, "shop")
    await Bun.sleep(50)
    expect(get().toasts).toEqual([])
    expect(asked).toHaveLength(1)
    await stopProjectService(project?.id ?? "")
  })

  test("a folder no tool worked in gets no note", async () => {
    createProject({ path: "/code/empty", name: "empty", git: false }, "empty")
    await Bun.sleep(80)
    expect(get().toasts).toEqual([])
    await stopProjectService(get().projects.find((item) => item.path === "/code/empty")?.id ?? "")
  })
})
