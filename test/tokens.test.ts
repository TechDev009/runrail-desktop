import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ACCENTS, PALETTES } from "../src/app/persist"

/**
 * The theme contract: raw colors, font sizes, and radii live only in styles/tokens.css, every
 * token a stylesheet asks for exists, and the text a person reads passes WCAG AA on every surface
 * in both themes and with every accent.
 */

const STYLES = join(import.meta.dir, "../src/styles")
const SOURCE = join(import.meta.dir, "../src")
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8")
const SHEETS = readdirSync(STYLES)
  .filter((name) => name.endsWith(".css") && name !== "tokens.css")
  .map((name) => ({ name, text: readFileSync(join(STYLES, name), "utf8") }))

/** Raw colors allowed in TypeScript, each with its reason. */
const TS_COLOR_ALLOWED = new Map([["lib/images.ts", "a pasted image with transparency is flattened onto white before it is sent"]])

function sourceFiles(dir: string, prefix = ""): { readonly name: string; readonly text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), name)
    return /\.(ts|tsx)$/.test(entry.name) ? [{ name, text: readFileSync(join(dir, entry.name), "utf8") }] : []
  })
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("tokens are the only place for raw values", () => {
  test("no stylesheet but tokens.css has a raw color", () => {
    const found = SHEETS.flatMap(({ name, text }) =>
      withoutComments(text)
        .split("\n")
        .map((line, index) => ({ line: line.trim(), at: `${name}:${String(index + 1)}` }))
        .filter(({ line }) => /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/.test(line))
        .map(({ at, line }) => `${at} ${line}`),
    )
    expect(found).toEqual([])
  })

  test("every padding, margin and gap is a step of the spacing scale", () => {
    const found = SHEETS.flatMap(({ name, text }) =>
      withoutComments(text)
        .replace(/\n\s+/g, " ")
        .split(/[;{}]/)
        .map((declaration) => declaration.trim())
        .filter((declaration) => /^(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?\s*:/.test(declaration))
        // Hairlines and zero are not steps; anything else in px must come from --sp-*.
        .filter((declaration) => /(?<![\w.-])\d+(\.\d+)?px\b/.test(declaration.replace(/(?<![\w.-])1px\b/g, "")))
        .map((declaration) => `${name} ${declaration}`),
    )
    expect(found).toEqual([])
  })

  test("no stylesheet but tokens.css has a raw font size or radius", () => {
    const found = SHEETS.flatMap(({ name, text }) =>
      withoutComments(text)
        .split("\n")
        .map((line, index) => ({ line: line.trim(), at: `${name}:${String(index + 1)}` }))
        .filter(({ line }) => {
          const size = /^font-size:\s*([^;]+);/.exec(line)?.[1]
          if (size !== undefined && /\d(px|rem|pt)\b/.test(size) && !size.includes("var(")) return true
          const radius = /^border(-[a-z]+)*-radius:\s*([^;]+);/.exec(line)?.[2]
          // Shapes, not sizes: none, a circle, or a value built from a token.
          return radius !== undefined && radius.split(/\s+(?![^(]*\))/).some((part) => part !== "0" && part !== "50%" && part !== "inherit" && !part.includes("var(--radius"))
        })
        .map(({ at, line }) => `${at} ${line}`),
    )
    expect(found).toEqual([])
  })

  test("no TypeScript file draws with a raw color", () => {
    const found = sourceFiles(SOURCE)
      .filter(({ name }) => !TS_COLOR_ALLOWED.has(name))
      .flatMap(({ name, text }) => (/["'`]#[0-9a-fA-F]{3,8}["'`]|["'`]rgba?\(/.test(text) ? [name] : []))
    expect(found).toEqual([])
  })

  test("every token a stylesheet or component asks for is defined", () => {
    const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!))
    // Custom properties a stylesheet sets for its own children.
    for (const { text } of SHEETS) for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]!)
    const used = new Set<string>()
    for (const { text } of [...SHEETS, { text: TOKENS }, ...sourceFiles(SOURCE)]) for (const match of text.matchAll(/var\((--[a-z0-9-]*[a-z0-9])\s*[,)]/g)) used.add(match[1]!)
    for (const match of readFileSync(join(SOURCE, "ui/inspector/TerminalPane.tsx"), "utf8").matchAll(/"(--(?:term|fs)-[a-z0-9-]+)"/g)) used.add(match[1]!)
    expect([...used].filter((name) => !defined.has(name)).sort()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Contrast

type Rgba = readonly [number, number, number, number]

interface Rule {
  readonly attrs: ReadonlyMap<string, string>
  readonly values: ReadonlyMap<string, string>
}

/** The `:root` rules of a stretch of CSS in source order, each with the attributes it asks for (`*`: any value). */
function rules(css: string): Rule[] {
  return [...css.matchAll(/(:root[^{]*)\{([^{}]*)\}/g)].map((match) => {
    const attrs = new Map([...match[1]!.matchAll(/\[data-([a-z-]+)(?:="([^"]*)")?\]/g)].map((attr) => [attr[1]!, attr[2] ?? "*"]))
    const values = new Map([...match[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((declaration) => [declaration[1]!, declaration[2]!.trim()]))
    return { attrs, values }
  })
}

const UNCOMMENTED = withoutComments(TOKENS)
// The high-contrast media query is an extra, not the baseline the contrast tests hold.
const BASELINE = rules(UNCOMMENTED.split("@media")[0]!)
const HIGH_CONTRAST = rules(/@media \(prefers-contrast: more\) \{([\s\S]*)\}\s*$/.exec(UNCOMMENTED)?.[1] ?? "")

/**
 * The tokens as the browser resolves them for these attributes: every matching rule, the more
 * attributes the more specific, and the later on a tie, as the cascade orders them.
 */
function scope(theme: "dark" | "light", accent: string, palette = "default", contrastMore = false): Map<string, string> {
  const on = new Map([["theme", theme], ["accent", accent], ["palette", palette]])
  const matching = [...BASELINE, ...(contrastMore ? HIGH_CONTRAST : [])]
    .map((rule, order) => ({ rule, order }))
    .filter(({ rule }) => [...rule.attrs].every(([name, value]) => on.has(name) && (value === "*" || on.get(name) === value)))
    .sort((a, b) => a.rule.attrs.size - b.rule.attrs.size || a.order - b.order)
  const merged = new Map<string, string>()
  for (const { rule } of matching) for (const [key, value] of rule.values) merged.set(key, value)
  return merged
}

function color(values: Map<string, string>, name: string, depth = 0): Rgba {
  const raw = values.get(name)
  if (raw === undefined || depth > 8) throw new Error(`token ${name} is not a color`)
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(raw)
  if (reference !== null) return color(values, reference[1]!, depth + 1)
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)
  if (hex !== null) return [0, 2, 4].map((at) => Number.parseInt(hex[1]!.slice(at, at + 2), 16)).concat(1) as unknown as Rgba
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(raw)
  if (rgba !== null) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])]
  throw new Error(`token ${name} has an unreadable color: ${raw}`)
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top[3]
  return [0, 1, 2].map((index) => top[index]! * alpha + bottom[index]! * (1 - alpha)).concat(1) as unknown as Rgba
}

function luminance([red, green, blue]: Rgba): number {
  const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrast(foreground: Rgba, background: Rgba): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (light! + 0.05) / (dark! + 0.05)
}

/** Pairs below `minimum`, as readable lines. */
function failures(values: Map<string, string>, foregrounds: readonly string[], backgrounds: readonly string[], minimum: number): string[] {
  return foregrounds.flatMap((foreground) =>
    backgrounds.flatMap((background) => {
      const base = color(values, background)
      const ratio = contrast(over(color(values, foreground), base), base)
      return ratio >= minimum ? [] : [`${foreground} on ${background}: ${ratio.toFixed(2)}`]
    }),
  )
}

const SURFACES = ["--bg", "--inset", "--surface", "--surface-2", "--surface-3", "--track", "--raised"]
const FLOWERS = PALETTES.filter((palette) => palette !== "default")
/** How far a flower palette's surface may lean to its hue: the spread of its red, green and blue. */
const TINT_BOUND = 24

describe("contrast (WCAG AA)", () => {
  for (const palette of PALETTES) {
    for (const theme of ["dark", "light"] as const) {
      const name = `${palette}, ${theme}`
      test(`${name}: the first three text tiers read on every surface`, () => {
        expect(failures(scope(theme, "mono", palette), ["--text", "--text-2", "--text-3"], SURFACES, 4.5)).toEqual([])
      })

      test(`${name}: status colors read as text on the content surfaces`, () => {
        expect(failures(scope(theme, "mono", palette), ["--blue", "--green", "--red", "--amber", "--purple", "--brand-claude"], ["--surface", "--surface-2"], 4.5)).toEqual([])
      })

      test(`${name}: a usage tile's color mark stands out from its tile, 3:1 for a graphic`, () => {
        const values = scope(theme, "mono", palette)
        const tile = over(color(values, "--segment-track"), color(values, "--surface-2"))
        const weak = ["--blue", "--purple", "--amber", "--green"].filter((token) => contrast(over(color(values, token), tile), tile) < 3)
        expect(weak).toEqual([])
      })

      test(`${name}: code and the terminal read on their backgrounds`, () => {
        const values = scope(theme, "mono", palette)
        const syntax = [...values.keys()].filter((token) => token.startsWith("--syn-token-") || token === "--syn-foreground")
        expect(failures(values, syntax, ["--inset", "--surface"], 4.5)).toEqual([])
        expect(failures(values, ["--term-fg", "--term-red", "--term-green", "--term-yellow", "--term-blue", "--term-magenta", "--term-cyan"], ["--term-bg"], 4.5)).toEqual([])
      })

      test(`${name}: with every accent, a label on the accent, the accent as text, and the focus ring`, () => {
        const found = ACCENTS.flatMap((accent) => {
          const values = scope(theme, accent, palette)
          return [
            ...failures(values, ["--text-on-accent"], ["--accent", "--accent-hover"], 4.5),
            ...failures(values, ["--accent", "--link"], ["--surface", "--surface-2"], 4.5),
            // A focus ring is a user-interface part: 3:1.
            ...failures(values, ["--focus"], SURFACES, 3),
          ].map((line) => `${accent}: ${line}`)
        })
        expect(found).toEqual([])
      })

      test(`${name}: high contrast reaches it, lines and the second and third text tiers`, () => {
        const plain = scope(theme, "mono", palette)
        const more = scope(theme, "mono", palette, true)
        const white = theme === "dark" ? "255, 255, 255" : "0, 0, 0"
        for (const token of ["--border", "--border-strong", "--text-2", "--text-3"]) {
          expect([token, more.get(token)?.startsWith(`rgba(${white},`)]).toEqual([token, true])
          expect([token, more.get(token) !== plain.get(token)]).toEqual([token, true])
        }
      })
    }
  }

  test("the default palette's surfaces have no hue", () => {
    for (const theme of ["dark", "light"] as const) {
      const values = scope(theme, "mono")
      for (const token of [...SURFACES, "--text", "--border", "--border-strong", "--border-subtle"]) {
        const [red, green, blue] = color(values, token)
        expect([theme, token, red === green && green === blue]).toEqual([theme, token, true])
      }
    }
  })

  test("a flower palette tints its surfaces and text only faintly", () => {
    const found = FLOWERS.flatMap((palette) =>
      (["dark", "light"] as const).flatMap((theme) => {
        const values = scope(theme, "mono", palette)
        return [...SURFACES, "--text"].flatMap((token) => {
          const [red, green, blue] = color(values, token)
          const spread = Math.max(red, green, blue) - Math.min(red, green, blue)
          return spread <= TINT_BOUND && spread > 0 ? [] : [`${palette} ${theme} ${token}: ${String(spread)}`]
        })
      }),
    )
    expect(found).toEqual([])
  })

  test("every palette and accent has its block, and the cards their colors", () => {
    for (const palette of FLOWERS) for (const theme of ["dark", "light"]) expect(TOKENS).toContain(`:root[data-theme="${theme}"][data-palette="${palette}"] {`)
    for (const accent of ACCENTS.filter((accent) => accent !== "mono" && accent !== "theme")) expect([accent, TOKENS.includes(`:root[data-accent="${accent}"] {`) && TOKENS.includes(`:root[data-theme="light"][data-accent="${accent}"] {`)]).toEqual([accent, true])
    for (const palette of PALETTES) for (const part of ["bg", "side", "line", "accent"]) for (const theme of ["dark", "light"]) expect(TOKENS).toContain(`--pv-${palette}-${theme}-${part}:`)
  })
})
