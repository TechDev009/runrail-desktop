import type { WorkspaceInfo } from "../host/types"
import type { Project, ProjectRemote } from "./persist"

/** A folder for a new project: on this Mac, or on a remote machine. */
export type ProjectSource = WorkspaceInfo & { readonly remote?: ProjectRemote }

/** Rules for naming and creating a project, shared by the Create project dialog and Rename. */

export const MAX_PROJECT_NAME = 80

/** Runs of whitespace become one space; undefined when nothing is left or it is too long. */
export function cleanProjectName(name: string): string | undefined {
  const clean = name.replace(/\s+/g, " ").trim()
  return clean.length === 0 || clean.length > MAX_PROJECT_NAME ? undefined : clean
}

/** The name field shows the folder's name until the person types one of their own. */
export function shownProjectName(typed: string, touched: boolean, folder: ProjectSource | undefined): string {
  return touched ? typed : (folder?.name ?? "").slice(0, MAX_PROJECT_NAME)
}

export function existingProject(folder: ProjectSource | undefined, projects: readonly Project[]): Project | undefined {
  return folder === undefined ? undefined : projects.find((project) => project.path === folder.path && project.remote?.id === folder.remote?.id)
}

export type CreateProblem = "no-folder" | "duplicate" | "no-name"

export function createProblem(name: string, folder: ProjectSource | undefined, projects: readonly Project[]): CreateProblem | undefined {
  if (folder === undefined) return "no-folder"
  if (existingProject(folder, projects) !== undefined) return "duplicate"
  return cleanProjectName(name) === undefined ? "no-name" : undefined
}
