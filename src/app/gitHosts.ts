import type { CodeHostRecord, GitRemote, GitService } from "../protocol/schemas"

/**
 * What a project's folder is connected to, from the engine's remote list: plain git, or a
 * repository on GitHub, GitLab, or Bitbucket. A service the engine only guessed is shown as a
 * guess ("GitLab?") until the person answers for that host in Settings → Projects.
 */

export interface ConnectedTo {
  readonly service: GitService | "local"
  /** Known from the host itself or the person's answer, not guessed from the URL. */
  readonly certain: boolean
  readonly host?: string
  readonly path?: string
  /** On a fork: the repository pull requests go to. */
  readonly upstream?: string
}

export const SERVICE_NAMES: Readonly<Record<GitService, string>> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", unknown: "Git server" }

/** The branch's upstream remote, else `origin`, else the only remote. */
export function primaryRemote(remotes: readonly GitRemote[], upstreamRemote?: string): GitRemote | undefined {
  return remotes.find((remote) => remote.name === upstreamRemote) ?? remotes.find((remote) => remote.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined)
}

export function connectedTo(remotes: readonly GitRemote[], upstreamRemote?: string): ConnectedTo {
  const remote = primaryRemote(remotes, upstreamRemote)
  if (remote === undefined || remote.host === undefined) return { service: "local", certain: true }
  const upstream = remotes.find((entry) => entry.name === "upstream")
  const fork = upstream !== undefined && upstream !== remote && upstream.host === remote.host && upstream.owner !== undefined && remote.owner !== undefined && upstream.owner.toLowerCase() !== remote.owner.toLowerCase()
  return {
    service: remote.service ?? "unknown",
    certain: remote.serviceFrom === "host" || remote.serviceFrom === "user",
    host: remote.host,
    ...(remote.path === undefined ? {} : { path: remote.path }),
    ...(fork && upstream.path !== undefined ? { upstream: upstream.path } : {}),
  }
}

export interface ServiceLine {
  /** `GitHub · example-org/widgets`, `git.corp.example · GitLab?`, or `git`. */
  readonly text: string
  /** The sidebar's mark: `GitHub` or `GitLab?`; none without a service to name. */
  readonly short?: string
  readonly title: string
}

export function serviceLine(connected: ConnectedTo | undefined): ServiceLine | undefined {
  if (connected === undefined) return undefined
  if (connected.service === "local") return { text: "git", title: "A git repository with no remote" }
  const host = connected.host ?? ""
  const fork = connected.upstream === undefined ? "" : ` · fork of ${connected.upstream}`
  const where = connected.path === undefined ? host : `${connected.path}${fork}`
  if (connected.service === "unknown") return { text: where === host ? host : `${host} · ${where}`, title: `${host}: which service this is is not known. Say which in Settings → Projects.` }
  const name = SERVICE_NAMES[connected.service]
  if (!connected.certain) return { text: `${host} · ${name}?`, short: `${name}?`, title: `${host} looks like ${name}. Confirm it in Settings → Projects.` }
  return { text: `${name} · ${where}`, short: name, title: `${name} · ${host}/${connected.path ?? ""}${fork}` }
}

export interface RepoLine {
  /** `widgets` from `example-org/widgets`, or the folder's name for a repository with no remote. */
  readonly name: string
  readonly title: string
}

/** The bar's repository mark: the repository's name, with where it lives in the tooltip. */
export function repoLine(project: { readonly path: string; readonly git?: boolean; readonly connectedTo?: ConnectedTo }): RepoLine | undefined {
  if (project.git !== true) return undefined
  const folder = project.path.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? project.path
  const connected = project.connectedTo
  if (connected === undefined) return { name: folder, title: folder }
  if (connected.service === "local") return { name: folder, title: `${folder}\nA git repository with no remote` }
  const name = connected.path?.split("/").pop() ?? folder
  const line = serviceLine(connected)
  const title = line?.title ?? ""
  return { name, title: connected.certain && connected.service !== "unknown" ? title : `${connected.host ?? ""}/${connected.path ?? ""}\n${title}` }
}

/** Pull requests are GitHub's until other services get connectors; a guess is never refused. */
export function pullRequestsOffered(connected: ConnectedTo | undefined): boolean {
  if (connected === undefined || connected.service === "local") return false
  return !(connected.certain && (connected.service === "gitlab" || connected.service === "bitbucket"))
}

/** What a project's row in Settings → Projects says about its folder, and what it offers. */
export interface ProjectGitRow {
  /** `GitHub · example-org/web`, `git · no remote`, `Not a git folder`, or `git.corp.example · looks like GitLab`. */
  readonly text: string
  readonly git: boolean
  /** On a fork: the repository pull requests go to. */
  readonly fork?: string
  readonly host?: string
  readonly service?: GitService
  /** `ask` while the service is a guess or unknown; `change` once the person answered; else nothing. */
  readonly answer: "none" | "ask" | "change"
  /** The service Confirm records: the app's guess. */
  readonly guess?: GitService
  /** The GitHub CLI switch for this host's pull requests, where it applies. */
  readonly githubCli?: { readonly enabled: boolean }
}

export function projectGitRow(project: { readonly git: boolean; readonly connectedTo?: ConnectedTo }, records: readonly CodeHostRecord[]): ProjectGitRow {
  if (!project.git) return { text: "Not a git folder", git: false, answer: "none" }
  const connected = project.connectedTo
  if (connected === undefined) return { text: "git", git: true, answer: "none" }
  if (connected.service === "local" || connected.host === undefined) return { text: "git · no remote", git: true, answer: "none" }
  const host = connected.host
  // An answer kept for `host:port` covers the remote on that port.
  const record = records.find((entry) => entry.host.replace(/:\d+$/, "") === host.replace(/:\d+$/, ""))
  const answered = record?.service !== undefined
  const where = connected.path ?? host
  const name = connected.service === "unknown" ? undefined : SERVICE_NAMES[connected.service]
  const text = name === undefined ? (where === host ? host : `${host} · ${where}`) : connected.certain ? `${name} · ${where}` : `${host} · looks like ${name}`
  const githubCli = connected.service === "github" || (connected.service === "unknown" && !connected.certain)
  return {
    text,
    git: true,
    host,
    service: connected.service,
    ...(connected.upstream === undefined ? {} : { fork: connected.upstream }),
    answer: answered ? "change" : connected.certain ? "none" : "ask",
    ...(!connected.certain && connected.service !== "unknown" ? { guess: connected.service } : {}),
    ...(githubCli ? { githubCli: { enabled: record?.connection?.enabled === true } } : {}),
  }
}
