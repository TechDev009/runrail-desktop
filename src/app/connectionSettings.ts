import { getHost } from "../host"
import { HostError, type SecretTarget } from "../host/types"
import {
  ConnectionEntrySchema,
  ConnectionListingSchema,
  HarnessStatusSchema,
  type ImageModel,
  LoginCommandSchema,
  ToolConnectionStatusSchema,
  ToolLoginReadSchema,
  ToolModelSchema,
  parseList,
  parseOr,
  type LoginCommand,
} from "../protocol/schemas"
import { connectionsChanged, onConnectionsChanged, systemCapability, systemRpc } from "./connections"
import { MODEL_TOOLS, type Prefs } from "./persist"
import { carried, thinkingLevels, type CodingTool, type Selection, type ToolModel } from "./picker"
import { get, setPrefs, startingModel } from "./store"

/**
 * What the engine keeps beside each connection: whether it is on, which models it offers, and the
 * one default. A coding tool is a connection too: it names the login the tool runs as, which is
 * the tool's own, never a token Runrail holds.
 */

export type ToolId = (typeof MODEL_TOOLS)[number]
export type ToolAuthMode = "subscription" | "api-key"

export interface ToolConnection {
  readonly id: string
  readonly tool: ToolId
  readonly label: string
  readonly authMode: ToolAuthMode
  /** Signed in from a config folder of its own, apart from the tool's usual login. */
  readonly separateAccount: boolean
  readonly enabled: boolean
  /** The models it offers, the first being its default. Absent: every model the tool lists. */
  readonly models?: readonly string[]
}

export interface ProviderSettings {
  readonly enabled: boolean
  readonly models?: readonly string[]
}

/** The model new threads start on, kept by the engine. `usable` is false while its connection is off or gone. */
export interface ConnectionDefault {
  readonly connectionId: string
  readonly model: string
  readonly usable: boolean
}

/** The image model agents make pictures with, picked from the person's own connections. */
export interface ImageChoice {
  readonly connectionId: string
  readonly model: string
  readonly route: ImageModel["route"]
  readonly usable: boolean
}

export interface ConnectionSettingsListing {
  readonly providers: ReadonlyMap<string, ProviderSettings>
  readonly tools: readonly ToolConnection[]
  readonly default?: ConnectionDefault
  readonly image?: ImageChoice
}

/** Tools that take a pasted key, and tools that can sign in as a second account, as the engine allows. */
export const KEY_TOOLS: readonly ToolId[] = ["claude-code", "codex", "gemini"]
export const SEPARATE_ACCOUNT_TOOLS: readonly ToolId[] = ["claude-code", "codex"]
/** The only tools whose sign-in the engine names: the rest sign in from their own interface. */
export const LOGIN_TOOLS: readonly ToolId[] = ["claude-code", "codex"]

function isTool(value: string): value is ToolId {
  return (MODEL_TOOLS as readonly string[]).includes(value)
}

/** Whether this engine keeps connection settings; an older one reads as every connection on, every model. */
export function settingsOffered(): Promise<boolean> {
  return systemCapability("connection.settings").catch(() => false)
}

/** Settings for every connection, or `undefined` from an engine without them. */
let lastTools: readonly ToolConnection[] | undefined
/** The image model as last read; `null` once read with none chosen. */
let lastImage: ImageChoice | null | undefined

/** The tool connections as last read, or undefined until read and again after a change. */
export function knownTools(): readonly ToolConnection[] | undefined {
  return lastTools
}

onConnectionsChanged(() => {
  lastTools = undefined
  lastImage = undefined
})

export async function listConnectionSettings(): Promise<ConnectionSettingsListing | undefined> {
  if (!(await settingsOffered())) return undefined
  const parsed = parseOr(ConnectionListingSchema, await systemRpc("connection.list"))
  if (parsed === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  const providers = new Map<string, ProviderSettings>()
  const tools: ToolConnection[] = []
  for (const entry of parseList(ConnectionEntrySchema, parsed.connections, 4_352)) {
    if (entry.kind === "provider") providers.set(entry.connectionId, { enabled: entry.enabled, ...(entry.models === undefined ? {} : { models: entry.models }) })
    // A tool this app cannot start (one added from the command line) is left out rather than offered.
    else if (isTool(entry.tool)) tools.push({ id: entry.connectionId, tool: entry.tool, label: entry.label, authMode: entry.authMode, separateAccount: entry.separateAccount, enabled: entry.enabled, ...(entry.models === undefined ? {} : { models: entry.models }) })
  }
  lastTools = tools
  lastImage = parsed.image ?? null
  return { providers, tools, ...(parsed.default === undefined ? {} : { default: parsed.default }), ...(parsed.image === undefined ? {} : { image: parsed.image }) }
}

export interface ConnectionChanges {
  readonly label?: string
  readonly enabled?: boolean
  /** `null` goes back to every listed model. */
  readonly models?: readonly string[] | null
}

/** Turns a connection on or off, renames it, or changes its models. The engine refuses an empty list. */
export async function updateConnectionSettings(connectionId: string, changes: ConnectionChanges): Promise<void> {
  if (changes.models !== undefined && changes.models !== null && changes.models.length === 0) throw new HostError("CONNECTION_MODELS_EMPTY", "choose at least one model")
  await systemRpc("connection.update", { connectionId, ...changes })
  connectionsChanged()
}

/** Sets the model new threads start on, or clears it. Adding a connection never sets it. */
export async function setConnectionDefault(choice: { readonly connectionId: string; readonly model: string } | undefined): Promise<void> {
  await systemRpc("connection.setDefault", choice === undefined ? { connectionId: null } : { connectionId: choice.connectionId, model: choice.model })
  connectionsChanged()
}

/** Picks the model agents make pictures with, or clears it. The engine checks the connection lists it. */
export async function setImageModel(choice: { readonly connectionId: string; readonly model: string } | undefined): Promise<void> {
  await systemRpc("connection.setImageModel", choice === undefined ? { connectionId: null } : { connectionId: choice.connectionId, model: choice.model })
  connectionsChanged()
}

/**
 * Whether a thread starting now gets the image tool: only once a usable image model is chosen, so
 * a thread without one is never offered a tool that can only refuse.
 */
export async function imageToolsOn(): Promise<boolean> {
  if (lastImage === undefined) await listConnectionSettings().catch(() => undefined)
  return lastImage !== undefined && lastImage !== null && lastImage.usable
}

export interface AddToolInput {
  readonly tool: ToolId
  readonly authMode: ToolAuthMode
  readonly separateAccount?: boolean
  readonly models?: readonly string[]
  readonly label?: string
}

export async function addToolConnection(input: AddToolInput): Promise<ToolConnection> {
  const added = parseOr(ConnectionEntrySchema, await systemRpc("connection.addTool", { tool: input.tool, authMode: input.authMode, ...(input.separateAccount === true ? { separateAccount: true } : {}), ...(input.models === undefined ? {} : { models: input.models }), ...(input.label === undefined ? {} : { label: input.label }) }))
  if (added?.kind !== "tool" || !isTool(added.tool)) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  connectionsChanged()
  return { id: added.connectionId, tool: added.tool, label: added.label, authMode: added.authMode, separateAccount: added.separateAccount, enabled: added.enabled, ...(added.models === undefined ? {} : { models: added.models }) }
}

/** Forgets the connection and deletes Runrail's copy of its key. The tool's own sign-in stays as it is. */
export async function removeToolConnection(connectionId: string): Promise<void> {
  await systemRpc("connection.removeTool", { connectionId })
  const prefs = get().prefs
  if (prefs.defaultToolConnectionId === connectionId) setPrefs({ defaultToolConnectionId: undefined, defaultToolModel: undefined })
  const rest = lastTools?.filter((tool) => tool.id !== connectionId)
  connectionsChanged()
  // Known at once, so a thread that ran as it is flagged before the list is read again.
  lastTools = rest
}

export interface ToolStatus {
  readonly keyStored?: boolean
  readonly installed?: boolean
  readonly version?: string
  readonly signedIn?: boolean
}

/** Asks the tool, with the connection's own folder, whether it is installed and signed in. Never which account. */
export async function toolConnectionStatus(connectionId: string): Promise<ToolStatus> {
  const parsed = parseOr(ToolConnectionStatusSchema, await systemRpc("connection.status", { connectionId }))
  if (parsed === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  const { keyStored, installed, version, signedIn } = parsed
  return { ...(keyStored === undefined ? {} : { keyStored }), ...(installed === undefined ? {} : { installed }), ...(version === undefined ? {} : { version }), ...(signedIn === undefined ? {} : { signedIn }) }
}

/** The tool's own sign-in for this connection's folder. Runrail does not run it: the person does, in a terminal. */
export async function toolLoginCommand(connectionId: string): Promise<LoginCommand> {
  const parsed = parseOr(LoginCommandSchema, await systemRpc("connection.loginCommand", { connectionId }))
  if (parsed === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  return parsed
}

/** Whether the engine can run a tool's own sign-in in a terminal inside the app. */
export function loginTerminalOffered(): Promise<boolean> {
  return systemCapability("connection.login").catch(() => false)
}

/** Starts the tool's own sign-in for this connection; the engine picks the command, never the app. */
export async function startToolLogin(connectionId: string, cols: number, rows: number): Promise<string> {
  const result = (await systemRpc("connection.loginStart", { connectionId, cols, rows })) as { readonly loginId?: unknown } | null
  if (typeof result?.loginId !== "string" || result.loginId.length > 64) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  return result.loginId
}

export interface ToolLoginOutput {
  readonly data: string
  readonly nextSeq: number
  readonly closed: boolean
}

export async function readToolLogin(loginId: string, afterSeq: number): Promise<ToolLoginOutput> {
  const parsed = parseOr(ToolLoginReadSchema, await systemRpc("connection.loginRead", { loginId, afterSeq }))
  if (parsed === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  return { data: parsed.chunks.map((chunk) => chunk.data).join(""), nextSeq: parsed.nextSeq, closed: parsed.closed }
}

/** What the person types: keys, or a code they paste. It goes to the tool and nowhere else. */
export async function writeToolLogin(loginId: string, data: string): Promise<void> {
  await systemRpc("connection.loginWrite", { loginId, data })
}

export async function closeToolLogin(loginId: string): Promise<void> {
  await systemRpc("connection.loginClose", { loginId }).catch(() => undefined)
}

/** A single-quoted shell word. */
function quoted(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** The login as one line a shell runs. Every part was already checked to be a plain word or a path. */
export function loginLine(login: LoginCommand): string {
  const env = Object.entries(login.env).map(([name, value]) => `${name}=${quoted(value)}`)
  return [...env, login.command, ...login.args].join(" ")
}

/** Runs the tool's own sign-out for the connection's folder, or for the usual login when it has none. */
export async function toolSignOut(connectionId: string): Promise<boolean> {
  const result = (await systemRpc("connection.vendorSignOut", { connectionId, confirm: true })) as { readonly signedOut?: unknown } | null
  connectionsChanged()
  return result?.signedOut === true
}

/** Stores a tool connection's key through the host's write-only path. */
export async function storeToolKey(connectionId: string, secret: string): Promise<void> {
  await getHost().connectionSecretSet(connectionId, secret, "tool" satisfies SecretTarget)
  connectionsChanged()
}

export async function storeToolKeyFromClipboard(connectionId: string): Promise<void> {
  await getHost().connectionSecretFromClipboard(connectionId, "tool")
  connectionsChanged()
}

/** The text entries of a list the engine sent, if it sent one. */
function strings(list: readonly unknown[] | undefined): readonly string[] | undefined {
  return list?.filter((item): item is string => typeof item === "string")
}

/** `harness.status` as the menu reads it: field by field, so nothing the engine did not mean for it rides along. */
export function toCodingTools(value: unknown): CodingTool[] {
  return parseList(HarnessStatusSchema, value).map((status): CodingTool => {
    const models = (status.models ?? []).flatMap((model): ToolModel[] => {
      const parsed = ToolModelSchema.safeParse(model)
      if (!parsed.success) return []
      const efforts = thinkingLevels(strings(parsed.data.efforts), false)
      const { id, name, reasoning, resolved } = parsed.data
      return [{ id, ...(name === undefined ? {} : { name }), ...(efforts.length === 0 ? {} : { efforts }), ...(reasoning === undefined ? {} : { reasoning }), ...(resolved === undefined ? {} : { resolved }), ...(parsed.data.default === true ? { default: true } : {}), ...(parsed.data.catalog === true ? { catalog: true } : {}) }]
    })
    const { id, name, kind, firstParty } = status.descriptor
    const efforts = thinkingLevels(strings(status.efforts), false)
    return {
      id,
      ...(name === undefined ? {} : { name }),
      ...(kind === undefined ? {} : { kind }),
      ...(firstParty === undefined ? {} : { firstParty }),
      available: status.available,
      ...(status.version === undefined ? {} : { version: status.version }),
      ...(status.signedIn === undefined ? {} : { signedIn: status.signedIn }),
      ...(status.models === undefined ? {} : { models }),
      ...(status.freeTextModel === undefined ? {} : { freeTextModel: status.freeTextModel }),
      ...(efforts.length === 0 ? {} : { efforts }),
      ...(status.proxy === undefined ? {} : { proxy: { address: status.proxy.address, ...(status.proxy.name === undefined ? {} : { name: status.proxy.name }) } }),
    }
  })
}

let detected: Promise<CodingTool[]> | undefined

/**
 * The coding tools installed on this computer, asked by the system engine, so the providers page
 * can suggest them with no project open. Empty from an engine that does not answer it.
 */
export function detectTools(refresh = false): Promise<CodingTool[]> {
  if (detected !== undefined && !refresh) return detected
  const promise = systemRpc("harness.status", refresh ? { refresh: true } : {}).then(toCodingTools, () => [])
  detected = promise
  return promise
}

let writing = 0

/** Called after a tool's account is ready. Reuse it for new threads when no start has been chosen. */
export function adoptFirstToolDefault(connection: ToolConnection): void {
  const prefs = get().prefs
  if (!connection.enabled || prefs.defaultBackend !== "native" || startingModel(prefs) !== undefined) return
  setStartDefault({ backend: connection.tool, connectionId: connection.id, ...(connection.models?.[0] === undefined ? {} : { model: connection.models[0] }) })
}

/** What the engine's default is in the app's own preferences, which new threads read at once. */
function defaultPrefs(choice: { readonly connectionId: string; readonly model: string }, tools: readonly ToolConnection[]): Partial<Prefs> {
  const tool = tools.find((item) => item.id === choice.connectionId)
  return tool === undefined ? { defaultBackend: "native", defaultModel: choice.model, defaultConnectionId: choice.connectionId } : { defaultBackend: tool.tool, defaultToolModel: choice.model, defaultToolConnectionId: tool.id }
}

/** The engine keeps the default, so the app follows it. */
export function adoptEngineDefault(listing: ConnectionSettingsListing): void {
  // A list read while this app's own change is on its way would undo it.
  if (writing > 0 || listing.default === undefined || !listing.default.usable) return
  const prefs = get().prefs
  const next = defaultPrefs(listing.default, listing.tools)
  if (Object.entries(next).some(([key, value]) => prefs[key as keyof Prefs] !== value)) setPrefs(next)
}

/**
 * Makes `selection` what new threads start on, here and in the engine. The engine holds a model on
 * a connection only, so anything else (a tool on its own login, or no model) clears its default.
 */
export function setStartDefault(selection: Selection): void {
  if (selection.backend === "replay") return
  const kept = carried(selection)
  setPrefs({ defaultBackend: selection.backend, ...(selection.backend === "native" ? { defaultModel: kept.model, defaultConnectionId: kept.connectionId } : { defaultToolModel: kept.model, defaultToolConnectionId: kept.connectionId }) })
  const choice = kept.model === undefined || kept.connectionId === undefined ? undefined : { connectionId: kept.connectionId, model: kept.model }
  // Not a change to the list of connections, so nothing is read again.
  writing += 1
  void settingsOffered()
    .then((offered) => (offered ? systemRpc("connection.setDefault", choice === undefined ? { connectionId: null } : choice) : undefined))
    .catch(() => undefined)
    .finally(() => {
      writing -= 1
    })
}
