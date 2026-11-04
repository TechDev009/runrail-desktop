import { useMemo, useState } from "react"
import { confirmAction } from "../../app/actions"
import { clearUsageHistory, setUsageEnabled, usageDayKey, usageSummary, type UsageRange } from "../../app/usageHistory"
import { useApp } from "../../app/store"
import { Button, Select, Toggle } from "../common"

type Range = 7 | 30 | 90 | 365 | "all"

function rangeBounds(range: Range): UsageRange {
  if (range === "all") return {}
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const from = new Date(now)
  from.setDate(from.getDate() - (range - 1))
  return { from: usageDayKey(from.getTime()), to: usageDayKey(now.getTime()) }
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM"
  const value = hour % 12 === 0 ? 12 : hour % 12
  return String(value) + " " + suffix
}

function dayLabel(day: string): string {
  const date = new Date(day + "T12:00:00")
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function Card({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint?: string }) {
  return (
    <div className="usage-card">
      <span className="usage-card-label">{label}</span>
      <strong className="usage-card-value">{value}</strong>
      {hint !== undefined && <span className="usage-card-hint">{hint}</span>}
    </div>
  )
}

export function UsageView() {
  const history = useApp((state) => state.usageHistory)
  const [range, setRange] = useState<Range>(30)
  const summary = useMemo(() => usageSummary(history, rangeBounds(range)), [history, range])
  const days = useMemo(() => {
    const filtered = history.days.filter((day) => {
      const bounds = rangeBounds(range)
      return (bounds.from === undefined || day.day >= bounds.from) && (bounds.to === undefined || day.day <= bounds.to)
    })
    return filtered.slice(-14)
  }, [history.days, range])
  const enable = (on: boolean): void => {
    setUsageEnabled(on)
  }
  return (
    <main className="usage-view">
      <header className="usage-head">
        <div>
          <h1>Usage history</h1>
          <p>Local activity summaries stay on this computer. Runrail never sends them anywhere.</p>
        </div>
        <Toggle label="Store local usage history" checked={history.enabled} onChange={enable} />
      </header>
      {!history.enabled ? (
        <section className="usage-empty">
          <h2>Usage history is off</h2>
          <p>Turn it on to count future messages, turns, active days, and model selections. Existing sessions are not backfilled.</p>
          <Button variant="primary" onClick={() => enable(true)}>Turn on local history</Button>
        </section>
      ) : (
        <>
          <div className="usage-toolbar">
            <label>
              <span className="sr-only">Date range</span>
              <Select value={range} onChange={(value) => setRange(value === "all" ? "all" : Number(value) as Range)} label="Date range">
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
                <option value={365}>Last year</option>
                <option value="all">All retained history</option>
              </Select>
            </label>
            <Button variant="ghost" size="sm" onClick={() => confirmAction({
                title: "Clear usage history?",
                body: "This removes the local activity summaries saved on this computer.",
                confirm: "Clear history",
                danger: true,
                onConfirm: clearUsageHistory,
              })}>Clear history</Button>
          </div>
          <section className="usage-cards" aria-label="Usage summary">
            <Card label="Messages" value={String(summary.messages)} />
            <Card label="Agent turns" value={String(summary.turns)} />
            <Card label="Active days" value={String(summary.activeDays)} />
            <Card label="Current streak" value={String(summary.currentStreak)} hint="days" />
            <Card label="Longest streak" value={String(summary.longestStreak)} hint="days" />
            <Card label="Peak hour" value={summary.peakHours.length === 0 ? "No data" : summary.peakHours.map(hourLabel).join(", ")} hint="local time" />
          </section>
          <section className="usage-panel">
            <div className="usage-panel-head">
              <div>
                <h2>Token reporting</h2>
                <p>Token totals remain unavailable until the connected engine reports durable per-turn usage.</p>
              </div>
              <span className="usage-status">Unavailable</span>
            </div>
          </section>
          <section className="usage-panel">
            <h2>By model</h2>
            {summary.models.length === 0 ? <p className="usage-muted">No model selections recorded in this range.</p> : (
              <div className="usage-models" role="list">
                {summary.models.map((model) => (
                  <div key={model.key} className="usage-model-row" role="listitem">
                    <span>{model.key}</span>
                    <strong>{String(model.turns)} turns</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="usage-panel">
            <h2>Recent activity</h2>
            {days.length === 0 ? <p className="usage-muted">No activity in this range.</p> : (
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <caption className="sr-only">Recent activity by local day</caption>
                  <thead><tr><th scope="col">Day</th><th scope="col">Messages</th><th scope="col">Turns</th><th scope="col">Active hours</th></tr></thead>
                  <tbody>
                    {days.map((day) => <tr key={day.day}><th scope="row">{dayLabel(day.day)}</th><td>{day.messages}</td><td>{day.turns}</td><td>{day.activeHours.length === 0 ? "None" : day.activeHours.map(hourLabel).join(", ")}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="usage-foot">Stored locally for up to 36 months. This history does not include prompts, transcripts, files, paths, credentials, or account details.</p>
        </>
      )}
    </main>
  )
}
