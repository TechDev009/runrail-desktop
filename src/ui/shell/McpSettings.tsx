import { Cable, CircleAlert, CircleCheck, Download, KeyRound, MoreHorizontal, Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction, openDialog } from "../../app/actions"
import { applyMcpVariables, checkMcpServer, clearMcpApp, listMcpVariables, variableNames, HOSTED_SERVERS, joinArgs, listMcpSignIns, mcpFailureText, removeMcpServer, saveMcpServer, setMcpApp, setMcpEnabled, signInAddress, signInMcpServer, signOutMcpServer, signsIn, splitArgs, useMcpServers, type McpApp, type McpSignIn, type McpStatus } from "../../app/mcp"
import { useWords } from "../../app/platformWords"
import type { SignInRun, SignInView } from "../../app/signIn"
import { nifraOn } from "../../app/nifra"
import { set as setApp, toast, useApp } from "../../app/store"
import { toHostError, type McpServer } from "../../host"
import { basename, plural } from "../../lib/format"
import { Button, cx, Menu, Segmented, Select, Spinner, Toggle } from "../common"
import { signInProblem } from "../connections/text"
import { revealSetting } from "./revealSetting"

/**
 * Settings → MCP servers. The host keeps the list and shows its own confirmation, with the exact
 * command or address, before it saves one; nothing typed here starts a program or sends a request
 * by itself.
 */

const NAME = /^[a-z][a-z0-9_-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const URL_SHAPE = /^(https:\/\/[^\s/@]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?)(\/\S*)?$/

interface Draft {
  readonly name: string
  readonly transport: "program" | "address"
  readonly commandLine: string
  readonly env: string
  readonly url: string
  readonly bearerEnv: string
  /** "all", or the project folder the server is kept for. */
  readonly scope: string
}

const EMPTY: Draft = { name: "", transport: "program", commandLine: "", env: "", url: "", bearerEnv: "", scope: "all" }

/** The variable names the draft would give the server, as far as they are valid. */
function draftVariableNames(draft: Draft): readonly string[] {
  return variableNames({
    url: draft.transport === "address" ? draft.url : undefined,
    env: draft.env.split(/[\s,]+/).filter((entry) => entry.length > 0),
    ...(draft.bearerEnv.trim().length === 0 ? {} : { bearerEnv: draft.bearerEnv.trim() }),
  })
}

function draftOf(server: McpServer): Draft {
  return {
    name: server.name,
    transport: server.url === undefined ? "program" : "address",
    commandLine: server.url === undefined ? joinArgs([server.command, ...server.args]) : "",
    env: server.env.join(", "),
    url: server.url ?? "",
    bearerEnv: server.bearerEnv ?? "",
    scope: server.project ?? "all",
  }
}

/** The draft as a server, or the first thing wrong with it, worded for the form. */
export function parseDraft(draft: Draft, enabled: boolean): McpServer | string {
  const name = draft.name.trim()
  if (!NAME.test(name)) return "Name: lowercase letters, digits, - or _, starting with a letter."
  const scope = draft.scope === "all" ? {} : { project: draft.scope }
  if (draft.transport === "address") {
    const url = draft.url.trim()
    if (!URL_SHAPE.test(url)) return "Address: https, or http only for a server on this computer, with no user name or password in it."
    const bearerEnv = draft.bearerEnv.trim()
    // The entry is not echoed back: a pasted value may be the token itself.
    if (bearerEnv.length > 0 && !ENV_NAME.test(bearerEnv)) return "Token variable: a name only, such as LINEAR_API_KEY. The token stays in your shell."
    return { name, command: "", args: [], env: [], url, ...(bearerEnv.length === 0 ? {} : { bearerEnv }), ...scope, enabled }
  }
  const [command, ...args] = splitArgs(draft.commandLine.trim())
  if (command === undefined || command.length === 0) return "Enter the command that starts the server."
  if (command.startsWith("-") || /\s/.test(command)) return "The command must start with a program name or path."
  if (args.length > 32) return "At most 32 arguments."
  const env = draft.env.split(/[\s,]+/).filter((entry) => entry.length > 0)
  const bad = env.find((entry) => !ENV_NAME.test(entry))
  // The entry is not echoed back: a pasted value may be the secret itself.
  if (bad !== undefined) return "Variables: list names only, such as GITHUB_TOKEN. The values stay in your shell and are never saved here."
  if (env.length > 16) return "At most 16 variables."
  return { name, command, args, env, ...scope, enabled }
}

interface FormProject {
  readonly name: string
  readonly path: string
}

function Form({ initial, previous, enabled, project, onDone, onCancel }: { readonly initial: Draft; readonly previous?: string; readonly enabled: boolean; readonly project: FormProject | undefined; readonly onDone: (servers: readonly McpServer[]) => void; readonly onCancel: () => void }) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const words = useWords()
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set())
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(new Set())
  const names = draftVariableNames(draft)
  useEffect(() => {
    if (previous === undefined) return
    let live = true
    listMcpVariables(previous, variableNames({ url: initial.transport === "address" ? initial.url : undefined, env: initial.env.split(/[\s,]+/).filter((entry) => entry.length > 0), ...(initial.bearerEnv.length === 0 ? {} : { bearerEnv: initial.bearerEnv }) }))
      .then((names) => live && setSaved(names))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [previous]) // eslint-disable-line react-hooks/exhaustive-deps -- the saved keys are read once for the server being edited
  const renamed = previous !== undefined && previous !== draft.name.trim()
  const kept = (name: string): boolean => !renamed && saved.has(name) && !forgotten.has(name)
  const submit = (): void => {
    const parsed = parseDraft(draft, enabled)
    if (typeof parsed === "string") return setError(parsed)
    const typed = Object.fromEntries(names.flatMap((name) => ((values[name] ?? "").trim().length === 0 ? [] : [[name, (values[name] ?? "").trim()] as const])))
    if (Object.values(typed).some((value) => value.length > 4_096 || /[\0-\x1f\x7f]/.test(value))) return setError("A value is too long, or has a line break. Paste the key on its own.")
    setError(undefined)
    setSaving(true)
    saveMcpServer(parsed, previous)
      .then(async (servers) => {
        try {
          // A renamed server leaves its old keys behind; they are cleared, so re-entering is needed.
          if (renamed) await applyMcpVariables(previous, {}, [...saved])
          const stale = renamed ? [] : [...saved].filter((name) => forgotten.has(name) || !names.includes(name))
          await applyMcpVariables(parsed.name, typed, stale.filter((name) => typed[name] === undefined))
        } catch (caught) {
          toast("error", `${parsed.name} saved, but its keys were not: ${toHostError(caught).message}`)
        }
        onDone(servers)
        toast("success", `${parsed.name} saved. Threads pick it up when their agent next starts.`)
      })
      .catch((caught: unknown) => {
        const failure = toHostError(caught)
        if (failure.code !== "MCP_DECLINED") setError(failure.message)
      })
      .finally(() => setSaving(false))
  }
  return (
    <form
      className="entry-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label className="entry-field">
        <span className="entry-field-label">Name</span>
        <input className="input" value={draft.name} maxLength={32} placeholder="github" spellCheck={false} autoFocus={previous === undefined} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <span className="entry-field-hint">Its tools show up as name.tool.</span>
      </label>
      <div className="entry-field">
        <span className="entry-field-label">Runs as</span>
        <Segmented
          label="Runs as"
          value={draft.transport}
          onChange={(transport) => setDraft({ ...draft, transport })}
          options={[
            { value: "program", label: "A program on this computer" },
            { value: "address", label: "A remote address" },
          ]}
        />
      </div>
      {draft.transport === "program" ? (
        <>
          <label className="entry-field">
            <span className="entry-field-label">Command</span>
            <input className="input mono" value={draft.commandLine} maxLength={8_192} placeholder="npx -y @modelcontextprotocol/server-github" spellCheck={false} onChange={(event) => setDraft({ ...draft, commandLine: event.target.value })} />
            <span className="entry-field-hint">A local server that speaks MCP over standard input and output. It runs in the thread's project folder.</span>
          </label>
          <label className="entry-field">
            <span className="entry-field-label">Variables from your shell</span>
            <input className="input mono" value={draft.env} maxLength={1_200} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN" spellCheck={false} onChange={(event) => setDraft({ ...draft, env: event.target.value })} />
            <span className="entry-field-hint">Names only, comma separated. The server gets each value from the keys you keep below, or else from the environment Runrail starts with.</span>
          </label>
        </>
      ) : (
        <>
          <label className="entry-field">
            <span className="entry-field-label">Address</span>
            <input className="input mono" value={draft.url} maxLength={2_048} placeholder="https://mcp.linear.app/mcp" spellCheck={false} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
            <span className="entry-field-hint">A server that speaks MCP over HTTP. Plain http is allowed only for a server on this computer.</span>
          </label>
          <label className="entry-field">
            <span className="entry-field-label">Token variable (optional)</span>
            <input className="input mono" value={draft.bearerEnv} maxLength={64} placeholder="LINEAR_API_KEY" spellCheck={false} onChange={(event) => setDraft({ ...draft, bearerEnv: event.target.value })} />
            <span className="entry-field-hint">The variable that holds the server's access token, sent to this address only. Keep its value below, or set it in your shell. Leave it empty for a server you sign in to in the browser.</span>
          </label>
        </>
      )}
      {names.length > 0 && (
        <div className="entry-field" data-setting="mcp-keys">
          <span className="entry-field-label">Keys kept in your {words.keychain}</span>
          <div className="entry-secrets">
            {names.map((name) => (
              <div key={name} className="entry-secret-row">
                <code className="entry-secret-name">{name}</code>
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4_096}
                  aria-label={`Value for ${name}`}
                  value={values[name] ?? ""}
                  placeholder={kept(name) ? "Saved. Type to replace it." : "Paste the value (optional)"}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                />
                {kept(name) && (
                  <Button size="sm" variant="ghost" type="button" onClick={() => setForgotten(new Set([...forgotten, name]))}>
                    Forget
                  </Button>
                )}
              </div>
            ))}
          </div>
          <span className="entry-field-hint">
            {renamed && saved.size > 0 ? "Renaming this server forgets its saved keys, so enter them again. " : ""}
            Saved in the {words.keychain}, never in the server list, and handed only to this server when it starts. A value kept here wins over the same variable in your shell.
          </span>
        </div>
      )}
      {(project !== undefined || draft.scope !== "all") && (
        <label className="entry-field">
          <span className="entry-field-label">Use in</span>
          <Select value={draft.scope} onChange={(next) => setDraft({ ...draft, scope: next })} label="Use in">
            <option value="all">Every project</option>
            {project !== undefined && <option value={project.path}>{project.name} only</option>}
            {draft.scope !== "all" && draft.scope !== project?.path && <option value={draft.scope}>{basename(draft.scope)} only</option>}
          </Select>
        </label>
      )}
      {error !== undefined && (
        <p className="setting-hint is-error" role="alert">
          {error}
        </p>
      )}
      <div className="entry-form-actions">
        <span className="entry-field-hint">You confirm the exact {draft.transport === "program" ? "command" : "address"} in the next step.</span>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving}>
          {previous === undefined ? "Add server" : "Save"}
        </Button>
      </div>
    </form>
  )
}

function whereItRuns(server: McpServer): string {
  return server.url ?? joinArgs([server.command, ...server.args])
}

function StatusLine({ server, status, checking }: { readonly server: McpServer; readonly status: McpStatus | undefined; readonly checking: boolean }) {
  if (checking)
    return (
      <span className="entry-status">
        <Spinner size={11} /> Starting it to check…
      </span>
    )
  if (!server.enabled) return <span className="entry-status is-off">Off</span>
  if (status === undefined) return <span className="entry-status">Not checked yet</span>
  if (status.state === "ready")
    return (
      <span className="entry-status is-ok">
        <CircleCheck size={11} /> Started, {plural(status.tools, "tool")}
      </span>
    )
  return (
    <span className="entry-status is-failed" title={status.code}>
      <CircleAlert size={11} /> {mcpFailureText(status.code)}
    </span>
  )
}

/** Where a server's browser sign-in stands, in the row that started it. */
function SigningIn({ view, onOpen, onCancel }: { readonly view: SignInView; readonly onOpen: () => void; readonly onCancel: () => void }) {
  return (
    <span className="entry-status" role="status">
      <Spinner size={11} /> {view.phase === "finishing" ? "Finishing the sign-in…" : view.phase === "browser" ? "Finish signing in on the page that opened in your browser." : "Starting the sign-in…"}
      {view.phase === "browser" && (
        <button type="button" className="link-button" onClick={onOpen}>
          Open the page again
        </button>
      )}
      {view.phase !== "finishing" && (
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      )}
    </span>
  )
}

const APP_ID = /^[\x21-\x7e]{1,512}$/

/**
 * The app a server signs in with, for an authorization server that registers none: the person
 * registers one there and names it here. Its secret goes to the keychain through the host.
 */
function AppForm({ server, app, onSaved, onCancel }: { readonly server: McpServer & { readonly url: string }; readonly app: McpApp | undefined; readonly onSaved: () => void; readonly onCancel: () => void }) {
  const words = useWords()
  const [clientId, setClientId] = useState(app?.id ?? "")
  const [secret, setSecret] = useState("")
  const [port, setPort] = useState(app?.callbackPort === undefined ? "" : String(app.callbackPort))
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const submit = (): void => {
    const id = clientId.trim()
    if (!APP_ID.test(id)) return setError("App ID: the ID the provider showed when you registered the app, with no spaces.")
    const callbackPort = port.trim().length === 0 ? undefined : Number(port.trim())
    if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1_024 || callbackPort > 65_535)) return setError("Callback port: a number from 1024 to 65535, or empty for any port.")
    setError(undefined)
    setSaving(true)
    setMcpApp(server.url, { clientId: id, ...(callbackPort === undefined ? {} : { callbackPort }), ...(secret.trim().length === 0 ? {} : { secret: secret.trim() }) })
      .then(() => {
        setSecret("")
        onSaved()
      })
      .catch((caught: unknown) => setError(toHostError(caught).message))
      .finally(() => setSaving(false))
  }
  const callback = `http://127.0.0.1${port.trim().length === 0 ? "" : `:${port.trim()}`}/callback`
  return (
    <form
      className="entry-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="setting-hint">
        {server.name}'s provider does not let apps register themselves, so sign-in needs an app you register there. Register an OAuth app with <code>{callback}</code> as its callback address, then enter its ID here.
      </p>
      <label className="entry-field">
        <span className="entry-field-label">App ID</span>
        <input className="input mono" value={clientId} maxLength={512} spellCheck={false} autoComplete="off" autoFocus onChange={(event) => setClientId(event.target.value)} />
      </label>
      <label className="entry-field">
        <span className="entry-field-label">App secret (if it has one)</span>
        <input className="input" type="password" value={secret} maxLength={4_096} spellCheck={false} autoComplete="off" placeholder={app?.secret === true && app.id === clientId.trim() ? "Kept. Leave empty to keep it." : ""} onChange={(event) => setSecret(event.target.value)} />
        <span className="entry-field-hint">Kept in the {words.keychain} and sent only to the provider's token address.</span>
      </label>
      <label className="entry-field">
        <span className="entry-field-label">Callback port (optional)</span>
        <input className="input mono" value={port} inputMode="numeric" maxLength={5} placeholder="Any" spellCheck={false} onChange={(event) => setPort(event.target.value)} />
        <span className="entry-field-hint">Only when the app was registered with a fixed port.</span>
      </label>
      {error !== undefined && (
        <p className="setting-hint is-error" role="alert">
          {error}
        </p>
      )}
      <div className="entry-form-actions">
        <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving}>
          Save and sign in
        </Button>
      </div>
    </form>
  )
}

export function McpSection() {
  const { servers, loading, error, set } = useMcpServers()
  const project = useApp(useShallow((state) => state.projects.find((item) => item.id === (state.layout.activeProjectId ?? state.projects[0]?.id))))
  const [editing, setEditing] = useState<string | "new" | undefined>()
  const [statuses, setStatuses] = useState<Readonly<Record<string, McpStatus>>>({})
  const [checking, setChecking] = useState<string | undefined>()
  // Undefined until the engine answers; an engine without a credential store offers no sign-in.
  const [known, setKnown] = useState<ReadonlyMap<string, McpSignIn> | undefined>()
  const [signing, setSigning] = useState<{ readonly name: string; readonly view: SignInView } | undefined>()
  const [appFor, setAppFor] = useState<string | undefined>()
  const [connecting, setConnecting] = useState<string | undefined>()
  const [seed, setSeed] = useState<Draft>(EMPTY)
  const run = useRef<SignInRun | undefined>(undefined)
  const nifra = useApp((state) => nifraOn(state.prefs))

  const refreshSignIns = (): void => {
    listMcpSignIns()
      .then(setKnown)
      .catch(() => setKnown(undefined))
  }
  const entryOf = (server: McpServer): McpSignIn | undefined => (server.url === undefined ? undefined : known?.get(signInAddress(server.url)))
  useEffect(refreshSignIns, [])
  // Leaving the page ends a sign-in still waiting, so none keeps a callback port open behind it.
  useEffect(() => () => void run.current?.cancel(), [])

  const check = (name: string): void => {
    if (project === undefined) return
    setChecking(name)
    checkMcpServer(project.id, name)
      .then((status) => setStatuses((current) => ({ ...current, [name]: status })))
      .catch((caught: unknown) => toast("error", `Check failed: ${toHostError(caught).message}`))
      .finally(() => setChecking(undefined))
  }

  const signIn = (server: McpServer & { readonly url: string }): void => {
    void run.current?.cancel()
    run.current = signInMcpServer(server, (view) => {
      setSigning({ name: server.name, view })
      if (view.phase === "done") {
        setSigning(undefined)
        // Shown at once; the engine's own list follows.
        const address = signInAddress(server.url)
        setKnown((current) => new Map([...(current ?? []), [address, { ...(current?.get(address) ?? { url: address, updatedAt: Date.now() }), signedIn: true }]]))
        refreshSignIns()
        toast("success", `Signed in to ${server.name}. Threads use it when their agent next starts.`)
        if (project !== undefined && (server.project === undefined || server.project === project.path)) check(server.name)
      } else if (view.phase === "failed" && view.code === "AUTH_CLIENT_REQUIRED") {
        // The form says what is needed; a toast would only repeat it.
        setSigning(undefined)
        setAppFor(server.name)
      } else if (view.phase === "failed") {
        setSigning(undefined)
        const problem = signInProblem(view.code)
        toast("error", `${problem.title}. ${problem.next} (${view.code ?? "AUTH_FAILED"})`)
      } else if (view.phase === "cancelled") setSigning(undefined)
    })
  }

  /** Saves a hosted server after the host's confirmation, then starts its browser sign-in. */
  const connectHosted = (hosted: (typeof HOSTED_SERVERS)[number]): void => {
    const server: McpServer = { name: hosted.name, command: "", args: [], env: [], url: hosted.url, enabled: true }
    setConnecting(hosted.name)
    saveMcpServer(server, undefined)
      .then((list) => {
        set(list)
        signIn({ ...server, url: hosted.url })
      })
      .catch((caught: unknown) => {
        const failure = toHostError(caught)
        if (failure.code !== "MCP_DECLINED") toast("error", failure.message)
      })
      .finally(() => setConnecting(undefined))
  }

  const forgetApp = (server: McpServer & { readonly url: string }): void => {
    clearMcpApp(server.url)
      .then(() => {
        refreshSignIns()
        toast("success", `${server.name} no longer signs in with your app.`)
      })
      .catch((caught: unknown) => toast("error", toHostError(caught).message))
  }

  const signOut = (server: McpServer & { readonly url: string }): void => {
    signOutMcpServer(server.url)
      .then(() => {
        refreshSignIns()
        setStatuses(({ [server.name]: _dropped, ...rest }) => rest)
        toast("success", `Signed out of ${server.name}.`)
      })
      .catch((caught: unknown) => toast("error", toHostError(caught).message))
  }

  return (
    <div className="settings-page" data-setting="mcp-servers">
      <h2>MCP servers</h2>
      <p className="settings-lead">Tools from Model Context Protocol servers, for threads on Runrail's own loop. Claude Code and Codex keep their own MCP settings.</p>
      <p className="setting-hint" data-setting="mcp-nifra">
        {nifra
          ? "In a Nifra project, Runrail also starts the nifra MCP server on your PATH for these threads; the thread header then shows Nifra. Nifra is made by the authors of Runrail. "
          : "Nifra's MCP server is off. "}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setApp({ settings: "general" })
            revealSetting("nifra")
          }}
        >
          {nifra ? "Turn it off" : "Turn it on"}
        </button>
      </p>
      {loading ? (
        <div className="pane-loading">
          <Spinner size={12} /> Loading servers…
        </div>
      ) : error !== undefined ? (
        <p className="setting-hint is-error">{error}</p>
      ) : (
        <>
          {servers.length === 0 && editing !== "new" && (
            <div className="entry-empty">
              <Cable size={18} />
              <span>No servers yet. Add one to give the agent tools such as GitHub, a database, or your docs.</span>
            </div>
          )}
          {servers.length > 0 && (
            <ul className="entry-list">
              {servers.map((server) =>
                appFor === server.name && server.url !== undefined ? (
                  <li key={server.name} className="entry-row is-editing">
                    <AppForm
                      server={{ ...server, url: server.url }}
                      app={entryOf(server)?.client}
                      onCancel={() => setAppFor(undefined)}
                      onSaved={() => {
                        setAppFor(undefined)
                        refreshSignIns()
                        signIn({ ...server, url: server.url! })
                      }}
                    />
                  </li>
                ) : editing === server.name ? (
                  <li key={server.name} className="entry-row is-editing">
                    <Form
                      initial={draftOf(server)}
                      previous={server.name}
                      enabled={server.enabled}
                      project={project}
                      onCancel={() => setEditing(undefined)}
                      onDone={(list) => {
                        set(list)
                        setEditing(undefined)
                        setStatuses({})
                      }}
                    />
                  </li>
                ) : (
                  <li key={server.name} className={cx("entry-row", !server.enabled && "is-off")}>
                    <span className="entry-mark" aria-hidden="true">
                      <Cable size={13} />
                    </span>
                    <span className="entry-text">
                      <span className="entry-name">{server.name}</span>
                      <code className="entry-command" title={whereItRuns(server)}>
                        {whereItRuns(server)}
                      </code>
                      {server.project !== undefined && <span className="entry-scope">Only in {server.project === project?.path ? project.name : basename(server.project)}</span>}
                      {signsIn(server) && entryOf(server) !== undefined && <span className="entry-scope">{entryOf(server)?.signedIn === true ? (entryOf(server)?.client === undefined ? "Signed in" : "Signed in with your app") : "Signs in with your app"}</span>}
                      {signing?.name === server.name ? (
                        <SigningIn view={signing.view} onOpen={() => void run.current?.open().catch((caught: unknown) => toast("error", `The page could not be opened. (${toHostError(caught).code})`))} onCancel={() => void run.current?.cancel()} />
                      ) : (
                        <StatusLine server={server} status={statuses[server.name]} checking={checking === server.name} />
                      )}
                    </span>
                    {server.url !== undefined && signsIn(server) && known !== undefined && entryOf(server)?.signedIn !== true && signing?.name !== server.name && (
                      <Button size="sm" variant="ghost" icon={<KeyRound size={13} />} disabled={signing !== undefined} title="Sign in to this server in your browser" onClick={() => signIn({ ...server, url: server.url! })}>
                        Sign in
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={project === undefined || checking !== undefined || (server.project !== undefined && server.project !== project.path)} title={project === undefined ? "Open a project to check a server" : server.project !== undefined && server.project !== project.path ? "Open its project to check it" : server.url === undefined ? "Start it once and list its tools" : "Connect once and list its tools"} onClick={() => check(server.name)}>
                      Check
                    </Button>
                    <Toggle
                      label={`Use ${server.name}`}
                      checked={server.enabled}
                      onChange={(enabled) => {
                        setMcpEnabled(server.name, enabled)
                          .then(set)
                          .catch((caught: unknown) => toast("error", toHostError(caught).message))
                      }}
                    />
                    <Menu
                      align="end"
                      width={180}
                      items={[
                        { id: "edit", label: "Edit", onSelect: () => setEditing(server.name) },
                        ...(server.url !== undefined && signsIn(server) && known !== undefined ? [{ id: "app", label: entryOf(server)?.client === undefined ? "Sign in with your own app…" : "Change your app…", onSelect: () => setAppFor(server.name) }] : []),
                        ...(server.url !== undefined && entryOf(server)?.client !== undefined ? [{ id: "forget-app", label: "Forget your app", onSelect: () => forgetApp({ ...server, url: server.url! }) }] : []),
                        ...(server.url !== undefined && entryOf(server)?.signedIn === true ? [{ id: "signout", label: "Sign out", onSelect: () => signOut({ ...server, url: server.url! }) }] : []),
                        {
                          id: "remove",
                          label: "Remove",
                          danger: true,
                          onSelect: () =>
                            confirmAction({
                              title: `Remove ${server.name}?`,
                              body: entryOf(server) !== undefined ? "Threads stop getting its tools when their agent next starts, and its sign-in and app are forgotten." : "Threads stop getting its tools when their agent next starts.",
                              confirm: "Remove",
                              danger: true,
                              onConfirm: () => {
                                const kept = entryOf(server)
                                const url = server.url
                                removeMcpServer(server.name)
                                  .then(async (list) => {
                                    set(list)
                                    if (kept !== undefined && url !== undefined) {
                                      if (kept.signedIn) await signOutMcpServer(url)
                                      if (kept.client !== undefined) await clearMcpApp(url)
                                      refreshSignIns()
                                    }
                                  })
                                  .catch((caught: unknown) => toast("error", toHostError(caught).message))
                              },
                            }),
                        },
                      ]}
                      trigger={({ toggle, ref, open }) => (
                        <button ref={ref} type="button" className={cx("icon-btn", "icon-btn-sm", open && "is-active")} onClick={toggle} aria-haspopup="menu" aria-label={`More for ${server.name}`}>
                          <MoreHorizontal size={14} />
                        </button>
                      )}
                    />
                  </li>
                ),
              )}
            </ul>
          )}
          {editing === "new" ? (
            <div className="entry-row is-editing">
              <Form
                initial={seed}
                enabled
                project={project}
                onCancel={() => setEditing(undefined)}
                onDone={(list) => {
                  set(list)
                  setEditing(undefined)
                }}
              />
            </div>
          ) : (
            <div className="entry-add">
              <Button
                icon={<Plus size={13} />}
                disabled={servers.length >= 16 || editing !== undefined}
                onClick={() => {
                  setSeed(EMPTY)
                  setEditing("new")
                }}
              >
                Add server
              </Button>
              <Button icon={<Download size={13} />} disabled={project === undefined || servers.length >= 16 || editing !== undefined} title={project === undefined ? "Open a project first" : "Servers set up in Claude Code, Codex, Cursor, and other tools"} onClick={() => project !== undefined && openDialog({ kind: "other-tools", section: "servers", projectId: project.id })} data-setting="mcp-import">
                From other tools…
              </Button>
              {servers.length >= 16 && <span className="setting-hint">At most 16 servers.</span>}
            </div>
          )}
          {editing === undefined && servers.length < 16 && HOSTED_SERVERS.some((hosted) => !servers.some((server) => server.name === hosted.name || server.url === hosted.url)) && (
            <div className="entry-hosted" data-setting="mcp-hosted">
              <div className="entry-hosted-copy">
                <span className="entry-hosted-title">Connect with a browser sign-in</span>
                <span className="entry-hosted-hint">No key to paste. Runrail asks you to confirm the address, then opens the provider's page.</span>
              </div>
              <div className="entry-hosted-list">
                {HOSTED_SERVERS.filter((hosted) => !servers.some((server) => server.name === hosted.name || server.url === hosted.url)).map((hosted) => (
                  <Button
                    key={hosted.name}
                    icon={<KeyRound size={13} />}
                    loading={connecting === hosted.name}
                    disabled={connecting !== undefined || signing !== undefined}
                    title={hosted.ownApp === true ? `${hosted.url} (needs an app you register with GitHub)` : hosted.url}
                    onClick={() => connectHosted(hosted)}
                  >
                    {hosted.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
