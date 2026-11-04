import { useRef, useState, type CSSProperties, type ChangeEvent } from "react"
import { confirmAction } from "../../app/actions"
import { ACCENTS, PALETTES, newId, type Accent, type Palette, type Prefs, type ThemeProfile } from "../../app/persist"
import { get, removeThemeProfile, saveThemeProfile, setActiveThemeProfile, toast } from "../../app/store"
import { CURATED_THEME_FILES, DEFAULT_THEME_SEED, deriveThemeTokens, downloadThemeFile, normalizeSeedColor, profileFromThemeFile, readThemeFile, themeFileFor, type ThemeFile } from "../../app/themeProfiles"
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

interface ProfileDraft {
  readonly id?: string
  readonly name: string
  readonly palette: Palette
  readonly seedColor: string
  readonly createdAt?: number
}

function profileDraft(profile?: ThemeProfile): ProfileDraft {
  return profile === undefined
    ? { name: "My theme", palette: "default", seedColor: DEFAULT_THEME_SEED }
    : { id: profile.id, name: profile.name, palette: profile.palette, seedColor: profile.seedColor, createdAt: profile.createdAt }
}

function profileFromDraft(draft: ProfileDraft): ThemeProfile | undefined {
  const name = draft.name.trim()
  const seedColor = normalizeSeedColor(draft.seedColor)
  if (name.length === 0 || name.length > 64 || seedColor === undefined) return undefined
  const now = Date.now()
  return {
    id: draft.id ?? newId("theme"),
    name,
    palette: draft.palette,
    seedColor,
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
  }
}

function ThemePreview({ seedColor }: { readonly seedColor: string }) {
  const dark = deriveThemeTokens(seedColor, true)
  const light = deriveThemeTokens(seedColor, false)
  const style = {
    "--tp-dark-accent": dark.accent,
    "--tp-dark-soft": dark.accentSoft,
    "--tp-dark-ink": dark.textOnAccent,
    "--tp-light-accent": light.accent,
    "--tp-light-soft": light.accentSoft,
    "--tp-light-ink": light.textOnAccent,
  } as CSSProperties
  return (
    <span className="theme-profile-preview" style={style} aria-hidden="true">
      <span className="theme-profile-preview-half is-dark">
        <span className="theme-profile-preview-dot" />
        <span className="theme-profile-preview-line" />
        <span className="theme-profile-preview-control">Aa</span>
      </span>
      <span className="theme-profile-preview-half is-light">
        <span className="theme-profile-preview-dot" />
        <span className="theme-profile-preview-line" />
        <span className="theme-profile-preview-control">Aa</span>
      </span>
    </span>
  )
}

export function ThemeProfiles({ profiles, activeId }: { readonly profiles: readonly ThemeProfile[]; readonly activeId?: string }) {
  const [draft, setDraft] = useState<ProfileDraft>()
  const [pendingImport, setPendingImport] = useState<ThemeFile>()
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement | null>(null)
  const editing = draft !== undefined
  const update = (patch: Partial<ProfileDraft>): void => setDraft((current) => (current === undefined ? current : { ...current, ...patch }))
  const save = (): void => {
    if (draft === undefined) return
    const profile = profileFromDraft(draft)
    if (profile === undefined) {
      setError("Enter a theme name and a six-digit hex color such as #6aa6ff.")
      return
    }
    saveThemeProfile(profile, true)
    setDraft(undefined)
    setError(undefined)
  }
  const importFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (file === undefined) return
    setPendingImport(undefined)
    void readThemeFile(file)
      .then((theme) => {
        if (get().themeProfiles.length >= 50) {
          setError("You can save up to 50 themes.")
          return
        }
        setError(undefined)
        setPendingImport(theme)
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Theme could not be imported."))
  }
  return (
    <div className="theme-profiles" data-setting="theme-profiles">
      <div className="theme-profiles-head">
        <div>
          <div className="setting-label">Saved themes</div>
          <div className="setting-hint">Create a named accent preset, keep it on this computer, and share it as a .rrtheme file.</div>
        </div>
        <div className="theme-profile-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
              if (profiles.length >= 50) {
                setError("You can save up to 50 themes.")
                return
              }
              setError(undefined)
              setDraft(profileDraft())
            }}>New</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => input.current?.click()}>Import</button>
          <input ref={input} type="file" accept=".rrtheme,application/json" className="theme-profile-file" onChange={importFile} aria-label="Import theme file" />
        </div>
      </div>
      {profiles.length === 0 && !editing && <p className="setting-hint">No saved themes yet.</p>}
      {profiles.length > 0 && (
        <div className="theme-profile-list">
          {profiles.map((profile) => (
            <div key={profile.id} className={cx("theme-profile-card", activeId === profile.id && "is-active")}>
              <ThemePreview seedColor={profile.seedColor} />
              <div className="theme-profile-copy">
                <strong>{profile.name}</strong>
                <span>{PALETTE_INFO[profile.palette].label} · {profile.seedColor}</span>
              </div>
              <div className="theme-profile-card-actions">
                {activeId === profile.id ? <span className="theme-profile-active">Active</span> : <button type="button" className="btn btn-sm btn-ghost" onClick={() => setActiveThemeProfile(profile.id)}>Apply</button>}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(profileDraft(profile))}>Edit</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                    if (profiles.length >= 50) {
                      setError("You can save up to 50 themes.")
                      return
                    }
                    const duplicate = profileFromThemeFile({ ...themeFileFor(profile), name: `${profile.name} copy` })
                    saveThemeProfile(duplicate, false)
                    toast("success", "Theme duplicated")
                  }}>Duplicate</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadThemeFile(profile)}>Export</button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction({
                    title: `Delete ${profile.name}?`,
                    body: activeId === profile.id ? "The built-in palette and accent will be restored." : "This saved theme will be removed from this computer.",
                    confirm: "Delete theme",
                    danger: true,
                    onConfirm: () => removeThemeProfile(profile.id),
                  })}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {pendingImport !== undefined && (
        <div className="theme-profile-editor" data-setting="theme-import-preview">
          <div className="theme-profile-editor-head">
            <div>
              <strong>Review imported theme</strong>
              <p className="setting-hint">{pendingImport.name} · {PALETTE_INFO[pendingImport.basePalette].label} · {pendingImport.seedColor}</p>
            </div>
            <ThemePreview seedColor={pendingImport.seedColor} />
          </div>
          <p className="setting-hint">The preview is contrast-adjusted for both light and dark modes. Saving creates a new local profile; it cannot replace an existing one.</p>
          <div className="theme-profile-editor-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => {
                if (get().themeProfiles.length >= 50) {
                  setError("You can save up to 50 themes.")
                  return
                }
                const nameTaken = get().themeProfiles.some((profile) => profile.name.toLowerCase() === pendingImport.name.toLowerCase())
                const imported = profileFromThemeFile({ ...pendingImport, name: nameTaken ? pendingImport.name + " (imported)" : pendingImport.name })
                saveThemeProfile(imported, false)
                setActiveThemeProfile(imported.id)
                setPendingImport(undefined)
                toast("success", "Theme imported")
              }}>Save imported theme</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPendingImport(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="theme-gallery">
        <div>
          <div className="setting-label">Curated gallery</div>
          <div className="setting-hint">A few Runrail themes shipped with the app. Install one to edit or export it locally.</div>
        </div>
        <div className="theme-gallery-list">
          {CURATED_THEME_FILES.map((theme) => (
            <div key={theme.name} className="theme-gallery-card">
              <ThemePreview seedColor={theme.seedColor} />
              <div className="theme-profile-copy">
                <strong>{theme.name}</strong>
                <span>{PALETTE_INFO[theme.basePalette].label} · {theme.seedColor}</span>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                  if (get().themeProfiles.length >= 50) {
                    setError("You can save up to 50 themes.")
                    return
                  }
                  const nameTaken = get().themeProfiles.some((profile) => profile.name.toLowerCase() === theme.name.toLowerCase())
                  const installed = profileFromThemeFile({ ...theme, name: nameTaken ? theme.name + " (copy)" : theme.name })
                  saveThemeProfile(installed, false)
                  toast("success", "Theme installed")
                }}>Install</button>
            </div>
          ))}
        </div>
      </div>
      {error !== undefined && !editing && <p className="setting-hint is-error" role="alert">{error}</p>}
      {editing && draft !== undefined && (
        <div className="theme-profile-editor">
          <div className="theme-profile-editor-head">
            <strong>{draft.id === undefined ? "New theme" : "Edit theme"}</strong>
            <ThemePreview seedColor={normalizeSeedColor(draft.seedColor) ?? DEFAULT_THEME_SEED} />
          </div>
          <label className="theme-profile-field">
            <span>Name</span>
            <input className="input" value={draft.name} maxLength={64} autoFocus onChange={(event) => update({ name: event.target.value })} />
          </label>
          <label className="theme-profile-field">
            <span>Base palette</span>
            <select className="select" value={draft.palette} onChange={(event) => update({ palette: event.target.value as Palette })}>
              {PALETTES.map((palette) => <option key={palette} value={palette}>{PALETTE_INFO[palette].label}</option>)}
            </select>
          </label>
          <label className="theme-profile-field">
            <span>Seed color</span>
            <span className="theme-profile-color-input">
              <input type="color" value={normalizeSeedColor(draft.seedColor) ?? DEFAULT_THEME_SEED} onChange={(event) => update({ seedColor: event.target.value })} aria-label="Theme seed color" />
              <input className="input" value={draft.seedColor} maxLength={7} spellCheck={false} onChange={(event) => update({ seedColor: event.target.value })} aria-describedby={error === undefined ? undefined : "theme-profile-error"} />
            </span>
          </label>
          {(() => {
            const normalized = normalizeSeedColor(draft.seedColor)
            const dark = normalized === undefined ? undefined : deriveThemeTokens(normalized, true)
            const light = normalized === undefined ? undefined : deriveThemeTokens(normalized, false)
            const adjusted = normalized !== undefined && (dark?.accent !== normalized || light?.accent !== normalized)
            return adjusted ? <p className="setting-hint">Runrail adjusts this seed slightly where needed to keep accent text and controls readable in both modes.</p> : null
          })()}
          {error !== undefined && <p id="theme-profile-error" className="setting-hint is-error" role="alert">{error}</p>}
          <div className="theme-profile-editor-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={save}>Save theme</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                setDraft(undefined)
                setError(undefined)
              }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
