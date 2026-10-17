import { useCallback, useEffect, useState } from "react"
import { toHostError } from "../host"
import {
  AgentInfoSchema,
  HarnessSchema,
  SkillSchema,
  WorkspaceListSchema,
  parseList,
  parseOr,
  type AgentInfo,
  type Skill,
  type WorkspaceEntry,
} from "../protocol/schemas"
import { connectionModels, listConnections, onConnectionsChanged, type Connection } from "./connections"
import { adoptEngineDefault, listConnectionSettings, toCodingTools, type ConnectionDefault, type ImageChoice, type ToolConnection } from "./connectionSettings"
import { projectCapability, projectRpc, threadRpc } from "./engines"
import type { CatalogModel } from "./modelText"
import type { CodingTool } from "./picker"

/**
 * Catalog: connections and their models (app-wide, from the system engine) plus the project's
 * coding tools, skills, and agents, and a per-workspace file index. Fetched on demand and cached in
 * memory for the app session.
 */

export { connectionLabel, modelKey, modelLabel, modelName, type CatalogModel } from "./modelText"

interface ConnectionCatalog {
  readonly connections: readonly Connection[]
  readonly models: readonly CatalogModel[]
  /** Connections whose model list could not be read, by stable error code. */
  readonly modelErrors: Readonly<Record<string, string>>
  /** Why connections could not be read at all (the engine did not start or did not answer). */
  readonly connectionsError?: string
  /** Coding-tool connections. Absent from an engine without connection settings. */
  readonly tools?: readonly ToolConnection[]
  /** The model new threads start on, as the engine keeps it. */
  readonly defaultChoice?: ConnectionDefault
  /** Image generators the ready connections list, and the one agents use. */
  readonly imageModels: readonly CatalogImageModel[]
  readonly imageChoice?: ImageChoice
}

export interface CatalogImageModel {
  readonly connectionId: string
  readonly id: string
  readonly name?: string
}

export interface Catalog extends ConnectionCatalog {
  readonly harnesses: readonly CodingTool[]
  readonly skills: readonly Skill[]
  readonly agents: readonly AgentInfo[]
}

const NO_CONNECTIONS: ConnectionCatalog = { connections: [], models: [], modelErrors: {}, imageModels: [] }
const EMPTY: Catalog = { ...NO_CONNECTIONS, harnesses: [], skills: [], agents: [] }
/** Listed by vendors next to their chat models, but not usable as one. */
export const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcri|audio|realtime|image|sora|babbage|davinci/i
const catalogs = new Map<string, Promise<Catalog>>()
const resolved = new Map<string, Catalog>()
let connectionCatalog: Promise<ConnectionCatalog> | undefined

async function list<T>(projectId: string, method: string, parse: (value: unknown) => T[]): Promise<T[]> {
  try {
    return parse(await projectRpc(projectId, method))
  } catch {
    return []
  }
}

/**
 * Models come from each connection that is ready to use. The engine asks the connection's own
 * endpoint with the stored key; the renderer sees only ids.
 */
async function readConnections(): Promise<ConnectionCatalog> {
  // Without settings (an older engine, or one that failed to read them) every connection is on.
  const [listed, settings] = await Promise.all([listConnections(), listConnectionSettings().catch(() => undefined)])
  const connections = settings === undefined ? listed : listed.map((connection) => {
    const own = settings.providers.get(connection.id)
    return own === undefined ? connection : { ...connection, enabled: own.enabled, ...(own.models === undefined ? {} : { models: own.models }) }
  })
  if (settings !== undefined) adoptEngineDefault(settings)
  const modelErrors: Record<string, string> = {}
  const imageModels: CatalogImageModel[] = []
  const lists = await Promise.all(
    connections
      // A connection that is off is not offered, so its list is read only when it is edited.
      .filter((connection) => connection.status === "ready" && connection.enabled !== false)
      .map(async (connection) => {
        const listed = await connectionModels(connection.id)
        if (listed.code !== undefined) modelErrors[connection.id] = listed.code
        for (const image of listed.images) imageModels.push({ connectionId: connection.id, id: image.id, ...(image.name === undefined ? {} : { name: image.name }) })
        return listed.models.filter((model) => !NOT_CHAT.test(model.id)).map((model) => ({ ...model, connectionId: connection.id }))
      }),
  )
  return {
    connections,
    models: lists.flat(),
    modelErrors,
    imageModels,
    ...(settings === undefined ? {} : { tools: settings.tools, ...(settings.default === undefined ? {} : { defaultChoice: settings.default }), ...(settings.image === undefined ? {} : { imageChoice: settings.image }) }),
  }
}

function loadConnections(force: boolean): Promise<ConnectionCatalog> {
  if (connectionCatalog !== undefined && !force) return connectionCatalog
  // The system engine may be unavailable (an older engine build); the rest of the catalog still loads.
  const promise = readConnections().catch((error: unknown) => {
    if (connectionCatalog === promise) connectionCatalog = undefined
    // Dropped with it, so the next reader asks again instead of reusing the failure.
    queueMicrotask(() => catalogs.clear())
    return { ...NO_CONNECTIONS, connectionsError: toHostError(error).code }
  })
  connectionCatalog = promise
  return promise
}

const watchers = new Set<() => void>()

/**
 * Whether each coding tool is installed and signed in, and which models it offers. The engine
 * learns this by running the tools' own commands, which takes seconds, so the catalog never waits
 * for it: the tools are listed at once and this fills in when it arrives.
 */
const toolStatus = new Map<string, readonly CodingTool[]>()
const toolProbes = new Set<string>()

function probeTools(projectId: string, refresh: boolean): void {
  if (toolProbes.has(projectId)) return
  toolProbes.add(projectId)
  // An engine from before this question is not asked it, and the plain list stays.
  void projectCapability(projectId, "harness.status")
    .then((offered) => (offered ? projectRpc(projectId, "harness.status", refresh ? { refresh: true } : {}) : undefined))
    .then((value) => {
      const tools = toCodingTools(value)
      if (tools.length === 0) return
      toolStatus.set(projectId, tools)
      catalogs.delete(projectId)
      for (const watcher of [...watchers]) watcher()
    })
    .catch(() => undefined)
    .finally(() => toolProbes.delete(projectId))
}

function loadTools(projectId: string, force: boolean): Promise<readonly CodingTool[]> {
  const known = toolStatus.get(projectId)
  if (known === undefined || force) probeTools(projectId, force)
  return known === undefined ? list(projectId, "harness.list", (value) => parseList(HarnessSchema, value)) : Promise.resolve(known)
}

/** Drops the cached connections and models, after one was added, changed, or removed. */
export function invalidateConnections(): void {
  connectionCatalog = undefined
  catalogs.clear()
  for (const watcher of [...watchers]) watcher()
}

onConnectionsChanged(invalidateConnections)

/** Connections do not belong to a project, so they load with none open; the rest needs one. */
const NO_PROJECT = ""

export function loadCatalog(projectId: string | undefined, force = false): Promise<Catalog> {
  const key = projectId ?? NO_PROJECT
  const cached = catalogs.get(key)
  if (cached !== undefined && !force) return cached
  const promise = Promise.all([
    loadConnections(force),
    projectId === undefined ? [] : loadTools(projectId, force),
    projectId === undefined ? [] : list(projectId, "skills.list", (value) => parseList(SkillSchema, value)),
    // Subagents are optional in the engine; asking an engine without them is an error, not an empty list.
    projectId === undefined
      ? []
      : projectCapability(projectId, "agents").then(
          (available) => (available ? list(projectId, "agent.list", (value) => parseList(AgentInfoSchema, value)) : []),
          () => [],
        ),
  ]).then(([connections, harnesses, skills, agents]) => {
    const catalog = { ...connections, harnesses, skills, agents }
    resolved.set(key, catalog)
    return catalog
  })
  catalogs.set(key, promise)
  promise.catch(() => catalogs.delete(key))
  return promise
}

export function invalidateCatalog(projectId: string): void {
  catalogs.delete(projectId)
}

export function useCatalog(projectId: string | undefined): Catalog & { readonly loading: boolean; readonly reload: () => void } {
  const key = projectId ?? NO_PROJECT
  const [catalog, setCatalog] = useState<Catalog>(() => resolved.get(key) ?? EMPTY)
  const [loading, setLoading] = useState(!resolved.has(key))
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true
    let latest = 0
    const load = (force: boolean, quiet: boolean): void => {
      const turn = (latest += 1)
      // A change elsewhere refreshes in place: what is on screen stays until the new list arrives.
      if (!quiet) setLoading(true)
      void loadCatalog(projectId, force)
        .then((value) => {
          if (live && turn === latest) setCatalog(value)
        })
        .finally(() => {
          if (live && turn === latest) setLoading(false)
        })
    }
    load(nonce > 0, resolved.has(key) && nonce === 0)
    const watcher = (): void => load(false, true)
    watchers.add(watcher)
    return () => {
      live = false
      watchers.delete(watcher)
    }
  }, [projectId, key, nonce])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { ...catalog, loading, reload }
}

// ---------------------------------------------------------------------------------------------
// Workspace file index (for @mentions, quick open, and the file tree)

interface FileIndex {
  readonly entries: readonly WorkspaceEntry[]
  readonly truncated: boolean
  readonly at: number
}

const FILE_TTL = 30_000

/**
 * Whether a workspace path belongs in Files and file mentions: not git's own data, and not the
 * project's `.runrail` folder, which holds the engine's state, plugins, and saved attachments.
 */
export function shownFile(path: string): boolean {
  const parts = path.split("/")
  return parts[0] !== ".runrail" && !parts.includes(".git")
}
const indexes = new Map<string, Promise<FileIndex>>()

function indexKey(threadId: string | undefined, projectId: string, folder: string | undefined): string {
  return threadId === undefined ? `p:${projectId}` : folder === undefined ? `t:${threadId}` : `t:${threadId}\n${folder}`
}

/** A thread's files, or those of one of the project's related folders. */
export function loadFiles(threadId: string | undefined, projectId: string, force = false, folder?: string): Promise<FileIndex> {
  const key = indexKey(threadId, projectId, folder)
  const cached = indexes.get(key)
  if (cached !== undefined && !force) return cached
  const params = { maxDepth: 8, maxEntries: 2_048, ...(folder === undefined ? {} : { folder }) }
  const promise = (threadId === undefined ? projectRpc(projectId, "workspace.list", params) : threadRpc(threadId, "workspace.list", params)).then((value) => {
    const parsed = parseOr(WorkspaceListSchema, value)
    const entries = (parsed?.entries ?? []).filter((entry) => shownFile(entry.path))
    return { entries, truncated: parsed?.truncated === true || entries.length >= 2_048, at: Date.now() }
  })
  indexes.set(key, promise)
  promise
    .then(() => setTimeout(() => indexes.get(key) === promise && indexes.delete(key), FILE_TTL))
    .catch(() => indexes.delete(key))
  return promise
}

export function useFiles(threadId: string | undefined, projectId: string | undefined, enabled = true, folder?: string): { readonly entries: readonly WorkspaceEntry[]; readonly truncated: boolean; readonly loading: boolean; readonly error?: string; readonly reload: () => void } {
  const [state, setState] = useState<{ entries: readonly WorkspaceEntry[]; truncated: boolean; loading: boolean; error?: string }>({ entries: [], truncated: false, loading: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled || projectId === undefined) return
    let live = true
    setState((current) => ({ ...current, loading: true }))
    loadFiles(threadId, projectId, nonce > 0, folder)
      .then((index) => {
        if (live) setState({ entries: index.entries, truncated: index.truncated, loading: false })
      })
      .catch((error: unknown) => {
        if (live) setState({ entries: [], truncated: false, loading: false, error: toHostError(error).message })
      })
    return () => {
      live = false
    }
  }, [threadId, projectId, enabled, nonce, folder])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { ...state, reload }
}
