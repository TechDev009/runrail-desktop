import { Check, ChevronDown, ChevronLeft, ChevronRight, Plus, RefreshCw, RotateCcw, Search, Settings2, Star, TriangleAlert } from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { connectModel } from "../../app/actions"
import type { Catalog } from "../../app/catalog"
import {
  bestMatch,
  buildPicker,
  reasoningView,
  THINKING_NAME,
  toggleFavorite,
  triggerView,
  type ModelFacts,
  type PickerEntry,
  type PickerValue,
  type PickerView,
  type ReasoningView,
  type Selection,
  type SelectionProblem,
  type TriggerView,
} from "../../app/picker"
import { useRefusedLevels } from "../../app/refusals"
import { MAX_FAVORITE_MODELS } from "../../app/persist"
import { get, set, setPrefs, useApp } from "../../app/store"
import type { Thinking } from "../../host/types"
import { Button, cx, IconButton, Popover, Spinner } from "../common"

/**
 * The model menu: one chip with the model and its reasoning effort. It opens on the effort, with
 * the model above the slider; the model opens the list of every model a thread can run on. What
 * the list holds is worked out in `app/picker`; this file only draws it.
 */

type PickerCatalogState = Catalog & {
  readonly loading: boolean
  readonly reload: () => void
}

export function ModelPicker({
  catalog,
  value,
  problem,
  onPick,
  onThinking,
  busy,
  openSignal,
  side = "top",
  align = "center",
  className,
}: {
  readonly catalog: PickerCatalogState
  readonly value: PickerValue
  /** Why this selection cannot send, when it cannot. */
  readonly problem: SelectionProblem | undefined
  readonly onPick: (selection: Selection) => void
  readonly onThinking: (thinking: Thinking) => void
  readonly busy: boolean
  readonly openSignal?: number
  readonly side?: "top" | "bottom"
  readonly align?: "start" | "end" | "center"
  readonly className?: string
}) {
  const developer = useApp((state) => state.prefs.developer)
  const toggleRef = useRef<{ open: boolean; toggle: () => void } | undefined>(undefined)

  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return
    const control = toggleRef.current
    if (control !== undefined && !control.open) control.toggle()
  }, [openSignal])

  const refused = useRefusedLevels(value.backend === "native" ? value.connectionId : undefined, value.model)
  const chip = triggerView(value, catalog, developer, problem, refused)
  // Nothing is known yet: the chip waits instead of claiming that no model is connected.
  const waiting = catalog.loading && catalog.connections.length === 0 && value.backend === "native" && value.model === undefined && !developer

  const reasoning = reasoningView(value, catalog.models, catalog.harnesses, refused)
  const level = waiting ? undefined : chip.reasoning

  return (
    <div className={cx("picker-chip", className, problem !== undefined && !waiting && "is-missing")}>
      <Popover
        side={side}
        align={align}
        width={256}
        room={400}
        className="picker-popover"
        trigger={({ open, toggle, ref }) => {
          toggleRef.current = { open, toggle }
          return (
            <button
              ref={ref}
              type="button"
              className={cx("picker-trigger", open && "is-open")}
              onClick={toggle}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={level === undefined ? undefined : `${waiting ? "Model" : chip.label}, ${THINKING_NAME[level]} effort`}
              title={waiting ? "Reading your connections" : chip.title}
            >
              {waiting ? (
                <Spinner size={12} />
              ) : problem !== undefined ? (
                <TriangleAlert size={12} />
              ) : (
                chip.mark !== undefined && (
                  <span className="picker-mark is-chip" aria-hidden="true">
                    {chip.mark}
                  </span>
                )
              )}
              <span className="picker-model">{waiting ? "Model" : chip.label}</span>
              {level !== undefined && <span className="picker-effort">{CHIP_LEVEL[level]}</span>}
              <ChevronDown size={12} className="picker-chevron" />
            </button>
          )
        }}
      >
        {(close) => (
          <ModelMenu catalog={catalog} value={value} developer={developer} busy={busy} chip={chip} level={level} reasoning={reasoning} onPick={onPick} onThinking={onThinking} close={close} />
        )}
      </Popover>
    </div>
  )
}

/** Mounted while the menu is open: it opens on the effort when the model takes one, else on the list. */
function ModelMenu({
  catalog,
  value,
  developer,
  busy,
  chip,
  level,
  reasoning,
  onPick,
  onThinking,
  close,
}: {
  readonly catalog: PickerCatalogState
  readonly value: PickerValue
  readonly developer: boolean
  readonly busy: boolean
  readonly chip: TriggerView
  readonly level: Thinking | undefined
  readonly reasoning: ReasoningView
  readonly onPick: (selection: Selection) => void
  readonly onThinking: (thinking: Thinking) => void
  readonly close: () => void
}) {
  const [page, setPage] = useState<"effort" | "models">(level === undefined ? "models" : "effort")
  const fallback = useApp((state) => state.prefs.defaultThinking)
  const root = useRef<HTMLDivElement | null>(null)
  const turned = useRef(false)

  // The popover focuses the first page; a page turned to takes focus the same way.
  useEffect(() => {
    if (!turned.current) {
      turned.current = true
      return
    }
    root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus()
  }, [page])

  // A model picked from the list that takes no effort has nothing to come back to.
  useEffect(() => {
    if (page === "effort" && level === undefined) close()
  }, [page, level, close])

  if (page === "models" || level === undefined) {
    return (
      <div ref={root} className="model-menu">
        <PickerPanel
          catalog={catalog}
          value={value}
          developer={developer}
          busy={busy}
          onBack={level === undefined ? undefined : () => setPage("effort")}
          onPick={(selection) => {
            onPick(selection)
            // Another coding tool or agent may need a new thread, so the menu steps aside for that.
            if (selection.backend === value.backend) setPage("effort")
            else close()
          }}
          close={close}
        />
      </div>
    )
  }
  const reset = reasoning.levels.includes(fallback) ? fallback : reasoning.levels.includes("medium") ? "medium" : undefined
  return (
    <div ref={root} className="model-menu effort-page">
      <div className="effort-page-head">
        <span className="effort-page-side" aria-hidden="true" />
        <button type="button" className="effort-page-model" onClick={() => setPage("models")} aria-label={`${chip.label}. Choose another model`}>
          <span className="effort-page-level">{THINKING_NAME[level]}</span>
          <span className="effort-page-name">
            <span className="effort-page-label">{chip.label}</span>
            <ChevronRight size={12} aria-hidden="true" />
          </span>
        </button>
        <span className="effort-page-side">
          <IconButton
            label={reset === undefined ? "Reset effort" : `Reset to ${THINKING_NAME[reset]}`}
            size="sm"
            disabled={reset === undefined || reset === level || !reasoning.enabled}
            onClick={() => reset !== undefined && onThinking(reset)}
          >
            <RotateCcw size={13} />
          </IconButton>
        </span>
      </div>
      <EffortSlider level={level} view={reasoning} busy={busy} onChange={onThinking} />
    </div>
  )
}

/** The level as the chip shows it, after the model's name. */
const CHIP_LEVEL: Record<Thinking, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
}

const LEVEL_HINT: Record<Thinking, string> = {
  off: "Answers right away, without thinking first",
  minimal: "The briefest look before answering",
  low: "Quick thinking for simple tasks",
  medium: "Balanced for everyday work",
  high: "Thinks longer on hard problems",
  xhigh: "Deep thinking; slower and uses more tokens",
  max: "As much thinking as the model allows",
  ultra: "Deepest thinking; hands work to subagents",
}

/**
 * Reasoning effort as a slider: a knob on a track with one stop per level the model takes, moved
 * by drag, click, or arrow keys. A level it does not list (a coding tool's floor, say) sits on the
 * lowest stop, and the note says how it runs.
 */
export function EffortSlider({
  level,
  view,
  busy,
  onChange,
  label = "Effort",
  compact = false,
}: {
  readonly level: Thinking
  readonly view: ReasoningView
  readonly busy: boolean
  readonly onChange: (thinking: Thinking) => void
  readonly label?: string
  /** Inside a settings row, which names and explains it: the track and the level's name. */
  readonly compact?: boolean
}) {
  const track = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const levels = view.levels
  const count = Math.max(1, levels.length)
  const at = Math.max(0, levels.indexOf(level))
  const choose = (index: number): void => {
    const next = levels[Math.min(levels.length - 1, Math.max(0, index))]
    if (view.enabled && next !== undefined && next !== level) onChange(next)
  }
  // Stops sit between the track's rounded ends, half its height in from each edge.
  const fromPointer = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect()
    if (box === undefined || count <= 1) return 0
    const usable = box.width - box.height
    if (usable <= 0) return at
    return Math.round(Math.min(1, Math.max(0, (clientX - box.left - box.height / 2) / usable)) * (count - 1))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0
    if (step !== 0) choose(at + step)
    else if (event.key === "Home") choose(0)
    else if (event.key === "End") choose(levels.length - 1)
    else return
    event.preventDefault()
    event.stopPropagation()
  }
  const hint = view.note ?? LEVEL_HINT[level]
  const style = {
    "--at": String(at),
    "--span": String(Math.max(1, count - 1)),
  } as CSSProperties
  return (
    <div className={cx("effort", compact && "is-compact", !view.enabled && "is-disabled", dragging && "is-dragging")} style={style}>
      <div
        ref={track}
        role="slider"
        tabIndex={view.enabled ? 0 : -1}
        className="effort-track"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={levels.length - 1}
        aria-valuenow={at}
        aria-valuetext={THINKING_NAME[level]}
        aria-disabled={!view.enabled}
        title={hint}
        data-autofocus={compact ? undefined : ""}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (!view.enabled || event.button !== 0) return
          setDragging(true)
          event.currentTarget.setPointerCapture(event.pointerId)
          choose(fromPointer(event.clientX))
        }}
        onPointerMove={(event) => dragging && choose(fromPointer(event.clientX))}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <span className="effort-fill" aria-hidden="true" />
        {levels.map((option, index) => (
          <span key={option} className={cx("effort-stop", index <= at && "is-passed")} style={{ "--i": String(index) } as CSSProperties} aria-hidden="true" />
        ))}
        <span className="effort-knob" aria-hidden="true" />
      </div>
      {compact && <span className="effort-value">{THINKING_NAME[level]}</span>}
      {/* What a level means is the track's tooltip; only how this one runs differs is said aloud. */}
      {!compact && (view.note !== undefined || busy) && (
        <p className="effort-hint">
          {view.note}
          {busy && <span className="effort-when">{view.note === undefined ? "From the next turn" : " · From the next turn"}</span>}
        </p>
      )}
    </div>
  )
}

const EMPTY_TEXT: Record<Exclude<NonNullable<PickerView["empty"]>, "no-match">, string> = {
  unreadable: "Connections could not be read.",
  "none-ready": "None of your connections is ready to use.",
  none: "No model is connected yet.",
}

/** Mounted while the menu is open, so a search never outlives the visit it was typed in. */
export function PickerPanel({
  catalog,
  value,
  developer,
  busy,
  onPick,
  onBack,
  close,
}: {
  readonly catalog: PickerCatalogState
  readonly value: PickerValue
  readonly developer: boolean
  readonly busy: boolean
  readonly onPick: (selection: Selection) => void
  /** Back to the effort, when the menu opened there. */
  readonly onBack?: (() => void) | undefined
  readonly close: () => void
}) {
  const recents = useApp((state) => state.prefs.recentModels)
  const favorites = useApp((state) => state.prefs.favoriteModels)
  const [query, setQuery] = useState("")
  const root = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const view = buildPicker({
    catalog,
    value,
    recents,
    favorites,
    query,
    developer,
  })
  const star = (entry: PickerEntry): void => {
    if (entry.model === undefined || entry.connectionId === undefined) return
    setPrefs({
      favoriteModels: toggleFavorite(get().prefs.favoriteModels, { model: entry.model, connectionId: entry.connectionId }, MAX_FAVORITE_MODELS),
    })
  }
  const typed = query.trim()

  // A long list opens with the current model in view.
  useEffect(() => {
    root.current?.querySelector(".picker-item.is-active")?.scrollIntoView({ block: "nearest" })
  }, [])

  const first = catalog.loading && catalog.connections.length === 0 && catalog.connectionsError === undefined

  const pick = (entry: PickerEntry): void => {
    onPick({
      backend: entry.backend,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId }),
    })
  }

  // Up and down walk the rows; the search field is the row above the first one.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const rows = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".picker-item:not(:disabled)") ?? [])
    if (rows.length === 0) return
    event.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "ArrowDown") {
      rows[at + 1 < rows.length ? at + 1 : 0]?.focus()
      return
    }
    if (at === 0 && search.current !== null) search.current.focus()
    else rows[at <= 0 ? rows.length - 1 : at - 1]?.focus()
  }

  const openConnections = (): void => {
    close()
    set({ settings: "connections" })
  }
  const connect = (): void => {
    close()
    connectModel()
  }

  return (
    <div ref={root} className="picker" onKeyDown={onKeyDown}>
      <div className="picker-top">
        {onBack !== undefined && (
          <IconButton label="Back to effort" size="sm" onClick={onBack}>
            <ChevronLeft size={14} />
          </IconButton>
        )}
        {view.search ? (
          <label className="picker-search">
            <Search size={13} />
            <input
              ref={search}
              type="text"
              value={query}
              maxLength={160}
              placeholder="Search models"
              aria-label="Search models"
              data-autofocus=""
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Backspace" && query.length === 0 && onBack !== undefined) {
                  event.preventDefault()
                  onBack()
                  return
                }
                if (event.key !== "Enter" || typed.length === 0) return
                event.preventDefault()
                const best = bestMatch(view)
                if (best !== undefined) pick(best)
              }}
            />
          </label>
        ) : (
          <span className="picker-title">Select model</span>
        )}
        {catalog.loading ? (
          <span className="picker-busy" role="status" aria-label="Loading models">
            <Spinner size={12} />
          </span>
        ) : (
          <IconButton label="Refresh models" size="sm" onClick={catalog.reload}>
            <RefreshCw size={12} />
          </IconButton>
        )}
      </div>
      {busy && (
        <div className="picker-note" role="status">
          Applies after this turn
        </div>
      )}
      <div className="picker-list" tabIndex={-1} {...(view.search ? {} : { "data-autofocus": "" })}>
        {first ? (
          <div className="picker-empty">Reading your connections…</div>
        ) : view.empty === "no-match" ? (
          <div className="picker-empty">Nothing matches "{typed}".</div>
        ) : (
          view.empty !== undefined && (
            <div className="picker-empty">
              <div>{EMPTY_TEXT[view.empty]}</div>
              {view.empty === "unreadable" ? (
                <Button size="sm" loading={catalog.loading} onClick={catalog.reload}>
                  Try again
                </Button>
              ) : view.empty === "none-ready" ? (
                <Button size="sm" variant="primary" icon={<Settings2 size={13} />} onClick={openConnections}>
                  Open Connections
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={connect}>
                  Connect a model
                </Button>
              )}
            </div>
          )
        )}
        {view.groups.map((group) => (
          <div key={group.id} className="picker-group" role="group" aria-label={group.label}>
            <div className="picker-group-label">
              <span className="picker-group-name">{group.label}</span>
              {group.note !== undefined && group.warn === true && (
                <span className="picker-warn" role="status">
                  {group.note}
                </span>
              )}
            </div>
            {group.note !== undefined && group.warn !== true && <div className="picker-group-note">{withCode(group.note)}</div>}
            {group.hint !== undefined && <div className="picker-group-note">{withCode(group.hint)}</div>}
            {group.entries.map((entry) => (
              <div key={entry.key} className={cx("picker-row", entry.favorite === true && "is-favorite")}>
                <button
                  type="button"
                  className={cx("picker-item", entry.active && "is-active", `is-${entry.kind}`)}
                  title={rowTitle(entry)}
                  disabled={entry.disabled === true}
                  aria-current={entry.active ? "true" : undefined}
                  onClick={() => pick(entry)}
                >
                  <span className="picker-item-text">
                    <span className="picker-item-label">{entry.label}</span>
                    {entry.meta !== undefined && <span className="picker-item-meta">{entry.meta}</span>}
                  </span>
                  {entry.facts?.context !== undefined && (
                    <span className="picker-fact is-context">
                      {entry.facts.context}
                      <span className="sr-only"> tokens of context.</span>
                    </span>
                  )}
                  <span className="picker-check">{entry.active && <Check size={14} />}</span>
                </button>
                {entry.kind === "model" && (
                  <button
                    type="button"
                    className="picker-star"
                    aria-pressed={entry.favorite === true}
                    aria-label={entry.favorite === true ? `Remove ${entry.label} from favorites` : `Add ${entry.label} to favorites`}
                    title={entry.favorite === true ? "Remove from favorites" : "Add to favorites"}
                    onClick={() => star(entry)}
                  >
                    <Star size={12} fill={entry.favorite === true ? "currentColor" : "none"} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {!first && view.empty !== "unreadable" && view.empty !== "none" && (
          <div className="picker-group picker-more">
            <button type="button" className="picker-item is-action" onClick={connect}>
              <Plus size={14} className="picker-item-icon" />
              <span className="picker-item-label">Connect another model</span>
            </button>
            <button type="button" className="picker-item is-action" onClick={openConnections}>
              <Settings2 size={14} className="picker-item-icon" />
              <span className="picker-item-label">Manage connections</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** A note with its `commands` set as code. */
function withCode(text: string): ReactNode {
  const parts = text.split("`")
  if (parts.length < 3) return text
  return parts.map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))
}

/** What else the connection said about a model, for the row's tooltip. */
function rowTitle(entry: PickerEntry): string | undefined {
  const facts: ModelFacts | undefined = entry.facts
  const parts = [
    entry.title,
    facts?.context === undefined ? undefined : `Reads up to ${facts.context} tokens at once`,
    facts?.reasoning === true ? "Thinks before it answers" : undefined,
    facts?.images === true ? "Reads images" : undefined,
    facts?.price?.long,
  ].filter((part): part is string => part !== undefined && part.length > 0)
  return parts.length === 0 ? undefined : parts.join(" · ")
}
