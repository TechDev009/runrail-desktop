/**
 * Each thread's person keeps one look for life, picked from its id: skin, hair, shirt, and hair
 * style. The colors are tokens, so they live with every other color in styles/tokens.css.
 */

const SKINS = ["var(--px-skin-1)", "var(--px-skin-2)", "var(--px-skin-3)", "var(--px-skin-4)", "var(--px-skin-5)", "var(--px-skin-6)"] as const
const HAIRS = ["var(--px-hair-1)", "var(--px-hair-2)", "var(--px-hair-3)", "var(--px-hair-4)", "var(--px-hair-5)", "var(--px-hair-6)", "var(--px-hair-7)"] as const
const SHIRTS = ["var(--px-shirt-1)", "var(--px-shirt-2)", "var(--px-shirt-3)", "var(--px-shirt-4)", "var(--px-shirt-5)", "var(--px-shirt-6)", "var(--px-shirt-7)", "var(--px-shirt-8)"] as const
const STYLES = ["short", "long", "bun"] as const

export type HairStyle = (typeof STYLES)[number]

export interface Look {
  readonly skin: string
  readonly hair: string
  readonly shirt: string
  readonly style: HairStyle
}

/** FNV-1a: stable across runs and machines, so a person looks the same everywhere. */
export function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

export function lookFor(id: string): Look {
  const value = hash(id)
  return {
    skin: SKINS[value % SKINS.length] ?? SKINS[0],
    hair: HAIRS[(value >>> 4) % HAIRS.length] ?? HAIRS[0],
    shirt: SHIRTS[(value >>> 8) % SHIRTS.length] ?? SHIRTS[0],
    style: STYLES[(value >>> 12) % STYLES.length] ?? STYLES[0],
  }
}

/** Helpers alternate between two skins so a row of them reads as several people. */
export const HELPER_SKINS = [SKINS[0], SKINS[3]] as const
