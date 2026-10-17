import { Ellipsis, KeyRound, ListChecks, LogOut, Pencil, Plug, Plus, RefreshCw, Trash, TriangleAlert } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { confirmAction, connectModel } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import { removeConnection, renameConnection, signInFlows, signOutConnection, testConnection, type Connection, type ConnectionCheck } from "../../app/connections"
import { addToolConnection, detectTools, updateConnectionSettings, type ToolId } from "../../app/connectionSettings"
import { BACKEND_LABELS } from "../../app/persist"
import { TOOL_BACKENDS, type CodingTool } from "../../app/picker"
import { toast, useApp } from "../../app/store"
import type { BackendId } from "../../host/types"
import { toHostError } from "../../host"
import type { SignInFlow } from "../../protocol/schemas"
import { Button, cx, EmptyState, IconButton, Menu, Spinner, Toggle, type MenuEntry } from "../common"
import { Notice, StatusChip } from "./parts"
import { ImageModelSection } from "./ImageModelSection"
import { ToolRow } from "./ToolRow"
import { checkText, connectionFix, connectionRoute, connectionStatus, countText, flowFor, isSignIn, problemText, saveProblemText, storeText, toolRoute, turnOnText } from "./text"

/**
 * Settings -> AI providers: every key, shell variable, sign-in, and coding tool a thread can run
 * on. From an engine without connection settings it is the older Connections list.
 */

export function ConnectionsPage() {
  const catalog = useCatalog(undefined)
  const credentialStore = useApp((state) => state.credentialStore)
  const prefs = useApp((state) => state.prefs)
  const [flows, setFlows] = useState<readonly SignInFlow[]>([])
  const [found, setFound] = useState<readonly CodingTool[]>([])
  const [nonce, setNonce] = useState(0)
  const [turning, setTurning] = useState(false)
  const settings = catalog.tools !== undefined
  const tools = catalog.tools ?? []

  useEffect(() => {
    let live = true
    // Only used to run a sign-in again; without it the row still offers the rest.
    signInFlows().then(
      (value) => {
        if (live) setFlows(value)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    let live = true
    void detectTools(nonce > 0).then((value) => {
      if (live) setFound(value)
    })
    return () => {
      live = false
    }
  }, [settings, nonce])

  const page = useRef<HTMLDivElement | null>(null)
  const count = catalog.connections.length + tools.length
  const lastCount = useRef(count)

  // A removed row takes the focus with it; the page's main action picks it up.
  useEffect(() => {
    const dropped = count < lastCount.current
    lastCount.current = count
    if (!dropped || document.activeElement !== document.body) return
    page.current?.querySelector<HTMLElement>(".conn-page-actions button:last-child:not(:disabled)")?.focus()
  }, [count])

  const reload = (): void => {
    catalog.reload()
    setNonce((value) => value + 1)
  }

  const broken = catalog.connectionsError !== undefined
  const first = catalog.loading && count === 0 && !broken
  const chosen = catalog.defaultChoice
  const isDefault = (id: string): boolean => (chosen !== undefined ? chosen.connectionId === id : prefs.defaultBackend === "native" ? prefs.defaultConnectionId === id : prefs.defaultToolConnectionId === id)
  // Installed tools no connection runs with the login they already have: listed off until turned on here.
  const offered = settings ? found.filter((tool) => tool.available === true && (TOOL_BACKENDS as readonly string[]).includes(tool.id) && !tools.some((item) => item.tool === tool.id && item.authMode === "subscription" && !item.separateAccount)) : []
  const action = settings ? "Add provider" : "Connect a model"

  // Runrail did not set these logins up, so who pays for their threads is said before any is turned on.
  const turnOn = (list: readonly CodingTool[]): void => {
    const ids = list.map((tool) => tool.id as ToolId)
    confirmAction({
      ...turnOnText(ids),
      onConfirm: () =>
        void (async () => {
          setTurning(true)
          try {
            // Every model each tool lists; turning one on never takes over the default.
            for (const tool of ids) await addToolConnection({ tool, authMode: "subscription" })
          } catch (caught) {
            toast("error", saveProblemText(toHostError(caught).code))
          }
          setTurning(false)
        })(),
    })
  }

  return (
    <div ref={page} className="settings-page conn-page">
      <div className="conn-page-head">
        <h2>{settings ? "AI providers" : "Connections"}</h2>
        <div className="conn-page-actions">
          <IconButton label="Refresh" size="sm" disabled={catalog.loading} onClick={reload}>
            <RefreshCw size={14} className={cx(catalog.loading && "spin")} />
          </IconButton>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={broken} onClick={() => connectModel()}>
            {action}
          </Button>
        </div>
      </div>
      <p className="settings-lead">
        {settings
          ? "Everything a thread can run on: a subscription you sign in to, an API key, a key your shell exports, or a coding tool on this computer. Turn one off to take it out of the model menu, and choose the models each one offers."
          : "A connection is one way to reach models: a subscription you sign in to, an API key, or a key your shell already exports. Every thread picks its model from these."}
      </p>

      {broken ? (
        <EmptyState
          icon={<TriangleAlert size={18} />}
          title="Connections could not be read"
          actions={
            <Button loading={catalog.loading} onClick={catalog.reload}>
              Try again
            </Button>
          }
        >
          {problemText(catalog.connectionsError, "The Runrail engine did not answer.")}
        </EmptyState>
      ) : first ? (
        <div className="pane-loading" role="status">
          <Spinner /> Loading connections…
        </div>
      ) : count === 0 && offered.length === 0 ? (
        <EmptyState
          icon={<Plug size={18} />}
          title={settings ? "No provider is added yet" : "No model is connected yet"}
          actions={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => connectModel()}>
              {action}
            </Button>
          }
        >
          Sign in with a subscription you already pay for, paste an API key, point Runrail at a model running on this computer{settings ? ", or add a coding tool you have installed" : ""}.
        </EmptyState>
      ) : (
        <ul className="conn-list">
          {catalog.connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              listError={catalog.modelErrors[connection.id]}
              models={catalog.models.filter((model) => model.connectionId === connection.id).length}
              flows={flows}
              isDefault={isDefault(connection.id)}
              settings={settings}
            />
          ))}
          {tools.map((tool) => (
            <ToolRow key={tool.id} connection={tool} isDefault={isDefault(tool.id)} nonce={nonce} />
          ))}
          {offered.length > 0 && (
            <li className="conn-list-head">
              <span>On this computer, not turned on</span>
              {offered.length > 1 && (
                <Button size="sm" variant="ghost" disabled={turning} onClick={() => turnOn(offered)}>
                  Turn on all
                </Button>
              )}
            </li>
          )}
          {offered.map((tool) => (
            <FoundToolRow key={tool.id} tool={tool} busy={turning} onTurnOn={() => turnOn([tool])} />
          ))}
        </ul>
      )}

      {settings && !broken && !first && <ImageModelSection connections={catalog.connections} models={catalog.imageModels} {...(catalog.imageChoice === undefined ? {} : { choice: catalog.imageChoice })} onChanged={reload} />}

      <p className="settings-foot">
        {storeText(credentialStore)}
        {settings ? " A coding tool's own sign-in stays with the tool." : " Claude Code, Codex, GitHub Copilot, and Pi threads use the login those tools already have, so they are not listed here."}
      </p>
    </div>
  )
}

/** A coding tool found on this computer that no connection runs yet with the login it already has. */
function FoundToolRow({ tool, busy, onTurnOn }: { readonly tool: CodingTool; readonly busy: boolean; readonly onTurnOn: () => void }) {
  const name = BACKEND_LABELS[tool.id as BackendId] ?? tool.id
  const version = typeof tool.version === "string" && tool.version.length > 0 ? ` · Version ${tool.version}` : ""
  return (
    <li className="conn-row is-off">
      <StatusChip tone="off" label="Off" />
      <div className="conn-row-main">
        <div className="conn-row-title">
          <span className="conn-row-name">{name}</span>
        </div>
        <div className="conn-row-meta">
          {toolRoute({ authMode: "subscription", separateAccount: false })}
          {version}
        </div>
        {tool.signedIn === false && <div className="conn-row-hint is-warn">{name} says it is not signed in. Sign in to it in a terminal, then refresh.</div>}
      </div>
      <div className="conn-row-actions">
        <Toggle checked={false} label={`Turn ${name} on`} disabled={busy} onChange={onTurnOn} />
      </div>
    </li>
  )
}

type Busy = "test" | "rename" | "remove" | "sign-out" | "toggle"

function ConnectionRow({
  connection,
  listError,
  models,
  flows,
  isDefault,
  settings,
}: {
  readonly connection: Connection
  readonly listError: string | undefined
  readonly models: number
  readonly flows: readonly SignInFlow[]
  readonly isDefault: boolean
  /** The engine keeps connection settings: the row can be turned off and its models chosen. */
  readonly settings: boolean
}) {
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [check, setCheck] = useState<ConnectionCheck | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [renaming, setRenaming] = useState(false)
  const settled = useRef(false)
  const row = useRef<HTMLLIElement | null>(null)
  const refocus = useRef(false)
  const off = connection.enabled === false
  const status = off ? { tone: "off" as const, label: "Off", hint: "Turned off: the model menu does not offer it." } : connectionStatus(connection, listError)
  const fix = connectionFix(connection, listError)
  const result = check === undefined ? undefined : checkText(check)

  const act = async (kind: Busy, run: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(kind)
    setError(undefined)
    try {
      await run()
      if (done !== undefined) toast("success", done)
    } catch (caught) {
      setError(saveProblemText(toHostError(caught).code))
    }
    setBusy(undefined)
  }

  const test = (): void =>
    void act("test", async () => {
      setCheck(undefined)
      setCheck(await testConnection(connection.id))
    })

  const repair = (): void => connectModel({ connectionId: connection.id, ...(fix?.kind === "sign-in" ? { flow: flowFor(connection, flows)?.id } : {}) })

  // A rename ended from the keyboard hands focus back to the row's menu once it is usable again.
  useEffect(() => {
    if (!refocus.current || renaming || busy !== undefined) return
    refocus.current = false
    row.current?.querySelector<HTMLButtonElement>(".conn-row-more")?.focus()
  }, [renaming, busy])

  const rename = (value: string, fromKeyboard = false): void => {
    if (settled.current) return
    settled.current = true
    refocus.current = fromKeyboard
    setRenaming(false)
    const next = value.trim()
    if (next === connection.label || next.length === 0) return
    void act("rename", () => renameConnection(connection.id, next))
  }

  const remove = (): void =>
    confirmAction({
      title: `Remove ${connection.label}?`,
      body: `${isSignIn(connection) ? "Its stored sign-in is deleted." : connection.environmentName !== undefined ? "The shell variable itself is not touched." : "Its stored key is deleted and cannot be restored."} Threads that use it keep their history, and need another model to continue.`,
      confirm: "Remove",
      danger: true,
      onConfirm: () => void act("remove", () => removeConnection(connection.id), `${connection.label} was removed.`),
    })

  const signOut = (): void =>
    confirmAction({
      title: `Sign out of ${connection.label}?`,
      body: "The stored sign-in is deleted. The connection stays in the list, so you can sign in again later.",
      confirm: "Sign out",
      onConfirm: () => void act("sign-out", () => signOutConnection(connection.id), `Signed out of ${connection.label}.`),
    })

  const items: MenuEntry[] = [
    ...(settings ? [{ id: "models", label: "Choose models", icon: <ListChecks size={14} />, onSelect: () => connectModel({ models: connection.id }) }] : []),
    {
      id: "rename",
      label: "Rename",
      icon: <Pencil size={14} />,
      onSelect: () => {
        settled.current = false
        setRenaming(true)
      },
    },
    ...(fix !== undefined && !fix.needed ? [{ id: "fix", label: fix.label, icon: <KeyRound size={14} />, onSelect: repair }] : []),
    ...(isSignIn(connection) && connection.status !== "unconfigured" ? [{ id: "sign-out", label: "Sign out", icon: <LogOut size={14} />, onSelect: signOut }] : []),
    { separator: true, id: "separator" },
    { id: "remove", label: "Remove", icon: <Trash size={14} />, danger: true, onSelect: remove },
  ]

  return (
    <li ref={row} className={cx("conn-row", busy === "remove" && "is-leaving", off && "is-off")} aria-busy={busy !== undefined}>
      <StatusChip tone={busy === "sign-out" || busy === "remove" ? "busy" : status.tone} label={busy === "remove" ? "Removing" : busy === "sign-out" ? "Signing out" : status.label} />
      <div className="conn-row-main">
        {renaming ? (
          <input
            className="input conn-rename"
            defaultValue={connection.label}
            maxLength={160}
            autoFocus
            aria-label={`New name for ${connection.label}`}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => rename(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                rename(event.currentTarget.value, true)
              } else if (event.key === "Escape") {
                // Ends the rename only; Settings stays open.
                event.preventDefault()
                event.stopPropagation()
                settled.current = true
                refocus.current = true
                setRenaming(false)
              }
            }}
          />
        ) : (
          <div className="conn-row-title">
            <span className="conn-row-name">{connection.label}</span>
            {isDefault && <span className="conn-badge">Default</span>}
          </div>
        )}
        <div className="conn-row-meta">
          {connectionRoute(connection)}
          {connection.models !== undefined ? <> · {models > 0 ? `${String(connection.models.length)} of ${countText(models, "model")}` : countText(connection.models.length, "model")}</> : status.tone === "ok" && models > 0 && <> · {countText(models, "model")}</>}
        </div>
        {error !== undefined ? (
          <Notice tone="fail" role="alert">
            {error}
          </Notice>
        ) : result !== undefined ? (
          <Notice tone={result.tone} role={result.tone === "fail" ? "alert" : "status"}>
            {result.text}
          </Notice>
        ) : (
          status.hint !== undefined && <div className={cx("conn-row-hint", `is-${status.tone}`)}>{status.hint}</div>
        )}
      </div>
      <div className="conn-row-actions">
        {fix !== undefined && fix.needed && (
          <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={repair}>
            {fix.label}
          </Button>
        )}
        <Button size="sm" loading={busy === "test"} disabled={busy !== undefined || status.tone === "off"} title={status.tone === "off" ? "Nothing to test until it is set up" : "Ask the provider whether this connection works"} onClick={test}>
          Test
        </Button>
        {settings && <Toggle checked={!off} label={off ? `Turn ${connection.label} on` : `Turn ${connection.label} off`} disabled={busy !== undefined} onChange={(enabled) => void act("toggle", () => updateConnectionSettings(connection.id, { enabled }))} />}
        <Menu
          align="end"
          items={items}
          trigger={({ open, toggle, ref }) => (
            <IconButton ref={ref} className="conn-row-more" label={`More for ${connection.label}`} size="sm" active={open} disabled={busy !== undefined} onClick={toggle}>
              <Ellipsis size={15} />
            </IconButton>
          )}
        />
      </div>
    </li>
  )
}
