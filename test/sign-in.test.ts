import { beforeEach, describe, expect, test } from "bun:test"
import { listConnections, nextSignInAccount, onConnectionsChanged, renameConnection, systemRpc } from "../src/app/connections"
import { foldSignIn, runSignIn, signInFinished, SIGN_IN_START, type SignInInput, type SignInRun, type SignInView } from "../src/app/signIn"
import { setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { PreviewScenario } from "../src/host/fakeConnections"
import type { SignInSnapshot } from "../src/protocol/schemas"

const LOGIN = "login-00000000-0000-4000-8000-000000000000"
const LANDED = "http://localhost:1455/auth/callback?code=abc&state=xyz"
const STOPPED: readonly (string | undefined)[] = ["CONTROL_START_FAILED", "ENGINE_NOT_RUNNING"]
let host: Host

function use(scenario: PreviewScenario = {}): void {
  host = createFakeHost({ signInDelayMs: 5, ...scenario })
  setHost(host)
}

beforeEach(() => use())

function snapshot(state: SignInSnapshot["state"], events: unknown[], extra: Partial<SignInSnapshot> = {}): SignInSnapshot {
  return { loginId: LOGIN, flow: "chatgpt", accountId: "signin-chatgpt", state, acceptsInput: state === "waiting", events, lastSeq: events.length, expiresAt: 1_900_000_000_000, ...extra }
}

describe("following a sign-in's steps", () => {
  test("a browser sign-in waits for the browser and never keeps the page address", () => {
    const view = foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, at: 1, type: "open-url", url: "https://auth.openai.com/oauth/authorize?state=SECRETSTATE", redirect: "loopback" }, { seq: 2, at: 2, type: "waiting" }]))
    expect(view).toEqual({ phase: "browser", loginId: LOGIN, accountId: "signin-chatgpt", lastSeq: 2, manual: false, acceptsInput: true, expiresAt: 1_900_000_000_000 })
    expect(JSON.stringify(view)).not.toContain("auth.openai.com")
    expect(JSON.stringify(view)).not.toContain("SECRETSTATE")
  })

  test("a busy callback port turns on pasting by hand, and a later automatic page turns it off", () => {
    const busy = foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, type: "open-url", redirect: "manual", notice: "AUTH_PORT_BUSY" }]))
    expect(busy).toMatchObject({ phase: "browser", manual: true, notice: "AUTH_PORT_BUSY", acceptsInput: true })
    const again = foldSignIn(busy, snapshot("waiting", [{ seq: 2, type: "open-url", redirect: "loopback" }]))
    expect(again.manual).toBe(false)
    expect("notice" in again).toBe(false)
    // A notice always offers the paste box, whatever the step says about the redirect.
    expect(foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, type: "open-url", redirect: "loopback", notice: "AUTH_LISTENER_FAILED" }]))).toMatchObject({ manual: true, notice: "AUTH_LISTENER_FAILED" })
    expect(foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, type: "open-url", redirect: "manual" }])).manual).toBe(true)
  })

  test("a device code shows its host only for a secure page", () => {
    const device = (verificationUrl: string): SignInView => foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, type: "device-code", userCode: "WDJB-MJHT", verificationUrl, expiresAt: 42 }], { acceptsInput: false }))
    expect(device("https://auth.x.ai/device?user_code=WDJB-MJHT")).toMatchObject({ phase: "device", acceptsInput: false, device: { userCode: "WDJB-MJHT", host: "auth.x.ai", expiresAt: 42 } })
    expect(device("http://auth.x.ai/device").device?.host).toBe("")
    expect(device("not an address").device?.host).toBe("")
  })

  test("steps it does not know, and steps already seen, are skipped", () => {
    const first = foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, type: "open-url", redirect: "loopback" }, { seq: 2, type: "telemetry", payload: "x" }]))
    expect(first).toMatchObject({ phase: "browser", lastSeq: 1 })
    const replay = foldSignIn(first, snapshot("waiting", [{ seq: 1, type: "device-code", userCode: "OLD", verificationUrl: "https://auth.x.ai", expiresAt: 1 }, { seq: 3, type: "waiting" }]))
    expect(replay).toMatchObject({ phase: "browser", lastSeq: 3 })
    expect(replay.device).toBeUndefined()
  })

  test("the engine's state decides how it ended", () => {
    const waiting = foldSignIn(SIGN_IN_START, snapshot("waiting", [{ seq: 1, type: "open-url", redirect: "loopback" }]))
    expect(foldSignIn(waiting, snapshot("finishing", [{ seq: 2, type: "finishing" }]))).toMatchObject({ phase: "finishing" })
    expect(foldSignIn(waiting, snapshot("finishing", []))).toMatchObject({ phase: "finishing" })
    expect(foldSignIn(waiting, snapshot("done", [{ seq: 2, type: "done", accountId: "signin-chatgpt-2" }]))).toMatchObject({ phase: "done", accountId: "signin-chatgpt-2", acceptsInput: false })
    expect(foldSignIn(waiting, snapshot("done", []))).toMatchObject({ phase: "done", accountId: "signin-chatgpt", acceptsInput: false })
    expect(foldSignIn(waiting, snapshot("cancelled", [{ seq: 2, type: "failed", code: "AUTH_CANCELLED" }]))).toMatchObject({ phase: "cancelled", code: "AUTH_CANCELLED", acceptsInput: false })
    expect(foldSignIn(waiting, snapshot("failed", [], { code: "AUTH_DENIED" }))).toMatchObject({ phase: "failed", code: "AUTH_DENIED" })
    expect(foldSignIn(waiting, snapshot("failed", [{ seq: 2, type: "failed", code: "AUTH_TIMEOUT" }]))).toMatchObject({ phase: "failed", code: "AUTH_TIMEOUT" })
    expect(foldSignIn(waiting, snapshot("failed", []))).toMatchObject({ phase: "failed", code: "AUTH_FAILED" })
  })

  test("a finished sign-in does not change again", () => {
    const done = foldSignIn(SIGN_IN_START, snapshot("done", [{ seq: 1, type: "done", accountId: "signin-chatgpt" }]))
    expect(signInFinished(done)).toBe(true)
    expect(foldSignIn(done, snapshot("failed", [{ seq: 2, type: "failed", code: "AUTH_DENIED" }]))).toBe(done)
    expect(signInFinished(SIGN_IN_START)).toBe(false)
    expect(signInFinished({ ...SIGN_IN_START, phase: "browser" })).toBe(false)
    expect(signInFinished({ ...SIGN_IN_START, phase: "cancelled" })).toBe(true)
  })
})

interface Followed {
  readonly views: SignInView[]
  readonly run: SignInRun
  /** The view the sign-in ended on. */
  readonly ended: Promise<SignInView>
  last(): SignInView | undefined
}

function follow(input: SignInInput): Followed {
  const views: SignInView[] = []
  let finish: (view: SignInView) => void = () => undefined
  const ended = new Promise<SignInView>((resolve) => {
    finish = resolve
  })
  const run = runSignIn(input, (view) => {
    views.push(view)
    if (signInFinished(view)) finish(view)
  })
  return { views, run, ended, last: () => views[views.length - 1] }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function account(id: string) {
  return (await listConnections()).find((connection) => connection.id === id)
}

function counter(): { readonly count: () => number; readonly stop: () => void } {
  let changes = 0
  const stop = onConnectionsChanged(() => {
    changes += 1
  })
  return { count: () => changes, stop }
}

describe("running a sign-in", () => {
  test("a browser sign-in ends in a ready connection and announces it once", async () => {
    const changes = counter()
    const { views, ended } = follow({ flow: "chatgpt" })
    expect(await ended).toMatchObject({ phase: "done", accountId: "signin-chatgpt", acceptsInput: false })
    expect(views.some((view) => view.phase === "browser" && !view.manual && view.acceptsInput)).toBe(true)
    expect(await account("signin-chatgpt")).toEqual({ id: "signin-chatgpt", label: "ChatGPT", presetId: "openai", authMode: "oauth", status: "ready" })
    expect(changes.count()).toBe(1)
    changes.stop()
  })

  test("a device code is shown, takes no pasted answer, and ends in a device connection", async () => {
    use({ signIn: "never" })
    const waiting = follow({ flow: "xai" })
    await until(() => waiting.last()?.phase === "device", "the code")
    expect(waiting.last()).toMatchObject({ acceptsInput: false, device: { userCode: "WDJB-MJHT", host: "accounts.x.ai" } })
    expect(await waiting.run.submit(LANDED)).toBe("AUTH_INVALID")
    expect(waiting.last()?.phase).toBe("device")
    await waiting.run.cancel()

    use()
    expect(await follow({ flow: "xai" }).ended).toMatchObject({ phase: "done", accountId: "signin-xai" })
    expect(await account("signin-xai")).toMatchObject({ authMode: "device", presetId: "xai-grok", status: "ready" })
  })

  test("with the callback port taken, a pasted address finishes it and a wrong one keeps it waiting", async () => {
    use({ signIn: "port-busy" })
    const { run, ended, last } = follow({ flow: "chatgpt" })
    await until(() => last()?.phase === "browser", "the browser step")
    expect(last()).toMatchObject({ manual: true, notice: "AUTH_PORT_BUSY", acceptsInput: true })
    expect(await run.submit("just some text")).toBe("AUTH_INPUT_INVALID")
    expect(last()?.phase).toBe("browser")
    expect(await account("signin-chatgpt")).toBeUndefined()
    expect(await run.submit(LANDED)).toBeUndefined()
    expect(await ended).toMatchObject({ phase: "done", accountId: "signin-chatgpt" })
    expect(await run.submit(LANDED)).toBe("AUTH_LOGIN_FINISHED")
    expect((await account("signin-chatgpt"))?.status).toBe("ready")
    // Nothing the person pasted is kept in what the window holds.
    expect(JSON.stringify(last())).not.toContain("abc")
  })

  test("access declined on the provider's page fails with its code and stores nothing", async () => {
    use({ signIn: "denied" })
    const changes = counter()
    expect(await follow({ flow: "chatgpt" }).ended).toMatchObject({ phase: "failed", code: "AUTH_DENIED", acceptsInput: false })
    expect(await account("signin-chatgpt")).toBeUndefined()
    expect(changes.count()).toBe(0)
    changes.stop()
  })

  test("cancel ends it in the engine too, and is safe to repeat", async () => {
    use({ signIn: "never" })
    const { run, ended, last } = follow({ flow: "chatgpt" })
    await until(() => last()?.phase === "browser", "the browser step")
    const loginId = last()?.loginId
    await run.cancel()
    expect(await ended).toMatchObject({ phase: "cancelled", code: "AUTH_CANCELLED", acceptsInput: false })
    expect(await systemRpc("auth.login.status", { loginId })).toMatchObject({ state: "cancelled", acceptsInput: false })
    await run.cancel()
    await run.open()
    expect(await run.submit(LANDED)).toBe("AUTH_LOGIN_FINISHED")
    expect(await account("signin-chatgpt")).toBeUndefined()
  })

  test("cancel while the engine is still starting it ends the sign-in it started", async () => {
    const base = createFakeHost({ signIn: "never" })
    const calls: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: { loginId?: string } | undefined
    setHost({
      ...base,
      rpc: async (engineId, method, params) => {
        calls.push(method)
        const result = await base.rpc(engineId, method, params)
        if (method === "auth.login.start") {
          started = result as { loginId?: string }
          await gate
        }
        return result
      },
    })
    const { run, last } = follow({ flow: "chatgpt" })
    await until(() => started !== undefined, "the start request")
    await run.cancel()
    expect(last()).toMatchObject({ phase: "cancelled", code: "AUTH_CANCELLED" })
    expect(last()?.loginId).toBeUndefined()
    release()
    await until(() => calls.includes("auth.login.cancel"), "the cancel request")
    expect(calls.includes("auth.login.status")).toBe(false)
    expect(await base.rpc("system", "auth.login.status", { loginId: started?.loginId })).toMatchObject({ state: "cancelled" })
    expect(last()?.phase).toBe("cancelled")
  })

  test("a sign-in the engine does not offer, or a connection it does not fit, fails before any page opens", async () => {
    let opened = 0
    const base = createFakeHost()
    setHost({
      ...base,
      authOpen: async (loginId) => {
        opened += 1
        return base.authOpen(loginId)
      },
    })
    expect(await follow({ flow: "nope" }).ended).toMatchObject({ phase: "failed", code: "AUTH_FLOW_UNKNOWN" })
    // An API-key connection cannot hold a subscription sign-in.
    expect(await follow({ flow: "chatgpt", accountId: "anthropic" }).ended).toMatchObject({ phase: "failed", code: "AUTH_ACCOUNT_MISMATCH" })
    expect(opened).toBe(0)
    expect((await listConnections()).map((connection) => connection.id)).toEqual(["anthropic", "openai"])
  })

  test("signing in again keeps the connection's name, and another account gets its own", async () => {
    use({ seed: "mixed" })
    await renameConnection("signin-chatgpt", "Work ChatGPT")
    expect(await follow({ flow: "chatgpt", accountId: "signin-chatgpt", label: "Ignored" }).ended).toMatchObject({ phase: "done", accountId: "signin-chatgpt" })
    expect(await account("signin-chatgpt")).toEqual({ id: "signin-chatgpt", label: "Work ChatGPT", presetId: "openai", authMode: "oauth", status: "ready" })
    const next = await nextSignInAccount({ id: "chatgpt", label: "ChatGPT" })
    expect(await follow({ flow: "chatgpt", ...next }).ended).toMatchObject({ phase: "done", accountId: "signin-chatgpt-2" })
    expect(await account("signin-chatgpt-2")).toMatchObject({ label: "ChatGPT 2", status: "ready" })
    expect((await account("signin-chatgpt"))?.label).toBe("Work ChatGPT")
  })

  test("an answer that cannot be read fails the sign-in instead of guessing", async () => {
    const base = createFakeHost()
    setHost({ ...base, rpc: async (engineId, method, params) => (method === "auth.login.start" ? { loginId: "login-short", state: "waiting" } : base.rpc(engineId, method, params)) })
    expect(await follow({ flow: "chatgpt" }).ended).toMatchObject({ phase: "failed", code: "AUTH_RESPONSE_INVALID" })
  })

  test("an engine that is not running fails with its code", async () => {
    use({ offline: true })
    const ended = await follow({ flow: "chatgpt" }).ended
    expect(ended.phase).toBe("failed")
    expect(STOPPED).toContain(ended.code)
  })

  test("a page that cannot be opened does not fail the sign-in", async () => {
    const base = createFakeHost({ signIn: "never" })
    setHost({
      ...base,
      authOpen: async () => {
        throw Object.assign(new Error("refused"), { code: "AUTH_URL_REFUSED" })
      },
    })
    const { run, last } = follow({ flow: "chatgpt" })
    await until(() => last()?.phase === "browser", "the browser step")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(last()?.phase).toBe("browser")
    // The button that opens it again reports the refusal to its caller.
    const refused = await run.open().then(
      () => undefined,
      (error: { code?: string }) => error.code,
    )
    expect(refused).toBe("AUTH_URL_REFUSED")
    await run.cancel()
  })
})
