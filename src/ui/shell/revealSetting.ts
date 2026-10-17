import { set } from "../../app/store"

/**
 * Brings a row into view and marks it for a moment, after a search or a link from elsewhere. A page
 * still loading its rows is looked at again for a short while.
 */
export function revealSetting(id: string, tries = 30): void {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(id)}"]`)
    if (row === null) {
      if (tries > 0) window.setTimeout(() => revealSetting(id, tries - 1), 50)
      return
    }
    row.scrollIntoView({ block: "center", behavior: "smooth" })
    row.classList.add("is-found")
    window.setTimeout(() => row.classList.remove("is-found"), 1_600)
  })
}

/** Settings → Projects at one project's row, where its git line and GitHub CLI switch are. */
export function openProjectSettings(projectId: string): void {
  set({ settings: "projects" })
  revealSetting(`project-${projectId}`)
}

/** Settings → Permissions at computer use, where the apps agents may use are listed. */
export function openComputerSettings(): void {
  set({ settings: "permissions" })
  revealSetting("computer-use")
}
