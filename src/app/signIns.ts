import { getHost, type SignInsSupport } from "../host"
import { get, set } from "./store"

/**
 * Saved browser sign-ins. A project the person opts in has its browser previews'
 * cookies kept by the host, sealed, and handed to its next preview. Turning it off forgets them.
 */

/** The project whose sign-ins a thread's new browser previews start with, when it keeps them. */
export function signInProject(threadId: string): string | undefined {
  const state = get()
  const projectId = state.threads.find((thread) => thread.id === threadId)?.projectId
  const project = state.projects.find((item) => item.id === projectId)
  return project?.browserSignIns === true ? project.id : undefined
}

export async function setBrowserSignIns(projectId: string, on: boolean): Promise<void> {
  set((state) => ({
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project
      const { browserSignIns: _previous, ...rest } = project
      return on ? { ...rest, browserSignIns: true as const } : rest
    }),
  }))
  if (!on) await getHost().signInsForget(projectId)
}

let support: Promise<SignInsSupport> | undefined

/** Asked once a launch: Linux keeps the key in a Secret Service keyring, which may not run. */
export function signInsSupport(): Promise<SignInsSupport> {
  support ??= getHost()
    .signInsSupport()
    .catch(() => ({ available: true }))
  return support
}

export function forgetSignIns(projectId: string): Promise<void> {
  return getHost().signInsForget(projectId)
}
