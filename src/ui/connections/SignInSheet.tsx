import { ExternalLink } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { useCatalog } from "../../app/catalog"
import { runSignIn, signInFinished, SIGN_IN_START, type SignInRun, type SignInView } from "../../app/signIn"
import { toHostError } from "../../host"
import type { SignInFlow } from "../../protocol/schemas"
import { Button, CopyButton, Spinner, useTicker } from "../common"
import { BackButton, Notice } from "./parts"
import { countText, manualReason, signInProblem, unofficialNotice } from "./text"

/**
 * One subscription sign-in, from the button to the result. The engine runs it and the host opens
 * the page; this sheet shows where it stands. It starts only from a click, and leaving the sheet
 * ends it, so no sign-in keeps waiting behind a closed dialog.
 */

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function SignInSheet({
  flow,
  accountId,
  label,
  again = false,
  onDone,
  onBack,
  onModels,
}: {
  readonly flow: SignInFlow
  /** An existing connection to sign in again, or a new id for another account. */
  readonly accountId?: string
  readonly label?: string
  /** True when `accountId` is an account that is being signed in to again. */
  readonly again?: boolean
  readonly onDone: () => void
  readonly onBack?: () => void
  /** Offers choosing a new account's models once it is signed in. */
  readonly onModels?: ((connectionId: string) => void) | undefined
}) {
  const ids = useId()
  const catalog = useCatalog(undefined)
  const [view, setView] = useState<SignInView | undefined>(undefined)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | undefined>(undefined)
  const [byHand, setByHand] = useState(false)
  const [pasted, setPasted] = useState(false)
  const [sending, setSending] = useState(false)
  const [inputError, setInputError] = useState<string | undefined>(undefined)
  const run = useRef<SignInRun | undefined>(undefined)
  const attempt = useRef(0)
  const paste = useRef<HTMLInputElement | null>(null)
  const step = useRef<HTMLDivElement | null>(null)
  const now = useTicker(view?.phase === "device", 15_000)
  const phase = view?.phase

  // The button that started the sign-in is gone once it runs; the first control of the waiting step takes its focus.
  useEffect(() => {
    const node = step.current
    if ((phase !== "browser" && phase !== "device") || node === null || node.contains(document.activeElement)) return
    node.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus()
  }, [phase])

  // The field is disabled while an answer is checked; focus returns once it can be typed in again.
  useEffect(() => {
    if (inputError !== undefined) paste.current?.focus()
  }, [inputError])

  useEffect(
    () => () => {
      attempt.current += 1
      void run.current?.cancel()
    },
    [],
  )

  const start = (): void => {
    const mine = (attempt.current += 1)
    setOpenError(undefined)
    setInputError(undefined)
    setByHand(false)
    setPasted(false)
    setView(SIGN_IN_START)
    run.current = runSignIn({ flow: flow.id, ...(accountId === undefined ? {} : { accountId }), ...(label === undefined ? {} : { label }) }, (next) => {
      if (attempt.current === mine) setView(next)
    })
  }

  const open = async (): Promise<void> => {
    setOpenError(undefined)
    setOpening(true)
    try {
      await run.current?.open()
    } catch (caught) {
      const code = toHostError(caught).code
      const problem = signInProblem(code)
      setOpenError(code === "AUTH_URL_REFUSED" ? `${problem.title}. ${problem.next} (${code})` : `The page could not be opened. (${code})`)
    }
    setOpening(false)
  }

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const node = paste.current
    // Read once and cleared: what is pasted here goes to the host and nowhere else.
    const value = node?.value.trim() ?? ""
    if (value.length === 0 || sending) return
    if (node !== null) node.value = ""
    setPasted(false)
    setInputError(undefined)
    setSending(true)
    const refused = await run.current?.submit(value)
    setSending(false)
    if (refused !== undefined && refused !== "AUTH_LOGIN_FINISHED") {
      const problem = signInProblem(refused)
      setInputError(`${problem.title}. ${problem.next} (${refused})`)
    }
  }

  const cancel = (): void => void run.current?.cancel()
  const title = again && label !== undefined ? `Sign in again: ${label}` : `Sign in to ${flow.label}`

  if (view === undefined) {
    return (
      <div className="conn-step">
        {onBack !== undefined && <BackButton onBack={onBack} />}
        <h3 className="conn-step-title">{title}</h3>
        <p className="dialog-text">
          {flow.kind === "browser"
            ? `Your browser opens the ${flow.label} sign-in page. Sign in there and this window picks it up by itself.`
            : `You get a short code to enter on the ${flow.label} page in your browser.`}{" "}
          Runrail never sees your password.
        </p>
        {flow.unofficial && (
          <div className="callout conn-callout" role="note">
            <strong>Unofficial.</strong> {unofficialNotice(flow)}
          </div>
        )}
        <div className="conn-actions">
          <Button variant="primary" autoFocus onClick={start}>
            Continue with {flow.label}
          </Button>
        </div>
      </div>
    )
  }

  if (view.phase === "done") {
    const models = catalog.models.filter((model) => model.connectionId === view.accountId).length
    const failure = view.accountId === undefined ? undefined : catalog.modelErrors[view.accountId]
    return (
      <div className="conn-step">
        <h3 className="conn-step-title">Signed in to {flow.label}</h3>
        <Notice tone="ok">
          {catalog.loading ? "Signed in. Loading its models…" : failure !== undefined ? "Signed in. Its model list could not be loaded yet; it is tried again when you open the model menu." : `Signed in. ${countText(models, "model")} in the model menu.`}
        </Notice>
        <div className="conn-actions">
          {onModels !== undefined && !again && view.accountId !== undefined ? (
            <>
              <Button variant="primary" autoFocus onClick={() => onModels(view.accountId!)}>
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

  if (signInFinished(view)) {
    const problem = signInProblem(view.code)
    return (
      <div className="conn-step">
        {onBack !== undefined && <BackButton onBack={onBack} />}
        <h3 className="conn-step-title">{problem.title}</h3>
        <Notice tone={view.phase === "cancelled" ? "off" : "fail"} role="alert">
          {problem.next}
          {view.code !== undefined && view.phase !== "cancelled" && <span className="conn-codeword"> ({view.code})</span>}
        </Notice>
        <div className="conn-actions">
          {problem.retry && (
            <Button variant="primary" autoFocus onClick={start}>
              Try again
            </Button>
          )}
          <Button variant={problem.retry ? "ghost" : "primary"} autoFocus={!problem.retry} onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    )
  }

  const manual = view.phase === "browser" && view.acceptsInput && (view.manual || byHand)

  return (
    <div ref={step} className="conn-step">
      <h3 className="conn-step-title">{title}</h3>

      {view.phase === "starting" && (
        <div className="conn-wait-row" role="status">
          <Spinner /> Starting the sign-in…
        </div>
      )}

      {view.phase === "finishing" && (
        <div className="conn-wait-row" role="status">
          <Spinner /> Finishing the sign-in…
        </div>
      )}

      {view.phase === "device" && view.device !== undefined && (
        <>
          <p className="dialog-text">
            Enter this code on the {view.device.host.length > 0 ? <span className="mono">{view.device.host}</span> : flow.label} page that opened in your browser.
          </p>
          <div className="conn-device">
            <output className="conn-device-code" aria-label="Sign-in code">
              {view.device.userCode}
            </output>
            <CopyButton text={view.device.userCode} label="Copy code" />
          </div>
          <div className="conn-wait-row" role="status">
            <Spinner /> Waiting for the code to be entered…
            <span className="conn-wait-note">{view.device.expiresAt > now ? `The code lasts about ${countText(Math.max(1, Math.ceil((view.device.expiresAt - now) / 60_000)), "more minute")}.` : "The code has run out."}</span>
          </div>
        </>
      )}

      {view.phase === "browser" && !manual && (
        <>
          <p className="dialog-text">Finish signing in on the page that opened in your browser. This window continues by itself.</p>
          <div className="conn-wait-row" role="status">
            <Spinner /> Waiting for the browser…
            {view.expiresAt !== undefined && <span className="conn-wait-note">Waits until {clock(view.expiresAt)}.</span>}
          </div>
        </>
      )}

      {manual && (
        <form className="form" onSubmit={(event) => void send(event)}>
          <p className="dialog-text">{manualReason(view.notice)}</p>
          <ol className="conn-steps">
            <li>Sign in on the page that opened in your browser.</li>
            <li>When it lands on a page that does not load, copy the whole address from the address bar.</li>
            <li>Paste it here.</li>
          </ol>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-paste`}>
              Address from the browser
            </label>
            <div className="conn-key-row">
              <input
                ref={paste}
                id={`${ids}-paste`}
                className="input mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-1p-ignore
                data-lpignore="true"
                autoFocus
                disabled={sending}
                placeholder="http://localhost:…/callback?code=…"
                aria-invalid={inputError !== undefined}
                onInput={(event) => {
                  setPasted(event.currentTarget.value.trim().length > 0)
                  setInputError(undefined)
                }}
              />
              <Button type="submit" variant="primary" loading={sending} disabled={!pasted}>
                Finish
              </Button>
            </div>
          </div>
          {inputError !== undefined && (
            <p className="form-error" role="alert">
              {inputError}
            </p>
          )}
        </form>
      )}

      {openError !== undefined && (
        <p className="form-error" role="alert">
          {openError}
        </p>
      )}

      <div className="conn-actions">
        {(view.phase === "browser" || view.phase === "device") && (
          <Button icon={<ExternalLink size={14} />} loading={opening} onClick={() => void open()}>
            Open the page again
          </Button>
        )}
        {view.phase === "browser" && view.acceptsInput && !view.manual && (
          <Button variant="ghost" onClick={() => setByHand((value) => !value)}>
            {byHand ? "Wait for the browser instead" : "The browser did not come back?"}
          </Button>
        )}
        <Button variant="ghost" disabled={view.phase === "finishing"} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
