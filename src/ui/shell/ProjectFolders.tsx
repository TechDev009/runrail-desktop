import { Folder, Plus, X } from "lucide-react"
import { restartEngines } from "../../app/engines"
import { MAX_PROJECT_FOLDERS, type Project } from "../../app/persist"
import { setProjectFolders, toast } from "../../app/store"
import { getHost, toHostError } from "../../host"
import { basename, dirname } from "../../lib/format"

/**
 * A project's related folders in Settings → Projects. Threads keep running in the
 * project's folder; the agent may also read and edit these, and the Files and Review panes can
 * switch to each. A folder comes from the system's folder dialog, which is what lets an engine use it.
 */

/** Whether one path is the other or holds it. */
export function foldersOverlap(a: string, b: string): boolean {
  const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`)
  return within(a, b) || within(b, a)
}

export function ProjectFolders({ project }: { readonly project: Project }) {
  const folders = project.folders ?? []
  const change = (next: readonly string[]): void => {
    setProjectFolders(project.id, next)
    // Engines take their folders when they start; a running turn finishes first.
    restartEngines(project.id)
  }
  const add = async (): Promise<void> => {
    try {
      const picked = await getHost().workspacePick({ near: dirname(project.path) || project.path, related: true })
      if (picked === null) return
      const clash = [project.path, ...folders].find((path) => foldersOverlap(path, picked.path))
      if (clash !== undefined) {
        toast("error", clash === project.path ? `${picked.name} is ${project.name}'s own folder, or inside or around it.` : `${picked.name} is already a related folder, or inside or around one.`)
        return
      }
      change([...folders, picked.path])
    } catch (error) {
      toast("error", `Could not add the folder: ${toHostError(error).message}`)
    }
  }
  return (
    <span className="project-folders">
      {folders.map((path) => (
        <span key={path} className="project-folder" title={path}>
          <Folder size={12} aria-hidden="true" />
          {basename(path)}
          <button type="button" className="project-folder-remove" aria-label={`Remove ${basename(path)}`} onClick={() => change(folders.filter((item) => item !== path))}>
            <X size={11} />
          </button>
        </span>
      ))}
      {folders.length < MAX_PROJECT_FOLDERS && (
        <button type="button" className="link-button project-folder-add" onClick={() => void add()} title="A folder the agent may also read and edit, such as another repository this project works with">
          <Plus size={12} aria-hidden="true" /> Add folder
        </button>
      )}
    </span>
  )
}
