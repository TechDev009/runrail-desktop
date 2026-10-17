import { create } from "zustand"
import { toHostError } from "../host"
import {
  hasCapability,
  MemoryListSchema,
  MemorySchema,
  MemorySettingsSchema,
  MemorySourceListSchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  parseList,
  parseOr,
  type MemoryInfo,
  type MemorySettings,
  type MemorySourceInfo,
  type MemoryStatus,
} from "../protocol/schemas"
import type { TimelineItem } from "../thread/reducer"
import { archiveThread, onSendFailed, onTurnEnded, projectRpc, quietWhen, send, setRecalls } from "./engines"
import { createThread, get, runtimeOf, threadById } from "./store"

/**
 * Memory on the desktop. The engine keeps memories and sources; the desktop adds what
 * recall finds to each message, shows and edits memories, keeps sources fresh until
 * workflows schedule them, and offers to keep facts from a thread once the person asks.
 */

const SYNC_EVERY_MS = 60 * 60_000
const MAX_TRANSCRIPT = 24_000

export type ScopeName = "project" | "person"

interface ProjectMemory {
  readonly state: "loading" | "ready" | "error"
  readonly status?: MemoryStatus
  readonly memories: readonly MemoryInfo[]
  readonly sources: readonly MemorySourceInfo[]
  readonly message?: string
}

export interface Suggestion {
  readonly text: string
  readonly scope: ScopeName
  readonly state: "new" | "kept" | "skipped"
}

export type Suggestions = { readonly state: "running"; readonly helperId: string } | { readonly state: "ready"; readonly items: readonly Suggestion[] } | { readonly state: "error"; readonly message: string }

interface MemoryState {
  readonly byProject: Readonly<Record<string, ProjectMemory>>
  /** By thread: the offer was dismissed, or its suggestions. This session only. */
  readonly suggestions: Readonly<Record<string, Suggestions | "dismissed">>
  /** Sources syncing now, by id. */
  readonly syncing: Readonly<Record<string, boolean>>
}

export const useMemory = create<MemoryState>()(() => ({ byProject: {}, suggestions: {}, syncing: {} }))

function patchProject(projectId: string, patch: Partial<ProjectMemory>): void {
  useMemory.setState((state) => {
    const before = state.byProject[projectId] ?? { state: "loading" as const, memories: [], sources: [] }
    return { byProject: { ...state.byProject, [projectId]: { ...before, ...patch } } }
  })
}

// ---------------------------------------------------------------------------------------------
// Recall

/** Where a memory came from, in words, for the block and the card. */
export function memoryLabel(memory: Pick<MemoryInfo, "scope" | "source">): string {
  const owner = memory.scope === "project" ? "project memory" : memory.scope === "person" ? "your memory" : "memory server"
  const ref = memory.source.ref
  if (memory.source.kind === "folder" && ref !== undefined) return `${owner}, from ${ref}`
  if (memory.source.kind === "github" && ref !== undefined) return `${owner}, from issue ${ref}`
  if (memory.source.kind === "feed") return `${owner}, from a feed`
  return owner
}

/** The person's messages ask the engine to add what they recall, unless recall is off. */
function recalls(threadId: string): boolean {
  const thread = threadById(threadId)
  // A setup's turns are the engine's prompts, not the person's.
  if (thread === undefined || thread.setup !== undefined || helpers.has(threadId) || !get().prefs.memory.recall) return false
  // A thread's first message goes before its engine says what it offers; an engine without memory ignores the ask.
  const contract = runtimeOf(threadId).contract
  return contract === undefined || hasCapability(contract, "memory")
}

setRecalls(recalls)

// ---------------------------------------------------------------------------------------------
// The Memory view

export async function loadMemory(projectId: string, query?: string): Promise<void> {
  patchProject(projectId, { state: "loading" })
  try {
    const [status, listed, sources] = await Promise.all([
      projectRpc(projectId, "memory.status"),
      projectRpc(projectId, "memory.list", { limit: 300, ...(query === undefined || query.trim().length === 0 ? {} : { query: query.trim() }) }),
      projectRpc(projectId, "memory.source.list"),
    ])
    const parsedStatus = parseOr(MemoryStatusSchema, status)
    patchProject(projectId, {
      state: "ready",
      ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
      memories: parseList(MemorySchema, parseOr(MemoryListSchema, listed)?.memories ?? [], 500),
      sources: parseList(MemorySourceSchema, parseOr(MemorySourceListSchema, sources)?.sources ?? [], 50),
      message: undefined,
    })
    watchSources(projectId)
  } catch (error) {
    patchProject(projectId, { state: "error", message: toHostError(error).message })
  }
}

/** A source's own entries, newest first. */
export async function sourceEntries(projectId: string, sourceId: string): Promise<readonly MemoryInfo[]> {
  return parseList(MemorySchema, parseOr(MemoryListSchema, await projectRpc(projectId, "memory.list", { sourceId, limit: 100 }))?.memories ?? [], 100)
}

export async function addMemory(projectId: string, scope: ScopeName, text: string, source: "manual" | "suggested" = "manual"): Promise<void> {
  await projectRpc(projectId, "memory.add", { scope, text, source })
  await loadMemory(projectId)
}

export async function updateMemory(projectId: string, id: string, text: string): Promise<void> {
  await projectRpc(projectId, "memory.update", { id, text })
  await loadMemory(projectId)
}

export async function forgetMemory(projectId: string, id: string): Promise<void> {
  await projectRpc(projectId, "memory.forget", { id })
  await loadMemory(projectId)
}

export async function readSettings(projectId: string): Promise<MemorySettings | undefined> {
  return parseOr(MemorySettingsSchema, await projectRpc(projectId, "memory.settings.get"))
}

export async function saveSettings(projectId: string, provider: "local" | "server-memory" | Record<string, unknown>): Promise<void> {
  await projectRpc(projectId, "memory.settings.set", { provider })
  await loadMemory(projectId)
}

// ---------------------------------------------------------------------------------------------
// Sources

export async function addSource(projectId: string, input: { readonly kind: MemorySourceInfo["kind"]; readonly scope: ScopeName; readonly target: string; readonly name?: string }): Promise<void> {
  const added = parseOr(MemorySourceSchema, await projectRpc(projectId, "memory.source.add", { ...input }))
  if (added !== undefined) await syncSource(projectId, added.id)
  else await loadMemory(projectId)
}

export async function removeSource(projectId: string, id: string): Promise<void> {
  await projectRpc(projectId, "memory.source.remove", { id })
  await loadMemory(projectId)
}

export async function syncSource(projectId: string, id: string): Promise<void> {
  useMemory.setState((state) => ({ syncing: { ...state.syncing, [id]: true } }))
  try {
    await projectRpc(projectId, "memory.source.sync", { id })
  } finally {
    useMemory.setState((state) => ({ syncing: { ...state.syncing, [id]: false } }))
    await loadMemory(projectId)
  }
}

/** A source is synced again once an hour while the app is open, until workflows schedule it. */
export function staleSources(sources: readonly MemorySourceInfo[], now: number): readonly MemorySourceInfo[] {
  return sources.filter((source) => source.lastSync === undefined || now - source.lastSync.at >= SYNC_EVERY_MS)
}

const watched = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

/** Whether a project this app looked at has sources the hourly sync keeps fresh. */
export function syncsSources(): boolean {
  return [...watched].some((id) => (useMemory.getState().byProject[id]?.sources ?? []).length > 0)
}

/** Syncs the stale sources of every watched project, but not one already syncing. */
export function syncStaleSources(now = Date.now()): void {
  for (const id of watched) {
    const { byProject, syncing } = useMemory.getState()
    for (const source of staleSources(byProject[id]?.sources ?? [], now)) {
      if (syncing[source.id] !== true) void syncSource(id, source.id).catch(() => undefined)
    }
  }
}

const MAX_WOKEN_PROJECTS = 20

/**
 * Every project's sources, for a launch the wake service opened: nothing was
 * looked at yet, so the stale sources of each project are found and synced here.
 */
export async function syncAllSources(projectIds: readonly string[]): Promise<void> {
  for (const projectId of projectIds.slice(0, MAX_WOKEN_PROJECTS)) {
    try {
      const listed = await projectRpc(projectId, "memory.source.list")
      patchProject(projectId, { sources: parseList(MemorySourceSchema, parseOr(MemorySourceListSchema, listed)?.sources ?? [], 50) })
      watchSources(projectId)
    } catch {
      // A project whose folder is gone has nothing to sync.
    }
  }
  syncStaleSources()
}

/** Whether a source is syncing now. */
export function syncingSources(): boolean {
  return Object.values(useMemory.getState().syncing).some(Boolean)
}

function watchSources(projectId: string): void {
  watched.add(projectId)
  timer ??= setInterval(() => syncStaleSources(), 5 * 60_000)
}

// ---------------------------------------------------------------------------------------------
// "Remember this?"

/** Threads that ask for suggestions; never offered suggestions or recall themselves. */
const helpers = new Map<string, string>()

quietWhen((threadId) => helpers.has(threadId))

/** A thread may offer to keep facts after two finished turns of the person's own. */
export function offersSuggestions(threadId: string, items: readonly TimelineItem[]): boolean {
  const thread = threadById(threadId)
  if (thread === undefined || thread.setup !== undefined || thread.review !== undefined || helpers.has(threadId) || !get().prefs.memory.suggest) return false
  return items.filter((item) => item.kind === "turn-end" && item.status === "completed").length >= 2
}

export function conversationText(items: readonly TimelineItem[]): string {
  const lines = items.flatMap((item) => (item.kind === "user" ? [`Person: ${item.text}`] : item.kind === "assistant" && item.text.trim().length > 0 ? [`Agent: ${item.text.trim()}`] : []))
  const text = lines.join("\n\n")
  return text.length > MAX_TRANSCRIPT ? text.slice(-MAX_TRANSCRIPT) : text
}

export function suggestPrompt(conversation: string): string {
  return [
    "Read this conversation from a coding thread and suggest up to five facts worth remembering in later threads: decisions, conventions, preferences, commands, where things live.",
    "Leave out anything temporary, anything secret (keys, tokens, passwords), and anything plain from the code itself. Do not use tools.",
    'Mark each fact "project" when it is true of this repository, or "person" when it is about how this person likes to work.',
    'End your final message with exactly one fenced code block tagged json: {"memories": [{"text": "...", "scope": "project"}]}. Use an empty list when nothing is worth keeping.',
    "",
    "<conversation>",
    conversation,
    "</conversation>",
  ].join("\n")
}

export function parseSuggestions(message: string): readonly Suggestion[] | undefined {
  const blocks = [...message.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)]
  const raw = blocks[blocks.length - 1]?.[1]
  if (raw === undefined) return undefined
  try {
    const value = JSON.parse(raw) as { memories?: unknown }
    if (!Array.isArray(value.memories)) return undefined
    return value.memories.slice(0, 5).flatMap((entry: unknown) => {
      const item = entry as { text?: unknown; scope?: unknown }
      if (typeof item.text !== "string" || item.text.trim().length === 0) return []
      return [{ text: item.text.trim().slice(0, 1_000), scope: item.scope === "person" ? ("person" as const) : ("project" as const), state: "new" as const }]
    })
  } catch {
    return undefined
  }
}

function setSuggestions(threadId: string, value: Suggestions | "dismissed"): void {
  useMemory.setState((state) => ({ suggestions: { ...state.suggestions, [threadId]: value } }))
}

export function dismissSuggestions(threadId: string): void {
  setSuggestions(threadId, "dismissed")
}

/** One turn on the project's default model, in a thread of its own that is archived once it answers. */
export function suggestMemories(threadId: string): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const conversation = conversationText(runtimeOf(threadId).timeline.items)
  if (conversation.length === 0) return
  const helper = createThread({ projectId: thread.projectId, mode: "plan", permission: "ask", title: `Memories from ${thread.title}`, select: false })
  helpers.set(helper.id, threadId)
  setSuggestions(threadId, { state: "running", helperId: helper.id })
  send(helper.id, { text: suggestPrompt(conversation) })
}

export function setSuggestion(threadId: string, index: number, patch: Partial<Pick<Suggestion, "scope" | "state">>): void {
  const current = useMemory.getState().suggestions[threadId]
  if (current === undefined || current === "dismissed" || current.state !== "ready") return
  setSuggestions(threadId, { state: "ready", items: current.items.map((item, at) => (at === index ? { ...item, ...patch } : item)) })
}

export async function keepSuggestion(threadId: string, index: number): Promise<void> {
  const thread = threadById(threadId)
  const current = useMemory.getState().suggestions[threadId]
  if (thread === undefined || current === undefined || current === "dismissed" || current.state !== "ready") return
  const item = current.items[index]
  if (item === undefined || item.state !== "new") return
  await addMemory(thread.projectId, item.scope, item.text, "suggested")
  setSuggestion(threadId, index, { state: "kept" })
}

onSendFailed((threadId, reason) => {
  const source = helpers.get(threadId)
  if (source === undefined) return
  setSuggestions(source, { state: "error", message: `The model could not be asked: ${reason}` })
  void archiveThread(threadId, true)
})

onTurnEnded((threadId, turnId) => {
  const source = helpers.get(threadId)
  if (source === undefined) return
  const timeline = runtimeOf(threadId).timeline
  const answer = timeline.items
    .filter((item) => item.kind === "assistant" && item.turnId === turnId)
    .map((item) => (item.kind === "assistant" ? item.text : ""))
    .join("\n\n")
  const parsed = timeline.lastTurnEnd?.status === "completed" ? parseSuggestions(answer) : undefined
  setSuggestions(
    source,
    parsed === undefined ? { state: "error", message: timeline.lastTurnEnd?.status === "completed" ? "The answer had no list of memories." : "The model did not finish." } : { state: "ready", items: parsed },
  )
  void archiveThread(threadId, true)
})
