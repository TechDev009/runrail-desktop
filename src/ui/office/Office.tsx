import { Bot, Columns3, Ellipsis, FlaskConical, FolderOpen, FolderPlus, GitBranch, History, Plus, SquareArrowOutUpRight } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { useShallow } from "zustand/react/shallow"
import { openDialog, openInEditor, pickProject, reveal, startNewThread } from "../../app/actions"
import { closeDrawer, closePeek, openPerson, setOfficeFilter, showList, useOfficeFilter, usePeek, type OfficeFilter } from "../../app/office"
import type { Project, ThreadMeta } from "../../app/persist"
import { personState, type PersonTone } from "../../app/personState"
import { useWords } from "../../app/platformWords"
import { ROLE_NAMES } from "../../app/setups"
import { threadGroupKind, type ThreadGroupKind } from "../../app/threadGroups"
import { gameOn } from "../../app/play"
import { set, threadOnScreen, useApp } from "../../app/store"
import { useWaiting } from "../../app/triage"
import { latestPlan } from "../../thread/reducer"
import { plural } from "../../lib/format"
import { Button, cx, EmptyState, Menu, Resizer, Segmented, useTicker, type MenuEntry } from "../common"
import { usePrefersReducedMotion, useStatuses } from "../hooks"
import { FloorPlant } from "../seasonal"
import { ThreadView } from "../thread/ThreadView"
import { PeekCard } from "./PeekCard"
import { Person } from "./Person"
import { RoomProps, Wisteria } from "./RoomProps"
import { TodayPill } from "./Quests"
import { WaitingButton } from "./Tray"
import { Weather } from "./Weather"

/**
 * The office floor: one room per project, one person per thread, and the open thread in a drawer
 * beside them. Rooms keep their people in the order the threads were made, so nobody changes desks.
 */

/** Desks a room shows before the rest fold into "Show more"; busy and unread threads always show. */
const SEATS = 12

const FILTERS: readonly { readonly value: OfficeFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "work", label: "Working" },
  { value: "ask", label: "Needs you" },
  { value: "fail", label: "Failed" },
  { value: "done", label: "Done" },
  { value: "idle", label: "Idle" },
]

/** One clock for the whole floor, so WebKit draws the people four times a second rather than on every frame. */
const FRAME_MS = 250
const frameListeners = new Set<(frame: number) => void>()
let frameTimer: ReturnType<typeof setInterval> | undefined
let frameCount = 0

function onFrame(listener: (frame: number) => void): () => void {
  frameListeners.add(listener)
  frameTimer ??= setInterval(() => {
    frameCount = (frameCount + 1) % 8
    for (const each of frameListeners) each(frameCount)
  }, FRAME_MS)
  return () => {
    frameListeners.delete(listener)
    if (frameListeners.size > 0 || frameTimer === undefined) return
    clearInterval(frameTimer)
    frameTimer = undefined
  }
}

export function OfficeView() {
  const projects = useApp((state) => state.projects)
  const drawer = useApp((state) => state.officeDrawer)
  const inspectorOpen = useApp((state) => state.layout.inspectorOpen)
  const filter = useOfficeFilter((state) => state.filter)
  const playing = useApp((state) => gameOn(state.prefs))
  const peeked = usePeek((state) => state.threadId)
  const floor = useRef<HTMLDivElement | null>(null)
  const waiting = useWaiting()
  const now = useTicker(true, 15_000)
  const [expanded, setExpanded] = useState(false)
  // Expanding is for one visit: the next person opens beside the floor.
  if (!drawer && expanded) setExpanded(false)
  const [width, setWidth] = useState(640)
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden")
  const still = usePrefersReducedMotion()
  const quiet = useMemo(() => new Map(waiting.filter((item) => item.kind === "quiet").map((item) => [item.threadId, item.since])), [waiting])
  const counts = useApp(
    useShallow((state) => {
      const tally: Record<PersonTone, number> = { work: 0, ask: 0, fail: 0, done: 0, idle: 0 }
      for (const thread of state.threads) {
        if (thread.archived === true) continue
        const since = quiet.get(thread.id)
        tally[personState({ thread, runtime: state.runtime[thread.id], backgroundAgents: 0, ...(since === undefined ? {} : { quietSince: since }) }).tone] += 1
      }
      return tally
    }),
  )

  // The drawer takes over from the card, and leaving the floor closes it.
  useEffect(() => {
    if (drawer) closePeek()
  }, [drawer])
  useEffect(() => closePeek, [])

  // Nothing animates while the window is hidden.
  useEffect(() => {
    const change = (): void => setHidden(document.visibilityState === "hidden")
    document.addEventListener("visibilitychange", change)
    return () => document.removeEventListener("visibilitychange", change)
  }, [])

  // With the side panel open there is no room for the floor beside the drawer.
  const wide = drawer && (expanded || inspectorOpen)
  const total = counts.work + counts.ask + counts.fail + counts.done + counts.idle
  const summary = [counts.work > 0 && `${String(counts.work)} working`, counts.ask > 0 && needYou(counts.ask), counts.fail > 0 && `${String(counts.fail)} failed`].filter(Boolean).join(" · ")

  return (
    <div className={cx("office", wide && "is-wide")}>
      {!wide && (
        <section className="office-floor" aria-label="Office floor">
          <header className="office-header" data-tauri-drag-region>
            <h1 className="office-title">Office</h1>
            <span className="office-summary">{total === 0 ? "No threads yet" : summary.length === 0 ? "All quiet" : summary}</span>
            {projects.length > 0 && (
              <div className="office-filters" role="group" aria-label="Show">
                {FILTERS.map((option) => {
                  const count = option.value === "all" ? total : counts[option.value]
                  return (
                    <button key={option.value} type="button" className={cx("office-filter", `is-${option.value}`)} aria-pressed={filter === option.value} onClick={() => setOfficeFilter(filter === option.value ? "all" : option.value)}>
                      {option.value !== "all" && <span className="office-filter-dot" aria-hidden />}
                      {option.label}
                      <span className="office-filter-count">{count}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <span className="office-spacer" data-tauri-drag-region />
            {/* With a thread open its own header has the waiting pill, and the floor is narrow. */}
            {!drawer && (
              <>
                {playing && projects.length > 0 && <TodayPill />}
                <WaitingButton />
                <Segmented
                  size="sm"
                  label="View"
                  value="office"
                  onChange={(value) => value === "list" && showList()}
                  options={[
                    { value: "office", label: "Office" },
                    { value: "list", label: "List" },
                  ]}
                />
              </>
            )}
          </header>
          <div ref={floor} className="office-scroll">
            {projects.length === 0 ? (
              <EmptyState
                icon={<FolderPlus size={18} />}
                title="No projects yet"
                actions={
                  <Button size="sm" onClick={() => void pickProject()}>
                    Open project
                  </Button>
                }
              >
                Each project you open becomes a room, and each of its threads a person at a desk.
              </EmptyState>
            ) : (
              <>
                <div className="office-rooms">
                  {projects.map((project) => (
                    <Room key={project.id} project={project} quiet={quiet} filter={filter} now={now} moving={!hidden && !still} />
                  ))}
                </div>
                {peeked !== undefined && !drawer && <PeekCard key={peeked} threadId={peeked} floor={floor} />}
              </>
            )}
          </div>
        </section>
      )}
      {drawer && (
        <aside className={cx("office-drawer", wide && "is-wide")} style={{ "--drawer-w": `${String(width)}px` } as CSSProperties} aria-label="Thread">
          {!wide && <Resizer side="left" width={width} min={440} max={1_200} onResize={setWidth} />}
          <ThreadView drawer={{ expanded: wide, canExpand: !inspectorOpen, onExpand: () => setExpanded((value) => !value), onClose: closeDrawer }} />
        </aside>
      )}
    </div>
  )
}

function needYou(count: number): string {
  return `${String(count)} need${count === 1 ? "s" : ""} you`
}

interface RoomFacts {
  readonly branch?: string
  readonly planDone: number
  readonly planTotal: number
}

// Outside Room so it stays the same function and a person re-renders only when its own facts change.
function movePerson(event: KeyboardEvent<HTMLButtonElement>): void {
  const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0
  if (step === 0 && event.key !== "Home" && event.key !== "End") return
  const buttons = [...(event.currentTarget.closest(".room")?.querySelectorAll<HTMLButtonElement>("button.person") ?? [])]
  const at = buttons.indexOf(event.currentTarget)
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, at + step))
  event.preventDefault()
  buttons[next]?.focus()
}

function Room({ project, quiet, filter, now, moving }: { readonly project: Project; readonly quiet: ReadonlyMap<string, number>; readonly filter: OfficeFilter; readonly now: number; readonly moving: boolean }) {
  const threads = useApp(useShallow((state) => state.threads.filter((thread) => thread.projectId === project.id && thread.archived !== true)))
  const statuses = useStatuses()
  const activeThreadId = useApp(threadOnScreen)
  const peeked = usePeek((state) => state.threadId)
  const palette = useApp((state) => state.prefs.palette)
  const words = useWords()
  const facts = useApp(
    useShallow((state): RoomFacts => {
      let branch: string | undefined
      let planDone = 0
      let planTotal = 0
      for (const thread of state.threads) {
        if (thread.projectId !== project.id || thread.archived === true) continue
        if (branch === undefined && thread.worktree === undefined) branch = state.git[thread.id]?.status?.branch ?? undefined
        const timeline = state.runtime[thread.id]?.timeline
        if (timeline?.activeTurnId === undefined) continue
        const plan = latestPlan(timeline)
        if (plan?.turnId !== timeline.activeTurnId) continue
        planTotal += plan.steps.length
        planDone += plan.steps.filter((step) => step.status === "completed").length
      }
      return { ...(branch === undefined ? {} : { branch }), planDone, planTotal }
    }),
  )
  const [more, setMore] = useState(false)
  const [offscreen, setOffscreen] = useState(false)
  const section = useRef<HTMLElement | null>(null)

  // Rooms scrolled out of view stop animating.
  useEffect(() => {
    const element = section.current
    if (element === null || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => setOffscreen(entries.every((entry) => !entry.isIntersecting)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The poses in office.css read these three beats: 250 ms, 500 ms, and 1 s.
  useEffect(() => {
    const element = section.current
    if (element === null || offscreen || !moving) return
    const stop = onFrame((frame) => {
      element.dataset.a = String(frame & 1)
      element.dataset.b = String((frame >> 1) & 1)
      element.dataset.c = String((frame >> 2) & 1)
    })
    return () => {
      stop()
      delete element.dataset.a
      delete element.dataset.b
      delete element.dataset.c
    }
  }, [offscreen, moving])

  const busy = (thread: ThreadMeta): boolean => {
    const status = statuses[thread.id]
    return status === "running" || status === "waiting" || status === "failed" || thread.unread === true || thread.id === activeThreadId
  }
  const ordered = [...threads].sort((left, right) => left.createdAt - right.createdAt)
  const kept = more ? ordered : [...ordered.filter(busy), ...ordered.filter((thread) => !busy(thread)).sort((left, right) => right.updatedAt - left.updatedAt)].slice(0, SEATS)
  const seated = new Set(kept.map((thread) => thread.id))
  const people = ordered.filter((thread) => seated.has(thread.id))
  const folded = ordered.length - people.length
  // A quiet thread is still running but counts as needing you, as on the floor's header and filters.
  const quietHere = threads.filter((thread) => statuses[thread.id] === "running" && quiet.has(thread.id)).length
  const asking = threads.filter((thread) => statuses[thread.id] === "waiting").length + quietHere
  const failed = threads.filter((thread) => statuses[thread.id] === "failed").length
  const working = threads.filter((thread) => statuses[thread.id] === "running").length - quietHere
  const lamp = asking > 0 ? "is-ask" : failed > 0 ? "is-fail" : working > 0 ? "is-work" : "is-idle"
  const groups = new Map<string, { readonly label: string; readonly ids: string[]; readonly kind: ThreadGroupKind }>()
  for (const thread of ordered) {
    if (thread.group === undefined) continue
    const group = groups.get(thread.group.id) ?? { label: thread.group.label, ids: [], kind: threadGroupKind(thread.group.id, thread) }
    group.ids.push(thread.id)
    groups.set(thread.group.id, group)
  }
  const runOf = (thread: ThreadMeta): string | undefined => {
    const group = thread.group === undefined ? undefined : groups.get(thread.group.id)
    if (group === undefined) return undefined
    if (group.kind.kind === "setup" && thread.setup !== undefined) return ROLE_NAMES[thread.setup.role]
    return `Run ${String(group.ids.indexOf(thread.id) + 1)} of ${String(group.ids.length)}`
  }
  const focusId = people.find((thread) => thread.id === activeThreadId)?.id ?? people[0]?.id

  const menu: MenuEntry[] = [
    { id: "new", label: "New thread", icon: <Plus size={14} />, onSelect: () => startNewThread(project.id) },
    { id: "import", label: "Import sessions…", icon: <History size={14} />, onSelect: () => openDialog({ kind: "import", projectId: project.id }) },
    { id: "editor", label: "Open in editor", icon: <SquareArrowOutUpRight size={14} />, onSelect: () => void openInEditor(project.path) },
    { id: "reveal", label: words.reveal, icon: <FolderOpen size={14} />, onSelect: () => void reveal(project.path) },
    ...(project.git ? [{ id: "best-of", label: "Best of N…", icon: <Columns3 size={14} />, onSelect: () => openDialog({ kind: "best-of-n", projectId: project.id }) }] : []),
  ]

  return (
    <section ref={section} className="room" aria-label={`${project.name}: ${plural(threads.length, "thread")}`}>
      <div className="room-wall">
        {palette === "fuji" && <Wisteria />}
        <div className="room-plate">
          <div className="room-name-line">
            <span className={cx("room-lamp", lamp)} aria-hidden />
            <h2 className="room-name" title={project.path}>
              {project.name}
            </h2>
            {facts.branch !== undefined && (
              <span className="room-branch">
                <GitBranch size={11} />
                {facts.branch}
              </span>
            )}
          </div>
          <div className="room-meta" title={[plural(threads.length, "thread"), working > 0 && `${String(working)} working`, asking > 0 && needYou(asking), failed > 0 && `${String(failed)} failed`, facts.planTotal > 0 && `Plan ${String(facts.planDone)}/${String(facts.planTotal)}`].filter(Boolean).join(" · ")}>
            <span>{plural(threads.length, "thread")}</span>
            {working > 0 && <span>{working} working</span>}
            {asking > 0 && <span className="is-ask">{needYou(asking)}</span>}
            {failed > 0 && <span className="is-fail">{failed} failed</span>}
            {facts.planTotal > 0 && (
              <span className="room-plan" title={`${String(facts.planDone)} of ${String(facts.planTotal)} plan steps done`}>
                Plan {facts.planDone}/{facts.planTotal}
                <span className="room-plan-bar">
                  <span style={{ width: `${String(Math.round((facts.planDone / facts.planTotal) * 100))}%` }} />
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="room-wall-end">
          <RoomProps projectId={project.id} palette={palette} />
          <button type="button" className="room-add" onClick={() => startNewThread(project.id)} aria-label={`New thread in ${project.name}`} title="New thread">
            <Plus size={14} />
          </button>
          <Menu
            align="end"
            width={220}
            items={menu}
            trigger={({ toggle, ref, open: shown }) => (
              <button ref={ref} type="button" className={cx("icon-btn icon-btn-sm", shown && "is-active")} aria-label={`${project.name} options`} onClick={toggle}>
                <Ellipsis size={15} />
              </button>
            )}
          />
        </div>
      </div>
      <div className="room-floor">
        <Weather palette={palette} projectId={project.id} />
        {people.length === 0 && <span className="room-empty">No threads yet</span>}
        {people.map((thread) => {
          const run = runOf(thread)
          const since = quiet.get(thread.id)
          return (
            <Person
              key={thread.id}
              threadId={thread.id}
              project={project.name}
              now={now}
              selected={thread.id === activeThreadId || thread.id === peeked}
              filter={filter}
              focusable={thread.id === focusId}
              onOpen={openPerson}
              onKeyDown={movePerson}
              {...(since === undefined ? {} : { quietSince: since })}
              {...(run === undefined ? {} : { run })}
            />
          )
        })}
        {(folded > 0 || more) && (
          <button type="button" className="room-more" onClick={() => setMore((value) => !value)}>
            {more ? "Show fewer" : `Show ${String(folded)} more`}
          </button>
        )}
        {palette !== "default" && <FloorPlant flower={palette} />}
        {[...groups.entries()].map(([groupId, group]) => (
          <div key={groupId} className="room-group">
            {group.kind.kind === "compare" ? <Columns3 size={14} /> : group.kind.kind === "eval" ? <FlaskConical size={14} /> : <Bot size={14} />}
            <span className="room-group-label">{group.kind.kind === "compare" ? `Best of ${String(group.ids.length)}` : group.kind.kind === "eval" ? "Eval" : plural(group.ids.length, "role")}</span>
            <span className="room-group-sub">{group.label}</span>
            <Button size="sm" onClick={() => set({ view: group.kind.kind === "compare" ? { kind: "compare", groupId } : group.kind.kind === "eval" ? { kind: "evals", runId: group.kind.runId } : { kind: "agents", runId: group.kind.runId }, officeDrawer: false })}>
              {group.kind.kind === "compare" ? "Compare runs" : group.kind.kind === "eval" ? "Open eval" : "Open run"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
