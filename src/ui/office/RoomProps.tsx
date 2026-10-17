import { memo, type ReactNode } from "react"
import type { Palette } from "../../app/persist"
import { plantPaths, type PlantArt } from "../seasonal"
import { hash } from "./looks"

/**
 * What hangs on a room's wall: a window, a shelf, a poster and a plant, picked from the
 * project's id so a room keeps the same wall everywhere. The window shows the night sky in the dark
 * theme and the day in the light one; office.css switches them. A flower palette puts its
 * season in the window and its flower in the pot, and Sakura hangs a lantern for the night.
 */

export interface WallProps {
  readonly window: boolean
  readonly shelf: boolean
  readonly poster: boolean
}

/** Every wall has a window or a poster, and some have both or a shelf too. */
export function wallProps(projectId: string): WallProps {
  const value = hash(projectId)
  const window = value % 4 !== 3
  return { window, shelf: (value >>> 3) % 2 === 1, poster: !window || (value >>> 5) % 3 === 0 }
}

type Cell = readonly [x: number, y: number, width: number, height: number, fill: string]

const cells = (list: readonly Cell[]): ReactNode => list.map(([x, y, width, height, fill]) => <rect key={`${String(x)}:${String(y)}:${fill}`} x={x} y={y} width={width} height={height} fill={fill} />)

/** The season through the glass, over the sky, 14 by 10 cells. */
const VIEWS: Readonly<Record<Palette, readonly Cell[]>> = {
  default: [],
  sakura: [
    [1, 6, 5, 1, "var(--px-sakura-bark)"],
    [5, 5, 3, 1, "var(--px-sakura-bark)"],
    [2, 5, 2, 1, "var(--px-sakura-bloom)"],
    [6, 4, 2, 1, "var(--px-sakura-bloom-mid)"],
    [4, 6, 1, 1, "var(--px-sakura-bloom-pale)"],
    [7, 5, 1, 1, "var(--px-sakura-bloom-pale)"],
    [8, 4, 1, 1, "var(--px-sakura-bloom)"],
  ],
  ume: [
    [2, 7, 7, 1, "var(--px-ume-branch)"],
    [7, 6, 1, 1, "var(--px-ume-branch)"],
    [8, 5, 1, 1, "var(--px-ume-branch)"],
    [3, 6, 1, 1, "var(--px-ume-bloom-deep)"],
    [6, 6, 1, 1, "var(--px-ume-bloom)"],
    [9, 4, 1, 1, "var(--px-ume-bloom-deep)"],
    [4, 2, 1, 1, "var(--px-snow)"],
    [10, 2, 1, 1, "var(--px-snow)"],
  ],
  fuji: [
    [1, 1, 12, 1, "var(--px-fuji-leaf)"],
    [2, 2, 1, 2, "var(--px-fuji-bloom-pale)"],
    [5, 2, 1, 3, "var(--px-fuji-bloom)"],
    [9, 2, 1, 2, "var(--px-fuji-bloom-pale)"],
    [11, 2, 1, 3, "var(--px-fuji-bloom)"],
  ],
  ajisai: [
    [2, 1, 1, 2, "var(--px-rain)"],
    [5, 3, 1, 2, "var(--px-rain)"],
    [8, 1, 1, 2, "var(--px-rain)"],
    [11, 4, 1, 2, "var(--px-rain)"],
    [3, 5, 1, 2, "var(--px-rain)"],
  ],
  tsubaki: [
    [2, 2, 1, 1, "var(--px-snow)"],
    [6, 1, 1, 1, "var(--px-snow)"],
    [10, 3, 1, 1, "var(--px-snow)"],
    [4, 4, 1, 1, "var(--px-snow)"],
    [1, 7, 12, 1, "var(--px-snow)"],
  ],
  matcha: [
    [3, 1, 1, 7, "var(--px-matcha-bamboo)"],
    [3, 3, 1, 1, "var(--px-matcha-bamboo-node)"],
    [7, 1, 1, 7, "var(--px-matcha-leaf)"],
    [7, 5, 1, 1, "var(--px-matcha-bamboo-node)"],
    [10, 1, 1, 7, "var(--px-matcha-bamboo)"],
    [4, 4, 2, 1, "var(--px-matcha-leaf)"],
    [8, 2, 2, 1, "var(--px-matcha-leaf)"],
  ],
}

/** Rain hides the sky's lights; snow clouds hide the sun but not the stars. */
function skyOf(palette: Palette): { readonly night: boolean; readonly day: boolean } {
  return { night: palette !== "ajisai", day: palette !== "ajisai" && palette !== "tsubaki" }
}

/** The plant in the wall's pot, 6 by 6 cells above it; the default palette keeps its green. */
const WALL_PLANTS: Readonly<Record<Palette, PlantArt>> = {
  default: {
    colors: { l: "var(--px-leaf)", d: "var(--px-leaf-dark)" },
    rows: ["..l...", "..lll.", "dddll.", "dddll.", ".dddd.", ".dddd."],
  },
  sakura: {
    colors: { p: "var(--px-sakura-bloom)", m: "var(--px-sakura-bloom-mid)", l: "var(--px-sakura-bloom-pale)", t: "var(--px-sakura-bark)" },
    rows: [".lppp.", "mmppp.", "mmm.ll", "..t.ll", "..tt..", "..t..."],
  },
  ume: {
    colors: { b: "var(--px-ume-branch)", r: "var(--px-ume-bloom)", d: "var(--px-ume-bloom-deep)" },
    rows: ["..r...", "d..r..", ".bb..d", "..bbb.", "..b...", "..b..."],
  },
  fuji: {
    colors: { g: "var(--px-fuji-leaf)", l: "var(--px-fuji-bloom-pale)", m: "var(--px-fuji-bloom)", d: "var(--px-fuji-bloom-deep)" },
    rows: [".ll...", ".llmm.", ".dgmm.", ".dg.l.", "..g.l.", "..g..."],
  },
  ajisai: {
    colors: { b: "var(--px-ajisai-bloom)", v: "var(--px-ajisai-bloom-violet)", l: "var(--px-ajisai-bloom-pale)", g: "var(--px-ajisai-leaf)" },
    rows: ["...vvv", "bbbvlv", "blbvvv", "bbbbb.", "ggbbb.", "gg..gg"],
  },
  tsubaki: {
    colors: { g: "var(--px-tsubaki-leaf)", h: "var(--px-tsubaki-leaf-dark)", r: "var(--px-tsubaki-bloom)", y: "var(--px-tsubaki-stamen)" },
    rows: [".gggg.", "ggggrg", "grrggg", "gryggg", "gggrrg", "ghgghg"],
  },
  matcha: {
    colors: { b: "var(--px-matcha-bamboo)", n: "var(--px-matcha-bamboo-node)", l: "var(--px-matcha-leaf)" },
    rows: [".b..l.", ".blnl.", ".n.nl.", ".b.nn.", ".b.nl.", ".b.nl."],
  },
}

export const RoomProps = memo(function RoomProps({ projectId, palette = "default" }: { readonly projectId: string; readonly palette?: Palette }) {
  const props = wallProps(projectId)
  const sky = skyOf(palette)
  return (
    <span className="room-props" aria-hidden>
      {palette === "sakura" && (
        <span className="room-lantern">
          <span className="room-lantern-cord" />
          <span className="room-lantern-light" />
        </span>
      )}
      {props.shelf && (
        <svg className="px-prop px-prop-shelf" viewBox="0 0 16 10" width="64" height="40">
          <rect x="0" y="9" width="16" height="1" className="px-wood" />
          <rect x="1" y="3" width="2" height="6" className="px-book-1" />
          <rect x="3" y="4" width="2" height="5" className="px-book-2" />
          <rect x="5" y="2" width="2" height="7" className="px-book-3" />
          <rect x="8" y="5" width="3" height="4" className="px-book-4" />
          <rect x="12" y="3" width="2" height="6" className="px-book-5" />
        </svg>
      )}
      {props.window && (
        <svg className="px-prop px-prop-window" viewBox="0 0 14 10" width="70" height="50" data-view={palette}>
          <rect x="0" y="0" width="14" height="9" className="px-glass" />
          <rect x="1" y="1" width="12" height="7" className="px-sky" />
          <rect x="1" y="5" width="12" height="3" className="px-sky-2" />
          {sky.night && (
            <g className="px-night">
              <rect x="3" y="2" width="1" height="1" className="px-star" />
              <rect x="9" y="3" width="1" height="1" className="px-star" />
              <rect x="11" y="1" width="1" height="1" className="px-star" />
            </g>
          )}
          {sky.day && (
            <g className="px-day">
              <rect x="10" y="2" width="2" height="2" className="px-star" />
              <rect x="2" y="3" width="4" height="1" className="px-cloud" />
              <rect x="3" y="2" width="2" height="1" className="px-cloud" />
            </g>
          )}
          {cells(VIEWS[palette])}
          <rect x="0" y="9" width="14" height="1" className="px-sill" />
        </svg>
      )}
      {props.poster && (
        <svg className="px-prop px-prop-poster" viewBox="0 0 9 11" width="36" height="44">
          <rect x="0" y="0" width="9" height="11" className="px-wood" />
          <rect x="1" y="1" width="7" height="9" className="px-poster" />
          <rect x="2" y="3" width="5" height="1" className="px-poster-ink" />
          <rect x="2" y="5" width="3" height="1" className="px-poster-ink" />
          <rect x="2" y="7" width="4" height="2" className="px-poster-card" />
        </svg>
      )}
      <svg className="px-prop" viewBox="0 0 6 10" width="30" height="50" data-plant={palette}>
        {plantPaths(WALL_PLANTS[palette]).map(([fill, d]) => (
          <path key={fill} fill={fill} d={d} />
        ))}
        <rect x="1" y="6" width="4" height="4" className="px-pot" />
        <rect x="0" y="6" width="6" height="1" className="px-pot-rim" />
      </svg>
    </span>
  )
})

/** Fuji's wisteria, hanging along the top of the wall in seven trusses, long and short by turns. */
export const Wisteria = memo(function Wisteria() {
  return (
    <span className="room-wisteria" aria-hidden>
      {Array.from({ length: 7 }, (_, index) => (
        <svg key={index} viewBox="0 0 5 9" width={index % 2 === 0 ? 15 : 12} height={index % 2 === 0 ? 27 : 22}>
          {cells([
            [0, 0, 5, 1, "var(--px-fuji-leaf)"],
            [0, 1, 5, 2, "var(--px-fuji-bloom-pale)"],
            [1, 3, 3, 2, "var(--px-fuji-bloom)"],
            [1, 5, 2, 2, "var(--px-fuji-bloom-pale)"],
            [2, 7, 1, 2, "var(--px-fuji-bloom-deep)"],
          ])}
        </svg>
      ))}
    </span>
  )
})
