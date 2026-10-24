import { describe, expect, test } from "bun:test"
import { ACCENTS, behaviorFor, DEFAULT_LAYOUT, defaultState, MAX_INSTRUCTIONS, MAX_THREAD_RUNS, paletteChange, parseState, withInstructions, type ThreadRun } from "../src/app/persist"
import { addProject, createThread, get, patchThread, persistedSlice, rememberThreadRun, set } from "../src/app/store"
import { accentChoices } from "../src/ui/shell/appearance"

const project = { id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }

function thread(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { id, projectId: "p1", title: "T", titled: true, createdAt: 1, updatedAt: 1, mode: "agent", permission: "ask", ...fields }
}

function load(threads: unknown[], prefs: Record<string, unknown> = {}) {
  return parseState({ version: 1, projects: [project], threads, prefs, layout: {} })
}

describe("saved state and connections", () => {
  test("a Runrail thread saved before connections existed loses its model", () => {
    const state = load([thread("t1", { backend: "native", model: "gpt-5.5", provider: "openai" })])
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0]?.model).toBeUndefined()
    expect(state.threads[0]?.connectionId).toBeUndefined()
    expect(JSON.stringify(state)).not.toContain("provider")
  })

  test("a thread keeps Auto, and an unknown level reads as Ask", () => {
    const state = load([thread("t1", { backend: "codex", permission: "auto" }), thread("t2", { backend: "codex", permission: "approve-everything" })])
    expect(state.threads.map((item) => item.permission)).toEqual(["auto", "ask"])
    expect(load([], { defaultPermission: "auto" }).prefs.defaultPermission).toBe("auto")
    expect(load([]).prefs.defaultPermission).toBe("auto")
    expect(load([], { defaultPermission: "ask" }).prefs.defaultPermission).toBe("ask")
    expect(load([], { defaultPermission: "unsafe" }).prefs.defaultPermission).toBe("ask")
  })

  test("a thread bound to a connection keeps its model", () => {
    const state = load([thread("t1", { backend: "native", model: "gpt-5.5", connectionId: "openai" })])
    expect(state.threads[0]).toMatchObject({ model: "gpt-5.5", connectionId: "openai" })
  })

  test("a coding tool keeps a model it can be started with, and nothing else", () => {
    const state = load([
      thread("t1", { backend: "codex", model: "gpt-5.5" }),
      thread("t2", { backend: "claude-code", model: "opus[1m]" }),
      thread("t3", { backend: "claude-code", model: "--dangerously-skip-permissions" }),
      thread("t4", { backend: "codex", model: "two words" }),
      thread("t5", { backend: "pi", model: "github-copilot/gpt-5.5" }),
      thread("t6", { backend: "replay", model: "gpt-5.5" }),
      thread("t7", { backend: "copilot", model: "gpt-5.5" }),
      thread("t8", { backend: "copilot", model: "-p" }),
    ])
    expect(state.threads.map((item) => item.model)).toEqual(["gpt-5.5", "opus[1m]", undefined, undefined, "github-copilot/gpt-5.5", undefined, "gpt-5.5", undefined])
    expect(state.threads).toHaveLength(8)
  })

  test("the default model of a coding tool is kept only when the tool could take it", () => {
    expect(load([], { defaultBackend: "claude-code", defaultToolModel: "sonnet" }).prefs).toMatchObject({ defaultBackend: "claude-code", defaultToolModel: "sonnet" })
    const bad = load([], { defaultBackend: "claude-code", defaultToolModel: "-p", developer: true }).prefs
    expect(bad.defaultToolModel).toBeUndefined()
    expect(bad).toMatchObject({ defaultBackend: "claude-code", developer: true })
  })

  test("a connection id the engine would refuse is dropped, and the model with it", () => {
    const state = load([thread("t1", { backend: "native", model: "gpt-5.5", connectionId: "not a valid id" })])
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0]?.connectionId).toBeUndefined()
    expect(state.threads[0]?.model).toBeUndefined()
  })

  test("the default model needs a connection too", () => {
    const old = load([], { defaultModel: "claude-opus-5-5", defaultProvider: "anthropic", developer: true })
    expect(old.prefs.defaultModel).toBeUndefined()
    expect(old.prefs.defaultConnectionId).toBeUndefined()
    expect(old.prefs.developer).toBe(true)
    const bound = load([], { defaultModel: "claude-opus-5-5", defaultConnectionId: "anthropic" })
    expect(bound.prefs).toMatchObject({ defaultModel: "claude-opus-5-5", defaultConnectionId: "anthropic" })
  })
})

describe("saved model picks", () => {
  test("state saved before recent models existed has none", () => {
    expect(load([]).prefs.recentModels).toEqual([])
  })

  test("recent models keep their order and hold a model id and a connection id, nothing else", () => {
    const recentModels = [
      { model: "meta-llama/llama-4:free", connectionId: "signin-openrouter", key: "sk-not-kept" },
      { model: "gpt-5.5", connectionId: "openai" },
    ]
    const state = load([], { recentModels })
    expect(state.prefs.recentModels).toEqual([
      { model: "meta-llama/llama-4:free", connectionId: "signin-openrouter" },
      { model: "gpt-5.5", connectionId: "openai" },
    ])
    expect(JSON.stringify(state)).not.toContain("sk-not-kept")
  })

  test("a recent list that is malformed or too long is forgotten, and the other settings stay", () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ model: `m-${String(index)}`, connectionId: "openai" }))
    for (const recentModels of [six, [{ model: "gpt-5.5" }], [{ model: "", connectionId: "openai" }], [{ model: "gpt-5.5", connectionId: "not a valid id" }], "gpt-5.5"]) {
      const state = load([], { recentModels, developer: true })
      expect(state.prefs.recentModels).toEqual([])
      expect(state.prefs.developer).toBe(true)
    }
  })

  test("favorites, instructions, and the context reading are kept, and bad ones are dropped alone", () => {
    const state = load([], { favoriteModels: [{ model: "gpt-5.5", connectionId: "openai", key: "sk-not-kept" }], instructions: "Use pnpm.", contextDisplay: "used" })
    expect(state.prefs.favoriteModels).toEqual([{ model: "gpt-5.5", connectionId: "openai" }])
    expect(state.prefs.instructions).toBe("Use pnpm.")
    expect(state.prefs.contextDisplay).toBe("used")
    expect(JSON.stringify(state)).not.toContain("sk-not-kept")
    const bad = load([], { favoriteModels: "gpt-5.5", instructions: "x".repeat(MAX_INSTRUCTIONS + 1), contextDisplay: "half", developer: true })
    expect(bad.prefs).toMatchObject({ favoriteModels: [], contextDisplay: "used", developer: true })
    expect(bad.prefs.instructions).toBeUndefined()
  })

  test("reasoning, agent, and voice settings come back, and fall back alone when bad", () => {
    const state = load([], { reasoning: "hidden", defaultMode: "plan", followUp: "steer", contextDisplay: "near-full", voice: { dictation: false, language: "zh-TW", rate: 1.5 } })
    expect(state.prefs).toMatchObject({ reasoning: "hidden", defaultMode: "plan", followUp: "steer", contextDisplay: "near-full" })
    expect(state.prefs.voice).toEqual({ dictation: false, engine: "apple", onDevice: false, words: [], language: "zh-TW", autoSend: false, sounds: true, readAloud: false, rate: 1.5 })
    const bad = load([], { defaultMode: "goal", followUp: "now", motion: "fast", voice: { language: "not a language", rate: 9, voiceId: "" } })
    expect(bad.prefs).toMatchObject({ defaultMode: "agent", followUp: "queue", motion: "system" })
    expect(bad.prefs.voice).toEqual({ dictation: true, engine: "apple", onDevice: false, words: [], autoSend: false, sounds: true, readAloud: false, rate: 1 })
    expect(load([], { voice: "on" }).prefs.voice).toEqual(load([]).prefs.voice)
  })

  test("global instructions ride with the behavior, trimmed, and blank sends none", () => {
    const base = behaviorFor("ask", "agent", "high")
    expect(withInstructions(base, "  Use pnpm.\n")).toEqual({ ...base, instructions: "Use pnpm." })
    expect(withInstructions(base, "   ")).toBe(base)
    expect(withInstructions(base, undefined)).toBe(base)
  })
})

describe("saved layout", () => {
  test("a layout saved without panels keeps everything else and has no panels", () => {
    const layout = { activeThreadId: "abc", activeProjectId: "p1", collapsedProjects: ["p1"], sidebarOpen: false, sidebarWidth: 300, inspectorOpen: true, inspectorWidth: 640 }
    const state = parseState({ version: 1, projects: [project], threads: [], prefs: {}, layout })
    // A layout without view options gets the default view.
    expect(state.layout).toEqual({ ...layout, panels: {}, sidebarView: DEFAULT_LAYOUT.sidebarView })
  })
})

describe("palette and accent", () => {
  const prefs = (saved: Record<string, unknown>) => parseState({ version: 1, projects: [], threads: [], prefs: saved, layout: {} }).prefs

  test("a saved palette and accent come back; anything else falls back to the default palette and mono", () => {
    expect(prefs({ palette: "sakura", accent: "theme" })).toMatchObject({ palette: "sakura", accent: "theme" })
    expect(prefs({ palette: "matcha", accent: "teal" })).toMatchObject({ palette: "matcha", accent: "teal" })
    expect(prefs({ palette: "neon", accent: "plaid" })).toMatchObject({ palette: "default", accent: "mono" })
    expect(prefs({})).toMatchObject({ palette: "default", accent: "mono" })
  })

  test("a flower palette picked on mono brings its own accent once; a chosen accent stays", () => {
    expect(paletteChange({ accent: "mono" }, "sakura")).toEqual({ palette: "sakura", accent: "theme" })
    expect(paletteChange({ accent: "blue" }, "sakura")).toEqual({ palette: "sakura" })
    expect(paletteChange({ accent: "theme" }, "default")).toEqual({ palette: "default" })
    expect(paletteChange({ accent: "mono" }, "default")).toEqual({ palette: "default" })
  })

  test("the palette's own accent is offered while a flower palette is on", () => {
    expect(accentChoices("default", "mono")).not.toContain("theme")
    expect(accentChoices("default", "theme")).toContain("theme")
    expect(accentChoices("ume", "mono")).toContain("theme")
    expect(accentChoices("ume", "mono")).toHaveLength(ACCENTS.length)
  })
})

describe("each turn's model, kept for its rows", () => {
  const run = (index: number): ThreadRun => ({ turnId: `turn-${String(index)}`, backend: "claude-code", model: "claude-opus-5-5" })

  test("is kept for the newest turns only, so busy threads cannot outgrow what the host saves", () => {
    expect(MAX_THREAD_RUNS).toBe(64)
    set({ ...defaultState() })
    addProject(project)
    const thread = createThread({ projectId: "p1", backend: "claude-code", select: false })
    for (let index = 0; index < 100; index += 1) rememberThreadRun(thread.id, run(index))
    const kept = get().threads.find((item) => item.id === thread.id)?.runHistory ?? []
    expect(kept).toHaveLength(64)
    expect(kept[0]?.turnId).toBe("turn-36")
    expect(kept[63]?.turnId).toBe("turn-99")
  })

  test("saved by an earlier build with up to 2,048 turns keeps its newest turns instead of losing them all", () => {
    const saved = load([thread("t1", { backend: "claude-code", runHistory: Array.from({ length: 2_048 }, (_, index) => run(index)) })])
    const kept = saved.threads[0]?.runHistory ?? []
    expect(kept).toHaveLength(64)
    expect(kept[63]?.turnId).toBe("turn-2047")
    expect(load([thread("t1", { backend: "claude-code", runHistory: Array.from({ length: 2_049 }, (_, index) => run(index)) })]).threads[0]?.runHistory).toBeUndefined()
  })

  test("is not saved for an archived thread", () => {
    set({ ...defaultState() })
    addProject(project)
    const kept = createThread({ projectId: "p1", backend: "claude-code", select: false })
    const archived = createThread({ projectId: "p1", backend: "claude-code", select: false })
    rememberThreadRun(kept.id, run(1))
    rememberThreadRun(archived.id, run(2))
    patchThread(archived.id, { archived: true })
    const threads = persistedSlice(get()).threads
    expect(threads.find((item) => item.id === kept.id)?.runHistory).toEqual([run(1)])
    expect(threads.find((item) => item.id === archived.id)).not.toHaveProperty("runHistory")
    expect(get().threads.find((item) => item.id === archived.id)?.runHistory).toEqual([run(2)])
  })
})
