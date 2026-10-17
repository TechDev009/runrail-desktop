import type { Connection, ConnectionCheck } from "../../app/connections"
import { words as currentWords, type PlatformWords } from "../../app/platformWords"
import type { ToolConnection, ToolId, ToolStatus } from "../../app/connectionSettings"
import { BACKEND_LABELS } from "../../app/persist"
import type { ConnectionPreset, SignInFlow } from "../../protocol/schemas"

/**
 * Words for the connection screens. Everything here is plain data in, plain text out, so each
 * state a connection can be in has one wording, used by the list, the dialog, and the palette.
 */

export type StatusTone = "ok" | "busy" | "warn" | "fail" | "off"

export interface ConnectionStatusText {
  readonly tone: StatusTone
  /** One of: Ready, Signing in, Expired, Failed, Off. */
  readonly label: string
  /** What is wrong and what to do about it; absent when nothing needs saying. */
  readonly hint?: string
}

/** Problems that mean the stored key or sign-in itself is no good, not that the network hiccuped. */
const REFUSED: ReadonlySet<string> = new Set(["AUTH_FAILED", "SIGN_IN_FAILED", "SIGN_IN_EXPIRED", "CREDENTIAL_MISSING", "ENDPOINT_DENIED"])

const PROBLEMS: Readonly<Record<string, string>> = {
  AUTH_FAILED: "The provider refused the key.",
  SIGN_IN_EXPIRED: "The sign-in ran out.",
  SIGN_IN_FAILED: "The sign-in could not be renewed.",
  CREDENTIAL_MISSING: "Nothing is stored for it.",
  ENDPOINT_DENIED: "The address is not allowed.",
  TIMEOUT: "The provider did not answer in time.",
  RATE_LIMITED: "The provider is limiting requests right now.",
  INVALID_RESPONSE: "The provider's answer could not be read.",
  SIGNED_OUT: "Signed out.",
  ENGINE_NOT_RUNNING: "The Runrail engine is not running.",
  CONTROL_START_FAILED: "The Runrail engine did not start.",
}

/** True when the key or sign-in itself was turned down, so trying the same one again cannot help. */
export function isRefusal(code: string): boolean {
  return REFUSED.has(code)
}

/** A stable code as a sentence, with the code kept for support. */
export function problemText(code: string | undefined, fallback = "It cannot be used right now."): string {
  if (code === undefined) return fallback
  return `${PROBLEMS[code] ?? fallback} (${code})`
}

export function isSignIn(connection: Pick<Connection, "authMode">): boolean {
  return connection.authMode === "oauth" || connection.authMode === "device"
}

export function isKey(connection: Pick<Connection, "authMode">): boolean {
  return connection.authMode === "api-key"
}

/** How a connection reaches its models, in the user's words. */
export function connectionRoute(connection: Connection): string {
  if (isKey(connection)) return connection.baseUrl === undefined ? "API key" : `API key · ${addressHost(connection.baseUrl)}`
  if (isSignIn(connection)) return "Subscription sign-in"
  if (connection.environmentName !== undefined) return `Shell variable ${connection.environmentName}`
  return "Set up outside the app"
}

function addressHost(address: string): string {
  try {
    return new URL(address).host
  } catch {
    return "custom address"
  }
}

/** Whether a thread can use the connection, and the next step when it cannot. */
export function connectionStatus(connection: Connection, listError?: string): ConnectionStatusText {
  switch (connection.status) {
    case "ready":
      if (listError === undefined) return { tone: "ok", label: "Ready" }
      if (REFUSED.has(listError)) return { tone: "fail", label: "Failed", hint: problemText(listError) }
      return { tone: "ok", label: "Ready", hint: `Its model list could not be loaded. ${problemText(listError, "Try again in a moment.")}` }
    case "refreshing":
      return { tone: "busy", label: "Signing in", hint: "Renewing the sign-in." }
    case "expired":
      return { tone: "warn", label: "Expired", hint: "The sign-in ran out. Sign in again to keep using it." }
    case "unconfigured":
      if (isKey(connection)) return { tone: "off", label: "Off", hint: "No key is stored. Add one to use it." }
      if (isSignIn(connection)) return { tone: "off", label: "Off", hint: "Signed out. Sign in to use it." }
      if (connection.environmentName !== undefined) return { tone: "off", label: "Off", hint: `Set ${connection.environmentName} in your shell profile, then restart Runrail.` }
      return { tone: "off", label: "Off", hint: "It is not set up yet." }
    default:
      return { tone: "fail", label: "Failed", hint: problemText(connection.statusCode) }
  }
}

export interface ConnectionFix {
  readonly kind: "key" | "sign-in"
  readonly label: string
  /** True when the connection does not work until this is done. */
  readonly needed: boolean
}

/** The one action that repairs or refreshes a connection's way in, if it has one. */
export function connectionFix(connection: Connection, listError?: string): ConnectionFix | undefined {
  const tone = connectionStatus(connection, listError).tone
  const needed = tone === "off" || tone === "fail" || tone === "warn"
  if (isKey(connection)) return { kind: "key", label: connection.status === "unconfigured" ? "Add key" : "Replace key", needed }
  if (isSignIn(connection)) return { kind: "sign-in", label: connection.status === "unconfigured" ? "Sign in" : "Sign in again", needed }
  return undefined
}

/** The sign-in that produced a connection, so it can be run again for the same account. */
export function flowFor(connection: Connection, flows: readonly SignInFlow[]): SignInFlow | undefined {
  if (!isSignIn(connection)) return undefined
  const byId = flows.find((flow) => connection.id === `signin-${flow.id}` || connection.id.startsWith(`signin-${flow.id}-`))
  return byId ?? flows.find((flow) => flow.preset === connection.presetId && (flow.authMode === undefined || flow.authMode === connection.authMode))
}

/** Connections a sign-in already produced. */
export function accountsOf(flow: SignInFlow, connections: readonly Connection[], flows: readonly SignInFlow[]): Connection[] {
  return connections.filter((connection) => flowFor(connection, flows)?.id === flow.id)
}

/** What a live check found, as one line. */
export function checkText(check: ConnectionCheck): { readonly tone: StatusTone; readonly text: string } {
  if (check.status === "ok") return { tone: "ok", text: check.modelCount === undefined ? "It works." : `It works. ${countText(check.modelCount, "model")}.` }
  if (check.status === "unverified") return { tone: "ok", text: "Saved. This provider has no model list, so it is checked when you send the first message." }
  return { tone: "fail", text: problemText(check.code, "The check failed.") }
}

export function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

const KEY_PROBLEMS = {
  empty: "Paste the key first.",
  lines: "A key is one line. Paste only the key itself.",
  long: "That is too long to be a key.",
} as const

export function keyProblemText(problem: keyof typeof KEY_PROBLEMS): string {
  return KEY_PROBLEMS[problem]
}

const ADDRESS_PROBLEMS = {
  empty: "Enter the address of the endpoint.",
  invalid: "That is not an address. It looks like https://host/v1.",
  scheme: "The address must start with https:// or http://.",
  credentials: "Leave user names, passwords, and # parts out of the address.",
  plain: "Use https:// for an address outside this computer or your local network.",
} as const

export function addressProblemText(problem: keyof typeof ADDRESS_PROBLEMS): string {
  return ADDRESS_PROBLEMS[problem]
}

/** Why a key could not be stored or a connection made, in words. */
const SAVE_PROBLEMS: Readonly<Record<string, string>> = {
  CONNECTION_SECRET_INVALID: "That does not look like a key: it must be one line of text.",
  CLIPBOARD_UNAVAILABLE: "The clipboard could not be read. Type or paste the key instead.",
  CLIPBOARD_UNSUPPORTED: "Reading the clipboard is not available on this system. Paste the key instead.",
  CONTROL_INVALID_INPUT: "The engine did not accept those details.",
  CONTROL_ACCOUNT_ENDPOINT_LOCKED: "A connection keeps its address. Add a new connection for another address.",
  CONTROL_ACCOUNT_SIGN_IN_ONLY: "This plan connects by signing in. For a pasted key, use the provider's key connection.",
  CONTROL_ACCOUNT_NOT_FOUND: "That connection no longer exists.",
  PROVIDER_ENDPOINT_DENIED: "That address is not allowed.",
  HOST_RPC_REFUSED: "The app refused that request.",
  CONNECTION_LIMIT: "There are too many connections of this kind. Remove one first.",
  CONNECTION_LABEL_INVALID: "A name is 1 to 160 characters.",
  CONNECTION_MODELS_EMPTY: "Choose at least one model.",
  CONNECTION_INVALID: "The engine did not accept that: a model id may be malformed or listed twice.",
  CONNECTION_MODEL_NOT_CHOSEN: "That model is not one of the connection's models.",
  CONTROL_CONNECTION_CHECK_FAILED: "The provider's model list could not be read just now. Check the connection, then try again.",
  CONNECTION_DISABLED: "That connection is turned off. Turn it on first.",
  CONNECTION_NOT_FOUND: "That connection no longer exists.",
  CONNECTION_AUTH_UNSUPPORTED: "This tool cannot sign in that way.",
  CONNECTION_KEY_MISSING: "No key is stored for this connection yet.",
  CONNECTION_STORE_BUSY: "The settings were busy. Try again in a moment.",
  CONNECTION_EXISTS: "A connection with that id already exists.",
  ENGINE_NOT_RUNNING: "The Runrail engine is not running. Try again in a moment.",
  CONTROL_START_FAILED: "The Runrail engine did not start.",
}

/** Why the sign-in terminal could not run, by the engine's stable code. */
export function loginProblemText(code: string, name: string): string {
  if (code === "TOOL_LOGIN_TOOL_MISSING") return `${name} was not found on this computer. Install it, then try again.`
  if (code === "TOOL_LOGIN_LIMIT") return "Too many sign-ins are open. Close the others, then try again."
  if (code === "TOOL_LOGIN_UNAVAILABLE") return "The sign-in cannot run inside the app on this computer. Run the command below in your own terminal."
  return saveProblemText(code)
}

export function saveProblemText(code: string): string {
  return `${SAVE_PROBLEMS[code] ?? "That did not work."} (${code})`
}

export interface SignInProblem {
  readonly title: string
  /** The plain next step. */
  readonly next: string
  /** False when trying the same thing again cannot help. */
  readonly retry: boolean
}

const SIGN_IN_PROBLEMS: Readonly<Record<string, SignInProblem>> = {
  AUTH_CANCELLED: { title: "Sign-in cancelled", next: "Nothing was stored. Start again when you are ready.", retry: true },
  AUTH_TIMEOUT: { title: "The sign-in took too long", next: "It waits about ten minutes. Start again and finish in the browser.", retry: true },
  AUTH_EXPIRED: { title: "The sign-in ran out", next: "The code or page is no longer valid. Start again to get a new one.", retry: true },
  AUTH_DENIED: { title: "Access was not granted", next: "The provider's page reported that access was declined. Start again and choose Allow, or check that the plan on that account includes this.", retry: true },
  AUTH_STATE_MISMATCH: { title: "The answer did not match this sign-in", next: "It came from an older attempt or another window. Start again and use the page that opens.", retry: true },
  AUTH_INPUT_INVALID: { title: "That address could not be used", next: "Copy the whole address from the browser's address bar after signing in, then paste it.", retry: true },
  AUTH_CODE_REJECTED: { title: "The provider refused the sign-in", next: "Start again. If it keeps happening, check that the account has an active plan.", retry: true },
  AUTH_SCOPE_MISSING: { title: "The account lacks the access this needs", next: "The plan on that account does not include this kind of use. Sign in with another account, or connect with an API key.", retry: false },
  AUTH_RESPONSE_INVALID: { title: "The provider's answer could not be read", next: "Try again in a moment. If it keeps happening, connect with an API key instead.", retry: true },
  AUTH_NETWORK: { title: "The provider could not be reached", next: "Check the network connection, then try again.", retry: true },
  AUTH_STORE_FAILED: { title: "The sign-in could not be saved", next: "The keychain refused the write. Unlock it, then try again.", retry: true },
  AUTH_ACCOUNT_MISMATCH: { title: "That connection cannot hold this sign-in", next: "It belongs to another provider or another way in. Add a new connection instead.", retry: false },
  AUTH_FLOW_UNKNOWN: { title: "This sign-in is not available", next: "This build of the engine does not offer it. Connect with an API key instead.", retry: false },
  AUTH_UNAVAILABLE: { title: "This sign-in is not available", next: "Connect with an API key instead.", retry: false },
  AUTH_LIMIT: { title: "Too many sign-ins are open", next: "Finish or cancel the others, then try again.", retry: true },
  AUTH_URL_REFUSED: { title: "The sign-in page was not opened", next: "Its address did not belong to the provider, so the app refused to open it. Nothing was sent.", retry: false },
  ENGINE_NOT_RUNNING: { title: "The engine is not running", next: "Try again in a moment.", retry: true },
  CONTROL_START_FAILED: { title: "The engine did not start", next: "Try again. If it keeps failing, restart Runrail.", retry: true },
}

export function signInProblem(code: string | undefined): SignInProblem {
  return (code === undefined ? undefined : SIGN_IN_PROBLEMS[code]) ?? { title: "The sign-in failed", next: "Try again. If it keeps failing, connect with an API key instead.", retry: true }
}

/** Why the browser cannot hand the result back by itself. */
export function manualReason(notice: string | undefined): string {
  if (notice === "AUTH_PORT_BUSY") return "Another app is using the port the sign-in answers on (often another coding tool that is signing in). Finish here by hand:"
  if (notice === "AUTH_LISTENER_FAILED") return "The app could not listen for the browser's answer. Finish here by hand:"
  return "When the browser is done it lands on a page that may not load. That is expected:"
}

/** What a subscription tile says under its name. */
const FLOW_DETAIL: Readonly<Record<string, string>> = {
  chatgpt: "Plus, Pro, Business, or Enterprise plan",
  openrouter: "Your OpenRouter account and credits",
  xai: "SuperGrok or X Premium plan",
  kimi: "Kimi Code plan",
  meta: "Meta AI plan",
}

export function flowDetail(flow: SignInFlow): string {
  return FLOW_DETAIL[flow.id] ?? "Sign in with your account"
}

/** Words people type for a sign-in that are in neither its name nor its plan line. */
const FLOW_KEYWORDS: Readonly<Record<string, string>> = {
  chatgpt: "openai gpt codex",
  xai: "grok supergrok twitter",
  kimi: "moonshot",
  meta: "muse llama",
}

export function flowKeywords(id: string): string | undefined {
  return FLOW_KEYWORDS[id]
}

/** Who runs a sign-in, where that reads better in a sentence than the tile's name. */
const FLOW_VENDOR: Readonly<Record<string, string>> = { xai: "xAI", kimi: "Kimi", meta: "Meta" }

/**
 * What the unofficial label means, said before the first sign-in: whose sign-in this is, what
 * Runrail presents there, and that the provider may stop it. The person decides with that in view.
 */
export function unofficialNotice(flow: SignInFlow): string {
  const vendor = FLOW_VENDOR[flow.id] ?? flow.label
  return `${vendor} runs this sign-in for its own command-line tool and does not document it for other apps. Runrail uses that tool's public client id, because ${vendor} issues no other, and names itself as Runrail in every request. ${vendor} may block it, or act on the account, without notice. An API key is the supported way in.`
}

/**
 * Subscriptions that are used through the vendor's own tool instead of a sign-in here. Runrail
 * starts that tool with the login it already has, and never sees the account's password or token.
 */
export interface ToolRoute {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly keywords: string
  readonly steps: readonly string[]
}

/** Plans that run through a coding tool installed on this computer. */
export function toolRoutes(words: PlatformWords = currentWords()): readonly ToolRoute[] {
  const installed = (tool: string): string => `Runs through ${tool} installed on this ${words.computer}`
  return [
    {
      id: "claude-code",
      name: "Claude Pro or Max",
      detail: installed("Claude Code"),
      keywords: "anthropic claude pro max subscription claude code",
      steps: [
        "Install Claude Code and sign in there once, with `claude auth login` in a terminal.",
        "In a thread, open the model menu and choose Claude Code.",
        "Runrail starts Claude Code with the login it already has. It never sees your Claude password or sign-in.",
      ],
    },
    {
      id: "codex",
      name: "Codex CLI",
      detail: installed("the Codex CLI"),
      keywords: "openai codex cli chatgpt",
      steps: [
        "Install the Codex CLI and sign in there once, with `codex login` in a terminal.",
        "In a thread, open the model menu and choose Codex.",
        "Prefer ChatGPT sign-in above if you want to pick models and keep the conversation in Runrail's own loop.",
      ],
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      detail: installed("the GitHub Copilot CLI"),
      keywords: "github copilot cli microsoft subscription",
      steps: [
        "Install the GitHub Copilot CLI and sign in there once, with `copilot login` in a terminal.",
        "In a thread, open the model menu and choose GitHub Copilot. Type a model id there to pick one; without one, Copilot uses its own default.",
        "Runrail starts the Copilot CLI with the login it already has. It never sees your GitHub sign-in, and never presents itself as another editor.",
      ],
    },
    {
      id: "pi",
      name: "Through Pi",
      detail: "Radius, and anything else you signed in to inside Pi",
      keywords: "pi radius gemini cli antigravity github copilot subscription",
      steps: [
        "Install Pi and sign in to the provider there once, with `/login` inside Pi.",
        "In a thread, open the model menu. The models Pi can run are listed under Through Pi.",
        "Pi keeps the sign-in. Runrail starts Pi with the model you pick and never sees the account.",
      ],
    },
  ]
}

/** How a coding-tool connection signs in, in the user's words. */
export function toolRoute(connection: Pick<ToolConnection, "authMode" | "separateAccount">): string {
  if (connection.authMode === "api-key") return "API key"
  return connection.separateAccount ? "Its own sign-in" : "The login it already has"
}

export interface ToolStatusText extends ConnectionStatusText {
  /** The one button that makes it usable, when it needs one. */
  readonly fix?: string
}

/** Whether a thread can run as a tool connection, from what the tool said; `undefined` is still asking. */
export function toolStatusText(connection: Pick<ToolConnection, "tool" | "authMode" | "separateAccount" | "enabled">, status: ToolStatus | undefined): ToolStatusText {
  const name = BACKEND_LABELS[connection.tool]
  if (!connection.enabled) return { tone: "off", label: "Off", hint: "Turned off: the model menu does not offer it." }
  if (status === undefined) return { tone: "busy", label: "Checking" }
  if (connection.authMode === "api-key") return status.keyStored === true ? { tone: "ok", label: "Ready" } : { tone: "warn", label: "No API key yet", hint: "Add a key to use it.", fix: "Add key" }
  if (status.installed === false) return { tone: "fail", label: "Not installed", hint: `${name} was not found on this computer. Install it, then refresh.` }
  if (status.signedIn === false) {
    return connection.separateAccount
      ? { tone: "warn", label: "Not signed in", hint: `Sign in to this account with ${name}'s own login.`, fix: "Sign in" }
      : { tone: "warn", label: "Not signed in", hint: `${name} says it is not signed in. Sign in to it in a terminal, then refresh.` }
  }
  return { tone: "ok", label: "Ready" }
}

/** What a coding tool's tile says under its name: the ways it can sign in. */
export const TOOL_DETAIL: Readonly<Record<ToolId, string>> = {
  "claude-code": "Claude Pro or Max, or an API key",
  codex: "A ChatGPT plan, or an API key",
  copilot: "A GitHub Copilot plan, with the login the CLI has",
  opencode: "The providers you set up in OpenCode",
  gemini: "A Google sign-in, or a Gemini API key",
  goose: "The provider you set up in Goose",
  pi: "Radius, and anything else you signed in to inside Pi",
}

/** Who pays for a thread run with the login a coding tool already has, said before it is turned on. */
export const TOOL_BILLING: Readonly<Record<ToolId, string>> = {
  "claude-code": "Signed in to a Claude plan, Claude Code's threads count against that plan's usage limits; with an API key, they are billed to that key.",
  codex: "Signed in with ChatGPT, Codex's threads count against your ChatGPT plan's usage limits; with an API key, they are billed to that key.",
  copilot: "GitHub Copilot's threads count against your Copilot plan.",
  opencode: "OpenCode's threads are billed to the providers you set up in OpenCode.",
  gemini: "Signed in with Google, Gemini CLI's threads count against that account's Gemini limits; with an API key, they are billed to that key.",
  goose: "Goose's threads are billed to the provider you set up in Goose.",
  pi: "Pi's threads are billed to what you signed in to inside Pi.",
}

/** The confirmation before turning on tools found on this computer, which run with logins Runrail did not set up. */
export function turnOnText(tools: readonly ToolId[]): { readonly title: string; readonly body: string; readonly confirm: string } {
  const names = tools.map((tool) => BACKEND_LABELS[tool])
  const listed = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`
  const billing = tools.map((tool) => TOOL_BILLING[tool]).join(" ")
  const after = "Runrail never sees a login, and turning a tool off later does not sign you out."
  if (tools.length === 1) return { title: `Turn on ${listed}?`, body: `${listed} runs threads with the login it already has on this computer, so they use that account's plan or key. ${billing} ${after}`, confirm: "Turn on" }
  return { title: `Turn on ${tools.length} coding tools?`, body: `${listed} each run threads with the login they already have on this computer, so they use those accounts' plans or keys. ${billing} ${after}`, confirm: "Turn on all" }
}

/** Providers shown first, in this order; the rest follow in the engine's order. */
const FEATURED: readonly string[] = ["anthropic", "openai", "google", "openrouter", "xai", "groq", "deepseek", "mistral"]

export function orderPresets(presets: readonly ConnectionPreset[]): ConnectionPreset[] {
  const rank = (id: string): number => {
    const index = FEATURED.indexOf(id)
    return index < 0 ? FEATURED.length : index
  }
  return presets.map((preset, index) => ({ preset, index })).sort((left, right) => rank(left.preset.id) - rank(right.preset.id) || left.index - right.index).map((entry) => entry.preset)
}

/** Words people type for a provider that are in neither its name nor its address. */
const PRESET_KEYWORDS: Readonly<Record<string, string>> = {
  anthropic: "claude",
  openai: "gpt chatgpt",
  google: "gemini",
  xai: "grok",
  meta: "muse llama",
  "kimi-for-coding": "kimi code moonshot",
  moonshotai: "kimi",
  "moonshotai-cn": "kimi",
  "alibaba-cn": "alibaba qwen",
  "alibaba-token-plan": "alibaba",
  "alibaba-token-plan-cn": "alibaba",
  zai: "glm zhipu",
  "zai-coding-plan": "glm zhipu",
  zhipuai: "glm bigmodel",
  "zhipuai-coding-plan": "glm bigmodel",
  volcengine: "doubao bytedance",
  togetherai: "together",
  "fireworks-ai": "fireworks",
  huggingface: "hf",
  vercel: "ai gateway",
}

export function presetKeywords(id: string): string | undefined {
  return PRESET_KEYWORDS[id]
}

/** True when every word of the query is somewhere in the fields. An empty query matches all. */
export function matches(query: string, ...fields: readonly (string | undefined)[]): boolean {
  const haystack = fields.filter((field) => field !== undefined).join(" ").toLowerCase()
  return query.toLowerCase().split(/\s+/).filter((word) => word.length > 0).every((word) => haystack.includes(word))
}

/** Friendly names for the formats a custom address can speak. */
const FORMAT_NAMES: Readonly<Record<string, string>> = {
  "custom-openai-chat": "OpenAI Chat Completions",
  "custom-openai-responses": "OpenAI Responses",
  "custom-anthropic": "Anthropic Messages",
  "custom-anthropic-bearer": "Anthropic Messages (Bearer key)",
}

export function formatName(id: string, fallback: string): string {
  return FORMAT_NAMES[id] ?? fallback
}

/** Where keys and sign-ins are kept, said the same way everywhere. */
export function storeText(store: "keychain" | "file" | undefined): string {
  if (store === "keychain") return "Keys and sign-ins are kept in your system keychain by the Runrail engine."
  if (store === "file") return "Keys and sign-ins are stored in a file, not the keychain. Only your user account can read it."
  return "Keys and sign-ins are kept by the Runrail engine."
}

/** Sign-ins that currently hold something to sign out of. */
export function signOutTargets(connections: readonly Connection[]): Connection[] {
  return connections.filter((connection) => isSignIn(connection) && connection.status !== "unconfigured")
}

/** Name for one more connection to a provider that already has `existing` of them. */
export function suggestLabel(name: string, existing: number): string {
  return existing === 0 ? name : `${name} ${existing + 1}`
}

/** Host of a provider's fixed address, for a tile's second line. */
export function presetHost(preset: Pick<ConnectionPreset, "baseUrl">): string | undefined {
  if (preset.baseUrl === undefined) return undefined
  try {
    return new URL(preset.baseUrl).host
  } catch {
    return undefined
  }
}
