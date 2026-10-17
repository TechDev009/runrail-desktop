import { ArrowUp, Plus, Search, X } from "lucide-react"
import { useMemo, useState, type FormEvent } from "react"
import { toHostError } from "../../host"
import { Button, IconButton, Spinner } from "../common"
import { BackButton, Notice } from "./parts"
import { chooseModel, dropModel, firstModel, type ModelOption } from "./steps"
import { countText, saveProblemText } from "./text"

/**
 * The models a connection offers: the ones it lists, the ones chosen from them, and any typed in.
 * The first chosen model is the connection's default. A list with nothing chosen cannot be saved.
 */
export function ModelsStep({
  title,
  lead,
  options,
  loading,
  listProblem,
  initial,
  recommended,
  validId,
  saveLabel,
  onSave,
  onBack,
  onSkip,
}: {
  readonly title: string
  readonly lead: string
  readonly options: readonly ModelOption[]
  readonly loading: boolean
  /** Why the list could not be read; typing an id still works. */
  readonly listProblem?: string | undefined
  /** What is chosen now; undefined is every model the connection lists. */
  readonly initial: readonly string[] | undefined
  /** Chosen at the start for a new connection. */
  readonly recommended: readonly string[]
  readonly validId: (id: string) => boolean
  readonly saveLabel: string
  /** `null` offers every model the connection lists, including ones it adds later. */
  readonly onSave: (models: readonly string[] | null) => Promise<void>
  readonly onBack?: (() => void) | undefined
  /** Leaves the list as it is. */
  readonly onSkip?: (() => void) | undefined
}) {
  // A connection on every model stays on every model when its list cannot be read; only a choice narrows it.
  const [every, setEvery] = useState(initial === undefined && recommended.length === 0)
  const [chosen, setChosen] = useState<readonly string[]>(initial ?? recommended)
  const [query, setQuery] = useState("")
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const names = useMemo(() => new Map(options.map((option) => [option.id, option.name ?? option.id])), [options])
  const needle = query.trim().toLowerCase()
  const shown = needle.length === 0 ? options : options.filter((option) => option.id.toLowerCase().includes(needle) || (option.name ?? "").toLowerCase().includes(needle))
  const typedId = typed.trim()
  const canAdd = typedId.length > 0 && validId(typedId) && !chosen.includes(typedId)
  const canSave = !busy && (every ? options.length > 0 || initial === undefined : chosen.length > 0)

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      await onSave(every ? null : chosen)
    } catch (caught) {
      setError(saveProblemText(toHostError(caught).code))
      setBusy(false)
    }
  }

  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (!canAdd) return
    setChosen((current) => chooseModel(current, typedId))
    setTyped("")
    setEvery(false)
  }

  return (
    <div className="conn-step">
      {onBack !== undefined && <BackButton onBack={onBack} disabled={busy} />}
      <h3 className="conn-step-title">{title}</h3>
      <p className="dialog-text">{lead}</p>
      {loading ? (
        <div className="pane-loading" role="status">
          <Spinner /> Loading its models…
        </div>
      ) : (
        <>
          {listProblem !== undefined && <Notice tone="warn">{listProblem}</Notice>}
          {(options.length > 0 || initial === undefined) && (
            <label className="conn-every">
              <input type="checkbox" checked={every} disabled={busy} onChange={(event) => setEvery(event.target.checked)} />
              <span>{options.length > 0 ? `Every model it lists (${String(options.length)}), including ones it adds later` : "Every model it lists, including ones it adds later"}</span>
            </label>
          )}
          {!every && (
            <div className="conn-models">
              <section className="conn-models-col" aria-label="Chosen models">
                <h4 className="conn-group-title">Chosen ({chosen.length})</h4>
                {chosen.length === 0 ? (
                  <p className="field-hint">Choose at least one model.</p>
                ) : (
                  <ul className="conn-shell">
                    {chosen.map((id, index) => (
                      <li key={id} className="conn-shell-row">
                        <span className="conn-shell-name" title={id}>
                          {names.get(id) ?? id}
                        </span>
                        {index === 0 ? (
                          <span className="conn-badge" title="A thread on this connection starts on it">
                            Default
                          </span>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<ArrowUp size={12} />} disabled={busy} title="A thread on this connection starts on its default" onClick={() => setChosen((current) => firstModel(current, id))}>
                            Make default
                          </Button>
                        )}
                        <IconButton size="sm" label={`Remove ${names.get(id) ?? id}`} disabled={busy} onClick={() => setChosen((current) => dropModel(current, id))}>
                          <X size={12} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="conn-key-row" onSubmit={add}>
                  <input className="input" value={typed} placeholder="Add a model id" aria-label="Add a model id" spellCheck={false} disabled={busy} onChange={(event) => setTyped(event.target.value)} />
                  <Button type="submit" size="sm" icon={<Plus size={12} />} disabled={!canAdd}>
                    Add
                  </Button>
                </form>
                {typedId.length > 0 && !validId(typedId) && <p className="form-error">That is not a model id: letters, digits, and . _ - : / @ + only.</p>}
              </section>
              {options.length > 0 && (
                <section className="conn-models-col" aria-label="Listed models">
                  <h4 className="conn-group-title">Listed ({countText(options.length, "model")})</h4>
                  {options.length > 8 && (
                    <label className="search-field">
                      <Search size={14} aria-hidden />
                      <input value={query} placeholder="Filter models" aria-label="Filter models" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
                    </label>
                  )}
                  <ul className="conn-shell conn-models-list">
                    {shown.map((option) => (
                      <li key={option.id} className="conn-shell-row">
                        <label className="conn-model-check">
                          <input type="checkbox" checked={chosen.includes(option.id)} disabled={busy} onChange={(event) => setChosen((current) => (event.target.checked ? chooseModel(current, option.id) : dropModel(current, option.id)))} />
                          <span className="conn-shell-name" title={option.id}>
                            {option.name ?? option.id}
                          </span>
                          {option.note !== undefined && <span className="conn-shell-var">{option.note}</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </>
      )}
      {error !== undefined && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="conn-actions">
        <Button variant="primary" loading={busy} disabled={!canSave || loading} onClick={() => void save()}>
          {saveLabel}
        </Button>
        {onSkip !== undefined && (
          <Button variant="ghost" disabled={busy} onClick={onSkip}>
            Keep every model
          </Button>
        )}
      </div>
    </div>
  )
}
