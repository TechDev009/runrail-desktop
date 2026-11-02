import { GithubRelayEventSchema } from "../protocol/schemas"
import type { GithubRelayEvent } from "../protocol/schemas"
import type { ThreadMeta } from "./persist"
import type { GitView } from "./store"
import { refreshPullRequests } from "./gitBar"
import { get } from "./store"
import { getHost } from "../host"

/** Relay deliveries wake the existing local PR reader; they are never accepted as CI truth. */

const POLL_MS = 60_000
const MAX_RECENT_DELIVERIES = 2_000

export function watchedThreadsForRelayEvents(
  events: readonly GithubRelayEvent[],
  threads: readonly ThreadMeta[],
  git: Readonly<Record<string, GitView>>,
): readonly string[] {
  const repositories = new Set(events.map((event) => `${event.repository.toLowerCase()}#${String(event.prNumber)}`))
  return threads
    .filter((thread) => {
      if (thread.archived === true || thread.ciWatch === undefined) return false
      const view = git[thread.id]?.pr
      if (view?.owner === undefined || view.repo === undefined) return false
      return repositories.has(`${view.owner}/${view.repo}#${String(thread.ciWatch.number)}`.toLowerCase())
    })
    .map((thread) => thread.id)
    .sort()
}

function validEvents(raw: readonly unknown[]): readonly GithubRelayEvent[] {
  const parsed: GithubRelayEvent[] = []
  for (const value of raw.slice(0, 100)) {
    const result = GithubRelayEventSchema.safeParse(value)
    if (result.success) parsed.push(result.data)
  }
  return parsed
}

/** Installs an opt-in relay poller. Local CI polling remains active as fallback/reconciliation. */
export function initCiRelay(): () => void {
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const delivered = new Set<string>()
  const inFlight = new Set<string>()
  const remember = (id: string): void => {
    delivered.add(id)
    while (delivered.size > MAX_RECENT_DELIVERIES) {
      const oldest = delivered.values().next().value as string | undefined
      if (oldest === undefined) break
      delivered.delete(oldest)
    }
  }
  const schedule = (delay = POLL_MS): void => {
    if (stopped || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void poll()
    }, delay)
  }
  const poll = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      const host = getHost()
      const status = await host.githubRelayStatus()
      if (status.state !== "paired") return
      const received = await host.githubRelayFetchEvents()
      const fresh = validEvents(received).filter((event) => {
        const key = `${event.deliveryId}:${event.event}:${event.repository}:${String(event.prNumber)}`
        return !delivered.has(key) && !inFlight.has(key)
      })
      const keys = fresh.map((event) => `${event.deliveryId}:${event.event}:${event.repository}:${String(event.prNumber)}`)
      for (const key of keys) inFlight.add(key)
      const ids = [...new Set(fresh.map((event) => event.deliveryId))]
      if (fresh.length > 0) {
        try {
          const targets = watchedThreadsForRelayEvents(fresh, get().threads, get().git)
          await Promise.allSettled(targets.map((threadId) => refreshPullRequests(threadId, "poll")))
          await host.githubRelayAcknowledge(ids)
          for (const key of keys) remember(key)
        } finally {
          for (const key of keys) inFlight.delete(key)
        }
      }
    } catch {
      // Local CI watch polling remains authoritative and recovers if the relay is offline.
    } finally {
      running = false
      schedule()
    }
  }
  const foreground = (): void => {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      void poll()
    }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", foreground)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", foreground)
    window.addEventListener("focus", foreground)
  }
  void poll()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", foreground)
    if (typeof window !== "undefined") {
      window.removeEventListener("online", foreground)
      window.removeEventListener("focus", foreground)
    }
  }
}
