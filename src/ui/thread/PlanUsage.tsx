import { RefreshCw, Waypoints } from "lucide-react"
import { useEffect, useState } from "react"
import { currentLimits, footerWindows, planName, planReadings, resetText, shortWindowLabel, tightestWindow, toolName, usageLevel, usePlanLimits, windowKey, windowLabel, type PlanAccount, type PlanReading, type PlanSource } from "../../app/limits"
import type { ToolProxy } from "../../app/picker"
import { readAccountUsage, useAccountLabels, usageReadOffered, usePlanLimitsOn, useToolProxies, useUsageAccounts, useUsageSignIns } from "../../app/planUsage"
import { plural } from "../../lib/format"
import { cx, Popover, Spinner } from "../common"

/**
 * Plan usage as the coding tools report it: a ring per account at the rail's foot, each
 * opening its own card, the only place it shows. The context card shares the meter.
 */

/** A bar filled to `fill`, colored by how much is used; `mark` sits where the tool auto-compacts. */
export function Meter({ share, fill = share, mark, large = false, label }: { readonly share: number; readonly fill?: number; readonly mark?: number; readonly large?: boolean; readonly label: string }) {
  return (
    <div className={cx("usage-meter", large && "is-large", usageLevel(share))} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}>
      <div className="usage-meter-fill" style={{ width: `${String(Math.min(100, fill * 100))}%` }} />
      {mark !== undefined && <span className="usage-meter-mark" style={{ left: `${String(mark * 100)}%` }} title="Auto-compacts here" />}
    </div>
  )
}

export function asOf(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "As of just now"
  if (minutes < 60) return `As of ${String(minutes)} min ago`
  if (minutes < 24 * 60) return `As of ${String(Math.floor(minutes / 60))} hr ago`
  return `As of ${plural(Math.floor(minutes / (24 * 60)), "day")} ago`
}

/** Readings age and windows reset while nothing else changes, so these redraw once a minute. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** The tool's name, or the connection's own for an account signed in from a folder of its own. */
export function accountName(account: PlanAccount, labels: Readonly<Record<string, string>>): string {
  if (account.connectionId === undefined) return toolName(account.source)
  return labels[account.connectionId] ?? `${toolName(account.source)} (own sign-in)`
}

/** An explicit refresh bypasses freshness caching; concurrent reads still share one request. */
function RefreshUsage({ account, name }: { readonly account: PlanAccount; readonly name: string }) {
  const [offered, setOffered] = useState(false)
  const [reading, setReading] = useState(false)
  useEffect(() => {
    let live = true
    void usageReadOffered().then((value) => live && setOffered(value))
    return () => {
      live = false
    }
  }, [])
  return (
    <button
      type="button"
      className="usage-refresh"
      disabled={reading}
      aria-label={`Refresh ${name} usage`}
      title="Read usage now"
      onClick={() => {
        setReading(true)
        void (offered ? readAccountUsage(account, 0) : usageReadOffered().then((value) => {
          setOffered(value)
          return value ? readAccountUsage(account, 0) : undefined
        })).finally(() => setReading(false))
      }}
    >
      {reading ? <Spinner size={11} /> : <RefreshCw size={11} />}
    </button>
  )
}

/** One account's windows: a label, a bar, the share, and when it resets; and the proxy it goes through. */
function AccountUsage({ account, proxy }: { readonly account: PlanAccount; readonly proxy: ToolProxy | undefined }) {
  const stored = usePlanLimits((state) => state[account.key])
  const now = Date.now()
  const limits = currentLimits(stored, now)
  const name = accountName(account, useAccountLabels())
  const signIn = useUsageSignIns((state) => state[account.key])
  const heading = limits?.plan === undefined ? name : `${name} · ${planName(limits.plan)}`
  return (
    <div className="usage-plan">
      <div className="usage-row">
        <span className="usage-heading">{heading}</span>
        <span className="usage-meta">
          {limits !== undefined && asOf(now - limits.at)}
          <RefreshUsage account={account} name={name} />
        </span>
      </div>
      {account.source === "codex" && <p className="usage-note">{signIn === undefined ? "Codex CLI sign-in" : `Codex CLI account: ${signIn}`}{account.connectionId === undefined ? " (default profile)" : " (connection profile)"}</p>}
      {proxy !== undefined && (
        <p className="usage-route" title="Set in the tool's own settings, not by Runrail">
          <Waypoints size={12} aria-hidden="true" />
          <span className="usage-route-name">{proxyName(proxy)}</span>
          <span className="usage-route-address">{proxy.address}</span>
        </p>
      )}
      {limits === undefined && <p className="usage-note">{`${name} has no usage to show right now.`}</p>}
      {account.source === "claude-code" && !limits?.windows.some((window) => window.id === "five-hour") && (
        <div className="usage-window"><div className="usage-row"><span className="usage-label">Session limit</span><span className="usage-note">Not available yet</span></div></div>
      )}
      {limits?.windows.map((window) => {
        const reset = resetText(window.resetsAt, now)
        const label = windowLabel(window, account.source)
        return (
          <div key={windowKey(window)} className="usage-window">
            <div className="usage-row">
              <span className="usage-label">{label}</span>
              <span className="usage-meta">
                {reset !== undefined && <span>{reset}</span>}
                <span className="usage-number">{Math.round(window.usedPercent)}%</span>
              </span>
            </div>
            <Meter share={window.usedPercent / 100} label={`${label}: ${String(Math.round(window.usedPercent))}% used`} />
          </div>
        )
      })}
    </div>
  )
}

/** At the rail's foot: a ring per account with a reading, so usage shows in every view; nothing when none has one or plan limits are off. */
export function RailUsage() {
  useMinute()
  const on = usePlanLimitsOn()
  const all = usePlanLimits((state) => state)
  const labels = useAccountLabels()
  const proxies = useToolProxies()
  const accounts = useUsageAccounts((state) => state.accounts)
  if (!on) return null
  return <UsageRings readings={planReadings(all, Date.now())} accounts={accounts} labels={labels} proxies={proxies} />
}

const MONOGRAMS: Readonly<Record<PlanSource, string>> = { "claude-code": "CC", codex: "Cx" }

/** "OpenAI via Headroom proxy" as the tool's settings name it, else "Via a proxy". */
export function proxyName(proxy: ToolProxy): string {
  return proxy.name ?? "Via a proxy"
}

export function proxyText(proxy: ToolProxy): string {
  return `${proxyName(proxy)} at ${proxy.address}`
}

/** The account's proxy: only its usual login is known to go through it. */
function proxyOf(account: PlanAccount, proxies: Readonly<Partial<Record<PlanSource, ToolProxy>>>): ToolProxy | undefined {
  return account.connectionId === undefined ? proxies[account.source] : undefined
}

/** A ring filled to the tightest window, colored by how much of it is used, around the tool's letters. */
function UsageRing({ share, text }: { readonly share: number; readonly text: string }) {
  const radius = 12
  const around = 2 * Math.PI * radius
  const fill = Math.min(1, Math.max(0, share))
  return (
    <span className={cx("usage-ring", usageLevel(share))} aria-hidden="true">
      <svg viewBox="0 0 28 28" width="28" height="28">
        <circle className="usage-ring-track" cx="14" cy="14" r={radius} />
        {fill > 0 && <circle className="usage-ring-fill" cx="14" cy="14" r={radius} strokeDasharray={`${String(fill * around)} ${String(around)}`} transform="rotate(-90 14 14)" />}
      </svg>
      <span className="usage-ring-text">{text}</span>
    </span>
  )
}

export function UsageRings({ readings, accounts = [], labels, proxies = {} }: { readonly readings: readonly PlanReading[]; readonly accounts?: readonly PlanAccount[]; readonly labels: Readonly<Record<string, string>>; readonly proxies?: Readonly<Partial<Record<PlanSource, ToolProxy>>> }) {
  const entries = [...readings, ...accounts.filter((account) => !readings.some((reading) => reading.account.key === account.key)).map((account) => ({ account, limits: undefined }))]
  if (entries.length === 0) return null
  return (
    <div className="rail-usage" role="group" aria-label="Plan usage">
      {entries.map(({ account, limits }) => {
        const windows = limits === undefined ? [] : footerWindows(limits)
        const name = accountName(account, labels)
        const proxy = proxyOf(account, proxies)
        const share = (limits === undefined ? 0 : tightestWindow(limits)?.usedPercent ?? 0) / 100
        const spoken = `${name}${limits?.plan === undefined ? "" : ` ${planName(limits.plan)}`}: ${windows.length === 0 ? "usage unavailable" : windows.map((window) => `${windowLabel(window, account.source)} ${String(Math.round(window.usedPercent))}%`).join(", ")}${proxy === undefined ? "" : `; ${proxyText(proxy)}`}`
        return (
          <Popover
            key={account.key}
            side="top"
            align="start"
            width={300}
            room={360}
            className="usage-popover rail-usage-popover"
            trigger={({ toggle, ref, open }) => (
              <button ref={ref} type="button" className={cx("rail-item rail-usage-item", open && "is-open")} aria-haspopup="dialog" aria-expanded={open} aria-label={`Plan usage, ${spoken}`} onClick={toggle}>
                <UsageRing share={share} text={MONOGRAMS[account.source]} />
                <span className="rail-tip" aria-hidden="true">
                  {name}
                  {limits?.plan !== undefined && <span className="rail-tip-note">{planName(limits.plan)}</span>}
                  {account.source === "claude-code" && !windows.some((window) => window.id === "five-hour") && <span className="rail-tip-note">Session limit unavailable</span>}
                  {windows.map((window) => (
                    <span key={windowKey(window)} className={cx("rail-tip-usage", usageLevel(window.usedPercent / 100))}>
                      {shortWindowLabel(window, account.source)} {Math.round(window.usedPercent)}%
                    </span>
                  ))}
                  {proxy !== undefined && <span className="rail-tip-note">via proxy</span>}
                </span>
              </button>
            )}
          >
            {() => (
              <div className="usage-card" tabIndex={-1} data-autofocus="">
                <span className="usage-title">Plan usage</span>
                <AccountUsage account={account} proxy={proxy} />
              </div>
            )}
          </Popover>
        )
      })}
    </div>
  )
}
