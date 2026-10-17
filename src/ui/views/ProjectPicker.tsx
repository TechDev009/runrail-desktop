import { ChevronsUpDown, Folder, FolderGit2 } from "lucide-react"
import type { Project } from "../../app/persist"

/** The project a place works on, said once and in full under its title; a menu when there is a choice. */
export function ProjectPicker({ projects, value, onChange, title }: { readonly projects: readonly Project[]; readonly value: string; readonly onChange: (projectId: string) => void; readonly title?: string }) {
  const current = projects.find((project) => project.id === value)
  if (current === undefined) return null
  const Icon = current.git ? FolderGit2 : Folder
  return (
    <label className="agents-project-row" title={title}>
      <Icon size={13} aria-hidden />
      {projects.length > 1 ? (
        <>
          <select className="agents-project-select" aria-label="Project" value={value} onChange={(event) => onChange(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={12} className="agents-project-chevron" aria-hidden />
        </>
      ) : (
        <span className="agents-project-name">{current.name}</span>
      )}
    </label>
  )
}
