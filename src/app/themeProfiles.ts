import { newId, type Palette, type ThemeProfile } from "./persist"

export interface ThemeTokens {
  readonly accent: string
  readonly accentHover: string
  readonly accentSoft: string
  readonly accentLine: string
  readonly textOnAccent: string
  readonly link: string
  readonly linkLine: string
  readonly focus: string
  readonly effortFill: string
  readonly effortStopOn: string
  readonly effortInk: string
}

export interface ThemeFile {
  readonly schemaVersion: 1
  readonly name: string
  readonly basePalette: Palette
  readonly seedColor: string
}

export const DEFAULT_THEME_SEED = "#6aa6ff"

export const CURATED_THEME_FILES: readonly ThemeFile[] = [
  { schemaVersion: 1, name: "Night sky", basePalette: "default", seedColor: "#6aa6ff" },
  { schemaVersion: 1, name: "Matcha dusk", basePalette: "matcha", seedColor: "#73c991" },
  { schemaVersion: 1, name: "Plum neon", basePalette: "ume", seedColor: "#e07aff" },
  { schemaVersion: 1, name: "Fuji morning", basePalette: "fuji", seedColor: "#7767e8" },
]

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

interface Hsl {
  readonly h: number
  readonly s: number
  readonly l: number
}

const HEX = /^#[0-9a-fA-F]{6}$/
const MAX_FILE_BYTES = 32 * 1024
const MAX_NAME_LENGTH = 64

export function normalizeSeedColor(value: string): string | undefined {
  const trimmed = value.trim()
  return HEX.test(trimmed) ? trimmed.toLowerCase() : undefined
}

function rgbFromHex(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function hexFromRgb(rgb: Rgb): string {
  const channel = (value: number): string => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")
  return "#" + channel(rgb.r) + channel(rgb.g) + channel(rgb.b)
}

function hslFromRgb(rgb: Rgb): Hsl {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const l = (max + min) / 2
  if (delta === 0) return { h: 0, s: 0, l }
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  return { h: (h * 60 + 360) % 360, s, l }
}

function rgbFromHsl(hsl: Hsl): Rgb {
  const c = (1 - Math.abs(2 * hsl.l - 1)) * hsl.s
  const x = c * (1 - Math.abs(((hsl.h / 60) % 2) - 1))
  const m = hsl.l - c / 2
  const [r, g, b] = hsl.h < 60 ? [c, x, 0] : hsl.h < 120 ? [x, c, 0] : hsl.h < 180 ? [0, c, x] : hsl.h < 240 ? [0, x, c] : hsl.h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

function luminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return channel(rgb.r) * 0.2126 + channel(rgb.g) * 0.7152 + channel(rgb.b) * 0.0722
}

function contrast(a: Rgb, b: Rgb): number {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))
  return (light + 0.05) / (dark + 0.05)
}

function safeAccent(seed: Rgb, dark: boolean): Rgb {
  const hsl = hslFromRgb(seed)
  const background: Rgb = dark ? { r: 24, g: 24, b: 24 } : { r: 250, g: 250, b: 250 }
  const preferred = dark ? Math.max(hsl.l, 0.52) : Math.min(hsl.l, 0.48)
  const candidates = Array.from({ length: 41 }, (_, index) => {
    const distance = index * 0.0125
    const lightness = dark ? Math.min(0.9, preferred + distance) : Math.max(0.12, preferred - distance)
    return rgbFromHsl({ ...hsl, l: lightness })
  })
  const passing = candidates.filter((candidate) => contrast(candidate, background) >= 4.5)
  return passing[0] ?? candidates.sort((a, b) => contrast(b, background) - contrast(a, background))[0] ?? seed
}

function rgba(rgb: Rgb, alpha: number): string {
  return "rgba(" + String(Math.round(rgb.r)) + ", " + String(Math.round(rgb.g)) + ", " + String(Math.round(rgb.b)) + ", " + String(alpha) + ")"
}

export function deriveThemeTokens(seedColor: string, dark: boolean): ThemeTokens {
  const normalized = normalizeSeedColor(seedColor) ?? DEFAULT_THEME_SEED
  const accent = safeAccent(rgbFromHex(normalized), dark)
  const accentHsl = hslFromRgb(accent)
  const hover = rgbFromHsl({ ...accentHsl, l: dark ? Math.min(0.94, accentHsl.l + 0.06) : Math.max(0.08, accentHsl.l - 0.06) })
  const white: Rgb = { r: 255, g: 255, b: 255 }
  const black: Rgb = { r: 0, g: 0, b: 0 }
  const textOnAccent = contrast(accent, white) >= contrast(accent, black) ? "#ffffff" : "#000000"
  const accentHex = hexFromRgb(accent)
  return {
    accent: accentHex,
    accentHover: hexFromRgb(hover),
    accentSoft: rgba(accent, dark ? 0.16 : 0.1),
    accentLine: rgba(accent, dark ? 0.48 : 0.38),
    textOnAccent,
    link: accentHex,
    linkLine: rgba(accent, dark ? 0.48 : 0.38),
    focus: rgba(accent, dark ? 0.9 : 0.95),
    effortFill: accentHex,
    effortStopOn: textOnAccent,
    effortInk: accentHex,
  }
}

export function themeFileFor(profile: ThemeProfile): ThemeFile {
  return { schemaVersion: 1, name: profile.name, basePalette: profile.palette, seedColor: profile.seedColor }
}

export function parseThemeFile(value: unknown): ThemeFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(",") !== "basePalette,name,schemaVersion,seedColor") return undefined
  if (record.schemaVersion !== 1 || typeof record.name !== "string" || record.name.trim().length === 0 || record.name.length > MAX_NAME_LENGTH) return undefined
  if (typeof record.basePalette !== "string" || !["default", "sakura", "ume", "fuji", "ajisai", "tsubaki", "matcha"].includes(record.basePalette)) return undefined
  const seedColor = typeof record.seedColor === "string" ? normalizeSeedColor(record.seedColor) : undefined
  if (seedColor === undefined) return undefined
  return { schemaVersion: 1, name: record.name.trim(), basePalette: record.basePalette as Palette, seedColor }
}

export function readThemeFile(file: File): Promise<ThemeFile> {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error("Theme file is too large."))
  return file.text().then((text) => {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error("Theme file is not valid JSON.")
    }
    const parsed = parseThemeFile(value)
    if (parsed === undefined) throw new Error("Theme file is missing a supported name, palette, or color.")
    return parsed
  })
}

export function profileFromThemeFile(file: ThemeFile, now = Date.now()): ThemeProfile {
  return { id: newId("theme"), name: file.name.slice(0, MAX_NAME_LENGTH), palette: file.basePalette, seedColor: file.seedColor, createdAt: now, updatedAt: now }
}

export function downloadThemeFile(profile: ThemeProfile): void {
  const blob = new Blob([JSON.stringify(themeFileFor(profile), null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = (profile.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48) || "runrail-theme") + ".rrtheme"
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
