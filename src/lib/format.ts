/** Small formatting helpers shared by the UI. All output is bounded and locale-aware. */

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1_000)
  if (seconds < 45) return "now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${String(days)}d`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${String(weeks)}w`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "5m ago", "just now", or a date for anything older than a month. */
export function timeAgo(at: number, now = Date.now()): string {
  const text = relativeTime(at, now)
  return text === "now" ? "just now" : /^\d/.test(text) ? `${text} ago` : text
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

export function bytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10 * 1_024 ? 1 : 0)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

export function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

export function usd(value: number): string {
  return value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return index <= 0 ? "" : path.slice(0, index)
}

/** Shortens a home-relative absolute path for display. */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")
}

/** Every folder of a path, for a breadcrumb: home as `~`, the filesystem root as `/`. */
export function pathCrumbs(path: string): string[] {
  const short = tildify(path)
  const parts = short.split(/[\\/]+/).filter((part) => part.length > 0)
  return short.startsWith("/") ? ["/", ...parts] : parts
}

/** A folder as people name it: home as `~`, and a deep path by its last few folders. */
export function compactPath(path: string, keep = 3): string {
  const short = tildify(path)
  const parts = short.split("/").filter((part) => part.length > 0)
  return parts.length <= keep + 1 ? short : `…/${parts.slice(-keep).join("/")}`
}

export function plural(count: number, word: string, suffix = "s"): string {
  return `${String(count)} ${word}${count === 1 ? "" : suffix}`
}

export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((part) => part.trim().length > 0) ?? ""
  const collapsed = line.replace(/\s+/g, " ").trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

/** Flattens markdown to readable text for one-line previews: drops code fences, tables, emphasis, and link targets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Renders a shortcut like "mod+shift+k" for the current platform. */
export function shortcut(keys: string): string {
  return keys
    .split("+")
    .map((key) => {
      switch (key) {
        case "mod":
          return isMac ? "⌘" : "Ctrl"
        case "ctrl":
          return isMac ? "⌃" : "Ctrl"
        case "tab":
          return isMac ? "⇥" : "Tab"
        case "shift":
          return isMac ? "⇧" : "Shift"
        case "alt":
          return isMac ? "⌥" : "Alt"
        case "enter":
          return isMac ? "↩" : "Enter"
        case "esc":
        case "escape":
          return "Esc"
        default:
          return key.length === 1 ? key.toUpperCase() : key
      }
    })
    .join(isMac ? "" : "+")
}

/** True when the keyboard event matches "mod+shift+k"-style notation. */
export interface KeyLike {
  readonly key: string
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

export function matches(event: KeyLike, keys: string): boolean {
  const parts = keys.split("+")
  const key = parts[parts.length - 1] ?? ""
  const mod = parts.includes("mod")
  const shift = parts.includes("shift")
  const alt = parts.includes("alt")
  // "ctrl" is the Control key on every platform; elsewhere than macOS "mod" is Control too.
  const ctrl = parts.includes("ctrl") || (!isMac && mod)
  const meta = isMac && mod
  if (ctrl !== event.ctrlKey || meta !== event.metaKey || shift !== event.shiftKey || alt !== event.altKey) return false
  const pressed = event.key.toLowerCase()
  if (key === "enter") return pressed === "enter"
  if (key === "esc") return pressed === "escape"
  if (key === "[" || key === "]") return event.code === (key === "[" ? "BracketLeft" : "BracketRight")
  if (key === ",") return pressed === ","
  if (key === ".") return pressed === "." || event.code === "Period"
  if (key === "/") return pressed === "/" || event.code === "Slash"
  // Option on macOS rewrites event.key (⌥B is "∫"), so letters and digits also match by code.
  if (/^[a-z]$/.test(key)) return pressed === key || event.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return pressed === key || event.code === `Digit${key}`
  return pressed === key
}
