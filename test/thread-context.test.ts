import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, set } from "../src/app/store"
import { threadContext } from "../src/app/threadMention"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { displayPrompt } from "../src/thread/reducer"
import { THREAD_BLOCK_BYTES, threadBlock, threadsIn } from "../src/thread/threadContext"

/** `@thread`. */

const asked = (text: string) => ({ kind: "user", text })
const replied = (text: string) => ({ kind: "assistant", text })
const bytes = (text: string) => new TextEncoder().encode(text).length

describe("the block", () => {
  test("every message asked and the latest reply, between markers the bubble hides", () => {
    const block = threadBlock("Parser", [asked("Fix CRLF"), replied("Done."), { kind: "tool", text: "ignored" }, asked("Add a test"), replied("Added parser.test.ts")])!
    expect(block).toContain('[Runrail context from the thread "Parser"')
    expect(block).toContain("Asked: Fix CRLF\nAsked: Add a test\nLatest reply:\nAdded parser.test.ts\n[End of the thread]")
    expect(block).not.toContain("Done.")
    const message = `Do the same here\n\n${block}`
    expect(displayPrompt(message)).toBe("Do the same here")
    expect(threadsIn(message)).toEqual(["Parser"])
  })

  test("stays within 8 KB, keeping the newest messages and saying the rest were left out", () => {
    const many = Array.from({ length: 200 }, (_, index) => asked(`message ${String(index)} ${"x".repeat(300)}`))
    const block = threadBlock("Long", [...many, replied("é".repeat(10_000))])!
    expect(bytes(block)).toBeLessThanOrEqual(THREAD_BLOCK_BYTES)
    expect(block).toContain("(Earlier messages left out.)")
    expect(block).toContain("message 199 ")
    expect(block).not.toContain("message 0 ")
    expect(block).toContain("…\n[End of the thread]")
  })

  test("a message's own context and memories are not carried again, and a title cannot break the markers", () => {
    const nested = `Look at this\n\n[Runrail context from the thread "Other": what ...]\nAsked: secret\n[End of the thread]`
    const block = threadBlock('Bad "title"]\nhere', [asked(nested)])!
    expect(block).not.toContain("secret")
    expect(threadsIn(`Hi\n\n${block}`)).toEqual(["Bad title here"])
  })

  test("a thread with nothing said has no block", () => {
    expect(threadBlock("Empty", [])).toBeUndefined()
    expect(threadBlock("Empty", [{ kind: "notice", text: "x" }])).toBeUndefined()
  })
})

describe("reading a thread", () => {
  beforeEach(() => {
    const host = createFakeHost({})
    setHost({
      ...host,
      rpc: async (engineId, method, params = {}) => {
        if (method === "conversation.peek") return { threadId: params.threadId, items: [{ kind: "user", id: "u1", seq: 0, at: 1, text: "Plan the release" }, { kind: "assistant", id: "a1", seq: 1, at: 2, text: "Three steps." }], truncated: false, lastSeq: 1 }
        return host.rpc(engineId, method, params)
      },
    })
    connectionsChanged()
    set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  })

  test("from its transcript, without opening it", async () => {
    const other = createThread({ projectId: "p1", backend: "native", title: "Release", select: false })
    const block = await threadContext(other.id)
    expect(block).toContain('"Release"')
    expect(block).toContain("Asked: Plan the release\nLatest reply:\nThree steps.")
    expect(await threadContext("th-missing")).toBeUndefined()
  })
})
