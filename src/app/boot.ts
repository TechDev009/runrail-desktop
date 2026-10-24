import { getHost, toHostError } from "../host"
import { initWorkflows } from "./workflowRuns"
import { initBackground } from "./background"
import { initEngines } from "./engines"
import { glassAvailable, loadState, type StateProblem } from "./persist"
import { get, persistedSlice, set, toast, useApp, type AppState } from "./store"
import { initKeepAwake } from "./power"
import { initCiWatch } from "./ciFix"
import { initLimitResume } from "./limitResume"
import { initSelfReview } from "./selfReview"
import { initFolderGit } from "./folderGit"
import { initComputerActivity } from "./computerAgent"
import { initStayRunning } from "./stayRunning"
import { initNotifications } from "./notifications"
import { initPhone } from "./phone"
import { initQuick } from "./quick"
import { initQuests } from "./questFiles"
import { initPreviews } from "./previews"
import { readAllProjectGit } from "./projectGit"
import { initPlanUsage } from "./planUsage"
import { startPreviewOffice } from "./previewOffice"
import { unlockTones } from "../lib/tones"
import { initUpdates } from "./updates"
import { createStateSaver, warnOnFailure } from "./stateSaver"

const SAVE_DELAY_MS = 400

let started = false

/** Loads persisted desktop state, wires engine events, and saves changes (debounced). */
export async function boot(): Promise<void> {
  if (started) return
  started = true
  const host = getHost()
  initEngines()
  initBackground()
  initPreviews()
  try {
    const [info, saved] = await Promise.all([host.info(), loadState(() => host.stateLoad())])
    const state = saved.state
    // macOS draws traffic lights over the content; CSS leaves room for them.
    document.documentElement.dataset.platform = info.platform
    set({
      ...state,
      // Office mode set to open on the floor shows it from the first frame.
      ...(state.prefs.officeMode === "office" ? { view: { kind: "office" } as const } : {}),
      platform: info.platform,
      hostVersion: info.version,
      ...(info.credentialStore === undefined ? {} : { credentialStore: info.credentialStore }),
      clipboardSecrets: info.clipboardSecrets === true,
      ...(saved.problem === undefined ? {} : { stateHeld: saved.problem }),
      loaded: true,
    })
    if (saved.problem !== undefined) toast("error", heldWords(saved.problem, saved.message))
    startPreviewOffice()
    initUpdates(info.updates === true)
    host
      .openInApps()
      .then((openIn) => set({ openIn }))
      .catch(() => undefined)
    // What each project is connected to, read once the window is usable so it never slows startup.
    window.setTimeout(() => void readAllProjectGit(), 2_000)
    // Each account's plan usage, one tool at a time, the same way.
    initPlanUsage(2_000)
    // Read by the startup budget in docs/PERFORMANCE.md: launch to a usable window.
    performance.mark("runrail:ready")
    host
      .startupReady()
      .then((timing) => timing !== null && set({ startupMs: timing.readyMs }))
      .catch(() => undefined)
  } catch (error) {
    const message = toHostError(error).message
    if (get().loaded) toast("error", `Could not load saved state: ${message}`)
    else {
      set({ loaded: true, stateHeld: "unreadable" })
      toast("error", heldWords("unreadable", message))
    }
  }
  const saving = persistChanges(get().stateHeld)
  window.addEventListener("beforeunload", () => void saving.flush())
  initQuests()
  initWorkflows()
  initKeepAwake()
  initLimitResume()
  initCiWatch()
  initSelfReview()
  initFolderGit()
  initComputerActivity()
  initStayRunning()
  initNotifications()
  initPhone()
  initQuick()
  unlockTones()
  applyTheme()
  useApp.subscribe((state, previous) => {
    const prefs = state.prefs
    const before = previous.prefs
    if (prefs.theme !== before.theme || prefs.palette !== before.palette || prefs.accent !== before.accent || prefs.density !== before.density || prefs.sidebarGlass !== before.sidebarGlass || prefs.textSize !== before.textSize || prefs.uiFont !== before.uiFont || prefs.codeFont !== before.codeFont || prefs.motion !== before.motion) applyTheme()
  })
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme)
}

/** What the person is told when this session will not save: at startup, and again at their first change. */
export function heldWords(problem: StateProblem, message?: string): string {
  if (problem === "unknown-version") return "Your saved projects and threads are from a different version of Runrail, so changes in this window will not be saved over them. Update Runrail to keep working with them."
  return `Could not read your saved projects and threads${message === undefined ? "" : ` (${message})`}, so changes in this window will not be saved over them. Quit and reopen Runrail to try again.`
}

/**
 * Saves the desktop state as it changes. When the saved state was not read at startup nothing is
 * written for the rest of the session, so the file on disk stays as it was.
 */
export function persistChanges(held: StateProblem | undefined): { readonly flush: () => Promise<void>; readonly stop: () => void } {
  const host = getHost()
  if (held !== undefined) {
    const stopQuit = host.onQuit(() => Promise.resolve())
    const stopWatch = useApp.subscribe((state, previous) => {
      if (!persistedChange(state, previous)) return
      stopWatch()
      toast("error", heldWords(held))
    })
    return {
      flush: () => Promise.resolve(),
      stop: () => {
        stopWatch()
        stopQuit()
      },
    }
  }
  const saver = createStateSaver({
    read: () => JSON.stringify(persistedSlice(get())),
    write: (text) => host.stateSave(JSON.parse(text)),
    failed: (error, attempt) => {
      if (!warnOnFailure(attempt)) return
      const failure = toHostError(error)
      toast("error", failure.code === "STATE_LIMIT" ? "Could not save state: there is too much to save. Delete archived threads you no longer need." : `Could not save state: ${failure.message}`)
    },
    delayMs: SAVE_DELAY_MS,
  })
  const stopWatch = useApp.subscribe((state, previous) => {
    if (persistedChange(state, previous)) saver.changed()
  })
  const stopQuit = host.onQuit(() => saver.flush())
  return {
    flush: () => saver.flush(),
    stop: () => {
      stopWatch()
      stopQuit()
    },
  }
}

function persistedChange(state: AppState, previous: AppState): boolean {
  return (
    state.projects !== previous.projects ||
    state.threads !== previous.threads ||
    state.prefs !== previous.prefs ||
    state.layout !== previous.layout ||
    state.learning !== previous.learning ||
    state.game !== previous.game
  )
}

function applyTheme(): void {
  const { prefs, platform } = get()
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && systemDark)
  const root = document.documentElement
  root.dataset.theme = dark ? "dark" : "light"
  // macOS draws the sidebar material in the system's own light or dark look, so it is used only
  // when the app's theme matches it; otherwise the sidebar is solid. Its gray would also wash out a
  // flower palette's tint, so glass is for the default palette only.
  root.dataset.glass = glassAvailable(platform) && prefs.sidebarGlass && dark === systemDark && prefs.palette === "default" ? "on" : "off"
  root.dataset.palette = prefs.palette
  root.dataset.accent = prefs.accent
  root.dataset.density = prefs.density
  root.dataset.textSize = prefs.textSize
  root.dataset.uiFont = prefs.uiFont
  root.dataset.codeFont = prefs.codeFont
  root.dataset.motion = prefs.motion
}
