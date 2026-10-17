import type { GitDiff, GitDiffFile } from "../protocol/schemas"

/** Past this many paths the whole diff is read again: about the same work, and it keeps git's order. */
export const PARTIAL_LIMIT = 50

const NEW_FILE = new Set(["added", "untracked"])

/**
 * The diff with `paths` swapped for a fresh read of only those paths. Undefined when that read
 * cannot stand in for a full one: a list cut short, or a rename, since git pairs an added file
 * with a deleted one only when it reads both.
 */
export function mergeDiff(current: GitDiff, paths: readonly string[], fresh: GitDiff): GitDiff | undefined {
  if (current.truncated === true || fresh.truncated === true) return undefined
  const touched = new Set(paths)
  const hit = (file: GitDiffFile): boolean => touched.has(file.path) || (file.originalPath !== undefined && touched.has(file.originalPath))
  const before = current.files.filter(hit)
  const kept = current.files.filter((file) => !hit(file))
  if (fresh.files.some((file) => !touched.has(file.path))) return undefined
  if ([...before, ...fresh.files].some((file) => file.originalPath !== undefined)) return undefined
  const changes = new Set([...before, ...fresh.files].map((file) => file.change))
  const others = new Set(kept.map((file) => file.change))
  const adds = [...changes].some((change) => NEW_FILE.has(change))
  if ((adds && others.has("deleted")) || (changes.has("deleted") && [...others].some((change) => NEW_FILE.has(change)))) return undefined

  const replacements = new Map(fresh.files.map((file) => [file.path, file]))
  const files: GitDiffFile[] = []
  for (const file of current.files) {
    if (!hit(file)) files.push(file)
    else {
      const next = replacements.get(file.path)
      if (next !== undefined) files.push(next)
      replacements.delete(file.path)
    }
  }
  for (const file of replacements.values()) {
    const at = files.findIndex((other) => other.path > file.path)
    files.splice(at < 0 ? files.length : at, 0, file)
  }
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return { ...current, files, totals: { ...current.totals, files: files.length, additions, deletions } }
}
