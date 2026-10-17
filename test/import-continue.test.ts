import { beforeEach, describe, expect, test } from "bun:test"
import { stopProjectService } from "../src/app/engines"
import { defaultState, parseState } from "../src/app/persist"
import { get, set } from "../src/app/store"
import { continuesInTool, EXTERNAL_LABELS, importExternal, toolResumeNote } from "../src/app/workflows"
import { EXTERNAL_SOURCES, ExternalSessionListSchema } from "../src/protocol/schemas"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

let imports: Record<string, unknown>[]

beforeEach(() => {
  const host = createFakeHost({})
  imports = []
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "session.external.import") {
        imports.push(params as Record<string, unknown>)
        return { sessionId: engineId, source: (params as { source: string }).source, imported: 2, historyMessages: 2 }
      }
      return host.rpc(engineId, method, params)
    },
  })
  set({
    ...defaultState(),
    projects: [{ id: "p1", path: "/code/shop", name: "shop", git: true, addedAt: 0 }],
    prefs: { ...defaultState().prefs, defaultToolConnectionId: "c-other-account" },
    runtime: {},
    git: {},
    drafts: {},
    toasts: [],
    view: { kind: "thread" },
  })
})

describe("an imported session continues in its own tool or on Runrail", () => {
  test("Claude Code, Codex and OpenCode sessions can continue in their own tool; the others say why not", () => {
    expect(EXTERNAL_SOURCES.map((source) => [source, continuesInTool(source)])).toEqual([
      ["claude-code", true],
      ["codex", true],
      ["pi", false],
      ["opencode", true],
      ["gemini", false],
      ["goose", false],
      ["copilot", false],
    ])
    expect(toolResumeNote("opencode")).toBeUndefined()
    expect(toolResumeNote("gemini")).toBe("Gemini CLI can continue only the session itself, not a copy, so this one continues on Runrail and the original stays as it was")
    expect(toolResumeNote("copilot")).toContain("Copilot CLI can continue only the session itself")
    expect(toolResumeNote("pi")).toBe("Pi sessions continue on Runrail")
  })

  test("an OpenCode session continued in OpenCode runs the thread there and asks the engine for a copy", async () => {
    const thread = await importExternal("p1", { source: "opencode", id: "ses_main1", title: "Fix the checkout total", updatedAt: 1 }, "tool")
    expect(thread).toMatchObject({ backend: "opencode", importedFrom: { source: "opencode", id: "ses_main1" } })
    expect(thread.model).toBeUndefined()
    expect(imports).toEqual([{ source: "opencode", id: "ses_main1", continueIn: "tool" }])
    await stopProjectService("p1")
  })

  test("a session from OpenCode, Gemini CLI, Goose or Copilot CLI lists, imports and stays imported", async () => {
    const listed = ExternalSessionListSchema.parse({ sessions: [{ source: "goose", id: "20261001_1", title: "Add a dark mode toggle", updatedAt: 1, messages: 5, cwd: "/code/shop" }] })
    const session = listed.sessions[0]!
    expect(EXTERNAL_LABELS[session.source]).toBe("Goose")
    const thread = await importExternal("p1", session, "tool")
    expect(thread).toMatchObject({ backend: "native", importedFrom: { source: "goose", id: "20261001_1" } })
    expect(imports).toEqual([{ source: "goose", id: "20261001_1" }])
    // The saved thread keeps where it came from across a restart.
    expect(parseState({ ...defaultState(), projects: get().projects, threads: [thread] }).threads[0]?.importedFrom).toEqual({ source: "goose", id: "20261001_1" })
    await stopProjectService("p1")
  })

  test("in its own tool, the thread runs on that tool with its default model and own sign-in, and asks the engine to fork the session there", async () => {
    const thread = await importExternal("p1", { source: "claude-code", id: "cc-1", title: "Fix login", updatedAt: 1 }, "tool")
    expect(thread).toMatchObject({ backend: "claude-code", importedFrom: { source: "claude-code", id: "cc-1" } })
    expect(thread.model).toBeUndefined()
    expect(thread.connectionId).toBeUndefined()
    expect(imports).toEqual([{ source: "claude-code", id: "cc-1", continueIn: "tool" }])
    const codex = await importExternal("p1", { source: "codex", id: "cx-1", updatedAt: 2 }, "tool")
    expect(codex.backend).toBe("codex")
    expect(imports[1]).toEqual({ source: "codex", id: "cx-1", continueIn: "tool" })
    await stopProjectService("p1")
  })

  test("on Runrail, or for a Pi session, the thread runs on Runrail's loop with the history as context", async () => {
    const pi = await importExternal("p1", { source: "pi", id: "pi-1", updatedAt: 1 }, "tool")
    const claude = await importExternal("p1", { source: "claude-code", id: "cc-2", updatedAt: 2 }, "runrail")
    expect([pi.backend, claude.backend]).toEqual(["native", "native"])
    expect(imports).toEqual([{ source: "pi", id: "pi-1" }, { source: "claude-code", id: "cc-2" }])
    expect(get().layout.activeThreadId).toBe(claude.id)
    await stopProjectService("p1")
  })
})
