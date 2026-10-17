import { create } from "zustand"
import { z } from "zod"
import { LiveFrameSchema } from "../protocol/schemas"
import { onConnectionsChanged, systemCapability, systemRpc } from "./connections"
import { detectTools, knownTools, listConnectionSettings, type ToolConnection } from "./connectionSettings"
import { currentLimits, forgetPlanAccounts, forgetPlanReading, planAccount, planSourceOf, notePlanReading, usePlanLimits, type PlanAccount, type PlanFrame, type PlanSource } from "./limits"
import type { ToolProxy } from "./picker"
import { get, setPrefs, useApp } from "./store"

/**
 * Plan usage read by the system engine with no thread running (`usage.read`): every account a
 * little after start, then on Refresh. The engine starts the tool as that account, asks, and
 * closes it, one tool at a time. None of it happens until the person turns plan limits on.
 */

/** A reading this fresh is not asked for again. */
export const USAGE_REFRESH_MS = 60_000
const SOURCES: readonly PlanSource[] = ["claude-code", "codex"]

/** Connection labels by id, so a footer line names an account signed in from a folder of its own. */
export const useAccountLabels = create<Readonly<Record<string, string>>>(() => labelsOf(knownTools() ?? []))

/** The proxy each tool's usual login sends its requests through, as its own settings say. */
export const useToolProxies = create<Readonly<Partial<Record<PlanSource, ToolProxy>>>>(() => ({}))

export const useUsageAccounts = create<{ readonly accounts: readonly PlanAccount[] }>(() => ({ accounts: [] }))
export const useUsageSignIns = create<Readonly<Record<string, string>>>(() => ({}))
const UsageIdentitySchema = z.object({ account: z.object({ label: z.string().min(1).max(254).regex(/^[^\u0000-\u001f\u007f]+$/) }).optional() })
let accountRevision = 0

function forgetCodexReading(account: PlanAccount): void {
  if (account.source !== "codex") return
  forgetPlanReading(account.key)
  useUsageSignIns.setState((state) => Object.fromEntries(Object.entries(state).filter(([key]) => key !== account.key)), true)
  readAt.delete(account.key)
}

function labelsOf(tools: readonly ToolConnection[]): Record<string, string> {
  return Object.fromEntries(tools.map((tool) => [tool.id, tool.label]))
}

/** What the latest list of connections says: their names, and which readings to drop. */
function noteConnections(tools: readonly ToolConnection[]): void {
  useAccountLabels.setState(labelsOf(tools), true)
  forgetPlanAccounts((connectionId) => tools.some((connection) => connection.id === connectionId && ownAccount(connection) !== undefined))
}

const readAt = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()
let supported: Promise<boolean> | undefined

/** A reading starts the tool signed in as the person, so only after a yes. Claude Code's needs the Agent SDK, which the person installs separately. */
export function planLimitsOn(): boolean {
  return get().prefs.planLimits === "on"
}

/** Whether anything about plan limits shows: nothing while they are off or not asked about yet. */
export function usePlanLimitsOn(): boolean {
  return useApp((state) => state.prefs.planLimits === "on")
}

/** Whether the system engine reads usage; an engine from before it is not asked. */
export function usageReadOffered(): Promise<boolean> {
  supported ??= systemCapability("usage.read").catch(() => false).then((offered) => {
    if (!offered) supported = undefined
    return offered
  })
  return supported
}

/** When the account last returned a valid reading. */
export function lastUsageRead(key: string): number | undefined {
  return readAt.get(key)
}

function planOf(answer: unknown, source: PlanSource): PlanFrame | undefined {
  const plan = (answer as { readonly plan?: unknown } | null)?.plan
  if (plan === null || typeof plan !== "object") return undefined
  const parsed = LiveFrameSchema.safeParse({ ...plan, liveSeq: 0 })
  return parsed.success && parsed.data.type === "plan.limits" && parsed.data.source === source ? parsed.data : undefined
}

/** Codex failures clear its quota because the profile may have changed sign-ins. */
export function readAccountUsage(account: PlanAccount, maxAgeMs = USAGE_REFRESH_MS): Promise<void> {
  if (!planLimitsOn()) return Promise.resolve()
  const running = inFlight.get(account.key)
  if (running !== undefined) return running
  const last = readAt.get(account.key)
  if (last !== undefined && Date.now() - last < maxAgeMs) return Promise.resolve()
  const revision = accountRevision
  const read = (async () => {
    try {
      if (!(await usageReadOffered()) || !planLimitsOn()) return
      const answer = await systemRpc("usage.read", { tool: account.source, ...(maxAgeMs === 0 ? { refresh: true } : {}), ...(account.connectionId === undefined ? {} : { connectionId: account.connectionId }) })
      if (revision !== accountRevision) return
      const frame = planOf(answer, account.source)
      if (frame !== undefined && frame.windows.length > 0) {
        const identity = UsageIdentitySchema.safeParse(answer)
        useUsageSignIns.setState((state) => {
          const rest = Object.fromEntries(Object.entries(state).filter(([key]) => key !== account.key))
          return identity.success && identity.data.account !== undefined ? { ...rest, [account.key]: identity.data.account.label } : rest
        }, true)
        notePlanReading(account, frame)
        readAt.set(account.key, Date.now())
      } else forgetCodexReading(account)
    } catch {
      // Not installed, signed out, or on a plan with no limits to report: nothing to show yet.
      if (revision === accountRevision) forgetCodexReading(account)
    } finally {
      if (revision === accountRevision) inFlight.delete(account.key)
    }
  })()
  inFlight.set(account.key, read)
  return read
}

/** A connection that signs in from a folder of its own, on a plan rather than a key. */
function ownAccount(connection: ToolConnection): PlanAccount | undefined {
  const source = planSourceOf(connection.tool)
  return source === undefined || !connection.separateAccount ? undefined : planAccount(source, connection)
}

/**
 * The accounts worth asking: each installed tool's usual login unless it is signed out, and each
 * enabled connection on a folder of its own. Readings of connections that are gone are dropped.
 */
export async function usageAccounts(refresh = false): Promise<readonly PlanAccount[]> {
  const revision = accountRevision
  const [tools, listing] = await Promise.all([detectTools(refresh), listConnectionSettings().catch(() => undefined)])
  if (revision !== accountRevision) return []
  useToolProxies.setState(Object.fromEntries(SOURCES.flatMap((source) => {
    const proxy = tools.find((entry) => entry.id === source)?.proxy
    return proxy === undefined ? [] : [[source, proxy]]
  })), true)
  const usual = SOURCES.filter((source) => {
    const tool = tools.find((entry) => entry.id === source)
    return tool?.available === true && tool.signedIn !== false
  }).map((source): PlanAccount => ({ key: source, source }))
  if (listing !== undefined) noteConnections(listing.tools)
  const own = (listing?.tools ?? []).flatMap((connection) => {
    const account = connection.enabled ? ownAccount(connection) : undefined
    return account === undefined ? [] : [account]
  })
  const accounts = [...usual, ...own]
  for (const key of Object.keys(usePlanLimits.getState())) {
    if ((key === "codex" || key.startsWith("codex:")) && !accounts.some((account) => account.key === key)) forgetCodexReading({ key, source: "codex" })
  }
  useUsageAccounts.setState({ accounts })
  return accounts
}

/** Every account, one after another, so no two tools start at once. */
export async function readAllPlanUsage(maxAgeMs = USAGE_REFRESH_MS): Promise<void> {
  if (!planLimitsOn()) return
  const accounts = await usageAccounts(maxAgeMs === 0)
  if (!(await usageReadOffered())) return
  for (const account of accounts) await readAccountUsage(account, maxAgeMs)
}

let watching: (() => void) | undefined
let stopFocus: (() => void) | undefined
let startupTimer: number | undefined
let generation = 0

/** A little after start, once the window is usable; a removed connection's reading goes with it. */
export function initPlanUsage(delayMs = 2_000): () => void {
  if (!planLimitsOn()) {
    stopPlanUsage()
    clearPlanReadings()
    return () => undefined
  }
  const current = ++generation
  if (startupTimer !== undefined) window.clearTimeout(startupTimer)
  watching?.()
  stopFocus?.()
  watching = onConnectionsChanged(() => {
    accountRevision += 1
    readAt.clear()
    inFlight.clear()
    for (const account of useUsageAccounts.getState().accounts) forgetCodexReading(account)
    supported = undefined
    void readAllPlanUsage(0).catch(() => undefined)
  })
  const refreshCodex = (): void => {
    void usageAccounts(true).then(async (accounts) => {
      if (current !== generation) return
      for (const account of accounts) if (account.source === "codex") await readAccountUsage(account, 0)
    }).catch(() => undefined)
  }
  window.addEventListener("focus", refreshCodex)
  stopFocus = () => window.removeEventListener("focus", refreshCodex)
  const read = async (attempt: number): Promise<void> => {
    await readAllPlanUsage(0).catch(() => undefined)
    if (current !== generation || attempt >= 2) return
    const accounts = useUsageAccounts.getState().accounts
    const incomplete = accounts.length === 0 || accounts.some((account) => {
      const limits = currentLimits(usePlanLimits.getState()[account.key], Date.now())
      return limits === undefined || (account.source === "claude-code" && !limits.windows.some((window) => window.id === "five-hour"))
    })
    if (incomplete) startupTimer = window.setTimeout(() => read(attempt + 1), attempt === 0 ? 10_000 : 30_000)
  }
  startupTimer = window.setTimeout(() => read(0), delayMs)
  return () => {
    window.removeEventListener("focus", refreshCodex)
    if (current === generation) stopPlanUsage()
  }
}

function stopPlanUsage(): void {
  generation += 1
  accountRevision += 1
  inFlight.clear()
  if (startupTimer !== undefined) window.clearTimeout(startupTimer)
  startupTimer = undefined
  stopFocus?.()
  stopFocus = undefined
  watching?.()
  watching = undefined
}

/** The rings go, and Claude Code's readings saved for the next start with them. */
function clearPlanReadings(): void {
  for (const key of Object.keys(usePlanLimits.getState())) forgetPlanReading(key)
  readAt.clear()
  useUsageAccounts.setState({ accounts: [] })
  useUsageSignIns.setState({}, true)
}

/**
 * The person's answer, from onboarding or Settings. On reads every account now, then at each start
 * and on Refresh; off stops reading and drops what was read.
 */
export function setPlanLimits(on: boolean): void {
  setPrefs({ planLimits: on ? "on" : "off" })
  if (on) initPlanUsage(0)
  else {
    stopPlanUsage()
    clearPlanReadings()
  }
}

/** Test seam: forgets when accounts were read, and whether the engine reads usage unless `reads` says. */
export function resetPlanUsage(reads?: boolean): void {
  accountRevision += 1
  readAt.clear()
  inFlight.clear()
  supported = reads === undefined ? undefined : Promise.resolve(reads)
  useUsageAccounts.setState({ accounts: [] })
  useUsageSignIns.setState({}, true)
}
