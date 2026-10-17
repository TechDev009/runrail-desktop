import { ChevronRight, Plus, Search, TriangleAlert, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { closeDialog } from "../../app/actions"
import { NOT_CHAT, useCatalog } from "../../app/catalog"
import { connectionModels, connectionPresets, createShellConnection, detectShellConnections, nextSignInAccount, signInFlows } from "../../app/connections"
import { detectTools, updateConnectionSettings } from "../../app/connectionSettings"
import { modelName } from "../../app/modelText"
import { validModelId, validToolModelId, type CodingTool } from "../../app/picker"
import { toast } from "../../app/store"
import { toHostError } from "../../host"
import type { DetectedConnection, SignInFlow } from "../../protocol/schemas"
import { Button, EmptyState, Modal, Spinner } from "../common"
import { KeyForm } from "./KeyForm"
import { BackButton, Inline, StatusChip } from "./parts"
import { ModelsStep } from "./ModelsStep"
import { SignInSheet } from "./SignInSheet"
import { buildTiles, initialStep, recommendedModels, type ConnectData, type ConnectTarget, type ModelOption, type Step, type Tile } from "./steps"
import { ToolKeyStep, toolOptions, ToolSetup, ToolSignInStep } from "./ToolSetup"
import { accountsOf, connectionStatus, countText, problemText, saveProblemText } from "./text"

/**
 * "Connect a model": every way in on one screen. Subscriptions sign in, providers take a key,
 * keys the shell already exports are one click, and anything else is a custom address.
 */

/** The tile in the next or previous row whose middle is closest to this one's. */
function verticalNeighbor(tiles: readonly HTMLElement[], from: HTMLElement, direction: 1 | -1): HTMLElement | undefined {
  const origin = from.getBoundingClientRect()
  const center = origin.left + origin.width / 2
  let best: HTMLElement | undefined
  let bestRow = Number.POSITIVE_INFINITY
  let bestAcross = Number.POSITIVE_INFINITY
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect()
    const down = (rect.top - origin.top) * direction
    if (down < 4) continue
    const across = Math.abs(rect.left + rect.width / 2 - center)
    if (down < bestRow - 4 || (Math.abs(down - bestRow) <= 4 && across < bestAcross)) {
      best = tile
      bestRow = Math.min(bestRow, down)
      bestAcross = across
    }
  }
  return best
}

export function ConnectDialog({ presetId, flow, connectionId, custom, tool, models }: ConnectTarget) {
  const catalog = useCatalog(undefined)
  const [loaded, setLoaded] = useState<ConnectData | undefined>(undefined)
  const [found, setFound] = useState<readonly CodingTool[]>([])
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [step, setStep] = useState<Step | undefined>(undefined)
  const [query, setQuery] = useState("")

  useEffect(() => {
    let live = true
    setLoadError(undefined)
    // A shell that cannot be read only hides the "Found in your shell" rows.
    Promise.all([connectionPresets(), detectShellConnections().catch(() => []), signInFlows()]).then(
      ([presets, detected, flows]) => {
        if (live) setLoaded({ catalog: presets, detected, flows })
      },
      (error: unknown) => {
        if (live) setLoadError(toHostError(error).code)
      },
    )
    return () => {
      live = false
    }
  }, [attempt])

  // Which coding tools are installed only orders and marks their tiles, so the dialog does not wait for it.
  useEffect(() => {
    let live = true
    void detectTools().then((tools) => {
      if (live) setFound(tools)
    })
    return () => {
      live = false
    }
  }, [])

  // Tool connections come from the catalog, so a connection added here is counted at once.
  const data = useMemo(() => (loaded === undefined ? undefined : catalog.tools === undefined ? loaded : { ...loaded, tools: { found, connections: catalog.tools } }), [loaded, catalog.tools, found])
  const settings = catalog.tools !== undefined

  useEffect(() => {
    if (step !== undefined || data === undefined || catalog.loading) return
    setStep(initialStep({ presetId, flow, connectionId, custom, tool, models }, data, catalog.connections))
  }, [step, data, catalog.loading, catalog.connections, presetId, flow, connectionId, custom, tool, models])

  const chooseModels = settings ? (id: string): void => setStep({ kind: "models", connectionId: id, fresh: true }) : undefined

  // Opened on one connection to repair it: there is no list to go back to.
  const back = connectionId === undefined ? (): void => setStep({ kind: "pick" }) : undefined

  return (
    <Modal title={!settings ? "Connect a model" : connectionId !== undefined || models !== undefined ? "Provider settings" : "Add a provider"} onClose={closeDialog} width={700} className="connect-modal">
      {loadError !== undefined ? (
        <EmptyState
          icon={<TriangleAlert size={18} />}
          title="The providers could not be loaded"
          actions={
            <Button variant="primary" autoFocus onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          }
        >
          {problemText(loadError, "The Runrail engine did not answer.")}
        </EmptyState>
      ) : data === undefined || step === undefined ? (
        <div className="pane-loading" role="status">
          <Spinner /> Loading providers…
        </div>
      ) : step.kind === "pick" ? (
        <Pick data={data} query={query} onQuery={setQuery} onStep={setStep} />
      ) : step.kind === "key" ? (
        <KeyForm key={step.preset.id} target={{ kind: "preset", preset: step.preset, label: step.label }} onDone={closeDialog} onBack={back} onModels={chooseModels} />
      ) : step.kind === "custom" ? (
        <KeyForm target={{ kind: "custom", formats: data.catalog.custom, ...(step.label === undefined ? {} : { label: step.label }), ...(step.address === undefined ? {} : { address: step.address }) }} onDone={closeDialog} onBack={back} onModels={chooseModels} />
      ) : step.kind === "replace" ? (
        <KeyForm key={step.connection.id} target={{ kind: "replace", connection: step.connection }} onDone={closeDialog} onBack={back} />
      ) : step.kind === "accounts" ? (
        <Accounts flow={step.flow} flows={data.flows} onStep={setStep} onBack={back} />
      ) : step.kind === "sign-in" ? (
        <SignInSheet key={`${step.flow.id}:${step.accountId ?? ""}`} flow={step.flow} accountId={step.accountId} label={step.label} again={step.again} onDone={closeDialog} onBack={back} onModels={chooseModels} />
      ) : step.kind === "tool" ? (
        <ToolSetup key={step.tool} tool={step.tool} found={found} onBack={back} />
      ) : step.kind === "tool-key" ? (
        <ToolKeyStep connection={step.connection} />
      ) : step.kind === "tool-sign-in" ? (
        <ToolSignInStep connection={step.connection} />
      ) : step.kind === "models" ? (
        <ModelsEditor key={step.connectionId} connectionId={step.connectionId} fresh={step.fresh === true} found={found} />
      ) : (
        <div className="conn-step">
          {back !== undefined && <BackButton onBack={back} />}
          <h3 className="conn-step-title">{step.route.name}</h3>
          <p className="dialog-text">{step.route.detail}. It keeps its own sign-in, so there is nothing to connect here.</p>
          <ol className="conn-steps">
            {step.route.steps.map((line) => (
              <li key={line}>
                <Inline text={line} />
              </li>
            ))}
          </ol>
          <div className="conn-actions">
            <Button variant="primary" autoFocus onClick={closeDialog}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Pick({ data, query, onQuery, onStep }: { readonly data: ConnectData; readonly query: string; readonly onQuery: (value: string) => void; readonly onStep: (step: Step) => void }) {
  const catalog = useCatalog(undefined)
  const filter = useRef<HTMLInputElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const [using, setUsing] = useState<string | undefined>(undefined)
  const [shellError, setShellError] = useState<string | undefined>(undefined)
  const tiles = useMemo(() => buildTiles(query, data, catalog.connections), [query, data, catalog.connections])

  const allTiles = (): HTMLElement[] => Array.from(body.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])

  const use = async (detected: DetectedConnection): Promise<void> => {
    if (using !== undefined) return
    setUsing(detected.environmentName)
    setShellError(undefined)
    try {
      await createShellConnection(detected)
      toast("success", `${detected.name} is connected through ${detected.environmentName}.`)
      // The row leaves the list with its button; the filter takes the focus it held.
      filter.current?.focus()
    } catch (error) {
      setShellError(saveProblemText(toHostError(error).code))
    }
    setUsing(undefined)
  }

  const onFilterKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      allTiles()[0]?.focus()
    } else if (event.key === "Enter" && query.trim().length > 0) {
      event.preventDefault()
      body.current?.querySelector<HTMLElement>('[data-tile="open"]')?.click()
    } else if (event.key === "Escape" && query.length > 0) {
      // The first Escape clears the filter; the dialog closes on the next one.
      event.preventDefault()
      onQuery("")
    }
  }

  const onTileKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const from = event.target as HTMLElement
    if (!from.matches("[data-tile]") || event.metaKey || event.ctrlKey || event.altKey) return
    const list = allTiles()
    const index = list.indexOf(from)
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()
      list[index + (event.key === "ArrowRight" ? 1 : -1)]?.focus()
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next = verticalNeighbor(list, from, event.key === "ArrowDown" ? 1 : -1)
      if (next !== undefined) next.focus()
      else if (event.key === "ArrowUp") filter.current?.focus()
    } else if (event.key === "Home") {
      event.preventDefault()
      list[0]?.focus()
    } else if (event.key === "End") {
      event.preventDefault()
      list[list.length - 1]?.focus()
    } else if (event.key === "Backspace" || (event.key.length === 1 && event.key !== " ")) {
      // Typing on a tile keeps filtering: the key lands in the filter box.
      filter.current?.focus()
    }
  }

  const group = (title: string, items: readonly Tile[]) =>
    items.length > 0 && (
      <section className="conn-group" aria-label={title}>
        <h3 className="conn-group-title">{title}</h3>
        <div className="conn-tiles">
          {items.map((tile) => (
            <button key={tile.key} type="button" className="conn-tile" data-tile="open" onClick={() => onStep(tile.step)}>
              <span className="conn-tile-name">
                {tile.name}
                {tile.badge !== undefined && <span className="conn-badge">{tile.badge}</span>}
              </span>
              <span className="conn-tile-detail">{tile.detail}</span>
              {tile.count > 0 && <span className="conn-tile-count">{tile.count} connected</span>}
              <ChevronRight className="conn-tile-go" size={14} aria-hidden />
            </button>
          ))}
        </div>
      </section>
    )

  return (
    <div className="conn-pick">
      <div className="conn-filter-bar">
        <label className="search-field">
        <Search size={14} aria-hidden />
        <input ref={filter} autoFocus value={query} placeholder="Filter providers" aria-label="Filter providers" spellCheck={false} onChange={(event) => onQuery(event.target.value)} onKeyDown={onFilterKey} />
        {query.length > 0 && (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear filter"
            onClick={() => {
              onQuery("")
              filter.current?.focus()
            }}
          >
            <X size={12} />
          </button>
        )}
        </label>
      </div>
      <div ref={body} className="conn-pick-body" onKeyDown={onTileKey}>
        {tiles.shell.length > 0 && (
          <section className="conn-group" aria-label="Found in your shell">
            <h3 className="conn-group-title">Found in your shell</h3>
            <ul className="conn-shell">
              {tiles.shell.map((item) => (
                <li key={`${item.presetId}:${item.environmentName}`} className="conn-shell-row">
                  <span className="conn-shell-name">{item.name}</span>
                  <span className="conn-shell-var mono">{item.environmentName}</span>
                  <Button size="sm" data-tile="use" loading={using === item.environmentName} disabled={using !== undefined} onClick={() => void use(item)}>
                    Use
                  </Button>
                </li>
              ))}
            </ul>
            {shellError !== undefined && (
              <p className="form-error" role="alert">
                {shellError}
              </p>
            )}
            <p className="field-hint">Runrail reads the variable when a thread starts. The key is not copied or stored.</p>
          </section>
        )}
        {group("Sign in with a subscription", tiles.subscriptions)}
        {group("Coding tools on this computer", tiles.tools)}
        {group("Connect with an API key", tiles.keys)}
        {tiles.empty && (
          <EmptyState
            title={`Nothing matches "${query.trim()}"`}
            actions={
              data.catalog.custom.length > 0 ? (
                <Button icon={<Plus size={14} />} onClick={() => onStep({ kind: "custom" })}>
                  Connect a custom endpoint
                </Button>
              ) : undefined
            }
          >
            A provider that is not listed can still be connected by its address, if it speaks the OpenAI or Anthropic format.
          </EmptyState>
        )}
      </div>
    </div>
  )
}

function Accounts({ flow, flows, onStep, onBack }: { readonly flow: SignInFlow; readonly flows: readonly SignInFlow[]; readonly onStep: (step: Step) => void; readonly onBack?: (() => void) | undefined }) {
  const catalog = useCatalog(undefined)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const accounts = accountsOf(flow, catalog.connections, flows)

  const add = async (): Promise<void> => {
    setAdding(true)
    setError(undefined)
    try {
      const next = await nextSignInAccount(flow)
      onStep({ kind: "sign-in", flow, accountId: next.accountId, label: next.label, again: false })
    } catch (caught) {
      setError(saveProblemText(toHostError(caught).code))
      setAdding(false)
    }
  }

  return (
    <div className="conn-step">
      {onBack !== undefined && <BackButton onBack={onBack} disabled={adding} />}
      <h3 className="conn-step-title">{flow.label}</h3>
      <p className="dialog-text">{countText(accounts.length, "account")} already signed in here. Sign in to one again, or add another.</p>
      <ul className="conn-shell">
        {accounts.map((connection, index) => {
          const status = connectionStatus(connection, catalog.modelErrors[connection.id])
          return (
            <li key={connection.id} className="conn-shell-row">
              <span className="conn-shell-name">{connection.label}</span>
              <StatusChip tone={status.tone} label={status.label} />
              <Button size="sm" autoFocus={index === 0} disabled={adding} onClick={() => onStep({ kind: "sign-in", flow, accountId: connection.id, label: connection.label, again: true })}>
                Sign in again
              </Button>
            </li>
          )
        })}
      </ul>
      {error !== undefined && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="conn-actions">
        <Button icon={<Plus size={14} />} loading={adding} onClick={() => void add()}>
          Add another account
        </Button>
      </div>
    </div>
  )
}

/** Changes which models a connection offers, or chooses them right after it was made. */
function ModelsEditor({ connectionId, fresh, found }: { readonly connectionId: string; readonly fresh: boolean; readonly found: readonly CodingTool[] }) {
  const catalog = useCatalog(undefined)
  const tool = catalog.tools?.find((item) => item.id === connectionId)
  const provider = catalog.connections.find((item) => item.id === connectionId)
  const [listed, setListed] = useState<{ readonly options: readonly ModelOption[]; readonly problem?: string } | undefined>(undefined)

  useEffect(() => {
    if (tool !== undefined) return
    let live = true
    void connectionModels(connectionId).then((result) => {
      if (!live) return
      const options = result.models.filter((model) => !NOT_CHAT.test(model.id)).map((model) => ({ id: model.id, name: modelName({ ...model, connectionId }) }))
      setListed({ options, ...(result.code === undefined ? {} : { problem: `Its model list could not be read (${result.code}). Type the ids you use.` }) })
    })
    return () => {
      live = false
    }
  }, [connectionId, tool])

  const label = tool?.label ?? provider?.label ?? connectionId
  const options = tool !== undefined ? toolOptions(tool.tool, found) : (listed?.options ?? [])
  const current = tool?.models ?? provider?.models
  return (
    <ModelsStep
      // Chosen at the start from the list, so it starts again once the list is read.
      key={tool !== undefined || listed !== undefined ? "listed" : "loading"}
      title={`${label}: models`}
      lead="The models a thread can pick from this connection. The first chosen one is what a thread on it starts on."
      options={options}
      loading={tool === undefined && listed === undefined}
      listProblem={listed?.problem ?? (tool !== undefined && options.length === 0 ? "The tool did not list its models. Type the ids you use." : undefined)}
      initial={fresh ? undefined : current}
      recommended={fresh ? recommendedModels(options, tool !== undefined) : (current ?? [])}
      validId={tool === undefined ? validModelId : validToolModelId}
      saveLabel="Save models"
      onSkip={fresh ? closeDialog : undefined}
      onSave={async (models) => {
        await updateConnectionSettings(connectionId, { models })
        toast("success", models === null ? `${label} offers every model it lists.` : `${label} offers ${models.length === 1 ? "1 model" : `${String(models.length)} models`}.`)
        closeDialog()
      }}
    />
  )
}
