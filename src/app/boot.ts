import { getHost, toHostError } from "../host"
import { initWorkflows } from "./workflowRuns"
import { initBackground } from "./background"
import { initEngines } from "./engines"
import { glassAvailable, parseState } from "./persist"
import { get, persistedSlice, set, toast, useApp } from "./store"
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
import { createStateSaver } from "./stateSaver"

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
    const [info, raw] = await Promise.all([host.info(), host.stateLoad().catch(() => null)])
    const state = parseState(raw)
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
      loaded: true,
    })
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
    set({ loaded: true })
    toast("error", `Could not load saved state: ${toHostError(error).message}`)
  }
  watchPersistence()
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

function watchPersistence(): void {
  const saver = createStateSaver({
    read: () => JSON.stringify(persistedSlice(get())),
    write: (text) => getHost().stateSave(JSON.parse(text)),
    failed: (error, attempt) => {
      if (attempt === 1) toast("error", `Could not save state: ${toHostError(error).message}`)
    },
    delayMs: SAVE_DELAY_MS,
  })
  useApp.subscribe((state, previous) => {
    if (
      state.projects === previous.projects &&
      state.threads === previous.threads &&
      state.prefs === previous.prefs &&
      state.layout === previous.layout &&
      state.learning === previous.learning &&
      state.game === previous.game
    )
      return
    saver.changed()
  })
  getHost().onQuit(() => saver.flush())
  window.addEventListener("beforeunload", () => void saver.flush())
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
