import { Check, Folder, FolderGit2, FolderPlus, GitBranch, Info, Package, PanelsTopLeft, Server, Sparkles, X, Zap } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { closeDialog, createProject, startNewThread } from "../../app/actions"
import { MAX_PROJECT_FOLDERS } from "../../app/persist"
import { cleanProjectName, createProblem, existingProject, MAX_PROJECT_NAME, shownProjectName, type ProjectSource } from "../../app/projectForm"
import { checkRemote, loadRemotes, remoteFolderName, useRemotes, validRemotePath } from "../../app/remotes"
import { appFolderName, createApp, loadStarters, type AppStarters } from "../../app/starters"
import { toast, useApp, type ProjectWhere } from "../../app/store"
import { getHost, toHostError } from "../../host"
import { compactPath } from "../../lib/format"
import { Button, IconButton, Modal, Segmented, Spinner } from "../common"
import { MachineForm } from "../shell/RemoteMachines"
import { foldersOverlap } from "../shell/ProjectFolders"

/**
 * Names a new project and picks its folder, on this computer or a remote machine, or makes a new app
 * from a starter; nothing is added until Create.
 */
export function CreateProjectDialog({ where: start = "local" }: { readonly where?: ProjectWhere } = {}) {
  const projects = useApp((state) => state.projects)
  const [typed, setTyped] = useState("")
  const [touched, setTouched] = useState(false)
  const [where, setWhere] = useState<ProjectWhere>(start)
  const [folder, setFolder] = useState<ProjectSource | undefined>()
  const [folders, setFolders] = useState<readonly ProjectSource[]>([])
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const name = shownProjectName(typed, touched, folder)
  const problem = createProblem(name, folder, projects)
  const existing = existingProject(folder, projects)
  const [starters, setStarters] = useState<AppStarters>()
  const [startersError, setStartersError] = useState<string>()
  const [starter, setStarter] = useState<string>()
  const [making, setMaking] = useState(false)
  const [failure, setFailure] = useState<{ readonly message: string; readonly output?: string }>()
  const folderName = appFolderName(name)
  const chosen = starters?.starters.find((entry) => entry.id === starter)
  const appProblem = cleanProjectName(name) === undefined || folderName === undefined || chosen === undefined

  useEffect(() => {
    if (where !== "new" || starters !== undefined) return
    let live = true
    loadStarters().then(
      (list) => {
        if (!live) return
        setStarters(list)
        setStarter((current) => current ?? list.default)
      },
      (failed: unknown) => {
        if (live) setStartersError(toHostError(failed).message)
      },
    )
    return () => {
      live = false
    }
  }, [where, starters])

  const pick = async (): Promise<void> => {
    setPicking(true)
    setError(undefined)
    try {
      const picked = await getHost().workspacePick()
      if (picked !== null) setFolder(picked)
    } catch (failure) {
      setError(`Could not open the folder: ${toHostError(failure).message}`)
    } finally {
      setPicking(false)
    }
  }
  const create = (): void => {
    const clean = cleanProjectName(name)
    if (folder === undefined || clean === undefined || problem !== undefined || picking) return
    createProject(folder, clean, folders.map((entry) => entry.path))
  }
  const makeApp = async (): Promise<void> => {
    const clean = cleanProjectName(name)
    if (clean === undefined || folderName === undefined || chosen === undefined || making) return
    setMaking(true)
    setFailure(undefined)
    try {
      const made = await createApp(folderName, chosen.id)
      if (made === undefined) return
      if (!made.ok) return setFailure({ message: made.message, ...(made.output == null || made.output.length === 0 ? {} : { output: made.output }) })
      for (const warning of made.warnings) toast("info", `${clean}: ${warning}`)
      createProject(made.workspace, clean)
    } catch (failed) {
      setFailure({ message: toHostError(failed).message })
    } finally {
      setMaking(false)
    }
  }
  const addFolder = async (): Promise<void> => {
    if (folder === undefined || folder.remote !== undefined || folders.length >= MAX_PROJECT_FOLDERS) return
    setPicking(true)
    setError(undefined)
    try {
      const picked = await getHost().workspacePick({ near: folder.path, related: true })
      if (picked === null) return
      if ([folder, ...folders].some((entry) => foldersOverlap(entry.path, picked.path))) setError("Choose a separate folder outside the folders already added.")
      else setFolders((current) => [...current, picked])
    } catch (failure) {
      setError(`Could not add the folder: ${toHostError(failure).message}`)
    } finally {
      setPicking(false)
    }
  }

  return (
    <Modal
      title="Create project"
      onClose={closeDialog}
      width={520}
      className="create-project"
      footer={
        <>
          <Button variant="ghost" disabled={making} onClick={closeDialog}>
            Cancel
          </Button>
          {where === "new" ? (
            <Button variant="primary" disabled={appProblem || making} loading={making} onClick={() => void makeApp()}>
              Choose where and create
            </Button>
          ) : (
            <Button variant="primary" disabled={problem !== undefined || picking} onClick={create}>
              Create project
            </Button>
          )}
        </>
      }
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          if (where === "new") void makeApp()
          else create()
        }}
      >
        <Segmented
          label="Where the project comes from"
          size="sm"
          value={where}
          onChange={(next) => {
            setWhere(next)
            setFolder(undefined)
            setFolders([])
            setError(undefined)
          }}
          options={[
            { value: "local", label: "This Mac", icon: <Folder size={13} /> },
            { value: "remote", label: "Remote machine", icon: <Server size={13} /> },
            { value: "new", label: "New app", icon: <Sparkles size={13} /> },
          ]}
        />
        <label className="create-project-name">
          <span className="create-project-name-icon" aria-hidden>
            {where === "new" ? <Sparkles size={15} /> : <Folder size={15} />}
          </span>
          <input
            value={name}
            placeholder={where === "new" ? "App name" : "Project name"}
            aria-label={where === "new" ? "App name" : "Project name"}
            maxLength={MAX_PROJECT_NAME}
            autoComplete="off"
            spellCheck={false}
            disabled={making}
            data-autofocus=""
            onChange={(event) => {
              setTouched(true)
              setTyped(event.target.value)
            }}
          />
          {where === "new" && folderName !== undefined && (
            <span className="create-project-slug" title={`The folder is named ${folderName}`}>
              <Folder size={11} aria-hidden />
              {folderName}
            </span>
          )}
        </label>
        {where === "new" ? (
          <NewApp
            folderName={folderName}
            starters={starters}
            error={startersError}
            starter={starter}
            onStarter={setStarter}
            making={making}
            failure={failure}
          />
        ) : (
        <div className="field">
          <div className="field-label">Source folder</div>
          {folder === undefined && where === "remote" ? (
            <RemoteSource onFound={setFolder} />
          ) : folder === undefined ? (
            <div className="create-project-source">
              <span className="create-project-source-text">Add a folder on this computer</span>
              <Button size="sm" icon={<FolderPlus size={14} />} loading={picking} disabled={picking} onClick={() => void pick()}>
                Add
              </Button>
              {error !== undefined && <div className="form-error">{error}</div>}
            </div>
          ) : (
            <div className="create-project-folder">
              <Folder size={15} className="create-project-folder-icon" />
              <span className="create-project-folder-path" title={folder.remote === undefined ? folder.path : `${folder.remote.host}:${folder.path}`}>
                {folder.remote === undefined ? compactPath(folder.path) : `${folder.remote.host}:${folder.path}`}
              </span>
              {folder.git && (
                <span className="create-project-git">
                  <GitBranch size={12} /> git
                </span>
              )}
              <IconButton label="Remove folder" size="sm" onClick={() => { setFolder(undefined); setFolders([]) }}>
                <X size={13} />
              </IconButton>
            </div>
          )}
          {folder !== undefined && folder.remote === undefined && (
            <div className="field">
              <div className="field-label">Additional folders</div>
              <p className="muted">The agent can read and edit these alongside the source folder.</p>
              {folders.map((entry) => (
                <div key={entry.path} className="create-project-folder">
                  <Folder size={15} />
                  <span className="create-project-folder-path" title={entry.path}>{compactPath(entry.path)}</span>
                  <IconButton label={`Remove ${entry.name}`} size="sm" onClick={() => setFolders((current) => current.filter((item) => item.path !== entry.path))}><X size={13} /></IconButton>
                </div>
              ))}
              {folders.length < MAX_PROJECT_FOLDERS && <Button size="sm" icon={<FolderPlus size={14} />} disabled={picking} loading={picking} onClick={() => void addFolder()}>Add folder</Button>}
              {error !== undefined && <div className="form-error">{error}</div>}
            </div>
          )}
          {existing !== undefined && (
            <div className="create-project-existing" role="status">
              <span>Already in Runrail as {existing.name}.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  closeDialog()
                  startNewThread(existing.id)
                }}
              >
                Open it
              </Button>
            </div>
          )}
        </div>
        )}
      </form>
    </Modal>
  )
}

const STARTER_ICONS: Record<string, ReactNode> = {
  nifra: <Sparkles size={15} />,
  vite: <Zap size={15} />,
  next: <PanelsTopLeft size={15} />,
  empty: <FolderGit2 size={15} />,
}

/**
 * The starters, as the engine lists them: Nifra first and chosen, marked Recommended, with who
 * makes each one, so nothing about the default is hidden.
 */
function NewApp({
  folderName,
  starters,
  error,
  starter,
  onStarter,
  making,
  failure,
}: {
  readonly folderName: string | undefined
  readonly starters: AppStarters | undefined
  readonly error: string | undefined
  readonly starter: string | undefined
  readonly onStarter: (id: string) => void
  readonly making: boolean
  readonly failure: { readonly message: string; readonly output?: string } | undefined
}) {
  const chosen = starters?.starters.find((entry) => entry.id === starter)
  return (
    <div className="field">
      <div className="field-label">Starter</div>
      {starters === undefined ? (
        error === undefined ? (
          <div className="starter-grid" aria-busy="true">
            {[0, 1, 2, 3].map((index) => <div key={index} className="starter-card is-loading" />)}
          </div>
        ) : (
          <div className="form-error">Could not list the starters: {error}</div>
        )
      ) : (
        <div className="starter-grid" role="radiogroup" aria-label="Starter">
          {starters.starters.map((entry) => (
            <label key={entry.id} className={`starter-card${entry.id === starter ? " is-chosen" : ""}`}>
              <input className="sr-only" type="radio" name="starter" value={entry.id} checked={entry.id === starter} disabled={making} onChange={() => onStarter(entry.id)} />
              <span className="starter-top">
                <span className="starter-icon" aria-hidden>
                  {STARTER_ICONS[entry.id] ?? <Package size={15} />}
                </span>
                {entry.recommended && <span className="starter-badge">Recommended</span>}
                <span className="starter-check" aria-hidden>
                  <Check size={11} strokeWidth={3} />
                </span>
              </span>
              <span className="starter-label">{entry.label}</span>
              <span className="starter-maker">By {entry.maker}</span>
              <span className="starter-description">{entry.description}</span>
            </label>
          ))}
        </div>
      )}
      {making ? (
        <MakingApp folderName={folderName} creator={chosen?.creator} />
      ) : (
        <p className="starter-note">
          <Info size={13} aria-hidden />
          <span>
            {chosen?.creator === undefined
              ? "Runrail makes the folder and its first commit, in the place you choose next."
              : <>Runrail runs <code>{chosen.creator}</code> from npm, installs the packages, and makes the first commit, in the place you choose next.</>}
          </span>
        </p>
      )}
      {failure !== undefined && (
        <div className="form-error" role="alert">
          {failure.message}
          {failure.output !== undefined && (
            <details className="starter-output">
              <summary>What the starter printed</summary>
              <pre>{failure.output}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/** The wait while a starter runs: the host reports no steps, so the time it has taken stands in. */
function MakingApp({ folderName, creator }: { readonly folderName: string | undefined; readonly creator: string | undefined }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="starter-making" role="status">
      <Spinner size={14} />
      <span className="starter-making-text">
        <span>Making {folderName ?? "the app"}</span>
        <span className="muted">{creator === undefined ? "Making the first commit" : `Running ${creator} and installing packages`}</span>
      </span>
      <span className="starter-making-time">{`${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`}</span>
    </div>
  )
}

/**
 * A folder on a remote machine: the machine is reached and the folder looked at
 * before the project can be created, so a typo or a machine without Runrail shows here.
 */
function RemoteSource({ onFound }: { readonly onFound: (folder: ProjectSource) => void }) {
  const { machines, loaded } = useRemotes()
  const [machineId, setMachineId] = useState<string>()
  const [path, setPath] = useState("")
  const [adding, setAdding] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void loadRemotes()
  }, [])
  const machine = machines.find((item) => item.id === machineId) ?? (machineId === undefined ? machines[0] : undefined)
  const look = async (): Promise<void> => {
    if (machine === undefined || !validRemotePath(path.trim())) return
    setChecking(true)
    setError(undefined)
    try {
      const folder = path.trim().replace(/(.)\/+$/, "$1")
      const answer = await checkRemote(machine.id, folder)
      if (answer.folder !== true) setError(`No folder at ${folder} on ${machine.host}.`)
      else onFound({ path: folder, name: remoteFolderName(folder), git: answer.git === true, remote: { id: machine.id, host: machine.host } })
    } catch (failure) {
      setError(toHostError(failure).message)
    } finally {
      setChecking(false)
    }
  }
  if (adding || (loaded && machines.length === 0))
    return (
      <div className="create-project-remote">
        {machines.length === 0 && <span className="create-project-source-text">Add the machine first, as you reach it with ssh.</span>}
        <MachineForm
          onDone={(saved) => {
            setAdding(false)
            if (saved !== undefined) setMachineId(saved.id)
          }}
        />
      </div>
    )
  return (
    <div className="create-project-remote">
      <div className="create-project-remote-row">
        <select className="input input-sm" aria-label="Remote machine" value={machine?.id ?? ""} onChange={(event) => (event.target.value === "add" ? setAdding(true) : setMachineId(event.target.value))}>
          {machines.map((item) => (
            <option key={item.id} value={item.id}>
              {item.host}
            </option>
          ))}
          <option value="add">Add a machine…</option>
        </select>
        <input
          className="input input-sm"
          aria-label="Folder on that machine"
          placeholder="/home/you/project"
          value={path}
          spellCheck={false}
          autoComplete="off"
          maxLength={4_096}
          onChange={(event) => {
            setPath(event.target.value)
            setError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void look()
            }
          }}
        />
        <Button size="sm" loading={checking} disabled={checking || machine === undefined || !validRemotePath(path.trim())} onClick={() => void look()}>
          Find
        </Button>
      </div>
      {error !== undefined && <div className="form-error">{error}</div>}
    </div>
  )
}
