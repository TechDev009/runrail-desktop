import { ClipboardPaste } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import {
  addKeyConnection,
  addressProblem,
  keyProblem,
  removeConnection,
  storeKey,
  storeKeyFromClipboard,
  testConnection,
  type Connection,
  type ConnectionCheck,
} from "../../app/connections"
import { useApp } from "../../app/store"
import { toHostError } from "../../host"
import type { ConnectionPreset, CustomPreset } from "../../protocol/schemas"
import { Button } from "../common"
import { BackButton, Notice } from "./parts"
import { addressProblemText, checkText, formatName, isRefusal, keyProblemText, presetHost, saveProblemText, storeText } from "./text"

/**
 * One form for every way a key gets in: a known provider, a custom address, or a new key for a
 * connection that already exists.
 *
 * The key never becomes React or store state. It sits in the input's own DOM node, is read once
 * when the form is sent, and the node is cleared in the same step. From there it goes down the
 * host's write-only path, and nothing in this window can read it back.
 */

export type KeyTarget =
  | { readonly kind: "preset"; readonly preset: ConnectionPreset; readonly label: string }
  | { readonly kind: "custom"; readonly formats: readonly CustomPreset[]; readonly label?: string; readonly address?: string }
  | { readonly kind: "replace"; readonly connection: Connection }

type Busy = "typed" | "clipboard" | "test" | "remove"

/** `onModels` offers choosing the new connection's models once it works. */
export function KeyForm({ target, onDone, onBack, onModels }: { readonly target: KeyTarget; readonly onDone: () => void; readonly onBack?: () => void; readonly onModels?: ((connectionId: string) => void) | undefined }) {
  const credentialStore = useApp((state) => state.credentialStore)
  const clipboardSecrets = useApp((state) => state.clipboardSecrets)
  const ids = useId()
  const keyInput = useRef<HTMLInputElement | null>(null)
  const addressInput = useRef<HTMLInputElement | null>(null)
  const form = useRef<HTMLFormElement | null>(null)
  const [label, setLabel] = useState(target.kind === "preset" ? target.label : target.kind === "replace" ? target.connection.label : (target.label ?? ""))
  const [format, setFormat] = useState(target.kind === "custom" ? (target.formats[0]?.id ?? "") : "")
  const [address, setAddress] = useState(target.kind === "custom" ? (target.address ?? "") : "")
  // Only whether something was typed is kept, to enable the button. Never the text.
  const [filled, setFilled] = useState(false)
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [addressError, setAddressError] = useState<string | undefined>(undefined)
  /** The connection this form made. It is kept across a refused key, so a second try reuses it. */
  const [createdId, setCreatedId] = useState<string | undefined>(undefined)
  const [check, setCheck] = useState<ConnectionCheck | undefined>(undefined)

  // The controls are disabled while a key is stored or checked, which drops focus; the key field takes it back.
  useEffect(() => {
    const node = form.current
    if (busy !== undefined || node === null || node.contains(document.activeElement)) return
    keyInput.current?.focus()
  }, [busy])

  const existingId = target.kind === "replace" ? target.connection.id : createdId
  const locked = busy !== undefined || createdId !== undefined
  const name = target.kind === "preset" ? target.preset.name : target.kind === "replace" ? target.connection.label : label.trim() || "Custom endpoint"
  const host = target.kind === "preset" ? presetHost(target.preset) : undefined

  const runCheck = async (connectionId: string): Promise<void> => {
    setBusy("test")
    setCheck(await testConnection(connectionId))
    setBusy(undefined)
  }

  const save = async (source: "typed" | "clipboard"): Promise<void> => {
    if (busy !== undefined) return
    setError(undefined)
    setAddressError(undefined)
    if (target.kind === "custom" && createdId === undefined) {
      const problem = addressProblem(address)
      if (problem !== undefined) {
        setAddressError(addressProblemText(problem))
        addressInput.current?.focus()
        return
      }
      if (format.length === 0) {
        setError("This engine offers no format for a custom address.")
        return
      }
    }
    let secret = ""
    if (source === "typed") {
      const node = keyInput.current
      const typed = node?.value ?? ""
      const problem = keyProblem(typed)
      if (problem !== undefined) {
        setError(keyProblemText(problem))
        node?.focus()
        return
      }
      secret = typed.trim()
      if (node !== null) node.value = ""
      setFilled(false)
    }
    const store = (connectionId: string): Promise<Connection> => (source === "typed" ? storeKey(connectionId, secret) : storeKeyFromClipboard(connectionId))
    setBusy(source)
    setCheck(undefined)
    try {
      let connectionId = existingId
      if (connectionId === undefined) {
        const input = target.kind === "custom" ? { presetId: format, label, baseUrl: address } : { presetId: target.kind === "preset" ? target.preset.id : "", label }
        connectionId = (await addKeyConnection(input, store)).id
        setCreatedId(connectionId)
      } else {
        await store(connectionId)
      }
      secret = ""
      await runCheck(connectionId)
    } catch (caught) {
      secret = ""
      setError(saveProblemText(toHostError(caught).code))
      setBusy(undefined)
    }
  }

  const remove = async (): Promise<void> => {
    if (createdId === undefined || busy !== undefined) return
    setBusy("remove")
    try {
      await removeConnection(createdId)
      setCreatedId(undefined)
      setCheck(undefined)
      setError(undefined)
    } catch (caught) {
      setError(saveProblemText(toHostError(caught).code))
    }
    setBusy(undefined)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save("typed")
  }

  if (check !== undefined && check.status !== "failed") {
    const result = checkText(check)
    return (
      <div className="conn-step">
        <h3 className="conn-step-title">{name} is connected</h3>
        <Notice tone={result.tone}>{result.text}</Notice>
        {check.status === "ok" && <p className="form-hint">Its models are in the model menu of every thread.</p>}
        <div className="conn-actions">
          {onModels !== undefined && createdId !== undefined ? (
            <>
              <Button variant="primary" autoFocus onClick={() => onModels(createdId)}>
                Choose models
              </Button>
              <Button variant="ghost" onClick={onDone}>
                Keep every model
              </Button>
            </>
          ) : (
            <Button variant="primary" autoFocus onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      </div>
    )
  }

  const refused = check !== undefined && isRefusal(check.code)
  const title = target.kind === "replace" ? `New key for ${name}` : target.kind === "custom" ? "Connect a custom endpoint" : `Connect ${name}`

  return (
    <form ref={form} className="conn-step form" onSubmit={submit} noValidate>
      {onBack !== undefined && <BackButton onBack={onBack} disabled={busy !== undefined} />}
      <h3 className="conn-step-title">{title}</h3>

      {target.kind !== "replace" && (
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={label} maxLength={160} disabled={locked} autoFocus={target.kind === "custom"} placeholder={target.kind === "custom" ? "My local model" : name} onChange={(event) => setLabel(event.target.value)} />
        </label>
      )}

      {target.kind === "custom" && (
        <>
          <label className="field">
            <span className="field-label">Address</span>
            <input
              ref={addressInput}
              className="input mono"
              value={address}
              disabled={locked}
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="http://localhost:11434/v1"
              aria-invalid={addressError !== undefined}
              aria-describedby={addressError === undefined ? undefined : `${ids}-address`}
              onChange={(event) => {
                setAddress(event.target.value)
                setAddressError(undefined)
              }}
            />
            {addressError !== undefined && (
              <span id={`${ids}-address`} className="form-error" role="alert">
                {addressError}
              </span>
            )}
          </label>
          <label className="field">
            <span className="field-label">Format</span>
            <select className="select" value={format} disabled={locked} onChange={(event) => setFormat(event.target.value)}>
              {target.formats.map((item) => (
                <option key={item.id} value={item.id}>
                  {formatName(item.id, item.name)}
                </option>
              ))}
            </select>
            <span className="field-hint">Most local servers and proxies speak OpenAI Chat Completions.</span>
          </label>
        </>
      )}

      <div className="field">
        <label className="field-label" htmlFor={`${ids}-key`}>
          {target.kind === "replace" || createdId !== undefined ? "New API key" : "API key"}
        </label>
        <div className="conn-key-row">
          {/* Uncontrolled on purpose: the key lives only in this node until the form is sent. */}
          <input
            ref={keyInput}
            id={`${ids}-key`}
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-1p-ignore
            data-lpignore="true"
            autoFocus={target.kind !== "custom"}
            disabled={busy !== undefined}
            placeholder="Paste the key"
            aria-describedby={`${ids}-key-hint`}
            onInput={(event) => {
              setFilled(event.currentTarget.value.length > 0)
              setError(undefined)
            }}
          />
          {clipboardSecrets && (
            <Button icon={<ClipboardPaste size={14} />} loading={busy === "clipboard"} disabled={busy !== undefined} title="The app reads the clipboard itself, so the key never passes through this window" onClick={() => void save("clipboard")}>
              From clipboard
            </Button>
          )}
        </div>
        <span id={`${ids}-key-hint`} className="field-hint">
          {target.kind === "custom"
            ? "A server that needs no key still takes any value here."
            : target.kind === "replace"
              ? "It replaces the stored key. The old one cannot be shown or restored."
              : host === undefined
                ? "It is stored once and cannot be shown again."
                : `It is sent only to ${host}, and cannot be shown again once stored.`}
        </span>
      </div>

      {error !== undefined && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {check !== undefined && (
        <Notice tone={refused ? "fail" : "warn"} role="alert">
          {refused ? `The key was saved, but it does not work. ${checkText(check).text}` : `The key was saved, but it could not be checked. ${checkText(check).text}`}
        </Notice>
      )}

      <div className="conn-actions">
        <Button type="submit" variant="primary" loading={busy === "typed"} disabled={busy !== undefined || !filled}>
          {check !== undefined ? "Try another key" : target.kind === "replace" ? "Replace key" : "Connect"}
        </Button>
        {check !== undefined && existingId !== undefined && (
          <Button loading={busy === "test"} disabled={busy !== undefined} onClick={() => void runCheck(existingId)}>
            Test again
          </Button>
        )}
        {check !== undefined && !refused && (
          <Button variant="ghost" disabled={busy !== undefined} onClick={onDone}>
            Keep it
          </Button>
        )}
        {check !== undefined && createdId !== undefined && (
          <Button variant="ghost" loading={busy === "remove"} disabled={busy !== undefined} onClick={() => void remove()}>
            Remove connection
          </Button>
        )}
        {busy === "test" && <span className="conn-wait">Checking the key…</span>}
      </div>
      <p className="conn-foot">{storeText(credentialStore)}</p>
    </form>
  )
}
