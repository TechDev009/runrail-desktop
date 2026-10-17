import { create } from "zustand"

/**
 * Responsive artboards: one browser tab's page laid out at phone, tablet, and
 * desktop widths side by side, each scaled down to fit. Each artboard is a preview of its own, so
 * the person can comment on any and the agent can look at any. Shown in memory only.
 */

export type ArtboardId = "phone" | "tablet" | "desktop"

export interface Artboard {
  readonly id: ArtboardId
  readonly label: string
  /** The width the page lays out at, and a screen's height for it, in CSS pixels. */
  readonly width: number
  readonly height: number
}

export const ARTBOARDS: readonly Artboard[] = [
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "tablet", label: "Tablet", width: 820, height: 1180 },
  { id: "desktop", label: "Desktop", width: 1280, height: 800 },
]

/** Room above each artboard for its name and buttons, and between artboards. */
export const ARTBOARD_HEAD = 28
export const ARTBOARD_GAP = 12
/** Below this the host does not scale a page down. */
const MIN_SCALE = 0.1

/** Which browser tabs show their artboards. */
export const useArtboards = create<Readonly<Record<string, true>>>()(() => ({}))

export function setArtboards(tab: string, on: boolean): void {
  useArtboards.setState((state) => {
    const next = { ...state }
    if (on) next[tab] = true
    else delete next[tab]
    return next
  }, true)
}

/** An artboard's own preview tab: the browser tab's id with the artboard's after a dot. */
export function artboardTab(tab: string, id: ArtboardId): string {
  return `${tab}.${id}`
}

/** The browser tab and artboard a preview tab stands for, when it is an artboard. */
export function artboardOf(previewTab: string): { readonly tab: string; readonly artboard: Artboard } | undefined {
  const dot = previewTab.lastIndexOf(".")
  if (dot <= 0) return undefined
  const artboard = ARTBOARDS.find((entry) => entry.id === previewTab.slice(dot + 1))
  return artboard === undefined ? undefined : { tab: previewTab.slice(0, dot), artboard }
}

export interface ArtboardPlace {
  readonly artboard: Artboard
  /** Where the page goes, relative to the area's top left, in points. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * One scale for every artboard, the largest at which all fit side by side in the area, never above
 * 1; each page keeps its own width because the host zooms it by that scale.
 */
export function artboardLayout(area: { readonly width: number; readonly height: number }): { readonly scale: number; readonly places: readonly ArtboardPlace[] } {
  const wide = ARTBOARDS.reduce((sum, artboard) => sum + artboard.width, 0)
  const tall = Math.max(...ARTBOARDS.map((artboard) => artboard.height))
  const room = area.width - ARTBOARD_GAP * (ARTBOARDS.length - 1)
  const scale = Math.max(MIN_SCALE, Math.min(1, room / wide, (area.height - ARTBOARD_HEAD) / tall))
  const used = wide * scale + ARTBOARD_GAP * (ARTBOARDS.length - 1)
  let x = Math.max(0, (area.width - used) / 2)
  const places = ARTBOARDS.map((artboard) => {
    const place = { artboard, x: Math.round(x), y: ARTBOARD_HEAD, width: Math.max(1, Math.round(artboard.width * scale)), height: Math.max(1, Math.round(artboard.height * scale)) }
    x += artboard.width * scale + ARTBOARD_GAP
    return place
  })
  return { scale, places }
}
