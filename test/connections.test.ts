import { beforeEach, describe, expect, test } from "bun:test"
import {
  addKeyConnection,
  addressProblem,
  connectionModels,
  connectionPresets,
  createKeyConnection,
  createShellConnection,
  detectShellConnections,
  freeConnectionId,
  keyProblem,
  listConnections,
  nextSignInAccount,
  onConnectionsChanged,
  removeConnection,
  renameConnection,
  signInFlows,
  signOutConnection,
  storeKey,
  storeKeyFromClipboard,
  systemRpc,
  testConnection,
} from "../src/app/connections"
import { get, setPrefs } from "../src/app/store"
import { setHost, SYSTEM_ENGINE_ID, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { guardRendererRpc, parsePreviewScenario, type PreviewScenario } from "../src/host/fakeConnections"

const CANARY = "sk-canary-0123456789"
let host: Host

async function code(run: () => unknown): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function use(scenario: PreviewScenario = {}): void {
  host = createFakeHost(scenario)
  setHost(host)
}

beforeEach(() => use())

describe("connections", () => {
  test("lists connections and the models each one reaches", async () => {
    const connections = await listConnections()
    expect(connections.map((connection) => [connection.id, connection.presetId, connection.authMode, connection.status])).toEqual([
      ["anthropic", "anthropic", "api-key", "ready"],
      ["openai", "openai", "environment", "ready"],
    ])
    expect(connections[1]?.environmentName).toBe("OPENAI_API_KEY")
    const listed = await connectionModels("anthropic")
    expect(listed.code).toBeUndefined()
    expect(listed.models.map((model) => model.id)).toContain("claude-opus-5-5")
  })

  test("a custom address with no model list is not an error", async () => {
    await systemRpc("account.create", { accountId: "relay", provider: "custom-openai-chat", preset: "custom-openai-chat", label: "Relay", authMode: "api-key", scopes: [], baseUrl: "http://127.0.0.1:9/v1", status: "unconfigured" })
    expect(await connectionModels("relay")).toEqual({ models: [], images: [], code: "CREDENTIAL_MISSING" })
    await host.connectionSecretSet("relay", CANARY)
    expect(await connectionModels("relay")).toEqual({ models: [], images: [] })
  })

  test("an unknown connection reports its code instead of throwing", async () => {
    expect(await connectionModels("nobody")).toEqual({ models: [], images: [], code: "CONTROL_ACCOUNT_NOT_FOUND" })
  })

  test("a key goes in and never comes back", async () => {
    const created = await systemRpc("account.create", { accountId: "groq", provider: "groq", preset: "groq", label: "Groq", authMode: "api-key", scopes: [], status: "unconfigured" })
    expect((created as { status: string }).status).toBe("unconfigured")
    const stored = await host.connectionSecretSet("groq", `  ${CANARY}\n`)
    expect((stored as { status: string }).status).toBe("ready")
    const seen = JSON.stringify([created, stored, await systemRpc("account.list"), await systemRpc("account.get", { accountId: "groq" }), await host.systemEngine()])
    expect(seen).not.toContain(CANARY)
    expect(await code(() => host.connectionSecretSet("groq", "two\nlines"))).toBe("CONNECTION_SECRET_INVALID")
    expect(await code(() => host.connectionSecretSet("nobody", CANARY))).toBe("CONTROL_ACCOUNT_NOT_FOUND")
    // A shell variable is not a stored key.
    expect(await code(() => host.connectionSecretSet("openai", CANARY))).toBe("CONTROL_INVALID_INPUT")
  })

  test("sign-in finishes through the host, never through a control request", async () => {
    const started = (await systemRpc("auth.login.start", { flow: "chatgpt" })) as { loginId: string; state: string; events: { type: string }[] }
    expect(started.state).toBe("waiting")
    expect(started.events.map((event) => event.type)).toEqual(["open-url", "waiting"])
    expect(await code(() => host.rpc(SYSTEM_ENGINE_ID, "auth.login.status", { loginId: started.loginId, input: "http://localhost:1455/auth/callback?code=x" }))).toBe("HOST_RPC_REFUSED")
    const done = (await host.authSubmitInput(started.loginId, "http://localhost:1455/auth/callback?code=x")) as { state: string }
    expect(done.state).toBe("done")
    expect((await listConnections()).find((connection) => connection.id === "signin-chatgpt")).toMatchObject({ authMode: "oauth", status: "ready", presetId: "openai" })
    expect(await code(() => host.authOpen(started.loginId))).toBe("AUTH_URL_UNAVAILABLE")
    expect(await code(() => host.authOpen("login-nope"))).toBe("CONTROL_INVALID_INPUT")
  })

  test("a thread starts only on a usable connection", async () => {
    const input = { engineId: "t1", workspace: "/code/app", backend: "native" as const, sessionId: "s1", model: "claude-opus-5-5" }
    expect(await code(() => host.engineStart({ ...input, connectionId: "nobody" }))).toBe("CONNECTION_NOT_FOUND")
    expect((await host.engineStart({ ...input, connectionId: "anthropic" })).connectionId).toBe("anthropic")
    expect(await code(() => host.engineStart({ ...input, engineId: SYSTEM_ENGINE_ID }))).toBe("CONTROL_INVALID_INPUT")
  })
})

describe("adding a connection", () => {
  test("offers the engine's providers, custom formats, and sign-ins", async () => {
    const catalog = await connectionPresets()
    expect(catalog.presets.map((preset) => preset.id)).toEqual(["anthropic", "openai", "openrouter", "google", "groq", "xai", "mistral", "deepseek", "minimax", "kimi-for-coding", "meta", "xai-grok", "kimi-code"])
    expect(catalog.presets.find((preset) => preset.id === "minimax")?.models).toBe("none")
    expect(catalog.presets.filter((preset) => preset.signInOnly === true).map((preset) => preset.id)).toEqual(["xai-grok", "kimi-code"])
    expect(catalog.custom.map((format) => format.id)).toEqual(["custom-openai-chat", "custom-openai-responses", "custom-anthropic"])
    expect((await signInFlows()).map((flow) => [flow.id, flow.kind, flow.authMode, flow.unofficial])).toEqual([
      ["chatgpt", "browser", "oauth", false],
      ["openrouter", "browser", "oauth", false],
      ["xai", "device-code", "device", true],
      ["kimi", "device-code", "device", true],
      ["meta", "device-code", "device", true],
    ])
  })

  test("finds shell keys that no connection uses yet", async () => {
    expect(await detectShellConnections()).toEqual([{ presetId: "groq", name: "Groq", environmentName: "GROQ_API_KEY" }])
    use({ seed: "empty" })
    expect((await detectShellConnections()).map((item) => item.presetId)).toEqual(["openai", "groq"])
  })

  test("a pasted key makes a ready connection, and a second one gets its own id", async () => {
    const added = await addKeyConnection({ presetId: "groq", label: "Groq" }, (id) => storeKey(id, CANARY))
    expect(added).toEqual({ id: "groq", label: "Groq", presetId: "groq", authMode: "api-key", status: "ready" })
    expect(await testConnection("groq")).toEqual({ status: "ok", code: "OK", modelCount: 1 })
    const second = await addKeyConnection({ presetId: "groq", label: "   " }, (id) => storeKey(id, "bad-key"))
    // A blank name falls back to the id.
    expect(second).toMatchObject({ id: "groq-2", label: "groq-2", status: "ready" })
    // The provider refusing a key is found by the check, not by storing it.
    expect(await testConnection("groq-2")).toEqual({ status: "failed", code: "AUTH_FAILED" })
    expect(JSON.stringify(await systemRpc("account.list"))).not.toContain(CANARY)
  })

  test("a key that cannot be stored leaves no connection behind", async () => {
    expect(await code(() => addKeyConnection({ presetId: "mistral", label: "Mistral" }, (id) => storeKey(id, "two\nlines")))).toBe("CONNECTION_SECRET_INVALID")
    expect((await listConnections()).map((connection) => connection.id)).toEqual(["anthropic", "openai"])
    // Created but never given a key: it exists and stays off.
    expect(await createKeyConnection({ presetId: "mistral", label: "Mistral" })).toMatchObject({ id: "mistral", status: "unconfigured" })
    expect(await testConnection("mistral")).toEqual({ status: "failed", code: "CREDENTIAL_MISSING" })
    // A plan address takes no key: nothing is created, so nothing is left behind.
    expect(await code(() => addKeyConnection({ presetId: "xai-grok", label: "Grok plan" }, (id) => storeKey(id, "k")))).toBe("CONTROL_ACCOUNT_SIGN_IN_ONLY")
    expect((await listConnections()).some((connection) => connection.presetId === "xai-grok")).toBe(false)
  })

  test("a custom address keeps its address and is checked on first use", async () => {
    const custom = await addKeyConnection({ presetId: "custom-openai-chat", label: "Ollama", baseUrl: "  http://127.0.0.1:11434/v1 " }, (id) => storeKey(id, "local"))
    expect(custom).toEqual({ id: "custom", label: "Ollama", presetId: "custom-openai-chat", authMode: "api-key", status: "ready", baseUrl: "http://127.0.0.1:11434/v1" })
    expect(await testConnection("custom")).toEqual({ status: "unverified", code: "NO_MODEL_LIST" })
    const moved = { accountId: "custom", provider: "custom-openai-chat", preset: "custom-openai-chat", label: "Ollama", authMode: "api-key", scopes: [], baseUrl: "http://127.0.0.1:1/v1" }
    expect(await code(() => systemRpc("account.upsert", moved))).toBe("CONTROL_ACCOUNT_ENDPOINT_LOCKED")
    expect((await addKeyConnection({ presetId: "custom-anthropic", label: "Relay", baseUrl: "https://relay.example/v1" }, (id) => storeKey(id, "k"))).id).toBe("custom-2")
  })

  test("a shell key becomes a connection without the window reading it", async () => {
    const [groq] = await detectShellConnections()
    expect(await createShellConnection(groq!)).toEqual({ id: "env-groq", label: "Groq", presetId: "groq", authMode: "environment", status: "ready", environmentName: "GROQ_API_KEY" })
    expect(await detectShellConnections()).toEqual([])
    // One provider's variable is never pointed at another provider.
    expect(await code(() => createShellConnection({ presetId: "mistral", name: "Mistral", environmentName: "OPENAI_API_KEY" }))).toBe("PROVIDER_ENDPOINT_DENIED")
    expect(await code(() => storeKey("env-groq", CANARY))).toBe("CONTROL_INVALID_INPUT")
  })

  test("the host can take the key from the clipboard itself", async () => {
    await createKeyConnection({ presetId: "mistral", label: "Mistral" })
    expect(await storeKeyFromClipboard("mistral")).toMatchObject({ id: "mistral", status: "ready" })
    expect(await code(() => storeKeyFromClipboard("openai"))).toBe("CONTROL_INVALID_INPUT")
    expect(await code(() => storeKeyFromClipboard("nobody"))).toBe("CONTROL_ACCOUNT_NOT_FOUND")
  })

  test("names the next account of a sign-in", async () => {
    expect(await nextSignInAccount({ id: "chatgpt", label: "ChatGPT" })).toEqual({ accountId: "signin-chatgpt", label: "ChatGPT" })
    use({ seed: "mixed" })
    expect(await nextSignInAccount({ id: "chatgpt", label: "ChatGPT" })).toEqual({ accountId: "signin-chatgpt-2", label: "ChatGPT 2" })
  })

  test("checks a key and an address before anything is sent", () => {
    expect([keyProblem("   "), keyProblem("a\nb"), keyProblem("x".repeat(16 * 1024 + 1)), keyProblem(`  ${CANARY}  `)]).toEqual(["empty", "lines", "long", undefined])
    const addresses: [string, ReturnType<typeof addressProblem>][] = [
      ["", "empty"],
      ["not an address", "invalid"],
      ["ftp://host/v1", "scheme"],
      ["https://user:pw@host/v1", "credentials"],
      ["https://host/v1#part", "credentials"],
      ["http://example.com/v1", "plain"],
      ["http://172.32.0.1/v1", "plain"],
      ["http://127.0.0.1:11434/v1", undefined],
      ["http://localhost:1234/v1", undefined],
      ["http://192.168.1.4/v1", undefined],
      ["http://172.16.0.9/v1", undefined],
      ["http://studio.local:1234/v1", undefined],
      ["  https://api.example.com/v1  ", undefined],
    ]
    for (const [address, problem] of addresses) expect([address, addressProblem(address)]).toEqual([address, problem])
  })

  test("picks the first free id and stops at a limit", async () => {
    expect(freeConnectionId("groq", new Set())).toBe("groq")
    expect(freeConnectionId("groq", new Set(["groq", "groq-2"]))).toBe("groq-3")
    const full = new Set(["groq", ...Array.from({ length: 998 }, (_, index) => `groq-${index + 2}`)])
    expect(await code(() => freeConnectionId("groq", full))).toBe("CONNECTION_LIMIT")
  })
})

describe("changing and removing a connection", () => {
  test("rename changes the name and nothing else", async () => {
    expect(await renameConnection("openai", "  Work OpenAI  ")).toEqual({ id: "openai", label: "Work OpenAI", presetId: "openai", authMode: "environment", status: "ready", environmentName: "OPENAI_API_KEY" })
    expect(await renameConnection("anthropic", "Personal")).toMatchObject({ id: "anthropic", label: "Personal", status: "ready", authMode: "api-key" })
    use({ seed: "mixed" })
    expect(await renameConnection("signin-chatgpt", "Work ChatGPT")).toMatchObject({ label: "Work ChatGPT", status: "expired", statusCode: "SIGN_IN_EXPIRED" })
    expect(await renameConnection("custom", "Relay")).toMatchObject({ label: "Relay", baseUrl: "http://127.0.0.1:8080/v1", status: "ready" })
  })

  test("rename refuses an empty or oversized name and an unknown connection", async () => {
    expect(await code(() => renameConnection("openai", "   "))).toBe("CONNECTION_LABEL_INVALID")
    expect(await code(() => renameConnection("openai", "x".repeat(161)))).toBe("CONNECTION_LABEL_INVALID")
    expect(await code(() => renameConnection("nobody", "Name"))).toBe("CONTROL_ACCOUNT_NOT_FOUND")
    expect((await listConnections()).find((connection) => connection.id === "openai")?.label).toBe("OpenAI")
  })

  test("removing the default connection clears the default model", async () => {
    setPrefs({ defaultModel: "claude-opus-5-5", defaultConnectionId: "anthropic" })
    await removeConnection("openai")
    expect([get().prefs.defaultModel, get().prefs.defaultConnectionId]).toEqual(["claude-opus-5-5", "anthropic"])
    await removeConnection("anthropic")
    expect([get().prefs.defaultModel, get().prefs.defaultConnectionId]).toEqual([undefined, undefined])
    expect(await listConnections()).toEqual([])
    expect(await code(() => removeConnection("anthropic"))).toBe("CONTROL_ACCOUNT_NOT_FOUND")
  })

  test("sign out drops the sign-in and keeps the connection", async () => {
    use({ seed: "mixed" })
    expect(await signOutConnection("signin-chatgpt")).toMatchObject({ id: "signin-chatgpt", label: "ChatGPT", status: "unconfigured", statusCode: "SIGNED_OUT" })
    expect(await testConnection("signin-chatgpt")).toEqual({ status: "failed", code: "CREDENTIAL_MISSING" })
    // A shell variable is not stored by the app, so there is nothing to sign out of.
    expect(await code(() => signOutConnection("openai"))).toBe("CONTROL_INVALID_INPUT")
    expect(await code(() => signOutConnection("nobody"))).toBe("CONTROL_ACCOUNT_NOT_FOUND")
  })

  test("a check answers with a code and never throws", async () => {
    use({ seed: "mixed" })
    const checks = await Promise.all(["anthropic", "groq", "mistral", "signin-chatgpt", "custom", "nobody"].map(async (id) => [id, await testConnection(id)]))
    expect(checks).toEqual([
      ["anthropic", { status: "ok", code: "OK", modelCount: 3 }],
      ["groq", { status: "failed", code: "AUTH_FAILED" }],
      ["mistral", { status: "failed", code: "CREDENTIAL_MISSING" }],
      ["signin-chatgpt", { status: "failed", code: "SIGN_IN_EXPIRED" }],
      ["custom", { status: "unverified", code: "NO_MODEL_LIST" }],
      ["nobody", { status: "failed", code: "CONTROL_ACCOUNT_NOT_FOUND" }],
    ])
  })

  test("every change is announced, and a refused one is not", async () => {
    let changes = 0
    const stop = onConnectionsChanged(() => {
      changes += 1
    })
    await addKeyConnection({ presetId: "groq", label: "Groq" }, (id) => storeKey(id, CANARY))
    expect(changes).toBe(2)
    await renameConnection("groq", "Fast")
    await signOutConnection("groq")
    await removeConnection("groq")
    expect(changes).toBe(5)
    await code(() => renameConnection("nobody", "Name"))
    await code(() => removeConnection("nobody"))
    await code(() => signOutConnection("openai"))
    expect(changes).toBe(5)
    stop()
    await removeConnection("openai")
    expect(changes).toBe(5)
  })

  test("an engine that is not running is a code, not a crash", async () => {
    use({ offline: true })
    // Which of the two depends on whether an earlier request already started the engine.
    const stopped: readonly (string | undefined)[] = ["CONTROL_START_FAILED", "ENGINE_NOT_RUNNING"]
    expect(stopped).toContain(await code(() => listConnections()))
    expect(stopped).toContain(await code(() => connectionPresets()))
    expect(stopped).toContain(await code(() => renameConnection("openai", "Name")))
    const check = await testConnection("anthropic")
    expect(check.status).toBe("failed")
    expect(stopped).toContain(check.code)
    const listed = await connectionModels("anthropic")
    expect(listed.models).toEqual([])
    expect(stopped).toContain(listed.code)
  })
})

describe("preview scenarios", () => {
  test("reads known words and ignores the rest", () => {
    expect(parsePreviewScenario("mixed, port-busy ,OFFLINE,nonsense")).toEqual({ seed: "mixed", signIn: "port-busy", offline: true })
    expect(parsePreviewScenario("empty")).toEqual({ seed: "empty" })
    expect(parsePreviewScenario("bogus")).toEqual({})
    expect(parsePreviewScenario(null)).toEqual({})
    expect(parsePreviewScenario(undefined)).toEqual({})
  })
})

describe("what the window may ask an engine", () => {
  const refusedCode = (engineId: string, method: string, params: Record<string, unknown> = {}): string | undefined => {
    try {
      guardRendererRpc(engineId, method, params)
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

  test("refuses secrets, sign-in input, and caller-named addresses", () => {
    const refused: [string, string, Record<string, unknown>][] = [
      [SYSTEM_ENGINE_ID, "auth.secret.set", { accountId: "a" }],
      ["t1", "auth.secret", {}],
      [SYSTEM_ENGINE_ID, "control.describe", {}],
      [SYSTEM_ENGINE_ID, "turn.enqueue", { message: "hi" }],
      ["t1", "auth.flows", {}],
      [SYSTEM_ENGINE_ID, "account.upsert", { accountId: "a", secret: CANARY }],
      [SYSTEM_ENGINE_ID, "account.upsert", { accountId: "a", headers: { nested: [{ ApiKey: CANARY }] } }],
      ["t1", "provider.discover", { provider: "openai", endpoint: "https://example.invalid/v1" }],
      ["t1", "model.discover", { credentialEnvironment: "OPENAI_API_KEY" }],
      [SYSTEM_ENGINE_ID, "account.create", { accountId: "a", authMode: "environment", environmentName: "OPENAI_API_KEY", baseUrl: "https://example.invalid/v1" }],
    ]
    for (const [engineId, method, params] of refused) expect([method, refusedCode(engineId, method, params)]).toEqual([method, "HOST_RPC_REFUSED"])
  })

  test("lets ordinary requests through", () => {
    const allowed: [string, string, Record<string, unknown>][] = [
      [SYSTEM_ENGINE_ID, "account.list", {}],
      [SYSTEM_ENGINE_ID, "connection.models", { connectionId: "anthropic" }],
      [SYSTEM_ENGINE_ID, "auth.login.start", { flow: "chatgpt" }],
      [SYSTEM_ENGINE_ID, "account.create", { accountId: "a", authMode: "api-key", baseUrl: "http://127.0.0.1:9/v1" }],
      ["t1", "turn.enqueue", { message: "the token budget" }],
      // Outside the credential methods a field may be called anything.
      ["t1", "workspace.read", { path: "src/token.ts", token: "x" }],
      ["t1", "model.list", {}],
    ]
    for (const [engineId, method, params] of allowed) expect([method, refusedCode(engineId, method, params)]).toEqual([method, undefined])
  })
})
