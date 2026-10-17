import { z } from "zod"
import { getHost, toHostError } from "../host"
import { parseOr } from "../protocol/schemas"
import { systemRpc } from "./connections"
import { restartEngines, restartProjectService } from "./engines"
import type { GrantRole, IntegrationGrant, IntegrationGrants, ThreadMeta } from "./persist"
import { create } from "zustand"
import { get, setPrefs } from "./store"

/**
 * Integrations: the built-in connectors and who may use what. The engine keeps which
 * connectors are on and their keys; the person's grants live in prefs and reach each thread's
 * engine in its behavior file, so a change restarts the engines.
 */

export const CONNECTOR_IDS = ["github", "linear", "slack", "jira"] as const
export type ConnectorId = (typeof CONNECTOR_IDS)[number]

export const CONNECTOR_INFO: Readonly<Record<ConnectorId, { readonly name: string; readonly does: string; readonly keyLabel?: string; readonly keyHelp?: string }>> = {
  github: { name: "GitHub", does: "Search issues, list and create issues and pull requests" },
  linear: { name: "Linear", does: "Search and create issues", keyLabel: "API key", keyHelp: "Linear: Settings, Security and access, Personal API keys." },
  slack: {
    name: "Slack",
    does: "List channels, search, send a message (asks first)",
    keyLabel: "Bot token",
    keyHelp: "A bot token (xoxb-) from your Slack app's OAuth page, with the channels:read, search:read and chat:write scopes.",
  },
  jira: { name: "Jira", does: "Search issues, add comments", keyLabel: "API token", keyHelp: "An Atlassian API token from id.atlassian.com, Security, API tokens." },
}

export const GRANTS: readonly IntegrationGrant[] = ["off", "read", "ask", "write"]
export const GRANT_LABELS: Readonly<Record<IntegrationGrant, string>> = { off: "Off", read: "Read", ask: "Ask", write: "Write" }
export const GRANT_ROLES: readonly { readonly role: GrantRole; readonly label: string }[] = [
  { role: "threads", label: "Your threads" },
  { role: "planner", label: "Planner" },
  { role: "executor", label: "Executor" },
  { role: "reviewer", label: "Reviewer" },
]
/** What a role may do with an integration until the person changes it: planners and reviewers read. */
export const ROLE_DEFAULTS: Readonly<Record<GrantRole, IntegrationGrant>> = { threads: "write", planner: "read", executor: "write", reviewer: "read" }

export function mcpKey(server: string): string {
  return `mcp:${server}`
}

export function grantOf(grants: IntegrationGrants, role: GrantRole, key: string): IntegrationGrant {
  return grants[role]?.[key] ?? ROLE_DEFAULTS[role]
}

/** A role in a setup is that role; a thread reviewing a pull request is a reviewer; the rest are the person's own. */
export function roleOfThread(thread: Pick<ThreadMeta, "setup" | "review">): GrantRole {
  return thread.setup?.role ?? (thread.review === undefined ? "threads" : "reviewer")
}

/**
 * The grants a thread's engine starts with. Every integration that is not Write is named, since the
 * engine takes one left out as Write; nothing is sent when everything is.
 */
export function integrationsFor(grants: IntegrationGrants, role: GrantRole, mcpServers: readonly string[]): Readonly<Record<string, IntegrationGrant>> | undefined {
  const keys = [...CONNECTOR_IDS, ...mcpServers.map(mcpKey)]
  const named = Object.fromEntries(keys.map((key) => [key, grantOf(grants, role, key)] as const).filter(([, grant]) => grant !== "write"))
  return Object.keys(named).length === 0 ? undefined : named
}

/** Whether a role's grants can differ from Write at all, so a launch can skip reading the MCP list. */
export function roleRestricted(grants: IntegrationGrants, role: GrantRole): boolean {
  return ROLE_DEFAULTS[role] !== "write" || Object.values(grants[role] ?? {}).some((grant) => grant !== "write")
}

/** A thread's grants for its launch; reads the host's MCP list only when the role is restricted. */
export async function threadIntegrations(thread: Pick<ThreadMeta, "setup" | "review">): Promise<Readonly<Record<string, IntegrationGrant>> | undefined> {
  const grants = get().prefs.integrationGrants
  const role = roleOfThread(thread)
  if (!roleRestricted(grants, role)) return undefined
  const servers = await getHost()
    .mcpList()
    .catch(() => [])
  return integrationsFor(
    grants,
    role,
    servers.map((server) => server.name),
  )
}

export function setGrant(role: GrantRole, key: string, grant: IntegrationGrant): void {
  const grants = get().prefs.integrationGrants
  const { [key]: _old, ...rest } = grants[role] ?? {}
  const next = grant === ROLE_DEFAULTS[role] ? rest : { ...rest, [key]: grant }
  setPrefs({ integrationGrants: { ...grants, [role]: next } })
  afterChange()
}

/** Restarts what starts with the grants or the connectors: each project's quiet engine, and every thread's engine. */
function afterChange(): void {
  for (const project of get().projects) void restartProjectService(project.id)
  restartEngines()
}

// ---------------------------------------------------------------------------------------------
// Connectors

const ConnectorStatusSchema = z.looseObject({
  id: z.enum(CONNECTOR_IDS),
  name: z.string().max(40),
  on: z.boolean(),
  connected: z.boolean(),
  signIn: z.enum(["gh", "key"]),
  site: z.string().max(256).optional(),
  email: z.string().max(256).optional(),
})
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>
const ConnectorListSchema = z.looseObject({ connectors: z.array(ConnectorStatusSchema).max(16) })

interface ConnectorsState {
  readonly connectors?: readonly ConnectorStatus[]
  readonly error?: string
}

export const useConnectors = create<ConnectorsState>(() => ({}))

export async function loadConnectors(): Promise<void> {
  try {
    const listed = parseOr(ConnectorListSchema, await systemRpc("connector.setup.list"))
    useConnectors.setState({ connectors: listed?.connectors ?? [], error: undefined })
  } catch (error) {
    useConnectors.setState({ error: toHostError(error).message })
  }
}

/** Keeps the key in the vault through the host's own command, then turns the connector on. */
export async function connectConnector(id: ConnectorId, input: { readonly key?: string; readonly site?: string; readonly email?: string }): Promise<void> {
  if (input.key !== undefined) await getHost().connectionSecretSet(id, input.key, "connector")
  await systemRpc("connector.setup.save", { id, on: true, ...(input.site === undefined ? {} : { site: input.site }), ...(input.email === undefined ? {} : { email: input.email }) })
  afterChange()
  await loadConnectors()
}

/** Turns a connector off and forgets its key. */
export async function disconnectConnector(id: ConnectorId): Promise<void> {
  await systemRpc("connector.setup.remove", { id })
  afterChange()
  await loadConnectors()
}
