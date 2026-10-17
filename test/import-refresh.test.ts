import { beforeEach, describe, expect, test } from "bun:test"
import { send, stopProjectService } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { createThread, runtimeOf, set } from "../src/app/store"
import { bringInTurns, checkNewTurns, importExternal } from "../src/app/workflows"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { NoticeItem, UserItem } from "../src/thread/reducer"
import { noticeCopy } from "../src/ui/thread/rows"

let refreshes: unknown[]

beforeEach(() => {
  const host = createFakeHost({})
  refreshes = []
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "session.external.refresh") refreshes.push(params)
      return host.rpc(engineId, method, params)
    },
  })
  set({
    ...defaultState(),
    projects: [{ id: "p-refresh", path: "/code/shop", name: "shop", git: true, addedAt: 0 }],
    runtime: {},
    git: {},
    drafts: {},
    toasts: [],
    view: { kind: "thread" },
  })
})

const notices = (threadId: string) => runtimeOf(threadId).timeline.items.filter((item): item is NoticeItem => item.kind === "notice")
const prompts = (threadId: string) => runtimeOf(threadId).timeline.items.filter((item): item is UserItem => item.kind === "user").map((item) => item.text)

describe("an imported session that grew in its tool", () => {
  test("offers its new turns, brings in only those, once", async () => {
    const thread = await importExternal("p-refresh", { source: "claude-code", id: "cc-7f3a", updatedAt: 1 }, "runrail")
    await checkNewTurns(thread.id)
    expect(runtimeOf(thread.id).newTurns).toBe(2)
    expect(refreshes).toEqual([{ dryRun: true }])

    await bringInTurns(thread.id)
    expect(runtimeOf(thread.id).newTurns).toBeUndefined()
    expect(notices(thread.id).map((item) => item.code)).toEqual(["session.imported", "session.refreshed"])
    expect(noticeCopy(notices(thread.id)[1]!)).toBe("Brought in 2 new turns the session gained in Claude Code since the import.")
    const texts = prompts(thread.id)
    expect(texts).toHaveLength(4)
    expect(new Set(texts).size).toBe(4)

    await checkNewTurns(thread.id)
    expect(runtimeOf(thread.id).newTurns).toBeUndefined()
    await stopProjectService("p-refresh")
  })

  test("sending a message withdraws the offer, and the engine then has none to make", async () => {
    // Continued in Claude Code, which needs no model picked to send.
    const thread = await importExternal("p-refresh", { source: "claude-code", id: "cc-7f3a", updatedAt: 1 }, "tool")
    await checkNewTurns(thread.id)
    expect(runtimeOf(thread.id).newTurns).toBe(2)
    send(thread.id, { text: "Ship it" })
    expect(runtimeOf(thread.id).newTurns).toBeUndefined()
    // Once the turn has run, the engine itself refuses: the thread has moved on.
    let asked = 0
    do {
      await Bun.sleep(20)
      await checkNewTurns(thread.id)
      asked += 1
    } while (runtimeOf(thread.id).newTurns !== undefined && asked < 100)
    expect(runtimeOf(thread.id).newTurns).toBeUndefined()
    await stopProjectService("p-refresh")
  })

  test("a thread that imported nothing is never asked", async () => {
    const thread = createThread({ projectId: "p-refresh", backend: "native", select: false })
    await checkNewTurns(thread.id)
    expect(refreshes).toEqual([])
    expect(runtimeOf(thread.id).newTurns).toBeUndefined()
  })
})
