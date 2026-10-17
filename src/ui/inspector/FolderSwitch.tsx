import { Folder } from "lucide-react"
import { showFolder, useShownFolder, useThreadFolders } from "../../app/folderGit"
import { basename } from "../../lib/format"
import { useProject, useThread } from "../hooks"

/** Which folder the Files and Review panes show: the thread's own, or one of the project's related folders. */
export function FolderSwitch({ threadId }: { readonly threadId: string }) {
  const folders = useThreadFolders(threadId)
  const shown = useShownFolder(threadId)
  const project = useProject(useThread(threadId)?.projectId)
  if (folders.length === 0) return null
  return (
    <div className="folder-switch">
      <Folder size={12} aria-hidden="true" />
      <select className="select select-sm" aria-label="Folder" value={shown ?? ""} title={shown} onChange={(event) => showFolder(threadId, event.target.value.length === 0 ? undefined : event.target.value)}>
        <option value="">{project?.name ?? "This project"}</option>
        {folders.map((folder) => (
          <option key={folder} value={folder}>
            {basename(folder)}
          </option>
        ))}
      </select>
      {shown !== undefined && <span className="folder-switch-note">Related folder. Pull requests and pushes stay with {project?.name ?? "the project"}.</span>}
    </div>
  )
}
