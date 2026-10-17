import { useMemo } from "react"
import type { BackgroundEntry } from "../protocol/schemas"
import type { TimelineItem, ToolItem } from "../thread/reducer"
import { listed, useBackground } from "./background"
import { useApp } from "./store"

/**
 * The Tasks tab's rows: work the engine reports (subagents and commands left running) and the
 * subagents in the thread's own timeline, one row each. An engine entry that names its tool call
 * stands for that call's timeline item.
 */

export type TaskStatus = BackgroundEntry["status"]

export interface TaskRow {
  readonly id: string
  readonly kind: "agent" | "command"
  readonly status: TaskStatus
  readonly label: string
  readonly agentType?: string | undefined
  readonly detail?: string | undefined
  readonly startedAt?: number | undefined
  readonly endedAt?: number | undefined
  readonly tokens?: number | undefined
  readonly toolUses?: number | undefined
  readonly exitCode?: number | undefined
  readonly callId?: string | undefined
  readonly entry?: BackgroundEntry | undefined
}

export const FINISHED_SHOWN = 10

export function isAgentItem(item: ToolItem): boolean {
  return item.agent !== undefined || item.presentation.kind === "agent"
}

function itemStatus(item: ToolItem): TaskStatus {
  const status = item.agentStatus ?? item.status
  return status === "running" ? "running" : status === "failed" ? "failed" : "completed"
}

export function taskRows(entries: readonly BackgroundEntry[], items: readonly TimelineItem[]): { readonly running: readonly TaskRow[]; readonly finished: readonly TaskRow[] } {
  const agents = new Map<string, ToolItem>()
  for (const item of items) if (item.kind === "tool" && isAgentItem(item)) agents.set(item.callId, item)
  const rows: TaskRow[] = []
  const linked = new Set<string>()
  for (const entry of entries) {
    if (!listed(entry)) continue
    const item = entry.callId === undefined ? undefined : agents.get(entry.callId)
    if (entry.callId !== undefined) linked.add(entry.callId)
    rows.push({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      label: entry.label,
      agentType: entry.agentType ?? item?.agent?.agentType,
      detail: entry.detail,
      startedAt: entry.startedAt ?? item?.at,
      endedAt: entry.endedAt ?? (entry.status === "running" ? undefined : item?.endedAt),
      tokens: entry.tokens,
      toolUses: entry.toolUses,
      exitCode: entry.exitCode,
      callId: entry.callId,
      entry,
    })
  }
  for (const item of agents.values()) {
    if (linked.has(item.callId)) continue
    rows.push({ id: `call:${item.callId}`, kind: "agent", status: itemStatus(item), label: item.agent?.title ?? (item.presentation.title || item.name), agentType: item.agent?.agentType, startedAt: item.at, endedAt: item.endedAt, callId: item.callId })
  }
  const running = rows.filter((row) => row.status === "running").sort((a, b) => (a.kind === b.kind ? (a.startedAt ?? 0) - (b.startedAt ?? 0) : a.kind === "agent" ? -1 : 1))
  const finished = rows
    .filter((row) => row.status !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
    .slice(0, FINISHED_SHOWN)
  return { running, finished }
}

const NO_ENTRIES: readonly BackgroundEntry[] = []
const NO_ITEMS: readonly TimelineItem[] = []

export function useTaskRows(threadId: string): ReturnType<typeof taskRows> {
  const entries = useBackground((state) => state[threadId]?.entries ?? NO_ENTRIES)
  const items = useApp((state) => state.runtime[threadId]?.timeline.items ?? NO_ITEMS)
  return useMemo(() => taskRows(entries, items), [entries, items])
}

/** Running rows, for the Tasks tab's badge. */
export function useRunningTasks(threadId: string): number {
  return useTaskRows(threadId).running.length
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Command output as plain text: terminal escapes go, and a line redrawn with `\r` keeps its last state. */
export function plainOutput(text: string): string {
  return text
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
      const at = trimmed.lastIndexOf("\r")
      return (at < 0 ? trimmed : trimmed.slice(at + 1)).replace(CONTROLS, "")
    })
    .join("\n")
}
