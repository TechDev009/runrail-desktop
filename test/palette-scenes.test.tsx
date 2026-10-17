import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { PALETTES, type Palette } from "../src/app/persist"
import type { PersonState } from "../src/app/personState"
import { lookFor } from "../src/ui/office/looks"
import { PersonCard } from "../src/ui/office/Person"
import { RoomProps, wallProps, Wisteria } from "../src/ui/office/RoomProps"
import { weather, Weather } from "../src/ui/office/Weather"

const STYLES = join(import.meta.dir, "..", "src", "styles")
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8")
const OFFICE = readFileSync(join(STYLES, "office.css"), "utf8")
const FLOWERS = PALETTES.filter((palette) => palette !== "default")

/** The declarations of the rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf("\n}", start))
}

const windowed = Array.from({ length: 50 }, (_, index) => `room-${String(index)}`).find((id) => wallProps(id).window) ?? ""
const bunned = Array.from({ length: 200 }, (_, index) => `thread-${String(index)}`).find((id) => lookFor(id).style === "bun") ?? ""

function person(threadId: string, palette: Palette): string {
  const state: PersonState = { pose: "typing", label: "Editing", tone: "work", moving: true, helpers: 0 }
  const tag = { title: "Fix the build", unread: false, model: "Opus 5.5", worktree: false, pinned: false, background: 0 }
  return renderToStaticMarkup(<PersonCard threadId={threadId} project="shop" now={0} selected={false} filter="all" focusable onOpen={() => undefined} onKeyDown={() => undefined} person={state} tag={tag} palette={palette} />)
}

describe("each palette's office", () => {
  test("every flower palette dresses its people, pots its plant and colours its weather, and has its own sky by night and by day", () => {
    for (const flower of FLOWERS) {
      const base = block(TOKENS, `:root[data-palette="${flower}"]`)
      for (const token of ["--px-shirt-1", "--px-shirt-8", "--px-pot", "--px-pot-rim", "--px-acc-1", "--px-acc-2", "--fx-1", "--fx-2", "--fx-3"]) expect(base).toContain(`${token}:`)
      for (const theme of ["dark", "light"]) {
        const sky = block(TOKENS, `:root[data-theme="${theme}"][data-palette="${flower}"]`)
        for (const token of ["--px-sky", "--px-sky-2", "--px-star"]) expect(sky).toContain(`${token}:`)
      }
    }
    // By day a flower palette's wall is its own surface, not the default office's oak.
    expect(block(TOKENS, `:root[data-theme="light"][data-palette]:not([data-palette="default"])`)).toContain("--wall: var(--surface-3);")
  })

  test("the window shows the palette's season and the pot its flower; rain hides the sky's lights and snow clouds the sun", () => {
    const views = new Set<string>()
    for (const palette of PALETTES) {
      const html = renderToStaticMarkup(<RoomProps projectId={windowed} palette={palette} />)
      expect(html).toContain(`data-view="${palette}"`)
      expect(html).toContain(`data-plant="${palette}"`)
      views.add(/data-view="[a-z]+">(.*?)<\/svg>/.exec(html)?.[1] ?? "")
      expect(html.includes('class="px-night"')).toBe(palette !== "ajisai")
      expect(html.includes('class="px-day"')).toBe(palette !== "ajisai" && palette !== "tsubaki")
      expect(html.includes("room-lantern")).toBe(palette === "sakura")
    }
    expect(views.size).toBe(PALETTES.length)
    expect(renderToStaticMarkup(<Wisteria />).match(/<svg/g)).toHaveLength(7)
    // Sakura's lantern is for the night only.
    expect(OFFICE).toMatch(/:root\[data-theme="light"\] \.room-lantern \{\s*display: none;/)
  })

  test("each person wears the palette's one accessory, a hat or hood covers a bun, and the mug holds the palette's tea", () => {
    expect(person(bunned, "default")).not.toContain("px-acc")
    const accessories = new Set(FLOWERS.map((flower) => [...person(bunned, flower).matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" class="px-acc/g)].map((match) => match.slice(1).join(",")).join(" ")))
    expect(accessories.size).toBe(FLOWERS.length)
    const bun = '<rect x="11" y="0" width="2" height="1" fill="var(--px-hair'
    expect(person(bunned, "sakura")).toContain(bun)
    expect(person(bunned, "tsubaki")).not.toContain(bun)
    expect(person(bunned, "ajisai")).not.toContain(bun)
    expect(person(bunned, "matcha")).toContain("px-tea")
    expect(person(bunned, "matcha")).toContain("px-steam")
    expect(person(bunned, "default")).not.toContain("px-steam")
  })

  test("the weather is the palette's own, scattered by room, the same on every render, and inside the floor", () => {
    const kinds = (palette: Palette, id = "room-1"): string => [...new Set(weather(palette, id).map((flake) => flake.kind))].sort().join(",")
    expect(kinds("default")).toBe("rise")
    expect(kinds("sakura")).toBe("sway")
    expect(kinds("ume")).toBe("snow,sway")
    expect(kinds("ajisai")).toBe("rain")
    expect(kinds("tsubaki")).toBe("snow")
    expect(kinds("matcha")).toBe("leaf")
    for (const palette of PALETTES) {
      const flakes = weather(palette, "room-1")
      expect(flakes).toEqual(weather(palette, "room-1"))
      expect(flakes).not.toEqual(weather(palette, "room-2"))
      for (const flake of flakes) {
        expect(flake.left).toBeGreaterThanOrEqual(4)
        expect(flake.left).toBeLessThan(96)
        expect(flake.into).toBeLessThan(flake.seconds)
      }
    }
    // Ume's every third flake is snow.
    expect(weather("ume", "room-1").filter((flake) => flake.tone === "snow")).toHaveLength(4)
  })

  test("the weather is CSS only, takes no clicks, runs only on the room's clock, and is not drawn with reduced motion", () => {
    const html = renderToStaticMarkup(<Weather palette="sakura" projectId="room-1" />)
    expect(html).toStartWith('<span class="room-weather" aria-hidden="true">')
    expect(html).not.toContain("<script")
    expect(block(OFFICE, ".room-weather")).toContain("pointer-events: none;")
    expect(block(OFFICE, ".fx")).toContain("animation-play-state: paused;")
    // The room's clock beats only while it is in view, the window shows and motion is not reduced.
    expect(block(OFFICE, ".room[data-a] .fx")).toContain("animation-play-state: running;")
    expect(OFFICE).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.room-weather \{\s*display: none;/)
    // Names stay readable: the weather falls behind the name tags.
    expect(block(OFFICE, ".person-tag")).toContain("z-index: 1;")
    // Every animation in the office is the Peek card's opening or a flake's fall, and only flakes fall.
    expect([...OFFICE.matchAll(/@keyframes ([a-z-]+)/g)].map((match) => match[1]).sort()).toEqual(["fx-rain", "fx-rise", "fx-snow", "fx-sway", "peek-in"])
    const named = OFFICE.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .filter((rule) => rule.includes("animation-name:"))
      .map((rule) => (rule.split("{")[0] ?? "").trim())
    expect(named.length).toBeGreaterThan(3)
    for (const selector of named) expect(selector).toMatch(/^\.fx-[a-z]+(,\s*\.fx-[a-z]+(\.is-big)?)*$/)
  })
})
