import { FolderX, GitBranch } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { systemRpc } from "../../app/connections"
import { rereadRemotes } from "../../app/gitBar"
import { projectGitRow } from "../../app/gitHosts"
import type { Project } from "../../app/persist"
import { rereadProjectsOn } from "../../app/projectGit"
import { toast } from "../../app/store"
import { toHostError } from "../../host"
import { CodeHostListSchema, CodeHostStatusSchema, parseOr, type CodeHostRecord, type CodeHostStatus, type GitService } from "../../protocol/schemas"
import { Button, Segmented, Toggle } from "../common"

/**
 * A project's git line in Settings → Projects: what its folder is connected to, the
 * answer when Runrail only guessed the service, and for a GitHub host whether pull requests use
 * the person's own GitHub CLI sign-in. Runrail never runs `gh auth login` and never sees
 * gh's token.
 */

const SERVICE_OPTIONS: readonly { readonly value: GitService; readonly label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "unknown", label: "Other" },
]

/** The person's answers per host, which every project row reads. */
export function useCodeHostRecords(): { readonly records: readonly CodeHostRecord[]; readonly problem?: string; readonly reload: () => void } {
  const [records, setRecords] = useState<readonly CodeHostRecord[]>([])
  const [problem, setProblem] = useState<string | undefined>()
  const reload = useCallback(() => {
    systemRpc("codehost.list")
      .then((value) => {
        const listing = parseOr(CodeHostListSchema, value)
        setRecords(listing?.hosts ?? [])
        setProblem(listing === undefined ? "The engine returned a host list this app cannot read." : listing.problem === "CODEHOST_STORE_INVALID" ? "The saved git host answers could not be read; the next change replaces them." : undefined)
      })
      .catch((error: unknown) => setProblem(toHostError(error).message))
  }, [])
  useEffect(reload, [reload])
  return { records, ...(problem === undefined ? {} : { problem }), reload }
}

export function ProjectGitLine({ project, records, onChanged }: { readonly project: Project; readonly records: readonly CodeHostRecord[]; readonly onChanged: () => void }) {
  const row = projectGitRow(project, records)
  const host = row.host
  const connected = row.githubCli?.enabled === true
  const [saving, setSaving] = useState(false)
  const [changing, setChanging] = useState(false)
  const [cli, setCli] = useState<CodeHostStatus | "checking" | undefined>()

  // A connected host says who gh is signed in as; asking runs `gh api user`, which reads only the login.
  useEffect(() => {
    if (!connected || host === undefined) return
    let live = true
    systemRpc("codehost.status", { host })
      .then((value) => live && setCli(parseOr(CodeHostStatusSchema, value)))
      .catch(() => live && setCli(undefined))
    return () => {
      live = false
    }
  }, [connected, host])

  if (host === undefined)
    return (
      <span className="project-git-line">
        {row.git ? <GitBranch size={12} aria-hidden="true" /> : <FolderX size={12} aria-hidden="true" />}
        <span>{row.text}</span>
      </span>
    )

  const answer = async (service: GitService): Promise<void> => {
    setSaving(true)
    try {
      await systemRpc("codehost.set", { host, service })
      setChanging(false)
      onChanged()
      await rereadProjectsOn(host)
      rereadRemotes()
    } catch (error) {
      toast("error", `Could not save: ${toHostError(error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const switchCli = async (on: boolean): Promise<void> => {
    setSaving(true)
    try {
      if (!on) {
        await systemRpc("codehost.disconnect", { host })
        setCli(undefined)
        onChanged()
        return
      }
      setCli("checking")
      const status = parseOr(CodeHostStatusSchema, await systemRpc("codehost.status", { host }))
      setCli(status)
      if (status?.state !== "ready") return
      await systemRpc("codehost.connect", { host, via: "gh" })
      toast("success", `Pull requests on ${host} use the GitHub CLI, signed in as ${status.login ?? "you"}`)
      onChanged()
    } catch (error) {
      setCli(undefined)
      toast("error", toHostError(error).message)
    } finally {
      setSaving(false)
    }
  }

  const asking = row.answer === "ask" || changing
  return (
    <span className="project-git">
      <span className="project-git-line">
        <GitBranch size={12} aria-hidden="true" />
        <span>{row.text}</span>
        {row.fork !== undefined && <span className="muted">· fork of {row.fork}</span>}
        {row.answer === "ask" && row.guess !== undefined && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => row.guess !== undefined && void answer(row.guess)}>
            Confirm
          </Button>
        )}
        {row.answer === "change" && !changing && (
          <button type="button" className="link-button" onClick={() => setChanging(true)}>
            Change
          </button>
        )}
      </span>
      {asking && row.service !== undefined && <Segmented size="sm" label={`Service for ${host}`} value={row.service} disabled={saving} options={SERVICE_OPTIONS} onChange={(value) => void answer(value)} />}
      {row.githubCli !== undefined && (
        <span className="project-git-cli">
          <Toggle checked={connected} disabled={saving} label={`Use the GitHub CLI for pull requests on ${host}`} onChange={(value) => void switchCli(value)} />
          <span className="project-git-cli-text">
            <span>{cliText(cli, connected)}</span>
            <span className="setting-hint">Applies to every project on {host}</span>
          </span>
        </span>
      )}
    </span>
  )
}

function cliText(cli: CodeHostStatus | "checking" | undefined, connected: boolean): string {
  if (cli === "checking") return "Checking the GitHub CLI…"
  if (cli?.state === "missing") return "Install the GitHub CLI (gh) first."
  if (cli?.state === "signed-out") return "The GitHub CLI is not signed in. Run gh auth login in a terminal, then turn this on."
  if (cli?.state === "ready") return connected ? `Pull requests use your GitHub CLI · signed in as ${cli.login ?? "you"}` : `GitHub CLI signed in as ${cli.login ?? "you"}; turn on to use it for pull requests`
  return connected ? "Pull requests use your GitHub CLI sign-in" : "Pull requests can use your GitHub CLI sign-in"
}
