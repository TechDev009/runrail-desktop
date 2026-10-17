import { getHost, SYSTEM_ENGINE_ID, toHostError } from "../host"
import {
  ContractSchema,
  ConnectionModelSchema,
  ConnectionModelsSchema,
  ConnectionPresetSchema,
  ConnectionPresetsSchema,
  ConnectionSchema,
  ConnectionTestSchema,
  CustomPresetSchema,
  DetectedConnectionSchema,
  DetectedConnectionsSchema,
  ImportableConnectionSchema,
  ImportableConnectionsSchema,
  ImageModelSchema,
  SignInFlowSchema,
  hasCapability,
  parseList,
  parseOr,
  type ImportableConnection,
  type ConnectionModel,
  type ConnectionPreset,
  type ConnectionRecord,
  type CustomPreset,
  type ImageModel,
  type DetectedConnection,
  type SignInFlow,
} from "../protocol/schemas"
import { HostError, type EngineInfo } from "../host/types"
import { get, setPrefs } from "./store"

/**
 * Connections: the keys, shell variables, and subscription sign-ins a model is reached through.
 * They belong to the app, not to a project, so they are read from the system engine. The
 * renderer only ever sees ids, labels, and states; keys take the host's write-only path.
 */

export interface Connection {
  readonly id: string
  readonly label: string
  /** The vendor or endpoint kind the connection talks to. */
  readonly presetId: string
  readonly authMode: string
  readonly status: ConnectionRecord["status"]
  readonly statusCode?: string
  /** Name of the shell variable, when the key is read from the login shell. */
  readonly environmentName?: string
  /** Set for connections to a custom address. */
  readonly baseUrl?: string
  /** False when it is turned off: a thread cannot pick it. Absent on an engine without the setting. */
  readonly enabled?: boolean
  /** The models it offers, the first being its default. Absent: every model it lists. */
  readonly models?: readonly string[]
}

export interface ConnectionModels {
  readonly models: readonly ConnectionModel[]
  /** The image generators the same list names. */
  readonly images: readonly ImageModel[]
  /** Why the endpoint's own list could not be read; absent when it answered. */
  readonly code?: string
}

let system: Promise<EngineInfo> | undefined
let watching = false

/** The system engine, started on first use and again after it exits. */
async function systemEngine(): Promise<EngineInfo> {
  const host = getHost()
  if (!watching) {
    watching = true
    host.onEngineExit((engineId) => {
      if (engineId === SYSTEM_ENGINE_ID) system = undefined
    })
  }
  const started = (system ??= host.systemEngine())
  try {
    return await started
  } catch (error) {
    if (system === started) system = undefined
    throw error
  }
}

/** Calls the system engine, starting it on first use and again after it exits. */
export async function systemRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  await systemEngine()
  return getHost().rpc(SYSTEM_ENGINE_ID, method, params)
}

/** Whether the system engine offers a capability; an engine from before it is not asked. */
export async function systemCapability(name: string): Promise<boolean> {
  return hasCapability(parseOr(ContractSchema, (await systemEngine()).contract), name)
}

export function toConnection(record: ConnectionRecord): Connection {
  const { reference } = record
  return {
    id: reference.accountId,
    label: reference.label.length > 0 ? reference.label : reference.accountId,
    presetId: reference.preset ?? reference.provider,
    authMode: reference.authMode,
    status: record.status,
    ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
    ...(reference.environmentName === undefined ? {} : { environmentName: reference.environmentName }),
    ...(reference.baseUrl === undefined ? {} : { baseUrl: reference.baseUrl }),
  }
}

let lastListed: readonly Connection[] | undefined

/** Every stored connection except removed ones, in the engine's order. */
export async function listConnections(): Promise<Connection[]> {
  const listed = parseList(ConnectionSchema, await systemRpc("account.list"), 512)
    .filter((record) => record.status !== "revoked")
    .map(toConnection)
  lastListed = listed
  return listed
}

/**
 * The list as it was last read, without asking the engine again. Undefined until it was read, and
 * again after a change until the next read: a caller that needs certainty asks `listConnections`.
 */
export function knownConnections(): readonly Connection[] | undefined {
  return lastListed
}

/**
 * Models one connection can run. The engine asks the connection's own endpoint with the stored
 * key and falls back to its bundled list, so a failed request can still return models.
 */
export async function connectionModels(connectionId: string): Promise<ConnectionModels> {
  try {
    const parsed = parseOr(ConnectionModelsSchema, await systemRpc("connection.models", { connectionId }))
    if (parsed === undefined) return { models: [], images: [], code: "INVALID_RESPONSE" }
    // Some endpoints have no list at all; that is not a failure.
    const failed = !parsed.live.ok && parsed.live.code !== "NO_MODEL_LIST"
    return { models: parseList(ConnectionModelSchema, parsed.models, 2_000), images: parseList(ImageModelSchema, parsed.images ?? [], 500), ...(failed ? { code: parsed.live.code } : {}) }
  } catch (error) {
    return { models: [], images: [], code: toHostError(error).code }
  }
}

// ---------------------------------------------------------------------------------------------
// Adding, changing, and removing connections

export interface PresetCatalog {
  readonly presets: readonly ConnectionPreset[]
  /** Request formats a custom address can speak. */
  readonly custom: readonly CustomPreset[]
}

export interface ConnectionCheck {
  readonly status: "ok" | "unverified" | "failed"
  readonly code: string
  readonly modelCount?: number
}

const MAX_KEY_BYTES = 16 * 1024
const MAX_LABEL = 160

const listeners = new Set<() => void>()

/** Runs `listener` after a connection was added, changed, or removed from this window. */
export function onConnectionsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function connectionsChanged(): void {
  lastListed = undefined
  for (const listener of [...listeners]) listener()
}

function record(value: unknown): Connection {
  const parsed = parseOr(ConnectionSchema, value)
  if (parsed === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  return toConnection(parsed)
}

/** Providers a key can be added for, and the formats a custom address can speak. */
export async function connectionPresets(): Promise<PresetCatalog> {
  const parsed = parseOr(ConnectionPresetsSchema, await systemRpc("connection.presets"))
  if (parsed === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  return { presets: parseList(ConnectionPresetSchema, parsed.presets, 512), custom: parseList(CustomPresetSchema, parsed.custom, 32) }
}

/** Provider keys already set in the login shell and not yet used by a connection. Names only. */
export async function detectShellConnections(): Promise<DetectedConnection[]> {
  const parsed = parseOr(DetectedConnectionsSchema, await systemRpc("connection.detect"))
  return parsed === undefined ? [] : parseList(DetectedConnectionSchema, parsed.detected, 512)
}

/** Providers Codex, Pi, or opencode are set up with, offered to add here. No key is ever read. */
export async function importableConnections(): Promise<ImportableConnection[]> {
  const parsed = parseOr(ImportableConnectionsSchema, await systemRpc("connection.importable"))
  return parsed === undefined ? [] : parseList(ImportableConnectionSchema, parsed.candidates, 64)
}

/** Subscription sign-ins this engine can run. */
export async function signInFlows(): Promise<SignInFlow[]> {
  return parseList(SignInFlowSchema, await systemRpc("auth.flows"), 64)
}

/** Why a typed key cannot be stored, or `undefined`. The same limits the host enforces. */
export function keyProblem(value: string): "empty" | "lines" | "long" | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return "empty"
  if (/[\r\n]/.test(trimmed)) return "lines"
  if (new TextEncoder().encode(trimmed).length > MAX_KEY_BYTES) return "long"
  return undefined
}

/** Why a custom address cannot be used, or `undefined`. The engine checks again. */
export function addressProblem(value: string): "empty" | "invalid" | "scheme" | "credentials" | "plain" | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return "empty"
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return "invalid"
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme"
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) return "credentials"
  const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname) || /^10\./.test(url.hostname) || /^192\.168\./.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || url.hostname.endsWith(".local")
  if (url.protocol === "http:" && !local) return "plain"
  return undefined
}

/** First id of the form `base`, `base-2`, `base-3`... that no stored record uses, removed ones included. */
export function freeConnectionId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  throw new HostError("CONNECTION_LIMIT", "too many connections of this kind")
}

async function takenIds(): Promise<Set<string>> {
  return new Set(parseList(ConnectionSchema, await systemRpc("account.list"), 512).map((entry) => entry.reference.accountId))
}

/** Id and label for one more account of a sign-in that already has one. */
export async function nextSignInAccount(flow: Pick<SignInFlow, "id" | "label">): Promise<{ readonly accountId: string; readonly label: string }> {
  const base = `signin-${flow.id}`
  const accountId = freeConnectionId(base, await takenIds())
  const suffix = accountId.slice(base.length + 1)
  return { accountId, label: suffix.length === 0 ? flow.label : `${flow.label} ${suffix}` }
}

function cleanLabel(label: string, fallback: string): string {
  const trimmed = label.trim().slice(0, MAX_LABEL)
  return trimmed.length > 0 ? trimmed : fallback
}

export interface KeyConnectionInput {
  /** A provider preset, or one of the custom formats together with `baseUrl`. */
  readonly presetId: string
  readonly label: string
  readonly baseUrl?: string
}

/** Creates a connection that takes a pasted key. It stays off until the key is stored. */
export async function createKeyConnection(input: KeyConnectionInput): Promise<Connection> {
  const id = freeConnectionId(input.baseUrl === undefined ? input.presetId : "custom", await takenIds())
  const created = record(
    await systemRpc("account.create", {
      accountId: id,
      provider: input.presetId,
      preset: input.presetId,
      label: cleanLabel(input.label, id),
      authMode: "api-key",
      scopes: [],
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl.trim() }),
    }),
  )
  connectionsChanged()
  return created
}

/** Stores a key through the host's write-only path. Nothing reads it back. */
export async function storeKey(connectionId: string, secret: string): Promise<Connection> {
  const stored = record(await getHost().connectionSecretSet(connectionId, secret))
  connectionsChanged()
  return stored
}

/** Same, but the host reads the clipboard itself, so the key never enters this window. */
export async function storeKeyFromClipboard(connectionId: string): Promise<Connection> {
  const stored = record(await getHost().connectionSecretFromClipboard(connectionId))
  connectionsChanged()
  return stored
}

/**
 * Creates a key connection and stores its key in one step. If the key cannot be stored the new
 * connection is removed again, so a failed attempt leaves nothing behind.
 */
export async function addKeyConnection(input: KeyConnectionInput, store: (connectionId: string) => Promise<Connection>): Promise<Connection> {
  const created = await createKeyConnection(input)
  try {
    return await store(created.id)
  } catch (error) {
    await systemRpc("account.remove", { accountId: created.id }).catch(() => undefined)
    connectionsChanged()
    throw error
  }
}

/** Uses a key the login shell already exports. The engine reads the variable; this window never does. */
export async function createShellConnection(detected: DetectedConnection): Promise<Connection> {
  const id = freeConnectionId(`env-${detected.presetId}`, await takenIds())
  const created = record(
    await systemRpc("account.create", {
      accountId: id,
      provider: detected.presetId,
      preset: detected.presetId,
      label: detected.name,
      authMode: "environment",
      scopes: [],
      environmentName: detected.environmentName,
      status: "ready",
    }),
  )
  connectionsChanged()
  return created
}

/** Changes only the label: the address and the way in stay as they are. */
export async function renameConnection(connectionId: string, label: string): Promise<Connection> {
  const trimmed = label.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL) throw new HostError("CONNECTION_LABEL_INVALID", "a name is 1 to 160 characters")
  const current = parseOr(ConnectionSchema, await systemRpc("account.get", { accountId: connectionId }))
  if (current === undefined) throw new HostError("INVALID_RESPONSE", "the engine's answer could not be read")
  const { reference } = current
  const renamed = record(
    await systemRpc("account.upsert", {
      accountId: reference.accountId,
      provider: reference.provider,
      label: trimmed,
      authMode: reference.authMode,
      ...(Array.isArray(reference.scopes) ? { scopes: reference.scopes } : {}),
      ...(reference.preset === undefined ? {} : { preset: reference.preset }),
      ...(reference.environmentName === undefined ? {} : { environmentName: reference.environmentName }),
      ...(reference.baseUrl === undefined ? {} : { baseUrl: reference.baseUrl }),
      ...(typeof reference.headers === "object" && reference.headers !== null ? { headers: reference.headers } : {}),
      // A shell connection's state is the caller's to keep; stored ones are owned by the vault.
      ...(reference.authMode === "environment" ? { status: current.status } : {}),
    }),
  )
  connectionsChanged()
  return renamed
}

/** Removes the connection and the key or sign-in stored for it. */
export async function removeConnection(connectionId: string): Promise<void> {
  await systemRpc("account.remove", { accountId: connectionId })
  const prefs = get().prefs
  const recentModels = prefs.recentModels.filter((recent) => recent.connectionId !== connectionId)
  setPrefs({ recentModels, ...(prefs.defaultConnectionId === connectionId ? { defaultModel: undefined, defaultConnectionId: undefined } : {}) })
  const rest = lastListed?.filter((connection) => connection.id !== connectionId)
  connectionsChanged()
  // Known at once, so a thread that used it is flagged before the list is read again.
  lastListed = rest
}

/** Drops the stored key or sign-in but keeps the connection, so it can be set up again. */
export async function signOutConnection(connectionId: string): Promise<Connection> {
  const result = record(await systemRpc("auth.logout", { accountId: connectionId }))
  connectionsChanged()
  return result
}

/** One live check. A failure is an answer, not an exception. */
export async function testConnection(connectionId: string): Promise<ConnectionCheck> {
  try {
    const parsed = parseOr(ConnectionTestSchema, await systemRpc("connection.test", { connectionId }))
    if (parsed === undefined) return { status: "failed", code: "INVALID_RESPONSE" }
    return { status: parsed.status, code: parsed.code, ...(parsed.modelCount === undefined ? {} : { modelCount: parsed.modelCount }) }
  } catch (error) {
    return { status: "failed", code: toHostError(error).code }
  }
}
