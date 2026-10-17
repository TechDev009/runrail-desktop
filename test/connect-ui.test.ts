import { describe, expect, test } from "bun:test"
import { connectionPresets, detectShellConnections, listConnections, signInFlows, type Connection } from "../src/app/connections"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { PreviewScenario } from "../src/host/fakeConnections"
import type { SignInFlow } from "../src/protocol/schemas"
import { buildTiles, initialStep, type ConnectData, type Tile } from "../src/ui/connections/steps"
import {
  accountsOf,
  addressProblemText,
  checkText,
  connectionFix,
  connectionRoute,
  connectionStatus,
  countText,
  flowDetail,
  flowFor,
  formatName,
  isRefusal,
  keyProblemText,
  manualReason,
  matches,
  orderPresets,
  presetHost,
  presetKeywords,
  problemText,
  saveProblemText,
  signInProblem,
  signOutTargets,
  storeText,
  suggestLabel,
  toolRoutes,
  unofficialNotice,
} from "../src/ui/connections/text"

function conn(id: string, extra: Partial<Connection> = {}): Connection {
  return { id, label: id, presetId: id, authMode: "api-key", status: "ready", ...extra }
}

const CHATGPT: SignInFlow = { id: "chatgpt", label: "ChatGPT", preset: "openai", kind: "browser", authMode: "oauth", unofficial: false, browserHosts: ["auth.openai.com"] }
const OPENROUTER: SignInFlow = { id: "openrouter", label: "OpenRouter", preset: "openrouter", kind: "browser", authMode: "oauth", unofficial: false, browserHosts: ["openrouter.ai"] }
const XAI: SignInFlow = { id: "xai", label: "xAI (Grok plan)", preset: "xai-grok", kind: "device-code", authMode: "device", unofficial: true, browserHosts: ["accounts.x.ai"] }
const FLOWS = [CHATGPT, OPENROUTER, XAI]

/** The five words the list may show for a connection. */
const LABELS = ["Ready", "Signing in", "Expired", "Failed", "Off"]

describe("what a connection's state is called", () => {
  test("every state has one of five labels, a tone, and a next step when it needs one", () => {
    expect(connectionStatus(conn("a"))).toEqual({ tone: "ok", label: "Ready" })
    expect(connectionStatus(conn("a", { status: "refreshing", authMode: "oauth" }))).toEqual({ tone: "busy", label: "Signing in", hint: "Renewing the sign-in." })
    expect(connectionStatus(conn("a", { status: "expired", authMode: "oauth" }))).toMatchObject({ tone: "warn", label: "Expired" })
    expect(connectionStatus(conn("a", { status: "error", statusCode: "AUTH_FAILED" }))).toEqual({ tone: "fail", label: "Failed", hint: "The provider refused the key. (AUTH_FAILED)" })
    expect(connectionStatus(conn("a", { status: "error" }))).toEqual({ tone: "fail", label: "Failed", hint: "It cannot be used right now." })
    expect(connectionStatus(conn("a", { status: "unconfigured" }))).toEqual({ tone: "off", label: "Off", hint: "No key is stored. Add one to use it." })
    expect(connectionStatus(conn("a", { status: "unconfigured", authMode: "device" }))).toEqual({ tone: "off", label: "Off", hint: "Signed out. Sign in to use it." })
    expect(connectionStatus(conn("a", { status: "unconfigured", authMode: "environment", environmentName: "GROQ_API_KEY" })).hint).toContain("Set GROQ_API_KEY")
    expect(connectionStatus(conn("a", { status: "unconfigured", authMode: "external" }))).toEqual({ tone: "off", label: "Off", hint: "It is not set up yet." })
    const statuses: Connection["status"][] = ["unconfigured", "ready", "expired", "refreshing", "error", "revoked"]
    for (const status of statuses) for (const authMode of ["api-key", "oauth", "device", "environment"]) expect(LABELS).toContain(connectionStatus(conn("a", { status, authMode })).label)
  })

  test("a model list that the provider refused fails the connection; a hiccup does not", () => {
    expect(connectionStatus(conn("a"), "AUTH_FAILED")).toEqual({ tone: "fail", label: "Failed", hint: "The provider refused the key. (AUTH_FAILED)" })
    const slow = connectionStatus(conn("a"), "TIMEOUT")
    expect(slow).toMatchObject({ tone: "ok", label: "Ready" })
    expect(slow.hint).toBe("Its model list could not be loaded. The provider did not answer in time. (TIMEOUT)")
    expect(connectionStatus(conn("a"), "SOMETHING_NEW").hint).toBe("Its model list could not be loaded. Try again in a moment. (SOMETHING_NEW)")
    expect(["AUTH_FAILED", "SIGN_IN_EXPIRED", "SIGN_IN_FAILED", "CREDENTIAL_MISSING", "ENDPOINT_DENIED"].map(isRefusal)).toEqual([true, true, true, true, true])
    expect(["TIMEOUT", "RATE_LIMITED", "INVALID_RESPONSE", "OK"].map(isRefusal)).toEqual([false, false, false, false])
  })

  test("says how a connection reaches its models", () => {
    expect(connectionRoute(conn("a"))).toBe("API key")
    expect(connectionRoute(conn("a", { baseUrl: "http://127.0.0.1:8080/v1" }))).toBe("API key · 127.0.0.1:8080")
    expect(connectionRoute(conn("a", { baseUrl: "nonsense" }))).toBe("API key · custom address")
    expect(connectionRoute(conn("a", { authMode: "oauth" }))).toBe("Subscription sign-in")
    expect(connectionRoute(conn("a", { authMode: "device" }))).toBe("Subscription sign-in")
    expect(connectionRoute(conn("a", { authMode: "environment", environmentName: "OPENAI_API_KEY" }))).toBe("Shell variable OPENAI_API_KEY")
    expect(connectionRoute(conn("a", { authMode: "external" }))).toBe("Set up outside the app")
  })

  test("offers the one repair a connection has, and none for a shell variable", () => {
    expect(connectionFix(conn("a"))).toEqual({ kind: "key", label: "Replace key", needed: false })
    expect(connectionFix(conn("a"), "AUTH_FAILED")).toEqual({ kind: "key", label: "Replace key", needed: true })
    expect(connectionFix(conn("a"), "TIMEOUT")).toEqual({ kind: "key", label: "Replace key", needed: false })
    expect(connectionFix(conn("a", { status: "unconfigured" }))).toEqual({ kind: "key", label: "Add key", needed: true })
    expect(connectionFix(conn("a", { status: "error", statusCode: "AUTH_FAILED" }))).toEqual({ kind: "key", label: "Replace key", needed: true })
    expect(connectionFix(conn("a", { authMode: "oauth", status: "expired" }))).toEqual({ kind: "sign-in", label: "Sign in again", needed: true })
    expect(connectionFix(conn("a", { authMode: "oauth", status: "unconfigured" }))).toEqual({ kind: "sign-in", label: "Sign in", needed: true })
    expect(connectionFix(conn("a", { authMode: "device", status: "refreshing" }))).toEqual({ kind: "sign-in", label: "Sign in again", needed: false })
    expect(connectionFix(conn("a", { authMode: "environment", environmentName: "X", status: "unconfigured" }))).toBeUndefined()
  })

  test("finds the sign-in a connection came from", () => {
    expect(flowFor(conn("signin-chatgpt", { presetId: "openai", authMode: "oauth" }), FLOWS)?.id).toBe("chatgpt")
    expect(flowFor(conn("signin-chatgpt-2", { presetId: "openai", authMode: "oauth" }), FLOWS)?.id).toBe("chatgpt")
    // Named by hand: the provider and the way in decide.
    expect(flowFor(conn("work", { presetId: "openrouter", authMode: "oauth" }), FLOWS)?.id).toBe("openrouter")
    expect(flowFor(conn("grok", { presetId: "xai-grok", authMode: "device" }), FLOWS)?.id).toBe("xai")
    expect(flowFor(conn("grok", { presetId: "xai-grok", authMode: "oauth" }), FLOWS)).toBeUndefined()
    // A pasted xAI key is its own row and leads to no sign-in.
    expect(flowFor(conn("grok-key", { presetId: "xai", authMode: "api-key" }), FLOWS)).toBeUndefined()
    expect(flowFor(conn("openai", { authMode: "api-key" }), FLOWS)).toBeUndefined()
    expect(flowFor(conn("signin-chatgpt", { presetId: "openai", authMode: "oauth" }), [])).toBeUndefined()
    const connections = [conn("openai"), conn("signin-chatgpt", { presetId: "openai", authMode: "oauth" }), conn("signin-chatgpt-2", { presetId: "openai", authMode: "oauth", status: "unconfigured" }), conn("signin-openrouter", { presetId: "openrouter", authMode: "oauth" })]
    expect(accountsOf(CHATGPT, connections, FLOWS).map((connection) => connection.id)).toEqual(["signin-chatgpt", "signin-chatgpt-2"])
    expect(accountsOf(XAI, connections, FLOWS)).toEqual([])
  })

  test("lists only sign-ins that hold something to sign out of", () => {
    const connections = [conn("anthropic"), conn("openai", { authMode: "environment", environmentName: "OPENAI_API_KEY" }), conn("signin-chatgpt", { authMode: "oauth", status: "expired" }), conn("signin-openrouter", { authMode: "oauth", status: "refreshing" }), conn("signin-xai", { authMode: "device", status: "unconfigured" })]
    expect(signOutTargets(connections).map((connection) => connection.id)).toEqual(["signin-chatgpt", "signin-openrouter"])
    expect(signOutTargets([conn("anthropic")])).toEqual([])
  })
})

describe("words for results and problems", () => {
  test("a check reads as one line", () => {
    expect(checkText({ status: "ok", code: "OK", modelCount: 1 })).toEqual({ tone: "ok", text: "It works. 1 model." })
    expect(checkText({ status: "ok", code: "OK", modelCount: 12 })).toEqual({ tone: "ok", text: "It works. 12 models." })
    expect(checkText({ status: "ok", code: "OK" })).toEqual({ tone: "ok", text: "It works." })
    expect(checkText({ status: "unverified", code: "NO_MODEL_LIST" }).tone).toBe("ok")
    expect(checkText({ status: "failed", code: "AUTH_FAILED" })).toEqual({ tone: "fail", text: "The provider refused the key. (AUTH_FAILED)" })
    expect(checkText({ status: "failed", code: "WHO_KNOWS" })).toEqual({ tone: "fail", text: "The check failed. (WHO_KNOWS)" })
    expect([countText(0, "model"), countText(1, "model"), countText(2, "model")]).toEqual(["0 models", "1 model", "2 models"])
  })

  test("a problem always keeps its code, and an unknown one still has words", () => {
    expect(problemText(undefined)).toBe("It cannot be used right now.")
    expect(problemText("RATE_LIMITED")).toBe("The provider is limiting requests right now. (RATE_LIMITED)")
    expect(problemText("NEW_CODE", "Try later.")).toBe("Try later. (NEW_CODE)")
    expect(saveProblemText("CONNECTION_LABEL_INVALID")).toBe("A name is 1 to 160 characters. (CONNECTION_LABEL_INVALID)")
    expect(saveProblemText("NEW_CODE")).toBe("That did not work. (NEW_CODE)")
    for (const problem of ["empty", "lines", "long"] as const) expect(keyProblemText(problem).length).toBeGreaterThan(0)
    for (const problem of ["empty", "invalid", "scheme", "credentials", "plain"] as const) expect(addressProblemText(problem).length).toBeGreaterThan(0)
  })

  test("every way a sign-in can fail has a title and a plain next step", () => {
    const codes = ["AUTH_CANCELLED", "AUTH_TIMEOUT", "AUTH_DENIED", "AUTH_EXPIRED", "AUTH_STATE_MISMATCH", "AUTH_INPUT_INVALID", "AUTH_CODE_REJECTED", "AUTH_SCOPE_MISSING", "AUTH_RESPONSE_INVALID", "AUTH_NETWORK", "AUTH_STORE_FAILED", "AUTH_ACCOUNT_MISMATCH", "AUTH_FLOW_UNKNOWN", "AUTH_UNAVAILABLE", "AUTH_LIMIT", "AUTH_URL_REFUSED", "ENGINE_NOT_RUNNING", "CONTROL_START_FAILED"]
    const fallback = signInProblem(undefined)
    expect(fallback).toEqual({ title: "The sign-in failed", next: "Try again. If it keeps failing, connect with an API key instead.", retry: true })
    expect(signInProblem("AUTH_FAILED")).toEqual(fallback)
    for (const code of codes) {
      const problem = signInProblem(code)
      expect([code, problem.title === fallback.title]).toEqual([code, false])
      expect(problem.next.length).toBeGreaterThan(20)
    }
    // Trying the same thing again cannot help for these.
    expect(codes.filter((code) => !signInProblem(code).retry)).toEqual(["AUTH_SCOPE_MISSING", "AUTH_ACCOUNT_MISMATCH", "AUTH_FLOW_UNKNOWN", "AUTH_UNAVAILABLE", "AUTH_URL_REFUSED"])
  })

  test("explains the manual route, an unofficial sign-in, and where keys are kept", () => {
    expect(manualReason("AUTH_PORT_BUSY")).toContain("port")
    expect(manualReason("AUTH_LISTENER_FAILED")).toContain("could not listen")
    expect(manualReason(undefined)).toContain("expected")
    // Whose sign-in it is, what Runrail presents there, and that it may be stopped.
    expect(unofficialNotice(XAI)).toBe(
      "xAI runs this sign-in for its own command-line tool and does not document it for other apps. Runrail uses that tool's public client id, because xAI issues no other, and names itself as Runrail in every request. xAI may block it, or act on the account, without notice. An API key is the supported way in.",
    )
    expect(unofficialNotice({ ...XAI, id: "later", label: "Later Labs" })).toStartWith("Later Labs runs this sign-in for its own command-line tool")
    expect(flowDetail(CHATGPT)).toBe("Plus, Pro, Business, or Enterprise plan")
    expect(flowDetail(XAI)).toBe("SuperGrok or X Premium plan")
    expect(flowDetail({ ...XAI, id: "later" })).toBe("Sign in with your account")
    expect(storeText("keychain")).toContain("system keychain")
    expect(storeText("file")).toContain("not the keychain")
    expect(storeText(undefined)).toBe("Keys and sign-ins are kept by the Runrail engine.")
    expect(formatName("custom-openai-chat", "x")).toBe("OpenAI Chat Completions")
    expect(formatName("custom-new", "Custom (New)")).toBe("Custom (New)")
  })

  test("orders, names, and matches providers", () => {
    const ids = ["minimax", "mistral", "openai", "zeta", "anthropic", "alpha"].map((id) => ({ id, name: id }))
    expect(orderPresets(ids).map((preset) => preset.id)).toEqual(["anthropic", "openai", "mistral", "minimax", "zeta", "alpha"])
    expect([suggestLabel("OpenAI", 0), suggestLabel("OpenAI", 1), suggestLabel("OpenAI", 4)]).toEqual(["OpenAI", "OpenAI 2", "OpenAI 5"])
    expect(presetHost({ baseUrl: "https://api.groq.com/openai/v1" })).toBe("api.groq.com")
    expect(presetHost({ baseUrl: "nonsense" })).toBeUndefined()
    expect(presetHost({})).toBeUndefined()
    expect(presetKeywords("anthropic")).toBe("claude")
    expect(presetKeywords("groq")).toBeUndefined()
    expect(matches("", "Anthropic")).toBe(true)
    expect(matches("   ", undefined)).toBe(true)
    expect(matches("CLAUDE key", "Anthropic", undefined, "claude", "api key")).toBe(true)
    expect(matches("claude grok", "Anthropic", "claude")).toBe(false)
    expect(matches("grok", "xAI", undefined)).toBe(false)
  })
})

async function load(scenario: PreviewScenario = {}): Promise<{ readonly data: ConnectData; readonly connections: Connection[] }> {
  setHost(createFakeHost(scenario))
  const [catalog, detected, flows, connections] = await Promise.all([connectionPresets(), detectShellConnections(), signInFlows(), listConnections()])
  return { data: { catalog, detected, flows }, connections }
}

const keysOf = (tiles: readonly Tile[]): string[] => tiles.map((tile) => tile.key)
const tile = (tiles: readonly Tile[], key: string): Tile | undefined => tiles.find((item) => item.key === key)

describe("what \"Connect a model\" offers", () => {
  test("lists sign-ins, tool routes, providers in order, and the custom address", async () => {
    const { data, connections } = await load()
    const tiles = buildTiles("", data, connections)
    expect(tiles.empty).toBe(false)
    expect(tiles.shell).toEqual([{ presetId: "groq", name: "Groq", environmentName: "GROQ_API_KEY" }])
    expect(keysOf(tiles.subscriptions)).toEqual(["flow:chatgpt", "flow:openrouter", "flow:xai", "flow:kimi", "flow:meta", "route:claude-code", "route:codex", "route:copilot", "route:pi"])
    // The addresses those plan sign-ins lead to take no pasted key, so they have no key tile.
    expect(keysOf(tiles.keys)).toEqual(["preset:anthropic", "preset:openai", "preset:google", "preset:openrouter", "preset:xai", "preset:groq", "preset:deepseek", "preset:mistral", "preset:minimax", "preset:kimi-for-coding", "preset:meta", "custom"])
    for (const key of ["flow:xai", "flow:kimi", "flow:meta"]) expect([key, tile(tiles.subscriptions, key)?.badge]).toEqual([key, "Unofficial"])
    expect(tile(tiles.subscriptions, "flow:meta")).toMatchObject({ name: "Meta AI (plan)", detail: "Meta AI plan" })
    expect(tile(tiles.subscriptions, "flow:chatgpt")?.badge).toBeUndefined()
    expect(tile(tiles.keys, "preset:groq")).toMatchObject({ name: "Groq", detail: "api.groq.com", count: 0 })
    expect(tile(tiles.subscriptions, "route:claude-code")).toMatchObject({ name: "Claude Pro or Max", detail: "Runs through Claude Code installed on this Mac", step: { kind: "route" } })
  })

  test("counts what is already connected and names the next one after it", async () => {
    const { data, connections } = await load()
    const tiles = buildTiles("", data, connections)
    // The shell connection counts too, so a pasted key is "OpenAI 2".
    expect([tile(tiles.keys, "preset:anthropic")?.count, tile(tiles.keys, "preset:openai")?.count, tile(tiles.keys, "preset:groq")?.count, tile(tiles.keys, "custom")?.count]).toEqual([1, 1, 0, 0])
    expect(tile(tiles.keys, "preset:openai")?.step).toMatchObject({ kind: "key", label: "OpenAI 2" })
    expect(tile(tiles.keys, "preset:groq")?.step).toMatchObject({ kind: "key", label: "Groq" })
    expect(tile(tiles.subscriptions, "flow:chatgpt")).toMatchObject({ count: 0, step: { kind: "sign-in", again: false } })

    const mixed = await load({ seed: "mixed" })
    const busy = buildTiles("", mixed.data, mixed.connections)
    // A sign-in that already has an account asks which one; it does not start a second by itself.
    expect(tile(busy.subscriptions, "flow:chatgpt")).toMatchObject({ count: 1, step: { kind: "accounts" } })
    expect(tile(busy.subscriptions, "flow:openrouter")?.count).toBe(1)
    expect(tile(busy.subscriptions, "flow:xai")).toMatchObject({ count: 0, step: { kind: "sign-in" } })
    // The subscription does not count as a key for the same provider.
    expect([tile(busy.keys, "preset:openai")?.count, tile(busy.keys, "preset:openrouter")?.count, tile(busy.keys, "preset:groq")?.count, tile(busy.keys, "custom")?.count]).toEqual([1, 0, 1, 1])
  })

  test("a shell key already in use is not offered again", async () => {
    const { data, connections } = await load()
    const attached = [...connections, conn("env-groq", { presetId: "groq", authMode: "environment", environmentName: "GROQ_API_KEY" })]
    expect(buildTiles("", data, attached).shell).toEqual([])
    // Another provider reading a variable of the same name does not hide it.
    expect(buildTiles("", data, [...connections, conn("env-x", { presetId: "mistral", authMode: "environment", environmentName: "GROQ_API_KEY" })]).shell.length).toBe(1)
  })

  test("the filter finds a provider by name, nickname, address, and shell variable", async () => {
    const { data, connections } = await load()
    const found = (query: string): string[] => {
      const tiles = buildTiles(query, data, connections)
      return [...tiles.shell.map((item) => `shell:${item.presetId}`), ...keysOf(tiles.subscriptions), ...keysOf(tiles.keys)]
    }
    expect(found("claude")).toEqual(["route:claude-code", "preset:anthropic"])
    expect(found("chatgpt")).toEqual(["flow:chatgpt", "route:codex", "preset:openai"])
    expect(found("GROQ_API_KEY")).toEqual(["shell:groq", "preset:groq"])
    expect(found("api.deepseek.com")).toEqual(["preset:deepseek"])
    expect(found("ollama")).toEqual(["custom"])
    expect(found("  open   router ")).toEqual(["flow:openrouter", "preset:openrouter"])
    expect(found("shell")).toEqual(["shell:groq"])
    const nothing = buildTiles("no such provider", data, connections)
    expect(nothing).toEqual({ shell: [], subscriptions: [], tools: [], keys: [], empty: true })
  })

  test("every subscription PI-Desktop lists finds something here", async () => {
    const { data, connections } = await load()
    const names: [string, string][] = [
      ["chatgpt", "flow:chatgpt"],
      ["openrouter", "flow:openrouter"],
      ["claude pro", "route:claude-code"],
      ["anthropic", "route:claude-code"],
      ["xai", "flow:xai"],
      ["grok", "flow:xai"],
      ["supergrok", "flow:xai"],
      ["x premium", "flow:xai"],
      ["grok", "preset:xai"],
      ["kimi", "flow:kimi"],
      ["kimi", "preset:kimi-for-coding"],
      ["meta", "flow:meta"],
      ["muse", "flow:meta"],
      ["meta", "preset:meta"],
      ["github copilot", "route:copilot"],
      ["copilot", "route:copilot"],
      ["codex", "route:codex"],
      ["radius", "route:pi"],
      ["gemini cli", "route:pi"],
    ]
    for (const [query, expected] of names) {
      const tiles = buildTiles(query, data, connections)
      expect([query, [...keysOf(tiles.subscriptions), ...keysOf(tiles.keys)].includes(expected)]).toEqual([query, true])
    }
    expect(toolRoutes().map((route) => route.id)).toEqual(["claude-code", "codex", "copilot", "pi"])
    // Copilot runs through GitHub's own tool, and the tile says Runrail borrows no other editor's name.
    expect(toolRoutes().find((route) => route.id === "copilot")?.steps.join(" ")).toContain("never presents itself as another editor")
    for (const route of toolRoutes()) expect(route.steps.length).toBeGreaterThan(1)
  })

  test("an engine without custom formats offers no custom address", async () => {
    const { data, connections } = await load()
    const tiles = buildTiles("", { ...data, catalog: { presets: data.catalog.presets, custom: [] } }, connections)
    expect(keysOf(tiles.keys)).not.toContain("custom")
    expect(buildTiles("ollama", { ...data, catalog: { presets: data.catalog.presets, custom: [] } }, connections).empty).toBe(true)
  })
})

describe("the step a dialog opens on", () => {
  test("opens the list when nothing is named or what is named is gone", async () => {
    const { data, connections } = await load()
    expect(initialStep({}, data, connections)).toEqual({ kind: "pick" })
    expect(initialStep({ presetId: "nope" }, data, connections)).toEqual({ kind: "pick" })
    expect(initialStep({ flow: "nope" }, data, connections)).toEqual({ kind: "pick" })
    expect(initialStep({ connectionId: "gone" }, data, connections)).toEqual({ kind: "pick" })
    // A shell variable has nothing to replace here.
    expect(initialStep({ connectionId: "openai" }, data, connections)).toEqual({ kind: "pick" })
    // A connection that is gone does not fall through to the provider named with it.
    expect(initialStep({ connectionId: "gone", presetId: "groq" }, data, connections)).toEqual({ kind: "pick" })
  })

  test("opens a provider's key form, the custom form, or a sign-in", async () => {
    const { data, connections } = await load()
    expect(initialStep({ presetId: "groq" }, data, connections)).toMatchObject({ kind: "key", preset: { id: "groq" }, label: "Groq" })
    expect(initialStep({ presetId: "anthropic" }, data, connections)).toMatchObject({ kind: "key", preset: { id: "anthropic" }, label: "Anthropic 2" })
    expect(initialStep({ presetId: "custom-anthropic" }, data, connections)).toEqual({ kind: "custom" })
    // A plan address opens its sign-in, never a key form.
    expect(initialStep({ presetId: "kimi-code" }, data, connections)).toMatchObject({ kind: "sign-in", flow: { id: "kimi" }, again: false })
    expect(initialStep({ presetId: "xai-grok" }, { ...data, flows: [] }, connections)).toEqual({ kind: "pick" })
    expect(initialStep({ flow: "chatgpt" }, data, connections)).toMatchObject({ kind: "sign-in", flow: { id: "chatgpt" }, again: false })
    const mixed = await load({ seed: "mixed" })
    expect(initialStep({ flow: "chatgpt" }, mixed.data, mixed.connections)).toMatchObject({ kind: "accounts", flow: { id: "chatgpt" } })
  })

  test("opens a connection on its own repair", async () => {
    const { data, connections } = await load({ seed: "mixed" })
    expect(initialStep({ connectionId: "groq" }, data, connections)).toMatchObject({ kind: "replace", connection: { id: "groq", status: "error" } })
    expect(initialStep({ connectionId: "custom" }, data, connections)).toMatchObject({ kind: "replace", connection: { id: "custom" } })
    expect(initialStep({ connectionId: "signin-chatgpt" }, data, connections)).toMatchObject({ kind: "sign-in", flow: { id: "chatgpt" }, accountId: "signin-chatgpt", label: "ChatGPT", again: true })
    // An engine that no longer offers the sign-in cannot run it again.
    expect(initialStep({ connectionId: "signin-chatgpt" }, { ...data, flows: [] }, connections)).toEqual({ kind: "pick" })
  })
})
