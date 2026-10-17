import { create } from "zustand"
import type { PersonTone } from "./personState"
import { get, openThread, set, setPrefs } from "./store"

/** Moving between the office floor and the thread list, and what the floor shows. */

export type OfficeFilter = "all" | PersonTone

export const useOfficeFilter = create<{ readonly filter: OfficeFilter }>()(() => ({ filter: "all" }))

export function setOfficeFilter(filter: OfficeFilter): void {
  useOfficeFilter.setState({ filter })
}

export function showOffice(): void {
  set({ view: { kind: "office" }, officeDrawer: false, settings: false })
  if (get().prefs.officeMode !== "office") setPrefs({ officeMode: "office" })
}

export function showList(): void {
  set({ view: { kind: "thread" }, officeDrawer: false })
  if (get().prefs.officeMode !== "list") setPrefs({ officeMode: "list" })
}

/** Turning office mode on opens the floor; turning it off leaves it for the thread list. */
export function setOfficeMode(on: boolean): void {
  setPrefs({ officeMode: on ? "office" : "off" })
  if (!on && get().view.kind === "office") set({ view: { kind: "thread" }, officeDrawer: false })
}

export function closeDrawer(): void {
  set({ officeDrawer: false })
}

/** The thread whose Peek card shows beside its person on the floor; the drawer replaces it. */
export const usePeek = create<{ readonly threadId: string | undefined }>()(() => ({ threadId: undefined }))

export function peekPerson(threadId: string): void {
  usePeek.setState({ threadId })
}

export function closePeek(): void {
  if (usePeek.getState().threadId !== undefined) usePeek.setState({ threadId: undefined })
}

/** The Peek card's "Open thread": the same thread in the drawer beside the floor. */
export function expandPeek(threadId: string): void {
  closePeek()
  openThread(threadId)
}

/**
 * A person pressed on the floor: their Peek card, or closes it when it is theirs. With the drawer
 * open the drawer shows them instead, or closes when it already does.
 */
export function openPerson(threadId: string): void {
  const state = get()
  if (state.view.kind === "office" && state.officeDrawer) {
    if (state.layout.activeThreadId === threadId) closeDrawer()
    else openThread(threadId)
    return
  }
  if (usePeek.getState().threadId === threadId) closePeek()
  else peekPerson(threadId)
}
