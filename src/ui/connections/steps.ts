import type { Connection, PresetCatalog } from "../../app/connections"
import type { ToolConnection, ToolId } from "../../app/connectionSettings"
import { BACKEND_LABELS, MODEL_TOOLS } from "../../app/persist"
import type { CodingTool } from "../../app/picker"
import type { ConnectionPreset, DetectedConnection, SignInFlow } from "../../protocol/schemas"
import { accountsOf, flowDetail, flowFor, flowKeywords, isKey, isSignIn, matches, orderPresets, presetHost, presetKeywords, suggestLabel, TOOL_DETAIL, toolRoutes, type ToolRoute } from "./text"

/**
 * What "Connect a model" shows and where each choice leads. Plain data in, plain data out, so
 * the list of providers and the step a dialog opens on can be checked without a window.
 */

export interface ConnectData {
  readonly catalog: PresetCatalog
  readonly detected: readonly DetectedConnection[]
  readonly flows: readonly SignInFlow[]
  /**
   * Coding tools: the ones found on this computer and the connections already made for them.
   * Absent from an engine without tool connections, where each tool is a page of instructions.
   */
  readonly tools?: { readonly found: readonly CodingTool[]; readonly connections: readonly ToolConnection[] }
}

export type Step =
  | { readonly kind: "pick" }
  | { readonly kind: "key"; readonly preset: ConnectionPreset; readonly label: string }
  /** A custom address; `label` and `address` come prefilled from another tool's settings. */
  | { readonly kind: "custom"; readonly label?: string; readonly address?: string }
  | { readonly kind: "replace"; readonly connection: Connection }
  /** A sign-in that already has accounts: sign in to one again, or add another. */
  | { readonly kind: "accounts"; readonly flow: SignInFlow }
  | { readonly kind: "sign-in"; readonly flow: SignInFlow; readonly accountId?: string; readonly label?: string; readonly again: boolean }
  | { readonly kind: "route"; readonly route: ToolRoute }
  /** A coding tool: the login it runs as, then its models. */
  | { readonly kind: "tool"; readonly tool: ToolId }
  /** The models a connection offers, chosen right after it is made (`fresh`) or changed later. */
  | { readonly kind: "models"; readonly connectionId: string; readonly fresh?: boolean }
  /** A key for a coding-tool connection that runs on one. */
  | { readonly kind: "tool-key"; readonly connection: ToolConnection }
  /** The tool's own sign-in for a connection with a folder of its own. */
  | { readonly kind: "tool-sign-in"; readonly connection: ToolConnection }

export interface ConnectTarget {
  readonly presetId?: string | undefined
  readonly flow?: string | undefined
  readonly connectionId?: string | undefined
  readonly custom?: { readonly label: string; readonly address: string } | undefined
  /** Opens on adding a connection for this coding tool. */
  readonly tool?: string | undefined
  /** Opens on choosing the models of this connection. */
  readonly models?: string | undefined
}

export interface Tile {
  readonly key: string
  readonly name: string
  readonly detail: string
  /** Shown next to the name; "Unofficial" for a sign-in the vendor does not document. */
  readonly badge?: string
  /** Connections this choice already produced. */
  readonly count: number
  readonly step: Step
}

export interface Tiles {
  /** Keys the login shell exports that no connection uses yet. */
  readonly shell: readonly DetectedConnection[]
  readonly subscriptions: readonly Tile[]
  /** Coding tools, installed ones first, when the engine keeps tool connections. */
  readonly tools: readonly Tile[]
  readonly keys: readonly Tile[]
  readonly empty: boolean
}

const CUSTOM_KEYWORDS = "custom local ollama lm studio vllm litellm llama.cpp proxy gateway self-hosted openai compatible anthropic compatible"
const CUSTOM_DETAIL = "Ollama, LM Studio, a proxy, or any compatible address"

function keyConnections(presetId: string, connections: readonly Connection[]): number {
  return connections.filter((connection) => connection.presetId === presetId && connection.baseUrl === undefined && !isSignIn(connection)).length
}

function keyStep(preset: ConnectionPreset, connections: readonly Connection[]): Step {
  return { kind: "key", preset, label: suggestLabel(preset.name, keyConnections(preset.id, connections)) }
}

function flowStep(flow: SignInFlow, connections: readonly Connection[], flows: readonly SignInFlow[]): Step {
  return accountsOf(flow, connections, flows).length > 0 ? { kind: "accounts", flow } : { kind: "sign-in", flow, again: false }
}

/** True when a connection already reads this shell variable for this provider. */
function attached(detected: DetectedConnection, connections: readonly Connection[]): boolean {
  return connections.some((connection) => connection.presetId === detected.presetId && connection.environmentName === detected.environmentName)
}

/** Everything the list offers for a filter text, in the order it is shown. */
export function buildTiles(query: string, data: ConnectData, connections: readonly Connection[]): Tiles {
  const shell = data.detected.filter((item) => !attached(item, connections) && matches(query, item.name, item.environmentName, item.presetId, "shell environment variable"))
  const subscriptions: Tile[] = [
    ...data.flows
      .filter((flow) => matches(query, flow.label, flow.id, flow.preset, flowDetail(flow), flowKeywords(flow.id), "subscription sign in login plan"))
      .map((flow) => ({
        key: `flow:${flow.id}`,
        name: flow.label,
        detail: flowDetail(flow),
        ...(flow.unofficial ? { badge: "Unofficial" } : {}),
        count: accountsOf(flow, connections, data.flows).length,
        step: flowStep(flow, connections, data.flows),
      })),
    ...(data.tools !== undefined ? [] : toolRoutes().filter((route) => matches(query, route.name, route.detail, route.keywords)).map((route) => ({ key: `route:${route.id}`, name: route.name, detail: route.detail, count: 0, step: { kind: "route", route } as const }))),
  ]
  const tools = data.tools === undefined ? [] : toolTiles(query, data.tools.found, data.tools.connections)
  // An address a plan sign-in leads to takes no pasted key; its tile is the sign-in above.
  const keys: Tile[] = orderPresets(data.catalog.presets.filter((preset) => preset.signInOnly !== true))
    .filter((preset) => matches(query, preset.name, preset.id, presetHost(preset), preset.environment, presetKeywords(preset.id), "api key"))
    .map((preset) => ({ key: `preset:${preset.id}`, name: preset.name, detail: presetHost(preset) ?? "API key", count: keyConnections(preset.id, connections), step: keyStep(preset, connections) }))
  if (data.catalog.custom.length > 0 && matches(query, "Custom endpoint", CUSTOM_DETAIL, CUSTOM_KEYWORDS)) {
    keys.push({ key: "custom", name: "Custom endpoint", detail: CUSTOM_DETAIL, count: connections.filter((connection) => connection.baseUrl !== undefined).length, step: { kind: "custom" } })
  }
  return { shell, subscriptions, tools, keys, empty: shell.length === 0 && subscriptions.length === 0 && tools.length === 0 && keys.length === 0 }
}

/** One tile per coding tool, installed ones first. A tool the engine has not looked for yet is listed as it is. */
function toolTiles(query: string, found: readonly CodingTool[], connections: readonly ToolConnection[]): Tile[] {
  const installed = (tool: ToolId): boolean | undefined => found.find((item) => item.id === tool)?.available
  const routes = toolRoutes()
  return MODEL_TOOLS.filter((tool) => matches(query, BACKEND_LABELS[tool], TOOL_DETAIL[tool], routes.find((route) => route.id === tool)?.keywords, "coding tool cli"))
    .map((tool, index) => ({ tool, index, rank: installed(tool) === false ? 1 : 0 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ tool }) => ({
      key: `tool:${tool}`,
      name: BACKEND_LABELS[tool],
      detail: TOOL_DETAIL[tool],
      ...(installed(tool) === false ? { badge: "Not installed" } : installed(tool) === true && !connections.some((item) => item.tool === tool) ? { badge: "Installed" } : {}),
      count: connections.filter((item) => item.tool === tool).length,
      step: { kind: "tool", tool },
    }))
}

/**
 * The step a dialog opens on. A connection opens its repair (a new key, or signing in again), a
 * provider its key form, a sign-in its sheet; anything that no longer resolves opens the list.
 */
export function initialStep(target: ConnectTarget, data: ConnectData, connections: readonly Connection[]): Step {
  if (target.custom !== undefined && data.catalog.custom.length > 0) return { kind: "custom", ...target.custom }
  if (target.models !== undefined && data.tools !== undefined && (connections.some((item) => item.id === target.models) || data.tools.connections.some((item) => item.id === target.models))) return { kind: "models", connectionId: target.models }
  const tool = MODEL_TOOLS.find((item) => item === target.tool)
  if (tool !== undefined && data.tools !== undefined) return { kind: "tool", tool }
  if (target.connectionId !== undefined) {
    const tool = data.tools?.connections.find((item) => item.id === target.connectionId)
    if (tool !== undefined) return tool.authMode === "api-key" ? { kind: "tool-key", connection: tool } : tool.separateAccount ? { kind: "tool-sign-in", connection: tool } : { kind: "pick" }
    const connection = connections.find((item) => item.id === target.connectionId)
    if (connection !== undefined) {
      if (isSignIn(connection)) {
        const flow = data.flows.find((item) => item.id === target.flow) ?? flowFor(connection, data.flows)
        if (flow !== undefined) return { kind: "sign-in", flow, accountId: connection.id, label: connection.label, again: true }
      }
      if (isKey(connection)) return { kind: "replace", connection }
    }
    return { kind: "pick" }
  }
  if (target.presetId !== undefined) {
    const preset = data.catalog.presets.find((item) => item.id === target.presetId)
    if (preset?.signInOnly === true) {
      const flow = data.flows.find((item) => item.preset === preset.id)
      return flow === undefined ? { kind: "pick" } : flowStep(flow, connections, data.flows)
    }
    if (preset !== undefined) return keyStep(preset, connections)
    if (data.catalog.custom.some((item) => item.id === target.presetId)) return { kind: "custom" }
  }
  if (target.flow !== undefined) {
    const flow = data.flows.find((item) => item.id === target.flow)
    if (flow !== undefined) return flowStep(flow, connections, data.flows)
  }
  return { kind: "pick" }
}

/** A model a connection lists, as the models step shows it. */
export interface ModelOption {
  readonly id: string
  readonly name?: string | undefined
  readonly note?: string | undefined
}

/** How many of a long list a new connection starts with: enough to pick from, few enough to read. */
const RECOMMENDED = 4

/**
 * What a new connection starts with chosen: a coding tool's whole list when it is short (the tool
 * curates it), a provider's first few in its own order. Nothing chosen starts on every listed
 * model: a long tool list (OpenCode lists every provider it has) is the tool's to narrow.
 */
export function recommendedModels(options: readonly ModelOption[], tool: boolean): string[] {
  const ids = options.map((option) => option.id)
  if (!tool) return ids.slice(0, RECOMMENDED)
  return ids.length <= RECOMMENDED * 2 ? ids : []
}

export function chooseModel(chosen: readonly string[], id: string): string[] {
  return chosen.includes(id) ? [...chosen] : [...chosen, id]
}

export function dropModel(chosen: readonly string[], id: string): string[] {
  return chosen.filter((item) => item !== id)
}

/** Moves a chosen model to the front, where it is the connection's default. */
export function firstModel(chosen: readonly string[], id: string): string[] {
  return chosen.includes(id) ? [id, ...chosen.filter((item) => item !== id)] : [...chosen]
}
