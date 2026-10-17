import { getHost, type FoundInstructions, type McpServer, type OtherTool, type OtherTools } from "../host"
import { addToolConnection, adoptFirstToolDefault, updateConnectionSettings, type ToolConnection, type ToolId } from "./connectionSettings"
import { serversToAdd, serverState, withImported } from "./otherTools"
import { MAX_INSTRUCTIONS, MODEL_TOOLS } from "./persist"
import type { CodingTool } from "./picker"
import { get, setPrefs } from "./store"

/**
 * First run: which coding tools Runrail may start, whether it reads plan limits, how much agents do
 * on their own, and what to bring over from the other tools on this computer. Every step can be
 * skipped; nothing here starts a tool as the person.
 */

export type OnboardingStep = "welcome" | "tools" | "limits" | "access" | "setup"

/** Plan limits exist only for these. */
const LIMIT_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["claude-code", "codex"])

export interface ToolChoice {
  readonly tool: ToolId
  readonly version?: string
  readonly signedIn?: boolean
  /** The connection that runs the tool with the login it already has, when there is one. */
  readonly connection?: ToolConnection
  /** On at first: as its connection is, else on when the tool says it is signed in. */
  readonly on: boolean
}

/** The installed tools, in Runrail's own order, each with whether it starts on. */
export function toolChoices(found: readonly CodingTool[], connections: readonly ToolConnection[]): readonly ToolChoice[] {
  return MODEL_TOOLS.flatMap((tool): ToolChoice[] => {
    const status = found.find((item) => item.id === tool)
    if (status?.available !== true) return []
    const connection = connections.find((item) => item.tool === tool && item.authMode === "subscription" && !item.separateAccount)
    return [{ tool, ...(status.version === undefined ? {} : { version: status.version }), ...(status.signedIn === undefined ? {} : { signedIn: status.signedIn }), ...(connection === undefined ? {} : { connection }), on: connection?.enabled ?? status.signedIn === true }]
  })
}

/** Tools this computer does not have, named for the line under the list. */
export function missingTools(found: readonly CodingTool[]): readonly ToolId[] {
  return MODEL_TOOLS.filter((tool) => found.find((item) => item.id === tool)?.available !== true)
}

/** Turns each tool on or off as picked. A tool turned on for the first time gets a connection that uses its own login. */
export async function applyTools(choices: readonly ToolChoice[], on: ReadonlySet<ToolId>): Promise<void> {
  let adopted = false
  for (const choice of choices) {
    const wanted = on.has(choice.tool)
    let connection = choice.connection
    if (wanted && connection === undefined) connection = await addToolConnection({ tool: choice.tool, authMode: "subscription" })
    else if (connection !== undefined && connection.enabled !== wanted) {
      await updateConnectionSettings(connection.id, { enabled: wanted })
      connection = { ...connection, enabled: wanted }
    }
    // New threads start on the first tool turned on, unless a start was already chosen.
    if (wanted && connection !== undefined && !adopted) {
      adoptFirstToolDefault(connection)
      adopted = true
    }
  }
}

/** The connection a tool needs before its own sign-in can run, made and turned on when missing. */
export async function connectionFor(choice: ToolChoice): Promise<ToolConnection> {
  if (choice.connection === undefined) return addToolConnection({ tool: choice.tool, authMode: "subscription" })
  if (!choice.connection.enabled) await updateConnectionSettings(choice.connection.id, { enabled: true })
  return { ...choice.connection, enabled: true }
}

/** Whether the plan limits step applies: only Claude Code and Codex report limits. */
export function offersLimits(choices: readonly ToolChoice[], on: ReadonlySet<ToolId>): boolean {
  return choices.some((choice) => LIMIT_TOOLS.has(choice.tool) && on.has(choice.tool))
}

export interface SetupServer {
  readonly key: string
  readonly tool: OtherTool
  readonly name: string
  readonly detail: string
  /** Absent when it cannot be added; `blocked` says why. */
  readonly server?: McpServer
  readonly blocked?: string
}

export interface SetupInstructions {
  readonly key: string
  readonly tool: OtherTool
  readonly place: string
  readonly text: string
}

export interface SetupFound {
  readonly servers: readonly SetupServer[]
  readonly instructions: readonly SetupInstructions[]
  /** Found too, but copied into a project, so not offered before one is open. */
  readonly skills: number
  readonly agents: number
}

/**
 * What the other tools hold that Runrail can take now: MCP servers for its own list, and global
 * instructions for every thread. Servers kept for one project wait until that project is open.
 */
export function setupFound(scan: OtherTools, existing: readonly McpServer[]): SetupFound {
  const servers = scan.servers.map((found, index): SetupServer => {
    const state = serverState(found, existing, undefined)
    const line = found.server === undefined ? found.original : found.server.url ?? [found.server.command, ...found.server.args].join(" ")
    return {
      key: `${found.place}:${found.original}:${String(index)}`,
      tool: found.tool,
      name: found.server?.name ?? found.original,
      detail: line,
      ...(state.kind === "ready" ? { server: state.server } : { blocked: state.kind === "taken" ? "Already in Runrail" : state.reason }),
    }
  })
  const instructions = scan.instructions
    .filter((found): found is FoundInstructions => found.scope === "global" && found.text.trim().length > 0)
    .map((found) => ({ key: `${found.tool}:${found.place}`, tool: found.tool, place: found.place, text: found.text }))
  return { servers, instructions, skills: scan.skills.length, agents: scan.agents.length }
}

/** What starts picked: every server that can be added. Instructions start unpicked, since their own tool already reads them. */
export function initialPicks(found: SetupFound): ReadonlySet<string> {
  return new Set(found.servers.filter((item) => item.server !== undefined).map((item) => item.key))
}

export function hasSetup(found: SetupFound | undefined): boolean {
  return found !== undefined && (found.servers.length > 0 || found.instructions.length > 0)
}

export async function scanSetup(): Promise<SetupFound> {
  const host = getHost()
  const [scan, existing] = await Promise.all([host.otherToolsScan(), host.mcpList()])
  return setupFound(scan, existing)
}

/**
 * Adds the picked servers (after the host's own confirmation, which throws `MCP_DECLINED` when
 * declined) and the picked instructions, under any the person already wrote.
 */
export async function bringOver(found: SetupFound, picked: ReadonlySet<string>): Promise<{ readonly servers: number; readonly instructions: number }> {
  const servers = serversToAdd(found.servers.filter((item) => picked.has(item.key)).flatMap((item) => (item.server === undefined ? [] : [item.server])))
  if (servers.length > 0) await getHost().mcpImport(servers)
  const texts = found.instructions.filter((item) => picked.has(item.key))
  if (texts.length > 0) {
    const merged = texts.reduce((draft, item) => withImported(draft, item.text), get().prefs.instructions ?? "")
    setPrefs({ instructions: merged.slice(0, MAX_INSTRUCTIONS) })
  }
  return { servers: servers.length, instructions: texts.length }
}

export function finishOnboarding(): void {
  setPrefs({ onboarded: true })
}
