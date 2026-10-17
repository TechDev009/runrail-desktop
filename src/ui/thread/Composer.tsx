import { AppWindowMac, ArrowUp, Bot, Clock, File, Folder, ListChecks, MessageSquare, MessagesSquare, Play, Slash, Square, Target, Trash, TriangleAlert, Workflow, X, Zap } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction, connectModel, openDialog, startNewThread, workspaceOf } from "../../app/actions"
import { archiveWithUndo } from "../../app/archive"
import { computerPlace, useComputerActivity } from "../../app/computerAgent"
import { clearPageComments, elementLabel, pageCommentsBlock, removePageComment, usePageComments, type PageComment } from "../../app/pageComments"
import { useCatalog, useFiles } from "../../app/catalog"
import { commandName, runSetupOn, runWorkflowNow, useRunnables } from "../../app/composerRuns"
import { threadContext } from "../../app/threadMention"
import type { ThreadMeta } from "../../app/persist"
import {
  cancel,
  compactThread,
  editQueued,
  removeQueued,
  restartEngine,
  resumeQueue,
  send,
  setAccess,
  setMode,
  setModel,
  setComputerUse,
  setSelection,
  startFailureText,
  steer,
  stopGoal,
} from "../../app/engines"
import { closeCoveringPanel } from "../../app/overlays"
import { hasCapability, type Contract } from "../../protocol/schemas"
import { accessOf, effectivePermission, nextAccess, withAccess, type Access } from "../../app/access"
import { newId, type PermissionPreset, type ThreadMode } from "../../app/persist"
import { anyConnected, carried, classifyPick, defaultSelection, problemHint, pushRecent, selectionLabel, selectionProblem, type PickerValue, type Selection } from "../../app/picker"
import { setStartDefault } from "../../app/connectionSettings"
import { isRunning, stopAllBackground, useBackground } from "../../app/background"
import { openPanel, openPanelHere } from "../../app/panels"
import { readProjectGit } from "../../app/projectGit"
import { createThread, draftSelection, get, paneFocused, patchRuntime, set, setPrefs, sitsOnDefault, toast, useApp, type Attachment, type QueuedPrompt } from "../../app/store"
import { expandPastes, nextPasteId, pastePlaceholder, shouldFold, type PastedBlock } from "../../app/paste"
import { continueInNewThread, createWorktreeThread, shareOffered, threadHasHistory } from "../../app/workflows"
import { HEAD_START, type WorktreeStart } from "../../app/worktreeStart"
import { getHost, toHostError } from "../../host"
import type { Thinking } from "../../host/types"
import { firstLine } from "../../lib/format"
import { rank } from "../../lib/fuzzy"
import { isImage, prepareImage, type PreparedImage } from "../../lib/images"
import { isBusy } from "../../thread/reducer"
import { Button, cx, IconButton, Kbd, Spinner } from "../common"
import { useProject, useRuntime, useThread } from "../hooks"
import { AccessMenu, AddMenu, GoalChip, TokenChip, WorktreeMenu, type ComposerToken } from "./ComposerMenus"
import { ContextRing } from "./ContextRing"
import { ModelPicker } from "./ModelPicker"
import { MicButton, TalkButton, useTalkAvailable } from "./Voice"
import { stopListening, stopSpeaking, stopTalking, useVoice } from "../../app/voice"
import { RepoMark, ThreadBar } from "./ThreadBar"

/**
 * The prompt box. In a thread it sends, queues while the agent works, and steers with ⌘↩.
 * Without a thread it is the new-thread composer: settings are chosen up front and the thread
 * is created (optionally in its own worktree) on first send.
 */

const MAX_ATTACHMENTS = 8
/** The last "Switch model" request a composer answered, so one that mounts later does not answer it again. */
let consumedModelMenu = 0
const NO_THREADS: readonly ThreadMeta[] = []
/** Threads listed under the files when `@` is typed. */
const MENTIONED_THREADS = 5
const MAX_HEIGHT = 320
/** Built-in commands plus project skills; the list scrolls. */
const MAX_COMMANDS = 48

interface NewConfig extends PickerValue {
  readonly mode: ThreadMode
  readonly permission: PermissionPreset
  readonly worktree: boolean
  readonly start: WorktreeStart
}

type Popup =
  | { readonly kind: "mention"; readonly query: string; readonly start: number }
  | { readonly kind: "slash"; readonly query: string }

interface Suggestion {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly icon: ReactNode
  readonly run: () => void
}

/**
 * Whether a turn takes guidance while it runs, as the engine says per backend (`turn.steer.live`):
 * Runrail's own loop, Claude Code while one of its tools runs, Codex through its own steer. An
 * engine from before that offers it on Runrail's own loop only; elsewhere it would be the next turn.
 */
export function steersMidTurn(backend: string | undefined, contract?: Contract): boolean {
  const status = contract?.capabilities["turn.steer.live"]
  if (status !== undefined) return status === "available"
  return backend === undefined || backend === "native"
}

function placeholderFor(mode: ThreadMode, busy: boolean, fresh: boolean, projectName?: string, canSteer = true): string {
  if (busy) return canSteer ? "Queue a follow-up, or steer the current turn" : "Queue a follow-up"
  if (mode === "plan") return "Describe what to plan. The agent reads, then proposes steps before changing anything."
  if (mode === "goal") return "Describe the goal. The agent keeps iterating until checks pass."
  if (fresh) return `Ask Runrail to build, fix, or explain anything${projectName === undefined ? "" : ` in ${projectName}`}`
  return "Ask for follow-up changes"
}

/**
 * Messages waiting for the turn to end: a card joined to the top of the box, the box's width.
 * Steer sends one now where the thread takes guidance mid-turn; clicking one puts it back in the box.
 */
export function QueueCard({ threadId, queue, paused, attaching = false, canSteer, steerKey, onEdit }: { readonly threadId: string; readonly queue: readonly QueuedPrompt[]; readonly paused: boolean; readonly attaching?: boolean; readonly canSteer: boolean; readonly steerKey: string; readonly onEdit: (item: QueuedPrompt) => void }) {
  if (queue.length === 0) return null
  return (
    <div className="queue-card" role="group" aria-label="Queued messages">
      {paused ? (
        <div className="queue-head is-paused">
          <TriangleAlert size={12} />
          <span className="queue-head-text">Queue paused. The last turn stopped or failed.</span>
          <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={() => resumeQueue(threadId)}>
            Resume
          </Button>
        </div>
      ) : (
        <div className="queue-head">
          <span className="queue-head-text">{queue.length === 1 ? "1 queued" : `${String(queue.length)} queued`}, {attaching ? "sent when the agent is ready" : "sent when this turn ends"}</span>
          <span className="queue-keys">
            {canSteer && (
              <>
                <Kbd keys={steerKey} /> steer ·{" "}
              </>
            )}
            <Kbd keys="escape" /> stop
          </span>
        </div>
      )}
      {queue.map((item) => (
        <div key={item.id} className="queue-item">
          <Clock size={12} className="queue-icon" aria-hidden="true" />
          <button
            type="button"
            className="queue-text"
            title={`${item.text.slice(0, 500)}\n\nClick to edit`}
            onClick={() => {
              const taken = editQueued(threadId, item.id)
              if (taken !== undefined) onEdit(taken)
            }}
          >
            {firstLine(item.text, 200) || `${String(item.attachments.length)} attachment(s)`}
          </button>
          {item.attachments.length > 0 && <span className="queue-attach">+{item.attachments.length}</span>}
          {canSteer && (
            <Button
              size="sm"
              variant="ghost"
              title="Send now and redirect the current turn"
              onClick={() => {
                removeQueued(threadId, item.id)
                void steer(threadId, { text: item.text, attachments: item.attachments })
              }}
            >
              Steer
            </Button>
          )}
          <IconButton size="sm" label="Delete queued message" onClick={() => removeQueued(threadId, item.id)}>
            <Trash size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

const NO_PAGE_COMMENTS: readonly PageComment[] = []

function PageCommentChip({ comment, onRemove }: { readonly comment: PageComment; readonly onRemove: () => void }) {
  const label = elementLabel(comment)
  return (
    <span className="composer-token is-comment" title={`${comment.url}${comment.width === undefined ? "" : ` at ${String(comment.width)} px wide`}\n${label}: ${comment.comment}`}>
      <MessageSquare size={12} />
      <span className="composer-token-name">
        {label}: {comment.comment}
      </span>
      <button type="button" className="chip-remove" aria-label={`Remove the comment on ${label}`} onClick={onRemove}>
        <X size={11} />
      </button>
    </span>
  )
}

function Strips({ threadId }: { readonly threadId: string }) {
  const runtime = useRuntime(threadId)
  const worktree = useApp((state) => state.threads.find((item) => item.id === threadId)?.worktree !== undefined)
  const [restarting, setRestarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const background = useBackground(useShallow((state) => (state[threadId]?.entries ?? []).filter(isRunning).map((entry) => (entry.stoppable ? 1 : 0))))
  const computing = useComputerActivity((state) => state[threadId])
  const place = computerPlace(useApp((state) => state.platform))
  const busy = isBusy(runtime.timeline)
  const strips: ReactNode[] = []
  // The agent is acting on the person's screen; one click takes it off.
  if (busy && computing !== undefined)
    strips.push(
      <div key="computer" className="strip is-computer" role="status">
        <AppWindowMac size={13} />
        <span className="strip-text">{computing.app === undefined ? `Using apps on ${place}` : `Using ${computing.app} on ${place}`}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setComputerUse(threadId, false)
            void cancel(threadId)
          }}
        >
          Stop
        </Button>
      </div>,
    )
  // Once the turn ends its Stop button goes; work it left running keeps one here.
  if (!busy && background.length > 0) {
    const stoppable = background.filter((value) => value === 1).length
    strips.push(
      <div key="background" className="strip is-background">
        <ListChecks size={13} />
        <span className="strip-text">{background.length === 1 ? "1 task running in the background" : `${String(background.length)} tasks running in the background`}</span>
        <Button size="sm" variant="ghost" onClick={() => openPanel(threadId, "tasks")}>
          View
        </Button>
        {stoppable > 0 && (
          <Button
            size="sm"
            variant="ghost"
            loading={stopping}
            onClick={() => {
              setStopping(true)
              void stopAllBackground(threadId)
                .then(({ failed }) => failed > 0 && toast("error", failed === 1 ? "A task could not be stopped" : `${String(failed)} tasks could not be stopped`))
                .finally(() => setStopping(false))
            }}
          >
            {stoppable === background.length ? "Stop all" : `Stop ${String(stoppable)}`}
          </Button>
        )}
      </div>,
    )
  }
  // A removed connection is named under the composer, where picking another model fixes it.
  if (runtime.engine === "failed" && runtime.engineError !== "CONNECTION_REMOVED")
    strips.push(
      <div key="engine" className="strip is-error" role="alert">
        <TriangleAlert size={13} />
        <span>{startFailureText(runtime.engineError, runtime.lastError, worktree)}</span>
        {runtime.engineError === "WORKSPACE_MISSING" ? (
          <Button size="sm" variant="ghost" onClick={() => void archiveWithUndo(threadId)}>
            Archive
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            loading={restarting}
            onClick={() => {
              setRestarting(true)
              void restartEngine(threadId).finally(() => setRestarting(false))
            }}
          >
            Retry
          </Button>
        )}
      </div>,
    )
  if (runtime.goal !== undefined && runtime.goal.status === "running")
    strips.push(
      <div key="goal" className="strip is-goal">
        <Target size={13} />
        <span className="strip-text">
          Goal · attempt {runtime.goal.iteration} of {runtime.goal.max} · <span className="muted">{firstLine(runtime.goal.objective, 80)}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => stopGoal(threadId)}>
          Stop goal
        </Button>
      </div>,
    )
  else if (runtime.goal !== undefined && runtime.goal.status !== "stopped")
    strips.push(
      <div key="goal" className={cx("strip", runtime.goal.status === "passed" ? "is-ok" : "is-warn")}>
        <Target size={13} />
        <span className="strip-text">{runtime.goal.status === "passed" ? `Goal reached after ${String(runtime.goal.iteration)} attempt(s)` : `Goal not reached after ${String(runtime.goal.max)} attempts`}</span>
        <IconButton size="sm" label="Dismiss" onClick={() => patchRuntime(threadId, { goal: undefined })}>
          <X size={12} />
        </IconButton>
      </div>,
    )
  if (runtime.restartPending)
    strips.push(
      <div key="restart" className="strip">
        <span className="strip-text">{busy ? "New settings apply when this turn ends." : "New settings apply when the background work ends."}</span>
        {!busy && (
          <Button
            size="sm"
            variant="ghost"
            loading={restarting}
            onClick={() =>
              confirmAction({
                title: "Apply the new settings now?",
                body: "The agent restarts, and the work it left running in the background stops.",
                confirm: "Restart",
                danger: true,
                onConfirm: () => {
                  setRestarting(true)
                  void restartEngine(threadId).finally(() => setRestarting(false))
                },
              })
            }
          >
            Apply now
          </Button>
        )}
      </div>,
    )
  if (runtime.lastError !== undefined && runtime.engine !== "failed")
    strips.push(
      <div key="error" className="strip is-error" role="alert">
        <TriangleAlert size={13} />
        <span className="strip-text">{runtime.lastError}</span>
        <IconButton size="sm" label="Dismiss" onClick={() => patchRuntime(threadId, { lastError: undefined })}>
          <X size={12} />
        </IconButton>
      </div>,
    )
  return strips.length === 0 ? null : <div className="strips">{strips}</div>
}

const NO_PASTES: readonly PastedBlock[] = []

const NEW_THREAD_GIT_AGE_MS = 15_000

export function Composer({ threadId, projectId }: { readonly threadId?: string; readonly projectId: string }) {
  const thread = useThread(threadId)
  const runtime = useRuntime(threadId)
  const canSteer = steersMidTurn(thread?.backend, runtime.contract)
  const steerFirst = useApp((state) => state.prefs.followUp === "steer") && canSteer
  const project = useProject(projectId)
  const catalog = useCatalog(projectId)
  const draftKey = threadId ?? `new:${projectId}`
  const text = useApp((state) => state.drafts[draftKey] ?? "")
  const { focusSignal, sendKey, prefs } = useApp(useShallow((state) => ({ focusSignal: state.focusComposer, sendKey: state.prefs.sendKey, prefs: state.prefs })))
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])
  const [tokens, setTokens] = useState<readonly ComposerToken[]>([])
  const pageComments = usePageComments((state) => (threadId === undefined ? NO_PAGE_COMMENTS : (state[threadId] ?? NO_PAGE_COMMENTS)))
  const [uploading, setUploading] = useState(0)
  const [creating, setCreating] = useState(false)
  const [popup, setPopup] = useState<Popup | undefined>()
  const [popupIndex, setPopupIndex] = useState(0)
  const popupRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    popupRef.current?.querySelector(".popup-item.is-active")?.scrollIntoView({ block: "nearest" })
  }, [popupIndex])
  // The branch moves outside the app, so a new thread's bar reads it again when it opens.
  useEffect(() => {
    if (threadId === undefined) void readProjectGit(projectId, NEW_THREAD_GIT_AGE_MS)
  }, [threadId, projectId])
  const [modelSignal, setModelSignal] = useState(0)
  const modelMenu = useApp((state) => state.modelMenu)
  useEffect(() => {
    if (modelMenu > consumedModelMenu && paneFocused(threadId)) {
      consumedModelMenu = modelMenu
      setModelSignal((value) => value + 1)
    }
  }, [modelMenu])
  const [dragging, setDragging] = useState(false)
  const [config, setConfig] = useState<NewConfig>(() => ({
    ...draftSelection(prefs),
    thinking: prefs.defaultThinking,
    mode: prefs.defaultMode,
    permission: prefs.defaultPermission,
    worktree: prefs.worktreeByDefault,
    start: HEAD_START,
  }))
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bytes = useRef(new Map<string, PreparedImage>())

  const running = threadId !== undefined && isBusy(runtime.timeline)
  // The thread's engine is starting: typing works, and a send goes once it is up.
  const attaching = threadId !== undefined && runtime.engine === "starting"
  const waiting = attaching && runtime.queue.length > 0
  const busy = running || attaching
  // Offered where the engine says its backend can compact: Runrail's own loop, Claude Code, Codex.
  const canCompact = hasCapability(runtime.contract, "session.compact")
  const mode = thread?.mode ?? config.mode
  const permission = thread?.permission ?? config.permission
  const backend = thread?.backend ?? config.backend
  const access = accessOf(mode, effectivePermission(permission, backend))
  const talkable = useTalkAvailable(threadId)
  const talking = useVoice((state) => threadId !== undefined && state.talking === threadId)
  const picker: PickerValue =
    thread === undefined
      ? config
      : { backend: thread.backend, ...(thread.model === undefined ? {} : { model: thread.model }), ...(thread.connectionId === undefined ? {} : { connectionId: thread.connectionId }), ...(thread.thinking === undefined ? {} : { thinking: thread.thinking }) }
  // Until the connections are read, only a missing model can be told; a removed or expired connection shows once they are.
  const connections = catalog.loading || catalog.connectionsError !== undefined ? undefined : catalog.connections
  const problem = selectionProblem(picker, connections, prefs.developer, connections === undefined ? undefined : catalog.tools)
  const connected = anyConnected(catalog)
  const hint = problem === undefined ? undefined : problemHint(problem, connected)
  const listedWindow = thread?.backend === "native" ? catalog.models.find((model) => model.id === thread.model && model.connectionId === thread.connectionId)?.contextTokens : undefined
  /** Set once the model was picked by hand, so the starting model never replaces a choice. */
  const touched = useRef(false)

  // A new thread starts on a model that can run: the last one used, else the first one a connection offers.
  useEffect(() => {
    if (threadId !== undefined || touched.current || connections === undefined) return
    if (problem !== "no-model" && problem !== "connection-removed") return
    const start = defaultSelection(catalog, get().prefs.recentModels)
    // With nothing to fall back on, a remembered model whose connection is gone is dropped: a new thread has no model, not a broken one.
    // The draft only: the saved start default changes when the person picks a model, not on its own.
    if (start !== undefined || problem === "connection-removed") setConfig((current) => ({ ...current, backend: start?.backend ?? "native", model: start?.model, connectionId: start?.connectionId }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, problem, connections, catalog.models, catalog.tools, catalog.harnesses])
  // The defaults can change under an open new thread (Settings, a removed connection). The draft follows them.
  const startKey = `${prefs.defaultBackend}|${prefs.defaultConnectionId ?? ""}|${prefs.defaultModel ?? ""}|${prefs.defaultToolConnectionId ?? ""}|${prefs.defaultToolModel ?? ""}`
  const followed = useRef(startKey)
  useEffect(() => {
    if (followed.current === startKey) return
    followed.current = startKey
    if (threadId !== undefined || sitsOnDefault(config, prefs)) return
    const start = draftSelection(prefs)
    touched.current = false
    setConfig((current) => ({ ...current, backend: start.backend, model: start.model, connectionId: start.connectionId }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey])
  useEffect(() => setConfig((current) => (current.thinking === prefs.defaultThinking ? current : { ...current, thinking: prefs.defaultThinking })), [prefs.defaultThinking])
  const files = useFiles(threadId, projectId, popup?.kind === "mention")

  const setText = useCallback((value: string) => set((state) => ({ drafts: { ...state.drafts, [draftKey]: value } })), [draftKey])
  const pastes = useApp((state) => state.pastes[draftKey] ?? NO_PASTES)
  const clearPastes = (): void =>
    set((state) => {
      const next = { ...state.pastes }
      delete next[draftKey]
      return { pastes: next }
    })

  // Attachments, skills, and subagents belong to one draft. A picture left unsent in another draft
  // lets go of its preview; a sent one keeps it, since its message shows it.
  const unsent = useRef<readonly Attachment[]>([])
  unsent.current = attachments
  useEffect(() => {
    for (const attachment of unsent.current) if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
    setAttachments([])
    setTokens([])
    setPopup(undefined)
  }, [draftKey])

  // Declared after the reset above, so an Edit's attachments land on the draft it opened.
  const restored = useApp((state) => state.editAttachments[draftKey])
  useEffect(() => {
    if (restored === undefined) return
    setAttachments((current) => [...current, ...restored].slice(0, MAX_ATTACHMENTS))
    set((state) => {
      const next = { ...state.editAttachments }
      delete next[draftKey]
      return { editAttachments: next }
    })
  }, [restored, draftKey])

  useEffect(() => {
    // With threads side by side, only the focused pane's composer takes the focus.
    if (paneFocused(threadId)) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal, draftKey])

  useLayoutEffect(() => {
    const element = inputRef.current
    if (element === null) return
    element.style.height = "auto"
    element.style.height = `${String(Math.min(element.scrollHeight, MAX_HEIGHT))}px`
  }, [text])

  // Settings setters work on the thread when there is one, otherwise on the new-thread config.
  const chooseMode = (value: ThreadMode): void => (threadId === undefined ? setConfig((current) => ({ ...current, mode: value })) : setMode(threadId, value))
  const chooseAccess = (value: Access): void => (threadId === undefined ? setConfig((current) => ({ ...current, ...withAccess(current, value) })) : setAccess(threadId, value))
  const chooseGoal = (on: boolean): void => chooseMode(on ? "goal" : "agent")
  const addToken = (token: ComposerToken): void => {
    setTokens((current) => (current.some((item) => item.kind === token.kind && item.id === token.id) ? current : [...current, token]))
    inputRef.current?.focus()
  }
  /** A file's path at the caret, or with none, an `@` that opens the file list. */
  const mention = (path?: string): void => {
    const element = inputRef.current
    const caret = element?.selectionStart ?? text.length
    const spacer = caret > 0 && !/\s$/.test(text.slice(0, caret)) ? " " : ""
    const insert = path === undefined ? "@" : `${mentionOf(path)} `
    const next = `${text.slice(0, caret)}${spacer}${insert}${text.slice(caret)}`
    const position = caret + spacer.length + insert.length
    setText(next)
    if (path === undefined) detectPopup(next, position)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(position, position)
    })
  }
  const remember = (model: string, connectionId: string): void => setPrefs({ recentModels: pushRecent(get().prefs.recentModels, { model, connectionId }) })
  const pickModel = (selection: Selection): void => {
    const kept = carried(selection)
    // Recents and stars list connected models only; a tool connection is not one.
    const bound = selection.backend === "native" && kept.model !== undefined && kept.connectionId !== undefined ? { model: kept.model, connectionId: kept.connectionId } : undefined
    if (threadId === undefined) {
      touched.current = true
      setConfig((current) => ({ ...current, backend: selection.backend, model: kept.model, connectionId: kept.connectionId }))
      // The next new thread starts where this one did. A recorded session is never a default.
      setStartDefault(selection)
      if (bound !== undefined) remember(bound.model, bound.connectionId)
      return
    }
    const change = classifyPick(picker, selection)
    if (change === "same") return
    if (change === "model") {
      // Same agent loop, or the same coding tool, with another model: the conversation carries on.
      setModel(threadId, { model: kept.model, ...(kept.connectionId === undefined ? {} : { connectionId: kept.connectionId }) })
      if (bound !== undefined) remember(bound.model, bound.connectionId)
      return
    }
    if (!threadHasHistory(threadId)) {
      setSelection(threadId, selection)
      if (bound !== undefined) remember(bound.model, bound.connectionId)
      return
    }
    // A coding tool keeps its own session, so the thread moves to a new one and the conversation goes along.
    const target = selectionLabel(selection, prefs.developer, catalog.models, catalog.harnesses)
    confirmAction({
      title: `Continue with ${target} in a new thread?`,
      body: `Codex and Claude Code keep separate vendor sessions, so ${target} cannot resume this thread's current session directly. The conversation stays here, on ${selectionLabel(picker, prefs.developer, catalog.models, catalog.harnesses)}, while ${target} continues it in a fresh thread in the same folder, with the same mode and permissions and with the conversation so far. A message you have typed but not sent moves with you.`,
      confirm: "Continue in a new thread",
      onConfirm: () => {
        if (continueInNewThread(threadId, selection) !== undefined && bound !== undefined) remember(bound.model, bound.connectionId)
      },
    })
  }
  const chooseThinking = (thinking: Thinking): void => (threadId === undefined ? setConfig((current) => ({ ...current, thinking })) : setModel(threadId, undefined, thinking))

  const workspace = threadId === undefined ? project?.path : workspaceOf(threadId)

  const addFiles = async (list: readonly File[]): Promise<void> => {
    const images = list.filter(isImage)
    if (images.length < list.length) toast("info", "Only PNG, JPEG, WebP, and GIF images can be attached.")
    if (workspace === undefined || images.length === 0) return
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      toast("info", `Up to ${String(MAX_ATTACHMENTS)} attachments per message.`)
      return
    }
    const batch = images.slice(0, room)
    setUploading((value) => value + batch.length)
    for (const file of batch) {
      try {
        const prepared = await prepareImage(file)
        const path = await getHost().attachmentSave(workspace, prepared.mediaType, prepared.data)
        const id = newId("a")
        bytes.current.set(id, prepared)
        setAttachments((current) => [...current, { id, path, kind: "image", name: file.name || "Pasted image", mediaType: prepared.mediaType, previewUrl: prepared.previewUrl }])
      } catch (error) {
        toast("error", `Could not attach ${file.name || "image"}: ${toHostError(error).message}`)
      } finally {
        setUploading((value) => value - 1)
      }
    }
  }

  const removeAttachment = (id: string): void => {
    bytes.current.delete(id)
    const removed = attachments.find((item) => item.id === id)?.previewUrl
    if (removed !== undefined) URL.revokeObjectURL(removed)
    setAttachments((current) => current.filter((item) => item.id !== id))
  }

  // ------------------------------------------------------------------------------------------
  // Slash commands and mentions

  const runnables = useRunnables(projectId, popup?.kind === "slash" && project?.git === true)
  const commands = useMemo((): Suggestion[] => {
    const list: Suggestion[] = [
      { id: "plan", label: "/plan", detail: mode === "plan" ? "Leave Plan: back to your permissions" : "Plan: read and propose, change nothing", icon: <Slash size={13} />, run: () => chooseAccess(mode === "plan" ? permission : "plan") },
      { id: "goal", label: "/goal", detail: mode === "goal" ? "Stop working toward a goal" : "Work until the goal's checks pass", icon: <Slash size={13} />, run: () => chooseGoal(mode !== "goal") },
      { id: "model", label: "/model", detail: "Change model or reasoning", icon: <Slash size={13} />, run: () => setModelSignal((value) => value + 1) },
      { id: "review", label: "/review", detail: "Open the review pane", icon: <Slash size={13} />, run: () => openPanelHere("review") },
      { id: "terminal", label: "/terminal", detail: "Open a terminal", icon: <Slash size={13} />, run: () => openPanelHere("terminal") },
      { id: "files", label: "/files", detail: "Browse project files", icon: <Slash size={13} />, run: () => openPanelHere("files") },
      { id: "new", label: "/new", detail: "Start a new thread", icon: <Slash size={13} />, run: () => startNewThread(projectId) },
    ]
    if (project?.git === true) list.push({ id: "best-of", label: "/best-of", detail: "Run this task on several models and compare", icon: <Slash size={13} />, run: () => openDialog({ kind: "best-of-n", projectId }) })
    list.push({ id: "import", label: "/import", detail: "Import sessions from other coding tools", icon: <Slash size={13} />, run: () => openDialog({ kind: "import", projectId }) })
    if (threadId !== undefined) {
      if (canCompact) list.push({ id: "compact", label: "/compact", detail: "Summarize context to free up room", icon: <Slash size={13} />, run: () => void compactThread(threadId) })
      if (shareOffered(prefs.developer)) list.push({ id: "share", label: "/share", detail: "Make a content-free share record of this thread", icon: <Slash size={13} />, run: () => openDialog({ kind: "share", threadId }) })
    }
    // Saved setups run on the message; saved workflows start at once. Both come before skills.
    const free = (label: string): boolean => !list.some((item) => item.label === label)
    for (const setup of runnables.setups) {
      const label = `/${commandName(setup.name)}`
      if (free(label)) list.push({ id: `setup:${setup.id}`, label, detail: `Run the ${setup.name} setup on your message`, icon: <Bot size={13} />, run: () => setTokens((current) => [...current.filter((token) => token.kind !== "setup"), { kind: "setup", id: setup.id, name: setup.name }]) })
    }
    for (const workflow of runnables.workflows) {
      const label = `/${commandName(workflow.name)}`
      if (free(label)) list.push({ id: `workflow:${workflow.id}`, label, detail: `Run the ${workflow.name} workflow now`, icon: <Workflow size={13} />, run: () => void runWorkflowNow(projectId, workflow) })
    }
    for (const skill of catalog.skills) {
      if (skill.enabled === false) continue
      const name = skill.name ?? skill.id
      list.push({ id: `skill:${skill.id}`, label: `/${name}`, detail: skill.description ?? "Skill", icon: <Zap size={13} />, run: () => addToken({ kind: "skill", id: skill.id, name }) })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, projectId, project?.git, catalog.skills, setText, prefs.developer, mode, permission, canCompact, runnables])

  const others = useApp((state) => (popup?.kind === "mention" ? state.threads : NO_THREADS))
  const suggestions = useMemo((): Suggestion[] => {
    if (popup === undefined) return []
    if (popup.kind === "slash") return rank(popup.query, commands, (item) => item.label.slice(1), MAX_COMMANDS)
    // Other threads, those of this project first, add their context to the message as a chip.
    const candidates = others.filter((other) => other.id !== threadId && other.archived !== true && other.titled)
    const ordered = [...candidates.filter((other) => other.projectId === projectId), ...candidates.filter((other) => other.projectId !== projectId)]
    const threads = rank(popup.query, ordered, (other) => other.title, MENTIONED_THREADS).map((other) => ({
      id: `thread:${other.id}`,
      label: other.title,
      detail: "Thread",
      icon: <MessagesSquare size={13} />,
      run: () => {
        const element = inputRef.current
        const caret = element?.selectionStart ?? text.length
        setText(`${text.slice(0, popup.start)}${text.slice(caret)}`)
        addToken({ kind: "thread", id: other.id, name: other.title })
        requestAnimationFrame(() => element?.setSelectionRange(popup.start, popup.start))
      },
    }))
    const paths = rank(popup.query, files.entries, (entry) => entry.path, 10).map((entry) => ({
      id: entry.path,
      label: entry.path,
      icon: entry.type === "directory" ? <Folder size={13} /> : <File size={13} />,
      run: () => {
        const element = inputRef.current
        const caret = element?.selectionStart ?? text.length
        const insert = `${mentionOf(`${entry.path}${entry.type === "directory" ? "/" : ""}`)} `
        const next = `${text.slice(0, popup.start)}${insert}${text.slice(caret)}`
        setText(next)
        requestAnimationFrame(() => {
          const position = popup.start + insert.length
          element?.setSelectionRange(position, position)
        })
      },
    }))
    return [...paths, ...threads]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup, commands, files.entries, text, setText, others, threadId, projectId])

  const detectPopup = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const slash = /^\/([\w-]*)$/.exec(before)
    if (slash !== null) {
      const query = slash[1] ?? ""
      // A caret event with the same query must not move the highlight back to the top.
      if (popup?.kind === "slash" && popup.query === query) return
      setPopup({ kind: "slash", query })
      setPopupIndex(0)
      return
    }
    const mention = /(^|\s)@([^\s@]*)$/.exec(before)
    if (mention !== null) {
      const query = mention[2] ?? ""
      const start = caret - query.length - 1
      if (popup?.kind === "mention" && popup.query === query && popup.start === start) return
      setPopup({ kind: "mention", query, start })
      setPopupIndex(0)
      return
    }
    setPopup(undefined)
  }

  const choose = (suggestion: Suggestion): void => {
    if (popup?.kind === "slash") setText("")
    setPopup(undefined)
    suggestion.run()
    inputRef.current?.focus()
  }

  // ------------------------------------------------------------------------------------------
  // Submit

  /** `fromStore` reads the draft as stored, for dictation that wrote it since this render. */
  const submit = async (intent: "send" | "steer", fromStore = false): Promise<void> => {
    const value = expandPastes(fromStore ? (get().drafts[draftKey] ?? "") : text, pastes).trim()
    if ((value.length === 0 && attachments.length === 0 && pageComments.length === 0) || uploading > 0 || creating) return
    const exact = value.startsWith("/") && !value.includes(" ") ? commands.find((command) => command.label === value) : undefined
    if (exact !== undefined) {
      setText("")
      exact.run()
      return
    }
    const setupToken = tokens.find((token) => token.kind === "setup")
    if (setupToken !== undefined) {
      if (value.length === 0 || project === undefined) {
        toast("info", `Describe the task for ${setupToken.name}, then send it`)
        return
      }
      setText("")
      setTokens([])
      // A new thread's Local checkout choice holds for the run; from a thread it gets its own worktree.
      void runSetupOn(project, setupToken, value, threadId === undefined && !config.worktree)
      return
    }
    if (problem !== undefined) {
      setModelSignal((signal) => signal + 1)
      return
    }
    const outgoing = attachments
    const skills = tokens.flatMap((token) => (token.kind === "skill" ? [token.id] : []))
    const asked = tokens.flatMap((token) => (token.kind === "agent" ? [`Use the ${token.id} subagent.`] : [])).join(" ")
    const words = asked.length === 0 ? value : value.length === 0 ? asked : `${asked}\n\n${value}`
    const mentioned = tokens.filter((token) => token.kind === "thread")
    // The bubble hides what follows the words, so a message of context alone would show as empty.
    if (mentioned.length > 0 && words.length === 0) {
      toast("info", `Say what to do with ${mentioned.map((token) => token.name).join(", ")}, then send it`)
      return
    }
    const contexts = await Promise.all(mentioned.map(async (token) => ({ name: token.name, block: await threadContext(token.id).catch(() => undefined) })))
    const empty = contexts.filter((context) => context.block === undefined).map((context) => context.name)
    if (empty.length > 0) toast("info", `Nothing to add from ${empty.join(", ")}: it has no conversation yet.`)
    const withContexts = contexts.reduce((text, context) => (context.block === undefined ? text : `${text}\n\n${context.block}`), words)
    // Comments on page elements go with this message, after the person's words.
    const message = pageComments.length === 0 ? withContexts : [withContexts, pageCommentsBlock(pageComments)].filter((part) => part.length > 0).join("\n\n")
    if (threadId === undefined) {
      if (project === undefined) return
      setCreating(true)
      try {
        const input = {
          projectId,
          backend: config.backend,
          ...(config.model === undefined ? {} : { model: config.model, ...(config.connectionId === undefined ? {} : { connectionId: config.connectionId }) }),
          ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
          mode: config.mode,
          permission: config.permission,
        }
        const created = config.worktree && project.git ? await createWorktreeThread(input, config.start, { firstMessage: value }) : createThread(input)
        if (config.backend === "native" && config.model !== undefined && config.connectionId !== undefined) remember(config.model, config.connectionId)
        let moved = outgoing
        // Images were written to the project root; a worktree thread needs them in its own tree.
        if (created.worktree !== undefined && outgoing.length > 0) {
          moved = await Promise.all(
            outgoing.map(async (attachment) => {
              const data = bytes.current.get(attachment.id)
              if (data === undefined || created.worktree === undefined) return attachment
              return { ...attachment, path: await getHost().attachmentSave(created.worktree.cwd, data.mediaType, data.data) }
            }),
          )
        }
        set((state) => {
          const drafts = { ...state.drafts }
          delete drafts[draftKey]
          const folded = { ...state.pastes }
          delete folded[draftKey]
          return { drafts, pastes: folded }
        })
        setAttachments([])
        setTokens([])
        bytes.current.clear()
        send(created.id, { text: message, attachments: moved, skills })
      } catch (error) {
        toast("error", `Could not start the thread: ${toHostError(error).message}`)
      } finally {
        setCreating(false)
      }
      return
    }
    setText("")
    clearPastes()
    setAttachments([])
    setTokens([])
    clearPageComments(threadId)
    bytes.current.clear()
    if (intent === "steer" && running && canSteer) await steer(threadId, { text: message, attachments: outgoing, skills })
    else send(threadId, { text: message, attachments: outgoing, skills })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (popup !== undefined && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        setPopupIndex((index) => (index + delta + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        const chosen = suggestions[popupIndex]
        if (chosen !== undefined) choose(chosen)
        return
      }
    }
    if (event.key === "Tab" && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      chooseAccess(nextAccess(access))
      return
    }
    if (event.key === "Escape") {
      if (popup !== undefined) {
        event.preventDefault()
        setPopup(undefined)
        return
      }
      // A panel over the thread closes first; the next Escape stops the turn.
      if (closeCoveringPanel()) {
        event.preventDefault()
        return
      }
      const voice = useVoice.getState()
      if (voice.listening === draftKey || voice.speaking !== undefined || (threadId !== undefined && voice.talking === threadId)) {
        event.preventDefault()
        stopTalking()
        stopListening()
        stopSpeaking()
        return
      }
      if (running && threadId !== undefined) {
        event.preventDefault()
        void cancel(threadId)
      }
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const mod = event.metaKey || event.ctrlKey
      // Nothing to send: leave the key to a pending approval.
      if (mod && text.trim().length === 0 && attachments.length === 0) return
      // Settings can make the send key steer and the other key queue.
      const other = sendKey === "enter" ? mod : event.altKey
      if (sendKey === "enter" || mod) {
        event.preventDefault()
        void submit(other === steerFirst ? "send" : "steer")
      }
      return
    }
    if (event.key === "ArrowUp" && text.length === 0 && threadId !== undefined) {
      const last = runtime.queue[runtime.queue.length - 1]
      if (last !== undefined) {
        event.preventDefault()
        const taken = editQueued(threadId, last.id)
        if (taken !== undefined) restoreQueued(taken)
      }
    }
  }

  const restoreQueued = (item: QueuedPrompt): void => {
    setText(item.text)
    setAttachments(item.attachments)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = Array.from(event.clipboardData.files)
    if (pasted.length > 0) {
      event.preventDefault()
      void addFiles(pasted)
      return
    }
    const pastedText = event.clipboardData.getData("text/plain")
    if (!shouldFold(pastedText, prefs.pasteThreshold)) return
    event.preventDefault()
    const block = { id: nextPasteId(pastes), text: pastedText }
    const input = event.currentTarget
    const placeholder = pastePlaceholder(block)
    const next = `${text.slice(0, input.selectionStart)}${placeholder}${text.slice(input.selectionEnd)}`
    const caret = input.selectionStart + placeholder.length
    set((state) => ({ drafts: { ...state.drafts, [draftKey]: next }, pastes: { ...state.pastes, [draftKey]: [...(state.pastes[draftKey] ?? []), block] } }))
    requestAnimationFrame(() => input.setSelectionRange(caret, caret))
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const dropped = Array.from(event.dataTransfer.files)
    if (dropped.length > 0) void addFiles(dropped)
  }

  const empty = text.trim().length === 0 && attachments.length === 0 && pageComments.length === 0
  const sendHint = sendKey === "enter" ? "enter" : "mod+enter"
  const otherKey = sendKey === "enter" ? "mod+enter" : "mod+alt+enter"
  const steerKey = steerFirst ? sendHint : otherKey
  const queueKey = steerFirst ? otherKey : sendHint

  return (
    <div className="composer-wrap">
      {threadId !== undefined && <Strips threadId={threadId} />}
      {threadId !== undefined && <ThreadBar threadId={threadId} />}
      {threadId === undefined && project?.git === true && (
        <div className="thread-bar" role="toolbar" aria-label="Git">
          <RepoMark project={project} />
          <WorktreeMenu projectId={projectId} value={config} onChange={(choice) => setConfig((current) => ({ ...current, ...choice }))} />
        </div>
      )}
      <div className="composer-stack">
        {threadId !== undefined && <QueueCard threadId={threadId} queue={runtime.queue} paused={runtime.queuePaused} attaching={attaching} canSteer={canSteer && running} steerKey={steerKey} onEdit={restoreQueued} />}
        <div
          className={cx("composer", dragging && "is-dragging", running && "is-busy")}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {popup !== undefined && (
            <div ref={popupRef} className="composer-popup" role="listbox" aria-label={popup.kind === "slash" ? "Commands" : "Files"}>
              {popup.kind === "mention" && files.loading && suggestions.length === 0 && (
                <div className="popup-empty">
                  <Spinner size={12} /> Indexing files…
                </div>
              )}
              {!(popup.kind === "mention" && files.loading) && suggestions.length === 0 && (
                <div className="popup-empty">{popup.kind === "slash" ? "No matching commands" : files.error !== undefined ? `Files unavailable: ${files.error}` : "No matching files"}</div>
              )}
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  type="button"
                  role="option"
                  aria-selected={index === popupIndex}
                  className={cx("popup-item", index === popupIndex && "is-active")}
                  onMouseEnter={() => setPopupIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(suggestion)
                  }}
                >
                  <span className="popup-icon">{suggestion.icon}</span>
                  <span className="popup-label">{suggestion.label}</span>
                  {suggestion.detail !== undefined && <span className="popup-detail">{suggestion.detail}</span>}
                </button>
              ))}
            </div>
          )}
          {(attachments.length > 0 || uploading > 0 || tokens.length > 0 || pageComments.length > 0) && (
            <div className="composer-attachments">
              {tokens.map((token) => (
                <TokenChip key={`${token.kind}:${token.id}`} token={token} onRemove={() => setTokens((current) => current.filter((item) => item !== token))} />
              ))}
              {threadId !== undefined && pageComments.map((comment) => <PageCommentChip key={comment.id} comment={comment} onRemove={() => removePageComment(threadId, comment.id)} />)}
              {attachments.map((attachment) => (
                <div key={attachment.id} className="attachment">
                  {attachment.previewUrl !== undefined ? <img src={attachment.previewUrl} alt={attachment.name} /> : <File size={14} />}
                  <span className="attachment-name">{attachment.name}</span>
                  <button type="button" className="attachment-remove" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                    <X size={11} />
                  </button>
                </div>
              ))}
              {uploading > 0 && (
                <div className="attachment is-loading">
                  <Spinner size={12} /> Preparing…
                </div>
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={text}
            maxLength={200_000}
            placeholder={placeholderFor(mode, running, threadId === undefined, project?.name, canSteer)}
            aria-label="Message"
            spellCheck
            onChange={(event) => {
              setText(event.target.value)
              detectPopup(event.target.value, event.target.selectionStart)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTimeout(() => setPopup(undefined), 120)}
            onSelect={(event) => {
              if (popup !== undefined) detectPopup(event.currentTarget.value, event.currentTarget.selectionStart)
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <AddMenu
                projectId={projectId}
                threadId={threadId}
                backend={backend}
                catalog={catalog}
                tokens={tokens}
                goal={mode === "goal"}
                imagesFull={attachments.length >= MAX_ATTACHMENTS}
                onImages={() => fileRef.current?.click()}
                onMention={mention}
                onToken={addToken}
                onGoal={chooseGoal}
                {...(project?.git === true ? { onBestOf: () => openDialog({ kind: "best-of-n", projectId }) } : {})}
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? [])
                  event.target.value = ""
                  void addFiles(picked)
                }}
              />
              <AccessMenu access={access} backend={backend} onChoose={chooseAccess} />
              {mode === "goal" && <GoalChip onOff={() => chooseGoal(false)} />}
            </div>
            <div className="composer-send">
              {threadId !== undefined && <ContextRing threadId={threadId} backend={thread?.backend} model={thread?.model} usage={runtime.timeline.context} fallbackWindow={listedWindow} compaction={!canCompact ? undefined : runtime.compacting === true ? "compacting" : busy ? "busy" : "ready"} />}
              <ModelPicker catalog={catalog} value={picker} problem={problem} busy={busy} openSignal={modelSignal} onPick={pickModel} onThinking={chooseThinking} />
              <MicButton draftKey={draftKey} {...(threadId === undefined ? {} : { threadId })} busy={busy} onSend={() => void submit("send", true)} onFocus={() => inputRef.current?.focus()} />
              {running && !empty && canSteer && (
                <Button size="sm" variant="ghost" onClick={() => void submit("steer")} kbd={steerKey} title="Send now and redirect the current turn">
                  Steer
                </Button>
              )}
              {threadId !== undefined && talkable && (talking || (empty && !busy)) ? (
                <TalkButton threadId={threadId} draftKey={draftKey} />
              ) : running && empty ? (
                <IconButton label="Stop" kbd="escape" className="send-button is-stop" onClick={() => threadId !== undefined && void cancel(threadId)}>
                  <Square size={12} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton label={hint !== undefined ? (problem === "no-model" ? hint : "Pick a model to send") : running ? "Queue" : waiting ? "Sends when the agent is ready" : "Send"} kbd={running ? queueKey : sendHint} className="send-button" disabled={empty || uploading > 0 || creating} onClick={() => void submit("send")}>
                  {creating || waiting ? <Spinner size={14} /> : <ArrowUp size={16} />}
                </IconButton>
              )}
            </div>
          </div>
        </div>
      </div>
      {hint !== undefined ? (
        <div className="composer-hint is-warn" role="status">
          <span className="composer-hint-warn">{hint}</span>
          {(problem === "connection-removed" || (problem === "no-model" && !connected)) && (
            <Button size="sm" variant="ghost" onClick={() => connectModel(picker.backend === "native" ? {} : { tool: picker.backend })}>
              Connect
            </Button>
          )}
        </div>
      ) : (
        <div className="composer-hint" aria-hidden="true" />
      )}
    </div>
  )
}

/** A file named in a message. A path with a space is quoted, so the model reads all of it as one path. */
export function mentionOf(path: string): string {
  return /\s/.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`
}
