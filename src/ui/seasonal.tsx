import { memo, type CSSProperties, type ReactNode } from "react"
import type { Palette } from "../app/persist"

/**
 * A flower palette's seasonal touch: a pixel plant at the end of each room's floor, and a
 * faint line drawing of its flower on a thread with nothing in it yet. The default palette has neither.
 */

export type Flower = Exclude<Palette, "default">

/** 16 by 20 cells, a letter a cell and "." for none; each letter's color is a token of the palette's own. */
export interface PlantArt {
  readonly colors: Readonly<Record<string, string>>
  readonly rows: readonly string[]
}

export const PLANTS: Readonly<Record<Flower, PlantArt>> = {
  sakura: {
    colors: {
      p: "var(--px-sakura-bloom)",
      m: "var(--px-sakura-bloom-mid)",
      d: "var(--px-sakura-bloom-deep)",
      l: "var(--px-sakura-bloom-pale)",
      t: "var(--px-sakura-bark)",
      k: "var(--px-sakura-bark-dark)",
      s: "var(--px-sakura-soil)",
      o: "var(--px-sakura-soil-dark)",
    },
    rows: [
      "................",
      ".......pp.......",
      ".....lmlmpp.....",
      "...pppdlmlmpppp.",
      "..lmppppdlmlmpp.",
      "..lmlmppppdlmlm.",
      "..pdpmpmppppdpm.",
      "..pppdpmpmpppp..",
      "..mppppdpmpmpp..",
      "...pmppppdpm....",
      "......tppp......",
      ".......tk.......",
      ".......tk.......",
      ".......tk.......",
      ".......tk.......",
      ".......tk.......",
      "......kkkk......",
      "....ssssssss....",
      ".....oooooo.....",
      "................",
    ],
  },
  ume: {
    colors: {
      b: "var(--px-ume-branch)",
      r: "var(--px-ume-bloom)",
      d: "var(--px-ume-bloom-deep)",
      y: "var(--px-ume-stamen)",
      v: "var(--px-ume-vase)",
      w: "var(--px-ume-vase-dark)",
      l: "var(--px-ume-vase-light)",
    },
    rows: [
      "................",
      "......r.........",
      ".....ryr........",
      "......r.....d...",
      "......b....dyd..",
      "....d..b....d...",
      "...dydb....b....",
      "..r.d.b..bb.....",
      ".ryr..b.b.br....",
      "..r.b..b..ryr...",
      ".....bbb...r....",
      ".......b...d....",
      ".......bbbdyd...",
      ".......b...d....",
      "......vvvv......",
      ".....lvvvvw.....",
      ".....lvvvvw.....",
      ".....lvvvvw.....",
      ".....lvvvvw.....",
      "......wwww......",
    ],
  },
  fuji: {
    colors: {
      w: "var(--px-fuji-trellis)",
      g: "var(--px-fuji-leaf)",
      d: "var(--px-fuji-bloom-deep)",
      m: "var(--px-fuji-bloom)",
      l: "var(--px-fuji-bloom-pale)",
      s: "var(--px-fuji-ground)",
    },
    rows: [
      "................",
      "wwwwwwwwwwwwwwww",
      "gw.g..g..g..g.wg",
      ".gddd.ddd.dddgw.",
      "..ddd.ddd.ddd...",
      "..ddd.ddd.ddd...",
      "..ddd.ddd.ddd...",
      "...mm.ddd..mm...",
      "..mm..mm..mm....",
      "...mm..mm..mm...",
      "..mm..mm...m....",
      "...m...mm..l....",
      "...l..mm...l....",
      "...l...m........",
      ".......l........",
      ".......l........",
      ".......l........",
      "................",
      "..ssssssssssss..",
      "................",
    ],
  },
  ajisai: {
    colors: {
      g: "var(--px-ajisai-leaf)",
      h: "var(--px-ajisai-leaf-dark)",
      b: "var(--px-ajisai-bloom)",
      v: "var(--px-ajisai-bloom-violet)",
      l: "var(--px-ajisai-bloom-pale)",
      p: "var(--px-ajisai-pot)",
      q: "var(--px-ajisai-pot-dark)",
    },
    rows: [
      "................",
      "................",
      "................",
      "................",
      ".....vl...bbv...",
      "...vlvbbbbvlvb..",
      "...vbbbbvlvbbb..",
      "...bbbvlvbbbbv..",
      "...bvlvbbbbvlv..",
      "...lvbbbbvlvbg..",
      "..hggbbvlvbbgg..",
      "..gghggvbbbgghg.",
      "..ghgghgbbgghg..",
      "...gghgghgghgg..",
      ".......hgg......",
      "....qqqqqqqq....",
      "....pppppppp....",
      "....pppppppp....",
      "....pppppppp....",
      ".....qqqqqq.....",
    ],
  },
  tsubaki: {
    colors: {
      g: "var(--px-tsubaki-leaf)",
      h: "var(--px-tsubaki-leaf-dark)",
      s: "var(--px-tsubaki-leaf-gloss)",
      r: "var(--px-tsubaki-bloom)",
      d: "var(--px-tsubaki-bloom-dark)",
      y: "var(--px-tsubaki-stamen)",
      o: "var(--px-tsubaki-ground)",
      k: "var(--px-tsubaki-ground-dark)",
    },
    rows: [
      "................",
      "................",
      "................",
      "................",
      "......shggg.....",
      ".....drdgghg....",
      "....gryrhsggg...",
      "...ggdrdggdrdg..",
      "...ghgggghryrg..",
      "...gggghsgdrdg..",
      "...ddhgggghgggg.",
      "..drrdgdrdgsghgg",
      ".hdrydhryrghgggg",
      ".ggddggdrdggggsg",
      ".ghgggghggsghggg",
      "..ggghs...hgggg.",
      "...hgg......g...",
      "...oooooooooo...",
      "..kkkkkkkkkkkk..",
      "................",
    ],
  },
  matcha: {
    colors: {
      b: "var(--px-matcha-bamboo)",
      n: "var(--px-matcha-bamboo-node)",
      l: "var(--px-matcha-leaf)",
      g: "var(--px-matcha-bowl)",
      r: "var(--px-matcha-bowl-rim)",
      f: "var(--px-matcha-tea)",
      w: "var(--px-matcha-whisk)",
      s: "var(--px-matcha-ground)",
    },
    rows: [
      "..b.b...........",
      "..b.b...l.......",
      "..b.b.ll........",
      "..n.nl..........",
      "l.b.bllll.......",
      "l.b.b...........",
      ".lb.b...........",
      "..n.n........w..",
      "..b.b........w..",
      "..b.b........w..",
      "..b.b........w..",
      "..n.n........w..",
      "..b.rfffffffwww.",
      "....ggggggggwww.",
      "....ggggggggwww.",
      "....ggggggggw.w.",
      ".....ggggggg....",
      ".......rrr......",
      ".ssssssssssssss.",
      "................",
    ],
  },
}

/** One path a color, each run of it along a row one rectangle, so a plant is a few elements. */
export function plantPaths(art: PlantArt): readonly (readonly [fill: string, d: string])[] {
  const runs = new Map<string, string>()
  art.rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const letter = row.charAt(x)
      let end = x + 1
      while (row.charAt(end) === letter) end += 1
      const width = String(end - x)
      if (letter !== ".") runs.set(letter, `${runs.get(letter) ?? ""}M${String(x)} ${String(y)}h${width}v1h-${width}z`)
      x = end
    }
  })
  return [...runs].map(([letter, d]) => [art.colors[letter] ?? "", d] as const)
}

/**
 * Sakura's petals: the column each starts from, under the canopy at row 9, and how many beats into
 * its fall it is when the floor's clock stops, so at rest they lie where the approved design put them.
 */
const PETAL_TOP = 9
const PETALS = [
  [2, 0],
  [13, 2],
  [4, 4],
  [10, 6],
] as const

/** The palette's plant, four screen pixels a cell. Petals come first so they slip out from under the canopy. */
export const FloorPlant = memo(function FloorPlant({ flower }: { readonly flower: Flower }) {
  return (
    <svg className="room-plant" viewBox="0 0 16 20" width="64" height="80" aria-hidden>
      {flower === "sakura" &&
        PETALS.map(([x, beat]) => <rect key={x} className="px-petal" x={x} y={PETAL_TOP} width="1" height="1" fill="var(--px-sakura-bloom)" style={{ "--petal": String(beat) } as CSSProperties} />)}
      {plantPaths(PLANTS[flower]).map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  )
})

const tenth = (value: number): number => Math.round(value * 10) / 10

/** `count` points evenly around the middle, `radius` out, the first `start` degrees clockwise from the top. */
function around(count: number, radius: number, start = 0): readonly (readonly [number, number])[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = ((start + (index * 360) / count) * Math.PI) / 180
    return [tenth(radius * Math.sin(angle)), tenth(-radius * Math.cos(angle))] as const
  })
}

const SAKURA_PETAL = "M0,-4 C-9,-12 -9,-26 -3,-31 L0,-27 L3,-31 C9,-26 9,-12 0,-4 Z"
const TEA_LEAF = "M0,-32 C18,-18 18,14 0,32 C-18,14 -18,-18 0,-32 Z"
const HYDRANGEA_FLORETS = [
  [0, -14],
  [-14, 2],
  [14, 2],
  [0, 16],
  [0, 2],
] as const

/** Line drawings on an 80 by 80 field centered on 0,0. */
const MARKS: Readonly<Record<Flower, ReactNode>> = {
  sakura: (
    <>
      {[0, 72, 144, 216, 288].map((angle) => (
        <path key={angle} d={SAKURA_PETAL} transform={`rotate(${String(angle)})`} />
      ))}
      <circle r="4" />
    </>
  ),
  ume: (
    <>
      {around(5, 17).map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r="12" />
      ))}
      {around(5, 9, 36).map(([x, y], index) => (
        <line key={index} x1="0" y1="0" x2={x} y2={y} />
      ))}
    </>
  ),
  fuji: (
    <>
      <path d="M-30,-34 Q0,-40 30,-34" />
      {[-16, 4].flatMap((left) =>
        Array.from({ length: 7 }, (_, index) => {
          const radius = 5.5 - index * 0.6
          return <ellipse key={`${String(left)}:${String(index)}`} cx={left + (index % 2) * 3} cy={-28 + index * 9} rx={tenth(radius)} ry={tenth(radius * 0.8)} />
        }),
      )}
    </>
  ),
  ajisai: (
    <>
      {HYDRANGEA_FLORETS.flatMap(([cx, cy]) => around(4, 5).map(([x, y]) => <circle key={`${String(cx + x)}:${String(cy + y)}`} cx={cx + x} cy={cy + y} r="4.2" />))}
    </>
  ),
  tsubaki: (
    <>
      {around(5, 14).map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r="15" />
      ))}
      <circle r="9" />
      {around(8, 6).map(([x, y], index) => (
        <line key={index} x1="0" y1="0" x2={x} y2={y} />
      ))}
    </>
  ),
  matcha: (
    <>
      <path d={TEA_LEAF} />
      <path d="M0,-28 L0,30" />
      {[-14, -5, 4, 13].map((y, index) => (
        <path key={y} d={`M0,${String(y)} L${index % 2 === 0 ? "-9" : "9"},${String(y - 8)}`} />
      ))}
    </>
  ),
}

/** The palette's flower as a faint line drawing in its own accent, for a thread with nothing in it yet. */
export function FlowerMark({ flower }: { readonly flower: Flower }) {
  return (
    <svg className="flower-mark" viewBox="-40 -40 80 80" width="88" height="88" aria-hidden>
      {MARKS[flower]}
    </svg>
  )
}
