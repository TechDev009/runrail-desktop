import { create } from "zustand"
import type { BackendId } from "../host/types"

/**
 * The context window each model last reported, so a new thread shows its size before the first
 * answer. Window sizes are facts about a model; nothing about a thread is kept.
 */

const STORAGE_KEY = "runrail.context-windows"
const MAX_ENTRIES = 64
const MAX_WINDOW = 20_000_000

type Windows = Readonly<Record<string, number>>

export function windowKey(backend: BackendId | undefined, model: string | undefined): string {
  return `${backend ?? "native"}:${model ?? "default"}`
}

export function cleanWindows(value: unknown): Windows {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] => entry[0].length <= 200 && typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0 && entry[1] <= MAX_WINDOW,
  )
  return Object.fromEntries(entries.slice(-MAX_ENTRIES))
}

function load(): Windows {
  try {
    return cleanWindows(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))
  } catch {
    return {}
  }
}

export const useContextWindows = create<Windows>(() => (typeof localStorage === "undefined" ? {} : load()))

export function rememberWindow(key: string, tokens: number): void {
  const current = useContextWindows.getState()
  if (current[key] === tokens) return
  const { [key]: _previous, ...rest } = current
  const next = cleanWindows({ ...rest, [key]: tokens })
  useContextWindows.setState(next, true)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode or a full store: the window is learned again from the next answer.
  }
}
