import { getHost, toHostError } from "../host"
import { SignInEventSchema, SignInSnapshotSchema, parseList, parseOr, type SignInSnapshot } from "../protocol/schemas"
import { connectionsChanged, systemRpc } from "./connections"

/**
 * Subscription sign-in, as this window sees it. The engine runs the sign-in and the host opens
 * the page; the window only follows the steps. It never holds the page address, a code the vendor
 * returned, or a token: the one thing a person may paste here goes straight to the host.
 */

export type SignInPhase = "starting" | "browser" | "device" | "finishing" | "done" | "failed" | "cancelled"

export interface SignInView {
  readonly phase: SignInPhase
  readonly loginId?: string
  /** The connection the sign-in will land in. */
  readonly accountId?: string
  readonly lastSeq: number
  /** True when the browser cannot hand the result back by itself, so the person pastes it. */
  readonly manual: boolean
  /** True while the engine still takes a pasted address or code. */
  readonly acceptsInput: boolean
  /** Why the automatic route is off: `AUTH_PORT_BUSY` or `AUTH_LISTENER_FAILED`. */
  readonly notice?: string
  readonly device?: { readonly userCode: string; readonly host: string; readonly expiresAt: number }
  readonly expiresAt?: number
  /** Stable code of the failure. */
  readonly code?: string
}

export const SIGN_IN_START: SignInView = { phase: "starting", lastSeq: 0, manual: false, acceptsInput: false }

const FINISHED: ReadonlySet<SignInPhase> = new Set<SignInPhase>(["done", "failed", "cancelled"])
const POLL_WAIT_MS = 20_000
const MAX_POLL_FAILURES = 4

export function signInFinished(view: SignInView): boolean {
  return FINISHED.has(view.phase)
}

/** Host name of an address, for display only. Anything unreadable shows as nothing. */
function hostOf(address: string): string {
  try {
    const url = new URL(address)
    return url.protocol === "https:" ? url.host : ""
  } catch {
    return ""
  }
}

/** Applies one engine answer to the view. Steps already seen, and kinds it does not know, are skipped. */
export function foldSignIn(view: SignInView, snapshot: SignInSnapshot): SignInView {
  if (signInFinished(view)) return view
  let next: SignInView = { ...view, loginId: snapshot.loginId, accountId: snapshot.accountId, acceptsInput: snapshot.acceptsInput, expiresAt: snapshot.expiresAt }
  let seen = view.lastSeq
  for (const event of parseList(SignInEventSchema, snapshot.events, 1_000)) {
    if (event.seq <= view.lastSeq) continue
    seen = Math.max(seen, event.seq)
    if (event.type === "open-url") {
      const { notice: _previous, ...rest } = next
      next = { ...rest, phase: "browser", manual: event.redirect === "manual" || event.notice !== undefined, ...(event.notice === undefined ? {} : { notice: event.notice }) }
    } else if (event.type === "device-code") {
      next = { ...next, phase: "device", device: { userCode: event.userCode, host: hostOf(event.verificationUrl), expiresAt: event.expiresAt } }
    } else if (event.type === "finishing") next = { ...next, phase: "finishing" }
    else if (event.type === "done") next = { ...next, phase: "done", accountId: event.accountId }
    else if (event.type === "failed") next = { ...next, phase: "failed", code: event.code }
  }
  next = { ...next, lastSeq: Math.max(seen, view.lastSeq) }
  // The state is the engine's verdict; the steps only explain how it got there.
  if (snapshot.state === "done") return { ...next, phase: "done", acceptsInput: false }
  if (snapshot.state === "cancelled") return { ...next, phase: "cancelled", acceptsInput: false, code: "AUTH_CANCELLED" }
  if (snapshot.state === "failed") return { ...next, phase: "failed", acceptsInput: false, code: snapshot.code ?? next.code ?? "AUTH_FAILED" }
  if (snapshot.state === "finishing") return { ...next, phase: "finishing" }
  return next
}

function failed(view: SignInView, code: string): SignInView {
  return signInFinished(view) ? view : { ...view, phase: "failed", acceptsInput: false, code }
}

export interface SignInInput {
  readonly flow: string
  /** An existing connection to sign in again, or a new id for another account. */
  readonly accountId?: string
  readonly label?: string
}

export interface SignInRun {
  /** Opens the sign-in page again. The host takes the address from the engine. */
  open(): Promise<void>
  /** Hands over a pasted address or code. Returns the stable code of a refusal, if any. */
  submit(input: string): Promise<string | undefined>
  /** Ends the sign-in. Safe to call at any time, more than once. */
  cancel(): Promise<void>
}

/**
 * Starts a sign-in and follows it until it ends. `onChange` receives every new view. The page is
 * opened once as soon as the engine has one; a failure to open it is not a failure of the sign-in.
 */
export function runSignIn(input: SignInInput, onChange: (view: SignInView) => void): SignInRun {
  let view = SIGN_IN_START
  let stopped = false
  let opened = false

  const update = (next: SignInView): void => {
    if (next === view) return
    const finishedNow = !signInFinished(view) && next.phase === "done"
    view = next
    if (finishedNow) connectionsChanged()
    onChange(view)
  }

  const apply = (value: unknown): void => {
    const snapshot = parseOr(SignInSnapshotSchema, value)
    update(snapshot === undefined ? failed(view, "AUTH_RESPONSE_INVALID") : foldSignIn(view, snapshot))
  }

  const open = async (): Promise<void> => {
    if (view.loginId === undefined || signInFinished(view)) return
    await getHost().authOpen(view.loginId)
  }

  const follow = async (): Promise<void> => {
    let started: unknown
    try {
      started = await systemRpc("auth.login.start", { flow: input.flow, ...(input.accountId === undefined ? {} : { accountId: input.accountId }), ...(input.label === undefined ? {} : { label: input.label }) })
    } catch (error) {
      update(failed(view, toHostError(error).code))
      return
    }
    // Cancelled while the engine was still starting it: nobody is watching, so end it there too.
    if (stopped) {
      const loginId = parseOr(SignInSnapshotSchema, started)?.loginId
      if (loginId !== undefined) await systemRpc("auth.login.cancel", { loginId }).catch(() => undefined)
      return
    }
    apply(started)
    let failures = 0
    while (!stopped && !signInFinished(view) && view.loginId !== undefined) {
      if (!opened && (view.phase === "browser" || view.phase === "device")) {
        opened = true
        // The sheet keeps an "Open again" button, so a refused or failed open is recoverable.
        void open().catch(() => undefined)
      }
      try {
        apply(await systemRpc("auth.login.status", { loginId: view.loginId, afterSeq: view.lastSeq, waitMs: POLL_WAIT_MS }))
        failures = 0
      } catch (error) {
        const code = toHostError(error).code
        failures += 1
        if (code === "AUTH_LOGIN_NOT_FOUND" || failures >= MAX_POLL_FAILURES) {
          update(failed(view, code === "AUTH_LOGIN_NOT_FOUND" ? "AUTH_EXPIRED" : code))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * failures))
      }
    }
  }
  void follow()

  return {
    open,
    async submit(value) {
      if (view.loginId === undefined || signInFinished(view)) return "AUTH_LOGIN_FINISHED"
      try {
        apply(await getHost().authSubmitInput(view.loginId, value))
        return undefined
      } catch (error) {
        return toHostError(error).code
      }
    },
    async cancel() {
      if (stopped) return
      stopped = true
      const loginId = view.loginId
      if (signInFinished(view)) return
      if (loginId === undefined) {
        onChange((view = { ...view, phase: "cancelled", code: "AUTH_CANCELLED" }))
        return
      }
      update({ ...view, phase: "cancelled", acceptsInput: false, code: "AUTH_CANCELLED" })
      await systemRpc("auth.login.cancel", { loginId }).catch(() => undefined)
    },
  }
}
