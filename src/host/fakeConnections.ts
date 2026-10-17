import { CONNECTION_ID, HostError, SYSTEM_ENGINE_ID } from "./types"

/**
 * Preview stand-in for the system engine: connections, their models, and sign-ins. It mirrors the
 * real host's rules (which requests the web view may make, and that a key goes in and never comes
 * back) so UI tests exercise the same refusals. Nothing is stored, opened, or sent anywhere.
 */

type Params = Record<string, unknown>
type Status = "unconfigured" | "ready" | "expired" | "refreshing" | "error" | "revoked"

/**
 * What the preview pretends is true, so every state of the connection screens can be looked at
 * and tested. `seed` picks the stored connections; `signIn` picks how a sign-in goes once its
 * page is opened; `offline` makes the system engine fail to start.
 */
export interface PreviewScenario {
  readonly seed?: "default" | "empty" | "mixed"
  readonly signIn?: "ok" | "port-busy" | "denied" | "never"
  readonly offline?: boolean
  /** Every thread opens with a 2,000-item history, for measuring a long thread. */
  readonly long?: boolean
  /** How long the pretend browser round trip takes. */
  readonly signInDelayMs?: number
  /** Projects and threads that fill themselves with activity, for office mode (fakeOffice.ts). */
  readonly office?: boolean
  /** With `office`: forty threads, twelve of them working at once. */
  readonly stress?: boolean
  /** The checkout's git state, for previewing the thread bar: `git-behind`, `git-diverged`, and so on. */
  readonly git?: PreviewGit
  /** The GitHub CLI as `codehost.status` finds it: `gh-missing` or `gh-signed-out`; signed in otherwise. */
  readonly gh?: "missing" | "signed-out"
  /** The branch's pull request, for previewing the PR chip: `pr-passing`, `pr-failing`, and so on. */
  readonly pr?: PreviewPr
  /** Claude Code's 5-hour window past the bar's amber or red line: `usage-high`, `usage-full`; its weekly one used up with no extra usage: `usage-out`. */
  readonly usage?: "high" | "full" | "out"
  /** Six projects with no threads, one per git line Settings → Projects shows. */
  readonly projects?: boolean
  /** The repository brings a setup that runs a check with full access, so it waits for the person's trust. */
  readonly projectSetup?: boolean
  /** Computer use: Runrail not granted the access yet, or Notes allowed already. */
  readonly computer?: "no-access" | "allowed"
  /** iOS Simulator: no Xcode, or no idb, so the pane is view only. */
  readonly simulator?: "no-xcode" | "no-idb"
  /** Android emulators: no SDK, or no KVM to start one. */
  readonly android?: "no-sdk" | "no-kvm"
}

export const PREVIEW_PRS = ["passing", "running", "failing", "draft", "approved", "changes", "conflicts", "merged", "closed", "none", "disconnected"] as const
export type PreviewPr = (typeof PREVIEW_PRS)[number]

export const PREVIEW_GITS = ["behind", "diverged", "unpublished", "detached", "noremote", "gitlab", "guess", "fork", "clean"] as const
export type PreviewGit = (typeof PREVIEW_GITS)[number]

const SEEDS: ReadonlySet<string> = new Set(["default", "empty", "mixed"])
const SIGN_INS: ReadonlySet<string> = new Set(["ok", "port-busy", "denied", "never"])

/** Reads a scenario from the `preview` query value: comma-separated words, unknown ones ignored. */
export function parsePreviewScenario(value: string | null | undefined): PreviewScenario {
  const words = (value ?? "").split(",").map((word) => word.trim().toLowerCase())
  const seed = words.find((word) => SEEDS.has(word)) as PreviewScenario["seed"]
  const signIn = words.find((word) => SIGN_INS.has(word)) as PreviewScenario["signIn"]
  const git = PREVIEW_GITS.find((name) => words.includes(`git-${name}`))
  const gh = words.includes("gh-missing") ? "missing" : words.includes("gh-signed-out") ? "signed-out" : undefined
  const pr = PREVIEW_PRS.find((name) => words.includes(`pr-${name}`))
  const usage = words.includes("usage-out") ? "out" : words.includes("usage-full") ? "full" : words.includes("usage-high") ? "high" : undefined
  return {
    ...(seed === undefined ? {} : { seed }),
    ...(signIn === undefined ? {} : { signIn }),
    ...(words.includes("offline") ? { offline: true } : {}),
    ...(words.includes("long") ? { long: true } : {}),
    ...(words.includes("office") ? { office: true } : {}),
    ...(words.includes("stress") ? { stress: true } : {}),
    ...(git === undefined ? {} : { git }),
    ...(gh === undefined ? {} : { gh }),
    ...(pr === undefined ? {} : { pr }),
    ...(usage === undefined ? {} : { usage }),
    ...(words.includes("projects") ? { projects: true } : {}),
    ...(words.includes("project-setup") ? { projectSetup: true } : {}),
    ...(words.includes("computer-no-access") ? { computer: "no-access" as const } : words.includes("computer-allowed") ? { computer: "allowed" as const } : {}),
    ...(words.includes("simulator-no-xcode") ? { simulator: "no-xcode" as const } : words.includes("simulator-no-idb") ? { simulator: "no-idb" as const } : {}),
    ...(words.includes("android-no-sdk") ? { android: "no-sdk" as const } : words.includes("android-no-kvm") ? { android: "no-kvm" as const } : {}),
  }
}

interface FakeAccount {
  /** Set by a key the preview treats as refused by the provider. The key itself is not kept. */
  rejected?: boolean
  reference: {
    accountId: string
    provider: string
    label: string
    authMode: string
    scopes: string[]
    environmentName?: string
    preset?: string
    baseUrl?: string
    createdAt: number
    updatedAt: number
  }
  status: Status
  statusCode?: string
}

interface FakeTool {
  readonly connectionId: string
  readonly tool: string
  label: string
  readonly authMode: "subscription" | "api-key"
  readonly separateAccount: boolean
  enabled: boolean
  models?: string[]
}

interface FakeLogin {
  readonly loginId: string
  readonly flow: string
  readonly preset: string
  readonly accountId: string
  readonly label: string
  readonly authMode: string
  state: "waiting" | "finishing" | "done" | "failed" | "cancelled"
  code?: string
  readonly acceptsInput: boolean
  readonly events: Params[]
  readonly startedAt: number
  readonly expiresAt: number
}

interface FakeModel {
  readonly id: string
  readonly name: string
  readonly contextTokens: number
  readonly reasoning: boolean
  readonly images: boolean
  readonly pricing?: { readonly inputUsdPerMillionTokens: number; readonly outputUsdPerMillionTokens: number }
}

const PRESETS: readonly { id: string; name: string; protocol: string; baseUrl: string; environment?: string; models: string; signInOnly?: boolean }[] = [
  { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", environment: "ANTHROPIC_API_KEY", models: "list" },
  { id: "openai", name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", environment: "OPENAI_API_KEY", models: "list" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", environment: "OPENROUTER_API_KEY", models: "list" },
  { id: "google", name: "Google Gemini", protocol: "openai-chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", environment: "GEMINI_API_KEY", models: "list" },
  { id: "groq", name: "Groq", protocol: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", environment: "GROQ_API_KEY", models: "list" },
  { id: "xai", name: "xAI", protocol: "openai-chat", baseUrl: "https://api.x.ai/v1", environment: "XAI_API_KEY", models: "list" },
  { id: "mistral", name: "Mistral", protocol: "openai-chat", baseUrl: "https://api.mistral.ai/v1", environment: "MISTRAL_API_KEY", models: "list" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai-chat", baseUrl: "https://api.deepseek.com", environment: "DEEPSEEK_API_KEY", models: "list" },
  { id: "minimax", name: "MiniMax (International)", protocol: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic/v1", environment: "MINIMAX_API_KEY", models: "none" },
  { id: "kimi-for-coding", name: "Kimi for Coding", protocol: "anthropic-messages", baseUrl: "https://api.kimi.com/coding/v1", environment: "KIMI_API_KEY", models: "list" },
  { id: "meta", name: "Meta AI", protocol: "openai-responses", baseUrl: "https://api.meta.ai/v1", environment: "META_API_KEY", models: "list" },
  { id: "xai-grok", name: "xAI (Grok plan)", protocol: "openai-responses", baseUrl: "https://api.x.ai/v1", models: "list", signInOnly: true },
  { id: "kimi-code", name: "Kimi Code", protocol: "anthropic-messages", baseUrl: "https://api.kimi.com/coding/v1", models: "list", signInOnly: true },
]

const CUSTOM: readonly { id: string; name: string; protocol: string; authStyle: string }[] = [
  { id: "custom-openai-chat", name: "Custom (OpenAI Chat)", protocol: "openai-chat", authStyle: "bearer" },
  { id: "custom-openai-responses", name: "Custom (OpenAI Responses)", protocol: "openai-responses", authStyle: "bearer" },
  { id: "custom-anthropic", name: "Custom (Anthropic Messages)", protocol: "anthropic-messages", authStyle: "x-api-key" },
]

const FLOWS: readonly { id: string; label: string; preset: string; kind: string; authMode: string; unofficial: boolean; browserHosts: string[] }[] = [
  { id: "chatgpt", label: "ChatGPT", preset: "openai", kind: "browser", authMode: "oauth", unofficial: false, browserHosts: ["auth.openai.com"] },
  { id: "openrouter", label: "OpenRouter", preset: "openrouter", kind: "browser", authMode: "oauth", unofficial: false, browserHosts: ["openrouter.ai"] },
  { id: "xai", label: "xAI (Grok plan)", preset: "xai-grok", kind: "device-code", authMode: "device", unofficial: true, browserHosts: ["accounts.x.ai"] },
  { id: "kimi", label: "Kimi Code", preset: "kimi-code", kind: "device-code", authMode: "device", unofficial: true, browserHosts: ["www.kimi.com"] },
  { id: "meta", label: "Meta AI (plan)", preset: "meta", kind: "device-code", authMode: "device", unofficial: true, browserHosts: ["auth.meta.com"] },
]

const MODELS: Readonly<Record<string, readonly FakeModel[]>> = {
  anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", contextTokens: 1_000_000, reasoning: true, images: true, pricing: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 } },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextTokens: 1_000_000, reasoning: true, images: true, pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 } },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextTokens: 200_000, reasoning: false, images: true },
  ],
  openai: [
    { id: "gpt-5.5", name: "GPT-5.5", contextTokens: 400_000, reasoning: true, images: true },
    { id: "gpt-5.5-mini", name: "GPT-5.5 mini", contextTokens: 400_000, reasoning: false, images: true, pricing: { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 2 } },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextTokens: 1_000_000, reasoning: true, images: true },
    { id: "openai/gpt-5.5", name: "GPT-5.5", contextTokens: 400_000, reasoning: true, images: true },
  ],
  groq: [{ id: "llama-4-70b", name: "Llama 4 70B", contextTokens: 131_072, reasoning: false, images: false }],
  xai: [{ id: "grok-5", name: "Grok 5", contextTokens: 256_000, reasoning: true, images: true }],
  "xai-grok": [{ id: "grok-5", name: "Grok 5", contextTokens: 256_000, reasoning: true, images: true }],
  "kimi-code": [{ id: "kimi-for-coding", name: "Kimi for Coding", contextTokens: 262_144, reasoning: true, images: false }],
  meta: [{ id: "muse-spark", name: "Muse Spark", contextTokens: 200_000, reasoning: true, images: true }],
}

/** The image generators each preset's list names; OpenRouter's answer through chat. */
const IMAGE_MODELS: Readonly<Record<string, readonly { readonly id: string; readonly name?: string; readonly route: "images" | "chat" }[]>> = {
  openai: [{ id: "dall-e-3", route: "images" }, { id: "gpt-image-1", route: "images" }],
  openrouter: [{ id: "google/gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", route: "chat" }, { id: "openai/gpt-5-image", name: "GPT-5 Image", route: "chat" }],
  xai: [{ id: "grok-2-image-1212", route: "images" }],
}

/** Shell variables the preview pretends the login shell has set. */
const SHELL = new Set(["OPENAI_API_KEY", "GROQ_API_KEY"])
export const RAW_CREDENTIAL_KEYS = new Set(["secret", "token", "apikey", "key", "password", "accesstoken", "refreshtoken", "credential"])
export const SYSTEM_NAMESPACES = ["account.", "connection.", "auth."]
/** Read-only questions the system engine also answers, so the providers page can name installed tools, and the git host answers. */
export const SYSTEM_METHODS = new Set(["harness.status", "codehost.list", "codehost.set", "codehost.connect", "codehost.disconnect", "codehost.status", "codehost.remotes", "conversation.peek", "usage.read", "thread.copy", "git.pr.search", "git.pr.teams", "git.pr.view", "git.pr.diff", "git.pr.review.post", "git.pr.merge", "workflow.due", "workflow.upcoming", "connector.setup.list", "connector.setup.save", "connector.setup.remove", "push.vapid", "push.send"])
/** Answered only by the system engine, so one reader keeps tool starts to one at a time. */
export const SYSTEM_ONLY_METHODS = new Set(["conversation.peek", "usage.read", "thread.copy", "push.vapid", "push.send"])
export const CREDENTIAL_NAMESPACES = [...SYSTEM_NAMESPACES, "provider.", "model.", "connector.setup."]
export const MAX_PARAM_NODES = 20_000
export const CALLER_ADDRESS_METHODS = new Set(["provider.select", "provider.discover", "model.discover"])
export const CALLER_ADDRESS_KEYS = ["endpoint", "credentialEnvironment", "allowInsecureRemote", "headers", "accountId"]
const STORED_MODES = new Set(["api-key", "oauth", "device"])
const LOGIN_ID = /^login-[0-9a-f-]{36}$/
const MAX_SECRET_BYTES = 16 * 1024
const LOGIN_TTL_MS = 10 * 60_000
const STATUSES: ReadonlySet<string> = new Set(["unconfigured", "ready", "expired", "refreshing", "error", "revoked"])
/** A key starting with this is treated as refused by the provider, so the failed check can be seen. */
const REJECTED_KEY_PREFIX = "bad"

/** What the preview's plans have used: Claude Code's usual login past the line the scenario asks for, a second account barely. */
export function previewPlan(tool: "claude-code" | "codex", usage: PreviewScenario["usage"], own = false, now = Date.now()): unknown {
  if (tool === "codex") return { type: "plan.limits", source: "codex", plan: "pro", windows: [{ id: "five-hour", usedPercent: own ? 3 : 24, resetsAt: now + 101 * 60_000, windowMinutes: 300 }, { id: "weekly", usedPercent: own ? 11 : 7, resetsAt: now + 4 * 86_400_000, windowMinutes: 10_080 }] }
  const fiveHour = own ? 12 : usage === "full" ? 97 : usage === "high" ? 86 : 62
  return {
    type: "plan.limits",
    source: "claude-code",
    plan: "max",
    windows: [
      { id: "five-hour", usedPercent: fiveHour, resetsAt: now + 38 * 60_000 },
      { id: "weekly", usedPercent: own ? 30 : usage === "out" ? 100 : 18, resetsAt: usage === "out" && !own ? now + 3 * 60 * 60_000 : now + 3 * 86_400_000 },
      { id: "weekly-model", model: "Fable", usedPercent: own ? 9 : 41, resetsAt: now + 3 * 86_400_000 },
    ],
    ...(usage === "out" && !own ? { extraUsage: false } : {}),
  }
}

function refused(message: string): HostError {
  return new HostError("HOST_RPC_REFUSED", message, 403)
}

function invalid(message: string): HostError {
  return new HostError("CONTROL_INVALID_INPUT", message, 400)
}

function namesRawCredential(value: unknown): boolean {
  const stack: unknown[] = [value]
  let seen = 0
  while (stack.length > 0) {
    seen += 1
    if (seen > MAX_PARAM_NODES) return true
    const node = stack.pop()
    if (Array.isArray(node)) stack.push(...(node as unknown[]))
    else if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (RAW_CREDENTIAL_KEYS.has(key.toLowerCase())) return true
        stack.push(child)
      }
    }
  }
  return false
}

/** The same decisions the desktop host makes before a request from the web view reaches an engine. */
export function guardRendererRpc(engineId: string, method: string, params: Params): void {
  if (method === "auth.secret" || method.startsWith("auth.secret.")) throw refused("secrets are set through the connection commands")
  const system = engineId === SYSTEM_ENGINE_ID
  const within = (namespaces: readonly string[]): boolean => namespaces.some((namespace) => method.startsWith(namespace))
  if (system && !within(SYSTEM_NAMESPACES) && !SYSTEM_METHODS.has(method)) throw refused("the system engine only manages connections")
  if (!system && method.startsWith("auth.")) throw refused("sign-in runs on the system engine")
  if (!system && SYSTEM_ONLY_METHODS.has(method)) throw refused("this is answered by the system engine")
  if (!within(CREDENTIAL_NAMESPACES)) return
  if (namesRawCredential(params)) throw refused("raw credentials are not accepted in control requests")
  if (method.startsWith("auth.") && params.input !== undefined) throw refused("sign-in input is sent through its own command")
  if (CALLER_ADDRESS_METHODS.has(method) && CALLER_ADDRESS_KEYS.some((key) => params[key] !== undefined)) throw refused("a provider address is chosen by its connection")
  if (method === "account.create" || method === "account.upsert") {
    const readsShell = params.authMode === "environment" || params.authMode === "api-key-reference" || params.environmentName !== undefined
    if (readsShell && params.baseUrl !== undefined) throw refused("a custom address takes a pasted key, not a shell variable")
  }
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(`${name} is required`)
  return value
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, name, max)
}

function connectionId(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) throw invalid("connection id is invalid")
  return value
}

/** Tools a connection can be added for, the ones that take a key, and the ones that sign in as a second account. */
const TOOLS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", copilot: "GitHub Copilot", pi: "Pi", opencode: "OpenCode", gemini: "Gemini CLI", goose: "Goose" }
const KEY_TOOLS = new Set(["claude-code", "codex", "gemini"])
const SEPARATE_TOOLS = new Set(["claude-code", "codex"])
const LOGINS: Readonly<Record<string, { command: string; args: string[]; variable: string }>> = {
  "claude-code": { command: "claude", args: ["auth", "login", "--claudeai"], variable: "CLAUDE_CONFIG_DIR" },
  codex: { command: "codex", args: ["login", "--device-auth"], variable: "CODEX_HOME" },
}
const MODEL_ID = /^(?!-)[A-Za-z0-9._\-:/@+[\]]{1,256}$/

export class FakeConnections {
  private readonly accounts = new Map<string, FakeAccount>()
  private readonly logins = new Map<string, FakeLogin>()
  private readonly scenario: PreviewScenario
  /** Settings beside each account; an account with none is on with every model. */
  private readonly settings = new Map<string, { enabled: boolean; models?: string[] }>()
  private readonly tools = new Map<string, FakeTool>()
  /** Tool connections whose key is stored, and separate accounts the person signed in to. */
  private readonly toolKeys = new Set<string>()
  private readonly toolSignIns = new Set<string>()
  /** Sign-in terminals: what the tool printed so far, and the line being typed. */
  private readonly toolLogins = new Map<string, { connectionId: string; out: string[]; typed: string; closed: boolean }>()
  private toolLoginCount = 0
  private chosenDefault: { connectionId: string; model: string } | undefined
  private chosenImage: { connectionId: string; model: string; route: "images" | "chat" } | undefined
  private readonly toolStatus: () => unknown

  constructor(scenario: PreviewScenario = {}, toolStatus: () => unknown = () => []) {
    this.scenario = scenario
    this.toolStatus = toolStatus
    const seed = scenario.seed ?? "default"
    if (seed === "empty") return
    this.seed("anthropic", "anthropic", "Anthropic", "api-key", "ready")
    this.seed("openai", "openai", "OpenAI", "environment", "ready", { environmentName: "OPENAI_API_KEY" })
    this.seedTool("claude-code-1", "claude-code", "Claude Code", "subscription", false)
    this.seedTool("codex-1", "codex", "Codex", "subscription", false)
    if (seed !== "mixed") return
    this.seedTool("claude-code-2", "claude-code", "Claude Code (work)", "subscription", true)
    this.seedTool("codex-2", "codex", "Codex key", "api-key", true)
    this.tools.get("codex-1")!.models = ["preview-codex-small"]
    this.seedTool("copilot-1", "copilot", "GitHub Copilot", "subscription", false)
    this.tools.get("copilot-1")!.enabled = false
    this.settings.set("openai", { enabled: false })
    // One connection in every state the list can show.
    this.seed("signin-chatgpt", "openai", "ChatGPT", "oauth", "expired", { statusCode: "SIGN_IN_EXPIRED" })
    this.seed("signin-openrouter", "openrouter", "OpenRouter", "oauth", "refreshing")
    this.seed("groq", "groq", "Groq", "api-key", "error", { statusCode: "AUTH_FAILED" })
    this.seed("mistral", "mistral", "Mistral", "api-key", "unconfigured")
    this.seed("custom", "custom-openai-chat", "Local relay", "api-key", "ready", { baseUrl: "http://127.0.0.1:8080/v1" })
  }

  private seed(id: string, preset: string, label: string, authMode: string, status: Status, extra: { environmentName?: string; baseUrl?: string; statusCode?: string } = {}): void {
    const now = Date.now()
    this.accounts.set(id, {
      reference: {
        accountId: id,
        provider: preset,
        label,
        authMode,
        scopes: [],
        ...(extra.environmentName === undefined ? {} : { environmentName: extra.environmentName }),
        preset,
        ...(extra.baseUrl === undefined ? {} : { baseUrl: extra.baseUrl }),
        createdAt: now,
        updatedAt: now,
      },
      status,
      ...(extra.statusCode === undefined ? {} : { statusCode: extra.statusCode }),
    })
  }

  private seedTool(connectionId: string, tool: string, label: string, authMode: "subscription" | "api-key", separateAccount: boolean): void {
    this.tools.set(connectionId, { connectionId, tool, label, authMode, separateAccount, enabled: true })
  }

  /** True when the preview pretends the system engine cannot start. */
  get offline(): boolean {
    return this.scenario.offline === true
  }

  /** True when this connection can start a thread; the preview engine refuses any other. */
  usable(id: string): boolean {
    return this.accounts.get(id)?.status === "ready" && this.settings.get(id)?.enabled !== false
  }

  /** Why a tool thread cannot start as this connection, as the engine's code, or `undefined`. */
  toolProblem(id: string, backend: string, model: string | undefined): string | undefined {
    const tool = this.tools.get(id)
    if (tool === undefined) return "CONNECTION_NOT_FOUND"
    if (tool.tool !== backend) return "CONNECTION_INVALID"
    if (!tool.enabled) return "CONNECTION_DISABLED"
    if (tool.authMode === "api-key" && !this.toolKeys.has(id)) return "CONNECTION_KEY_MISSING"
    if (model !== undefined && tool.models !== undefined && !tool.models.includes(model)) return "CONNECTION_MODEL_NOT_CHOSEN"
    return undefined
  }

  /** A plan's usage as `usage.read` answers it, refused as the engine refuses. */
  private usage(params: Params): unknown {
    const tool = params.tool
    if (tool !== "claude-code" && tool !== "codex") throw invalid("tool must be claude-code or codex")
    const connection = params.connectionId === undefined ? undefined : this.tool(params.connectionId)
    if (connection !== undefined && connection.tool !== tool) throw new HostError("CONNECTION_INVALID", "the connection is for another tool", 400)
    if (connection?.authMode === "api-key") throw new HostError("USAGE_UNAVAILABLE", "a connection on a key has no plan", 409)
    const status = (this.toolStatus() as { descriptor?: { id?: string }; available?: boolean; signedIn?: boolean }[]).find((entry) => entry.descriptor?.id === tool)
    if (status?.available !== true) throw new HostError("TOOL_UNAVAILABLE", "the tool is not installed", 501)
    const own = connection?.separateAccount === true
    if (own ? !this.toolSignIns.has(connection.connectionId) : status.signedIn === false) throw new HostError("USAGE_UNAVAILABLE", "the tool is not signed in", 409)
    return previewPlan(tool, this.scenario.usage, own)
  }

  private tool(id: unknown): FakeTool {
    const found = this.tools.get(connectionId(id))
    if (found === undefined) throw new HostError("CONNECTION_NOT_FOUND", "no tool connection has this id", 404)
    return found
  }

  private models(value: unknown): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new HostError("CONNECTION_INVALID", "models must be a list", 400)
    if (value.length === 0) throw new HostError("CONNECTION_MODELS_EMPTY", "choose at least one model", 400)
    if (value.length > 256 || value.some((model) => typeof model !== "string" || !MODEL_ID.test(model)) || new Set(value).size !== value.length) throw new HostError("CONNECTION_INVALID", "a model id is invalid or repeated", 400)
    return [...(value as string[])]
  }

  private toolEntry(tool: FakeTool): Params {
    return { kind: "tool", connectionId: tool.connectionId, tool: tool.tool, label: tool.label, authMode: tool.authMode, separateAccount: tool.separateAccount, enabled: tool.enabled, ...(tool.models === undefined ? {} : { models: [...tool.models] }), createdAt: 1, updatedAt: 1 }
  }

  private providerEntry(account: FakeAccount): Params {
    const own = this.settings.get(account.reference.accountId)
    return { kind: "provider", connectionId: account.reference.accountId, provider: account.reference.provider, ...(account.reference.preset === undefined ? {} : { preset: account.reference.preset }), label: account.reference.label, authMode: account.reference.authMode, status: account.status, enabled: own?.enabled ?? true, ...(own?.models === undefined ? {} : { models: [...own.models] }) }
  }

  private enabledOf(id: string): { enabled: boolean; models?: string[] | undefined; usable: boolean } | undefined {
    const tool = this.tools.get(id)
    if (tool !== undefined) return { enabled: tool.enabled, models: tool.models, usable: tool.enabled }
    const account = this.accounts.get(id)
    if (account === undefined) return undefined
    const own = this.settings.get(id)
    const enabled = own?.enabled ?? true
    return { enabled, models: own?.models, usable: enabled && account.status !== "revoked" }
  }

  private listing(enabledOnly: boolean): Params {
    const providers = [...this.accounts.values()].filter((account) => !enabledOnly || (account.status !== "revoked" && this.settings.get(account.reference.accountId)?.enabled !== false)).map((account) => this.providerEntry(account))
    const tools = [...this.tools.values()].filter((tool) => !enabledOnly || tool.enabled).map((tool) => this.toolEntry(tool))
    const chosen = this.chosenDefault
    const state = chosen === undefined ? undefined : this.enabledOf(chosen.connectionId)
    const image = this.chosenImage
    const imageState = image === undefined ? undefined : this.enabledOf(image.connectionId)
    return { connections: [...providers, ...tools], ...(chosen === undefined ? {} : { default: { ...chosen, usable: state?.usable === true } }), ...(image === undefined ? {} : { image: { ...image, usable: imageState?.usable === true } }) }
  }

  private account(id: unknown): FakeAccount {
    const found = this.accounts.get(connectionId(id))
    if (found === undefined) throw new HostError("CONTROL_ACCOUNT_NOT_FOUND", "account was not found", 404)
    return found
  }

  private login(id: unknown): FakeLogin {
    if (typeof id !== "string" || !LOGIN_ID.test(id)) throw invalid("loginId is invalid")
    const found = this.logins.get(id)
    if (found === undefined) throw new HostError("AUTH_LOGIN_NOT_FOUND", "sign-in was not found", 404)
    return found
  }

  private copy(account: FakeAccount): Params {
    return { reference: { ...account.reference, scopes: [...account.reference.scopes] }, status: account.status, ...(account.statusCode === undefined ? {} : { statusCode: account.statusCode }) }
  }

  private snapshot(login: FakeLogin, afterSeq = 0): Params {
    return {
      loginId: login.loginId,
      flow: login.flow,
      preset: login.preset,
      accountId: login.accountId,
      state: login.state,
      ...(login.code === undefined ? {} : { code: login.code }),
      acceptsInput: login.acceptsInput && login.state === "waiting",
      events: login.events.filter((event) => (event.seq as number) > afterSeq),
      lastSeq: login.events.length,
      startedAt: login.startedAt,
      expiresAt: login.expiresAt,
    }
  }

  private push(login: FakeLogin, event: Params): void {
    login.events.push({ seq: login.events.length + 1, at: Date.now(), ...event })
  }

  private upsert(params: Params): Params {
    const id = connectionId(params.accountId)
    const existing = this.accounts.get(id)
    const authMode = text(params.authMode, "authMode", 64)
    const preset = optionalText(params.preset, "preset", 128)
    const baseUrl = optionalText(params.baseUrl, "baseUrl", 2_048)
    const environmentName = optionalText(params.environmentName, "environmentName", 128)
    if (existing !== undefined && existing.status !== "revoked" && (existing.reference.authMode !== authMode || existing.reference.preset !== preset || existing.reference.baseUrl !== baseUrl)) {
      throw new HostError("CONTROL_ACCOUNT_ENDPOINT_LOCKED", "an existing connection keeps its address and sign-in method", 409)
    }
    const provider = text(params.provider, "provider", 128)
    const label = text(params.label, "label", 160)
    // A plan address takes only what its sign-in stores, as in the engine.
    if (authMode !== "oauth" && authMode !== "device" && PRESETS.some((row) => row.id === (preset ?? provider) && row.signInOnly === true)) {
      throw new HostError("CONTROL_ACCOUNT_SIGN_IN_ONLY", "this provider is reached through its sign-in", 400)
    }
    // A shell variable that belongs to one provider is never sent to another one's address.
    const owner = environmentName === undefined ? undefined : PRESETS.find((entry) => entry.environment === environmentName)
    if (owner !== undefined && owner.id !== (preset ?? provider)) throw new HostError("PROVIDER_ENDPOINT_DENIED", "that shell variable belongs to another provider", 403)
    if (params.status !== undefined && (typeof params.status !== "string" || !STATUSES.has(params.status))) throw invalid("status is invalid")
    const now = Date.now()
    // A stored key or sign-in arrives separately and owns the state; a shell variable's state is the caller's.
    const kept = existing !== undefined && existing.status !== "revoked" ? existing.status : "unconfigured"
    const status = STORED_MODES.has(authMode) ? kept : ((params.status as Status | undefined) ?? "unconfigured")
    const account: FakeAccount = {
      ...(existing?.rejected === true ? { rejected: true } : {}),
      reference: {
        accountId: id,
        provider,
        label,
        authMode,
        scopes: [],
        ...(environmentName === undefined ? {} : { environmentName }),
        ...(preset === undefined ? {} : { preset }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        createdAt: existing?.reference.createdAt ?? now,
        updatedAt: now,
      },
      status,
      ...(STORED_MODES.has(authMode) && existing?.statusCode !== undefined && existing.status !== "revoked" ? { statusCode: existing.statusCode } : {}),
    }
    this.accounts.set(id, account)
    return this.copy(account)
  }

  private finish(login: FakeLogin): void {
    if (login.state !== "waiting") return
    login.state = "done"
    const now = Date.now()
    const existing = this.accounts.get(login.accountId)
    this.accounts.set(login.accountId, {
      reference: { accountId: login.accountId, provider: login.preset, label: existing?.reference.label ?? login.label, authMode: login.authMode, scopes: [], preset: login.preset, createdAt: existing?.reference.createdAt ?? now, updatedAt: now },
      status: "ready",
    })
    this.push(login, { type: "finishing" })
    this.push(login, { type: "done", accountId: login.accountId })
  }

  private fail(login: FakeLogin, code: string, state: "failed" | "cancelled" = "failed"): void {
    if (login.state !== "waiting") return
    login.state = state
    login.code = code
    this.push(login, { type: "failed", code })
  }

  async rpc(method: string, params: Params): Promise<unknown> {
    switch (method) {
      case "account.list":
        return [...this.accounts.values()].filter((account) => params.provider === undefined || account.reference.provider === params.provider).map((account) => this.copy(account))
      case "account.get":
      case "account.status":
      case "account.select":
        return this.copy(this.account(params.accountId))
      case "account.create":
      case "account.upsert":
        return this.upsert(params)
      case "account.revoke": {
        const account = this.account(params.accountId)
        account.status = "revoked"
        account.statusCode = "ACCOUNT_REVOKED"
        return this.copy(account)
      }
      case "account.remove": {
        const account = this.account(params.accountId)
        this.accounts.delete(account.reference.accountId)
        this.settings.delete(account.reference.accountId)
        if (this.chosenDefault?.connectionId === account.reference.accountId) this.chosenDefault = undefined
        if (this.chosenImage?.connectionId === account.reference.accountId) this.chosenImage = undefined
        for (const login of this.logins.values()) if (login.accountId === account.reference.accountId) this.fail(login, "AUTH_CANCELLED", "cancelled")
        return { removed: true, accountId: account.reference.accountId }
      }
      case "connection.list":
        if (params.enabledOnly !== undefined && typeof params.enabledOnly !== "boolean") throw invalid("enabledOnly is invalid")
        return this.listing(params.enabledOnly === true)
      case "connection.update": {
        const id = connectionId(params.connectionId)
        const tool = this.tools.get(id)
        const account = this.accounts.get(id)
        if (tool === undefined && account === undefined) throw new HostError("CONNECTION_NOT_FOUND", "no connection has this id", 404)
        if (params.enabled !== undefined && typeof params.enabled !== "boolean") throw invalid("enabled is invalid")
        const models = params.models === null ? null : this.models(params.models)
        const label = optionalText(params.label, "label", 160)
        if (tool !== undefined) {
          if (params.enabled !== undefined) tool.enabled = params.enabled as boolean
          if (models !== undefined) tool.models = models ?? undefined
          if (label !== undefined) tool.label = label
          if (models !== undefined && models !== null && this.chosenDefault?.connectionId === id && !models.includes(this.chosenDefault.model)) this.chosenDefault = { connectionId: id, model: models[0]! }
          return this.toolEntry(tool)
        }
        const own = { ...(this.settings.get(id) ?? { enabled: true }) }
        if (params.enabled !== undefined) own.enabled = params.enabled as boolean
        if (models !== undefined) own.models = models ?? undefined
        this.settings.set(id, own)
        if (label !== undefined) account!.reference.label = label
        if (models !== undefined && models !== null && this.chosenDefault?.connectionId === id && !models.includes(this.chosenDefault.model)) this.chosenDefault = { connectionId: id, model: models[0]! }
        return this.providerEntry(account!)
      }
      case "connection.setDefault": {
        if (params.connectionId === null) {
          this.chosenDefault = undefined
          return { default: null }
        }
        const id = connectionId(params.connectionId)
        const model = text(params.model, "model", 256)
        const state = this.enabledOf(id)
        if (state === undefined) throw new HostError("CONNECTION_NOT_FOUND", "no connection has this id", 404)
        if (!state.usable) throw new HostError("CONNECTION_DISABLED", "connection is turned off", 409)
        if (state.models !== undefined && !state.models.includes(model)) throw new HostError("CONNECTION_MODEL_NOT_CHOSEN", "model is not one of the connection's models", 400)
        this.chosenDefault = { connectionId: id, model }
        return { default: { ...this.chosenDefault, usable: true } }
      }
      case "connection.setImageModel": {
        if (params.connectionId === null) {
          this.chosenImage = undefined
          return { image: null }
        }
        const account = this.account(params.connectionId)
        const model = text(params.model, "model", 256)
        const presetId = account.reference.preset ?? account.reference.provider
        if (this.problem(account) !== undefined) throw new HostError("CONTROL_CONNECTION_CHECK_FAILED", "the connection's model list could not be read", 409)
        const listed = (IMAGE_MODELS[presetId] ?? []).find((entry) => entry.id === model)
        if (listed === undefined) throw new HostError("CONNECTION_MODEL_NOT_CHOSEN", "the connection does not list this image model", 400)
        if (this.enabledOf(account.reference.accountId)?.usable !== true) throw new HostError("CONNECTION_DISABLED", "connection is turned off", 409)
        this.chosenImage = { connectionId: account.reference.accountId, model, route: listed.route }
        return { image: this.chosenImage }
      }
      case "connection.addTool": {
        const tool = text(params.tool, "tool", 64)
        if (TOOLS[tool] === undefined) throw new HostError("CONNECTION_INVALID", "tool is unknown", 400)
        const authMode = params.authMode ?? "subscription"
        if (authMode !== "subscription" && authMode !== "api-key") throw new HostError("CONNECTION_INVALID", "tool connection auth mode is invalid", 400)
        if (params.separateAccount !== undefined && typeof params.separateAccount !== "boolean") throw invalid("separateAccount is invalid")
        if (authMode === "api-key" && !KEY_TOOLS.has(tool)) throw new HostError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs in only with its own login", 400)
        if (params.separateAccount === true && authMode === "subscription" && !SEPARATE_TOOLS.has(tool)) throw new HostError("CONNECTION_AUTH_UNSUPPORTED", "this tool cannot sign in as a separate account", 400)
        const models = this.models(params.models)
        let index = 1
        while (this.tools.has(`${tool}-${String(index)}`)) index += 1
        const id = `${tool}-${String(index)}`
        const same = [...this.tools.values()].filter((entry) => entry.tool === tool).length
        const label = optionalText(params.label, "label", 160) ?? (same === 0 ? TOOLS[tool]! : `${TOOLS[tool]!} ${String(same + 1)}`)
        const added: FakeTool = { connectionId: id, tool, label, authMode, separateAccount: authMode === "api-key" || params.separateAccount === true, enabled: true, ...(models === undefined ? {} : { models }) }
        this.tools.set(id, added)
        return this.toolEntry(added)
      }
      case "connection.removeTool": {
        const tool = this.tool(params.connectionId)
        this.tools.delete(tool.connectionId)
        // Runrail's copy of the key goes with it; the tool's own sign-in does not.
        this.toolKeys.delete(tool.connectionId)
        if (this.chosenDefault?.connectionId === tool.connectionId) this.chosenDefault = undefined
        return { removed: true, connectionId: tool.connectionId }
      }
      case "connection.status": {
        const tool = this.tool(params.connectionId)
        const base = { connectionId: tool.connectionId, tool: tool.tool, authMode: tool.authMode, separateAccount: tool.separateAccount, enabled: tool.enabled }
        if (tool.authMode === "api-key") return { ...base, keyStored: this.toolKeys.has(tool.connectionId) }
        const status = (this.toolStatus() as { descriptor?: { id?: string }; available?: boolean; version?: string; signedIn?: boolean }[]).find((entry) => entry.descriptor?.id === tool.tool)
        const signedIn = tool.separateAccount ? this.toolSignIns.has(tool.connectionId) : status?.signedIn
        return { ...base, installed: status?.available === true, ...(status?.version === undefined ? {} : { version: status.version }), ...(signedIn === undefined ? {} : { signedIn }) }
      }
      case "connection.loginCommand": {
        const tool = this.tool(params.connectionId)
        const login = LOGINS[tool.tool]
        if (login === undefined || tool.authMode !== "subscription") throw new HostError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs in from its own interface", 400)
        return { connectionId: tool.connectionId, command: login.command, args: login.args, env: tool.separateAccount ? { [login.variable]: `/preview/accounts/tool-homes/${tool.connectionId}` } : {} }
      }
      case "connection.loginStart": {
        const tool = this.tool(params.connectionId)
        const login = LOGINS[tool.tool]
        if (login === undefined || tool.authMode !== "subscription") throw new HostError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs in from its own interface", 400)
        for (const [id, running] of this.toolLogins) if (running.connectionId === tool.connectionId) this.toolLogins.delete(id)
        this.toolLoginCount += 1
        const loginId = `login-${this.toolLoginCount}`
        // A preview stand-in for the tool's own screen: an address, then a prompt for the code.
        const page = tool.tool === "codex" ? "Open https://auth.openai.com/codex/device and enter this code: PREV-1EW0\r\n" : "Opening your browser to sign in…\r\nhttps://claude.ai/oauth/authorize?code=true&preview=1\r\n\r\nPaste code here if prompted > "
        this.toolLogins.set(loginId, { connectionId: tool.connectionId, out: [`${login.command} ${login.args.join(" ")}\r\n`, page], typed: "", closed: false })
        return { connectionId: tool.connectionId, loginId }
      }
      case "connection.loginRead": {
        const login = this.toolLogin(params.loginId)
        const afterSeq = typeof params.afterSeq === "number" ? params.afterSeq : 0
        const chunks = login.out.map((data, index) => ({ seq: index + 1, data })).filter((chunk) => chunk.seq > afterSeq)
        return { chunks, nextSeq: login.out.length, closed: login.closed }
      }
      case "connection.loginWrite": {
        const login = this.toolLogin(params.loginId)
        if (typeof params.data !== "string" || params.data.length > 8_192) throw invalid("data is invalid")
        if (login.closed) throw new HostError("TOOL_LOGIN_NOT_FOUND", "this sign-in has ended", 404)
        for (const char of params.data) {
          if (char === "\r") {
            login.out.push("\r\nLogin successful.\r\n")
            login.closed = true
            this.finishToolSignIn(login.connectionId)
            break
          }
          login.typed += char
          login.out.push(char)
        }
        return { acceptedBytes: params.data.length }
      }
      case "connection.loginClose": {
        const loginId = this.toolLoginId(params.loginId)
        this.toolLogins.delete(loginId)
        return { loginId, closed: true }
      }
      case "connection.vendorSignOut": {
        const tool = this.tool(params.connectionId)
        if (params.confirm !== true) throw invalid("confirm must be true")
        if (LOGINS[tool.tool] === undefined || tool.authMode !== "subscription") throw new HostError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs out from its own interface", 400)
        this.toolSignIns.delete(tool.connectionId)
        return { connectionId: tool.connectionId, signedOut: true }
      }
      case "harness.status":
        return this.toolStatus()
      case "usage.read":
        return { plan: this.usage(params) }
      case "connection.presets":
        return { presets: PRESETS, custom: CUSTOM }
      case "connection.detect": {
        const used = new Set([...this.accounts.values()].filter((account) => account.status !== "revoked" && account.reference.authMode === "environment").map((account) => account.reference.preset))
        return { detected: PRESETS.flatMap((preset) => (preset.environment !== undefined && SHELL.has(preset.environment) && !used.has(preset.id) ? [{ presetId: preset.id, name: preset.name, environmentName: preset.environment }] : [])) }
      }
      case "connection.importable":
        return {
          candidates: [
            { source: "codex", id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "preset", presetId: "openrouter", environmentName: "OPENROUTER_API_KEY", environmentSet: SHELL.has("OPENROUTER_API_KEY"), models: ["anthropic/claude-sonnet-5-5"] },
            { source: "pi", id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", kind: "local", models: ["qwen3-coder"] },
            { source: "opencode", id: "relay", name: "Team relay", baseUrl: "https://relay.example.com/v1", kind: "remote", models: [] },
          ],
        }
      case "connection.models": {
        const account = this.account(params.connectionId)
        const presetId = account.reference.preset ?? account.reference.provider
        const problem = this.problem(account)
        // A custom address has no list to read; the user types a model id.
        const listed = problem === undefined ? (MODELS[presetId] ?? []) : []
        return {
          connectionId: account.reference.accountId,
          presetId,
          models: listed.map((model) => ({ ...model, source: "live" })),
          images: problem === undefined ? (IMAGE_MODELS[presetId] ?? []) : [],
          live: problem === undefined ? (listed.length > 0 ? { ok: true, code: "OK" } : { ok: false, code: "NO_MODEL_LIST" }) : { ok: false, code: problem },
          manualEntry: true,
        }
      }
      case "connection.test": {
        const account = this.account(params.connectionId)
        const presetId = account.reference.preset ?? account.reference.provider
        const count = MODELS[presetId]?.length
        const base = { connectionId: account.reference.accountId, checkedAt: Date.now() }
        const problem = this.problem(account)
        if (problem !== undefined) return { ...base, status: "failed", code: problem }
        return count === undefined ? { ...base, status: "unverified", code: "NO_MODEL_LIST" } : { ...base, status: "ok", code: "OK", modelCount: count }
      }
      case "auth.flows":
        return FLOWS
      case "auth.login.start": {
        const flow = FLOWS.find((entry) => entry.id === params.flow)
        if (flow === undefined) throw new HostError("AUTH_FLOW_UNKNOWN", "sign-in is not available", 404)
        const accountId = params.accountId === undefined ? `signin-${flow.id}` : connectionId(params.accountId)
        const target = this.accounts.get(accountId)
        // Checked before anyone is sent to the vendor's page: the result must fit the connection.
        if (target !== undefined && target.status !== "revoked" && (target.reference.authMode !== flow.authMode || (target.reference.preset ?? target.reference.provider) !== flow.preset)) {
          throw new HostError("AUTH_ACCOUNT_MISMATCH", "that connection cannot hold this sign-in", 409)
        }
        // One sign-in per flow: a new one replaces the one still waiting.
        for (const other of this.logins.values()) if (other.flow === flow.id) this.fail(other, "AUTH_CANCELLED", "cancelled")
        const startedAt = Date.now()
        const login: FakeLogin = {
          loginId: `login-${crypto.randomUUID()}`,
          flow: flow.id,
          preset: flow.preset,
          accountId,
          label: typeof params.label === "string" && params.label.length > 0 ? params.label.slice(0, 160) : flow.label,
          authMode: flow.authMode,
          state: "waiting",
          // A device code is typed on the vendor's page; there is nothing to paste back.
          acceptsInput: flow.kind === "browser",
          events: [],
          startedAt,
          expiresAt: startedAt + LOGIN_TTL_MS,
        }
        // Placeholder addresses on the flow's own host; the preview never opens them.
        const page = `https://${flow.browserHosts[0] ?? "example.invalid"}/preview`
        if (flow.kind === "device-code") this.push(login, { type: "device-code", userCode: "WDJB-MJHT", verificationUrl: page, expiresAt: login.expiresAt })
        else if (this.scenario.signIn === "port-busy") this.push(login, { type: "open-url", url: page, redirect: "manual", notice: "AUTH_PORT_BUSY" })
        else this.push(login, { type: "open-url", url: page, redirect: "loopback" })
        this.push(login, { type: "waiting" })
        this.logins.set(login.loginId, login)
        return this.snapshot(login)
      }
      case "auth.login.status": {
        const login = this.login(params.loginId)
        const afterSeq = typeof params.afterSeq === "number" ? params.afterSeq : 0
        const waitMs = typeof params.waitMs === "number" ? Math.min(Math.max(params.waitMs, 0), 400) : 0
        if (login.events.length <= afterSeq && login.state === "waiting" && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
        return this.snapshot(login, afterSeq)
      }
      case "auth.login.cancel": {
        const login = this.login(params.loginId)
        this.fail(login, "AUTH_CANCELLED", "cancelled")
        return this.snapshot(login)
      }
      case "auth.logout": {
        const account = this.account(params.accountId)
        if (account.status === "revoked") throw new HostError("CONTROL_ACCOUNT_REVOKED", "account is revoked", 409)
        if (!STORED_MODES.has(account.reference.authMode)) throw invalid("account keeps no stored credential")
        account.status = "unconfigured"
        account.statusCode = "SIGNED_OUT"
        delete account.rejected
        return this.copy(account)
      }
      default:
        throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
    }
  }

  /** Marks the connection usable and drops the value: the preview keeps no key. */
  setSecret(id: string, secret: string, target: "account" | "tool" = "account"): unknown {
    const trimmed = secret.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_SECRET_BYTES || /[\r\n]/.test(trimmed)) throw new HostError("CONNECTION_SECRET_INVALID", "key must be one non-empty line", 400)
    if (target === "tool") {
      const tool = this.tool(id)
      if (tool.authMode !== "api-key") throw invalid("this connection does not take a pasted key")
      this.toolKeys.add(tool.connectionId)
      return { connectionId: tool.connectionId }
    }
    const account = this.account(id)
    if (account.status === "revoked") throw new HostError("CONTROL_ACCOUNT_REVOKED", "account is revoked", 409)
    if (account.reference.authMode !== "api-key") throw invalid("this connection does not take a pasted key")
    account.status = "ready"
    delete account.statusCode
    if (trimmed.startsWith(REJECTED_KEY_PREFIX)) account.rejected = true
    else delete account.rejected
    account.reference.updatedAt = Date.now()
    return this.copy(account)
  }

  /** Why a live request through this connection would fail, as the stable code, or `undefined`. */
  private problem(account: FakeAccount): string | undefined {
    if (account.status === "expired") return "SIGN_IN_EXPIRED"
    if (account.status === "error") return account.statusCode ?? "AUTH_FAILED"
    if (account.status !== "ready") return "CREDENTIAL_MISSING"
    return account.rejected === true ? "AUTH_FAILED" : undefined
  }

  private toolLoginId(value: unknown): string {
    if (typeof value !== "string" || !this.toolLogins.has(value)) throw new HostError("TOOL_LOGIN_NOT_FOUND", "this sign-in is not running", 404)
    return value
  }

  private toolLogin(value: unknown): { connectionId: string; out: string[]; typed: string; closed: boolean } {
    return this.toolLogins.get(this.toolLoginId(value))!
  }

  /** Stands in for the person finishing the tool's own sign-in in a terminal. */
  finishToolSignIn(id: string): void {
    const tool = this.tools.get(id)
    if (tool?.separateAccount === true && tool.authMode === "subscription") this.toolSignIns.add(id)
  }

  /** Stands in for the browser round trip: the sign-in completes shortly after it is "opened". */
  open(loginId: string): void {
    const login = this.login(loginId)
    if (login.state !== "waiting") throw new HostError("AUTH_URL_UNAVAILABLE", "this sign-in has no page to open", 409)
    const outcome = this.scenario.signIn ?? "ok"
    // With the callback port taken the browser cannot report back; only a pasted address finishes it.
    if (outcome === "never" || (outcome === "port-busy" && login.acceptsInput)) return
    setTimeout(() => (outcome === "denied" ? this.fail(login, "AUTH_DENIED") : this.finish(login)), this.scenario.signInDelayMs ?? 1_200)
  }

  submitInput(loginId: string, input: string): unknown {
    const login = this.login(loginId)
    if (login.state !== "waiting") throw new HostError("AUTH_LOGIN_FINISHED", "sign-in already finished", 409)
    if (!login.acceptsInput) throw new HostError("AUTH_INVALID", "this sign-in takes no pasted answer", 400)
    // The engine reads the address a person landed on; anything else is refused and the sign-in keeps waiting.
    if (input.trim().length === 0 || input.length > 8_192 || !/[?&]code=/.test(input)) throw new HostError("AUTH_INPUT_INVALID", "paste the address you were sent to", 400)
    this.finish(login)
    return this.snapshot(login)
  }
}
