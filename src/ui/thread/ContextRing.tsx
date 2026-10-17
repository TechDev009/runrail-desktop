import { Shrink } from "lucide-react"
import { useEffect, useState } from "react"
import { rememberWindow, useContextWindows, windowKey } from "../../app/contextWindows"
import { compactThread, refreshThreadUsage, threadRpc } from "../../app/engines"
import { usageLevel } from "../../app/limits"
import { useApp } from "../../app/store"
import { rememberedContext } from "../../app/threadContext"
import type { BackendId } from "../../host/types"
import { compact, duration, plural, usd } from "../../lib/format"
import { MetricsSchema, parseOr, type Metrics } from "../../protocol/schemas"
import type { ContextUsage } from "../../thread/reducer"
import { cx, Popover } from "../common"
import { Meter } from "./PlanUsage"

/**
 * How full the model's context is. The engine reports the latest request's prompt plus answer; the
 * window comes from the engine, else the model's listing, else what the model last reported.
 */

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface ContextReading {
  readonly used: number
  readonly window: number
  /** Share used, 0 to 1. */
  readonly share: number
  /** The share where the coding tool compacts on its own, when it says. */
  readonly autoCompact?: number
  readonly estimated: boolean
}

/** Before the first answer nothing is in the context yet, so a known window reads as empty. */
export function readContext(usage: ContextUsage | undefined, fallbackWindow: number | undefined): ContextReading | undefined {
  const window = usage?.windowTokens ?? fallbackWindow
  if (window === undefined || window <= 0) return undefined
  const used = usage?.usedTokens ?? 0
  const point = usage?.autoCompactAt
  const autoCompact = point !== undefined && point < window ? point / window : undefined
  return { used, window, share: Math.min(1, used / window), ...(autoCompact === undefined ? {} : { autoCompact }), estimated: usage?.estimated ?? false }
}

/** Below this share, the ring set to show only near a full context stays hidden. */
export const NEAR_FULL = 0.8

type Display = "used" | "near-full"

function shownPercent(reading: ContextReading): { readonly fraction: number; readonly percent: number; readonly shown: "used" } {
  return { fraction: reading.share, percent: Math.round(reading.share * 100), shown: "used" }
}

export function contextSentence(reading: ContextReading, _display?: Display): string {
  const { percent, shown } = shownPercent(reading)
  return `${String(percent)}% ${shown}`
}

type Compaction = "ready" | "busy" | "compacting"

const COMPACT_NOTE: Record<Compaction, string> = {
  ready: "Summarize earlier turns to free up room",
  busy: "Once this turn ends",
  compacting: "New messages wait until it's done",
}

/** What this thread's session has used so far, as the engine counts it. */
function ThreadUsage({ metrics, backend }: { readonly metrics: Metrics; readonly backend: BackendId | undefined }) {
  // Each kind keeps one color mark; the numbers stay in the text color, which reads on every theme.
  const tiles: [string, string, string][] = [
    ["In", compact(metrics.inputTokens ?? 0), "is-in"],
    ["Out", compact(metrics.outputTokens ?? 0), "is-out"],
    ["Tools", compact(metrics.toolCalls ?? 0), "is-tools"],
    ["Turns", compact(metrics.runs ?? 0), "is-turns"],
  ]
  const meta = [
    // A coding tool calls its model itself and does not say how often.
    backend === "native" ? plural(metrics.modelCalls ?? 0, "model call") : undefined,
    // A subscription reports no cost; $0.00 would read as free.
    metrics.costUsd !== undefined && metrics.costUsd > 0 ? usd(metrics.costUsd) : undefined,
    metrics.elapsedMs === undefined ? undefined : duration(metrics.elapsedMs),
  ].filter((part) => part !== undefined)
  return (
    <div className="usage-thread">
      <div className="usage-row">
        <span className="usage-heading">This thread</span>
        {meta.length > 0 && <span className="usage-meta">{meta.join(" · ")}</span>}
      </div>
      <div className="usage-tiles">
        {tiles.map(([label, value, tone]) => (
          <div key={label} className={cx("usage-tile", tone)}>
            <span className="usage-tile-label">{label}</span>
            <span className="usage-tile-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The session's counts, read when the card opens. */
function useMetrics(threadId: string): Metrics | undefined {
  const engine = useApp((state) => state.runtime[threadId]?.engine)
  const [metrics, setMetrics] = useState<Metrics | undefined>()
  useEffect(() => {
    if (engine !== "ready") return
    let live = true
    threadRpc(threadId, "metrics.snapshot", {})
      .then((value) => live && setMetrics(parseOr(MetricsSchema, value)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [threadId, engine])
  return metrics
}

function ContextCard({
  threadId,
  backend,
  reading,
  used,
  display,
  compaction,
  close,
}: {
  readonly threadId: string
  readonly backend: BackendId | undefined
  readonly reading: ContextReading | undefined
  readonly used: number
  readonly display: Display
  readonly compaction: Compaction | undefined
  readonly close: () => void
}) {
  const metrics = useMetrics(threadId)
  // Reads the context share now; a plan reading it brings goes to the sidebar footer.
  useEffect(() => refreshThreadUsage(threadId), [threadId])
  const ran = (metrics?.runs ?? 0) > 0
  const share = reading?.share ?? 0
  const shown = reading === undefined ? undefined : shownPercent(reading)
  const mark = reading?.autoCompact
  return (
    <div className="usage-card" tabIndex={-1} data-autofocus="">
      <div className="usage-row">
        <span className="usage-title">Context</span>
        {shown === undefined ? (
          <span className="usage-percent">
            {compact(used)}
            <span className="usage-percent-unit">tokens</span>
          </span>
        ) : (
          <span className={cx("usage-percent", usageLevel(share))}>
            {shown.percent}%<span className="usage-percent-unit">{shown.shown}</span>
          </span>
        )}
      </div>
      <Meter
        share={share}
        fill={shown?.fraction ?? 0}
        large
        {...(mark === undefined ? {} : { mark })}
        label={reading === undefined ? "Context" : `Context ${contextSentence(reading, display)}${reading.autoCompact === undefined ? "" : `, auto-compacts at ${String(Math.round(reading.autoCompact * 100))}% used`}`}
      />
      {reading === undefined ? (
        <p className="usage-note">The window's size comes with the model's first answer.</p>
      ) : (
        <div className="usage-row usage-sub">
          <span>{used === 0 ? "Nothing in context yet" : `${compact(used)} used`}</span>
          <span>
            {compact(Math.max(0, reading.window - used))} left of {compact(reading.window)}
            {reading.estimated ? ", estimated" : ""}
          </span>
        </div>
      )}
      {metrics !== undefined && ran && (
        <>
          <div className="usage-sep" />
          <ThreadUsage metrics={metrics} backend={backend} />
        </>
      )}
      {compaction !== undefined && (
        <>
          <div className="usage-sep" />
          <button
            type="button"
            className="usage-action"
            disabled={compaction !== "ready"}
            onClick={() => {
              close()
              void compactThread(threadId)
            }}
          >
            <Shrink size={14} aria-hidden="true" />
            <span className="usage-action-text">
              <span className="usage-action-label">{compaction === "compacting" ? "Compacting…" : "Compact now"}</span>
              <span className="usage-note">{COMPACT_NOTE[compaction]}</span>
            </span>
          </button>
        </>
      )}
    </div>
  )
}

/**
 * The context ring and share beside the model chip. It opens a card with how full the context is,
 * what the thread has used, and Compact. Plan usage lives in the sidebar footer.
 */
export function ContextRing({
  threadId,
  backend,
  model,
  usage: liveUsage,
  fallbackWindow,
  compaction,
}: {
  readonly threadId: string
  readonly backend: BackendId | undefined
  readonly model: string | undefined
  readonly usage: ContextUsage | undefined
  readonly fallbackWindow: number | undefined
  /** Whether Compact is offered: undefined where the engine cannot compact. */
  readonly compaction: Compaction | undefined
}) {
  const display = useApp((state) => state.prefs.contextDisplay)
  const key = windowKey(backend, model)
  const remembered = useContextWindows((state) => state[key])
  const usage = liveUsage ?? rememberedContext(threadId)
  const reported = usage?.windowTokens
  useEffect(() => {
    if (reported !== undefined) rememberWindow(key, reported)
  }, [key, reported])
  const reading = readContext(usage, fallbackWindow ?? remembered)
  // Set to show only near a full context, the ring stays out of the way until then.
  if (display === "near-full" && (reading === undefined || reading.share < NEAR_FULL)) return null
  const share = reading?.share ?? 0
  const used = reading?.used ?? usage?.usedTokens ?? 0
  const sentence = reading === undefined ? `${compact(used)} tokens used` : contextSentence(reading, display)
  const shown = reading === undefined ? undefined : shownPercent(reading)
  return (
    <Popover
      side="top"
      align="center"
      width={300}
      room={220}
      className="usage-popover"
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          className={cx("context-ring", usageLevel(share), reading === undefined && "is-empty", open && "is-open", compaction === "compacting" && "is-compacting")}
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={compaction === "compacting" ? `Compacting context, ${sentence}` : `Context ${sentence}`}
          title={compaction === "compacting" ? "Compacting context…" : reading === undefined ? `Context · ${sentence}` : `Context ${sentence} · ${compact(used)} of ${compact(reading.window)} tokens`}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle className="context-ring-track" cx="8" cy="8" r={RADIUS} />
            <circle className="context-ring-fill" cx="8" cy="8" r={RADIUS} strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - (shown?.fraction ?? 0))} />
          </svg>
          {shown !== undefined && <span className="context-ring-value">{shown.percent}%</span>}
        </button>
      )}
    >
      {(close) => <ContextCard threadId={threadId} backend={backend} reading={reading} used={used} display={display} compaction={compaction} close={close} />}
    </Popover>
  )
}
