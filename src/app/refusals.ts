import { useSyncExternalStore } from "react"
import type { Thinking } from "../host/types"

/**
 * Reasoning levels a connected model refused, as the engine reported them while the app runs. The
 * engine learns a refusal per level and sends the turn without one; the picker hides that level
 * for the model. Nothing here is stored: a new engine asks the model again.
 */

const MAX_MODELS = 256
const refused = new Map<string, readonly Thinking[]>()
const listeners = new Set<() => void>()
const NONE: readonly Thinking[] = Object.freeze([])

function keyOf(connectionId: string, model: string): string {
  return `${connectionId}\n${model}`
}

export function rememberRefusal(connectionId: string, model: string, thinking: Thinking): void {
  const key = keyOf(connectionId, model)
  const known = refused.get(key) ?? NONE
  if (known.includes(thinking)) return
  refused.delete(key)
  if (refused.size >= MAX_MODELS) {
    const oldest = refused.keys().next().value
    if (oldest !== undefined) refused.delete(oldest)
  }
  refused.set(key, Object.freeze([...known, thinking]))
  for (const listener of listeners) listener()
}

export function refusedLevels(connectionId: string | undefined, model: string | undefined): readonly Thinking[] {
  if (connectionId === undefined || model === undefined) return NONE
  return refused.get(keyOf(connectionId, model)) ?? NONE
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRefusedLevels(connectionId: string | undefined, model: string | undefined): readonly Thinking[] {
  const read = (): readonly Thinking[] => refusedLevels(connectionId, model)
  return useSyncExternalStore(subscribe, read, read)
}

/** For tests: forget every refusal. */
export function resetRefusals(): void {
  refused.clear()
  for (const listener of listeners) listener()
}
