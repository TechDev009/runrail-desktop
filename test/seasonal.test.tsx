import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { PALETTES } from "../src/app/persist"
import { EmptyState } from "../src/ui/common"
import { FloorPlant, FlowerMark, PLANTS, type Flower, type PlantArt } from "../src/ui/seasonal"

const STYLES = join(import.meta.dir, "../src/styles")
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8")
const OFFICE = readFileSync(join(STYLES, "office.css"), "utf8")
const THREAD = readFileSync(join(STYLES, "thread.css"), "utf8")
const FLOWERS = PALETTES.filter((palette): palette is Flower => palette !== "default")

/** The palette's own block, the one that holds what is the same in both themes. */
function paletteBlock(flower: Flower): string {
  return new RegExp(`:root\\[data-palette="${flower}"\\] \\{([^}]*)\\}`).exec(TOKENS)?.[1] ?? ""
}

/** The rows a rendered plant's paths cover, each cell the letter of its path's color. */
function redraw(html: string, art: PlantArt): string[] {
  const letters = new Map(Object.entries(art.colors).map(([letter, fill]) => [fill, letter]))
  const grid = Array.from({ length: 20 }, () => Array.from({ length: 16 }, () => "."))
  for (const [, fill, d] of html.matchAll(/<path fill="([^"]+)" d="([^"]+)"/g)) {
    for (const [, x, y, width] of d!.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let cell = Number(x); cell < Number(x) + Number(width); cell += 1) grid[Number(y)]![cell] = letters.get(fill!) ?? "?"
    }
  }
  return grid.map((row) => row.join(""))
}

/** Where a petal lies with the floor's clock at `beat`, as office.css moves it. */
function petalAt(rect: string, beat: number): readonly [number, number] {
  const x = Number(/ x="(\d+)"/.exec(rect)?.[1])
  const y = Number(/ y="(\d+)"/.exec(rect)?.[1])
  const fall = (beat + Number(/--petal:(\d+)/.exec(rect)?.[1])) % 8
  return [x + Math.floor(fall / 4), y + fall]
}

describe("a flower palette's plant on the office floor", () => {
  test("is 16 by 20 cells, each color a token of the palette's own block", () => {
    for (const flower of FLOWERS) {
      const art = PLANTS[flower]
      expect(art.rows).toHaveLength(20)
      for (const row of art.rows) expect(row).toHaveLength(16)
      expect([...new Set(art.rows.join("").replace(/\./g, ""))].sort()).toEqual(Object.keys(art.colors).sort())
      for (const color of Object.values(art.colors)) {
        const token = /^var\((--px-[a-z-]+)\)$/.exec(color)?.[1] ?? ""
        expect(token.startsWith(`--px-${flower}-`)).toBe(true)
        expect(paletteBlock(flower)).toContain(`${token}:`)
      }
    }
  })

  test("is drawn as one path a color covering exactly its cells, hidden from screen readers", () => {
    for (const flower of FLOWERS) {
      const html = renderToStaticMarkup(<FloorPlant flower={flower} />)
      expect(html).toContain('aria-hidden="true"')
      expect(html.match(/<path /g)).toHaveLength(Object.keys(PLANTS[flower].colors).length)
      expect(redraw(html, PLANTS[flower])).toEqual([...PLANTS[flower].rows])
    }
  })

  test("Sakura alone has petals; they rest where the design put them and fall below the canopy on the clock", () => {
    for (const flower of FLOWERS) expect(renderToStaticMarkup(<FloorPlant flower={flower} />).includes("px-petal")).toBe(flower === "sakura")
    const petals = renderToStaticMarkup(<FloorPlant flower="sakura" />).match(/<rect class="px-petal"[^>]*>/g) ?? []
    expect(petals.map((rect) => petalAt(rect, 0))).toEqual([
      [2, 9],
      [13, 11],
      [5, 13],
      [11, 15],
    ])
    for (const rect of petals) {
      const fallen = Array.from({ length: 8 }, (_, beat) => petalAt(rect, beat))
      expect(new Set(fallen.map(([, y]) => y)).size).toBe(8)
      for (const [x, y] of fallen) {
        expect(y).toBeGreaterThanOrEqual(9)
        expect(y).toBeLessThan(17)
        expect(x).toBeLessThan(16)
      }
    }
  })

  test("the petals move only with the floor's clock, which stops out of view, hidden, or with motion reduced", () => {
    const petal = /\.px-petal \{([^}]*)\}/.exec(OFFICE)?.[1] ?? ""
    expect(petal).toContain("--fall: mod(var(--beat-a, 0) + var(--beat-b, 0) + var(--beat-c, 0) + var(--petal), 8);")
    expect(petal).toContain("transform: translate(calc(round(down, var(--fall) / 4, 1) * 1px), calc(var(--fall) * 1px));")
    expect(OFFICE).not.toMatch(/px-petal[^{]*\{[^}]*animation/)
    for (const [bit, value] of [
      ["a", 1],
      ["b", 2],
      ["c", 4],
    ] as const) {
      expect(OFFICE).toContain(`.room[data-${bit}="1"] .room-plant {\n  --beat-${bit}: ${String(value)};\n}`)
      expect(OFFICE.split(`--beat-${bit}:`)).toHaveLength(2)
    }
  })
})

describe("a flower palette's mark on an empty thread", () => {
  test("each flower has its own faint line drawing, hidden from screen readers", () => {
    const marks = FLOWERS.map((flower) => renderToStaticMarkup(<FlowerMark flower={flower} />))
    for (const html of marks) {
      expect(html).toContain('class="flower-mark"')
      expect(html).toContain('aria-hidden="true"')
      expect((html.match(/<(path|circle|line|ellipse) /g) ?? []).length).toBeGreaterThanOrEqual(6)
      expect(html).not.toContain("NaN")
    }
    expect(new Set(marks).size).toBe(FLOWERS.length)
    const mark = /\.flower-mark \{([^}]*)\}/.exec(THREAD)?.[1] ?? ""
    expect(mark).toContain("stroke: var(--palette-accent);")
    expect(mark).toContain("fill: none;")
    expect(mark).toContain("opacity: 0.32;")
    expect(mark).toContain("pointer-events: none;")
  })

  test("takes the empty state's icon place, without the icon's box", () => {
    const withMark = renderToStaticMarkup(
      <EmptyState icon={<span>icon</span>} art={<FlowerMark flower="ume" />} title="No messages yet">
        Describe the change below.
      </EmptyState>,
    )
    expect(withMark).toContain("flower-mark")
    expect(withMark).not.toContain("empty-icon")
    expect(withMark.indexOf("flower-mark")).toBeLessThan(withMark.indexOf("No messages yet"))
    expect(renderToStaticMarkup(<EmptyState icon={<span>icon</span>} title="No messages yet" />)).toContain('<div class="empty-icon"><span>icon</span></div>')
  })
})
