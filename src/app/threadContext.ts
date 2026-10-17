import type { ContextUsage } from "../thread/reducer"

/**
 * Each thread's latest context reading. The engine sends it only as a live frame, which a window
 * reload skips and an engine restart loses, so the last one is kept until the next one arrives.
 */

const STORAGE_KEY = "runrail.thread-context"
const MAX_ENTRIES = 200
const MAX_TOKENS = 20_000_000

type Readings = Readonly<Record<string, ContextUsage>>

function tokenCount(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= MAX_TOKENS
}

export function cleanReadings(value: unknown): Readings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([threadId, entry]): [string, ContextUsage][] => {
    if (threadId.length > 200 || entry === null || typeof entry !== "object") return []
    const { usedTokens, windowTokens, autoCompactAt, estimated } = entry as Record<string, unknown>
    if (!tokenCount(usedTokens, 0) || (windowTokens !== undefined && !tokenCount(windowTokens, 1))) return []
    const point = tokenCount(autoCompactAt, 1) ? autoCompactAt : undefined
    return [[threadId, { usedTokens, ...(windowTokens === undefined ? {} : { windowTokens }), ...(point === undefined ? {} : { autoCompactAt: point }), estimated: estimated === true }]]
  })
  return Object.fromEntries(entries.slice(-MAX_ENTRIES))
}

function load(): Readings {
  try {
    return cleanReadings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))
  } catch {
    return {}
  }
}

let readings: Readings = typeof localStorage === "undefined" ? {} : load()

function save(next: Readings): void {
  readings = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode or a full store: the reading comes back with the thread's next answer.
  }
}

export function rememberedContext(threadId: string): ContextUsage | undefined {
  return readings[threadId]
}

export function rememberContext(threadId: string, usage: ContextUsage): void {
  const current = readings[threadId]
  if (current?.usedTokens === usage.usedTokens && current.windowTokens === usage.windowTokens && current.autoCompactAt === usage.autoCompactAt && current.estimated === usage.estimated) return
  const { [threadId]: _previous, ...rest } = readings
  save(cleanReadings({ ...rest, [threadId]: usage }))
}

export function forgetContext(threadId: string): void {
  if (readings[threadId] === undefined) return
  const { [threadId]: _previous, ...rest } = readings
  save(rest)
}
