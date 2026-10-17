import { getHost, HostError, toHostError, type Unsubscribe } from "../host"
import { forgetActivity, noteActivity } from "./activity"
import { backgroundOf, noteBackgroundFrames, runningCount, useBackground } from "./background"
import { noteBrowserFrames, takesBrowser } from "./browserAgent"
import { noteSent, noteThreadFrames } from "./threadAgent"
import { noteComputerFrames, takesComputer } from "./computerAgent"
import { AgentEventSchema, ContractSchema, ControlStateSchema, ConversationSchema, LiveCursorSchema, LiveFrameSchema, GitDiffSchema, GitRemoteListSchema, GitStatusSchema, hasCapability, parseOr, type Contract, type Conversation } from "../protocol/schemas"
import { connectedTo } from "./gitHosts"
import { splitUpstream } from "./threadBar"
import {
  addPendingUser,
  appendNotice,
  applyFrames,
  beginEpoch,
  isBusy,
  loadHistory,
  markEngineExited,
  markUser,
  pendingApprovals,
  removeItem,
  type Timeline,
  type TurnRun,
} from "../thread/reducer"
import { behaviorFor, newId, titleFromPrompt, withInstructions, withShell, type PermissionPreset, type ThreadMeta, type ThreadMode, type ThreadStatus } from "./persist"
import { askedAt, noteAnswered, noteRescue, noteTimeline, noteTurnEnd } from "./play"
import {
  get,
  noteProjectGit,
  openThread,
  patchGit,
  patchRuntime,
  patchThread,
  projectById,
  rememberThreadRun,
  removeProject,
  runtimeOf,
  set,
  setPrefs,
  setProjectSkill,
  threadById,
  threadOnScreen,
  toast,
  type Attachment,
  type QueuedPrompt,
  type ThreadRuntime,
} from "./store"
import type { EngineInfo, EngineStartInput, StreamFrame, Thinking } from "../host/types"
import { knownConnections, listConnections, systemCapability, systemRpc, type Connection } from "./connections"
import { imageToolsOn, knownTools } from "./connectionSettings"
import { bump, noteOpen, recordError, stepClock } from "./diagnostics"
import { forgetThread, notify } from "./inbox"
import { carried, problemHint, selectionProblem, type Selection } from "./picker"
import { rememberRefusal } from "./refusals"
import { notePlanReading, planFrames, type PlanFrame } from "./limits"
import { planLimitsOn, readAccountUsage } from "./planUsage"
import { HELD_FOR_LIMIT, mayHoldForLimit, planLimitRefusal, threadAccount } from "./limitCheck"
import { CLAUDE_SDK_CODE, CLAUDE_SDK_NOTICE, claudeSdkRefusal, installClaudeSdk, mayAskForSdk } from "./claudeSdk"
import { forgetContext, rememberContext } from "./threadContext"
import { effectivePermission, withAccess, type Access } from "./access"
import { announce } from "./notifications"
import { readAnswer, speak, useVoice } from "./voice"
import { threadIntegrations } from "./integrations"
import { runLabel } from "./modelText"
import { nifraOn, NifraUseSchema } from "./nifra"

/**
 * Engine controller. One engine process per open thread (session id = thread id), started on
 * demand and evicted least-recently-used. The controller owns the stream cursor, the desktop
 * prompt queue, and the goal loop; everything it keeps is in memory.
 */

const MAX_LIVE_ENGINES = 12
const HISTORY_ITEMS = 2_048
export const HISTORY_UNAVAILABLE = "history.unavailable"
const GOAL_ITERATIONS = 6
const GOAL_DONE = /^\s*GOAL COMPLETE\s*$/m

const owners = new Map<string, string>()
const starting = new Map<string, Promise<string>>()
const services = new Map<string, Promise<string>>()
const serviceContracts = new Map<string, Contract>()
/** Selection captured when each engine process was launched; settings can change while a turn drains. */
const engineRuns = new Map<string, TurnRun>()
const lastUsed = new Map<string, number>()
let subscriptions: Unsubscribe[] = []

function runForThread(thread: Pick<ThreadMeta, "backend" | "model" | "connectionId">): TurnRun {
  return {
    backend: thread.backend,
    ...(thread.model === undefined ? {} : { model: thread.model }),
    ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }),
  }
}

function noteModelSwitch(threadId: string, from: TurnRun, to: TurnRun): void {
  if (from.backend === to.backend && from.model === to.model && from.connectionId === to.connectionId) return
  patchRuntime(threadId, (current) => ({
    timeline: appendNotice(current.timeline, {
      code: "model.changed",
      message: `Switched from ${runLabel(from)} to ${runLabel(to)}.`,
    }),
  }))
}

function rememberTurnStarts(threadId: string, thread: ThreadMeta, frames: readonly StreamFrame[], run: TurnRun): void {
  for (const frame of frames) {
    if (frame.kind !== "event") continue
    const event = AgentEventSchema.safeParse(frame.data)
    if (!event.success || event.data.type !== "turn.started") continue
    rememberThreadRun(threadId, {
      turnId: event.data.turnId,
      backend: thread.backend,
      ...(event.data.model === undefined ? (run.model === undefined ? {} : { model: run.model }) : { model: event.data.model }),
      ...(event.data.connectionId === undefined ? (run.connectionId === undefined ? {} : { connectionId: run.connectionId }) : { connectionId: event.data.connectionId }),
    })
  }
}

export function engineIdFor(threadId: string): string {
  return `e-${threadId}`
}

function serviceIdFor(projectId: string): string {
  return `svc-${projectId}`
}

/**
 * What the engine is launched with. On Runrail's own loop a model is always reached through a
 * connection: the engine resolves the key itself, so a model without one is not sent. A coding tool
 * that takes a model gets the model and the tool connection it runs as, whose login, folder, or key
 * the engine resolves; without one it signs in by itself. Any other tool gets nothing.
 */
export function launchSelection(thread: Pick<ThreadMeta, "backend" | "model" | "connectionId">): { readonly model?: string; readonly connectionId?: string; readonly toolConnectionId?: string } {
  const kept = carried(thread)
  if (thread.backend === "native" || kept.connectionId === undefined) return kept
  return { ...(kept.model === undefined ? {} : { model: kept.model }), toolConnectionId: kept.connectionId }
}

function touch(threadId: string): void {
  lastUsed.set(threadId, Date.now())
}

function threadFor(engineId: string): string | undefined {
  const owner = owners.get(engineId)
  if (owner !== undefined) return owner
  return engineId.startsWith("e-") ? engineId.slice(2) : undefined
}

/** A reasoning level the thread's connected model refused is hidden in the picker for that model. */
function noteRefusals(threadId: string, frames: readonly StreamFrame[]): void {
  for (const frame of frames) {
    if (frame.kind === "event" || (frame.data as { readonly type?: unknown } | null)?.type !== "model.notice") continue
    const parsed = LiveFrameSchema.safeParse(frame.data)
    const thread = threadById(threadId)
    if (!parsed.success || parsed.data.type !== "model.notice" || thread?.backend !== "native" || thread.connectionId === undefined || thread.model === undefined) continue
    rememberRefusal(thread.connectionId, thread.model, parsed.data.thinking)
  }
}

let filing: Promise<void> = Promise.resolve()

/**
 * A thread's plan readings are about the account its tool runs as, which can take a list of
 * the connections to know; one batch at a time, so a later reading never lands first.
 */
function filePlanFrames(threadId: string, frames: readonly PlanFrame[]): void {
  filing = filing.then(async () => {
    const thread = threadById(threadId)
    const account = thread === undefined ? undefined : await threadAccount(thread)
    if (account === undefined || !planLimitsOn()) return
    if (account.source === "codex") await readAccountUsage(account)
    else for (const frame of frames) notePlanReading(account, frame)
  })
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

export function initEngines(): () => void {
  const host = getHost()
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = [
    host.onBatch((engineId, frames) => {
      const threadId = threadFor(engineId)
    const thread = threadById(threadId)
    if (threadId === undefined || thread === undefined) return
      const plans = planFrames(frames)
      if (plans.length > 0) filePlanFrames(threadId, plans)
      noteActivity(threadId)
      const before = runtimeOf(threadId).timeline
      const run = engineRuns.get(engineId) ?? runForThread(thread)
      rememberTurnStarts(threadId, thread, frames, run)
      const after = applyFrames(before, frames, run)
      bump("stream.frames", frames.length)
      noteRefusals(threadId, frames)
      noteBackgroundFrames(threadId, frames)
      noteBrowserFrames(threadId, engineId, frames)
      noteThreadFrames(threadId, engineId, frames)
      noteComputerFrames(threadId, engineId, frames)
      if (after === before) return
      if (after.context !== undefined && after.context !== before.context) rememberContext(threadId, after.context)
      patchRuntime(threadId, { timeline: after, stream: "connected" })
      afterTimeline(threadId, before, after)
    }),
    // A settings restart held back for background work goes ahead once that work ends.
    useBackground.subscribe((_state, previous) => {
      for (const [threadId, before] of Object.entries(previous)) {
        const runtime = runtimeOf(threadId)
        if (runningCount(before) === 0 || runningCount(backgroundOf(threadId)) > 0 || !runtime.restartPending || isBusy(runtime.timeline)) continue
        void restartEngine(threadId)
      }
    }),
    host.onStream((engineId, state) => {
      const threadId = threadFor(engineId)
      if (threadId === undefined || threadById(threadId) === undefined) return
      bump(`stream.${state}`)
      patchRuntime(threadId, { stream: state === "connected" ? "connected" : "reconnecting" })
    }),
    host.onEngineExit((engineId, code, signal) => {
      bump(code === 0 ? "engine.exit" : "engine.exit.error")
      const threadId = threadFor(engineId)
      if (threadId === undefined) {
        for (const [projectId] of services) if (serviceIdFor(projectId) === engineId) services.delete(projectId)
        return
      }
      if (threadById(threadId) === undefined) return
      const at = Date.now()
      const wasBusy = isBusy(runtimeOf(threadId).timeline)
      patchRuntime(threadId, (current) => ({
        engine: "stopped",
        stream: "idle",
        timeline: markEngineExited(current.timeline, at),
        ...(code === 0 ? {} : { engineError: "ENGINE_EXITED", lastError: exitReason(code, signal) }),
      }))
      forgetActivity(threadId)
      if (wasBusy) patchThread(threadId, { lastStatus: "failed" })
    }),
  ]
  return () => {
    for (const unsubscribe of subscriptions) unsubscribe()
    subscriptions = []
  }
}

export function exitReason(code: number | null, signal: number | undefined): string {
  if (signal !== undefined) return `engine was stopped by signal ${String(signal)}`
  return code === null ? "engine stopped unexpectedly" : `engine exited with code ${String(code)}`
}

/** Starts (or reuses) the thread's engine, loads history once, and attaches the stream. */
export function ensureEngine(threadId: string): Promise<string> {
  // During a restart the old engine is still "ready" until it stops; a call waits for the new one
  // instead of reaching the one being stopped.
  const restart = restarts.get(threadId)
  if (restart !== undefined) return restart.promise.then(() => startOrReuse(threadId))
  return startOrReuse(threadId)
}

function startOrReuse(threadId: string): Promise<string> {
  const runtime = runtimeOf(threadId)
  if (runtime.engine === "ready" && runtime.engineId !== undefined) {
    touch(threadId)
    return Promise.resolve(runtime.engineId)
  }
  const inflight = starting.get(threadId)
  if (inflight !== undefined) return inflight
  const promise = startEngine(threadId).finally(() => starting.delete(threadId))
  starting.set(threadId, promise)
  return promise
}

async function startEngine(threadId: string): Promise<string> {
  const host = getHost()
  const thread = threadById(threadId)
  if (thread === undefined) throw new HostError("THREAD_NOT_FOUND", "thread no longer exists")
  const project = projectById(thread.projectId)
  if (project === undefined) throw new HostError("PROJECT_NOT_FOUND", "project no longer exists")
  const launchRun = runForThread(thread)
  patchRuntime(threadId, { engine: "starting", engineError: undefined, lastError: undefined })
  const clock = stepClock()
  const workspace = thread.worktree?.cwd ?? project.path
  // History first: the system engine reads the transcript while this engine starts. What it
  // read stays on screen unless the engine's own read differs.
  const base = runtimeOf(threadId).timeline
  let peeked: Conversation | undefined
  let answered = false
  if (!runtimeOf(threadId).historyLoaded)
    void peekHistory(threadId, workspace).then((history) => {
      if (history === undefined || answered || runtimeOf(threadId).historyLoaded) return
      peeked = history
      patchRuntime(threadId, { timeline: loadHistory(base, history.items, history.truncated === true, false, launchRun, thread.runHistory) })
    })
  await evictEngines(threadId)
  clock.mark("evict")
  const engineId = engineIdFor(threadId)
  engineRuns.set(engineId, launchRun)
  bump("engine.start")
  try {
    const integrations = await threadIntegrations(thread)
    // The same three routes take the image tool, once the person picked an image model.
    const images = takesBrowser(thread.backend) && (await imageToolsOn())
    const behavior = withShell(withInstructions(behaviorFor(effectivePermission(thread.permission, thread.backend), thread.mode, thread.thinking), get().prefs.instructions), get().prefs.terminalShell)
    const remote = project.remote
    const info = await launch(thread, remote !== undefined ? remoteStart(thread, { engineId, workspace, sessionId: threadId, behavior, remote: remote.id, threadTools: get().prefs.threadMessages !== "off" && takesBrowser(thread.backend) && !quiet(threadId), noNifra: !nifraOn(get().prefs) }) : {
      engineId,
      workspace,
      backend: thread.backend,
      sessionId: threadId,
      behavior: integrations === undefined ? behavior : { ...behavior, integrations },
      ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
      // The engine copies the earlier thread's conversation the first time only.
      ...(thread.parentThreadId === undefined ? {} : { continueFrom: thread.parentThreadId }),
      ...(thread.browser === undefined || !takesBrowser(thread.backend) ? {} : { browserTools: true,...(thread.browser.anySite === true ? { browserAnySite: true } : {}) }),
      // The routes that take the browser tools take the thread tools the same ways.
      ...(get().prefs.threadMessages === "off" || !takesBrowser(thread.backend) || quiet(threadId) ? {} : { threadTools: true }),
      // The same three routes take related folders; the others would refuse them.
      ...(project.folders === undefined || !takesBrowser(thread.backend) ? {} : { folders: project.folders }),
      ...(thread.computer === true && takesComputer(thread.backend) ? { computerTools: true } : {}),
      ...(images ? { imageTools: true } : {}),
      ...(nifraOn(get().prefs) ? {} : { noNifra: true }),
    })
    clock.mark("launch")
    owners.set(engineId, threadId)
    // Before the thread is ready, so its first turn already leaves out the project's disabled skills.
    await applySkillChoices(engineId, project.id)
    clock.mark("skills")
    const contract = parseOr(ContractSchema, info.contract)
    void host.rpc(engineId, "nifra.status").then((value) => {
      const nifra = NifraUseSchema.safeParse(value)
      if (nifra.success) patchRuntime(threadId, { nifra: nifra.data })
    }, () => undefined)
    const live = parseOr(ConversationSchema, await host.rpc(engineId, "session.conversation.read", { source: "live", maxItems: 1 }).catch(() => undefined))
    clock.mark("live")
    const liveSeq = live?.lastSeq ?? -1
    const runtime = runtimeOf(threadId)
    let timeline = runtime.timeline
    if (!runtime.historyLoaded) {
      const history = parseOr(
        ConversationSchema,
        await host.rpc(engineId, "session.conversation.read", { source: "auto", maxItems: HISTORY_ITEMS }).catch(() => undefined),
      )
      // Asked after the history read: a turn still open now was open when the history was written.
      const state = parseOr(ControlStateSchema, await host.rpc(engineId, "session.snapshot").catch(() => undefined))
      const inTurn = history === undefined ? undefined : state
      answered = true
      const same = peeked !== undefined && (history === undefined || (history.lastSeq === peeked.lastSeq && history.items.length === peeked.items.length && inTurn?.active !== true))
      if (same) timeline = runtimeOf(threadId).timeline
    else if (history !== undefined) timeline = loadHistory(base, history.items, history.truncated === true, inTurn?.active === true, launchRun, thread.runHistory)
      if (state?.historyUnavailable === true) timeline = appendNotice(timeline, { code: HISTORY_UNAVAILABLE, level: "error", message: "Runrail could not read this thread's earlier messages, so the model goes on without them." })
      clock.mark(peeked === undefined ? "history" : same ? "history (kept the peek)" : "history (replaced the peek)")
    }
    const sameInstance = runtime.instance === info.instance
    if (!sameInstance) {
      // An engine that outlived a window reload still holds live frames for turns the history already covers; start at its live position.
      const cursor = parseOr(LiveCursorSchema, await host.rpc(engineId, "live.frames", { afterLiveSeq: Number.MAX_SAFE_INTEGER, maxFrames: 1 }).catch(() => undefined))
      timeline = beginEpoch(timeline, liveSeq, cursor?.lastLiveSeq ?? 0)
      clock.mark("frames")
    }
    patchRuntime(threadId, { engine: "ready", engineId, instance: info.instance, ...(contract === undefined ? {} : { contract }), timeline, historyLoaded: true })
    clock.mark("ready")
    // A turn restored mid-flight is timed from here, so a silent one still shows as quiet.
    noteActivity(threadId)
    await host.streamStart(engineId, timeline.lastSeq, timeline.lastLiveSeq)
    clock.mark("stream")
    noteOpen({ backend: thread.backend, steps: clock.steps(), totalMs: clock.total(), items: timeline.items.length, at: Date.now() })
    touch(threadId)
    // Sent while the engine was starting: it goes now, once.
    const ready = runtimeOf(threadId)
    if (!ready.queuePaused && !shouldQueue(ready)) dispatchNext(threadId)
    return engineId
  } catch (error) {
    const failure = toHostError(error)
    recordError(failure.code)
    patchRuntime(threadId, { engine: "failed", stream: "idle", engineError: failure.code, lastError: failure.message })
    // A message sent while it was starting waits in the queue for an engine that is not coming.
    if (runtimeOf(threadId).queue.length > 0) sendFailed(threadId, failure.message)
    throw failure
  }
}

let peeks: Promise<boolean> | undefined

/** A thread's history from its transcript, through the system engine; undefined when it cannot say. */
async function peekHistory(threadId: string, workspace: string): Promise<Conversation | undefined> {
  peeks ??= systemCapability("conversation.peek").catch(() => {
    peeks = undefined
    return false
  })
  if (!(await peeks)) return undefined
  return parseOr(ConversationSchema, await systemRpc("conversation.peek", { threadId, workspace, maxItems: HISTORY_ITEMS }).catch(() => undefined))
}

/**
 * Fills a thread's timeline from its transcript without starting its engine, for a screen that
 * reads a thread the person has not opened (Reviews reads a review thread's findings).
 */
export async function peekThread(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined || runtimeOf(threadId).historyLoaded || runtimeOf(threadId).timeline.items.length > 0) return
  const workspace = thread.worktree?.cwd ?? projectById(thread.projectId)?.path
  if (workspace === undefined) return
  const history = await peekHistory(threadId, workspace)
  if (history === undefined || runtimeOf(threadId).historyLoaded || runtimeOf(threadId).timeline.items.length > 0) return
    patchRuntime(threadId, (current) => ({ timeline: loadHistory(current.timeline, history.items, history.truncated === true, false, thread === undefined ? undefined : runForThread(thread), thread?.runHistory) }))
}

/** Test seam: whether the system engine is asked again if it can peek. */
export function resetPeeks(): void {
  peeks = undefined
}

/**
 * Starts the engine on the thread's model. A thread whose connection was removed still opens: the
 * engine starts with no model so the conversation can be read, and sending stays refused until
 * another model is picked.
 */
async function launch(thread: ThreadMeta, base: EngineStartInput): Promise<EngineInfo> {
  const host = getHost()
  // A remote engine runs on what is signed in on its machine; the model was chosen in `remoteStart`.
  if (base.remote !== undefined) return host.engineStart(base)
  const selection = launchSelection(thread)
  // A tool connection that is gone fails the start: its tool's usual login would be another account.
  if (selection.toolConnectionId !== undefined) {
    const removed = new HostError("CONNECTION_REMOVED", problemHint("connection-removed", true))
    if (knownTools()?.some((tool) => tool.id === selection.toolConnectionId) === false) throw removed
    try {
      return await host.engineStart({ ...base, ...selection })
    } catch (error) {
      throw toHostError(error).code === "CONNECTION_NOT_FOUND" ? removed : error
    }
  }
  // No connection to lose: a coding tool on its own login, or no model at all.
  if (selection.connectionId === undefined) return host.engineStart({ ...base, ...selection })
  const gone = (connections: readonly Connection[]): boolean => !connections.some((connection) => connection.id === selection.connectionId)
  const known = knownConnections()
  if (known !== undefined && gone(known)) return host.engineStart(base)
  try {
    return await host.engineStart({ ...base, ...selection })
  } catch (error) {
    if (toHostError(error).code === "CONNECTION_NOT_FOUND") {
      // Refresh the list too, so sending is refused as "connection removed" rather than "not ready".
      await listConnections().catch(() => undefined)
      return host.engineStart(base)
    }
    // An older engine reports a missing connection like any other failed start, so the list decides.
    const listed = await listConnections().catch(() => undefined)
    if (listed === undefined || !gone(listed)) throw error
    return host.engineStart(base)
  }
}

/**
 * What a thread on a remote machine starts with: its folder there, its mode and
 * model, and nothing that lives only on this Mac: no connection or key, browser, related folders,
 * computer or image tools, and no conversation copied from a thread here.
 */
export function remoteStart(thread: Pick<ThreadMeta, "backend" | "model" | "thinking">, base: { readonly engineId: string; readonly workspace: string; readonly sessionId: string; readonly behavior: EngineStartInput["behavior"]; readonly remote: string; readonly threadTools: boolean; readonly noNifra?: boolean }): EngineStartInput {
  return {
    engineId: base.engineId,
    workspace: base.workspace,
    backend: thread.backend,
    sessionId: base.sessionId,
    remote: base.remote,
    ...(base.behavior === undefined ? {} : { behavior: base.behavior }),
    ...(thread.model === undefined || thread.backend === "native" ? {} : { model: thread.model }),
    ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
    ...(base.threadTools ? { threadTools: true } : {}),
    ...(base.noNifra === true ? { noNifra: true } : {}),
  }
}

/** Why the thread may not send, as an error the timeline can show. */
function sendRefusal(threadId: string): HostError | undefined {
  const thread = threadById(threadId)
  if (thread === undefined) return undefined
  const problem = selectionProblem(thread, knownConnections(), get().prefs.developer, knownTools())
  if (problem === undefined) return undefined
  return new HostError(problem === "no-model" ? "MODEL_NOT_SET" : problem === "connection-removed" ? "CONNECTION_REMOVED" : "CONNECTION_NOT_READY", problemHint(problem, true))
}

async function evictEngines(keep: string): Promise<void> {
  const state = get()
  const live = Object.entries(state.runtime).filter(([, runtime]) => runtime.engine === "ready" || runtime.engine === "starting")
  if (live.length < MAX_LIVE_ENGINES) return
  const candidates = live
    .filter(([id, runtime]) => id !== keep && id !== state.layout.activeThreadId && !(state.layout.panes ?? []).includes(id) && runtime.engine === "ready" && !isBusy(runtime.timeline) && runningCount(backgroundOf(id)) === 0)
    .sort(([a], [b]) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))
  for (const [id] of candidates.slice(0, live.length - MAX_LIVE_ENGINES + 1)) await stopEngine(id)
}

export async function stopEngine(threadId: string): Promise<void> {
  const runtime = runtimeOf(threadId)
  const engineId = runtime.engineId ?? engineIdFor(threadId)
  const host = getHost()
  await host.streamStop(engineId).catch(() => undefined)
  await host.engineStop(engineId).catch(() => undefined)
  patchRuntime(threadId, (current) => ({ engine: "stopped", stream: "idle", timeline: markEngineExited(current.timeline) }))
  forgetActivity(threadId)
}

/** Restarts in flight: whether the new engine has read its settings, and whether one changed since. */
const restarts = new Map<string, { promise: Promise<void>; starting: boolean; again: boolean }>()

/** Stops the thread's engine and starts it again with the thread's current settings. */
export function restartEngine(threadId: string): Promise<void> {
  const running = restarts.get(threadId)
  if (running !== undefined) {
    // A change before the new engine starts is read by it; one after needs another restart.
    if (running.starting) running.again = true
    return running.promise
  }
  const entry = { promise: Promise.resolve(), starting: false, again: false }
  entry.promise = (async () => {
    do {
      entry.again = false
      entry.starting = false
      patchRuntime(threadId, { restartPending: false })
      await stopEngine(threadId)
      entry.starting = true
      await startOrReuse(threadId).catch(() => undefined)
    } while (entry.again)
  })().finally(() => restarts.delete(threadId))
  restarts.set(threadId, entry)
  return entry.promise
}

/** Calls a method on the thread's engine, restarting it once if the process went away. */
export async function threadRpc(threadId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const engineId = await ensureEngine(threadId)
  bump("rpc.calls")
  try {
    return await getHost().rpc(engineId, method, params)
  } catch (error) {
    const failure = toHostError(error)
    recordError(failure.code)
    if (failure.code !== "ENGINE_NOT_RUNNING") throw failure
    patchRuntime(threadId, { engine: "stopped", stream: "idle" })
    return getHost().rpc(await ensureEngine(threadId), method, params)
  }
}

/** Rebuilds the timeline from the engine after something outside a turn rewrote the transcript. */
export async function reloadHistory(threadId: string): Promise<void> {
  const history = parseOr(ConversationSchema, await threadRpc(threadId, "session.conversation.read", { source: "auto", maxItems: HISTORY_ITEMS }))
  if (history === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "conversation response was malformed")
  const thread = threadById(threadId)
  patchRuntime(threadId, (current) => ({ timeline: loadHistory(current.timeline, history.items, history.truncated === true, false, thread === undefined ? undefined : runForThread(thread), thread?.runHistory), historyLoaded: true }))
}

/**
 * A quiet per-project engine on the replay backend for work that is not part of a conversation:
 * creating worktrees and reading git state before a thread exists.
 */
export async function projectRpc(projectId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const call = async (): Promise<unknown> => getHost().rpc(await ensureService(projectId), method, params)
  bump("rpc.service")
  serviceCalls.set(projectId, (serviceCalls.get(projectId) ?? 0) + 1)
  try {
    return await call()
  } catch (error) {
    const failure = toHostError(error)
    recordError(failure.code)
    if (failure.code !== "ENGINE_NOT_RUNNING") throw failure
    services.delete(projectId)
    return call()
  } finally {
    const left = (serviceCalls.get(projectId) ?? 1) - 1
    if (left > 0) serviceCalls.set(projectId, left)
    else serviceCalls.delete(projectId)
  }
}

/** Calls in flight to each project's quiet engine: an eval run is one long call. */
const serviceCalls = new Map<string, number>()
const serviceRestarts = new Set<string>()
let serviceRetry: ReturnType<typeof setTimeout> | undefined
const SERVICE_RESTART_RETRY_MS = 15_000

/**
 * Restarts a project's quiet engine so it reads changed settings, once it runs no setup, workflow,
 * or eval: stopping it would end them. Asked again until then.
 */
export async function restartProjectService(projectId: string): Promise<void> {
  if (!services.has(projectId)) return void serviceRestarts.delete(projectId)
  if (await serviceBusy(projectId)) {
    serviceRestarts.add(projectId)
    serviceRetry ??= setTimeout(() => {
      serviceRetry = undefined
      for (const id of [...serviceRestarts]) void restartProjectService(id)
    }, SERVICE_RESTART_RETRY_MS)
    return
  }
  serviceRestarts.delete(projectId)
  await stopProjectService(projectId)
}

async function serviceBusy(projectId: string): Promise<boolean> {
  if ((serviceCalls.get(projectId) ?? 0) > 0) return true
  const engineId = await services.get(projectId)?.catch(() => undefined)
  if (engineId === undefined) return false
  const host = getHost()
  const lists = await Promise.all(["setup.run.list", "workflow.run.list"].map((method) => host.rpc(engineId, method, {}).catch(() => undefined)))
  return lists.some((list) => {
    const runs = (list as { readonly runs?: unknown } | undefined)?.runs
    return Array.isArray(runs) && runs.some((run) => {
      const state = (run as { readonly state?: unknown } | null)?.state
      return state === "running" || state === "waiting"
    })
  })
}

/** Removes a project and stops every engine working in it, its threads' included. */
export async function closeProject(projectId: string): Promise<void> {
  const threads = get().threads.filter((thread) => thread.projectId === projectId).map((thread) => thread.id)
  serviceRestarts.delete(projectId)
  removeProject(projectId)
  // A removed project's saved browser sign-ins go with it.
  await Promise.all([stopProjectService(projectId), ...threads.map((threadId) => stopEngine(threadId)), getHost().signInsForget(projectId).catch(() => undefined)])
}

function ensureService(projectId: string): Promise<string> {
  const existing = services.get(projectId)
  if (existing !== undefined) return existing
  const project = projectById(projectId)
  if (project === undefined) return Promise.reject(new HostError("PROJECT_NOT_FOUND", "project no longer exists"))
  const engineId = serviceIdFor(projectId)
  const promise = getHost()
    .engineStart({ engineId, workspace: project.path, backend: "replay", sessionId: engineId, ...(project.remote === undefined ? {} : { remote: project.remote.id }) })
    .then(async (info) => {
      const contract = parseOr(ContractSchema, info.contract)
      if (contract !== undefined) serviceContracts.set(projectId, contract)
      await applySkillChoices(engineId, projectId)
      return engineId
    })
  promise.catch(() => services.delete(projectId))
  services.set(projectId, promise)
  return promise
}

/**
 * Turns off the project's disabled skills in one engine. A skill the engine does not have (removed,
 * or a coding tool with no skills) is skipped; the choice stays for engines that have it.
 */
async function applySkillChoices(engineId: string, projectId: string): Promise<void> {
  const host = getHost()
  for (const id of projectById(projectId)?.disabledSkills ?? []) await host.rpc(engineId, "skills.setEnabled", { id, enabled: false }).catch(() => undefined)
}

/**
 * Turns a skill on or off for a project: the project's engine first, so a refusal changes nothing,
 * then the saved choice, then each running thread of the project. New engines start with it.
 */
export async function setSkillEnabled(projectId: string, skillId: string, enabled: boolean): Promise<void> {
  await projectRpc(projectId, "skills.setEnabled", { id: skillId, enabled })
  setProjectSkill(projectId, skillId, enabled)
  const host = getHost()
  const running = get().threads.filter((thread) => thread.projectId === projectId).map((thread) => runtimeOf(thread.id))
  await Promise.all(
    running
      .filter((runtime) => runtime.engine === "ready" && runtime.engineId !== undefined)
      .map((runtime) => host.rpc(runtime.engineId!, "skills.setEnabled", { id: skillId, enabled }).catch(() => undefined)),
  )
}

/** The contract of the project's service engine, once it has started. */
export function projectContract(projectId: string): Contract | undefined {
  return serviceContracts.get(projectId)
}

/** Whether the project's engine offers a capability. Starts the service engine if needed. */
export async function projectCapability(projectId: string, name: string): Promise<boolean> {
  await ensureService(projectId)
  return hasCapability(serviceContracts.get(projectId), name)
}

/** Whether the thread's engine offers a capability. False until the engine has started. */
export function threadCapability(threadId: string, name: string): boolean {
  return hasCapability(runtimeOf(threadId).contract, name)
}

export async function stopProjectService(projectId: string): Promise<void> {
  if (!services.has(projectId)) return
  services.delete(projectId)
  await getHost().engineStop(serviceIdFor(projectId)).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------------
// Timeline transitions

function afterTimeline(threadId: string, before: Timeline, after: Timeline): void {
  noteTimeline(threadId, before, after)
  if (after.lastTurnEnd !== undefined && after.lastTurnEnd !== before.lastTurnEnd) void onTurnEnd(threadId, after.lastTurnEnd)
  if (after.activeTurnId !== undefined && before.activeTurnId !== after.activeTurnId) patchThread(threadId, { lastStatus: "running" })
  const beforePending = pendingApprovals(before).length
  const afterPending = pendingApprovals(after).length
  if (afterPending > beforePending) {
    patchThread(threadId, { lastStatus: "waiting" })
    if (useVoice.getState().talking === threadId) speak("The agent needs your approval.", `approval:${threadId}`)
    if (threadOnScreen() !== threadId) {
      patchThread(threadId, { unread: true })
      notify("approval", threadId, threadById(threadId)?.title ?? "A thread")
    }
    announce("approval", threadId)
  } else if (afterPending < beforePending && after.activeTurnId !== undefined) {
    patchThread(threadId, { lastStatus: "running" })
  }
}

function statusOf(end: NonNullable<Timeline["lastTurnEnd"]>): ThreadStatus {
  return end.status
}

async function onTurnEnd(threadId: string, end: NonNullable<Timeline["lastTurnEnd"]>): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined) return
  noteTurnEnd(threadId, end)
  const active = threadOnScreen() === threadId
  patchThread(threadId, { updatedAt: end.at, lastStatus: statusOf(end), ...(active ? {} : { unread: true }) })
  if (end.status === "completed") {
    const answers = turnItems(runtimeOf(threadId).timeline, end.turnId).filter((item) => item.kind === "assistant")
    const answer = answers[answers.length - 1]
    if (answer?.kind === "assistant") readAnswer(threadId, answer.text, answer.key)
  }
  // A setup's turns are steps of its run, which tells the person when it ends; a helper answers in the thread that asked.
  const step = thread.setup !== undefined || quiet(threadId)
  if (!active && !step) notify(end.status === "completed" ? "finished" : end.status === "failed" ? "failed" : "stopped", threadId, thread.title, end.at)
  if (end.status !== "stopped" && !step) announce(end.status === "failed" ? "failed" : "finished", threadId)
  else if (!active && !step && get().prefs.notifications) toast("success", `${thread.title} stopped`, { label: "Open", run: () => openThread(threadId) })
  void refreshGit(threadId)
  void computeTurnChanges(threadId, end.turnId)
  for (const listener of turnEndListeners) listener(threadId, end.turnId)

  const runtime = runtimeOf(threadId)
  if (runtime.restartPending && runningCount(backgroundOf(threadId)) === 0) await restartEngine(threadId)

  if (runtime.goal?.status === "running") {
    if (continueGoal(threadId, end)) return
  }
  const next = runtimeOf(threadId)
  if (next.queue.length === 0) return
  if (end.status !== "completed") {
    patchRuntime(threadId, { queuePaused: true })
    return
  }
  if (!next.queuePaused) dispatchNext(threadId)
}

function turnItems(timeline: Timeline, turnId: string): Timeline["items"] {
  return timeline.items.filter((item) => "turnId" in item && item.turnId === turnId)
}

async function computeTurnChanges(threadId: string, turnId: string): Promise<void> {
  const timeline = runtimeOf(threadId).timeline
  const paths = new Set<string>()
  for (const item of turnItems(timeline, turnId)) {
    if (item.kind !== "tool" || item.status !== "ok") continue
    const kind = item.presentation.kind
    if (kind !== "write" && kind !== "edit" && kind !== "patch") continue
    if (item.presentation.path !== undefined) paths.add(item.presentation.path)
    for (const path of item.presentation.paths ?? []) paths.add(path)
  }
  if (paths.size === 0) return
  try {
    const diff = parseOr(
      GitDiffSchema,
      await threadRpc(threadId, "git.diff", { scope: "head", paths: [...paths].slice(0, 256), contextLines: 0, maxFiles: 256, maxBytes: 1_024 * 1_024, includeUntracked: true }),
    )
    if (diff === undefined) return
    patchRuntime(threadId, (current) => ({ changes: { ...current.changes, [turnId]: diff.totals } }))
  } catch {
    // Not a repository, or git is unavailable: the turn summary omits the change count.
  }
}

const turnEndListeners = new Set<(threadId: string, turnId: string) => void>()
const sendFailListeners = new Set<(threadId: string, reason: string) => void>()

/** Runs when a message could not reach the thread's engine: no turn starts, so none will end. */
export function onSendFailed(listener: (threadId: string, reason: string) => void): () => void {
  sendFailListeners.add(listener)
  return () => sendFailListeners.delete(listener)
}

function sendFailed(threadId: string, reason: string): void {
  for (const listener of sendFailListeners) listener(threadId, reason)
}

/** Runs after each turn ends, once the engine's state for it is in. */
export function onTurnEnded(listener: (threadId: string, turnId: string) => void): () => void {
  turnEndListeners.add(listener)
  return () => turnEndListeners.delete(listener)
}

export async function refreshGit(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const project = projectById(thread?.projectId)
  if (thread === undefined || project === undefined) return
  if (!project.git && thread.worktree === undefined) {
    patchGit(threadId, { loading: false, error: "NOT_A_REPOSITORY" })
    return
  }
  patchGit(threadId, { loading: true })
  try {
    const status = parseOr(GitStatusSchema, await threadRpc(threadId, "git.status", { maxEntries: 2_000 }))
    if (status === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "git status was malformed")
    patchGit(threadId, { status, loading: false, error: undefined, updatedAt: Date.now() })
    void refreshChangeStats(threadId)
    if (get().git[threadId]?.remotes === undefined) void refreshRemotes(threadId)
  } catch (error) {
    patchGit(threadId, { loading: false, error: toHostError(error).code })
  }
}

/** Changed lines and files for the thread bar, counted without building patches. */
async function refreshChangeStats(threadId: string): Promise<void> {
  const contract = runtimeOf(threadId).contract
  if (contract !== undefined && !hasCapability(contract, "git.diff.stats")) return
  try {
    const diff = parseOr(GitDiffSchema, await threadRpc(threadId, "git.diff", { scope: "head", statsOnly: true, includeUntracked: true }))
    if (diff !== undefined) patchGit(threadId, { stats: { ...diff.totals, ...(diff.truncated === true ? { truncated: true } : {}) } })
  } catch {
    // The bar keeps its last counts; the Review pane reports git failures.
  }
}

/** The checkout's remotes, and from them what the project is connected to. */
export async function refreshRemotes(threadId: string): Promise<void> {
  try {
    const list = parseOr(GitRemoteListSchema, await threadRpc(threadId, "git.remote.list", {}))
    if (list === undefined) return
    patchGit(threadId, { remotes: list.remotes })
    const thread = threadById(threadId)
    if (thread !== undefined) noteProjectGit(thread.projectId, { connectedTo: connectedTo(list.remotes, splitUpstream(get().git[threadId]?.status?.upstream)?.remote) })
  } catch {
    // No remote list: the header shows no service and the bar no Publish.
  }
}

// ---------------------------------------------------------------------------------------------
// Sending

export interface SendInput {
  readonly text: string
  readonly attachments?: readonly Attachment[]
  /** Skill ids to run with the message. */
  readonly skills?: readonly string[]
  /** A message sent again names the key it first went under. */
  readonly requestId?: string
  /** Sent without the check for a used-up plan. */
  readonly anyway?: boolean
}

/** The engine's own loop takes skills by id (up to eight); a coding tool is asked in words. */
const MAX_SKILLS = 8

export function withSkills(backend: string, text: string, skills: readonly string[]): { readonly text: string; readonly skills: readonly string[] } {
  if (skills.length === 0) return { text, skills }
  if (backend === "native") return { text, skills: skills.slice(0, MAX_SKILLS) }
  const asked = skills.map((id) => `Use the ${id} skill.`).join(" ")
  return { text: text.length === 0 ? asked : `${asked}\n\n${text}`, skills: [] }
}

/** Sends now if the thread is idle; otherwise queues. Titles the thread from its first prompt. */
export function send(threadId: string, input: SendInput): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const { text, skills } = withSkills(thread.backend, input.text.trim(), input.skills ?? [])
  const attachments = input.attachments ?? []
  if (text.length === 0 && attachments.length === 0) return
  noteSent(threadId, text)
  // A message sent before a usage limit resets takes the place of the wait for it.
  if (thread.resume !== undefined) patchThread(threadId, { resume: undefined })
  if (!thread.titled && text.length > 0) patchThread(threadId, { title: titleFromPrompt(text), titled: true })
  patchThread(threadId, { updatedAt: Date.now() })
  // The thread moves on: what its imported session gains from now on stays in that tool.
  if (runtimeOf(threadId).newTurns !== undefined) patchRuntime(threadId, { newTurns: undefined })

  if (thread.mode === "goal" && runtimeOf(threadId).goal?.status !== "running") {
    patchRuntime(threadId, { goal: { objective: text, iteration: 1, max: GOAL_ITERATIONS, status: "running" } })
    dispatch(threadId, { id: newId("q"), text: goalPrompt(text), attachments, ...(skills.length === 0 ? {} : { skills }) }, text)
    return
  }
  const prompt: QueuedPrompt = { id: input.requestId ?? newId("q"), text, attachments, ...(skills.length === 0 ? {} : { skills }), ...(input.anyway === true ? { anyway: true as const } : {}) }
  if (shouldQueue(runtimeOf(threadId))) {
    patchRuntime(threadId, (current) => ({ queue: [...current.queue, prompt] }))
    return
  }
  dispatch(threadId, prompt)
}

function shouldQueue(runtime: ThreadRuntime): boolean {
  if (runtime.engine === "starting" || runtime.compacting === true) return true
  if (isBusy(runtime.timeline)) return true
  return runtime.timeline.items.some((item) => item.kind === "user" && item.state === "sending")
}

function dispatchNext(threadId: string): void {
  const runtime = runtimeOf(threadId)
  const [next, ...rest] = runtime.queue
  if (next === undefined) return
  patchRuntime(threadId, { queue: rest })
  dispatch(threadId, next)
}

function messageFor(text: string, attachments: readonly Attachment[], skills: readonly string[] = []): unknown {
  if (attachments.length === 0 && skills.length === 0) return text
  return {
    text,
    ...(skills.length === 0 ? {} : { skills }),
    attachments: attachments.map((attachment) => ({
      path: attachment.path,
      kind: attachment.kind,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
    })),
  }
}

/** Whether a message asks the engine to add the memories it recalls; set by `memory.ts`. */
let recalls: (threadId: string) => boolean = () => false

export function setRecalls(value: (threadId: string) => boolean): void {
  recalls = value
}

/** Helper threads: their turns end without a notification and their messages recall nothing. */
const quietTests: ((threadId: string) => boolean)[] = []

export function quietWhen(test: (threadId: string) => boolean): void {
  quietTests.push(test)
}

export function quiet(threadId: string): boolean {
  return quietTests.some((test) => test(threadId))
}

function dispatch(threadId: string, prompt: QueuedPrompt, display?: string): void {
  const images = prompt.attachments.flatMap((attachment) => (attachment.previewUrl === undefined ? [] : [attachment.previewUrl]))
  const sent = prompt.attachments.map(({ path, kind, name, mediaType }) => ({ path, kind, name, ...(mediaType === undefined ? {} : { mediaType }) }))
  let key = ""
  patchRuntime(threadId, (current) => {
    const added = addPendingUser(current.timeline, { text: display ?? prompt.text, attachments: prompt.attachments.length, images, sent, requestId: prompt.id })
    key = added.key
    return { timeline: added.timeline, lastError: undefined }
  })
  let held = false
  let heldForSdk = false
  void (async () => {
    try {
      // Checked here, the one place every send passes: a queue, a goal loop, or a setup run.
      const refusal = sendRefusal(threadId)
      if (refusal !== undefined) throw refusal
      const thread = threadById(threadId)
      const sdk = thread !== undefined && mayAskForSdk(thread) ? await claudeSdkRefusal(thread) : undefined
      if (sdk !== undefined) {
        // An engine starting or restarting puts back the timeline it read; the card goes on after.
        await ensureEngine(threadId).catch(() => undefined)
        heldForSdk = true
        throw sdk
      }
      const limit = thread !== undefined && prompt.anyway !== true && mayHoldForLimit(thread) ? await planLimitRefusal(thread) : undefined
      if (limit !== undefined) {
        held = true
        throw limit
      }
      // A goal loop's own prompts go as they are; the person's message is what recall looks up.
      const recall = display === undefined && !quiet(threadId) && recalls(threadId)
      // A resend after a lost answer goes under the same key, so the engine runs it once.
      await threadRpc(threadId, "turn.enqueue", { message: messageFor(prompt.text, prompt.attachments, prompt.skills), idempotencyKey: prompt.id, ...(recall ? { recall: true } : {}) })
      // An engine that never announced the turn still took the message.
      patchRuntime(threadId, (current) => ({ timeline: markUser(current.timeline, key, "sent") }))
    } catch (error) {
      const failure = toHostError(error)
      if (heldForSdk) {
        // One card asks for every message held in the thread; the answer sends them all.
        patchRuntime(threadId, (current) => {
          const marked = markUser(current.timeline, key, "failed", failure.code, failure.message)
          const asking = marked.items.some((item) => item.kind === "notice" && item.code === CLAUDE_SDK_NOTICE)
          return { timeline: asking ? marked : appendNotice(marked, { code: CLAUDE_SDK_NOTICE, level: "info" }), queuePaused: true }
        })
        if (runtimeOf(threadId).goal?.status === "running") patchRuntime(threadId, (current) => ({ ...(current.goal === undefined ? {} : { goal: { ...current.goal, status: "stopped" } }) }))
        return
      }
      patchRuntime(threadId, (current) => {
        const marked = markUser(current.timeline, key, "failed", failure.code, held ? HELD_FOR_LIMIT : failure.message)
        // A held message gets the card a turn the limit refused ends with, which says it all.
        return held ? { timeline: appendNotice(marked, { code: failure.code, level: "error", message: failure.message }), queuePaused: true } : { timeline: marked, queuePaused: true, lastError: failure.message }
      })
      if (runtimeOf(threadId).goal?.status === "running") patchRuntime(threadId, (current) => ({ ...(current.goal === undefined ? {} : { goal: { ...current.goal, status: "stopped" } }) }))
      sendFailed(threadId, failure.message)
    }
  })()
}

/** Retries a failed send: removes the failed bubble and sends the same text again. */
export function retry(threadId: string, key: string, anyway = false): void {
  const timeline = runtimeOf(threadId).timeline
  const position = timeline.index.get(key)
  const item = position === undefined ? undefined : timeline.items[position]
  if (item?.kind !== "user") return
  patchRuntime(threadId, (current) => ({ timeline: removeItem(current.timeline, key), queuePaused: false }))
  send(threadId, { text: item.text, ...(item.requestId === undefined ? {} : { requestId: item.requestId }), ...(anyway ? { anyway } : {}) })
}

/**
 * The person's answer on the Claude Agent SDK card: download it, restart the Claude Code engines so
 * they use it, then send what waited; or send without it, and stop asking.
 */
export async function answerClaudeSdk(threadId: string, install: boolean): Promise<void> {
  if (install) {
    if (!(await installClaudeSdk())) return
    restartClaudeCode(threadId)
    // This thread's engine started in print mode; its held messages go to the new one.
    await restartEngine(threadId)
  } else setPrefs({ claudeSdk: "without" })
  patchRuntime(threadId, (current) => {
    let timeline = current.timeline
    for (const item of current.timeline.items) if (item.kind === "notice" && item.code === CLAUDE_SDK_NOTICE) timeline = removeItem(timeline, item.key)
    return { timeline }
  })
  for (const item of runtimeOf(threadId).timeline.items) if (item.kind === "user" && item.state === "failed" && item.errorCode === CLAUDE_SDK_CODE) retry(threadId, item.key)
}

/** Downloads the SDK from Settings; Claude Code threads pick it up as each one is idle. */
export async function installClaudeSdkEverywhere(): Promise<void> {
  if (await installClaudeSdk()) restartClaudeCode()
}

/** A Claude Code engine chooses the SDK or print mode as it starts. */
function restartClaudeCode(except?: string): void {
  for (const thread of get().threads) if (thread.backend === "claude-code" && thread.id !== except) applyRestart(thread.id)
}

/** Sends the thread's last message again, for a fresh answer; the earlier answer stays above. */
export function askAgain(threadId: string): void {
  const items = runtimeOf(threadId).timeline.items
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "user" && item.steer !== true && item.text.trim().length > 0) {
      send(threadId, { text: item.text })
      return
    }
  }
}

/**
 * Adds guidance to the running turn without waiting for it to end. Where the engine answers for the
 * running turn only (`turn.steer.live`), guidance the turn cannot take now (Claude Code between its
 * tools, a turn that just ended) goes back first in the queue instead of into the engine's.
 */
export async function steer(threadId: string, input: SendInput): Promise<void> {
  const { text, skills } = withSkills(threadById(threadId)?.backend ?? "native", input.text.trim(), input.skills ?? [])
  const attachments = input.attachments ?? []
  if (text.length === 0 && attachments.length === 0) return
  noteRescue(threadId)
  const liveOnly = runtimeOf(threadId).contract?.capabilities["turn.steer.live"] !== undefined
  let key = ""
  patchRuntime(threadId, (current) => {
    const added = addPendingUser(current.timeline, { text, attachments: attachments.length, steer: true })
    key = added.key
    return { timeline: added.timeline }
  })
  try {
    const answer = await threadRpc(threadId, "turn.steer", { message: messageFor(text, attachments, skills), idempotencyKey: newId("s"), ...(liveOnly ? { liveOnly: true } : {}) })
    if (!liveOnly || (answer as { readonly steered?: unknown } | null)?.steered !== false) return
    const prompt: QueuedPrompt = { id: newId("q"), text, attachments, ...(skills.length === 0 ? {} : { skills }) }
    patchRuntime(threadId, (current) => ({ timeline: removeItem(current.timeline, key), queue: [prompt, ...current.queue] }))
    const runtime = runtimeOf(threadId)
    if (!runtime.queuePaused && !shouldQueue(runtime)) dispatchNext(threadId)
  } catch (error) {
    const failure = toHostError(error)
    patchRuntime(threadId, (current) => ({ timeline: markUser(current.timeline, key, "failed", failure.code, failure.message), lastError: failure.message }))
  }
}

export async function cancel(threadId: string): Promise<void> {
  noteRescue(threadId)
  patchRuntime(threadId, (current) => ({
    queuePaused: current.queue.length > 0 ? true : current.queuePaused,
    ...(current.goal?.status === "running" ? { goal: { ...current.goal, status: "stopped" as const } } : {}),
  }))
  try {
    await threadRpc(threadId, "turn.cancel", { reason: "user" })
  } catch (error) {
    toast("error", `Could not stop: ${toHostError(error).message}`)
  }
}

/**
 * Whether "Allow for this session" is offered: the engine takes the scope, and the thread runs on
 * Claude Code, the one tool that can remember an answer. Elsewhere the engine treats it as once.
 */
export function offersSessionApproval(threadId: string): boolean {
  return threadById(threadId)?.backend === "claude-code" && threadCapability(threadId, "approval.scope")
}

/** Whether the engine takes answers to a coding tool's questions; an older one takes only yes or no. */
export function answersQuestions(threadId: string): boolean {
  return threadCapability(threadId, "approval.questions")
}

/** Resolves to whether the answer went through, so a question form can keep what was typed when it did not. */
/** `followUp` asks the tool for more questions instead, with the answers so far (any) and an optional note. */
export async function resolveApproval(threadId: string, approvalId: string, approved: boolean, reason?: string, scope?: "session", answers?: Readonly<Record<string, readonly string[]>>, followUp?: { readonly note?: string }): Promise<boolean> {
  const asked = askedAt(runtimeOf(threadId).timeline, approvalId)
  const more = followUp === undefined ? {} : { followUp: true, ...(followUp.note === undefined ? {} : { note: followUp.note }) }
  // The engine takes no empty answer set; asking for more with none sends only the request.
  const given = answers === undefined || (followUp !== undefined && Object.keys(answers).length === 0) ? {} : { answers }
  try {
    const taken = await threadRpc(threadId, "approval.resolve", { approvalId, approved, ...(reason === undefined ? {} : { reason }), ...(scope === undefined ? {} : { scope }), ...given, ...more })
    // `false` means the engine no longer had it waiting: someone else answered, or it timed out.
    if (taken !== false) noteAnswered(threadId, approvalId, asked)
    return true
  } catch (error) {
    toast("error", `${answers === undefined ? "Approval" : "Answer"} failed: ${toHostError(error).message}`)
    return false
  }
}

export function removeQueued(threadId: string, id: string): void {
  patchRuntime(threadId, (current) => ({ queue: current.queue.filter((item) => item.id !== id) }))
}

export function editQueued(threadId: string, id: string): QueuedPrompt | undefined {
  const item = runtimeOf(threadId).queue.find((prompt) => prompt.id === id)
  removeQueued(threadId, id)
  return item
}

/** Sends the next queued prompt now (resuming a paused queue). */
export function resumeQueue(threadId: string): void {
  patchRuntime(threadId, { queuePaused: false })
  if (!shouldQueue(runtimeOf(threadId))) dispatchNext(threadId)
}

// ---------------------------------------------------------------------------------------------
// Goal loop

function goalPrompt(objective: string): string {
  return [
    `Goal: ${objective}`,
    "",
    "Work toward this goal autonomously across turns. Make the changes, then run the checks that prove the goal is met (tests, typecheck, build).",
    "When the goal is fully met and verified, end your reply with a line that says exactly: GOAL COMPLETE",
  ].join("\n")
}

function continueGoal(threadId: string, end: NonNullable<Timeline["lastTurnEnd"]>): boolean {
  const runtime = runtimeOf(threadId)
  const goal = runtime.goal
  if (goal === undefined) return false
  if (end.status !== "completed") {
    patchRuntime(threadId, { goal: { ...goal, status: "stopped" } })
    return false
  }
  const items = turnItems(runtime.timeline, end.turnId)
  const lastAssistant = [...items].reverse().find((item) => item.kind === "assistant")
  const declared = lastAssistant?.kind === "assistant" && GOAL_DONE.test(lastAssistant.text)
  const failedVerification = items.some((item) => item.kind === "notice" && item.code === "verification.failed")
  if (declared && !failedVerification) {
    patchRuntime(threadId, { goal: { ...goal, status: "passed" } })
    return false
  }
  if (goal.iteration >= goal.max) {
    patchRuntime(threadId, { goal: { ...goal, status: "exhausted" } })
    return false
  }
  const iteration = goal.iteration + 1
  patchRuntime(threadId, { goal: { ...goal, iteration } })
  const text = [
    `Continue toward the goal: ${goal.objective}`,
    failedVerification ? "The last verification failed; fix the cause before continuing." : "Check what is still missing, finish it, and verify.",
    "End with GOAL COMPLETE only when the goal is met and verified.",
  ].join("\n")
  dispatch(threadId, { id: newId("q"), text, attachments: [] }, `Continue toward goal (${String(iteration)} of ${String(goal.max)})`)
  return true
}

export function stopGoal(threadId: string): void {
  patchRuntime(threadId, (current) => (current.goal === undefined ? {} : { goal: { ...current.goal, status: "stopped" } }))
}

// ---------------------------------------------------------------------------------------------
// Thread settings

/**
 * Changes the model or reasoning effort. Both are launch settings of the engine, so a running
 * engine restarts (after the current turn, if one is running); history is kept on disk.
 */
export function setModel(threadId: string, selection: { readonly model: string | undefined; readonly connectionId?: string } | undefined, thinking?: Thinking): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const previousRun = runForThread(thread)
  const next = { ...(selection === undefined ? {} : { model: selection.model, connectionId: selection.connectionId }), ...(thinking === undefined ? {} : { thinking }) }
  if ((selection === undefined || (selection.model === thread.model && selection.connectionId === thread.connectionId)) && (thinking === undefined || thinking === thread.thinking)) return
  const modelChanged = selection !== undefined && (selection.model !== thread.model || selection.connectionId !== thread.connectionId)
  patchThread(threadId, next)
  if (modelChanged) noteModelSwitch(threadId, previousRun, runForThread({ ...thread, ...next }))
  applyRestart(threadId)
}

/** Something every engine starts with changed: idle engines restart now, busy ones when their turn ends. */
export function restartEngines(projectId?: string): void {
  for (const thread of get().threads) if (projectId === undefined || thread.projectId === projectId) applyRestart(thread.id)
}

function applyRestart(threadId: string): void {
  const runtime = runtimeOf(threadId)
  // A start that failed is tried again with the new settings; a stopped engine picks them up on its own.
  if (runtime.engine === "failed") return void ensureEngine(threadId).catch(() => undefined)
  if (runtime.engine !== "ready" && runtime.engine !== "starting") return
  // A restart ends the engine's background work too, so it waits for that as it waits for a turn.
  if (isBusy(runtime.timeline) || runningCount(backgroundOf(threadId)) > 0) patchRuntime(threadId, { restartPending: true })
  else void restartEngine(threadId)
}

/** Browser use for the agent. The engine starts with the tools or without them, so it restarts. */
export function setBrowserUse(threadId: string, use: { readonly agent: boolean; readonly anySite: boolean }): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const browser = use.agent ? { agent: true as const, ...(use.anySite ? { anySite: true as const } : {}) } : undefined
  if (browser?.agent === thread.browser?.agent && browser?.anySite === thread.browser?.anySite) return
  patchThread(threadId, { browser })
  applyRestart(threadId)
}

/** Computer use for the agent. The engine starts with the tools or without them, so it restarts. */
export function setComputerUse(threadId: string, on: boolean): void {
  const thread = threadById(threadId)
  if (thread === undefined || (thread.computer === true) === on) return
  patchThread(threadId, { computer: on ? true : undefined })
  applyRestart(threadId)
}

export function setPermission(threadId: string, permission: PermissionPreset): void {
  patchThread(threadId, { permission })
  applyRestart(threadId)
}

/** Plan or a permission level, from the composer's one menu; restarts the engine once. */
export function setAccess(threadId: string, access: Access): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const next = withAccess({ mode: thread.mode, permission: thread.permission }, access)
  if (next.mode === thread.mode && next.permission === thread.permission) return
  patchThread(threadId, next)
  if (next.mode !== "goal") stopGoal(threadId)
  applyRestart(threadId)
}

export function setMode(threadId: string, mode: ThreadMode): void {
  const thread = threadById(threadId)
  if (thread === undefined || thread.mode === mode) return
  const needsRestart = (thread.mode === "plan") !== (mode === "plan")
  patchThread(threadId, { mode })
  if (mode !== "goal") stopGoal(threadId)
  if (needsRestart) applyRestart(threadId)
}

/**
 * Moves a thread to another model or coding tool in place. Between a connected model and a coding
 * tool the conversation does not carry over, so callers only do this while the thread is empty.
 */
export function setSelection(threadId: string, selection: Selection): void {
  const thread = threadById(threadId)
  if (thread === undefined) return
  const previousRun = runForThread(thread)
  const kept = carried(selection)
  if (thread.backend === selection.backend && thread.model === kept.model && thread.connectionId === kept.connectionId) return
  patchThread(threadId, { backend: selection.backend, model: kept.model, connectionId: kept.connectionId })
  noteModelSwitch(threadId, previousRun, { backend: selection.backend, ...kept })
  applyRestart(threadId)
}

export function renameThread(threadId: string, title: string): void {
  const trimmed = title.replace(/\s+/g, " ").trim().slice(0, 256)
  if (trimmed.length === 0) return
  patchThread(threadId, { title: trimmed, titled: true })
}

/** Removes the thread and deletes its engine storage. User-initiated only. */
export async function deleteThread(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  if (thread === undefined) return
  await stopEngine(threadId)
  await getHost().threadForget(threadId).catch(() => undefined)
  // A thread continued on another model shares its worktree; the last thread to go takes it along.
  const worktree = thread.worktree
  const shared = worktree !== undefined && get().threads.some((item) => item.id !== threadId && item.worktree?.id === worktree.id)
  if (worktree !== undefined && !shared) await projectRpc(thread.projectId, "worktree.remove", { id: worktree.id, force: true, deleteBranch: true }).catch(() => undefined)
  owners.delete(engineIdFor(threadId))
  forgetThread(threadId)
  forgetContext(threadId)
  set((state) => {
    const runtime = { ...state.runtime }
    delete runtime[threadId]
    const git = { ...state.git }
    delete git[threadId]
    const threads = state.threads.filter((item) => item.id !== threadId)
    const nextActive = state.layout.activeThreadId === threadId ? threads.find((item) => item.projectId === thread.projectId && item.archived !== true)?.id : state.layout.activeThreadId
    return { runtime, git, threads, layout: { ...state.layout, activeThreadId: nextActive } }
  })
}

/** The start failure strip's words: a deleted folder said plainly, anything else in the host's own words. */
export function startFailureText(code: string | undefined, message: string | undefined, worktree: boolean): string {
  if (code === "WORKSPACE_MISSING") return worktree ? "This thread's worktree folder was deleted, so its agent cannot start here. Archive the thread and start a new one." : "This project's folder was moved or deleted, so the agent cannot start."
  return `The agent could not start: ${message ?? code ?? "unknown error"}`
}

export async function archiveThread(threadId: string, archived: boolean): Promise<void> {
  patchThread(threadId, archived ? { archived, archivedAt: Date.now() } : { archived })
  if (archived) await stopEngine(threadId)
}

/**
 * Compacts the conversation the model reads. A coding tool's compaction shows in the timeline and
 * the ring, so only Runrail's own loop, which leaves no notice, says how it went.
 */
export async function compactThread(threadId: string): Promise<void> {
  if (runtimeOf(threadId).compacting === true) return
  patchRuntime(threadId, { compacting: true })
  try {
    const result = await threadRpc(threadId, "session.compact", { reason: "manual" })
    const removed = (result as { readonly removed?: unknown } | null)?.removed
    if (typeof removed === "number") toast(removed > 0 ? "success" : "info", removed > 0 ? "Context compacted" : "Nothing to compact yet")
  } catch (error) {
    toast("error", `Compaction failed: ${toHostError(error).message}`)
  } finally {
    patchRuntime(threadId, { compacting: false })
    const runtime = runtimeOf(threadId)
    if (!runtime.queuePaused && !shouldQueue(runtime)) dispatchNext(threadId)
  }
}

/**
 * Asks a running engine for the context reading now. It comes back as a live frame, so the ring
 * updates the usual way. An engine is never started for it.
 */
export function refreshThreadUsage(threadId: string): void {
  void readThreadUsage(threadId)
}

function readsUsage(threadId: string): boolean {
  const runtime = runtimeOf(threadId)
  return runtime.engine === "ready" && runtime.engineId !== undefined && hasCapability(runtime.contract, "session.usage")
}

async function readThreadUsage(threadId: string): Promise<void> {
  const engineId = runtimeOf(threadId).engineId
  if (!readsUsage(threadId) || engineId === undefined) return
  await getHost().rpc(engineId, "session.usage.read", {}).catch(() => undefined)
}

/** Derived status for lists: live runtime first, then the last status seen. */
export function threadStatus(thread: ThreadMeta, runtime: ThreadRuntime | undefined): ThreadStatus {
  if (runtime !== undefined) {
    if (pendingApprovals(runtime.timeline).length > 0) return "waiting"
    if (isBusy(runtime.timeline)) return "running"
    if (runtime.engine === "starting" || runtime.compacting === true) return "running"
    if (runtime.queue.length > 0 && !runtime.queuePaused) return "running"
  }
  return thread.lastStatus === "running" || thread.lastStatus === "waiting" ? "idle" : (thread.lastStatus ?? "idle")
}
