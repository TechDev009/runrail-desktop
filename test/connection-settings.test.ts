import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged, systemRpc, type Connection } from "../src/app/connections"
import { ensureEngine, offersSessionApproval, resolveApproval } from "../src/app/engines"
import { adoptEngineDefault, adoptFirstToolDefault, closeToolLogin, toCodingTools, KEY_TOOLS, listConnectionSettings, loginLine, loginTerminalOffered, readToolLogin, setStartDefault, startToolLogin, toolConnectionStatus, writeToolLogin, type ConnectionSettingsListing, type ToolConnection } from "../src/app/connectionSettings"
import type { CatalogModel } from "../src/app/modelText"
import { defaultState } from "../src/app/persist"
import { buildPicker, carried, classifyPick, offeredConnection, offeredModels, pickable, selectionProblem, type CodingTool, type PickerCatalog, type PickerView, type Selection } from "../src/app/picker"
import { addProject, createThread, get, set, setPrefs } from "../src/app/store"
import { setHost, SYSTEM_ENGINE_ID, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { guardRendererRpc, type PreviewScenario } from "../src/host/fakeConnections"
import { buildTiles, chooseModel, dropModel, firstModel, initialStep, recommendedModels, type ConnectData } from "../src/ui/connections/steps"
import { loginProblemText, toolRoute, toolStatusText, turnOnText } from "../src/ui/connections/text"

/**
 * Connection settings: each connection on or off with the models it offers, coding tools as
 * connections of their own, and the one default the engine keeps.
 */

let host: Host

function use(scenario: PreviewScenario = {}): void {
  host = createFakeHost(scenario)
  setHost(host)
}

beforeEach(() => {
  use()
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
})

async function code(run: () => unknown): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function conn(id: string, extra: Partial<Connection> = {}): Connection {
  return { id, label: id, presetId: id, authMode: "api-key", status: "ready", ...extra }
}

function model(connectionId: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { connectionId, id, ...extra }
}

function toolConnection(id: string, tool: ToolConnection["tool"], extra: Partial<ToolConnection> = {}): ToolConnection {
  return { id, tool, label: id, authMode: "subscription", separateAccount: false, enabled: true, ...extra }
}

test("a newly connected subscription is reused across projects without another sign-in", () => {
  const connection = toolConnection("claude-code-2", "claude-code", { separateAccount: true, models: ["sonnet"] })
  adoptFirstToolDefault(connection)
  for (const projectId of ["project-one", "project-two"]) {
    const thread = createThread({ projectId, select: false })
    expect({ backend: thread.backend, connectionId: thread.connectionId, model: thread.model }).toEqual({ backend: "claude-code", connectionId: connection.id, model: "sonnet" })
  }
})

test("connecting another account preserves an existing model default", () => {
  setPrefs({ defaultBackend: "native", defaultConnectionId: "anthropic", defaultModel: "claude-opus-5-5" })
  adoptFirstToolDefault(toolConnection("codex-1", "codex", { models: ["codex-model"] }))
  expect(get().prefs).toMatchObject({ defaultBackend: "native", defaultConnectionId: "anthropic", defaultModel: "claude-opus-5-5" })
})

const HARNESSES: readonly CodingTool[] = [
  { id: "native" },
  { id: "claude-code", available: true, signedIn: false, freeTextModel: true, models: [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }, { id: "haiku", name: "Haiku" }] },
  { id: "codex", available: true, signedIn: true, models: [{ id: "codex-large", name: "Codex Large" }] },
  { id: "copilot", available: true, freeTextModel: true },
  { id: "pi", available: false },
]

const TOOLS: readonly ToolConnection[] = [
  toolConnection("claude-code-1", "claude-code", { label: "Claude Code" }),
  toolConnection("claude-code-2", "claude-code", { label: "Claude Code (work)", separateAccount: true, models: ["sonnet", "opus", "claude-fable-5-1"] }),
  toolConnection("codex-1", "codex", { label: "Codex", enabled: false }),
]

function catalog(extra: Partial<PickerCatalog> = {}): PickerCatalog {
  return {
    connections: [conn("anthropic", { label: "Anthropic", models: ["claude-haiku-4-5"] }), conn("openai", { label: "OpenAI", enabled: false })],
    models: [model("anthropic", "claude-opus-5-5", { name: "Claude Opus 5.5" }), model("anthropic", "claude-haiku-4-5", { name: "Claude Haiku 4.5" }), model("openai", "gpt-5.5", { name: "GPT-5.5" })],
    modelErrors: {},
    harnesses: HARNESSES,
    tools: TOOLS,
    ...extra,
  }
}

function view(value: Selection = { backend: "native" }, query = "", from: PickerCatalog = catalog()): PickerView {
  return buildPicker({ catalog: from, value, recents: [], favorites: [], query, developer: false })
}

function group(shown: PickerView, id: string) {
  return shown.groups.find((item) => item.id === id)
}

describe("the model menu with connection settings", () => {
  test("a connection that is off is left out, and one with chosen models offers only those", () => {
    const shown = view()
    expect(shown.groups.map((item) => item.id)).toEqual(["connection anthropic", "tool claude-code @claude-code-1", "tool claude-code @claude-code-2"])
    expect(group(shown, "connection anthropic")?.entries.map((entry) => entry.model)).toEqual(["claude-haiku-4-5"])
    expect(offeredConnection(conn("openai", { enabled: false }))).toBe(false)
    // A chosen id the list lacks was typed in, and is still offered.
    expect(offeredModels([model("relay", "a")], { id: "relay", models: ["b", "a"] })).toEqual([{ id: "b", connectionId: "relay" }, model("relay", "a")])
  })

  test("each tool connection that is on is its own group, named as the person named it", () => {
    const shown = view()
    expect(group(shown, "tool claude-code @claude-code-1")).toMatchObject({ label: "Claude Code", note: "Not signed in", warn: true })
    expect(group(shown, "tool claude-code @claude-code-1")?.entries.map((entry) => [entry.label, entry.connectionId])).toEqual([
      ["Default", "claude-code-1"],
      ["Opus", "claude-code-1"],
      ["Sonnet", "claude-code-1"],
      ["Haiku", "claude-code-1"],
    ])
    // The tool's word about its usual login says nothing of a connection with a folder of its own.
    expect(group(shown, "tool claude-code @claude-code-2")).not.toHaveProperty("note")
    expect(group(shown, "tool codex @codex-1")).toBeUndefined()
  })

  test("chosen models come in their order with no Default row, named as the tool lists them", () => {
    const entries = group(view(), "tool claude-code @claude-code-2")?.entries ?? []
    expect(entries.map((entry) => [entry.key, entry.label, entry.model])).toEqual([
      ["tool claude-code @claude-code-2 sonnet", "Sonnet", "sonnet"],
      ["tool claude-code @claude-code-2 opus", "Opus", "opus"],
      ["tool claude-code @claude-code-2 claude-fable-5-1", "claude-fable-5-1", "claude-fable-5-1"],
    ])
    expect(entries[0]?.title).toBe("sonnet through Claude Code (work), with its own sign-in")
  })

  test("Claude Code's models say the version and the exact model each alias runs", () => {
    const versioned: CodingTool = {
      id: "claude-code",
      available: true,
      signedIn: true,
      models: [
        { id: "opus", name: "Opus 5.5", resolved: "claude-opus-5-5", default: true },
        { id: "claude-fable-5-1[1m]", name: "Fable 5.1", resolved: "claude-fable-5-1[1m]" },
        { id: "haiku", name: "Haiku 4.5", resolved: "claude-haiku-4-5-20251001", reasoning: false },
        { id: "claude-opus-4-8", name: "Opus 4.8", catalog: true },
      ],
    }
    const shown = view({ backend: "native" }, "", catalog({ harnesses: [versioned], tools: [TOOLS[0]!] }))
    expect(group(shown, "tool claude-code @claude-code-1")?.entries.map((entry) => [entry.label, entry.meta])).toEqual([
      ["Default", "Opus 5.5 · set in Claude Code"],
      ["Opus 5.5", "claude-opus-5-5"],
      ["Fable 5.1", "claude-fable-5-1[1m]"],
      ["Haiku 4.5", "claude-haiku-4-5-20251001"],
      ["Opus 4.8", "claude-opus-4-8"],
    ])
    expect(group(shown, "tool claude-code @claude-code-1")?.entries[1]?.title).toBe("claude-opus-5-5 through Claude Code, with the login it already has")
    // A version Claude Code does not list itself still runs by its id, but the plan may not include it.
    expect(group(shown, "tool claude-code @claude-code-1")?.entries[4]?.title).toBe("claude-opus-4-8 through Claude Code, with the login it already has. Not in Claude Code's own list: a model the plan does not include is refused on the first message")
    const parsed = toCodingTools([{ descriptor: { id: "claude-code" }, available: true, models: [{ id: "opus", name: "Opus 5.5", resolved: "claude-opus-5-5", default: true }, { id: "sonnet", resolved: "not an id!", catalog: "yes" }, { id: "claude-opus-5", catalog: true }] }])
    expect(parsed[0]?.models).toEqual([{ id: "opus", name: "Opus 5.5", resolved: "claude-opus-5-5", default: true }, { id: "sonnet" }, { id: "claude-opus-5", catalog: true }])
  })

  test("the entry in use is marked only on its own connection", () => {
    const shown = view({ backend: "claude-code", model: "opus", connectionId: "claude-code-2" })
    expect(pickable(shown).filter((entry) => entry.active).map((entry) => entry.key)).toEqual(["tool claude-code @claude-code-2 opus"])
  })

  test("a thread from before tool connections keeps only what it runs on", () => {
    const shown = view({ backend: "claude-code", model: "opus" })
    expect(group(shown, "tool claude-code")?.entries.map((entry) => [entry.key, entry.active])).toEqual([["tool claude-code opus", true]])
  })

  test("a typed id goes only to a connection that offers every model", () => {
    const shown = view({ backend: "native" }, "claude-brand-new")
    expect(pickable(shown).filter((entry) => entry.kind === "manual").map((entry) => entry.key)).toEqual(["manual claude-code @claude-code-1"])
  })

  test("without connection settings, every tool is offered on its own login", () => {
    const shown = view({ backend: "native" }, "", catalog({ tools: undefined }))
    expect(shown.groups.filter((item) => item.id.startsWith("tool")).map((item) => item.id)).toEqual(["tool claude-code", "tool codex", "tool copilot", "tool pi"])
  })

  test("another tool connection is another login, so it is a new route", () => {
    expect(classifyPick({ backend: "claude-code", model: "opus", connectionId: "claude-code-1" }, { backend: "claude-code", model: "opus", connectionId: "claude-code-2" })).toBe("route")
    expect(classifyPick({ backend: "claude-code", model: "opus" }, { backend: "claude-code", model: "opus", connectionId: "claude-code-1" })).toBe("route")
    expect(classifyPick({ backend: "claude-code", model: "opus", connectionId: "claude-code-2" }, { backend: "claude-code", model: "sonnet", connectionId: "claude-code-2" })).toBe("model")
  })

  test("a tool connection that was removed or turned off cannot send", () => {
    expect(selectionProblem({ backend: "claude-code", connectionId: "claude-code-9" }, [], false, TOOLS)).toBe("connection-removed")
    expect(selectionProblem({ backend: "codex", connectionId: "codex-1" }, [], false, TOOLS)).toBe("connection-not-ready")
    expect(selectionProblem({ backend: "claude-code", connectionId: "claude-code-2" }, [], false, TOOLS)).toBeUndefined()
    // A thread on the tool's own login, or a list not read yet, is not refused.
    expect(selectionProblem({ backend: "claude-code" }, [], false, TOOLS)).toBeUndefined()
    expect(selectionProblem({ backend: "claude-code", connectionId: "claude-code-9" }, [], false, undefined)).toBeUndefined()
  })
})

describe("OpenCode, Gemini CLI, and Goose", () => {
  const found: readonly CodingTool[] = [
    { id: "opencode", available: true, signedIn: true, freeTextModel: true, models: [{ id: "lmstudio/qwen", name: "qwen" }] },
    { id: "gemini", available: true, freeTextModel: true },
    { id: "goose", available: true, freeTextModel: true },
  ]
  const three = catalog({ harnesses: found, tools: [toolConnection("opencode-1", "opencode", { label: "OpenCode" }), toolConnection("gemini-1", "gemini", { label: "Gemini key", authMode: "api-key", separateAccount: true }), toolConnection("goose-1", "goose", { label: "Goose" })] })

  test("each is a group of its own, with what it lists and its own default", () => {
    const shown = view({ backend: "native" }, "", three)
    expect(group(shown, "tool opencode @opencode-1")?.entries.map((entry) => entry.label)).toEqual(["Default", "qwen"])
    expect(group(shown, "tool gemini @gemini-1")?.entries.map((entry) => entry.label)).toEqual(["Default"])
    expect(group(shown, "tool goose @goose-1")?.entries.map((entry) => [entry.label, entry.meta, entry.model])).toEqual([["Default", "Set in Goose", undefined]])
  })

  test("a typed id goes to each of them", () => {
    const shown = view({ backend: "native" }, "qwen/qwen3.6-35b-a3b", three)
    expect(pickable(shown).filter((entry) => entry.kind === "manual").map((entry) => entry.key)).toEqual(["manual opencode @opencode-1", "manual gemini @gemini-1", "manual goose @goose-1"])
  })

  test("a thread keeps the model and the connection", () => {
    expect(carried({ backend: "goose", model: "qwen/qwen3.6-35b-a3b", connectionId: "goose-1" })).toEqual({ model: "qwen/qwen3.6-35b-a3b", connectionId: "goose-1" })
    expect(carried({ backend: "gemini", model: "gemini-2.5-pro", connectionId: "gemini-1" })).toEqual({ model: "gemini-2.5-pro", connectionId: "gemini-1" })
  })

  test("Gemini CLI takes a key; an engine from before tool connections shows none of the three", () => {
    expect(KEY_TOOLS).toContain("gemini")
    const shown = view({ backend: "native" }, "", catalog({ harnesses: found, tools: undefined }))
    expect(shown.groups.some((item) => /^tool (opencode|gemini|goose)/.test(item.id))).toBe(false)
  })
})

describe("choosing models", () => {
  const options = ["a", "b", "c", "d", "e"].map((id) => ({ id }))

  test("a new provider starts with its first few, a coding tool with its whole short list, or every model", () => {
    expect(recommendedModels(options, false)).toEqual(["a", "b", "c", "d"])
    expect(recommendedModels(options, true)).toEqual(["a", "b", "c", "d", "e"])
    const long = Array.from({ length: 41 }, (_, index) => ({ id: `m${String(index)}` }))
    expect(recommendedModels(long, true)).toEqual([])
  })

  test("models are added once, dropped, and moved to the front to become the default", () => {
    expect(chooseModel(["a"], "b")).toEqual(["a", "b"])
    expect(chooseModel(["a", "b"], "a")).toEqual(["a", "b"])
    expect(dropModel(["a", "b"], "a")).toEqual(["b"])
    expect(firstModel(["a", "b", "c"], "c")).toEqual(["c", "a", "b"])
    expect(firstModel(["a"], "z")).toEqual(["a"])
  })
})

describe("coding tools in Add provider", () => {
  const data = (found: readonly CodingTool[], connections: readonly ToolConnection[] = []): ConnectData => ({ catalog: { presets: [], custom: [] }, detected: [], flows: [], tools: { found, connections } })

  test("installed tools come first, marked until one is added", () => {
    const tiles = buildTiles("", data(HARNESSES, [TOOLS[0]!]), [])
    expect(tiles.tools.map((tile) => [tile.key, tile.badge, tile.count])).toEqual([
      ["tool:claude-code", undefined, 1],
      ["tool:codex", "Installed", 0],
      ["tool:copilot", "Installed", 0],
      ["tool:opencode", undefined, 0],
      ["tool:gemini", undefined, 0],
      ["tool:goose", undefined, 0],
      ["tool:pi", "Not installed", 0],
    ])
    expect(tiles.subscriptions.some((tile) => tile.key.startsWith("route:"))).toBe(false)
  })

  test("an engine without tool connections shows each tool as instructions", () => {
    const tiles = buildTiles("", { catalog: { presets: [], custom: [] }, detected: [], flows: [] }, [])
    expect(tiles.tools).toEqual([])
    expect(tiles.subscriptions.map((tile) => tile.key)).toContain("route:claude-code")
  })

  test("the dialog opens on a tool, on a connection's models, or on what a tool connection needs", () => {
    const connections = [toolConnection("codex-2", "codex", { authMode: "api-key", separateAccount: true }), TOOLS[1]!, TOOLS[0]!]
    const tools = data(HARNESSES, connections)
    expect(initialStep({ tool: "codex" }, tools, [])).toEqual({ kind: "tool", tool: "codex" })
    expect(initialStep({ models: "claude-code-2" }, tools, [])).toEqual({ kind: "models", connectionId: "claude-code-2" })
    expect(initialStep({ models: "gone" }, tools, [])).toEqual({ kind: "pick" })
    expect(initialStep({ connectionId: "codex-2" }, tools, [])).toEqual({ kind: "tool-key", connection: connections[0]! })
    expect(initialStep({ connectionId: "claude-code-2" }, tools, [])).toEqual({ kind: "tool-sign-in", connection: TOOLS[1]! })
    // The tool's usual login is signed in from the tool itself.
    expect(initialStep({ connectionId: "claude-code-1" }, tools, [])).toEqual({ kind: "pick" })
  })
})

describe("what a tool connection's row says", () => {
  const own = toolConnection("claude-code-1", "claude-code")
  const separate = toolConnection("claude-code-2", "claude-code", { separateAccount: true })
  const key = toolConnection("codex-2", "codex", { authMode: "api-key", separateAccount: true })

  test("how it signs in", () => {
    expect([own, separate, key].map(toolRoute)).toEqual(["The login it already has", "Its own sign-in", "API key"])
  })

  test("turning on a tool found here says first who pays for its threads", () => {
    const one = turnOnText(["claude-code"])
    expect(one).toMatchObject({ title: "Turn on Claude Code?", confirm: "Turn on" })
    expect(one.body).toStartWith("Claude Code runs threads with the login it already has")
    expect(one.body).toContain("Claude plan")
    const all = turnOnText(["claude-code", "codex", "goose"])
    expect(all).toMatchObject({ title: "Turn on 3 coding tools?", confirm: "Turn on all" })
    expect(all.body).toStartWith("Claude Code, Codex and Goose each run threads")
    expect(all.body).toContain("ChatGPT plan")
    expect(all.body).toContain("provider you set up in Goose")
    expect(all.body).toContain("does not sign you out")
    expect(one.body).toContain("does not sign you out")
  })

  test("its status, and the one button that fixes it", () => {
    expect(toolStatusText({ ...own, enabled: false }, { signedIn: true })).toMatchObject({ tone: "off", label: "Off" })
    expect(toolStatusText(own, undefined)).toEqual({ tone: "busy", label: "Checking" })
    expect(toolStatusText(key, { keyStored: false })).toEqual({ tone: "warn", label: "No API key yet", hint: "Add a key to use it.", fix: "Add key" })
    expect(toolStatusText(key, { keyStored: true })).toEqual({ tone: "ok", label: "Ready" })
    expect(toolStatusText(own, { installed: false })).toMatchObject({ tone: "fail", label: "Not installed" })
    expect(toolStatusText(separate, { installed: true, signedIn: false })).toMatchObject({ label: "Not signed in", fix: "Sign in" })
    // The usual login is the tool's to fix, so the row offers no button for it.
    expect(toolStatusText(own, { installed: true, signedIn: false })).not.toHaveProperty("fix")
    expect(toolStatusText(own, { installed: true, signedIn: true })).toEqual({ tone: "ok", label: "Ready" })
  })
})

describe("the tool's own sign-in line", () => {
  test("names the folder in single quotes, so a shell takes it as one word", () => {
    expect(loginLine({ command: "claude", args: ["auth", "login", "--claudeai"], env: { CLAUDE_CONFIG_DIR: "/Users/a/My Folder/claude-code-2" } })).toBe("CLAUDE_CONFIG_DIR='/Users/a/My Folder/claude-code-2' claude auth login --claudeai")
    expect(loginLine({ command: "codex", args: ["login"], env: { CODEX_HOME: "/x/it's" } })).toBe(`CODEX_HOME='/x/it'\\''s' codex login`)
    expect(loginLine({ command: "codex", args: ["login"], env: {} })).toBe("codex login")
  })
})

describe("the preview engine's connection settings", () => {
  test("the system engine also answers which tools are installed, and nothing else new", async () => {
    expect(() => guardRendererRpc(SYSTEM_ENGINE_ID, "harness.status", {})).not.toThrow()
    for (const method of ["codehost.list", "codehost.set", "codehost.connect", "codehost.disconnect", "codehost.status"]) expect(() => guardRendererRpc(SYSTEM_ENGINE_ID, method, { host: "github.com" })).not.toThrow()
    expect(() => guardRendererRpc(SYSTEM_ENGINE_ID, "codehost.remotes", { path: "/Users/me/code/web" })).not.toThrow()
    expect(() => guardRendererRpc(SYSTEM_ENGINE_ID, "conversation.peek", { threadId: "t1", workspace: "/Users/me/code/web" })).not.toThrow()
    expect(await code(() => guardRendererRpc("thread-1", "conversation.peek", { threadId: "t2", workspace: "/Users/me/code/web" }))).toBe("HOST_RPC_REFUSED")
    expect(await code(() => guardRendererRpc(SYSTEM_ENGINE_ID, "codehost.listx", {}))).toBe("HOST_RPC_REFUSED")
    expect(await code(() => guardRendererRpc(SYSTEM_ENGINE_ID, "git.remote.list", {}))).toBe("HOST_RPC_REFUSED")
    expect(await code(() => guardRendererRpc(SYSTEM_ENGINE_ID, "harness.list", {}))).toBe("HOST_RPC_REFUSED")
    expect(await code(() => guardRendererRpc(SYSTEM_ENGINE_ID, "turn.enqueue", {}))).toBe("HOST_RPC_REFUSED")
  })

  test("adds a tool connection with its models, and refuses a way in the tool does not have", async () => {
    const added = (await systemRpc("connection.addTool", { tool: "codex", authMode: "api-key", models: ["preview-codex-small"] })) as { connectionId: string; separateAccount: boolean }
    expect(added).toMatchObject({ kind: "tool", tool: "codex", authMode: "api-key", separateAccount: true, models: ["preview-codex-small"] })
    expect(await code(() => systemRpc("connection.addTool", { tool: "copilot", authMode: "api-key" }))).toBe("CONNECTION_AUTH_UNSUPPORTED")
    expect(await code(() => systemRpc("connection.addTool", { tool: "copilot", authMode: "subscription", separateAccount: true }))).toBe("CONNECTION_AUTH_UNSUPPORTED")
    expect(await code(() => systemRpc("connection.addTool", { tool: "nope", authMode: "subscription" }))).toBe("CONNECTION_INVALID")
    const status = (await systemRpc("connection.status", { connectionId: added.connectionId })) as { keyStored?: boolean }
    expect(status.keyStored).toBe(false)
    await host.connectionSecretSet(added.connectionId, "sk-preview-0123456789", "tool")
    expect(((await systemRpc("connection.status", { connectionId: added.connectionId })) as { keyStored?: boolean }).keyStored).toBe(true)
  })

  test("a model list cannot be emptied, and the default follows a list that drops it", async () => {
    const listing = await listConnectionSettings()
    const tool = listing?.tools[0]
    expect(tool).toBeDefined()
    expect(await code(() => systemRpc("connection.update", { connectionId: tool!.id, models: [] }))).toBe("CONNECTION_MODELS_EMPTY")
    await systemRpc("connection.setDefault", { connectionId: tool!.id, model: "first" })
    await systemRpc("connection.update", { connectionId: tool!.id, models: ["second", "third"] })
    expect((await listConnectionSettings())?.default).toEqual({ connectionId: tool!.id, model: "second", usable: true })
    expect(await code(() => systemRpc("connection.setDefault", { connectionId: tool!.id, model: "first" }))).toBe("CONNECTION_MODEL_NOT_CHOSEN")
  })

  test("a connection that is off cannot be the default", async () => {
    const tool = (await listConnectionSettings())!.tools[0]!
    await systemRpc("connection.update", { connectionId: tool.id, enabled: false })
    expect(await code(() => systemRpc("connection.setDefault", { connectionId: tool.id, model: "opus" }))).toBe("CONNECTION_DISABLED")
  })

  test("a separate account signs in with the tool's own command for its own folder, and out again", async () => {
    const added = (await systemRpc("connection.addTool", { tool: "claude-code", authMode: "subscription", separateAccount: true })) as { connectionId: string }
    const login = await systemRpc("connection.loginCommand", { connectionId: added.connectionId })
    expect(login).toMatchObject({ command: "claude", env: { CLAUDE_CONFIG_DIR: `/preview/accounts/tool-homes/${added.connectionId}` } })
    expect(((await systemRpc("connection.status", { connectionId: added.connectionId })) as { signedIn?: boolean }).signedIn).toBe(false)
    expect(await code(() => systemRpc("connection.vendorSignOut", { connectionId: added.connectionId }))).toBe("CONTROL_INVALID_INPUT")
    expect(await systemRpc("connection.vendorSignOut", { connectionId: added.connectionId, confirm: true })).toEqual({ connectionId: added.connectionId, signedOut: true })
    expect(await code(() => systemRpc("connection.loginCommand", { connectionId: "copilot-9" }))).toBe("CONNECTION_NOT_FOUND")
  })

  test("a separate account signs in through the terminal in the dialog, and the engine picks the command", async () => {
    expect(await loginTerminalOffered()).toBe(true)
    expect(() => guardRendererRpc(SYSTEM_ENGINE_ID, "connection.loginWrite", { loginId: "login-1", data: "code" })).not.toThrow()
    const added = (await systemRpc("connection.addTool", { tool: "claude-code", authMode: "subscription", separateAccount: true })) as { connectionId: string }
    const loginId = await startToolLogin(added.connectionId, 80, 16)
    const first = await readToolLogin(loginId, 0)
    expect(first.data).toContain("claude auth login --claudeai")
    expect(first.data).toContain("Paste code here")
    expect(first.closed).toBe(false)
    await writeToolLogin(loginId, "preview-code\r")
    const last = await readToolLogin(loginId, first.nextSeq)
    expect([last.data.includes("Login successful."), last.closed]).toEqual([true, true])
    expect((await toolConnectionStatus(added.connectionId)).signedIn).toBe(true)
    await closeToolLogin(loginId)
    expect(await code(() => readToolLogin(loginId, 0))).toBe("TOOL_LOGIN_NOT_FOUND")
  })

  test("the sign-in terminal is refused for a key connection and a tool with no sign-in", async () => {
    const key = (await systemRpc("connection.addTool", { tool: "codex", authMode: "api-key" })) as { connectionId: string }
    const copilot = (await systemRpc("connection.addTool", { tool: "copilot", authMode: "subscription" })) as { connectionId: string }
    expect(await code(() => startToolLogin(key.connectionId, 80, 16))).toBe("CONNECTION_AUTH_UNSUPPORTED")
    expect(await code(() => startToolLogin(copilot.connectionId, 80, 16))).toBe("CONNECTION_AUTH_UNSUPPORTED")
    expect(await code(() => writeToolLogin("login-gone", "x"))).toBe("TOOL_LOGIN_NOT_FOUND")
    expect(loginProblemText("TOOL_LOGIN_TOOL_MISSING", "Codex")).toBe("Codex was not found on this computer. Install it, then try again.")
    expect(loginProblemText("CONTROL_INVALID_INPUT", "Codex")).toContain("(CONTROL_INVALID_INPUT)")
  })

  test("removing a tool connection clears the default it held", async () => {
    const tool = (await listConnectionSettings())!.tools[0]!
    await systemRpc("connection.setDefault", { connectionId: tool.id, model: "opus" })
    await systemRpc("connection.removeTool", { connectionId: tool.id })
    const listing = await listConnectionSettings()
    expect(listing?.tools.some((item) => item.id === tool.id)).toBe(false)
    expect(listing?.default).toBeUndefined()
  })
})

describe("the default model", () => {
  const empty: ConnectionSettingsListing = { providers: new Map(), tools: [] }

  async function engineDefault(): Promise<unknown> {
    for (let tries = 0; tries < 50; tries += 1) {
      const listing = await listConnectionSettings()
      if (listing?.default !== undefined) return listing.default
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return (await listConnectionSettings())?.default
  }

  test("an engine without a default leaves the app's own as it is", () => {
    setPrefs({ defaultBackend: "native", defaultModel: "claude-opus-5-5", defaultConnectionId: "anthropic" })
    adoptEngineDefault(empty)
    expect(get().prefs).toMatchObject({ defaultBackend: "native", defaultModel: "claude-opus-5-5", defaultConnectionId: "anthropic" })
  })

  test("the engine's default is what new threads start on, for a model or a tool connection", () => {
    const tool = toolConnection("claude-code-2", "claude-code", { separateAccount: true })
    adoptEngineDefault({ providers: new Map(), tools: [tool], default: { connectionId: "claude-code-2", model: "sonnet", usable: true } })
    expect(get().prefs).toMatchObject({ defaultBackend: "claude-code", defaultToolModel: "sonnet", defaultToolConnectionId: "claude-code-2" })
    adoptEngineDefault({ providers: new Map(), tools: [tool], default: { connectionId: "anthropic", model: "claude-haiku-4-5", usable: true } })
    expect(get().prefs).toMatchObject({ defaultBackend: "native", defaultModel: "claude-haiku-4-5", defaultConnectionId: "anthropic" })
    // One whose connection is off leaves the app's own as it is.
    adoptEngineDefault({ providers: new Map(), tools: [tool], default: { connectionId: "claude-code-2", model: "opus", usable: false } })
    expect(get().prefs.defaultBackend).toBe("native")
  })

  test("picking a default sets it here and in the engine; a tool on its own login clears the engine's", async () => {
    const tool = (await listConnectionSettings())!.tools[0]!
    setStartDefault({ backend: tool.tool, model: "opus", connectionId: tool.id })
    expect(get().prefs).toMatchObject({ defaultBackend: tool.tool, defaultToolModel: "opus", defaultToolConnectionId: tool.id })
    expect(await engineDefault()).toEqual({ connectionId: tool.id, model: "opus", usable: true })
    setStartDefault({ backend: "codex" })
    expect(get().prefs).toMatchObject({ defaultBackend: "codex" })
    expect(get().prefs.defaultToolConnectionId).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect((await listConnectionSettings())?.default).toBeUndefined()
  })
})

describe("allowing for this session", () => {
  test("is offered on Claude Code threads by an engine that remembers it, and sent as the scope", async () => {
    const sent: unknown[] = []
    setHost({
      ...host,
      rpc: (engineId, method, params) => {
        if (method === "approval.resolve") sent.push(params)
        return host.rpc(engineId, method, params)
      },
    })
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    const claude = createThread({ projectId: "p1", backend: "claude-code", model: "opus", connectionId: "claude-code-1" })
    const codex = createThread({ projectId: "p1", backend: "codex" })
    await ensureEngine(claude.id)
    await ensureEngine(codex.id)
    expect(offersSessionApproval(claude.id)).toBe(true)
    expect(offersSessionApproval(codex.id)).toBe(false)
    await resolveApproval(claude.id, "approval-1", true, undefined, "session")
    await resolveApproval(claude.id, "approval-2", true)
    expect(sent).toEqual([{ approvalId: "approval-1", approved: true, scope: "session" }, { approvalId: "approval-2", approved: true }])
  })
})
