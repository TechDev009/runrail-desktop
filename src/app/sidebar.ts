import type { Project, SidebarView, ThreadMeta } from "./persist"

/** What the sidebar draws, worked out apart from React so every view and sort can be tested. */

export type Row = { readonly kind: "thread"; readonly thread: ThreadMeta } | { readonly kind: "group"; readonly id: string; readonly label: string; readonly threads: readonly ThreadMeta[] }

export type TimeGroup = "Pinned" | "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older" | "Archived"

export type Section =
  | {
      readonly kind: "project"
      readonly project: Project
      /** Live rows first, then archived ones when they are shown. */
      readonly rows: readonly Row[]
      /** No threads at all to show for it, searched or not. */
      readonly empty: boolean
      /** Open when not collapsed, and always while a search shows what it found inside. */
      readonly open: boolean
    }
  | { readonly kind: "time"; readonly label: TimeGroup; readonly rows: readonly Row[] }

export interface SidebarModel {
  readonly sections: readonly Section[]
  /** Threads in the order they appear, for previous and next; collapsed projects count as open. */
  readonly order: readonly string[]
  /** A search is on and found nothing. */
  readonly noMatches: boolean
}

export interface SidebarInput {
  readonly projects: readonly Project[]
  readonly threads: readonly ThreadMeta[]
  readonly view: SidebarView
  readonly collapsed: readonly string[]
  readonly query?: string
  readonly now: number
}

const DAY = 86_400_000

/** The thread row lit in the sidebar: only while that thread has the screen, so Office and a row never both light. */
export function highlightedThread(view: { readonly kind: string }, activeThreadId: string | undefined): string | undefined {
  return view.kind === "thread" ? activeThreadId : undefined
}

export function sidebarModel(input: SidebarInput): SidebarModel {
  const { view } = input
  const terms = searchTerms(input.query ?? "")
  const projects = new Map(input.projects.map((project) => [project.id, project]))
  const shown = input.threads.filter((thread) => projects.has(thread.projectId) && (view.showArchived || thread.archived !== true))
  const time = (thread: ThreadMeta): number => (view.threadSort === "created" ? thread.createdAt : thread.updatedAt)
  const newest = (left: ThreadMeta, right: ThreadMeta): number => time(right) - time(left)
  const found = (thread: ThreadMeta, project: Project): boolean => terms.length === 0 || matches(terms, project.name) || matches(terms, `${project.name} ${thread.title}`)
  // Pinning one run of a comparison pins the comparison, so it stays one row.
  const pinnedGroups = new Set(shown.flatMap((thread) => (thread.pinned === true && thread.group !== undefined ? [thread.group.id] : [])))
  const isPinned = (thread: ThreadMeta): boolean => thread.archived !== true && (thread.pinned === true || (thread.group !== undefined && pinnedGroups.has(thread.group.id)))

  if (view.organize === "chronological") {
    const listed = shown.filter((thread) => found(thread, projects.get(thread.projectId) as Project)).sort(newest)
    // A comparison's runs stay one row, filed where its newest run falls.
    const buckets = new Map<TimeGroup, Row[]>()
    for (const row of rowsOf(listed)) {
      const lead = row.kind === "thread" ? row.thread : (listed.find((thread) => thread.group?.id === row.id) as ThreadMeta)
      const label: TimeGroup = lead.archived === true ? "Archived" : isPinned(lead) ? "Pinned" : timeGroup(time(lead), input.now)
      buckets.set(label, [...(buckets.get(label) ?? []), row])
    }
    const sections = TIME_GROUPS.flatMap((label): Section[] => {
      const rows = buckets.get(label)
      return rows === undefined ? [] : [{ kind: "time", label, rows }]
    })
    return { sections, order: orderOf(sections), noMatches: terms.length > 0 && sections.length === 0 }
  }

  // Pinned threads leave their project for one list above every project, shown even when it is collapsed.
  const pinned: ThreadMeta[] = []
  const sections: Section[] = []
  for (const project of sortProjects(input.projects, input.threads, view, time)) {
    const own = shown.filter((thread) => thread.projectId === project.id)
    const nameFound = terms.length === 0 || matches(terms, project.name)
    const listed = nameFound ? own : own.filter((thread) => found(thread, project))
    pinned.push(...listed.filter(isPinned))
    const rest = listed.filter((thread) => !isPinned(thread))
    // A search lists a project only for what it found there; one found by name with no threads still shows.
    if (terms.length > 0 && rest.length === 0 && (own.length > 0 || !nameFound)) continue
    const live = rest.filter((thread) => thread.archived !== true).sort(newest)
    const archived = rest.filter((thread) => thread.archived === true).sort(newest)
    sections.push({
      kind: "project",
      project,
      rows: [...rowsOf(live), ...rowsOf(archived)],
      // A project whose threads are all pinned has nothing left to list, but is not empty.
      empty: own.length === 0,
      open: (terms.length > 0 && rest.length > 0) || !input.collapsed.includes(project.id),
    })
  }
  if (pinned.length > 0) sections.unshift({ kind: "time", label: "Pinned", rows: rowsOf(pinned.sort(newest)) })
  return { sections, order: orderOf(sections), noMatches: terms.length > 0 && sections.length === 0 }
}

export interface ArchivedGroup {
  readonly project: Project
  readonly threads: readonly ThreadMeta[]
}

/** When a thread was archived, or its last activity for one archived before that was kept. */
export function archivedAt(thread: ThreadMeta): number {
  return thread.archivedAt ?? thread.updatedAt
}

/** Archived threads whose project is still open: the count on the sidebar's Archived row. */
export function archivedCount(projects: readonly Project[], threads: readonly ThreadMeta[]): number {
  const open = new Set(projects.map((project) => project.id))
  return threads.filter((thread) => thread.archived === true && open.has(thread.projectId)).length
}

/**
 * The Archived list: by project, newest archived first, a project placed by its
 * newest. Every word typed must appear in a thread's title or its project's name.
 */
export function archivedList(input: { readonly projects: readonly Project[]; readonly threads: readonly ThreadMeta[]; readonly query?: string }): { readonly groups: readonly ArchivedGroup[]; readonly total: number } {
  const terms = searchTerms(input.query ?? "")
  const projects = new Map(input.projects.map((project) => [project.id, project]))
  const archived = input.threads.filter((thread) => thread.archived === true && projects.has(thread.projectId))
  const found = archived.filter((thread) => matches(terms, `${projects.get(thread.projectId)?.name ?? ""} ${thread.title}`)).sort((left, right) => archivedAt(right) - archivedAt(left))
  const byProject = new Map<string, ThreadMeta[]>()
  for (const thread of found) byProject.set(thread.projectId, [...(byProject.get(thread.projectId) ?? []), thread])
  return { groups: [...byProject].map(([projectId, threads]) => ({ project: projects.get(projectId) as Project, threads })), total: archived.length }
}

const TIME_GROUPS: readonly TimeGroup[] = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older", "Archived"]

/** Calendar days on this computer's clock, so "Yesterday" means the day before today, not 24 hours ago. */
export function timeGroup(at: number, now: number): TimeGroup {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  if (at >= start) return "Today"
  if (at >= start - DAY) return "Yesterday"
  if (at >= start - 7 * DAY) return "Previous 7 days"
  if (at >= start - 30 * DAY) return "Previous 30 days"
  return "Older"
}

function sortProjects(projects: readonly Project[], threads: readonly ThreadMeta[], view: SidebarView, time: (thread: ThreadMeta) => number): readonly Project[] {
  if (view.projectSort === "name") return projects.slice().sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
  if (view.projectSort === "activity") {
    const latest = new Map<string, number>()
    for (const thread of threads) if (thread.archived !== true) latest.set(thread.projectId, Math.max(latest.get(thread.projectId) ?? 0, time(thread)))
    return projects.slice().sort((left, right) => (latest.get(right.id) ?? right.addedAt) - (latest.get(left.id) ?? left.addedAt))
  }
  return projects
}

/** Runs of one Best-of-N comparison collapse into one row where the first of them sorts. */
function rowsOf(threads: readonly ThreadMeta[]): Row[] {
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const thread of threads) {
    if (thread.group === undefined) {
      rows.push({ kind: "thread", thread })
      continue
    }
    if (seen.has(thread.group.id)) continue
    seen.add(thread.group.id)
    const members = threads.filter((item) => item.group?.id === thread.group?.id).sort((left, right) => left.createdAt - right.createdAt)
    rows.push({ kind: "group", id: thread.group.id, label: thread.group.label, threads: members })
  }
  return rows
}

function orderOf(sections: readonly Section[]): string[] {
  return sections.flatMap((section) => section.rows.flatMap((row) => (row.kind === "thread" ? [row.thread] : row.threads))).filter((thread) => thread.archived !== true).map((thread) => thread.id)
}

function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
}

/** Every word typed appears somewhere in the text, in any order. */
function matches(terms: readonly string[], text: string): boolean {
  const lower = text.toLowerCase()
  return terms.every((term) => lower.includes(term))
}

/** The thread `step` places from `current` in the list's order, wrapping; the first or last when none is current. */
export function steppedThread(order: readonly string[], current: string | undefined, step: 1 | -1): string | undefined {
  if (order.length === 0) return undefined
  const index = current === undefined ? -1 : order.indexOf(current)
  return order[(index + step + order.length) % order.length]
}
