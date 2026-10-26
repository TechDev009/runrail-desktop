import { useCallback, useEffect, useState } from "react"
import { z } from "zod"
import { getHost, toHostError, type McpServer } from "../host"
import { systemRpc } from "./connections"
import { projectRpc, restartEngines, restartProjectService } from "./engines"
import { useImportRevision } from "./otherTools"
import { runSignIn, type SignInRun, type SignInView } from "./signIn"
import { get } from "./store"

/**
 * MCP servers for Runrail's own loop. The host keeps the list and asks the person before it saves
 * a command; every engine reads the list when it starts, so a change restarts the engines.
 */

export const McpStatusSchema = z.object({
  name: z.string().max(64),
  state: z.enum(["ready", "failed", "off"]),
  tools: z.number().int().min(0).max(10_000),
  code: z.string().max(64).optional(),
})
export type McpStatus = z.infer<typeof McpStatusSchema>

const CODE_TEXT: Readonly<Record<string, string>> = {
  MCP_TRANSPORT_FAILED: "The program did not start. Check the command and that it is installed.",
  MCP_TRANSPORT_INVALID: "The command or its settings are not valid.",
  MCP_CLIENT_TIMEOUT: "It started but did not answer in time.",
  MCP_CLIENT_CLOSED: "It stopped before it answered.",
  MCP_RESPONSE_INVALID: "Its answer was not valid MCP.",
  MCP_REMOTE_ERROR: "It answered with an error.",
  MCP_BRIDGE_INVALID: "Its tools have names Runrail cannot use.",
  MCP_BRIDGE_LIMIT: "It lists more tools than Runrail takes.",
  MCP_TOKEN_MISSING: "Its token variable is not set in the shell Runrail started from.",
  MCP_TOKEN_REJECTED: "It refused the token in its token variable.",
  MCP_SIGN_IN_REQUIRED: "It asks you to sign in. Use Sign in, then check it again.",
  MCP_SIGN_IN_UNAVAILABLE: "Its sign-in could not be read or renewed. Unlock the keychain, or sign in again.",
}

export function mcpFailureText(code: string | undefined): string {
  return (code === undefined ? undefined : CODE_TEXT[code]) ?? "It did not start."
}

/** A command line split the way a shell would for plain words and quotes; no expansion. */
export function splitArgs(text: string): string[] {
  const args: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ""
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

export function joinArgs(args: readonly string[]): string {
  return args.map((arg) => (/^[A-Za-z0-9_./:@=+,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`)).join(" ")
}

/** Restarts what reads the list: each project's quiet engine, and every thread's engine. */
function afterChange(): void {
  for (const project of get().projects) void restartProjectService(project.id)
  restartEngines()
}

export async function saveMcpServer(server: McpServer, previous?: string): Promise<readonly McpServer[]> {
  const servers = await getHost().mcpSave(server, previous)
  afterChange()
  return servers
}

export async function setMcpEnabled(name: string, enabled: boolean): Promise<readonly McpServer[]> {
  const servers = await getHost().mcpSetEnabled(name, enabled)
  afterChange()
  return servers
}

export async function removeMcpServer(name: string): Promise<readonly McpServer[]> {
  const servers = await getHost().mcpRemove(name)
  afterChange()
  return servers
}

/**
 * Hosted servers whose sign-in Runrail found by itself (checked 2026-10-26). Picking one only fills
 * in the form; the person still confirms the address before anything is saved.
 */
export const HOSTED_SERVERS: readonly { readonly name: string; readonly label: string; readonly url: string; readonly ownApp?: true }[] = [
  { name: "linear", label: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "notion", label: "Notion", url: "https://mcp.notion.com/mcp" },
  { name: "atlassian", label: "Jira and Confluence", url: "https://mcp.atlassian.com/v1/mcp" },
  { name: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp" },
  // GitHub's sign-in registers no apps; it asks for one the person registered.
  { name: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", ownApp: true },
]

/** A server reached at an address with no token variable signs in with its own page, when it has one. */
export function signsIn(server: McpServer): boolean {
  return server.url !== undefined && server.bearerEnv === undefined
}

/** The address as the engine keys a sign-in: no fragment, and no trailing slash on a bare host. */
export function signInAddress(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

const McpAppSchema = z.object({ id: z.string().min(1).max(512), callbackPort: z.number().int().min(1_024).max(65_535).optional(), secret: z.boolean() })
const McpSignInSchema = z.object({ url: z.string().max(2_048), signedIn: z.boolean(), updatedAt: z.number(), client: McpAppSchema.optional() })
const McpSignInsSchema = z.object({ servers: z.array(McpSignInSchema).max(256) })
export type McpSignIn = z.infer<typeof McpSignInSchema>
export type McpApp = z.infer<typeof McpAppSchema>

/** What the engine keeps per server address: whether it is signed in, and the app it signs in with when the person named one. */
export async function listMcpSignIns(): Promise<ReadonlyMap<string, McpSignIn>> {
  const parsed = McpSignInsSchema.safeParse(await systemRpc("auth.mcp.list"))
  return new Map(parsed.success ? parsed.data.servers.map((entry) => [entry.url, entry]) : [])
}

/**
 * Names the app a server signs in with, for an authorization server that registers none. Its
 * secret, when there is one, goes to the engine through the host's own command, never as a call.
 */
export async function setMcpApp(url: string, app: { readonly clientId: string; readonly callbackPort?: number; readonly secret?: string }): Promise<void> {
  const named = z.object({ id: z.string() }).safeParse(await systemRpc("auth.mcp.client.set", { url, clientId: app.clientId, ...(app.callbackPort === undefined ? {} : { callbackPort: app.callbackPort }) }))
  if (!named.success) throw toHostError({ code: "CONTROL_INVALID_RESPONSE", message: "the engine's answer could not be read" })
  if (app.secret !== undefined) await getHost().connectionSecretSet(named.data.id, app.secret, "mcp-client")
}

export async function clearMcpApp(url: string): Promise<void> {
  await systemRpc("auth.mcp.client.clear", { url })
}

/** Signs in to the server in the browser; every engine restarts once it is done, so threads pick up the tokens. */
export function signInMcpServer(server: McpServer & { readonly url: string }, onChange: (view: SignInView) => void): SignInRun {
  return runSignIn({ mcp: { url: server.url, name: server.name } }, (view) => {
    if (view.phase === "done") afterChange()
    onChange(view)
  })
}

export async function signOutMcpServer(url: string): Promise<void> {
  await systemRpc("auth.mcp.signout", { url })
  afterChange()
}

/** Starts the server once in the project's quiet engine and reports whether it lists its tools. */
export async function checkMcpServer(projectId: string, name: string): Promise<McpStatus> {
  const parsed = McpStatusSchema.safeParse(await projectRpc(projectId, "mcp.check", { name }))
  if (!parsed.success) throw toHostError({ code: "CONTROL_INVALID_RESPONSE", message: "the check answer could not be read" })
  return parsed.data
}

export function useMcpServers(): { readonly servers: readonly McpServer[]; readonly loading: boolean; readonly error?: string; readonly set: (servers: readonly McpServer[]) => void } {
  const [servers, setServers] = useState<readonly McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const revision = useImportRevision((state) => state.servers)
  useEffect(() => {
    let live = true
    getHost()
      .mcpList()
      .then((list) => live && setServers(list))
      .catch((caught: unknown) => live && setError(toHostError(caught).message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [revision])
  const set = useCallback((list: readonly McpServer[]) => setServers(list), [])
  return { servers, loading, ...(error === undefined ? {} : { error }), set }
}
