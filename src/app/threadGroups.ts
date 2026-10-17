import type { ThreadMeta } from "./persist"

/**
 * What a group of threads is, from its id and first thread: an eval's runs (the eval's id), a setup
 * run's roles (also a workflow's steps, which run as setup runs), or Best of N runs to compare.
 */
export type ThreadGroupKind = { readonly kind: "eval"; readonly runId: string } | { readonly kind: "setup"; readonly runId: string } | { readonly kind: "compare" }

export function threadGroupKind(groupId: string, first: Pick<ThreadMeta, "setup"> | undefined): ThreadGroupKind {
  const setup = first?.setup
  if (setup === undefined) return { kind: "compare" }
  return groupId.startsWith("eval-") ? { kind: "eval", runId: groupId } : { kind: "setup", runId: setup.runId }
}
