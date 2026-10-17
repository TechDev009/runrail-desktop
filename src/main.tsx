import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@xterm/xterm/css/xterm.css"
import "./styles/tokens.css"
import "./styles/app.css"
import { boot } from "./app/boot"
import { useApp } from "./app/store"
import { initHost } from "./host"
import { App } from "./ui/shell/App"

/** Longer than the splash's fade in index.html, for a hidden window whose frames never run. */
const SPLASH_REMOVE_MS = 1_000

/** Fades out the splash index.html draws, once the saved state is in and the app renders under it. */
function hideSplash(): void {
  const splash = document.getElementById("splash")
  if (splash === null) return
  window.setTimeout(() => splash.remove(), SPLASH_REMOVE_MS)
  // On the next frame the app has rendered and boot has put the motion setting on the page.
  requestAnimationFrame(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce") {
      splash.remove()
      return
    }
    splash.addEventListener("transitionend", () => splash.remove(), { once: true })
    splash.classList.add("is-gone")
  })
}

function whenLoaded(run: () => void): void {
  if (useApp.getState().loaded) {
    run()
    return
  }
  const stop = useApp.subscribe((state) => {
    if (!state.loaded) return
    stop()
    run()
  })
}

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
whenLoaded(hideSplash)
void initHost().then(() => {
  void boot()
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
