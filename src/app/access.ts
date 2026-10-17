import type { BackendId } from "../host/types"
import type { PermissionPreset, ThreadMode } from "./persist"

/**
 * What the agent may do, as one choice: Plan (read and propose, change nothing) or a permission
 * level. A thread stores Plan as its mode, so leaving Plan returns to the permission it had.
 */

export type Access = "plan" | PermissionPreset

export const ACCESS_ORDER: readonly Access[] = ["plan", "ask", "auto-edit", "auto", "full"]

export const ACCESS_LABELS: Readonly<Record<Access, string>> = { plan: "Plan", ask: "Ask", "auto-edit": "Auto-edit", auto: "Auto", full: "Full access" }

/** The coding tools whose own reviewer answers for Auto: Claude Code's auto mode and Codex's Approve for me. */
const AUTO_BACKENDS: ReadonlySet<BackendId> = new Set<BackendId>(["claude-code", "codex"])

export function offersAuto(backend: BackendId): boolean {
  return AUTO_BACKENDS.has(backend)
}

/** Auto on a tool with no reviewer runs as Ask. The thread keeps Auto for when it moves back. */
export function effectivePermission(permission: PermissionPreset, backend: BackendId): PermissionPreset {
  return permission === "auto" && !offersAuto(backend) ? "ask" : permission
}

export function accessOf(mode: ThreadMode, permission: PermissionPreset): Access {
  return mode === "plan" ? "plan" : permission
}

/** Plan replaces Goal; a permission level keeps Goal on and leaves Plan. */
export function withAccess(current: { readonly mode: ThreadMode; readonly permission: PermissionPreset }, access: Access): { readonly mode: ThreadMode; readonly permission: PermissionPreset } {
  if (access === "plan") return { mode: "plan", permission: current.permission }
  return { mode: current.mode === "plan" ? "agent" : current.mode, permission: access }
}

/** Shift-Tab walks Ask, Auto-edit, and Plan. Auto and Full access are only ever picked from the menu. */
const CYCLE: readonly Access[] = ["ask", "auto-edit", "plan"]

export function nextAccess(access: Access): Access {
  const at = CYCLE.indexOf(access)
  return at < 0 ? "ask" : (CYCLE[(at + 1) % CYCLE.length] ?? "ask")
}
