import { create } from "zustand"
import type { FoundServer, McpServer, OtherTool } from "../host"

/**
 * Bringing skills, MCP servers, subagents, and instructions over from Claude Code, Codex, and the
 * other coding tools on this computer. The host reads their settings; this decides what can be
 * added and keeps the lists that show them current after an import.
 */

export const OTHER_TOOL_LABELS: Readonly<Record<OtherTool, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "opencode",
  pi: "Pi",
  shared: "Shared",
}

export type OtherToolsSection = "skills" | "servers" | "agents"

/** Bumped after an import, so the Settings list it changed reads itself again. */
export const useImportRevision = create<Readonly<Record<OtherToolsSection, number>>>(() => ({ skills: 0, servers: 0, agents: 0 }))

export function bumpImportRevision(section: OtherToolsSection): void {
  useImportRevision.setState((state) => ({ [section]: state[section] + 1 }))
}

export type ServerState = { readonly kind: "ready"; readonly server: McpServer } | { readonly kind: "taken" } | { readonly kind: "unusable"; readonly reason: string }

/**
 * Whether a found server can be added: one that cannot run here, or whose name is already in
 * Runrail's list, cannot. A server the other tool keeps for one project stays limited to it.
 */
export function serverState(found: FoundServer, existing: readonly McpServer[], projectPath: string | undefined): ServerState {
  if (found.server === undefined) return { kind: "unusable", reason: found.leftOut[0] ?? "it cannot run here as written" }
  if (existing.some((server) => server.name === found.server?.name)) return { kind: "taken" }
  if (found.scope === "project") {
    if (projectPath === undefined) return { kind: "unusable", reason: "it belongs to a project; open that project first" }
    return { kind: "ready", server: { ...found.server, project: projectPath } }
  }
  return { kind: "ready", server: found.server }
}

/** The picked servers, minus any whose name another picked one already uses. */
export function serversToAdd(picked: readonly McpServer[]): readonly McpServer[] {
  const names = new Set<string>()
  return picked.filter((server) => {
    if (names.has(server.name)) return false
    names.add(server.name)
    return true
  })
}

/** Instruction text taken from another tool, added under what is already written. */
export function withImported(draft: string, text: string): string {
  const trimmed = text.trim()
  if (draft.trim().length === 0) return trimmed
  if (draft.includes(trimmed)) return draft
  return `${draft.trimEnd()}\n\n${trimmed}`
}
