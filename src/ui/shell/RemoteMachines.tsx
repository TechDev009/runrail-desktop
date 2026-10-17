import { Plus, Server, Trash } from "lucide-react"
import { useEffect, useState } from "react"
import { useWords } from "../../app/platformWords"
import { checkRemote, loadRemotes, removeRemote, saveRemote, useRemotes } from "../../app/remotes"
import { toast, useApp } from "../../app/store"
import { getHost, toHostError, type RemoteMachine } from "../../host"
import { Button, IconButton } from "../common"

/**
 * Remote machines: a project can live on a machine the person reaches with `ssh`.
 * Runrail uses their own SSH settings and keys and never reads them; a thread there runs on the
 * coding tools signed in on that machine, since keys on this Mac never leave it.
 */
export function RemoteMachines() {
  const words = useWords()
  const { machines, loaded, error } = useRemotes()
  const projects = useApp((state) => state.projects)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    void loadRemotes()
  }, [])
  return (
    <div className="remote-machines" data-setting="remote-machines">
      <div className="settings-head-row">
        <h3>Remote machines</h3>
        {!adding && (
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            Add machine
          </Button>
        )}
      </div>
      <p className="setting-hint">
        A project can live on another machine you reach with ssh. Runrail connects with your own SSH settings and keys, starts its engine there, and the agent works on that machine. Keys for AI providers stay on this {words.computer}, so a thread there runs on Claude Code or Codex signed in on that machine.
      </p>
      {adding && <MachineForm onDone={() => setAdding(false)} />}
      {error !== undefined && <p className="setting-hint is-error">{error}</p>}
      {loaded && machines.length > 0 && (
        <ul className="settings-list">
          {machines.map((machine) => (
            <MachineRow key={machine.id} machine={machine} used={projects.filter((project) => project.remote?.id === machine.id).length} />
          ))}
        </ul>
      )}
    </div>
  )
}

function MachineRow({ machine, used }: { readonly machine: RemoteMachine; readonly used: number }) {
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<string>()
  const check = async (): Promise<void> => {
    setChecking(true)
    setStatus(undefined)
    try {
      const answer = await checkRemote(machine.id)
      setStatus(`Reached; Runrail ${answer.version ?? "answered"} there.`)
    } catch (failure) {
      setStatus(toHostError(failure).message)
    } finally {
      setChecking(false)
    }
  }
  return (
    <li className="settings-list-row" data-setting={`remote-${machine.id}`}>
      <Server size={14} className="muted" />
      <span className="settings-list-text">
        <span className="settings-list-title">{machine.host}</span>
        <span className="settings-list-hint">
          {machine.engine ?? "runrail"} · {used === 0 ? "no projects" : used === 1 ? "1 project" : `${String(used)} projects`}
          {status !== undefined && ` · ${status}`}
        </span>
      </span>
      <Button size="sm" variant="ghost" loading={checking} disabled={checking} onClick={() => void check()}>
        Check
      </Button>
      <IconButton
        label={used > 0 ? `Remove ${machine.host}'s projects first` : `Remove ${machine.host}`}
        size="sm"
        disabled={used > 0}
        onClick={() => void removeRemote(machine.id).catch((failure: unknown) => toast("error", toHostError(failure).message))}
      >
        <Trash size={13} />
      </IconButton>
    </li>
  )
}

/** A new machine: a host as ssh takes it, and how its shell starts Runrail when not on its PATH. */
export function MachineForm({ onDone }: { readonly onDone: (machine?: RemoteMachine) => void }) {
  const [host, setHost] = useState("")
  const [engine, setEngine] = useState("")
  const [aliases, setAliases] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void getHost()
      .sshHosts()
      .then(setAliases, () => setAliases([]))
  }, [])
  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const saved = await saveRemote({ host, ...(engine.trim().length === 0 ? {} : { engine }) })
      onDone(saved)
    } catch (failure) {
      const problem = toHostError(failure)
      if (problem.code !== "REMOTE_DECLINED") setError(problem.message)
    } finally {
      setSaving(false)
    }
  }
  // Not a form: it also sits inside the Create project dialog's form.
  return (
    <div
      className="remote-form"
      role="group"
      aria-label="Add a remote machine"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault()
          event.stopPropagation()
          if (host.trim().length > 0 && !saving) void save()
        }
      }}
    >
      <label className="field">
        <span className="field-label">Host</span>
        <input className="input input-sm" list="ssh-hosts" value={host} placeholder="dev-box, or you@server.example.com" autoComplete="off" spellCheck={false} maxLength={253} data-autofocus="" onChange={(event) => setHost(event.target.value)} />
        <datalist id="ssh-hosts">
          {aliases.map((alias) => (
            <option key={alias} value={alias} />
          ))}
        </datalist>
      </label>
      <label className="field">
        <span className="field-label">Engine command</span>
        <input className="input input-sm" value={engine} placeholder="runrail" autoComplete="off" spellCheck={false} maxLength={300} onChange={(event) => setEngine(event.target.value)} />
        <span className="setting-hint">Only if runrail is not on that machine's PATH, such as ~/.bun/bin/runrail.</span>
      </label>
      {error !== undefined && <div className="form-error">{error}</div>}
      <div className="remote-form-actions">
        <Button size="sm" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={saving || host.trim().length === 0} onClick={() => void save()}>
          Add machine
        </Button>
      </div>
    </div>
  )
}
