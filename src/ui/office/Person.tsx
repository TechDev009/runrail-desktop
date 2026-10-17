import { Activity, Check, GitBranch, Pin } from "lucide-react"
import { memo, type KeyboardEvent, type ReactNode } from "react"
import { useShallow } from "zustand/react/shallow"
import { isRunning, useBackground } from "../../app/background"
import { learnLevel, lessonById } from "../../app/lessons"
import { modelLabel } from "../../app/modelText"
import type { OfficeFilter } from "../../app/office"
import { BACKEND_LABELS, type Palette } from "../../app/persist"
import { personState, type Pose, type PersonState, type PersonTone } from "../../app/personState"
import { useApp } from "../../app/store"
import { relativeTime } from "../../lib/format"
import { cx } from "../common"
import { HELPER_SKINS, lookFor, type HairStyle, type Look } from "./looks"

/**
 * One thread as a person at a desk. The pose comes from personState, so it moves only while the
 * thread works; the name tag carries the same facts as the sidebar row.
 */

/** The bubble over a person's head: one glyph for how the thread stands; the tooltip says what it is doing. */
const GLYPHS: Readonly<Record<PersonTone, ReactNode>> = {
  work: "···",
  ask: "?",
  fail: "!",
  done: <Check size={12} strokeWidth={3} />,
  idle: "z",
}

/**
 * Each flower palette's one accessory, in cells over the person's head: Sakura's hair clip,
 * Ume's scarf, Fuji's ribbon, Ajisai's raincoat hood, Tsubaki's knit hat and Matcha's headband.
 */
type Cell = readonly [x: number, y: number, width: number, height: number, tone: 1 | 2 | 3]
const ACCESSORIES: Readonly<Record<Palette, readonly Cell[]>> = {
  default: [],
  sakura: [
    [14, 2, 2, 1, 1],
    [15, 1, 1, 1, 2],
  ],
  ume: [
    [9, 7, 6, 1, 1],
    [13, 8, 1, 2, 2],
  ],
  fuji: [
    [12, 0, 3, 1, 1],
    [13, 1, 1, 1, 2],
  ],
  ajisai: [
    [8, 0, 8, 2, 1],
    [7, 2, 1, 5, 1],
    [16, 2, 1, 5, 1],
    [8, 2, 8, 1, 2],
  ],
  tsubaki: [
    [8, 1, 8, 2, 1],
    [8, 3, 8, 1, 2],
    [11, 0, 2, 1, 2],
  ],
  matcha: [
    [8, 3, 8, 1, 1],
    [16, 3, 1, 2, 2],
    [11, 3, 1, 1, 3],
  ],
}

/** A hat or hood covers a bun. */
const HATS: ReadonlySet<Palette> = new Set(["ajisai", "tsubaki"])
/** Tea in the mug, and steam off it on a cold day or in a tea house. */
const TEA: ReadonlySet<Palette> = new Set(["sakura", "matcha"])
const STEAM: ReadonlySet<Palette> = new Set(["ume", "tsubaki", "matcha"])

/** How many helpers are drawn; more show as a count. */
const HELPERS_SHOWN = 3

export interface PersonProps {
  readonly threadId: string
  readonly project: string
  readonly quietSince?: number
  readonly now: number
  readonly selected: boolean
  readonly filter: OfficeFilter
  readonly focusable: boolean
  readonly run?: string
  readonly onOpen: (threadId: string) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

export interface PersonTag {
  readonly title: string
  readonly unread: boolean
  readonly model: string
  readonly worktree: boolean
  readonly pinned: boolean
  /** Share of the context window used, 0 to 100, when the engine reported one. */
  readonly context?: number
  readonly background: number
}

export const Person = memo(function Person(props: PersonProps) {
  const { threadId, quietSince } = props
  const agents = useBackground((state) => state[threadId]?.entries.filter((entry) => entry.kind === "agent" && isRunning(entry)).length ?? 0)
  const background = useBackground((state) => state[threadId]?.entries.filter(isRunning).length ?? 0)
  const person = useApp(
    useShallow((state): PersonState | undefined => {
      const thread = state.threads.find((item) => item.id === threadId)
      return thread === undefined ? undefined : personState({ thread, runtime: state.runtime[threadId], backgroundAgents: agents, ...(quietSince === undefined ? {} : { quietSince }) })
    }),
  )
  const tag = useApp(
    useShallow((state): Omit<PersonTag, "background"> => {
      const thread = state.threads.find((item) => item.id === threadId)
      const context = state.runtime[threadId]?.timeline.context
      const share = context?.windowTokens === undefined || context.windowTokens <= 0 ? undefined : Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))
      return {
        title: thread === undefined ? "" : thread.titled ? thread.title : "New thread",
        unread: thread?.unread === true,
        model: thread === undefined ? "" : thread.model !== undefined ? modelLabel(thread.model) : BACKEND_LABELS[thread.backend],
        worktree: thread?.worktree !== undefined,
        pinned: thread?.pinned === true,
        ...(share === undefined ? {} : { context: share }),
      }
    }),
  )
  const learning = useApp((state) => learnLevel(state.prefs) !== "off")
  const palette = useApp((state) => state.prefs.palette)
  if (person === undefined) return null
  const lesson = learning ? lessonById(person.lesson)?.title : undefined
  return <PersonCard {...props} person={person} tag={{ ...tag, background }} palette={palette} {...(lesson === undefined ? {} : { lesson })} />
})

/** The person as drawn from plain facts; `Person` feeds it from the stores. */
/** `lesson`: learn mode's title for what the person is doing, shown on hovering the bubble. */
export function PersonCard({ threadId, project, quietSince, now, selected, filter, focusable, run, onOpen, onKeyDown, person, tag, lesson, palette = "default" }: PersonProps & { readonly person: PersonState; readonly tag: PersonTag; readonly lesson?: string; readonly palette?: Palette }) {
  const look = lookFor(threadId)
  const quietFor = quietSince === undefined ? undefined : relativeTime(quietSince, now)
  const label = person.pose === "quiet" && quietFor !== undefined ? `Quiet for ${quietFor}` : person.label
  const about = person.detail === undefined ? label : `${label}: ${person.detail}`
  const dimmed = filter !== "all" && person.tone !== filter
  return (
    <button
      type="button"
      className={cx("person", `is-${person.tone}`, selected && "is-selected", dimmed && "is-dimmed")}
      data-pose={person.pose}
      data-thread={threadId}
      tabIndex={focusable ? 0 : -1}
      aria-label={`${tag.title}, ${about}, ${project}${run === undefined ? "" : `, ${run}`}`}
      aria-pressed={selected}
      title={`${tag.title}\n${about}`}
      onClick={() => onOpen(threadId)}
      onKeyDown={onKeyDown}
    >
      <span className="person-bubble" aria-hidden title={lesson}>
        {person.pose === "quiet" ? "z" : GLYPHS[person.tone]}
      </span>
      <span className="person-scene" aria-hidden>
        <Desk look={look} pose={person.pose} palette={palette} />
        {person.helpers > 0 && <Helpers count={person.helpers} />}
      </span>
      <span className="person-tag">
        <span className="person-title">
          {tag.unread && <span className="person-unread" />}
          <span className="person-name">{run ?? tag.title}</span>
        </span>
        <span className="person-meta">
          <span className="person-model">{tag.model}</span>
          {tag.context !== undefined && (
            <span className={cx("person-context", tag.context >= 80 ? "is-full" : tag.context >= 60 && "is-filling")} title={`Context ${String(tag.context)}% used`}>
              <span style={{ width: `${String(tag.context)}%` }} />
            </span>
          )}
          <span className="person-flags">
            {tag.worktree && <GitBranch size={11} aria-label="Own worktree" />}
            {tag.pinned && <Pin size={11} aria-label="Pinned" />}
            {tag.background > 0 && <Activity size={11} aria-label={`${String(tag.background)} running in the background`} />}
          </span>
        </span>
      </span>
    </button>
  )
}

function Hair({ style, color }: { readonly style: HairStyle; readonly color: string }) {
  return (
    <>
      {style === "bun" && <rect x="11" y="0" width="2" height="1" fill={color} />}
      <rect x="9" y="1" width="6" height="1" fill={color} />
      <rect x="8" y="2" width="8" height="2" fill={color} />
      <rect x="8" y="4" width="1" height={style === "long" ? 4 : 2} fill={color} />
      <rect x="15" y="4" width="1" height={style === "long" ? 4 : 2} fill={color} />
    </>
  )
}

/** The person at their desk, in pixel art: 24 by 22 cells, drawn crisp at any size. */
function Desk({ look, pose, palette }: { readonly look: Look; readonly pose: Pose; readonly palette: Palette }) {
  const raised = pose === "raised"
  const style = look.style === "bun" && HATS.has(palette) ? "short" : look.style
  return (
    <svg className="px-scene" viewBox="0 0 24 22" width="92" height="84">
      <ellipse cx="12" cy="21.2" rx="10.5" ry="0.9" className="px-shadow" />
      <rect x="6.6" y="4" width="10.8" height="9.6" rx="2.2" className="px-chair" />
      <g className="px px-body">
        <rect x="9" y="8" width="6" height="5" fill={look.shirt} />
        <rect x="8" y="9" width="1" height="3" fill={look.shirt} />
        {!raised && <rect x="15" y="9" width="1" height="3" fill={look.shirt} />}
        <rect x="11" y="7" width="2" height="1" fill={look.skin} />
        <rect x="9" y="3" width="6" height="4" fill={look.skin} />
        <Hair style={style} color={look.hair} />
        <rect x="10" y="5" width="1" height="1" className="px-eye" />
        <rect x="13" y="5" width="1" height="1" className="px-eye" />
        {ACCESSORIES[palette].map(([x, y, width, height, tone]) => (
          <rect key={`${String(x)}:${String(y)}`} x={x} y={y} width={width} height={height} className={`px-acc px-acc-${String(tone)}`} />
        ))}
      </g>
      {raised && (
        <g className="px px-wave">
          <rect x="15" y="8" width="1" height="1" fill={look.shirt} />
          <rect x="16" y="5" width="1" height="4" fill={look.shirt} />
          <rect x="16" y="3" width="1" height="2" fill={look.skin} />
        </g>
      )}
      <rect x="1.4" y="13" width="21.2" height="2" rx="0.8" className="px-desk-top" />
      <rect x="2.4" y="15" width="19.2" height="4.2" rx="0.5" className="px-desk-front" />
      <rect x="3.4" y="19" width="1.4" height="2" rx="0.3" className="px-desk-leg" />
      <rect x="19.2" y="19" width="1.4" height="2" rx="0.3" className="px-desk-leg" />
      <rect x="8.6" y="8.7" width="6.8" height="4.5" rx="0.6" className="px-laptop" />
      <rect x="7.7" y="12.9" width="8.6" height="0.8" rx="0.4" className="px-laptop-base" />
      <circle cx="12" cy="10.9" r="0.75" className="px-glow" />
      <g className="px">
        <rect x="8" y="12" width="1" height="1" fill={look.skin} className="px-hand-left" />
        {!raised && <rect x="15" y="12" width="1" height="1" fill={look.skin} className="px-hand-right" />}
      </g>
      <rect x="17.8" y="10.7" width="2" height="2.3" rx="0.5" className="px-mug" />
      {TEA.has(palette) && <rect x="18.1" y="10.8" width="1.4" height="0.5" className="px-tea" />}
      {STEAM.has(palette) && (
        <>
          <rect x="18.3" y="8.8" width="0.4" height="1.2" className="px-steam px-steam-1" />
          <rect x="19.1" y="8.2" width="0.4" height="1.4" className="px-steam px-steam-2" />
        </>
      )}
      <rect x="3.6" y="12.2" width="3" height="0.8" rx="0.2" className="px-paper" />
    </svg>
  )
}

function Helpers({ count }: { readonly count: number }) {
  const shown = Math.min(count, HELPERS_SHOWN)
  return (
    <span className="person-helpers" title={`${String(count)} subagent${count === 1 ? "" : "s"} working`}>
      {Array.from({ length: shown }, (_, index) => (
        <svg key={index} className="px-helper" viewBox="0 0 7 9" width="14" height="18">
          <rect x="1" y="0" width="5" height="1" className="px-helper-hair" />
          <rect x="1" y="1" width="5" height="2" fill={HELPER_SKINS[index % HELPER_SKINS.length]} />
          <rect x="2" y="2" width="1" height="1" className="px-eye" />
          <rect x="4" y="2" width="1" height="1" className="px-eye" />
          <rect x="1" y="3" width="5" height="4" className="px-helper-shirt" />
          <rect x="2" y="7" width="1" height="2" className="px-helper-legs" />
          <rect x="4" y="7" width="1" height="2" className="px-helper-legs" />
        </svg>
      ))}
      {count > shown && <span className="person-helpers-more">+{count - shown}</span>}
    </span>
  )
}
