import { getHost } from "../host"
import type { EvalRun, SetupRun, WorkflowRun, WorkflowUpcoming } from "../protocol/schemas"
import { isBusy } from "../thread/reducer"
import { useEvals } from "./evals"
import { syncAllSources, syncingSources, syncsSources, useMemory } from "./memory"
import { tellMenuBar } from "./notifications"
import { words } from "./platformWords"
import { guardRuns } from "./power"
import { active as setupActive, useSetups } from "./setups"
import { get, setPrefs, toast, useApp, type ThreadRuntime } from "./store"
import { active as workflowActive, useUpcoming, useWorkflows } from "./workflowRuns"

/**
 * What keeps Runrail in the menu bar when its window closes: a turn running or
 * queued, a workflow, setup or eval run going, a workflow that starts by itself, or memory sources
 * that sync hourly. While any holds, the host hides the window instead of quitting; hidden, it
 * quits a minute after the last one ends. The menu bar item's lines come from here too.
 */
export type StayReason = "turn" | "workflow-run" | "setup-run" | "eval-run" | "schedule" | "memory-sync" | "limit-wait"

export interface StayInput {
  readonly runtime: Readonly<Record<string, ThreadRuntime>>
  readonly workflowRuns: readonly Pick<WorkflowRun, "state" | "waiting">[]
  readonly setupRuns: readonly Pick<SetupRun, "state" | "waiting">[]
  readonly evalRuns: readonly Pick<EvalRun, "state">[]
  readonly upcoming?: WorkflowUpcoming
  readonly sources: boolean
  /** Threads waiting to continue once a usage limit resets. */
  readonly limitWaits?: number
}

export function stayReasons(input: StayInput): StayReason[] {
  const reasons: StayReason[] = []
  if (Object.values(input.runtime).some((runtime) => isBusy(runtime.timeline) || runtime.queue.length > 0)) reasons.push("turn")
  if (input.workflowRuns.some(workflowActive)) reasons.push("workflow-run")
  if (input.setupRuns.some(setupActive)) reasons.push("setup-run")
  if (input.evalRuns.some((run) => run.state === "running")) reasons.push("eval-run")
  if ((input.upcoming?.armed ?? 0) > 0) reasons.push("schedule")
  if (input.sources) reasons.push("memory-sync")
  if ((input.limitWaits ?? 0) > 0) reasons.push("limit-wait")
  return reasons
}

/**
 * Opened by the wake service after Quit: only work under way keeps the app, not a
 * schedule still to come or sources that sync hourly, since the service opens it again for those.
 */
export function wokenReasons(reasons: readonly StayReason[], syncing: boolean): StayReason[] {
  const kept = reasons.filter((reason) => reason !== "schedule" && reason !== "memory-sync")
  return syncing ? [...kept, "memory-sync"] : kept
}

/** The menu bar item's lines: what runs and waits, then the next scheduled run. */
export function stayLines(input: StayInput, now: number): string[] {
  const timelines = Object.values(input.runtime).map((runtime) => runtime.timeline)
  const running = timelines.filter((timeline) => isBusy(timeline) && timeline.status !== "waiting").length
  const waiting =
    timelines.filter((timeline) => timeline.status === "waiting").length +
    input.workflowRuns.filter((run) => run.waiting !== undefined).length +
    input.setupRuns.filter((run) => run.waiting?.kind === "approve").length
  const limited = input.limitWaits ?? 0
  const parts = [...(running > 0 ? [`${String(running)} running`] : []), ...(waiting > 0 ? [`${String(waiting)} waiting for you`] : []), ...(limited > 0 ? [`${String(limited)} waiting for a usage limit`] : [])]
  const next = input.upcoming?.next
  return [parts.length === 0 ? "Nothing running" : parts.join(", "), ...(next === undefined ? [] : [`Next: ${next.name}, ${when(next.at, now)}`])]
}

/** "now", "at 14:30", "tomorrow at 02:00", or "Mon at 09:00". */
export function when(at: number, now: number): string {
  return at - now < 60_000 ? "now" : clock(at, now)
}

/** "at 14:30", "tomorrow at 02:00", or "Mon at 09:00", however soon. */
export function clock(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const day = (value: number) => new Date(value).toDateString()
  if (day(at) === day(now)) return `at ${time}`
  if (day(at) === day(now + 86_400_000)) return `tomorrow at ${time}`
  return `${new Date(at).toLocaleDateString([], { weekday: "short" })} at ${time}`
}

function current(): StayInput {
  const upcoming = useUpcoming.getState().upcoming
  return {
    runtime: get().runtime,
    workflowRuns: Object.values(useWorkflows.getState().runs).map((entry) => entry.run),
    setupRuns: Object.values(useSetups.getState().runs).map((entry) => entry.run),
    evalRuns: Object.values(useEvals.getState().runs).map((entry) => entry.run),
    ...(upcoming === undefined ? {} : { upcoming }),
    sources: syncsSources(),
    limitWaits: get().threads.filter((thread) => thread.resume !== undefined && thread.archived !== true).length,
  }
}

let sent: string | undefined
/** Opened by the wake service, until the person opens the window. */
let woken = false

function sync(): void {
  const input = current()
  const reasons = woken ? wokenReasons(stayReasons(input), syncingSources()) : stayReasons(input)
  const lines = stayLines(input, Date.now())
  guardRuns(reasons.some((reason) => reason === "workflow-run" || reason === "setup-run" || reason === "eval-run"))
  const key = JSON.stringify([reasons, lines])
  if (key === sent) return
  sent = key
  void getHost()
    .backgroundHold(reasons, lines)
    .catch(() => {
      sent = undefined
    })
}

export function initStayRunning(): void {
  sync()
  useApp.subscribe((state, previous) => {
    if (state.runtime !== previous.runtime || state.threads !== previous.threads) sync()
  })
  for (const store of [useWorkflows, useSetups, useEvals, useUpcoming, useMemory] as const) store.subscribe(() => sync())
  void getHost()
    .launchWoken()
    .then((value) => {
      if (!value) return
      woken = true
      sync()
      void syncAllSources(get().projects.map((project) => project.id))
    })
    .catch(() => undefined)
  // Told once: as a notification on closing, or, with notifications off, when the window is back.
  getHost().onBackground((hidden, tray) => {
    if (!hidden && woken) {
      woken = false
      sync()
    }
    if (get().prefs.toldMenuBar) return
    // A Linux desktop without a tray keeps Runrail running unseen; launching it again shows the window.
    const { menuBar, quitKeys } = words()
    if (!hidden) {
      toast("info", `Runrail kept running in ${tray ? menuBar : "the background"} while its window was closed, because work was pending. Quit it with ${quitKeys}${tray ? ` or from ${menuBar}` : ""}.`)
      setPrefs({ toldMenuBar: true })
      return
    }
    void tellMenuBar(`It keeps your schedules and runs going while its window is closed. Open Runrail to see it again${tray ? `, or quit it from ${menuBar}` : ""}.`).then((told) => {
      if (told) setPrefs({ toldMenuBar: true })
    })
  })
  // "at 14:30" turns into "now" without anything else changing.
  setInterval(sync, 60_000)
}
