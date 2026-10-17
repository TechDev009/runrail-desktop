import { ClipboardPaste, SquareTerminal } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { closeDialog } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import {
  addToolConnection,
  adoptFirstToolDefault,
  KEY_TOOLS,
  loginLine,
  loginTerminalOffered,
  SEPARATE_ACCOUNT_TOOLS,
  storeToolKey,
  storeToolKeyFromClipboard,
  toolConnectionStatus,
  toolLoginCommand,
  type ToolAuthMode,
  type ToolConnection,
  type ToolId,
} from "../../app/connectionSettings"
import { BACKEND_LABELS } from "../../app/persist"
import { toolModels, validToolModelId, type CodingTool } from "../../app/picker"
import { toast, useApp } from "../../app/store"
import { toHostError } from "../../host"
import { Button, CopyButton, Spinner } from "../common"
import { typeInNewTerminal } from "../inspector/TerminalPane"
import { ModelsStep } from "./ModelsStep"
import { LoginTerminal, type LoginState } from "./LoginTerminal"
import { BackButton, Notice } from "./parts"
import { recommendedModels, type ModelOption } from "./steps"
import { keyProblemText, loginProblemText, saveProblemText, storeText } from "./text"

/**
 * Adding a coding tool: the login it runs as, its models, then a key or a sign-in when the login
 * is not the tool's usual one. The tool keeps every sign-in; Runrail keeps only a pasted key.
 */

type Login = "own" | "separate" | "key"

const LOGIN_TEXT: Readonly<Record<Login, { readonly title: string; readonly detail: (name: string) => string }>> = {
  own: { title: "Use the login it already has", detail: (name) => `${name} runs as it does in your terminal, with the account it is signed in to there.` },
  separate: { title: "Sign in to another account", detail: (name) => `${name} gets a folder of its own and you sign in there with ${name}'s own login. Your usual login is not touched.` },
  key: { title: "Use an API key", detail: (name) => `${name} runs in a folder of its own with a key you paste. Runrail keeps the key and hands it only to ${name}.` },
}

export function toolOptions(tool: ToolId, found: readonly CodingTool[]): ModelOption[] {
  return toolModels(found, tool).map((model) => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }), ...(model.resolved !== undefined && model.resolved !== model.name ? { note: model.resolved } : model.catalog === true ? { note: model.id } : {}) }))
}

export function ToolSetup({ tool, found, onBack }: { readonly tool: ToolId; readonly found: readonly CodingTool[]; readonly onBack?: (() => void) | undefined }) {
  const name = BACKEND_LABELS[tool]
  const detected = found.find((item) => item.id === tool)
  const choices: Login[] = ["own", ...(SEPARATE_ACCOUNT_TOOLS.includes(tool) ? (["separate"] as const) : []), ...(KEY_TOOLS.includes(tool) ? (["key"] as const) : [])]
  const [login, setLogin] = useState<Login>("own")
  const [phase, setPhase] = useState<"login" | "models">("login")
  const [made, setMade] = useState<ToolConnection | undefined>(undefined)
  const options = toolOptions(tool, found)

  const add = async (models: readonly string[] | null): Promise<void> => {
    const authMode: ToolAuthMode = login === "key" ? "api-key" : "subscription"
    const added = await addToolConnection({ tool, authMode, ...(login === "separate" ? { separateAccount: true } : {}), ...(models === null ? {} : { models }) })
    if (login === "own") {
      if (detected?.available === true && detected.signedIn === true) adoptFirstToolDefault(added)
      toast("success", `${added.label} is added. Its models are in the model menu.`)
      closeDialog()
      return
    }
    setMade(added)
  }

  // Outside the models step, which shows its own errors.
  const addNow = async (): Promise<void> => {
    try {
      await add(null)
    } catch (caught) {
      toast("error", saveProblemText(toHostError(caught).code))
    }
  }

  if (made !== undefined && made.authMode === "api-key") return <ToolKeyStep connection={made} />
  if (made !== undefined && made.separateAccount) return <ToolSignInStep connection={made} />

  if (phase === "models")
    return (
      <ModelsStep
        title={`${name}: models`}
        lead={`The models a thread can pick for ${name}. The first is what a new thread starts on.`}
        options={options}
        loading={false}
        listProblem={options.length === 0 ? `${name} lists no models here. Type the ids you use, or keep every model it offers.` : undefined}
        initial={undefined}
        recommended={recommendedModels(options, true)}
        validId={validToolModelId}
        saveLabel={login === "own" ? `Add ${name}` : "Next"}
        onBack={() => setPhase("login")}
        onSave={add}
        onSkip={options.length === 0 ? () => void addNow() : undefined}
      />
    )

  return (
    <div className="conn-step">
      {onBack !== undefined && <BackButton onBack={onBack} />}
      <h3 className="conn-step-title">{name}</h3>
      {detected?.available === false && <Notice tone="warn">{name} was not found on this computer. Install it first; a connection added now works once it is.</Notice>}
      <div className="conn-choices" role="radiogroup" aria-label={`How ${name} signs in`}>
        {choices.map((choice) => (
          <label key={choice} className="conn-choice">
            <input type="radio" name="tool-login" checked={login === choice} onChange={() => setLogin(choice)} />
            <span className="conn-choice-text">
              <span className="conn-choice-title">
                {LOGIN_TEXT[choice].title}
                {choice === "own" && detected?.signedIn === false && <span className="conn-badge">Not signed in</span>}
              </span>
              <span className="conn-choice-detail">{LOGIN_TEXT[choice].detail(name)}</span>
            </span>
          </label>
        ))}
      </div>
      {login === "own" && detected?.signedIn === false && <p className="field-hint">Sign in to {name} in a terminal first, or choose another account here.</p>}
      <div className="conn-actions">
        <Button variant="primary" autoFocus onClick={() => setPhase("models")}>
          Next
        </Button>
      </div>
    </div>
  )
}

/** Stores the key a key connection runs with. Write-only: nothing reads it back. */
export function ToolKeyStep({ connection, onBack }: { readonly connection: ToolConnection; readonly onBack?: (() => void) | undefined }) {
  const credentialStore = useApp((state) => state.credentialStore)
  const clipboardSecrets = useApp((state) => state.clipboardSecrets)
  const ids = useId()
  const keyInput = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState<"typed" | "clipboard" | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [stored, setStored] = useState(false)

  const save = async (source: "typed" | "clipboard"): Promise<void> => {
    let secret = ""
    if (source === "typed") {
      const node = keyInput.current
      const typed = node?.value ?? ""
      const trimmed = typed.trim()
      const problem = trimmed.length === 0 ? "empty" : /[\r\n]/.test(trimmed) ? "lines" : new TextEncoder().encode(trimmed).length > 16 * 1024 ? "long" : undefined
      if (problem !== undefined) {
        setError(keyProblemText(problem))
        return
      }
      secret = trimmed
      if (node !== null) node.value = ""
    }
    setBusy(source)
    setError(undefined)
    try {
      await (source === "typed" ? storeToolKey(connection.id, secret) : storeToolKeyFromClipboard(connection.id))
      secret = ""
      setStored(true)
      adoptFirstToolDefault(connection)
    } catch (caught) {
      secret = ""
      setError(saveProblemText(toHostError(caught).code))
    }
    setBusy(undefined)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save("typed")
  }

  if (stored)
    return (
      <div className="conn-step">
        <h3 className="conn-step-title">{connection.label} is ready</h3>
        <Notice tone="ok">The key is stored. A provider that refuses it ends the first turn with a clear error.</Notice>
        <div className="conn-actions">
          <Button variant="primary" autoFocus onClick={closeDialog}>
            Done
          </Button>
        </div>
      </div>
    )

  return (
    <form className="conn-step form" onSubmit={submit} noValidate>
      {onBack !== undefined && <BackButton onBack={onBack} disabled={busy !== undefined} />}
      <h3 className="conn-step-title">API key for {connection.label}</h3>
      <div className="field">
        <label className="field-label" htmlFor={`${ids}-key`}>
          API key
        </label>
        <div className="conn-key-row">
          {/* Uncontrolled on purpose: the key lives only in this node until the form is sent. */}
          <input ref={keyInput} id={`${ids}-key`} className="input mono" type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true" autoFocus disabled={busy !== undefined} placeholder="Paste the key" onInput={() => setError(undefined)} />
          {clipboardSecrets && (
            <Button type="button" icon={<ClipboardPaste size={14} />} loading={busy === "clipboard"} disabled={busy !== undefined} title="Read the key from the clipboard without showing it here" onClick={() => void save("clipboard")}>
              Paste
            </Button>
          )}
        </div>
        <span className="field-hint">{storeText(credentialStore)} It never goes into the tool's own settings.</span>
      </div>
      {error !== undefined && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="conn-actions">
        <Button type="submit" variant="primary" loading={busy === "typed"} disabled={busy !== undefined}>
          Save key
        </Button>
        <Button variant="ghost" disabled={busy !== undefined} onClick={closeDialog}>
          Add the key later
        </Button>
      </div>
    </form>
  )
}

const STATUS_POLL_MS = 2_000

/**
 * Signs a connection in with the tool's own login. The engine runs it in a terminal inside the
 * dialog, which the person types into; an older engine leaves it to a terminal tab or the person's
 * own terminal. This waits for the tool to say it is signed in.
 */
export function ToolSignInStep({ connection, onBack }: { readonly connection: ToolConnection; readonly onBack?: (() => void) | undefined }) {
  const name = BACKEND_LABELS[connection.tool]
  const catalog = useCatalog(undefined)
  const threadOpen = useApp((state) => state.layout.activeThreadId !== undefined && state.threads.some((thread) => thread.id === state.layout.activeThreadId))
  const [line, setLine] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [signedIn, setSignedIn] = useState(false)
  const [offered, setOffered] = useState<boolean | undefined>(undefined)
  const [run, setRun] = useState(0)
  const [login, setLogin] = useState<LoginState | undefined>(undefined)
  const ended = login?.kind === "ended"

  useEffect(() => {
    let live = true
    toolLoginCommand(connection.id).then(
      (login) => {
        if (live) setLine(loginLine(login))
      },
      (error: unknown) => {
        if (live) setProblem(saveProblemText(toHostError(error).code))
      },
    )
    void loginTerminalOffered().then((value) => {
      if (live) setOffered(value)
    })
    return () => {
      live = false
    }
  }, [connection.id])

  useEffect(() => {
    if (signedIn) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      void toolConnectionStatus(connection.id)
        .then((status) => {
          if (live && status.signedIn === true) setSignedIn(true)
        })
        .catch(() => undefined)
        .finally(() => {
          if (live) timer = setTimeout(ask, STATUS_POLL_MS)
        })
    }
    ask()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
    // The tool's sign-in ending is the moment to ask again, not two seconds later.
  }, [connection.id, signedIn, ended])

  useEffect(() => {
    if (signedIn) {
      adoptFirstToolDefault(connection)
      catalog.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  if (signedIn)
    return (
      <div className="conn-step">
        <h3 className="conn-step-title">{connection.label} is signed in</h3>
        <Notice tone="ok">{name} says this account is signed in. Its models are in the model menu.</Notice>
        <div className="conn-actions">
          <Button variant="primary" autoFocus onClick={closeDialog}>
            Done
          </Button>
        </div>
      </div>
    )

  const inApp = offered === true && problem === undefined
  const stopped = ended || login?.kind === "failed"
  return (
    <div className="conn-step">
      {onBack !== undefined && <BackButton onBack={onBack} />}
      <h3 className="conn-step-title">Sign in to {connection.label}</h3>
      <p className="dialog-text">
        {inApp
          ? `${name}'s own sign-in runs here. It opens a browser page or shows a code, and may ask you to paste one back; ${name} keeps what it gets${connection.separateAccount ? ", in the connection's own folder" : ""}. Runrail never sees it.`
          : `Run ${name}'s own sign-in for this account. It opens a browser page or shows a code; ${name} keeps what it gets, in the connection's own folder.`}
      </p>
      {problem !== undefined ? (
        <Notice tone="fail">{problem}</Notice>
      ) : line === undefined || offered === undefined ? (
        <div className="pane-loading" role="status">
          <Spinner /> Getting the command…
        </div>
      ) : inApp ? (
        <>
          {run > 0 && <LoginTerminal connectionId={connection.id} run={run} onState={setLogin} />}
          {login?.kind === "failed" && <Notice tone="fail">{loginProblemText(login.code, name)}</Notice>}
          {ended && <Notice tone="warn">{name}'s sign-in ended without signing in. Start it again to retry.</Notice>}
          <details className="conn-own-terminal">
            <summary>Run it in your own terminal instead</summary>
            <div className="conn-command">
              <code className="conn-code mono">{line}</code>
              <CopyButton text={line} label="Copy the command" />
            </div>
          </details>
        </>
      ) : (
        <div className="conn-command">
          <code className="conn-code mono">{line}</code>
          <CopyButton text={line} label="Copy the command" />
        </div>
      )}
      {(!inApp || run > 0) && problem === undefined && (
        <div className="conn-wait-row" role="status">
          <Spinner size={13} /> Waiting for {name} to say it is signed in…
        </div>
      )}
      <div className="conn-actions">
        {inApp && line !== undefined && (run === 0 || stopped) && (
          <Button variant="primary" icon={<SquareTerminal size={14} />} onClick={() => setRun((value) => value + 1)}>
            {run === 0 ? `Sign in with ${name}` : "Start again"}
          </Button>
        )}
        {!inApp && line !== undefined && threadOpen && (
          <Button variant="primary" icon={<SquareTerminal size={14} />} onClick={() => void typeInNewTerminal(line)}>
            Run in a terminal tab
          </Button>
        )}
        <Button variant={(inApp && (run === 0 || stopped)) || (!inApp && line !== undefined && threadOpen) ? "ghost" : "primary"} onClick={closeDialog}>
          Sign in later
        </Button>
      </div>
      {!inApp && line !== undefined && !threadOpen && <p className="field-hint">Open a thread to run it in a terminal tab here, or paste it into your own terminal.</p>}
    </div>
  )
}
