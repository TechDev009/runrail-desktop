import { create } from "zustand"
import { getHost, HostError, toHostError, type UpdateStatus } from "../host"
import { parseOr, UpdateStatusSchema } from "../protocol/schemas"
import { get, set, toast } from "./store"

/**
 * Signed in-app updates. The host checks a signed feed and verifies every bundle before it
 * installs; the renderer only asks, shows the result, and starts the install on request.
 * Nothing is downloaded until the user chooses to install.
 */

type Available = Extract<UpdateStatus, { state: "available" }>

export type UpdatePhase =
  | { readonly phase: "idle" }
  | { readonly phase: "checking"; readonly update?: Available }
  | { readonly phase: "current"; readonly version: string; readonly checkedAt: number }
  | { readonly phase: "available"; readonly update: Available; readonly checkedAt: number }
  | { readonly phase: "installing"; readonly update: Available }
  | { readonly phase: "failed"; readonly code: string; readonly message: string; readonly update?: Available }

interface UpdateState {
  /** False in builds made without the updater; they explain instead of checking. */
  readonly supported: boolean
  readonly status: UpdatePhase
}

export const useUpdates = create<UpdateState>(() => ({ supported: false, status: { phase: "idle" } }))

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1_000

let timer: ReturnType<typeof setInterval> | undefined

function setStatus(status: UpdatePhase): void {
  useUpdates.setState({ status })
}

/** Starts background checks when the build supports updates and the user has not turned them off. */
export function initUpdates(supported: boolean): void {
  useUpdates.setState({ supported })
  if (!supported) return
  setTimeout(() => {
    if (get().prefs.checkUpdates) void checkForUpdates({ quiet: true })
  }, FIRST_CHECK_MS)
  timer ??= setInterval(() => {
    if (get().prefs.checkUpdates) void checkForUpdates({ quiet: true })
  }, CHECK_EVERY_MS)
}

/**
 * Asks the feed for a newer build. A quiet (background) check never shows an error and only
 * speaks up once per new version.
 */
export async function checkForUpdates(options: { readonly quiet?: boolean } = {}): Promise<void> {
  const { supported, status } = useUpdates.getState()
  if (!supported || status.phase === "checking" || status.phase === "installing") return
  const previous = status
  // A known update stays on screen while the feed is asked again.
  setStatus(previous.phase === "available" || (previous.phase === "failed" && previous.update !== undefined) ? { phase: "checking", update: previous.update } : { phase: "checking" })
  try {
    const result = parseOr(UpdateStatusSchema, await getHost().updateCheck())
    if (result === undefined) throw new HostError("UPDATE_INVALID_RESPONSE", "the update feed answered with something unexpected")
    if (result.state === "unavailable") {
      useUpdates.setState({ supported: false, status: { phase: "idle" } })
      return
    }
    if (result.state === "current") {
      setStatus({ phase: "current", version: result.version, checkedAt: Date.now() })
      return
    }
    setStatus({ phase: "available", update: result, checkedAt: Date.now() })
    const known = previous.phase === "available" && previous.update.version === result.version
    if (options.quiet === true && !known) toast("info", `Runrail ${result.version} is available`, { label: "View", run: () => set({ settings: "general" }) })
  } catch (error) {
    const failure = toHostError(error)
    if (options.quiet === true) setStatus(previous)
    else setStatus({ phase: "failed", code: failure.code, message: failure.message })
  }
}

/** Downloads, verifies, and installs the available update. The app restarts when it succeeds. */
export async function installUpdate(): Promise<void> {
  const { status } = useUpdates.getState()
  if (status.phase !== "available" && !(status.phase === "failed" && status.update !== undefined)) return
  const update = status.update
  if (update === undefined) return
  setStatus({ phase: "installing", update })
  try {
    await getHost().updateInstall()
  } catch (error) {
    const failure = toHostError(error)
    setStatus({ phase: "failed", code: failure.code, message: failure.message, update })
  }
}
