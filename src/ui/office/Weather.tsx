import { memo, type CSSProperties } from "react"
import type { Palette } from "../../app/persist"
import { hash } from "./looks"

/**
 * A palette's weather over a room's floor: petals, plum and snow, wisteria, rain, snow,
 * tea leaves, and dust in the lamplight on the default palette's night. It is CSS only and takes no
 * clicks; office.css runs it only while the room's clock runs, so it stops off screen, in a hidden
 * window, and with reduced motion, where it is not drawn at all.
 */

export type FallKind = "sway" | "leaf" | "rain" | "snow" | "rise"

interface Fall {
  /** "mix" is Ume's: every third flake is snow and the rest are petals. */
  readonly kind: FallKind | "mix"
  readonly count: number
  /** How long one fall takes, shortest and longest, in seconds. */
  readonly seconds: readonly [number, number]
}

const FALLS: Readonly<Record<Palette, Fall>> = {
  default: { kind: "rise", count: 6, seconds: [9, 14] },
  sakura: { kind: "sway", count: 14, seconds: [8, 13] },
  ume: { kind: "mix", count: 14, seconds: [9, 14] },
  fuji: { kind: "sway", count: 11, seconds: [11, 16] },
  ajisai: { kind: "rain", count: 26, seconds: [1.1, 1.9] },
  tsubaki: { kind: "snow", count: 18, seconds: [9, 15] },
  matcha: { kind: "leaf", count: 8, seconds: [13, 18] },
}

export interface Flake {
  readonly kind: FallKind
  /** Which of the palette's weather colours, or Ume's snow. */
  readonly tone: 1 | 2 | 3 | "snow"
  readonly big: boolean
  /** Percent across the floor. */
  readonly left: number
  readonly seconds: number
  /** How far into its fall it starts, so the floor never begins empty. */
  readonly into: number
}

const tenth = (value: number): number => Math.round(value * 10) / 10

/** A scatter picked from the project's id, so each room's weather differs but never jumps between renders. */
export function weather(palette: Palette, projectId: string): readonly Flake[] {
  const fall = FALLS[palette]
  const room = hash(projectId) % 89
  const [shortest, longest] = fall.seconds
  return Array.from({ length: fall.count }, (_, index): Flake => {
    const seed = (index * 37 + room * 53) % 97
    const snow = fall.kind === "snow" || (fall.kind === "mix" && index % 3 === 2)
    const kind: FallKind = snow ? "snow" : fall.kind === "mix" ? "sway" : fall.kind
    const seconds = tenth(shortest + ((seed % 10) / 10) * (longest - shortest))
    return {
      kind,
      tone: fall.kind === "mix" && snow ? "snow" : (((index % 3) + 1) as 1 | 2 | 3),
      big: seed % 3 === 0,
      left: 4 + ((seed * 13) % 92),
      seconds,
      into: tenth(((seed % 17) / 17) * seconds),
    }
  })
}

export const Weather = memo(function Weather({ palette, projectId }: { readonly palette: Palette; readonly projectId: string }) {
  return (
    <span className="room-weather" aria-hidden>
      {weather(palette, projectId).map((flake, index) => (
        <span
          key={index}
          className={`fx fx-${flake.kind} fx-tone-${String(flake.tone)}${flake.big ? " is-big" : ""}`}
          style={{ "--fx-x": `${String(flake.left)}%`, "--fx-s": `${String(flake.seconds)}s`, "--fx-d": `-${String(flake.into)}s` } as CSSProperties}
        />
      ))}
    </span>
  )
})
