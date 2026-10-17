import { Blocks, Check, Info, KeyRound, Plug, Puzzle, Server, ShieldCheck } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { confirmAction } from "../../app/actions"
import {
  CONNECTOR_IDS,
  CONNECTOR_INFO,
  connectConnector,
  disconnectConnector,
  GRANT_LABELS,
  GRANT_ROLES,
  grantOf,
  GRANTS,
  loadConnectors,
  mcpKey,
  setGrant,
  useConnectors,
  type ConnectorId,
  type ConnectorStatus,
} from "../../app/integrations"
import { useMcpServers } from "../../app/mcp"
import type { IntegrationGrant } from "../../app/persist"
import { useWords } from "../../app/platformWords"
import { toast, useApp, type View } from "../../app/store"
import { toHostError } from "../../host"
import { McpSection } from "../shell/McpSettings"
import { Button, cx, Spinner } from "../common"
import { ExtensionsView } from "./Extensions"

/**
 * Integrations: the built-in connectors, MCP servers, who may use what, and the
 * plugins and skills Extensions used to hold. Connectors and grants reach a thread's engine when it
 * starts, so a change here restarts the engines.
 */

export type IntegrationsSection = NonNullable<Extract<View, { readonly kind: "integrations" }>["section"]>

/** Each service's mark: its initial on its own tint (no brand artwork is shipped). */
const CONNECTOR_MARKS: Readonly<Record<ConnectorId, string>> = { github: "GH", linear: "L", slack: "S", jira: "J" }

const SECTIONS: readonly { readonly id: IntegrationsSection; readonly label: string; readonly icon: ReactNode }[] = [
  { id: "connectors", label: "Connectors", icon: <Plug size={14} /> },
  { id: "mcp", label: "MCP servers", icon: <Server size={14} /> },
  { id: "grants", label: "Who may use what", icon: <ShieldCheck size={14} /> },
  { id: "extensions", label: "Plugins and skills", icon: <Puzzle size={14} /> },
]

export function IntegrationsView({ section: wanted }: { readonly section?: IntegrationsSection | undefined }) {
  const [section, setSection] = useState<IntegrationsSection>(wanted ?? "connectors")
  const connectors = useConnectors((state) => state.connectors)
  const { servers } = useMcpServers()

  useEffect(() => {
    if (wanted !== undefined) setSection(wanted)
  }, [wanted])
  useEffect(() => {
    void loadConnectors()
  }, [])

  const counts: Partial<Record<IntegrationsSection, number>> = { connectors: connectors?.filter((item) => item.on).length ?? 0, mcp: servers.length }
  return (
    <main className="agents integrations" aria-label="Integrations">
      <nav className="agents-list" aria-label="Integration kinds">
        <div className="agents-list-top" data-tauri-drag-region>
          <span className="agents-title">Integrations</span>
        </div>
        {SECTIONS.map((item) => (
          <button key={item.id} type="button" className={cx("agents-item", item.id === section && "is-active")} aria-current={item.id === section ? "page" : undefined} onClick={() => setSection(item.id)}>
            <span className="agents-item-title">
              {item.icon}
              <span className="integrations-item-name">{item.label}</span>
              {counts[item.id] !== undefined && <span className={cx("integrations-count", (counts[item.id] ?? 0) > 0 && "is-some")}>{counts[item.id]}</span>}
            </span>
          </button>
        ))}
        <p className="agents-note integrations-footnote">GitHub, Linear, Slack and Jira are built in. Anything else comes in as an MCP server.</p>
      </nav>
      <section className="agents-detail">
        <div className="agents-detail-top" data-tauri-drag-region />
        <div className="agents-body integrations-body">
          {section === "connectors" && <Connectors connectors={connectors} />}
          {section === "mcp" && <McpSection />}
          {section === "grants" && <Grants connectors={connectors} servers={servers.map((server) => server.name)} />}
          {section === "extensions" && (
            <>
              <Head title="Plugins and skills" lead="What the agent can do beyond its built-in tools, per project." />
              <ExtensionsView embedded />
            </>
          )}
        </div>
      </section>
    </main>
  )
}

function Head({ title, lead }: { readonly title: string; readonly lead: string }) {
  return (
    <header className="integrations-head">
      <h1>{title}</h1>
      <p className="muted">{lead}</p>
    </header>
  )
}

function Connectors({ connectors }: { readonly connectors: readonly ConnectorStatus[] | undefined }) {
  const words = useWords()
  const error = useConnectors((state) => state.error)
  return (
    <>
      <Head title="Connectors" lead={`Each service is reached at its own address only. A key goes to the ${words.keychain} through Runrail's own path and is read only when a call is made.`} />
      {error !== undefined && <p className="agents-note is-error">{error}</p>}
      {connectors === undefined && error === undefined ? (
        <p className="agents-note" role="status">
          <Spinner size={12} /> Reading connectors…
        </p>
      ) : (
        <div className="integrations-grid">
          {CONNECTOR_IDS.map((id) => (
            <ConnectorCard key={id} id={id} status={connectors?.find((item) => item.id === id)} />
          ))}
        </div>
      )}
    </>
  )
}

function ConnectorCard({ id, status }: { readonly id: ConnectorId; readonly status: ConnectorStatus | undefined }) {
  const words = useWords()
  const info = CONNECTOR_INFO[id]
  const [form, setForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const on = status?.on === true
  const connected = on && status?.connected === true
  const viaGh = id === "github"

  const act = async (work: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await work()
      toast("success", done)
      setForm(false)
    } catch (error) {
      toast("error", toHostError(error).message)
    } finally {
      setBusy(false)
    }
  }
  const disconnect = (): void =>
    confirmAction({
      title: `Disconnect ${info.name}?`,
      body: viaGh ? "Threads stop getting GitHub's tools. Your gh sign-in stays as it is." : `Threads stop getting its tools, and its key is removed from the ${words.keychain}.`,
      confirm: "Disconnect",
      danger: true,
      onConfirm: () => void act(() => disconnectConnector(id), `${info.name} disconnected`),
    })

  return (
    <article className={cx("integrations-card", !on && "is-off", connected && "is-connected")} aria-label={info.name}>
      <div className="integrations-card-top">
        <span className={cx("integrations-logo", `is-${id}`)} aria-hidden="true">
          {CONNECTOR_MARKS[id]}
        </span>
        <span className="integrations-card-title">
          <strong>{info.name}</strong>
          <span className="integrations-does">{info.does}</span>
        </span>
        {connected ? (
          <span className="integrations-state is-ok">
            <Check size={11} aria-hidden /> Connected
          </span>
        ) : on ? (
          <span className="integrations-state is-warn">{viaGh ? "Sign in with gh" : "Needs a key"}</span>
        ) : (
          <span className="integrations-state">Not connected</span>
        )}
      </div>
      <span className="integrations-line">
        <Info size={12} aria-hidden />
        <span>
          {viaGh ? (
            <>
              Your own <code>gh</code> sign-in. No token kept by Runrail.
            </>
          ) : connected ? (
            `${info.keyLabel ?? "Key"} in the ${words.keychain}${status?.site === undefined ? "" : ` · ${status.site}`}`
          ) : (
            info.keyHelp
          )}
        </span>
      </span>
      {form && !viaGh ? (
        <KeyForm id={id} busy={busy} onCancel={() => setForm(false)} onSave={(input) => void act(() => connectConnector(id, input), `${info.name} connected`)} />
      ) : (
        <div className="integrations-actions">
          {!on && (
            <Button size="sm" variant="primary" disabled={busy} icon={viaGh ? <Plug size={13} /> : <KeyRound size={13} />} onClick={() => (viaGh ? void act(() => connectConnector(id, {}), "GitHub connected") : setForm(true))}>
              Connect {info.name}
            </Button>
          )}
          {on && !viaGh && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(true)}>
              {connected ? "Replace key" : "Add key"}
            </Button>
          )}
          {on && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

function KeyForm({
  id,
  busy,
  onCancel,
  onSave,
}: {
  readonly id: ConnectorId
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onSave: (input: { readonly key: string; readonly site?: string; readonly email?: string }) => void
}) {
  const info = CONNECTOR_INFO[id]
  const [key, setKey] = useState("")
  const [site, setSite] = useState("")
  const [email, setEmail] = useState("")
  const jira = id === "jira"
  const ready = key.trim().length > 0 && (!jira || (site.trim().length > 0 && email.trim().length > 0))
  return (
    <form
      className="integrations-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onSave({ key: key.trim(), ...(jira ? { site: site.trim(), email: email.trim() } : {}) })
      }}
    >
      {jira && (
        <>
          <label className="field">
            <span className="field-label">Site</span>
            <input className="input" value={site} placeholder="your-team.atlassian.net" autoComplete="off" spellCheck={false} onChange={(event) => setSite(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Account email</span>
            <input className="input" type="email" value={email} autoComplete="off" spellCheck={false} onChange={(event) => setEmail(event.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        <span className="field-label">{info.keyLabel ?? "Key"}</span>
        <input className="input" type="password" value={key} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => setKey(event.target.value)} />
      </label>
      <div className="integrations-actions">
        <Button size="sm" variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Grants({ connectors, servers }: { readonly connectors: readonly ConnectorStatus[] | undefined; readonly servers: readonly string[] }) {
  const grants = useApp((state) => state.prefs.integrationGrants)
  const rows: readonly { readonly key: string; readonly label: string; readonly off: boolean }[] = [
    ...CONNECTOR_IDS.map((id) => ({ key: id, label: CONNECTOR_INFO[id].name, off: connectors?.find((item) => item.id === id)?.on !== true })),
    ...servers.map((name) => ({ key: mcpKey(name), label: name, off: false })),
  ]
  return (
    <>
      <Head title="Who may use what" lead="Per role, for the connectors and the MCP servers Runrail starts. Ask means each use waits for you; Write still asks before each write." />
      <div className="integrations-table-wrap">
        <table className="integrations-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Integration</span>
              </th>
              {GRANT_ROLES.map((role) => (
                <th key={role.role} scope="col">
                  {role.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={cx(row.off && "is-off")}>
                <th scope="row">
                  {row.key.startsWith("mcp:") && <Blocks size={12} aria-hidden />} {row.label}
                  {row.off && <span className="muted"> · not connected</span>}
                </th>
                {GRANT_ROLES.map((role) => {
                  const grant = grantOf(grants, role.role, row.key)
                  return (
                    <td key={role.role}>
                      <select
                        className={cx("select select-sm integrations-grant", `is-${grant}`)}
                        aria-label={`${row.label} for ${role.label}`}
                        value={grant}
                        onChange={(event) => setGrant(role.role, row.key, event.target.value as IntegrationGrant)}
                      >
                        {GRANTS.map((value) => (
                          <option key={value} value={value}>
                            {GRANT_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="form-hint">
        A role in a setup or a workflow step uses its column; a thread reviewing a pull request is a Reviewer. Codex gets only what runs without asking, and ACP tools and Pi get none yet. A coding tool's own tools and
        its own MCP settings are outside this.
      </p>
    </>
  )
}
