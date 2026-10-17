import { isBusy } from "../thread/reducer"
import { getHost } from "../host"
import { get, useApp } from "./store"

/**
 * While any thread runs a turn: asks the host to hold off sleep, when the person turned that on,
 * and to ask before quitting. The host ties the hold to its own process, so a crash cannot leave
 * the Mac awake.
 */
type Hold = "off" | "system" | "display"

/**
 * Keeps one host setting at what the app wants: one call at a time, the latest wish sent last, and
 * after a failed call the host's state counts as unknown and is set again a little later.
 */
export function hostSetting<T>(initial: T, send: (value: T) => Promise<unknown>, retryMs = 5_000): (want: T) => void {
  let applied: { readonly value: T } | undefined = { value: initial }
  let wanted = initial
  let sending = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const apply = (): void => {
    if (sending || (applied !== undefined && Object.is(applied.value, wanted))) return
    sending = true
    const value = wanted
    send(value).then(
      () => {
        applied = { value }
        sending = false
        apply()
      },
      () => {
        applied = undefined
        sending = false
        clearTimeout(retry)
        retry = setTimeout(apply, retryMs)
      },
    )
  }
  return (want) => {
    wanted = want
    apply()
  }
}

let setHold: ((hold: Hold) => void) | undefined
let setGuard: ((on: boolean) => void) | undefined
let runsGoing = false

function sync(): void {
  const state = get()
  const busy = Object.values(state.runtime).some((runtime) => isBusy(runtime.timeline))
  setHold?.(!busy || !state.prefs.keepAwake ? "off" : state.prefs.keepDisplayAwake ? "display" : "system")
  setGuard?.((busy || runsGoing) && state.prefs.confirmQuit)
}

/** A workflow, setup or eval run is going; it lives in its project's engine, so Quit ends it too. */
export function guardRuns(on: boolean): void {
  if (runsGoing === on) return
  runsGoing = on
  sync()
}

export function initKeepAwake(): void {
  setHold = hostSetting<Hold>("off", (hold) => getHost().keepAwake(hold !== "off", hold === "display"))
  setGuard = hostSetting(false, (on) => getHost().quitGuard(on))
  sync()
  useApp.subscribe((state, previous) => {
    if (state.runtime !== previous.runtime || state.prefs !== previous.prefs) sync()
  })
}
