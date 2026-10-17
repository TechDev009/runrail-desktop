import { CONNECTION_ID, type BackendId, type Thinking } from "../host/types"
import { compact } from "../lib/format"
import type { Harness } from "../protocol/schemas"
import { connectionLabel, modelKey, modelLabel, modelName, type CatalogModel } from "./modelText"
import type { Connection } from "./connections"
import type { ToolConnection } from "./connectionSettings"
import { ALL_THINKING_LEVELS, BACKEND_LABELS, LEGACY_TOOLS, MODEL_TOOLS, RECENT_MODELS, takesModel, THINKING_LEVELS, TOOL_MODEL_ID, type RecentModel } from "./persist"

/**
 * What the model menu shows, worked out as plain data so it can be tested without a window.
 *
 * A thread runs on a model reached through a connection, or on a coding tool installed on this
 * computer that brings its own login. The menu lists both. Which engine backend does the work is
 * never named outside developer mode.
 */

/** What a thread (or the new-thread composer) runs on. */
export interface Selection {
  readonly backend: BackendId
  readonly model?: string | undefined
  /**
   * Connection `model` is reached through, or on a coding tool the tool connection it runs as. A
   * coding tool with none runs on its own login, as threads from before tool connections do.
   */
  readonly connectionId?: string | undefined
}

/** One model a coding tool offers under its own login. */
export interface ToolModel {
  readonly id: string
  readonly name?: string | undefined
  /** The levels this model takes, when the tool lists them per model (Codex). */
  readonly efforts?: readonly Thinking[] | undefined
  /** False when the tool says the model does not reason (Pi). */
  readonly reasoning?: boolean | undefined
  /** The exact model an alias runs, as the tool reported it (Claude Code: `opus` -> `claude-opus-5-5`). */
  readonly resolved?: string | undefined
  /** The model the tool starts on when none is named. */
  readonly default?: boolean | undefined
  /** Not in the tool's own list but run by its id (older Claude versions); the account may not have it. */
  readonly catalog?: boolean | undefined
}

/** A coding tool the engine knows, with what the tool said when the engine asked it about itself. */
export interface CodingTool extends Harness {
  /** False when the tool is not installed. Absent until the engine has looked. */
  readonly available?: boolean | undefined
  readonly signedIn?: boolean | undefined
  readonly models?: readonly ToolModel[] | undefined
  /** False when the tool takes only the models it lists. */
  readonly freeTextModel?: boolean | undefined
  /** The levels the tool takes, when it said. */
  readonly efforts?: readonly Thinking[] | undefined
  /** Where the tool's own settings send its model requests, when that is not its vendor. */
  readonly proxy?: ToolProxy | undefined
}

export interface ToolProxy {
  readonly address: string
  readonly name?: string | undefined
}

export interface PickerValue extends Selection {
  readonly thinking?: Thinking | undefined
}

export type { RecentModel }

export interface PickerCatalog {
  readonly connections: readonly Connection[]
  readonly models: readonly CatalogModel[]
  /** Connections whose model list could not be read, by stable error code. */
  readonly modelErrors: Readonly<Record<string, string>>
  /** Coding tools the engine found on this computer. Empty when it could not tell. */
  readonly harnesses: readonly CodingTool[]
  /**
   * The coding-tool connections a thread can run as. Absent from an engine without them, where
   * every installed tool is offered with its own login.
   */
  readonly tools?: readonly ToolConnection[] | undefined
  readonly connectionsError?: string | undefined
}

export type EntryKind = "model" | "manual" | "tool" | "test" | "replay"

/** What a row can say about its model at a glance, when the connection told us. */
export interface ModelFacts {
  readonly context?: string
  readonly reasoning?: boolean
  readonly images?: boolean
  /** `short` fits the row ("$3/$15"); `long` says what it means. */
  readonly price?: { readonly short: string; readonly long: string }
}

export interface PickerEntry extends Selection {
  readonly kind: EntryKind
  readonly key: string
  readonly label: string
  readonly meta?: string
  readonly facts?: ModelFacts
  readonly title?: string
  readonly disabled?: boolean
  readonly active: boolean
  /** A connected model the person starred. */
  readonly favorite?: boolean
}

export interface PickerGroup {
  readonly id: string
  readonly label: string
  /** A letter mark for the provider or tool; recent and developer groups have none. */
  readonly mark?: string
  readonly note?: string
  /** The note reports a failure rather than a hint. */
  readonly warn?: boolean
  /** What to do about the failure. */
  readonly hint?: string
  readonly entries: readonly PickerEntry[]
}

export type PickerEmpty = "unreadable" | "none-ready" | "none" | "no-match"

export interface PickerView {
  readonly groups: readonly PickerGroup[]
  /** Whether typing can narrow the list or name a model the list does not have. */
  readonly search: boolean
  readonly empty?: PickerEmpty
}

/** Coding tools a thread can run on instead of a connected model. */
export const TOOL_BACKENDS = MODEL_TOOLS
const RECENT_SHOWN = 3
/** "Recent" earns its rows only once the list no longer fits at a glance. */
const RECENT_FROM = 9
/** Never a leading hyphen: the id travels as a command-line argument. */
const MODEL_ID = /^(?!-)[A-Za-z0-9._\-:/@+]{1,160}$/
/** Claude Code's model names, for before the engine has asked the tool and for labels. */
const CLAUDE_MODELS: readonly ToolModel[] = [
  { id: "fable", name: "Fable" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
]
/** How to sign in to a tool, which only the tool itself can do. */
const TOOL_FIX: Record<(typeof MODEL_TOOLS)[number], string> = {
  "claude-code": "Run `claude auth login` in a terminal, then refresh.",
  codex: "Run `codex login` in a terminal, then refresh.",
  copilot: "Run `copilot login` in a terminal, then refresh.",
  opencode: "Run `opencode auth login` in a terminal, then refresh.",
  gemini: "Run `gemini` in a terminal and sign in there, then refresh.",
  goose: "Run `goose configure` in a terminal, then refresh.",
  pi: "Run `pi` in a terminal and sign in there with `/login`, then refresh.",
}
/** Pi runs whatever it is signed in to, so its group is named for what it is: a way through. */
const TOOL_GROUP_LABELS: Partial<Record<BackendId, string>> = { pi: "Through Pi" }

/** The heading a coding tool's models are listed under. */
export function toolGroupLabel(backend: BackendId): string {
  return TOOL_GROUP_LABELS[backend] ?? BACKEND_LABELS[backend]
}

/** Pi names a model `provider/model`; the provider is the part before the first slash. */
function piProvider(model: string): string | undefined {
  const cut = model.indexOf("/")
  return cut > 0 ? model.slice(0, cut) : undefined
}

const LIST_ERRORS: Record<string, string> = {
  AUTH_FAILED: "The key was rejected",
  CREDENTIAL_MISSING: "No key stored",
  SIGN_IN_EXPIRED: "Sign in again",
  SIGN_IN_FAILED: "Sign-in failed",
  TIMEOUT: "No answer in time",
  RATE_LIMITED: "Rate limited",
  ENDPOINT_DENIED: "The address is not allowed",
  INVALID_RESPONSE: "The answer could not be read",
}
/** A list that failed this way will not take a typed model id either. */
const REFUSED = new Set(["AUTH_FAILED", "CREDENTIAL_MISSING", "SIGN_IN_EXPIRED", "SIGN_IN_FAILED", "ENDPOINT_DENIED"])

export const THINKING_TEXT: Record<Thinking, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra" }
/** The same levels in a sentence. */
export const THINKING_NAME: Record<Thinking, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" }

/** A provider's letter mark: its first letter or digit, upper case. */
export function markOf(label: string): string {
  return (/[A-Za-z0-9]/.exec(label)?.[0] ?? "?").toUpperCase()
}

function dollars(value: number): string {
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toPrecision(1)}`
  return `$${value < 10 ? String(Math.round(value * 100) / 100) : String(Math.round(value * 10) / 10)}`
}

/** A model's list price per million tokens, for a row. Both sides free reads "Free". */
export function priceFact(pricing: CatalogModel["pricing"]): ModelFacts["price"] | undefined {
  const input = pricing?.inputUsdPerMillionTokens
  const output = pricing?.outputUsdPerMillionTokens
  if (input === undefined && output === undefined) return undefined
  if (input === 0 && output === 0) return { short: "Free", long: "Listed as free" }
  const short = input !== undefined && output !== undefined ? `${dollars(input)}/${dollars(output)}` : input !== undefined ? `${dollars(input)} in` : `${dollars(output!)} out`
  const parts = [...(input === undefined ? [] : [`${dollars(input)} in`]), ...(output === undefined ? [] : [`${dollars(output)} out`])]
  return { short, long: `List price per million tokens: ${parts.join(", ")}. Your plan or provider may bill differently.` }
}

function factsOf(model: CatalogModel): { readonly facts?: ModelFacts } {
  const facts: { context?: string; reasoning?: boolean; images?: boolean; price?: ModelFacts["price"] } = {}
  if (model.contextTokens !== undefined && model.contextTokens > 0) facts.context = compact(model.contextTokens)
  if (model.reasoning === true) facts.reasoning = true
  if (model.images === true) facts.images = true
  const price = priceFact(model.pricing)
  if (price !== undefined) facts.price = price
  return Object.keys(facts).length === 0 ? {} : { facts }
}

/** Whether `text` can be sent to the engine as a model id. */
export function validModelId(text: string): boolean {
  return MODEL_ID.test(text)
}

function findModel(models: readonly CatalogModel[], value: Selection): CatalogModel | undefined {
  if (value.model === undefined || value.connectionId === undefined) return undefined
  return models.find((model) => model.id === value.model && model.connectionId === value.connectionId)
}

/** Whether a thread can pick this connection: ready, and not turned off. */
export function offeredConnection(connection: Connection): boolean {
  return connection.status === "ready" && connection.enabled !== false
}

/**
 * The models a connection offers, in its order: the chosen ones, each as listed when the list has
 * it, else the whole list. A chosen id the list lacks (typed in) is still offered.
 */
export function offeredModels(models: readonly CatalogModel[], connection: Pick<Connection, "id" | "models">): CatalogModel[] {
  const listed = models.filter((model) => model.connectionId === connection.id)
  if (connection.models === undefined) return listed
  return connection.models.map((id) => listed.find((model) => model.id === id) ?? { id, connectionId: connection.id })
}

/** Whether `text` can be sent to a coding tool as a model id. */
export function validToolModelId(text: string): boolean {
  return TOOL_MODEL_ID.test(text)
}

export { MODEL_TOOLS, takesModel }

/**
 * What of a selection a thread keeps. A connected model needs its connection, a coding tool that
 * takes a model keeps the model and the tool connection it runs as, and anything else names neither.
 */
export function carried(selection: Selection): { readonly model?: string; readonly connectionId?: string } {
  if (selection.backend === "native") return selection.model === undefined || selection.connectionId === undefined ? {} : { model: selection.model, connectionId: selection.connectionId }
  if (!takesModel(selection.backend)) return {}
  return { ...(selection.model === undefined ? {} : { model: selection.model }), ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }) }
}

export type ToolState = "ready" | "unknown" | "missing" | "signed-out"

/** Whether a coding tool can run. "unknown" is the engine not having looked, and is never a refusal. */
export function toolState(tools: readonly CodingTool[], backend: BackendId): ToolState {
  if (tools.length === 0) return "unknown"
  const tool = tools.find((item) => item.id === backend)
  if (tool === undefined || tool.available === false) return "missing"
  if (tool.signedIn === false) return "signed-out"
  return tool.available === true ? "ready" : "unknown"
}

export function toolModels(tools: readonly CodingTool[], backend: BackendId): readonly ToolModel[] {
  const listed = tools.find((item) => item.id === backend)?.models
  if (listed !== undefined && listed.length > 0) return listed
  return backend === "claude-code" ? CLAUDE_MODELS : []
}

/** A coding tool's model as the menu names it. */
export function toolModelName(backend: BackendId, model: string, tools: readonly CodingTool[] = []): string {
  // Two providers inside Pi can offer the same model, so away from its list a Pi model keeps its full id.
  if (backend === "pi") return model
  return toolModels(tools, backend).find((item) => item.id === model)?.name ?? model
}

export function buildPicker(input: {
  readonly catalog: PickerCatalog
  readonly value: Selection
  readonly recents: readonly RecentModel[]
  /** Starred models, listed first. */
  readonly favorites?: readonly RecentModel[]
  readonly query: string
  readonly developer: boolean
}): PickerView {
  const { catalog, value, developer } = input
  const typed = input.query.trim()
  const needle = typed.toLowerCase()
  const ready = catalog.connections.filter(offeredConnection)
  const onModel = (model: string, connectionId: string): boolean => value.backend === "native" && value.model === model && value.connectionId === connectionId
  const favorites = input.favorites ?? []
  const starred = (model: CatalogModel): boolean => favorites.some((item) => item.model === model.id && item.connectionId === model.connectionId)
  const modelEntry = (model: CatalogModel, prefix: string, meta: string | undefined): PickerEntry => ({
    kind: "model",
    key: `${prefix}${modelKey(model)}`,
    backend: "native",
    model: model.id,
    connectionId: model.connectionId,
    label: modelName(model),
    ...(meta === undefined ? {} : { meta }),
    ...factsOf(model),
    title: model.id,
    active: onModel(model.id, model.connectionId),
    ...(starred(model) ? { favorite: true } : {}),
  })
  const manualEntry = (connection: Connection): PickerEntry => ({
    kind: "manual",
    key: `manual ${connection.id}`,
    backend: "native",
    model: typed,
    connectionId: connection.id,
    label: `Use "${typed}"`,
    meta: "Typed id",
    title: `Send "${typed}" to ${connection.label} as the model id`,
    active: onModel(typed, connection.id),
  })

  const groups: PickerGroup[] = []

  const readyModel = (pick: RecentModel): CatalogModel | undefined => {
    const connection = ready.find((item) => item.id === pick.connectionId)
    return connection === undefined ? undefined : offeredModels(catalog.models, connection).find((model) => model.id === pick.model)
  }
  if (needle.length === 0) {
    const entries = favorites.flatMap((favorite) => {
      const model = readyModel(favorite)
      return model === undefined ? [] : [modelEntry(model, "favorite ", connectionLabel(model.connectionId, catalog.connections))]
    })
    if (entries.length > 0) groups.push({ id: "favorites", label: "Favorites", entries })
  }
  if (needle.length === 0 && catalog.models.length >= RECENT_FROM) {
    const entries: PickerEntry[] = []
    for (const recent of input.recents) {
      if (entries.length === RECENT_SHOWN) break
      const model = readyModel(recent)
      if (model !== undefined && !starred(model)) entries.push(modelEntry(model, "recent ", connectionLabel(model.connectionId, catalog.connections)))
    }
    if (entries.length > 0) groups.push({ id: "recent", label: "Recent", entries })
  }

  const listed = ready.map((connection) => {
    const all = offeredModels(catalog.models, connection)
    const whole = needle.length === 0 || connection.label.toLowerCase().includes(needle)
    const shown = whole ? all : all.filter((model) => model.id.toLowerCase().includes(needle) || modelName(model).toLowerCase().includes(needle))
    return { connection, all, shown }
  })
  // A coding tool that takes a model is listed like a connection: its models under its name.
  const onTool = (backend: BackendId, model: string | undefined, connectionId: string | undefined): boolean => value.backend === backend && value.model === model && value.connectionId === connectionId
  const toolGroup = (backend: (typeof MODEL_TOOLS)[number], connection: ToolConnection | undefined): ToolGroup => {
    const name = BACKEND_LABELS[backend]
    const heading = connection?.label ?? toolGroupLabel(backend)
    const state = toolState(catalog.harnesses, backend)
    // Only a tool that is not there is refused. "Not signed in" is the tool's own word about its
    // usual login, so it says nothing of a connection with its own folder or key.
    const off = state === "missing"
    const ownLogin = connection === undefined || (connection.authMode === "subscription" && !connection.separateAccount)
    const signedOut = state === "signed-out" && ownLogin
    const whole = needle.length === 0 || name.toLowerCase().includes(needle) || heading.toLowerCase().includes(needle)
    const fix = TOOL_FIX[backend]
    const why = state === "missing" ? `${name} was not found on this computer` : signedOut ? `${name} is not signed in. ${fix}` : undefined
    const through = connection === undefined ? `${name} on this computer` : `${connection.label}`
    const login = connection === undefined || ownLogin ? "with the login it already has" : connection.authMode === "api-key" ? "with its own key" : "with its own sign-in"
    // Under Pi a row is the model, with the provider it comes from beside it.
    const provider = (model: ToolModel): string | undefined => (backend === "pi" && model.name !== undefined ? piProvider(model.id) : undefined)
    // The exact model behind a name, so "Opus 5.5" also says `claude-opus-5-5`; nothing when the name is the id.
    const exact = (model: ToolModel): string | undefined => (model.resolved !== undefined && model.resolved !== model.name ? model.resolved : model.catalog === true ? model.id : undefined)
    const fallback = state === "missing" ? undefined : toolModels(catalog.harnesses, backend).find((model) => model.default === true)
    const key = connection === undefined ? `tool ${backend}` : `tool ${backend} @${connection.id}`
    const row = (model: ToolModel | undefined, typedId = false): PickerEntry => ({
      kind: "tool",
      key: model === undefined ? key : `${key} ${model.id}`,
      backend,
      ...(model === undefined ? {} : { model: model.id }),
      ...(connection === undefined ? {} : { connectionId: connection.id }),
      label: model === undefined ? "Default" : (model.name ?? model.id),
      ...(model === undefined ? { meta: fallback === undefined ? `Set in ${name}` : `${fallback.name ?? fallback.id} · set in ${name}` } : typedId ? { meta: "Typed id" } : provider(model) !== undefined ? { meta: provider(model) } : exact(model) === undefined ? {} : { meta: exact(model) }),
      title: why ?? (model === undefined ? `${through}, with the model ${name} picks${fallback === undefined ? "" : ` (${fallback.resolved ?? fallback.id} now)`}, ${login}` : `${exact(model) ?? model.id} through ${through}, ${login}${model.catalog === true ? `. Not in ${name}'s own list: a model the plan does not include is refused on the first message` : ""}`),
      ...(off ? { disabled: true } : {}),
      active: onTool(backend, model?.id, connection?.id),
    })
    const all = state === "missing" ? [] : toolModels(catalog.harnesses, backend)
    // Chosen models, named as the tool lists them; the first is what the connection starts on.
    const models = connection?.models === undefined ? all : connection.models.map((id) => all.find((model) => model.id === id) ?? { id })
    const shown = whole ? models : models.filter((model) => model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle))
    const entries = [...(whole && connection?.models === undefined ? [row(undefined)] : []), ...shown.map((model) => row(model))]
    // A model typed in earlier stays in view as the one in use.
    if (whole && !off && value.backend === backend && value.connectionId === connection?.id && value.model !== undefined && !models.some((model) => model.id === value.model)) entries.push(row({ id: value.model }, true))
    const freeText = connection?.models === undefined && catalog.harnesses.find((tool) => tool.id === backend)?.freeTextModel !== false
    return { backend, connectionId: connection?.id, name, heading, state, off, signedOut, fix, models, entries, freeText }
  }
  // With tool connections, a tool is offered as each connection that is on. A thread from before
  // them, on the tool's own login, still shows what it runs on.
  const modelTools: ToolGroup[] =
    catalog.tools === undefined
      ? LEGACY_TOOLS.map((backend) => toolGroup(backend, undefined))
      : [
          ...catalog.tools.filter((tool) => tool.enabled).map((tool) => toolGroup(tool.tool, tool)),
          ...(takesModel(value.backend) && value.connectionId === undefined ? [toolGroup(value.backend, undefined)].map((group) => ({ ...group, entries: group.entries.filter((entry) => entry.active) })) : []),
        ]
  const extras: PickerEntry[] = developer
    ? [
        { kind: "test" as const, key: "test", backend: "native" as const, label: "Test model", meta: "Scripted, no connection", title: "Scripted model built into the engine. Developer mode only.", active: value.backend === "native" && value.model === undefined },
        { kind: "replay" as const, key: "replay", backend: "replay" as const, label: "Recorded session", meta: "Plays back, no model", title: "Plays a recorded session back. Developer mode only.", active: value.backend === "replay" },
      ].filter((entry) => needle.length === 0 || entry.label.toLowerCase().includes(needle))
    : []
  // Text that names something on offer is a search, not a model id for every connection.
  const matched = listed.reduce((count, item) => count + item.shown.length, 0) + (needle.length === 0 ? 0 : modelTools.reduce((count, tool) => count + tool.entries.length, 0) + extras.length)
  const canType = validModelId(typed)

  for (const { connection, all, shown } of listed) {
    const error = catalog.modelErrors[connection.id]
    const refused = error !== undefined && REFUSED.has(error)
    const entries = shown.map((model) => modelEntry(model, "", undefined))
    // A typed id is offered where the list cannot answer: an endpoint with no list, or a name no list has.
    const exact = all.some((model) => model.id === typed)
    // A connection with chosen models takes none other.
    if (canType && !refused && !exact && connection.models === undefined && (all.length === 0 || matched === 0)) entries.push(manualEntry(connection))
    const note =
      needle.length > 0
        ? undefined
        : error !== undefined
          ? `${LIST_ERRORS[error] ?? "Could not load models"} (${error})`
          : all.length === 0
            ? "Lists no models. Type a model id above to use it."
            : undefined
    if (entries.length === 0 && note === undefined) continue
    groups.push({ id: `connection ${connection.id}`, label: connection.label, mark: markOf(connection.label), ...(note === undefined ? {} : { note }), ...(error === undefined ? {} : { warn: true }), entries })
  }

  for (const tool of modelTools) {
    const entries = [...tool.entries]
    const id = tool.connectionId === undefined ? tool.backend : `${tool.backend} @${tool.connectionId}`
    if (validToolModelId(typed) && matched === 0 && !tool.off && tool.freeText && !tool.models.some((model) => model.id === typed)) {
      entries.push({ kind: "manual", key: `manual ${id}`, backend: tool.backend, model: typed, ...(tool.connectionId === undefined ? {} : { connectionId: tool.connectionId }), label: `Use "${typed}"`, meta: "Typed id", title: `Send "${typed}" to ${tool.heading} as the model id`, active: onTool(tool.backend, typed, tool.connectionId) })
    }
    if (entries.length === 0) continue
    const trouble = tool.state === "missing" ? { note: "Not installed", warn: true } : tool.signedOut ? { note: "Not signed in", warn: true, hint: tool.fix } : {}
    groups.push({ id: `tool ${id}`, label: tool.heading, mark: markOf(tool.name), ...trouble, entries })
  }
  if (extras.length > 0) groups.push({ id: "developer", label: "Developer", entries: extras })

  const empty: PickerEmpty | undefined =
    catalog.connectionsError !== undefined
      ? "unreadable"
      : ready.length === 0
        ? catalog.connections.length > 0
          ? "none-ready"
          : "none"
        : needle.length > 0 && groups.length === 0
          ? "no-match"
          : undefined
  // Typing also names a model for a coding tool that is known to be ready, with no connection at all.
  return { groups, search: ready.length > 0 || modelTools.some((tool) => tool.state === "ready" || tool.state === "signed-out"), ...(empty === undefined ? {} : { empty }) }
}

interface ToolGroup {
  readonly backend: (typeof MODEL_TOOLS)[number]
  readonly connectionId: string | undefined
  readonly name: string
  readonly heading: string
  readonly state: ToolState
  readonly off: boolean
  readonly signedOut: boolean
  readonly fix: string
  readonly models: readonly ToolModel[]
  readonly entries: readonly PickerEntry[]
  readonly freeText: boolean
}

/** Every entry that can be picked, in menu order. */
export function pickable(view: PickerView): PickerEntry[] {
  return view.groups.flatMap((group) => group.entries.filter((entry) => entry.disabled !== true))
}

/** What Enter in the search field picks: the first thing on offer that matched, before any typed id. */
export function bestMatch(view: PickerView): PickerEntry | undefined {
  const entries = pickable(view)
  return entries.find((entry) => entry.kind !== "manual") ?? entries[0]
}

export type PickChange = "same" | "model" | "route"

/**
 * A model change keeps the conversation: the same agent loop, or the same coding tool, carries on
 * with another model. A route change does not: a coding tool keeps its own session, so the work
 * moves to a new thread.
 */
export function classifyPick(current: Selection, next: Selection): PickChange {
  if (next.backend !== current.backend) return "route"
  if (next.backend === "native") return next.model === current.model && next.connectionId === current.connectionId ? "same" : "model"
  if (!takesModel(next.backend)) return "same"
  // Another tool connection is another login, with its own sessions.
  if (next.connectionId !== current.connectionId) return "route"
  return next.model === current.model ? "same" : "model"
}

export type SelectionProblem = "no-model" | "connection-removed" | "connection-not-ready"

/**
 * Why a thread cannot send yet. `connections` is undefined while the list is not known, and then
 * only a missing model is reported. Developer mode may run with no model: the scripted test model.
 */
export function selectionProblem(value: Selection, connections: readonly Connection[] | undefined, developer: boolean, tools?: readonly ToolConnection[]): SelectionProblem | undefined {
  if (value.backend !== "native") {
    // A tool connection that is gone or off cannot be run as; the tool's own login is not a stand-in.
    if (value.connectionId === undefined || tools === undefined) return undefined
    const tool = tools.find((item) => item.id === value.connectionId)
    return tool === undefined ? "connection-removed" : tool.enabled ? undefined : "connection-not-ready"
  }
  if (value.model === undefined) return developer ? undefined : "no-model"
  if (value.connectionId === undefined) return "no-model"
  if (connections === undefined) return undefined
  const connection = connections.find((item) => item.id === value.connectionId)
  if (connection === undefined) return "connection-removed"
  return offeredConnection(connection) ? undefined : "connection-not-ready"
}

/** Something to run on: a model connection that is ready, or a coding tool connection that is on. */
export function anyConnected(catalog: { readonly connections: readonly Connection[]; readonly tools?: readonly ToolConnection[] | undefined }): boolean {
  return catalog.connections.some((connection) => connection.status === "ready") || (catalog.tools ?? []).some((tool) => tool.enabled)
}

/** One line for the composer: what is wrong and what to do about it. */
export function problemHint(problem: SelectionProblem, connected: boolean): string {
  // Also a connection this app never had: one the thread got from another install of Runrail.
  if (problem === "connection-removed") return "This thread's connection is not set up in this app. Connect it, or pick another model."
  if (problem === "connection-not-ready") return "The connection for this model needs attention. Fix it in Settings, or pick another model."
  return connected ? "Pick a model to send" : "Connect a model to send"
}

/** The model a new thread starts on when nothing was chosen: the last one used, else the first one offered. */
export function defaultSelection(catalog: Pick<PickerCatalog, "connections" | "models"> & Partial<PickerCatalog>, recents: readonly RecentModel[]): Selection | undefined {
  const ready = catalog.connections.filter(offeredConnection)
  for (const recent of recents) {
    const connection = ready.find((item) => item.id === recent.connectionId)
    if (connection === undefined) continue
    const mine = offeredModels(catalog.models, connection)
    // A typed id on an endpoint with no list is still a valid pick.
    if (mine.length === 0 || mine.some((model) => model.id === recent.model)) return { backend: "native", model: recent.model, connectionId: recent.connectionId }
  }
  for (const connection of ready) {
    const first = offeredModels(catalog.models, connection)[0]
    if (first !== undefined) return { backend: "native", model: first.id, connectionId: connection.id }
  }
  for (const tool of catalog.tools ?? []) {
    const installed = catalog.harnesses?.find((harness) => harness.id === tool.tool)
    // Detection describes the usual login only. A separate account must be selected after its own sign-in succeeds.
    if (!tool.enabled || tool.authMode !== "subscription" || tool.separateAccount || installed?.available !== true || installed.signedIn !== true) continue
    const model = tool.models?.[0] ?? installed.models?.find((model) => model.default === true)?.id
    return { backend: tool.tool, connectionId: tool.id, ...(model === undefined ? {} : { model }) }
  }
  return undefined
}

/** `recents` with `pick` moved to the front. */
/** Stars a model, or takes its star away. Newest star last, so the list keeps the order they were added in. */
export function toggleFavorite(favorites: readonly RecentModel[], pick: RecentModel, max: number): RecentModel[] {
  const rest = favorites.filter((item) => item.model !== pick.model || item.connectionId !== pick.connectionId)
  return rest.length < favorites.length ? rest : [...favorites, { model: pick.model, connectionId: pick.connectionId }].slice(-max)
}

export function pushRecent(recents: readonly RecentModel[], pick: RecentModel): RecentModel[] {
  return [pick, ...recents.filter((item) => item.model !== pick.model || item.connectionId !== pick.connectionId)].slice(0, RECENT_MODELS)
}

export interface TriggerView {
  readonly label: string
  /** The letter mark of the provider or coding tool the model is reached through. */
  readonly mark?: string
  /** Shown next to the model, when the model takes one. */
  readonly reasoning?: Thinking
  readonly title: string
}

/** The chip in the composer: the model and its reasoning level, or the tool that does the work. */
export function triggerView(value: PickerValue, catalog: Pick<PickerCatalog, "connections" | "models"> & { readonly harnesses?: readonly CodingTool[]; readonly tools?: readonly ToolConnection[] | undefined }, developer: boolean, problem: SelectionProblem | undefined, refused: readonly Thinking[] = []): TriggerView {
  if (value.backend === "replay") return { label: "Recorded session", title: "A recorded session plays back without a model" }
  if (value.backend !== "native") {
    const name = BACKEND_LABELS[value.backend]
    if (!takesModel(value.backend)) return { label: name, mark: markOf(name), title: `${name} uses the model and login it already has` }
    const reasoning = toolReasoning(value, reasoningView(value, catalog.models, catalog.harnesses))
    const mark = markOf(name)
    const connection = value.connectionId === undefined ? undefined : catalog.tools?.find((tool) => tool.id === value.connectionId)
    const through = problem !== undefined ? problemHint(problem, true) : connection === undefined ? `${name} on this computer, with the login it already has` : connection.label
    if (value.model === undefined) return { label: connection?.label ?? name, mark, title: problem === undefined && connection === undefined ? `${name} on this computer, with the model and login it already has` : through, ...reasoning }
    // The chip carries the tool's letter, so its name is not spelled out after the model's.
    const resolved = toolModels(catalog.harnesses ?? [], value.backend).find((model) => model.id === value.model)?.resolved
    return { label: toolModelName(value.backend, value.model, catalog.harnesses), mark, title: problem === undefined ? `${resolved ?? value.model} through ${through}` : through, ...reasoning }
  }
  if (value.model === undefined) {
    if (developer) return { label: "Test model", title: "Scripted model built into the engine" }
    const connected = anyConnected(catalog)
    return { label: connected ? "No model" : "Connect a model", title: problemHint("no-model", connected) }
  }
  const picked = findModel(catalog.models, value)
  const label = picked === undefined ? modelLabel(value.model) : modelName(picked)
  const through = connectionLabel(value.connectionId, catalog.connections)
  const title = problem === undefined ? `${value.model} through ${through}` : problemHint(problem, true)
  const reasoning = value.thinking ?? "medium"
  // A level the model refused runs without one, so the chip shows none.
  return { label, ...(problem === undefined ? { mark: markOf(through) } : {}), title, ...(picked?.reasoning === false || refused.includes(reasoning) ? {} : { reasoning }) }
}

export interface ReasoningView {
  readonly shown: boolean
  readonly enabled: boolean
  /** The levels on offer, lowest first. */
  readonly levels: readonly Thinking[]
  readonly note?: string
}

/** What a coding tool takes when it did not say: its levels from Low up to High. */
const TOOL_LEVELS: readonly Thinking[] = ["low", "medium", "high"]
const THINKING_SET: ReadonlySet<string> = new Set(ALL_THINKING_LEVELS)
/** Pi's own levels; Ultra is Codex's alone. */
const PI_LEVELS: readonly Thinking[] = ALL_THINKING_LEVELS.filter((level) => level !== "ultra")

/** The levels a tool or model named, in Runrail's order, without any it cannot run from here. */
export function thinkingLevels(named: readonly string[] | undefined, floor: boolean): readonly Thinking[] {
  if (named === undefined) return []
  // Coding tools other than Pi run Off and Min as Low, so those two are not offered.
  return ALL_THINKING_LEVELS.filter((level) => named.includes(level) && THINKING_SET.has(level) && !(floor && (level === "off" || level === "minimal")))
}

/**
 * Reasoning levels belong to a connected model, or to a coding tool that takes one from Runrail.
 * `refused` are the levels this connected model refused while the app ran; they are not offered.
 */
export function reasoningView(value: PickerValue, models: readonly CatalogModel[], tools: readonly CodingTool[] = [], refused: readonly Thinking[] = []): ReasoningView {
  if (takesModel(value.backend)) {
    const name = BACKEND_LABELS[value.backend]
    const tool = tools.find((item) => item.id === value.backend)
    const model = value.model === undefined ? undefined : tool?.models?.find((item) => item.id === value.model)
    const pi = value.backend === "pi"
    // Pi takes every level as it is; each of the others says which it takes, per model or for the tool.
    const said = thinkingLevels(model?.efforts ?? tool?.efforts, !pi)
    const levels = said.length > 0 ? said : pi ? PI_LEVELS : TOOL_LEVELS
    if (model?.reasoning === false) return { shown: true, enabled: false, levels, note: `${name} says this model does not reason` }
    const current = value.thinking ?? "medium"
    if (levels.includes(current)) return { shown: true, enabled: true, levels }
    const floored = current === "off" || current === "minimal"
    const where = model?.efforts === undefined ? name : "this model"
    return { shown: true, enabled: true, levels, note: floored ? `Runs as Low, the lowest ${name} takes` : `${THINKING_NAME[current]} is not listed for ${where}, so it runs as ${THINKING_NAME[runsAs(levels, current)]}` }
  }
  if (value.backend !== "native") return { shown: false, enabled: false, levels: [] }
  if (findModel(models, value)?.reasoning === false) return { shown: true, enabled: false, levels: THINKING_LEVELS, note: "This model has no reasoning levels" }
  const levels = THINKING_LEVELS.filter((level) => !refused.includes(level))
  const current = value.thinking ?? "medium"
  if (!refused.includes(current)) return { shown: true, enabled: true, levels }
  return { shown: true, enabled: true, levels, note: current === "off" ? "This model cannot turn reasoning off" : `This model refused ${THINKING_NAME[current]}` }
}

/** A level the tool does not list runs as the highest it lists below that level, else its lowest. */
function runsAs(levels: readonly Thinking[], current: Thinking): Thinking {
  if (levels.includes(current)) return current
  const rank = ALL_THINKING_LEVELS.indexOf(current)
  const below = levels.filter((level) => ALL_THINKING_LEVELS.indexOf(level) < rank)
  return below[below.length - 1] ?? levels[0] ?? current
}

/** The level a coding tool runs at: none for a model it says does not reason, else the nearest it lists. */
function toolReasoning(value: PickerValue, view: ReasoningView): { readonly reasoning?: Thinking } {
  if (!view.enabled) return {}
  return { reasoning: runsAs(view.levels, value.thinking ?? "medium") }
}

/** What a thread runs on, in a few words. With the model list at hand it is the name the model menu shows. */
export function selectionLabel(value: Selection, developer = false, models: readonly CatalogModel[] = [], tools: readonly CodingTool[] = []): string {
  if (value.backend === "replay") return "Recorded session"
  if (value.backend !== "native") {
    const name = BACKEND_LABELS[value.backend]
    return value.model !== undefined && takesModel(value.backend) ? `${toolModelName(value.backend, value.model, tools)} via ${name}` : name
  }
  if (value.model === undefined) return developer ? "Test model" : "No model"
  const listed = findModel(models, value)
  return listed === undefined ? modelLabel(value.model) : modelName(listed)
}

/** The tool a thread runs through, when it is not a connected model. */
export function viaLabel(backend: BackendId): string | undefined {
  if (backend === "native") return undefined
  return backend === "replay" ? "Recorded session" : `via ${BACKEND_LABELS[backend]}`
}

// ---------------------------------------------------------------------------------------------
// One <select> for dialogs and settings: models by connection, then the coding tools

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectGroup {
  readonly label: string
  readonly options: readonly SelectOption[]
}

/** Cannot appear in a connection id, so the first two cuts are exact and the rest is the model id. */
const SEPARATOR = "|"

/** A selection as one string, for an option value. A thread on Runrail's own loop with no model named is `native`. */
/** Marks a tool connection's id in an option value; neither a model id nor a connection id starts with it. */
const TOOL_CONNECTION = "@"

export function encodeSelection(value: Selection): string {
  if (value.backend !== "native") {
    if (!takesModel(value.backend)) return value.backend
    return [value.backend, ...(value.connectionId === undefined ? [] : [`${TOOL_CONNECTION}${value.connectionId}`]), ...(value.model === undefined ? [] : [value.model])].join(SEPARATOR)
  }
  return value.model === undefined || value.connectionId === undefined ? "native" : ["native", value.connectionId, value.model].join(SEPARATOR)
}

export function decodeSelection(text: string): Selection | undefined {
  const [backend, ...parts] = text.split(SEPARATOR)
  if (backend === "native") {
    const [connectionId, ...rest] = parts
    const model = rest.join(SEPARATOR)
    return connectionId === undefined || model.length === 0 ? { backend: "native" } : { backend: "native", model, connectionId }
  }
  const tool = MODEL_TOOLS.find((item) => item === backend)
  if (tool !== undefined) {
    const connectionId = parts[0]?.startsWith(TOOL_CONNECTION) === true ? parts.shift()!.slice(TOOL_CONNECTION.length) : undefined
    if (connectionId !== undefined && !CONNECTION_ID.test(connectionId)) return undefined
    const model = parts.join(SEPARATOR)
    const through = connectionId === undefined ? {} : { connectionId }
    return model.length === 0 ? { backend: tool, ...through } : validToolModelId(model) ? { backend: tool, model, ...through } : undefined
  }
  return backend === "replay" && parts.length === 0 ? { backend } : undefined
}

/**
 * Option groups for a "runs on" select. `current` stays selectable even when the catalog no longer
 * lists it, so an open form never silently changes what was saved. `known` is false while the
 * connections are still being read, when a missing one cannot be called removed.
 */
export function selectGroups(catalog: PickerCatalog, current: Selection | undefined, known = true): SelectGroup[] {
  const groups: SelectGroup[] = []
  const ready = catalog.connections.filter(offeredConnection)
  for (const connection of ready) {
    const options = offeredModels(catalog.models, connection).map((model) => ({ value: encodeSelection({ backend: "native", model: model.id, connectionId: connection.id }), label: modelName(model) }))
    if (options.length > 0) groups.push({ label: connection.label, options })
  }
  if (current !== undefined && current.backend === "native" && current.model !== undefined && current.connectionId !== undefined) {
    const value = encodeSelection(current)
    if (!groups.some((group) => group.options.some((option) => option.value === value))) {
      const listed = catalog.connections.some((connection) => connection.id === current.connectionId)
      groups.unshift({ label: listed ? connectionLabel(current.connectionId, catalog.connections) : known ? "Removed connection" : "Current", options: [{ value, label: modelLabel(current.model) }] })
    }
  }
  const options: SelectOption[] = []
  const chosen = current === undefined ? undefined : encodeSelection(current)
  // With tool connections a tool is offered once per connection that is on; before them, once.
  const routes: readonly { readonly backend: (typeof TOOL_BACKENDS)[number]; readonly connection?: ToolConnection }[] =
    catalog.tools === undefined ? LEGACY_TOOLS.map((backend) => ({ backend })) : catalog.tools.filter((tool) => tool.enabled).map((tool) => ({ backend: tool.tool, connection: tool }))
  for (const { backend, connection } of routes) {
    const name = connection?.label ?? BACKEND_LABELS[backend]
    const state = toolState(catalog.harnesses, backend)
    const ownLogin = connection === undefined || (connection.authMode === "subscription" && !connection.separateAccount)
    const trouble = state === "missing" ? " (not installed)" : state === "signed-out" && ownLogin ? " (not signed in)" : ""
    // A closed select shows the option alone, so each one names its tool.
    const add = (value: string, label: string): void => {
      // A tool that is not installed cannot be chosen; one that says it is not signed in still can.
      const refused = state === "missing" && value !== chosen
      options.push({ value, label: trouble.length > 0 && value !== chosen ? `${label}${trouble}` : label, ...(refused ? { disabled: true } : {}) })
    }
    const through = connection === undefined ? {} : { connectionId: connection.id }
    if (connection?.models === undefined) add(encodeSelection({ backend, ...through }), name)
    if (!takesModel(backend)) continue
    const listed = toolModels(catalog.harnesses, backend)
    const models = connection?.models === undefined ? (state === "missing" ? [] : listed) : connection.models.map((id) => listed.find((model) => model.id === id) ?? { id })
    for (const model of models) add(encodeSelection({ backend, model: model.id, ...through }), `${toolModelName(backend, model.id, catalog.harnesses)} via ${name}`)
    if (current?.backend === backend && current.connectionId === connection?.id && current.model !== undefined && chosen !== undefined && !options.some((option) => option.value === chosen)) add(chosen, `${current.model} via ${name}`)
  }
  // What a saved form names stays selectable after its tool connection was turned off or removed.
  if (current !== undefined && takesModel(current.backend) && chosen !== undefined && !options.some((option) => option.value === chosen)) {
    const name = catalog.tools?.find((tool) => tool.id === current.connectionId)?.label ?? BACKEND_LABELS[current.backend]
    options.push({ value: chosen, label: current.model === undefined ? name : `${current.model} via ${name}` })
  }
  groups.push({ label: "Coding tools", options })
  return groups
}
