import { Cable, CircleAlert, CircleCheck, Download, MoreHorizontal, Plus } from "lucide-react"
import { useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction, openDialog } from "../../app/actions"
import { checkMcpServer, joinArgs, mcpFailureText, removeMcpServer, saveMcpServer, setMcpEnabled, splitArgs, useMcpServers, type McpStatus } from "../../app/mcp"
import { nifraOn } from "../../app/nifra"
import { set as setApp, toast, useApp } from "../../app/store"
import { toHostError, type McpServer } from "../../host"
import { basename, plural } from "../../lib/format"
import { Button, cx, Menu, Segmented, Spinner, Toggle } from "../common"
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
  const submit = (): void => {
    const parsed = parseDraft(draft, enabled)
    if (typeof parsed === "string") return setError(parsed)
    setError(undefined)
    setSaving(true)
    saveMcpServer(parsed, previous)
      .then((servers) => {
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
            <span className="entry-field-hint">Names only, comma separated. The server gets their values from the environment Runrail starts with; nothing secret is saved here.</span>
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
            <span className="entry-field-hint">The name of a shell variable holding the server's access token. Its value is sent to this address only, and is never saved here.</span>
          </label>
        </>
      )}
      {(project !== undefined || draft.scope !== "all") && (
        <label className="entry-field">
          <span className="entry-field-label">Use in</span>
          <select className="select" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })} aria-label="Use in">
            <option value="all">Every project</option>
            {project !== undefined && <option value={project.path}>{project.name} only</option>}
            {draft.scope !== "all" && draft.scope !== project?.path && <option value={draft.scope}>{basename(draft.scope)} only</option>}
          </select>
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

export function McpSection() {
  const { servers, loading, error, set } = useMcpServers()
  const project = useApp(useShallow((state) => state.projects.find((item) => item.id === (state.layout.activeProjectId ?? state.projects[0]?.id))))
  const [editing, setEditing] = useState<string | "new" | undefined>()
  const [statuses, setStatuses] = useState<Readonly<Record<string, McpStatus>>>({})
  const [checking, setChecking] = useState<string | undefined>()
  const nifra = useApp((state) => nifraOn(state.prefs))

  const check = (name: string): void => {
    if (project === undefined) return
    setChecking(name)
    checkMcpServer(project.id, name)
      .then((status) => setStatuses((current) => ({ ...current, [name]: status })))
      .catch((caught: unknown) => toast("error", `Check failed: ${toHostError(caught).message}`))
      .finally(() => setChecking(undefined))
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
                editing === server.name ? (
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
                      <StatusLine server={server} status={statuses[server.name]} checking={checking === server.name} />
                    </span>
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
                        {
                          id: "remove",
                          label: "Remove",
                          danger: true,
                          onSelect: () =>
                            confirmAction({
                              title: `Remove ${server.name}?`,
                              body: "Threads stop getting its tools when their agent next starts.",
                              confirm: "Remove",
                              danger: true,
                              onConfirm: () => {
                                removeMcpServer(server.name)
                                  .then(set)
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
                initial={EMPTY}
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
              <Button size="sm" icon={<Plus size={13} />} disabled={servers.length >= 16 || editing !== undefined} onClick={() => setEditing("new")}>
                Add server
              </Button>
              <Button size="sm" variant="ghost" icon={<Download size={13} />} disabled={project === undefined || servers.length >= 16 || editing !== undefined} title={project === undefined ? "Open a project first" : "Servers set up in Claude Code, Codex, Cursor, and other tools"} onClick={() => project !== undefined && openDialog({ kind: "other-tools", section: "servers", projectId: project.id })} data-setting="mcp-import">
                From other tools…
              </Button>
              {servers.length >= 16 && <span className="setting-hint">At most 16 servers.</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
