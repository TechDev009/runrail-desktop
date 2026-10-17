import { describe, expect, test } from "bun:test"
import type { Connection } from "../src/app/connections"
import type { CatalogModel } from "../src/app/modelText"
import type { Thinking } from "../src/host/types"
import { RECENT_MODELS } from "../src/app/persist"
import {
  anyConnected,
  bestMatch,
  buildPicker,
  classifyPick,
  decodeSelection,
  defaultSelection,
  encodeSelection,
  pickable,
  problemHint,
  pushRecent,
  toggleFavorite,
  reasoningView,
  thinkingLevels,
  selectGroups,
  selectionLabel,
  selectionProblem,
  carried,
  markOf,
  toolModelName,
  toolState,
  triggerView,
  validModelId,
  validToolModelId,
  viaLabel,
  type CodingTool,
  type PickerCatalog,
  type PickerView,
  type Selection,
  priceFact,
} from "../src/app/picker"
import { compact } from "../src/lib/format"

function conn(id: string, extra: Partial<Connection> = {}): Connection {
  return { id, label: id, presetId: id, authMode: "api-key", status: "ready", ...extra }
}

function model(connectionId: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { connectionId, id, ...extra }
}

function catalog(extra: Partial<PickerCatalog> = {}): PickerCatalog {
  return { connections: [], models: [], modelErrors: {}, harnesses: [], ...extra }
}

const ANTHROPIC = conn("anthropic", { label: "Anthropic" })
const OPENAI = conn("openai", { label: "OpenAI" })
const RELAY = conn("relay", { label: "Local relay" })
const GROQ = conn("groq", { label: "Groq", status: "error" })

/** Two connections with a list, one that lists nothing, one that is not ready. */
const MIXED = catalog({
  connections: [ANTHROPIC, OPENAI, GROQ, RELAY],
  models: [
    model("anthropic", "claude-opus-5-5", { name: "Claude Opus 5.5", contextTokens: 200_000 }),
    model("anthropic", "claude-haiku-4-5", { name: "Claude Haiku 4.5" }),
    model("openai", "gpt-5.5", { name: "GPT-5.5" }),
    model("openai", "gpt-5.5-mini", { name: "GPT-5.5 mini", reasoning: false }),
  ],
})

const NOTHING: Selection = { backend: "native" }

function view(input: { catalog?: PickerCatalog; value?: Selection; recents?: readonly { model: string; connectionId: string }[]; favorites?: readonly { model: string; connectionId: string }[]; query?: string; developer?: boolean } = {}): PickerView {
  return buildPicker({ catalog: input.catalog ?? MIXED, value: input.value ?? NOTHING, recents: input.recents ?? [], favorites: input.favorites ?? [], query: input.query ?? "", developer: input.developer ?? false })
}

function groupIds(shown: PickerView): string[] {
  return shown.groups.map((group) => group.id)
}

function labels(shown: PickerView, id: string): string[] {
  return shown.groups.find((group) => group.id === id)?.entries.map((entry) => entry.label) ?? []
}

describe("the model menu", () => {
  test("lists models by connection, then the coding tools", () => {
    const shown = view()
    expect(groupIds(shown)).toEqual(["connection anthropic", "connection openai", "connection relay", "tool claude-code", "tool codex", "tool copilot", "tool pi"])
    expect(shown.groups.map((group) => group.label)).toEqual(["Anthropic", "OpenAI", "Local relay", "Claude Code", "Codex", "GitHub Copilot", "Through Pi"])
    expect(labels(shown, "connection anthropic")).toEqual(["Claude Opus 5.5", "Claude Haiku 4.5"])
    // A coding tool lists its models like a connection does. One that has not said what it offers is its default alone.
    expect(labels(shown, "tool claude-code")).toEqual(["Default", "Fable", "Opus", "Sonnet", "Haiku"])
    expect(labels(shown, "tool codex")).toEqual(["Default"])
    expect(labels(shown, "tool copilot")).toEqual(["Default"])
    expect(labels(shown, "tool pi")).toEqual(["Default"])
    expect(shown.search).toBe(true)
    expect(shown.empty).toBeUndefined()
  })

  test("a connection that is not ready offers nothing", () => {
    expect(groupIds(view())).not.toContain("connection groq")
  })

  test("a model entry carries its connection, its id, and the facts its connection gave", () => {
    const group = view().groups[0]
    const [opus, haiku] = group?.entries ?? []
    expect(group?.mark).toBe("A")
    expect(opus).toMatchObject({ kind: "model", key: "anthropic claude-opus-5-5", backend: "native", model: "claude-opus-5-5", connectionId: "anthropic", title: "claude-opus-5-5", facts: { context: compact(200_000) }, active: false })
    expect(opus?.meta).toBeUndefined()
    expect(haiku?.facts).toBeUndefined()
  })

  test("a list price reads as dollars per million tokens", () => {
    expect(priceFact({ inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 })).toEqual({ short: "$3/$15", long: "List price per million tokens: $3 in, $15 out. Your plan or provider may bill differently." })
    expect(priceFact({ inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 })?.short).toBe("$0.15/$0.6")
    expect(priceFact({ inputUsdPerMillionTokens: 0.001 })?.short).toBe("$0.001 in")
    expect(priceFact({ outputUsdPerMillionTokens: 75 })?.short).toBe("$75 out")
    expect(priceFact({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })?.short).toBe("Free")
    expect(priceFact({})).toBeUndefined()
    expect(priceFact(undefined)).toBeUndefined()
  })

  test("a provider's mark is its first letter or digit", () => {
    expect(["OpenAI", "  xAI", "302.ai", "-"].map(markOf)).toEqual(["O", "X", "3", "?"])
  })

  test("the entry the thread runs on is the active one, and only through its own connection", () => {
    const twice = catalog({ connections: [ANTHROPIC, OPENAI], models: [model("anthropic", "shared"), model("openai", "shared")] })
    const active = pickable(view({ catalog: twice, value: { backend: "native", model: "shared", connectionId: "openai" } })).filter((entry) => entry.active)
    expect(active.map((entry) => entry.key)).toEqual(["openai shared"])
    expect(pickable(view({ value: { backend: "codex" } })).filter((entry) => entry.active).map((entry) => entry.key)).toEqual(["tool codex"])
  })

  test("a connection with no list says how to use it", () => {
    const relay = view().groups.find((group) => group.id === "connection relay")
    expect(relay).toMatchObject({ note: "Lists no models. Type a model id above to use it.", entries: [] })
    expect(relay?.warn).toBeUndefined()
  })

  test("a list that failed names the reason and its code", () => {
    const failed = view({ catalog: { ...MIXED, modelErrors: { relay: "TIMEOUT", openai: "SOMETHING_NEW" } } })
    expect(failed.groups.find((group) => group.id === "connection relay")).toMatchObject({ note: "No answer in time (TIMEOUT)", warn: true })
    // The engine's bundled list still shows under the warning.
    expect(failed.groups.find((group) => group.id === "connection openai")).toMatchObject({ note: "Could not load models (SOMETHING_NEW)", warn: true })
    expect(labels(failed, "connection openai")).toEqual(["GPT-5.5", "GPT-5.5 mini"])
  })
})

describe("searching the model menu", () => {
  test("matches a model by name or by id, and drops the notes", () => {
    const byName = view({ query: "  HAIKU " })
    // The connection with no list offers the text as a model id as well, and Claude Code has a model of that name.
    expect(groupIds(byName)).toEqual(["connection anthropic", "connection relay", "tool claude-code"])
    expect(labels(byName, "connection anthropic")).toEqual(["Claude Haiku 4.5"])
    expect(labels(byName, "tool claude-code")).toEqual(["Haiku"])
    expect(labels(view({ query: "opus-5-5" }), "connection anthropic")).toEqual(["Claude Opus 5.5"])
    expect(byName.groups.every((group) => group.note === undefined)).toBe(true)
  })

  test("a connection's name shows everything it lists", () => {
    const shown = view({ query: "openai" })
    expect(labels(shown, "connection openai")).toEqual(["GPT-5.5", "GPT-5.5 mini"])
    expect(groupIds(shown)).not.toContain("connection anthropic")
  })

  test("a coding tool is found by its name", () => {
    const shown = view({ query: "codex" })
    // Connections with a list do not take the tool's name as a model id.
    expect(groupIds(shown)).toEqual(["connection relay", "tool codex"])
    expect(labels(shown, "tool codex")).toEqual(["Default"])
    expect(labels(view({ query: "claude code" }), "tool claude-code")).toEqual(["Default", "Fable", "Opus", "Sonnet", "Haiku"])
    expect(labels(view({ query: "through pi" }), "tool pi")).toEqual(["Default"])
    expect(groupIds(view({ query: "github" }))).toEqual(["connection relay", "tool copilot"])
  })

  test("Enter takes what matched before a typed id", () => {
    expect(pickable(view({ query: "codex" }))[0]?.kind).toBe("manual")
    expect(bestMatch(view({ query: "codex" }))).toMatchObject({ kind: "tool", backend: "codex" })
    expect(bestMatch(view({ query: "mini" }))).toMatchObject({ kind: "model", model: "gpt-5.5-mini" })
    expect(bestMatch(view({ query: "brand-new-model" }))).toMatchObject({ kind: "manual", model: "brand-new-model", connectionId: "anthropic" })
    expect(bestMatch(view({ query: "recorded", developer: true }))).toMatchObject({ kind: "replay" })
    expect(bestMatch(view({ query: "two words" }))).toBeUndefined()
    // A tool that is not installed is never the pick.
    expect(bestMatch(view({ catalog: { ...MIXED, connections: [ANTHROPIC, OPENAI], harnesses: [{ id: "native" }] }, query: "codex" }))).toBeUndefined()
  })

  test("nothing found is said so", () => {
    const shown = view({ query: "no such thing!" })
    expect(shown.groups).toEqual([])
    expect(shown.empty).toBe("no-match")
  })
})

describe("typing a model id", () => {
  test("a connection with no list always takes a typed id", () => {
    const shown = view({ query: "mini" })
    expect(labels(shown, "connection openai")).toEqual(["GPT-5.5 mini"])
    expect(shown.groups.find((group) => group.id === "connection relay")?.entries).toEqual([
      { kind: "manual", key: "manual relay", backend: "native", model: "mini", connectionId: "relay", label: 'Use "mini"', meta: "Typed id", title: 'Send "mini" to Local relay as the model id', active: false },
    ])
  })

  test("a connection with a list takes one only when no list has the name", () => {
    const shown = view({ query: "my-org/new-model:free" })
    // A coding tool that takes a model takes a typed one too.
    expect(groupIds(shown)).toEqual(["connection anthropic", "connection openai", "connection relay", "tool claude-code", "tool codex", "tool copilot", "tool pi"])
    for (const group of shown.groups) expect(group.entries.map((entry) => entry.kind)).toEqual(["manual"])
    expect(shown.groups[3]?.entries[0]).toEqual({ kind: "manual", key: "manual claude-code", backend: "claude-code", model: "my-org/new-model:free", label: 'Use "my-org/new-model:free"', meta: "Typed id", title: 'Send "my-org/new-model:free" to Claude Code as the model id', active: false })
    expect(view({ query: "mini" }).groups.find((group) => group.id === "connection anthropic")).toBeUndefined()
  })

  test("the typed id is the model that gets picked, as typed", () => {
    const [entry] = pickable(view({ query: " Vendor/Model-X " }))
    expect(entry).toMatchObject({ model: "Vendor/Model-X", connectionId: "anthropic" })
  })

  test("text that cannot be a model id is never offered", () => {
    expect(view({ query: "two words" }).empty).toBe("no-match")
    expect(view({ query: "x".repeat(161) }).groups).toEqual([])
    expect(validModelId("a|b")).toBe(false)
    expect(validModelId("--flag")).toBe(false)
    expect(validModelId("anthropic/claude-opus-5-5@2026:thinking+1")).toBe(true)
  })

  test("a connection whose key was refused does not take one", () => {
    for (const refusal of ["AUTH_FAILED", "CREDENTIAL_MISSING", "SIGN_IN_EXPIRED", "SIGN_IN_FAILED", "ENDPOINT_DENIED"]) {
      const shown = view({ catalog: { ...MIXED, modelErrors: { relay: refusal } }, query: "some-model" })
      expect(groupIds(shown).filter((id) => id.startsWith("connection "))).toEqual(["connection anthropic", "connection openai"])
    }
    const slow = view({ catalog: { ...MIXED, modelErrors: { relay: "TIMEOUT" } }, query: "some-model" })
    expect(groupIds(slow)).toContain("connection relay")
  })

  test("an id the connection already lists is not offered twice", () => {
    const shown = view({ query: "gpt-5.5" })
    expect(shown.groups.find((group) => group.id === "connection openai")?.entries.map((entry) => entry.kind)).toEqual(["model", "model"])
  })

  test("a typed id the thread already runs on is marked", () => {
    const [entry] = view({ query: "local-7b", value: { backend: "native", model: "local-7b", connectionId: "relay" } }).groups.find((group) => group.id === "connection relay")?.entries ?? []
    expect(entry?.active).toBe(true)
  })
})

describe("recent models", () => {
  const many = catalog({
    connections: [ANTHROPIC, OPENAI, GROQ],
    models: [...Array.from({ length: 5 }, (_, index) => model("anthropic", `a-${String(index)}`)), ...Array.from({ length: 4 }, (_, index) => model("openai", `o-${String(index)}`)), model("groq", "g-0")],
  })
  const recents = [
    { model: "o-3", connectionId: "openai" },
    { model: "gone", connectionId: "openai" },
    { model: "g-0", connectionId: "groq" },
    { model: "a-1", connectionId: "anthropic" },
    { model: "a-2", connectionId: "anthropic" },
    { model: "a-3", connectionId: "anthropic" },
  ]

  test("show once the list is long, newest first, three at most", () => {
    const shown = view({ catalog: many, recents })
    expect(shown.groups[0]).toMatchObject({ id: "recent", label: "Recent" })
    // One the connection no longer lists and one on a connection that is not ready are skipped.
    expect(shown.groups[0]?.entries.map((entry) => entry.key)).toEqual(["recent openai o-3", "recent anthropic a-1", "recent anthropic a-2"])
    expect(shown.groups[0]?.entries.map((entry) => entry.meta)).toEqual(["OpenAI", "Anthropic", "Anthropic"])
  })

  test("stay out of a short list, a search, and a list with none to show", () => {
    expect(groupIds(view({ recents: [{ model: "gpt-5.5", connectionId: "openai" }] }))).not.toContain("recent")
    expect(groupIds(view({ catalog: many, recents, query: "a-" }))).not.toContain("recent")
    expect(groupIds(view({ catalog: many, recents: [] }))).not.toContain("recent")
  })
})

describe("favorite models", () => {
  const favorites = [
    { model: "gpt-5.5", connectionId: "openai" },
    { model: "gone", connectionId: "openai" },
    { model: "claude-opus-5-5", connectionId: "anthropic" },
  ]

  test("come first, in the order they were starred, even in a short list", () => {
    const shown = view({ favorites })
    expect(shown.groups[0]).toMatchObject({ id: "favorites", label: "Favorites" })
    expect(shown.groups[0]?.entries.map((entry) => entry.key)).toEqual(["favorite openai gpt-5.5", "favorite anthropic claude-opus-5-5"])
    expect(shown.groups[0]?.entries.every((entry) => entry.favorite === true)).toBe(true)
    // The same model in its connection's list carries the star too.
    expect(shown.groups.find((group) => group.id === "connection openai")?.entries.find((entry) => entry.model === "gpt-5.5")?.favorite).toBe(true)
    expect(shown.groups.find((group) => group.id === "connection openai")?.entries.find((entry) => entry.model === "gpt-5.5-mini")?.favorite).toBeUndefined()
  })

  test("leave a search alone, and a favorite is not repeated under Recent", () => {
    expect(groupIds(view({ favorites, query: "gpt" }))).not.toContain("favorites")
    const many = catalog({ connections: [OPENAI], models: Array.from({ length: 10 }, (_, index) => model("openai", `o-${String(index)}`)) })
    const shown = view({ catalog: many, favorites: [{ model: "o-1", connectionId: "openai" }], recents: [{ model: "o-1", connectionId: "openai" }, { model: "o-2", connectionId: "openai" }] })
    expect(shown.groups.find((group) => group.id === "recent")?.entries.map((entry) => entry.model)).toEqual(["o-2"])
  })

  test("a star toggles, and the oldest falls off past the limit", () => {
    const one = { model: "gpt-5.5", connectionId: "openai" }
    expect(toggleFavorite([], one, 32)).toEqual([one])
    expect(toggleFavorite([one], one, 32)).toEqual([])
    const full = Array.from({ length: 3 }, (_, index) => ({ model: `m-${String(index)}`, connectionId: "openai" }))
    expect(toggleFavorite(full, one, 3)).toEqual([...full.slice(1), one])
  })
})

describe("coding tools in the menu", () => {
  const tool = (id: string, extra: Partial<CodingTool> = {}): CodingTool => ({ id, ...extra })
  /** What the engine reports once it has asked each tool: one ready, one signed out, one missing. */
  const ASKED: readonly CodingTool[] = [
    tool("native"),
    tool("claude-code", { available: true, signedIn: true, models: [{ id: "opus", name: "Opus" }, { id: "opus[1m]", name: "Opus, 1M context" }], freeTextModel: true }),
    tool("codex", { available: true, signedIn: false, models: [{ id: "codex-large", name: "Codex Large" }] }),
    tool("copilot", { available: true, freeTextModel: true }),
    tool("pi", { available: false }),
  ]
  /** A Pi that is signed in to two providers, both offering a model of the same name. */
  const PI_MODELS: CodingTool = tool("pi", { available: true, signedIn: true, freeTextModel: true, models: [{ id: "github-copilot/gpt-large", name: "gpt-large" }, { id: "radius/gpt-large", name: "gpt-large" }, { id: "radius/auto", name: "auto" }] })
  const asked = (input: Parameters<typeof view>[0] = {}): PickerView => view({ catalog: { ...MIXED, harnesses: ASKED }, ...input })
  const group = (shown: PickerView, id: string) => shown.groups.find((item) => item.id === id)

  test("are all offered when the engine could not tell what is installed", () => {
    const shown = view()
    expect(shown.groups.filter((item) => item.id.startsWith("tool")).flatMap((item) => item.entries).every((entry) => entry.disabled === undefined)).toBe(true)
    expect(group(shown, "tool pi")?.entries.map((entry) => [entry.label, entry.meta])).toEqual([["Default", "Set in Pi"]])
    expect(group(shown, "tool copilot")?.entries.map((entry) => [entry.label, entry.meta])).toEqual([["Default", "Set in GitHub Copilot"]])
    expect(group(shown, "tool claude-code")).not.toHaveProperty("note")
  })

  test("one that is not installed cannot be picked", () => {
    const shown = view({ catalog: { ...MIXED, harnesses: [{ id: "native" }, { id: "codex" }] } })
    expect(group(shown, "tool claude-code")).toMatchObject({ note: "Not installed", warn: true, entries: [{ label: "Default", disabled: true, title: "Claude Code was not found on this computer" }] })
    expect(group(shown, "tool claude-code")?.entries).toHaveLength(1)
    expect(group(shown, "tool codex")?.entries.map((entry) => entry.disabled)).toEqual([undefined])
    expect(group(shown, "tool pi")).toMatchObject({ label: "Through Pi", note: "Not installed", warn: true, entries: [{ label: "Default", disabled: true, title: "Pi was not found on this computer" }] })
    expect(group(shown, "tool copilot")).toMatchObject({ note: "Not installed", entries: [{ disabled: true, title: "GitHub Copilot was not found on this computer" }] })
    expect(pickable(shown).map((entry) => entry.key)).not.toContain("tool pi")
    expect(pickable(shown).map((entry) => entry.key)).not.toContain("tool claude-code")
    expect(pickable(shown).map((entry) => entry.key)).toContain("tool codex")
  })

  test("a tool lists the models it reported, and the one in use is marked", () => {
    const shown = asked({ value: { backend: "claude-code", model: "opus[1m]" } })
    expect(group(shown, "tool claude-code")?.entries.map((entry) => [entry.key, entry.label, entry.model, entry.connectionId, entry.active])).toEqual([
      ["tool claude-code", "Default", undefined, undefined, false],
      ["tool claude-code opus", "Opus", "opus", undefined, false],
      ["tool claude-code opus[1m]", "Opus, 1M context", "opus[1m]", undefined, true],
    ])
    expect(group(shown, "tool claude-code")).not.toHaveProperty("note")
    expect(group(asked({ value: { backend: "claude-code" } }), "tool claude-code")?.entries.map((entry) => entry.active)).toEqual([true, false, false])
    // A model on a connection never lights a tool's row of the same name.
    expect(pickable(asked({ value: { backend: "native", model: "opus", connectionId: "anthropic" } })).filter((entry) => entry.active)).toEqual([])
  })

  test("one that says it is not signed in carries a warning and how to fix it, and can still be tried", () => {
    const shown = asked()
    expect(group(shown, "tool codex")).toMatchObject({ note: "Not signed in", warn: true, hint: "Run `codex login` in a terminal, then refresh." })
    // The tool's answer to a short question is not proof, so it warns and never locks the tool away.
    expect(group(shown, "tool codex")?.entries.map((entry) => [entry.label, entry.disabled])).toEqual([["Default", undefined], ["Codex Large", undefined]])
    expect(group(shown, "tool codex")?.entries[0]?.title).toBe("Codex is not signed in. Run `codex login` in a terminal, then refresh.")
    expect(pickable(shown).filter((entry) => entry.backend === "codex").map((entry) => entry.key)).toEqual(["tool codex", "tool codex codex-large"])
    expect(group(asked({ query: "brand-new" }), "tool codex")?.entries.map((entry) => entry.kind)).toEqual(["manual"])
  })

  test("a typed model goes to a tool that is ready, never to one that is not", () => {
    const shown = asked({ query: "claude-fable-5-1[1m]" })
    expect(group(shown, "tool claude-code")?.entries).toEqual([
      { kind: "manual", key: "manual claude-code", backend: "claude-code", model: "claude-fable-5-1[1m]", label: 'Use "claude-fable-5-1[1m]"', meta: "Typed id", title: 'Send "claude-fable-5-1[1m]" to Claude Code as the model id', active: false },
    ])
    // Brackets name a Claude Code variant; no connection takes them, and a tool that is not installed takes nothing.
    expect(groupIds(shown)).toEqual(["tool claude-code", "tool codex", "tool copilot"])
    // Copilot lists no models, so a typed id is the only way to name one.
    expect(group(asked({ query: "gpt-typed" }), "tool copilot")?.entries).toEqual([
      { kind: "manual", key: "manual copilot", backend: "copilot", model: "gpt-typed", label: 'Use "gpt-typed"', meta: "Typed id", title: 'Send "gpt-typed" to GitHub Copilot as the model id', active: false },
    ])
    expect(group(asked({ value: { backend: "copilot", model: "gpt-typed" } }), "tool copilot")?.entries.map((entry) => [entry.label, entry.meta, entry.active])).toEqual([["Default", "Set in GitHub Copilot", false], ["gpt-typed", "Typed id", true]])
    // Copilot does not say whether someone is signed in, so nothing is claimed either way.
    expect(group(asked(), "tool copilot")).not.toHaveProperty("note")
    expect(toolState(ASKED, "copilot")).toBe("ready")
  })

  test("Pi lists what it can run, each model with the provider it comes from", () => {
    const through = (input: Parameters<typeof view>[0] = {}): PickerView => view({ catalog: { ...MIXED, harnesses: [tool("native"), PI_MODELS] }, ...input })
    const shown = through({ value: { backend: "pi", model: "radius/gpt-large" } })
    expect(group(shown, "tool pi")?.label).toBe("Through Pi")
    expect(group(shown, "tool pi")?.entries.map((entry) => [entry.key, entry.label, entry.meta, entry.model, entry.active])).toEqual([
      ["tool pi", "Default", "Set in Pi", undefined, false],
      ["tool pi github-copilot/gpt-large", "gpt-large", "github-copilot", "github-copilot/gpt-large", false],
      ["tool pi radius/gpt-large", "gpt-large", "radius", "radius/gpt-large", true],
      ["tool pi radius/auto", "auto", "radius", "radius/auto", false],
    ])
    expect(group(shown, "tool pi")?.entries[2]?.title).toBe("radius/gpt-large through Pi on this computer, with the login it already has")
    // A provider's name finds its models, and a model no list has can be typed.
    expect(labels(through({ query: "radius" }), "tool pi")).toEqual(["gpt-large", "auto"])
    expect(group(through({ query: "new-hub/new-model" }), "tool pi")?.entries.map((entry) => [entry.kind, entry.model])).toEqual([["manual", "new-hub/new-model"]])
    // Pi with nothing to run on says how to fix that, and can still be tried.
    const out = view({ catalog: { ...MIXED, harnesses: [tool("native"), tool("pi", { available: true, signedIn: false, freeTextModel: true })] } })
    expect(group(out, "tool pi")).toMatchObject({ note: "Not signed in", warn: true, hint: "Run `pi` in a terminal and sign in there with `/login`, then refresh." })
    expect(group(out, "tool pi")?.entries.map((entry) => entry.disabled)).toEqual([undefined])
    expect(group(view({ catalog: { ...MIXED, harnesses: [tool("claude-code", { available: true }), tool("codex", { available: false })] }, query: "brand-new" }), "tool codex")).toBeUndefined()
    expect(group(asked({ query: "opus" }), "tool claude-code")?.entries.map((entry) => entry.kind)).toEqual(["tool", "tool"])
    const closed = view({ catalog: { ...MIXED, harnesses: [tool("claude-code", { available: true, freeTextModel: false })] }, query: "brand-new" })
    expect(group(closed, "tool claude-code")).toBeUndefined()
    expect(validToolModelId("opus[1m]")).toBe(true)
    expect(validToolModelId("-flag")).toBe(false)
    expect(validToolModelId("two words")).toBe(false)
    expect(validToolModelId("x".repeat(129))).toBe(false)
  })

  test("a typed model already in use stays in view", () => {
    const shown = asked({ value: { backend: "claude-code", model: "claude-fable-5-1" } })
    expect(group(shown, "tool claude-code")?.entries[3]).toMatchObject({ key: "tool claude-code claude-fable-5-1", label: "claude-fable-5-1", meta: "Typed id", active: true })
  })

  test("typing works with no connection once a tool is known to be ready", () => {
    expect(view({ catalog: catalog({ harnesses: ASKED }) })).toMatchObject({ empty: "none", search: true })
    expect(view({ catalog: catalog({ harnesses: [tool("claude-code", { available: false }), tool("codex")] }) })).toMatchObject({ empty: "none", search: false })
  })

  test("whether a tool can run", () => {
    expect(toolState([], "codex")).toBe("unknown")
    expect(toolState([tool("codex")], "codex")).toBe("unknown")
    expect(toolState([tool("native")], "codex")).toBe("missing")
    expect(toolState(ASKED, "claude-code")).toBe("ready")
    expect(toolState(ASKED, "codex")).toBe("signed-out")
    expect(toolState(ASKED, "pi")).toBe("missing")
    // Installed, and the tool would not say whether someone is signed in: not a refusal.
    expect(toolState([tool("pi", { available: true })], "pi")).toBe("ready")
  })

  test("a model's name comes from the tool's list, else from Claude Code's known names, else it is the id", () => {
    expect(toolModelName("claude-code", "opus[1m]", ASKED)).toBe("Opus, 1M context")
    expect(toolModelName("claude-code", "sonnet")).toBe("Sonnet")
    expect(toolModelName("codex", "codex-large")).toBe("codex-large")
  })

  test("what of a pick a thread keeps", () => {
    expect(carried({ backend: "native", model: "gpt-5.5", connectionId: "openai" })).toEqual({ model: "gpt-5.5", connectionId: "openai" })
    expect(carried({ backend: "native", model: "gpt-5.5" })).toEqual({})
    expect(carried({ backend: "claude-code", model: "opus" })).toEqual({ model: "opus" })
    // A tool keeps the tool connection it runs as, and one that takes no model keeps none.
    expect(carried({ backend: "codex", model: "codex-large", connectionId: "codex-1" })).toEqual({ model: "codex-large", connectionId: "codex-1" })
    expect(carried({ backend: "codex", connectionId: "codex-1" })).toEqual({ connectionId: "codex-1" })
    expect(carried({ backend: "pi", model: "radius/auto", connectionId: "pi-1" })).toEqual({ model: "radius/auto", connectionId: "pi-1" })
    expect(carried({ backend: "copilot", model: "gpt-typed" })).toEqual({ model: "gpt-typed" })
    expect(carried({ backend: "replay", model: "anything" })).toEqual({})
    expect(carried({ backend: "codex" })).toEqual({})
  })
})

describe("developer entries", () => {
  test("are absent outside developer mode", () => {
    expect(groupIds(view())).not.toContain("developer")
    expect(JSON.stringify(view())).not.toContain("Recorded session")
  })

  test("add the scripted model and recorded sessions", () => {
    const shown = view({ developer: true })
    expect(shown.groups[shown.groups.length - 1]).toMatchObject({ id: "developer", label: "Developer" })
    expect(shown.groups[shown.groups.length - 1]?.entries).toMatchObject([
      { kind: "test", backend: "native", label: "Test model", meta: "Scripted, no connection", active: true },
      { kind: "replay", backend: "replay", label: "Recorded session", meta: "Plays back, no model", active: false },
    ])
    expect(labels(view({ developer: true, query: "recorded" }), "developer")).toEqual(["Recorded session"])
    expect(view({ developer: true, value: { backend: "replay" } }).groups.find((group) => group.id === "developer")?.entries.map((entry) => entry.active)).toEqual([false, true])
  })
})

describe("a menu with no model to offer", () => {
  test("no connection at all", () => {
    const shown = view({ catalog: catalog() })
    expect(shown).toMatchObject({ empty: "none", search: false })
    expect(groupIds(shown)).toEqual(["tool claude-code", "tool codex", "tool copilot", "tool pi"])
  })

  test("connections, none ready", () => {
    expect(view({ catalog: catalog({ connections: [GROQ] }) })).toMatchObject({ empty: "none-ready", search: false })
  })

  test("connections that could not be read", () => {
    const shown = view({ catalog: catalog({ connections: [ANTHROPIC], connectionsError: "ENGINE_UNAVAILABLE" }) })
    expect(shown.empty).toBe("unreadable")
  })
})

describe("what a pick changes", () => {
  const onOpus: Selection = { backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" }

  test("the same model through the same connection changes nothing", () => {
    expect(classifyPick(onOpus, { ...onOpus })).toBe("same")
    expect(classifyPick({ backend: "codex" }, { backend: "codex" })).toBe("same")
    expect(classifyPick({ backend: "codex", model: "codex-large" }, { backend: "codex", model: "codex-large" })).toBe("same")
    expect(classifyPick({ backend: "pi" }, { backend: "pi" })).toBe("same")
    expect(classifyPick({ backend: "replay" }, { backend: "replay", model: "ignored" })).toBe("same")
  })

  test("another model on the same coding tool keeps the conversation", () => {
    expect(classifyPick({ backend: "claude-code" }, { backend: "claude-code", model: "opus" })).toBe("model")
    expect(classifyPick({ backend: "claude-code", model: "opus" }, { backend: "claude-code", model: "sonnet" })).toBe("model")
    expect(classifyPick({ backend: "claude-code", model: "opus" }, { backend: "claude-code" })).toBe("model")
    expect(classifyPick({ backend: "claude-code", model: "opus" }, { backend: "codex", model: "opus" })).toBe("route")
  })

  test("another model, or the same one through another connection, keeps the conversation", () => {
    expect(classifyPick(onOpus, { ...onOpus, model: "claude-haiku-4-5" })).toBe("model")
    expect(classifyPick(onOpus, { ...onOpus, connectionId: "relay" })).toBe("model")
    expect(classifyPick(NOTHING, onOpus)).toBe("model")
  })

  test("to or from a coding tool is a new route", () => {
    expect(classifyPick(onOpus, { backend: "claude-code" })).toBe("route")
    expect(classifyPick({ backend: "claude-code" }, onOpus)).toBe("route")
    expect(classifyPick({ backend: "claude-code" }, { backend: "codex" })).toBe("route")
    expect(classifyPick(onOpus, { backend: "replay" })).toBe("route")
  })
})

describe("why a thread cannot send", () => {
  const connections = [ANTHROPIC, GROQ]

  test("a coding tool or a recorded session needs no model", () => {
    expect(selectionProblem({ backend: "codex" }, [], false)).toBeUndefined()
    expect(selectionProblem({ backend: "replay" }, undefined, false)).toBeUndefined()
  })

  test("no model, or a model with no connection", () => {
    expect(selectionProblem(NOTHING, connections, false)).toBe("no-model")
    expect(selectionProblem({ backend: "native", model: "gpt-5.5" }, connections, false)).toBe("no-model")
    // A model with no connection is never the scripted test model.
    expect(selectionProblem({ backend: "native", model: "gpt-5.5" }, connections, true)).toBe("no-model")
  })

  test("developer mode may run with no model", () => {
    expect(selectionProblem(NOTHING, connections, true)).toBeUndefined()
  })

  test("a connection that was removed or needs attention", () => {
    expect(selectionProblem({ backend: "native", model: "m", connectionId: "openai" }, connections, false)).toBe("connection-removed")
    expect(selectionProblem({ backend: "native", model: "m", connectionId: "groq" }, connections, false)).toBe("connection-not-ready")
    expect(selectionProblem({ backend: "native", model: "m", connectionId: "anthropic" }, connections, false)).toBeUndefined()
  })

  test("a coding tool connection that is on counts as connected, like a ready model connection", () => {
    const codex = { id: "codex-1", tool: "codex" as const, label: "Codex", authMode: "subscription" as const, separateAccount: false, enabled: true }
    expect(anyConnected({ connections: [] })).toBe(false)
    expect(anyConnected({ connections: [conn("openai", { status: "expired" })], tools: [{ ...codex, enabled: false }] })).toBe(false)
    expect(anyConnected({ connections: [], tools: [codex] })).toBe(true)
    expect(anyConnected({ connections: [conn("openai")] })).toBe(true)
  })

  test("nothing is called removed before the connections are read", () => {
    expect(selectionProblem({ backend: "native", model: "m", connectionId: "openai" }, undefined, false)).toBeUndefined()
    expect(selectionProblem(NOTHING, undefined, false)).toBe("no-model")
  })

  test("each reason says what to do", () => {
    expect(problemHint("connection-removed", true)).toBe("This thread's connection is not set up in this app. Connect it, or pick another model.")
    expect(problemHint("connection-not-ready", true)).toBe("The connection for this model needs attention. Fix it in Settings, or pick another model.")
    expect(problemHint("no-model", true)).toBe("Pick a model to send")
    expect(problemHint("no-model", false)).toBe("Connect a model to send")
  })
})

describe("the model a new thread starts on", () => {
  test("reuses a connected coding-tool subscription when no API model is configured", () => {
    const saved = catalog({ tools: [{ id: "claude-code-1", tool: "claude-code", label: "Claude Code", authMode: "subscription", separateAccount: false, enabled: true, models: ["sonnet"] }], harnesses: [{ id: "claude-code", name: "Claude Code", available: true, signedIn: true }] })
    expect(defaultSelection(saved, [])).toEqual({ backend: "claude-code", connectionId: "claude-code-1", model: "sonnet" })
  })

  test("a subscription's reported default is reused, and disabled or signed-out tools are skipped", () => {
    const saved = catalog({ tools: [{ id: "codex-1", tool: "codex", label: "Codex", authMode: "subscription", separateAccount: false, enabled: true }], harnesses: [{ id: "codex", name: "Codex", available: true, signedIn: true, models: [{ id: "codex-model", default: true }] }] })
    expect(defaultSelection(saved, [])).toEqual({ backend: "codex", connectionId: "codex-1", model: "codex-model" })
    expect(defaultSelection({ ...saved, tools: saved.tools?.map((tool) => ({ ...tool, enabled: false })) }, [])).toBeUndefined()
    expect(defaultSelection({ ...saved, harnesses: [{ id: "codex", name: "Codex", available: true, signedIn: false }] }, [])).toBeUndefined()
  })

  test("a separate account is not assumed ready from the tool's usual sign-in", () => {
    expect(defaultSelection(catalog({ tools: [{ id: "claude-code-2", tool: "claude-code", label: "Other Claude", authMode: "subscription", separateAccount: true, enabled: true }], harnesses: [{ id: "claude-code", name: "Claude Code", available: true, signedIn: true }] }), [])).toBeUndefined()
  })

  test("the last one used that can still run", () => {
    const recents = [
      { model: "g-0", connectionId: "groq" },
      { model: "retired", connectionId: "openai" },
      { model: "gpt-5.5-mini", connectionId: "openai" },
    ]
    expect(defaultSelection(MIXED, recents)).toEqual({ backend: "native", model: "gpt-5.5-mini", connectionId: "openai" })
  })

  test("a typed id on a connection with no list is still a valid start", () => {
    expect(defaultSelection(MIXED, [{ model: "local-7b", connectionId: "relay" }])).toEqual({ backend: "native", model: "local-7b", connectionId: "relay" })
  })

  test("else the first model of the first ready connection that lists one", () => {
    expect(defaultSelection(MIXED, [])).toEqual({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    expect(defaultSelection({ connections: [RELAY, GROQ, OPENAI], models: [model("groq", "g-0"), ...MIXED.models] }, [])).toEqual({ backend: "native", model: "gpt-5.5", connectionId: "openai" })
  })

  test("nothing when nothing can run", () => {
    expect(defaultSelection({ connections: [RELAY, GROQ], models: [model("groq", "g-0")] }, [{ model: "g-0", connectionId: "groq" }])).toBeUndefined()
    expect(defaultSelection(catalog(), [])).toBeUndefined()
  })
})

describe("remembering picks", () => {
  test("the newest goes first, once", () => {
    const first = pushRecent([], { model: "a", connectionId: "one" })
    const second = pushRecent(first, { model: "b", connectionId: "one" })
    expect(pushRecent(second, { model: "a", connectionId: "one" })).toEqual([
      { model: "a", connectionId: "one" },
      { model: "b", connectionId: "one" },
    ])
  })

  test("the same model through another connection is another pick", () => {
    expect(pushRecent([{ model: "a", connectionId: "one" }], { model: "a", connectionId: "two" })).toHaveLength(2)
  })

  test("only so many are kept", () => {
    let recents: { model: string; connectionId: string }[] = []
    for (let index = 0; index < RECENT_MODELS + 3; index += 1) recents = pushRecent(recents, { model: `m-${String(index)}`, connectionId: "one" })
    expect(recents).toHaveLength(RECENT_MODELS)
    expect(recents[0]?.model).toBe(`m-${String(RECENT_MODELS + 2)}`)
  })
})

describe("the chip in the composer", () => {
  test("names the model and its reasoning level", () => {
    expect(triggerView({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic", thinking: "high" }, MIXED, false, undefined)).toEqual({ label: "Claude Opus 5.5", mark: "A", reasoning: "high", title: "claude-opus-5-5 through Anthropic" })
    expect(triggerView({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" }, MIXED, false, undefined).reasoning).toBe("medium")
  })

  test("leaves the level out for a model that takes none", () => {
    expect(triggerView({ backend: "native", model: "gpt-5.5-mini", connectionId: "openai", thinking: "high" }, MIXED, false, undefined)).toEqual({ label: "GPT-5.5 mini", mark: "O", title: "gpt-5.5-mini through OpenAI" })
  })

  test("a model the list does not have keeps a readable name", () => {
    expect(triggerView({ backend: "native", model: "claude-sonnet-5-5", connectionId: "relay" }, MIXED, false, undefined)).toMatchObject({ label: "Sonnet 5.5", reasoning: "medium" })
    expect(triggerView({ backend: "native", model: "local-7b", connectionId: "relay" }, MIXED, false, undefined).label).toBe("local-7b")
  })

  test("says what is wrong when the thread cannot send", () => {
    const broken = triggerView({ backend: "native", model: "gpt-5.5", connectionId: "gone" }, MIXED, false, "connection-removed")
    expect(broken.title).toBe(problemHint("connection-removed", true))
    // A chip that cannot send shows the warning, not a provider mark.
    expect(broken.mark).toBeUndefined()
  })

  test("with no model, asks for one", () => {
    expect(triggerView(NOTHING, MIXED, false, "no-model")).toEqual({ label: "No model", title: "Pick a model to send" })
    expect(triggerView(NOTHING, catalog({ connections: [GROQ] }), false, "no-model")).toEqual({ label: "Connect a model", title: "Connect a model to send" })
    expect(triggerView(NOTHING, MIXED, true, undefined).label).toBe("Test model")
  })

  test("names the coding tool that does the work", () => {
    expect(triggerView({ backend: "claude-code", thinking: "high" }, MIXED, false, undefined)).toEqual({ label: "Claude Code", mark: "C", title: "Claude Code on this computer, with the model and login it already has", reasoning: "high" })
    expect(triggerView({ backend: "claude-code", model: "opus" }, MIXED, false, undefined)).toEqual({ label: "Opus", mark: "C", title: "opus through Claude Code on this computer, with the login it already has", reasoning: "medium" })
    expect(triggerView({ backend: "codex", model: "codex-large" }, { ...MIXED, harnesses: [{ id: "codex", models: [{ id: "codex-large", name: "Codex Large" }] }] }, false, undefined).label).toBe("Codex Large")
    expect(triggerView({ backend: "pi", thinking: "high" }, MIXED, false, undefined)).toEqual({ label: "Pi", mark: "P", title: "Pi on this computer, with the model and login it already has", reasoning: "high" })
    // A model inside Pi keeps its provider, since two providers there can offer the same one.
    expect(triggerView({ backend: "pi", model: "radius/gpt-large" }, MIXED, false, undefined)).toEqual({ label: "radius/gpt-large", mark: "P", title: "radius/gpt-large through Pi on this computer, with the login it already has", reasoning: "medium" })
    expect(triggerView({ backend: "copilot", model: "gpt-typed" }, MIXED, false, undefined).label).toBe("gpt-typed")
    expect(triggerView({ backend: "replay" }, MIXED, true, undefined).label).toBe("Recorded session")
  })

  test("shows the level a coding tool runs at", () => {
    // Below the tool's lowest level it runs as Low; Pi runs Off as it is.
    expect(triggerView({ backend: "claude-code", thinking: "off" }, MIXED, false, undefined).reasoning).toBe("low")
    expect(triggerView({ backend: "pi", thinking: "off" }, MIXED, false, undefined).reasoning).toBe("off")
    // A model the tool says does not reason shows none.
    const pi = { ...MIXED, harnesses: [{ id: "pi" as const, models: [{ id: "radius/plain", reasoning: false }] }] }
    expect(triggerView({ backend: "pi", model: "radius/plain", thinking: "high" }, pi, false, undefined)).not.toHaveProperty("reasoning")
  })
})

describe("reasoning levels", () => {
  const NATIVE: readonly Thinking[] = ["off", "minimal", "low", "medium", "high"]
  const TOOLS: CodingTool[] = [
    { id: "claude-code", name: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "codex", name: "Codex", efforts: ["low", "medium", "high"], models: [{ id: "codex-large", efforts: ["low", "medium", "high", "xhigh"] }, { id: "codex-small", efforts: ["low", "medium"] }] },
    { id: "pi", name: "Pi", models: [{ id: "radius/auto", reasoning: true }, { id: "radius/plain", reasoning: false }] },
  ]

  test("belong to a connected model, from Off to High", () => {
    expect(reasoningView({ backend: "native", model: "gpt-5.5", connectionId: "openai" }, MIXED.models)).toEqual({ shown: true, enabled: true, levels: NATIVE })
    expect(reasoningView({ backend: "native", model: "unlisted", connectionId: "relay" }, MIXED.models)).toEqual({ shown: true, enabled: true, levels: NATIVE })
  })

  test("are off for a model that has none", () => {
    expect(reasoningView({ backend: "native", model: "gpt-5.5-mini", connectionId: "openai" }, MIXED.models)).toEqual({ shown: true, enabled: false, levels: NATIVE, note: "This model has no reasoning levels" })
  })

  test("are the ones a coding tool says it takes, and say where its lowest level is", () => {
    expect(reasoningView({ backend: "claude-code", model: "opus", thinking: "high" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: true, levels: ["low", "medium", "high", "xhigh", "max"] })
    expect(reasoningView({ backend: "claude-code", thinking: "off" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: true, levels: ["low", "medium", "high", "xhigh", "max"], note: "Runs as Low, the lowest Claude Code takes" })
    expect(reasoningView({ backend: "codex", thinking: "minimal" }, MIXED.models, TOOLS).note).toBe("Runs as Low, the lowest Codex takes")
    // A tool that said nothing is offered Low to High.
    expect(reasoningView({ backend: "codex" }, MIXED.models)).toEqual({ shown: true, enabled: true, levels: ["low", "medium", "high"] })
    expect(reasoningView({ backend: "copilot", thinking: "minimal" }, MIXED.models).note).toBe("Runs as Low, the lowest GitHub Copilot takes")
    expect(reasoningView({ backend: "copilot", thinking: "max" }, MIXED.models).note).toBe("Max is not listed for GitHub Copilot, so it runs as High")
  })

  test("follow the model when the tool lists them per model", () => {
    expect(reasoningView({ backend: "codex", model: "codex-large", thinking: "xhigh" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: true, levels: ["low", "medium", "high", "xhigh"] })
    expect(reasoningView({ backend: "codex", model: "codex-small", thinking: "high" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: true, levels: ["low", "medium"], note: "High is not listed for this model, so it runs as Medium" })
    // The chip shows the level that runs, and Ultra is offered only where a model lists it.
    expect(triggerView({ backend: "codex", model: "codex-small", thinking: "ultra" }, { ...MIXED, harnesses: TOOLS }, false, undefined).reasoning).toBe("medium")
    expect(reasoningView({ backend: "codex", model: "codex-ultra", thinking: "ultra" }, MIXED.models, [{ id: "codex", name: "Codex", models: [{ id: "codex-ultra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] }]).levels).toContain("ultra")
    // A model the tool did not list falls back to the tool's own levels.
    expect(reasoningView({ backend: "codex", model: "typed-in", thinking: "high" }, MIXED.models, TOOLS).levels).toEqual(["low", "medium", "high"])
  })

  test("Pi takes every level as it is, unless it says the model does not reason", () => {
    const ALL: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    expect(reasoningView({ backend: "pi", thinking: "off" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: true, levels: ALL })
    expect(reasoningView({ backend: "pi", model: "radius/auto", thinking: "max" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: true, levels: ALL })
    expect(reasoningView({ backend: "pi", model: "radius/plain" }, MIXED.models, TOOLS)).toEqual({ shown: true, enabled: false, levels: ALL, note: "Pi says this model does not reason" })
  })

  test("a level the connected model refused is not offered, and the chip shows none for it", () => {
    const value = { backend: "native" as const, model: "gpt-5.5", connectionId: "openai" }
    expect(reasoningView({ ...value, thinking: "low" }, MIXED.models, [], ["high"])).toEqual({ shown: true, enabled: true, levels: ["off", "minimal", "low", "medium"] })
    expect(reasoningView({ ...value, thinking: "high" }, MIXED.models, [], ["high"])).toEqual({ shown: true, enabled: true, levels: ["off", "minimal", "low", "medium"], note: "This model refused High" })
    expect(reasoningView({ ...value, thinking: "off" }, MIXED.models, [], ["off"]).note).toBe("This model cannot turn reasoning off")
    expect(triggerView({ ...value, thinking: "high" }, MIXED, false, undefined, ["high"])).not.toHaveProperty("reasoning")
    expect(triggerView({ ...value, thinking: "low" }, MIXED, false, undefined, ["high"]).reasoning).toBe("low")
  })

  test("a recorded session takes none", () => {
    expect(reasoningView({ backend: "replay" }, MIXED.models, TOOLS)).toEqual({ shown: false, enabled: false, levels: [] })
  })

  test("a list is read in Runrail's order, and only levels it knows are kept", () => {
    expect(thinkingLevels(["max", "low", "persistent", "off", "ultra"], false)).toEqual(["off", "low", "max", "ultra"])
    expect(thinkingLevels(["max", "low", "minimal", "off"], true)).toEqual(["low", "max"])
    expect(thinkingLevels(undefined, false)).toEqual([])
  })
})

describe("short labels", () => {
  test("what a thread runs on", () => {
    expect(selectionLabel({ backend: "native", model: "claude-sonnet-5-5", connectionId: "anthropic" })).toBe("Sonnet 5.5")
    expect(selectionLabel({ backend: "pi" })).toBe("Pi")
    expect(selectionLabel({ backend: "replay" })).toBe("Recorded session")
    expect(selectionLabel(NOTHING)).toBe("No model")
    expect(selectionLabel(NOTHING, true)).toBe("Test model")
    // With the model list at hand, the name is the one the menu shows; a model it does not list keeps the short one.
    const listed = [model("anthropic", "claude-sonnet-5-5", { name: "Claude Sonnet 5.5" })]
    expect(selectionLabel({ backend: "native", model: "claude-sonnet-5-5", connectionId: "anthropic" }, false, listed)).toBe("Claude Sonnet 5.5")
    expect(selectionLabel({ backend: "native", model: "claude-sonnet-5-5", connectionId: "relay" }, false, listed)).toBe("Sonnet 5.5")
    expect(selectionLabel({ backend: "codex" }, false, listed)).toBe("Codex")
    // A coding tool's model is named with the tool, so it is never taken for a connected model.
    expect(selectionLabel({ backend: "claude-code", model: "opus" })).toBe("Opus via Claude Code")
    expect(selectionLabel({ backend: "codex", model: "codex-large" }, false, [], [{ id: "codex", models: [{ id: "codex-large", name: "Codex Large" }] }])).toBe("Codex Large via Codex")
    expect(selectionLabel({ backend: "pi" })).toBe("Pi")
    expect(selectionLabel({ backend: "pi", model: "radius/auto" }, false, [], [{ id: "pi", models: [{ id: "radius/auto", name: "auto" }] }])).toBe("radius/auto via Pi")
    expect(selectionLabel({ backend: "replay", model: "ignored" })).toBe("Recorded session")
  })

  test("the tool a thread runs through", () => {
    expect(viaLabel("native")).toBeUndefined()
    expect(viaLabel("claude-code")).toBe("via Claude Code")
    expect(viaLabel("codex")).toBe("via Codex")
    expect(viaLabel("pi")).toBe("via Pi")
    expect(viaLabel("replay")).toBe("Recorded session")
  })
})

describe("a selection as an option value", () => {
  const cases: Selection[] = [
    { backend: "native", model: "gpt-5.5", connectionId: "openai" },
    { backend: "native", model: "meta-llama/llama-4:free", connectionId: "signin-openrouter" },
    { backend: "native", model: "accounts/fireworks/models/x@2026+a", connectionId: "a.b:c_d-e" },
    { backend: "native" },
    { backend: "claude-code" },
    { backend: "claude-code", model: "opus[1m]" },
    { backend: "codex" },
    { backend: "codex", model: "vendor/codex-large:2026" },
    { backend: "pi" },
    { backend: "replay" },
  ]

  test("reads back as it was written", () => {
    for (const value of cases) expect(decodeSelection(encodeSelection(value))).toEqual(value)
  })

  test("a model without a connection is no model", () => {
    expect(encodeSelection({ backend: "native", model: "gpt-5.5" })).toBe("native")
    // A coding tool's model travels with the tool connection it runs as; a tool that takes none drops both.
    expect(encodeSelection({ backend: "codex", model: "gpt-5.5" })).toBe("codex|gpt-5.5")
    expect(encodeSelection({ backend: "codex", model: "gpt-5.5", connectionId: "codex-2" })).toBe("codex|@codex-2|gpt-5.5")
    expect(decodeSelection("codex|@codex-2|gpt-5.5")).toEqual({ backend: "codex", model: "gpt-5.5", connectionId: "codex-2" })
    expect(decodeSelection("codex|@codex-2")).toEqual({ backend: "codex", connectionId: "codex-2" })
    expect(decodeSelection("codex|@-bad|gpt-5.5")).toBeUndefined()
    expect(encodeSelection({ backend: "pi", model: "radius/auto" })).toBe("pi|radius/auto")
    expect(encodeSelection({ backend: "replay", model: "gpt-5.5" })).toBe("replay")
    expect(decodeSelection("native|openai")).toEqual({ backend: "native" })
    expect(decodeSelection("native|openai|")).toEqual({ backend: "native" })
  })

  test("unknown text is not a selection", () => {
    expect(decodeSelection("")).toBeUndefined()
    expect(decodeSelection("cursor")).toBeUndefined()
    expect(decodeSelection("openai|gpt-5.5")).toBeUndefined()
    expect(decodeSelection("codex|two words")).toBeUndefined()
    expect(decodeSelection("claude-code|--flag")).toBeUndefined()
    expect(decodeSelection("copilot|-p")).toBeUndefined()
    expect(decodeSelection("replay|model")).toBeUndefined()
  })
})

describe("options for a runs-on select", () => {
  const values = (groups: ReturnType<typeof selectGroups>): string[][] => groups.map((group) => group.options.map((option) => option.value))

  test("models by ready connection, then the coding tools", () => {
    const groups = selectGroups(MIXED, undefined)
    expect(groups.map((group) => group.label)).toEqual(["Anthropic", "OpenAI", "Coding tools"])
    expect(values(groups)).toEqual([
      ["native|anthropic|claude-opus-5-5", "native|anthropic|claude-haiku-4-5"],
      ["native|openai|gpt-5.5", "native|openai|gpt-5.5-mini"],
      ["claude-code", "claude-code|fable", "claude-code|opus", "claude-code|sonnet", "claude-code|haiku", "codex", "copilot", "pi"],
    ])
    expect(groups[0]?.options[0]?.label).toBe("Claude Opus 5.5")
    // A closed select shows one option alone, so a tool's model names its tool.
    expect(groups[2]?.options.slice(0, 3).map((option) => option.label)).toEqual(["Claude Code", "Fable via Claude Code", "Opus via Claude Code"])
  })

  test("a current model the list does not have stays selectable", () => {
    const typed = selectGroups(MIXED, { backend: "native", model: "local-7b", connectionId: "relay" })
    expect(typed[0]).toEqual({ label: "Local relay", options: [{ value: "native|relay|local-7b", label: "local-7b" }] })
    const resting = selectGroups(MIXED, { backend: "native", model: "g-0", connectionId: "groq" })
    expect(resting[0]?.label).toBe("Groq")
    expect(selectGroups(MIXED, { backend: "native", model: "gpt-5.5", connectionId: "openai" })).toHaveLength(3)
  })

  test("a removed connection is only called removed once the connections are read", () => {
    const current: Selection = { backend: "native", model: "gpt-5.5", connectionId: "gone" }
    expect(selectGroups(MIXED, current)[0]).toEqual({ label: "Removed connection", options: [{ value: "native|gone|gpt-5.5", label: "GPT-5.5" }] })
    expect(selectGroups(catalog(), current, false)[0]?.label).toBe("Current")
  })

  test("a tool that is not installed is disabled unless it is the current one", () => {
    const only = { ...MIXED, harnesses: [{ id: "native" }, { id: "codex" }] }
    expect(selectGroups(only, undefined)[2]?.options).toEqual([
      { value: "claude-code", label: "Claude Code (not installed)", disabled: true },
      { value: "codex", label: "Codex" },
      { value: "copilot", label: "GitHub Copilot (not installed)", disabled: true },
      { value: "pi", label: "Pi (not installed)", disabled: true },
    ])
    expect(selectGroups(only, { backend: "pi" })[2]?.options[3]).toEqual({ value: "pi", label: "Pi" })
    // The model a saved form names stays selectable on a tool that has since gone.
    expect(selectGroups(only, { backend: "claude-code", model: "opus" })[2]?.options.slice(0, 2)).toEqual([
      { value: "claude-code", label: "Claude Code (not installed)", disabled: true },
      { value: "claude-code|opus", label: "opus via Claude Code" },
    ])
  })

  test("a tool that says it is not signed in is marked and stays selectable, and so does a typed model", () => {
    const tools = { ...MIXED, harnesses: [{ id: "claude-code", available: true, signedIn: true }, { id: "codex", available: true, signedIn: false, models: [{ id: "codex-large", name: "Codex Large" }] }, { id: "pi", available: true }] }
    const options = selectGroups(tools, { backend: "claude-code", model: "claude-fable-5-1" })[2]?.options ?? []
    expect(options.filter((option) => option.value.startsWith("codex"))).toEqual([
      { value: "codex", label: "Codex (not signed in)" },
      { value: "codex|codex-large", label: "Codex Large via Codex (not signed in)" },
    ])
    expect(options.find((option) => option.value === "claude-code|claude-fable-5-1")).toEqual({ value: "claude-code|claude-fable-5-1", label: "claude-fable-5-1 via Claude Code" })
    expect(options[options.length - 1]).toEqual({ value: "pi", label: "Pi" })
  })
})
