import type { CSSProperties } from "react"
import { ACCENTS, PALETTES, type Accent, type Palette, type Prefs } from "../../app/persist"
import { cx } from "../common"

/** Appearance controls for Settings: the theme and palette as small previews, the accent as color dots. */

type Theme = Prefs["theme"]

const THEMES: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

/** A tiny window: a sidebar, two lines of text, and a message bubble. */
function Mini({ tone }: { readonly tone: "light" | "dark" }) {
  return (
    <span className={cx("theme-mini", `is-${tone}`)}>
      <span className="theme-mini-side" />
      <span className="theme-mini-main">
        <span className="theme-mini-line" />
        <span className="theme-mini-line is-short" />
        <span className="theme-mini-bubble" />
      </span>
    </span>
  )
}

export function ThemeCards({ value, onChange }: { readonly value: Theme; readonly onChange: (theme: Theme) => void }) {
  return (
    <div className="theme-cards" role="radiogroup" aria-label="Theme">
      {THEMES.map((theme) => (
        <button key={theme.value} type="button" role="radio" aria-checked={value === theme.value} className={cx("theme-card", value === theme.value && "is-active")} onClick={() => onChange(theme.value)}>
          <span className={cx("theme-preview", `is-${theme.value}`)} aria-hidden="true">
            {theme.value === "system" ? (
              <>
                <Mini tone="dark" />
                <Mini tone="light" />
              </>
            ) : (
              <Mini tone={theme.value} />
            )}
          </span>
          <span className="theme-card-label">{theme.label}</span>
        </button>
      ))}
    </div>
  )
}

export const PALETTE_INFO: Readonly<Record<Palette, { readonly label: string; readonly about: string }>> = {
  default: { label: "Default", about: "Neutral black and white" },
  sakura: { label: "Sakura", about: "Cherry blossom, soft pink; Yozakura at night" },
  ume: { label: "Ume", about: "Plum blossom, deep rose" },
  fuji: { label: "Fuji", about: "Wisteria, lavender" },
  ajisai: { label: "Ajisai", about: "Hydrangea, blue-violet" },
  tsubaki: { label: "Tsubaki", about: "Camellia, crimson with leaf green" },
  matcha: { label: "Matcha", about: "Green tea" },
}

/** One side of a palette card, drawn in that palette's colors whichever palette is on. */
function PaletteHalf({ palette, tone }: { readonly palette: Palette; readonly tone: "dark" | "light" }) {
  const token = (part: string): string => `var(--pv-${palette}-${tone}-${part})`
  const style = { "--pv-bg": token("bg"), "--pv-side": token("side"), "--pv-line": token("line"), "--pv-accent": token("accent") } as CSSProperties
  return (
    <span className={cx("palette-half", `is-${tone}`)} style={style}>
      <span className="palette-half-side" />
      <span className="palette-half-main">
        <span className="palette-half-line" />
        <span className="palette-half-line is-short" />
        <span className="palette-half-dot" />
      </span>
    </span>
  )
}

export function PaletteCards({ value, onChange }: { readonly value: Palette; readonly onChange: (palette: Palette) => void }) {
  return (
    <div className="palette-cards" role="radiogroup" aria-label="Palette">
      {PALETTES.map((palette) => (
        <button key={palette} type="button" role="radio" aria-checked={value === palette} title={PALETTE_INFO[palette].about} className={cx("palette-card", value === palette && "is-active")} onClick={() => onChange(palette)}>
          <span className="palette-preview" aria-hidden="true">
            <PaletteHalf palette={palette} tone="dark" />
            <PaletteHalf palette={palette} tone="light" />
          </span>
          <span className="palette-card-label">{PALETTE_INFO[palette].label}</span>
        </button>
      ))}
    </div>
  )
}

export const ACCENT_LABELS: Readonly<Record<Accent, string>> = { mono: "Mono", theme: "Palette", blue: "Blue", violet: "Violet", orange: "Orange", green: "Green", teal: "Teal", rose: "Rose", amber: "Amber", indigo: "Indigo", cyan: "Cyan" }

/** The palette's own accent is offered while a flower palette is on; on the default palette it would be mono. */
export function accentChoices(palette: Palette, value: Accent): readonly Accent[] {
  return ACCENTS.filter((accent) => accent !== "theme" || palette !== "default" || value === "theme")
}

export function AccentDots({ value, palette = "default", onChange }: { readonly value: Accent; readonly palette?: Palette; readonly onChange: (accent: Accent) => void }) {
  return (
    <div className="accent-dots" role="radiogroup" aria-label="Accent">
      {accentChoices(palette, value).map((accent) => {
        const label = accent === "theme" && palette !== "default" ? `${ACCENT_LABELS.theme} (${PALETTE_INFO[palette].label})` : ACCENT_LABELS[accent]
        return <button key={accent} type="button" role="radio" aria-checked={value === accent} aria-label={label} title={label} className={cx("accent-dot", `is-${accent}`, value === accent && "is-active")} onClick={() => onChange(accent)} />
      })}
      <span className="accent-name">{ACCENT_LABELS[value]}</span>
    </div>
  )
}
