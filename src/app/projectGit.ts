import { create } from "zustand"
import { toHostError } from "../host"
import { parseOr, ProjectRemotesSchema } from "../protocol/schemas"
import { systemCapability, systemRpc } from "./connections"
import { projectRpc } from "./engines"
import { connectedTo } from "./gitHosts"
import { get, noteProjectGit, projectById } from "./store"

/**
 * What each project's folder is connected to, read by the system engine from the folder itself
 *, so the sidebar mark and Settings → Projects know it before any thread runs there. A
 * thread's own remote read still refines it with the branch's upstream.
 */

/** A reading holds this long before the app reads the folder again unprompted. */
export const PROJECT_GIT_MAX_AGE_MS = 5 * 60_000

/** A project checkout's branch as last read; not saved, since it moves under the app. */
export interface ProjectHead {
  readonly branch?: string
  readonly detached: boolean
  readonly initial: boolean
  readonly head?: string
}

export const useProjectHeads = create<Readonly<Record<string, ProjectHead>>>(() => ({}))

function noteHead(projectId: string, head: ProjectHead | undefined): void {
  useProjectHeads.setState((heads) => {
    const { [projectId]: _, ...rest } = heads
    return head === undefined ? rest : { ...rest, [projectId]: head }
  }, true)
}

const readAt = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()
let supported: Promise<boolean> | undefined

function engineReads(): Promise<boolean> {
  supported ??= systemCapability("codehost.remotes").catch(() => {
    supported = undefined
    return false
  })
  return supported
}

/**
 * Reads one project's folder, once at a time, unless it was read within `maxAgeMs`. A folder on a
 * remote machine is read there, and only with `reach`, so opening the app never dials every machine.
 */
export function readProjectGit(projectId: string, maxAgeMs = PROJECT_GIT_MAX_AGE_MS, options: { readonly reach?: boolean } = {}): Promise<void> {
  if (projectById(projectId)?.remote !== undefined && options.reach !== true) return Promise.resolve()
  const running = inFlight.get(projectId)
  if (running !== undefined) return running
  const last = readAt.get(projectId)
  if (last !== undefined && Date.now() - last < maxAgeMs) return Promise.resolve()
  const read = (async () => {
    const project = projectById(projectId)
    if (project === undefined || !(await engineReads())) return
    try {
      const params = { path: project.path }
      const answer = parseOr(ProjectRemotesSchema, project.remote === undefined ? await systemRpc("codehost.remotes", params) : await projectRpc(project.id, "codehost.remotes", params))
      if (answer === undefined) return
      readAt.set(projectId, Date.now())
      noteProjectGit(projectId, answer.git ? { git: true, connectedTo: connectedTo(answer.remotes ?? []) } : { git: false })
      noteHead(
        projectId,
        answer.git && answer.detached !== undefined
          ? { detached: answer.detached, initial: answer.initial === true, ...(answer.branch === undefined ? {} : { branch: answer.branch }), ...(answer.head === undefined ? {} : { head: answer.head }) }
          : undefined,
      )
    } catch (error) {
      // A folder that moved or vanished keeps its last reading; the thread that opens it says why.
      if (toHostError(error).code !== "CONTROL_INVALID_INPUT") return
      readAt.set(projectId, Date.now())
    } finally {
      inFlight.delete(projectId)
    }
  })()
  inFlight.set(projectId, read)
  return read
}

/** Every project, one folder at a time so a long list never runs many git reads at once. */
export async function readAllProjectGit(maxAgeMs = PROJECT_GIT_MAX_AGE_MS): Promise<void> {
  for (const project of get().projects) await readProjectGit(project.id, maxAgeMs)
}

/** Projects on `host` read again at once, after the person answers which service it is. */
export async function rereadProjectsOn(host: string): Promise<void> {
  const bare = host.replace(/:\d+$/, "")
  for (const project of get().projects) if (project.connectedTo?.host?.replace(/:\d+$/, "") === bare) await readProjectGit(project.id, 0)
}

/** Test seam: forgets readings, and whether the engine reads folders unless `reads` says. */
export function resetProjectGit(reads?: boolean): void {
  readAt.clear()
  inFlight.clear()
  useProjectHeads.setState({}, true)
  supported = reads === undefined ? undefined : Promise.resolve(reads)
}
