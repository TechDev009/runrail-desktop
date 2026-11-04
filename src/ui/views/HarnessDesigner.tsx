import { ArrowUp, FolderPlus, LoaderCircle, MessageCircle, Plug, Sparkles, Square } from "lucide-react"
import { useEffect, useMemo, useState, type ChangeEvent } from "react"
import { connectModel, openDialog } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import { assistantText, designerPrompt, MAX_AI_DESCRIPTION_LENGTH, MAX_AI_REQUEST_BYTES, MAX_AI_SOURCE_BYTES, parseGeneratedScreen } from "../../app/customScreenDesigner"
import { cancel, send } from "../../app/engines"
import { anyConnected, selectionProblem } from "../../app/picker"
import type { CustomScreen } from "../../app/persist"
import { createThread, openThread, runtimeOf, set, setCustomScreen, startSelection, useApp } from "../../app/store"
import { isBusy, pendingApprovals } from "../../thread/reducer"
import { Button } from "../common"

export function HarnessDesigner({ screen }: { readonly screen: CustomScreen }) {
  const projects = useApp((state) => state.projects)
  const activeProjectId = useApp((state) => state.layout.activeProjectId ?? state.projects[0]?.id)
  const prefs = useApp((state) => state.prefs)
  const projectId = projects.some((project) => project.id === screen.designerProjectId)
    ? screen.designerProjectId
    : activeProjectId
  const project = projects.find((item) => item.id === projectId)
  const catalog = useCatalog(projectId)
  const selection = useMemo(() => startSelection(prefs), [prefs])
  const modelProblem = catalog.loading ? undefined : selectionProblem(selection, catalog.connections, prefs.developer, catalog.tools)
  const modelReady = !catalog.loading && modelProblem === undefined
  const designerThread = useApp((state) => state.threads.find((thread) => thread.id === screen.designerThreadId))
  const runtime = useApp((state) => screen.designerThreadId === undefined ? undefined : state.runtime[screen.designerThreadId])
  const [description, setDescription] = useState("")
  const [message, setMessage] = useState<string>()
  const sourceBytes = sourceSize(screen)
  const sourceTooLarge = sourceBytes > MAX_AI_SOURCE_BYTES
  const generating = screen.designerPending === true
  const busy = runtime !== undefined && isBusy(runtime.timeline)
  const approvals = runtime === undefined ? [] : pendingApprovals(runtime.timeline)
  const usableThread = designerThread !== undefined && designerThread.archived !== true && designerThread.projectId === projectId
    ? designerThread
    : undefined

  useEffect(() => {
    if (screen.designerPending !== true || screen.designerThreadId === undefined || runtime === undefined) return
    if (designerThread === undefined || designerThread.archived === true) {
      setCustomScreen({ designerPending: false, designerPendingAfterTurnId: undefined, designerPendingStartedAt: undefined })
      setMessage("The AI conversation is no longer available. Start a new request to continue designing this screen.")
      return
    }
    const timeline = runtime.timeline
    const end = timeline.lastTurnEnd
    if (end !== undefined && end.turnId !== screen.designerPendingAfterTurnId) {
      if (end.status === "completed") {
        const text = assistantText(timeline, end.turnId)
        const parsed = parseGeneratedScreen(text)
        if (parsed.ok) {
          setCustomScreen({
            ...parsed.screen,
            designerPending: false,
            designerPendingAfterTurnId: undefined,
            designerPendingStartedAt: undefined,
          })
          setMessage("Your screen is ready. Describe another change whenever you want to refine it.")
        } else {
          setCustomScreen({ designerPending: false, designerPendingAfterTurnId: undefined, designerPendingStartedAt: undefined })
          setMessage(parsed.reason)
        }
      } else {
        setCustomScreen({ designerPending: false, designerPendingAfterTurnId: undefined, designerPendingStartedAt: undefined })
        setMessage(end.status === "stopped" ? "Screen generation was stopped." : "The AI couldn't finish this screen. Open its conversation to see the error and try again.")
      }
      return
    }

    const failedRequest = [...timeline.items].reverse().find((item) =>
      item.kind === "user" && item.state === "failed" && item.at >= (screen.designerPendingStartedAt ?? 0),
    )
    if (!busy && failedRequest?.kind === "user") {
      setCustomScreen({ designerPending: false, designerPendingAfterTurnId: undefined, designerPendingStartedAt: undefined })
      setMessage(failedRequest.errorMessage ?? runtime.lastError ?? "The AI request did not start. Check the model connection and try again.")
    }
  }, [busy, designerThread, runtime, screen.designerPending, screen.designerPendingAfterTurnId, screen.designerPendingStartedAt, screen.designerThreadId])

  const chooseProject = (nextProjectId: string): void => {
    setCustomScreen({
      designerProjectId: nextProjectId,
      designerThreadId: undefined,
      designerPending: false,
      designerPendingAfterTurnId: undefined,
      designerPendingStartedAt: undefined,
    })
    setMessage(undefined)
  }

  const submit = (): void => {
    const request = description.trim()
    if (request.length === 0 || project === undefined || !modelReady || generating || sourceTooLarge) return
    if (new TextEncoder().encode(request).byteLength + sourceBytes > MAX_AI_REQUEST_BYTES) {
      setMessage("This request and screen source exceed the AI input limit. Shorten the description or reduce the screen in Edit code.")
      return
    }

    let prompt: string
    try {
      prompt = designerPrompt(request, project.name, screen)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "This screen is too large to include in an AI request.")
      return
    }

    let thread = usableThread
    if (thread === undefined) {
      thread = createThread({
        projectId: project.id,
        backend: selection.backend,
        ...(selection.model === undefined ? {} : { model: selection.model }),
        ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }),
        mode: "agent",
        permission: "ask",
        title: "Screen designer",
        select: false,
      })
    }

    const before = runtimeOf(thread.id).timeline.lastTurnEnd?.turnId
    setCustomScreen({
      designerThreadId: thread.id,
      designerProjectId: project.id,
      designerPending: true,
      designerPendingAfterTurnId: before,
      designerPendingStartedAt: Date.now(),
    })
    setMessage(undefined)
    setDescription("")
    send(thread.id, { text: prompt })
  }

  const openModelSettings = (): void => {
    if (anyConnected(catalog) && modelProblem === "no-model") set({ settings: "models" })
    else connectModel()
  }

  const selectProject = (event: ChangeEvent<HTMLSelectElement>): void => chooseProject(event.currentTarget.value)

  return (
    <aside className="custom-screen-designer" aria-label="AI screen designer">
      <div className="custom-screen-designer-main">
        <div className="custom-screen-designer-kicker"><Sparkles size={14} aria-hidden /> AI BUILDER</div>
        <h2>What should this screen do?</h2>
        <p className="custom-screen-designer-intro">Describe the screen you want. Runrail's AI builds it here, then you can keep refining it in plain language.</p>

        <label className="custom-screen-project-picker">
          <span>Build for project</span>
          {projects.length > 0 ? (
            <select value={projectId ?? ""} onChange={selectProject} disabled={generating}>
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          ) : (
            <span className="custom-screen-project-empty">Choose a project to give the AI its workspace context.</span>
          )}
        </label>

        <label className="custom-screen-prompt-label" htmlFor="screen-description">Describe your screen</label>
        <textarea
          id="screen-description"
          className="custom-screen-prompt"
          value={description}
          maxLength={MAX_AI_DESCRIPTION_LENGTH}
          onChange={(event) => setDescription(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="For example: Make a project cockpit with active runs, approvals that need me, and quick links to Files and Workflows."
          disabled={generating}
        />
        <div className="custom-screen-prompt-footer">
          <span>{description.length.toLocaleString()} / {MAX_AI_DESCRIPTION_LENGTH.toLocaleString()}</span>
          <Button
            size="sm"
            variant="primary"
            icon={generating ? undefined : <ArrowUp size={14} />}
            loading={generating && !busy}
            disabled={
              generating || description.trim().length === 0 || project === undefined || !modelReady || sourceTooLarge
            }
            onClick={submit}
          >
            {generating ? "Building screen" : usableThread === undefined ? "Create screen" : "Refine screen"}
          </Button>
        </div>

        {catalog.loading && project !== undefined && <p className="custom-screen-setup-hint">Checking the selected AI connection…</p>}
        {!catalog.loading && modelProblem !== undefined && (
          <div className="custom-screen-setup-hint is-error">
            <span>{modelProblem === "no-model" && anyConnected(catalog) ? "Choose a model before asking AI to build this screen." : "Connect or repair an AI model before building this screen."}</span>
            <Button size="sm" onClick={openModelSettings}><Plug size={13} />{modelProblem === "no-model" && anyConnected(catalog) ? "Choose model" : "Connect model"}</Button>
          </div>
        )}
        {sourceTooLarge && <p className="custom-screen-setup-hint is-error">This screen is too large to include in a refinement. Reduce it in Edit code first.</p>}
        {project === undefined && projects.length === 0 && (
          <div className="custom-screen-setup-hint">
            <span>Add a project so the AI uses the right Runrail workspace context.</span>
            <Button size="sm" onClick={() => openDialog({ kind: "create-project" })}><FolderPlus size={13} />Add project</Button>
          </div>
        )}
        {message !== undefined && <p className="custom-screen-designer-message" role="status">{message}</p>}
        {generating && (
          <div className="custom-screen-generation-state" role="status" aria-live="polite">
            <LoaderCircle size={14} className="spin" aria-hidden />
            <span>{approvals.length > 0 ? "The AI needs your approval or answer to continue." : busy ? "AI is designing your screen…" : "Starting the AI conversation…"}</span>
          </div>
        )}
      </div>

      <div className="custom-screen-designer-footer">
        <p>Generated code runs in an isolated screen. Runrail feature calls keep their normal approvals and safeguards.</p>
        <div className="custom-screen-designer-actions">
          {generating && busy && usableThread !== undefined && (
            <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => { void cancel(usableThread.id) }}>Stop</Button>
          )}
          {usableThread !== undefined && (
            <Button
              size="sm"
              variant={approvals.length > 0 ? "primary" : "ghost"}
              icon={<MessageCircle size={13} />}
              onClick={() => openThread(usableThread.id)}
            >
              {approvals.length > 0 ? "Review in conversation" : "Open AI conversation"}
            </Button>
          )}
        </div>
      </div>
    </aside>
  )
}

function sourceSize(screen: CustomScreen): number {
  return new TextEncoder().encode(screen.html).byteLength
    + new TextEncoder().encode(screen.css).byteLength
    + new TextEncoder().encode(screen.javascript).byteLength
}

