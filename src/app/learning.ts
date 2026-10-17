import { create } from "zustand"
import { countsAsRead, lessonKey, type LessonLevel } from "./lessons"
import { MAX_LESSONS_READ, MAX_LESSONS_SEEN, type Learning } from "./persist"
import { recordGame } from "./play"
import { get, set } from "./store"

/** Learn mode's actions. History is persisted with the rest of desktop state; pins last a session. */

interface Pin {
  readonly threadId: string
  readonly anchor: string
}

/** Where each card showed this session, keyed by lesson key, so a card does not move once shown. */
export const useLessonPins = create<Readonly<Record<string, Pin>>>()(() => ({}))

export function pinsFor(pins: Readonly<Record<string, Pin>>, threadId: string): ReadonlyMap<string, string> {
  return new Map(Object.entries(pins).flatMap(([key, pin]) => (pin.threadId === threadId ? [[key, pin.anchor] as const] : [])))
}

function withSeen(learning: Learning, key: string): Learning {
  return learning.seen.includes(key) ? learning : { ...learning, seen: [...learning.seen, key].slice(-MAX_LESSONS_SEEN) }
}

function hasRead(learning: Learning, level: LessonLevel, id: string): boolean {
  return learning.read.some((entry) => entry.id === id && entry.level === level)
}

function withRead(learning: Learning, level: LessonLevel, id: string): Learning {
  if (hasRead(learning, level, id)) return learning
  return { ...learning, read: [...learning.read, { id, level, at: Date.now() }].slice(-MAX_LESSONS_READ) }
}

export function lessonShown(threadId: string, anchor: string, level: LessonLevel, id: string): void {
  const key = lessonKey(level, id)
  const pin = useLessonPins.getState()[key]
  if (pin?.threadId !== threadId || pin.anchor !== anchor) useLessonPins.setState({ [key]: { threadId, anchor } })
}

/** The card stayed in view long enough: it stays where it is and is not offered again at this level. */
export function lessonSeen(threadId: string, anchor: string, level: LessonLevel, id: string): void {
  const key = lessonKey(level, id)
  useLessonPins.setState({ [key]: { threadId, anchor } })
  set((state) => ({ learning: withSeen(state.learning, key) }))
}

export function lessonOpened(threadId: string, anchor: string, level: LessonLevel, id: string): void {
  const key = lessonKey(level, id)
  const fresh = !hasRead(get().learning, level, id)
  useLessonPins.setState({ [key]: { threadId, anchor } })
  set((state) => ({ learning: withRead(withSeen(state.learning, key), level, id) }))
  if (fresh) recordGame("lesson-read", threadId)
}

export function lessonDismissed(threadId: string, level: LessonLevel, id: string, inViewMs: number): void {
  const key = lessonKey(level, id)
  const read = countsAsRead("dismiss", inViewMs) && !hasRead(get().learning, level, id)
  set((state) => {
    const seen = withSeen(state.learning, key)
    return { learning: read ? withRead(seen, level, id) : seen }
  })
  useLessonPins.setState((pins) => Object.fromEntries(Object.entries(pins).filter(([pinned]) => pinned !== key)), true)
  if (read) recordGame("lesson-read", threadId)
}

/** Offers every lesson again; what was read stays in the history. */
export function resetLessons(): void {
  useLessonPins.setState({}, true)
  set((state) => ({ learning: { ...state.learning, seen: [] } }))
}
