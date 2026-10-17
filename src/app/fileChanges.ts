import { HostError } from "../host"
import { GitDiffSchema, parseOr, type GitDiffFile } from "../protocol/schemas"
import { threadRpc } from "./engines"

export async function readFileChange(threadId: string, path: string): Promise<GitDiffFile | undefined> {
  const diff = parseOr(GitDiffSchema, await threadRpc(threadId, "git.diff", { scope: "head", paths: [path], contextLines: 3, maxFiles: 1, maxBytes: 512 * 1_024, includeUntracked: true }))
  if (diff === undefined) throw new HostError("CONTROL_INVALID_RESPONSE", "The engine returned changes this app cannot read.")
  return diff.files.find((file) => file.path === path || file.originalPath === path)
}
