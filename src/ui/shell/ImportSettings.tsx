import { Download } from "lucide-react"
import { useEffect, useState } from "react"
import { openDialog } from "../../app/actions"
import { createShellConnection, importableConnections } from "../../app/connections"
import { toast } from "../../app/store"
import { toHostError } from "../../host"
import { plural } from "../../lib/format"
import type { ImportableConnection } from "../../protocol/schemas"
import { Button, Spinner } from "../common"

/**
 * Providers Codex, Pi, or opencode are set up with, offered as connections. The engine reads those
 * tools' settings and returns addresses, model ids, and variable names; a key written in one of
 * their files never reaches this window, so a provider that needs one is added with the key form.
 */

const SOURCE_LABELS: Readonly<Record<ImportableConnection["source"], string>> = { codex: "Codex", pi: "Pi", opencode: "opencode" }

/** What adding a candidate does, worded for its button. */
export function importAction(candidate: ImportableConnection): { readonly kind: "shell" | "key" | "custom"; readonly label: string; readonly detail: string } {
  if (candidate.kind === "preset" && candidate.environmentName !== undefined && candidate.environmentSet === true)
    return { kind: "shell", label: "Add", detail: `Uses ${candidate.environmentName} from your shell.` }
  if (candidate.kind === "preset")
    return { kind: "key", label: "Add key…", detail: candidate.environmentName === undefined ? "Add its key to use it here." : `${candidate.environmentName} is not set in your shell; add the key here instead.` }
  return { kind: "custom", label: "Add…", detail: candidate.kind === "local" ? "A server on this computer. Most take any key." : "Add the key this address takes." }
}

export function ImportProviders() {
  const [candidates, setCandidates] = useState<readonly ImportableConnection[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [adding, setAdding] = useState<string | undefined>()

  useEffect(() => {
    let live = true
    importableConnections()
      .then((list) => live && setCandidates(list))
      .catch((caught: unknown) => live && setError(toHostError(caught).message))
    return () => {
      live = false
    }
  }, [])

  const add = (candidate: ImportableConnection): void => {
    const action = importAction(candidate)
    if (action.kind === "key") return openDialog({ kind: "connect", ...(candidate.presetId === undefined ? {} : { presetId: candidate.presetId }) })
    if (action.kind === "custom") return openDialog({ kind: "connect", custom: { label: candidate.name, address: candidate.baseUrl } })
    if (candidate.presetId === undefined || candidate.environmentName === undefined) return
    const key = `${candidate.source}:${candidate.id}`
    setAdding(key)
    createShellConnection({ presetId: candidate.presetId, name: candidate.name, environmentName: candidate.environmentName })
      .then(() => {
        toast("success", `${candidate.name} added. It reads ${candidate.environmentName ?? "its key"} from your shell.`)
        setCandidates((list) => list?.filter((item) => item !== candidate))
      })
      .catch((caught: unknown) => toast("error", `Could not add ${candidate.name}: ${toHostError(caught).message}`))
      .finally(() => setAdding(undefined))
  }

  if (error !== undefined) return <p className="setting-hint is-error">{error}</p>
  if (candidates === undefined)
    return (
      <div className="pane-loading">
        <Spinner size={12} /> Reading other tools' settings…
      </div>
    )
  if (candidates.length === 0) return <p className="setting-hint">Codex, Pi, and opencode list no providers Runrail can add.</p>
  return (
    <ul className="entry-list">
      {candidates.map((candidate) => {
        const action = importAction(candidate)
        const key = `${candidate.source}:${candidate.id}`
        return (
          <li key={key} className="entry-row">
            <span className="entry-mark" aria-hidden="true">
              <Download size={13} />
            </span>
            <span className="entry-text">
              <span className="entry-name">{candidate.name}</span>
              <code className="entry-command" title={candidate.baseUrl}>
                {candidate.baseUrl}
              </code>
              <span className="entry-scope">
                From {SOURCE_LABELS[candidate.source]}
                {candidate.models.length === 0 ? "" : ` · ${plural(candidate.models.length, "model")}`} · {action.detail}
              </span>
            </span>
            <Button size="sm" variant={action.kind === "shell" ? "primary" : "ghost"} loading={adding === key} disabled={adding !== undefined} onClick={() => add(candidate)}>
              {action.label}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
