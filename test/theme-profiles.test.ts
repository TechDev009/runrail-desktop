import { afterEach, describe, expect, test } from "bun:test"
import { parseState, type ThemeProfile } from "../src/app/persist"
import { get, persistedSlice, removeThemeProfile, saveThemeProfile, setActiveThemeProfile, setPrefs, set } from "../src/app/store"
import { CURATED_THEME_FILES, deriveThemeTokens, normalizeSeedColor, parseThemeFile, profileFromThemeFile, themeFileFor } from "../src/app/themeProfiles"

function profile(id: string, seedColor = "#6aa6ff"): ThemeProfile {
  return { id, name: "Theme " + id, palette: "default", seedColor, createdAt: 1, updatedAt: 1 }
}

afterEach(() => set({ themeProfiles: [], activeThemeProfileId: undefined }))

function channels(value: string): [number, number, number] {
  const hex = value.replace("#", "")
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number]
}

function luminance(value: string): number {
  const [r, g, b] = channels(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

function ratio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

describe("theme tokens", () => {
  test("any seed yields an accent that reads on the app background in both modes", () => {
    for (const seed of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#808080", "#6aa6ff", "#e07aff"]) {
      expect([seed, "dark", ratio(deriveThemeTokens(seed, true).accent, "#181818") >= 4.5]).toEqual([seed, "dark", true])
      expect([seed, "light", ratio(deriveThemeTokens(seed, false).accent, "#fafafa") >= 4.5]).toEqual([seed, "light", true])
    }
  })

  test("the label on the accent reads on it", () => {
    for (const seed of ["#000000", "#ffffff", "#ffcc00", "#3366ff"]) {
      for (const dark of [true, false]) {
        const tokens = deriveThemeTokens(seed, dark)
        expect(ratio(tokens.textOnAccent, tokens.accent)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("an invalid seed falls back to the default instead of throwing", () => {
    expect(deriveThemeTokens("not-a-color", true)).toEqual(deriveThemeTokens("#6aa6ff", true))
  })

  test("seed colors are six-digit hex only, lowercased", () => {
    expect(normalizeSeedColor(" #ABCDEF ")).toBe("#abcdef")
    for (const bad of ["#abc", "abcdef", "#abcdeg", "rgb(1,2,3)", "#abcdef00", ""]) expect(normalizeSeedColor(bad)).toBeUndefined()
  })
})

describe("theme files", () => {
  const good = { schemaVersion: 1, name: "Mine", basePalette: "fuji", seedColor: "#ABCDEF" }

  test("a valid file round-trips through a profile", () => {
    const file = parseThemeFile(good)!
    expect(file).toEqual({ schemaVersion: 1, name: "Mine", basePalette: "fuji", seedColor: "#abcdef" })
    const saved = profileFromThemeFile(file, 5)
    expect(themeFileFor(saved)).toEqual(file)
    expect(saved).toMatchObject({ createdAt: 5, updatedAt: 5, palette: "fuji" })
  })

  test("unknown keys, versions, palettes, colors, and long or empty names are refused", () => {
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, schemaVersion: 2 },
      { ...good, basePalette: "neon" },
      { ...good, seedColor: "red" },
      { ...good, name: "   " },
      { ...good, name: "x".repeat(65) },
      { name: "a" },
      [],
      null,
      "text",
    ]) expect(parseThemeFile(bad)).toBeUndefined()
  })

  test("every curated theme is a valid file", () => {
    for (const theme of CURATED_THEME_FILES) expect(parseThemeFile(theme)).toEqual(theme)
  })
})

describe("saved themes in state", () => {
  test("applying, deleting the active one, and ignoring an unknown id", () => {
    saveThemeProfile(profile("a"), true)
    saveThemeProfile(profile("b"))
    expect(get().activeThemeProfileId).toBe("a")
    setActiveThemeProfile("missing")
    expect(get().activeThemeProfileId).toBe("a")
    removeThemeProfile("b")
    expect(get().activeThemeProfileId).toBe("a")
    removeThemeProfile("a")
    expect(get().activeThemeProfileId).toBeUndefined()
    expect(get().themeProfiles).toEqual([])
  })

  test("picking a built-in palette or accent releases the saved theme", () => {
    saveThemeProfile(profile("a"), true)
    setPrefs({ density: "compact" })
    expect(get().activeThemeProfileId).toBe("a")
    setPrefs({ accent: "blue" })
    expect(get().activeThemeProfileId).toBeUndefined()
  })

  test("saved themes survive a save and load, and a bad active id is dropped", () => {
    saveThemeProfile(profile("a"), true)
    const saved = JSON.parse(JSON.stringify(persistedSlice(get())))
    expect(parseState(saved)).toMatchObject({ themeProfiles: [profile("a")], activeThemeProfileId: "a" })
    expect(parseState({ ...saved, activeThemeProfileId: "gone" }).activeThemeProfileId).toBeUndefined()
  })

  test("loading drops invalid and duplicate profiles and caps the list at 50", () => {
    const many = Array.from({ length: 60 }, (_, index) => profile("p" + String(index)))
    const parsed = parseState({ version: 1, themeProfiles: [profile("a"), profile("a"), { ...profile("b"), seedColor: "red" }, { ...profile("c"), palette: "neon" }, { ...profile("d"), name: " " }, ...many] }).themeProfiles
    expect(parsed.map((item) => item.id).slice(0, 2)).toEqual(["a", "p0"])
    // Only the first 50 saved entries are read, so junk ahead of valid ones can push them out.
    expect(parsed).toHaveLength(46)
    expect(parseState({ version: 1, themeProfiles: many }).themeProfiles).toHaveLength(50)
  })
})
