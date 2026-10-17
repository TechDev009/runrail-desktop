import type { View } from "./store"

/**
 * The rail's places, each with its digit: Threads 1, Reviews 2, Agents 3, Workflows 4, Evals 5,
 * Integrations 6, Memory 7, Office 8.
 */
export type RailPlace = "threads" | "reviews" | "agents" | "workflows" | "evals" | "integrations" | "memory" | "office"

export interface RailItem {
  readonly place: RailPlace
  readonly label: string
  readonly keys: string
  readonly active: boolean
  /** Threads waiting on the person on Office; pull requests waiting on their review on Reviews. */
  readonly badge?: number
}

export interface RailInput {
  readonly view: View
  readonly office: boolean
  readonly waiting: number
  readonly reviewsWaiting?: number
  /** Setup runs whose plan waits for the person's approval. */
  readonly agentsWaiting?: number
  /** Evals running now. */
  readonly evalsRunning?: number
}

const PLACES: readonly { readonly place: RailPlace; readonly label: string; readonly keys: string }[] = [
  { place: "threads", label: "Threads", keys: "mod+1" },
  { place: "reviews", label: "Reviews", keys: "mod+2" },
  { place: "agents", label: "Agents", keys: "mod+3" },
  { place: "workflows", label: "Workflows", keys: "mod+4" },
  { place: "evals", label: "Evals", keys: "mod+5" },
  { place: "integrations", label: "Integrations", keys: "mod+6" },
  { place: "memory", label: "Memory", keys: "mod+7" },
  { place: "office", label: "Office", keys: "mod+8" },
]

export function placeOf(view: View): RailPlace {
  switch (view.kind) {
    case "thread":
    case "compare":
    case "archived":
      return "threads"
    case "reviews":
      return "reviews"
    case "agents":
      return "agents"
    case "workflows":
      return "workflows"
    case "evals":
      return "evals"
    case "integrations":
      return "integrations"
    case "memory":
      return "memory"
    case "office":
      return "office"
  }
}

export function railItems({ view, office, waiting, reviewsWaiting = 0, agentsWaiting = 0, evalsRunning = 0 }: RailInput): readonly RailItem[] {
  const current = placeOf(view)
  const badges: Partial<Record<RailPlace, number>> = { office: waiting, reviews: reviewsWaiting, agents: agentsWaiting, evals: evalsRunning }
  return PLACES.filter((item) => item.place !== "office" || office).map((item) => {
    const badge = badges[item.place] ?? 0
    return { ...item, active: item.place === current, ...(badge > 0 ? { badge } : {}) }
  })
}

/** The threads list sits beside the rail on the Threads place only, when the person keeps it open. */
export function listShown(view: View, open: boolean): boolean {
  return open && placeOf(view) === "threads"
}

/** The `aria-keyshortcuts` value for "mod+1": "Meta+1" on macOS, "Control+1" elsewhere. */
export function ariaKeys(keys: string, mac: boolean): string {
  return keys
    .split("+")
    .map((part) => (part === "mod" ? (mac ? "Meta" : "Control") : part === "shift" ? "Shift" : part === "alt" ? "Alt" : part === "ctrl" ? "Control" : part.length === 1 ? part.toUpperCase() : part))
    .join("+")
}

/**
 * What choosing a place does. Choosing the place already shown toggles the threads list for
 * Threads and does nothing elsewhere; Office does nothing while office mode is off.
 */
export function railAction(place: RailPlace, input: { readonly view: View; readonly office: boolean }): "show" | "toggle-list" | "none" {
  if (place === "office" && !input.office) return "none"
  if (placeOf(input.view) !== place) return "show"
  return place === "threads" ? "toggle-list" : "none"
}
