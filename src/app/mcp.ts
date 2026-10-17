import { useCallback, useEffect, useState } from "react"
import { z } from "zod"
import { getHost, toHostError, type McpServer } from "../host"
import { projectRpc, restartEngines, restartProjectService } from "./engines"
import { useImportRevision } from "./otherTools"
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
