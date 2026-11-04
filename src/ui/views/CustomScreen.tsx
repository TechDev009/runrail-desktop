import { Code2, CodeXml, Play, RotateCcw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DEFAULT_CUSTOM_SCREEN, MAX_CUSTOM_SCREEN_BYTES, type CustomScreenIcon } from "../../app/persist"
import { setCustomScreen, useApp } from "../../app/store"
import { getHost } from "../../host"
import { createCodeEditor } from "../inspector/codeEditor"
import { Button } from "../common"
import { HarnessDesigner } from "./HarnessDesigner"
import { pendingQuestionQueue } from "../../app/pendingQuestions"
import "../../styles/custom-screen.css"

type SourceField = "html" | "css" | "javascript"
type EditorTab = SourceField | "api"

const TABS: readonly { readonly id: EditorTab; readonly label: string; readonly path?: string }[] = [
  { id: "html", label: "HTML", path: "screen.html" },
  { id: "css", label: "CSS", path: "screen.css" },
  { id: "javascript", label: "JavaScript", path: "screen.js" },
  { id: "api", label: "Runrail API" },
]

export function CustomScreenView() {
  const screen = useApp((state) => state.customScreen)
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<EditorTab>("html")
  const [error, setError] = useState<string>()
  const preview = useRef<HTMLDivElement>(null)
  const host = useMemo(() => getHost(), [])
  const dialog = useApp((state) => state.dialog)
  const hasPendingQuestion = useApp((state) => pendingQuestionQueue(state.threads, state.runtime).length > 0)
  const settingsOpen = useApp((state) => state.settings !== false)
  const paletteOpen = useApp((state) => state.palette)
  const suspended = dialog !== undefined || hasPendingQuestion || settingsOpen || paletteOpen
  const bytes = new TextEncoder().encode(screen.html).byteLength + new TextEncoder().encode(screen.css).byteLength + new TextEncoder().encode(screen.javascript).byteLength
  const tooLarge = bytes > MAX_CUSTOM_SCREEN_BYTES

  const measure = useCallback(() => {
    const element = preview.current
    if (element === null) return null
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }, [])

  useEffect(() => {
    if (host.kind !== "tauri" || editing) {
      void host.customScreenClose()
      return
    }
    const bounds = measure()
    if (bounds === null) return
    setError(undefined)
    void host.customScreenOpen({ html: screen.html, css: screen.css, javascript: screen.javascript }, bounds).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not run the custom screen")
    })
    return () => {
      void host.customScreenClose()
    }
  }, [editing, host, measure, screen.html, screen.css, screen.javascript])

  useEffect(() => {
    if (host.kind !== "tauri" || editing) return
    const update = (): void => {
      if (suspended) {
        void host.customScreenBounds(null)
        return
      }
      const bounds = measure()
      void host.customScreenBounds(bounds)
    }
    update()
    if (suspended) return
    const element = preview.current
    const observer = element === null ? undefined : new ResizeObserver(update)
    if (element !== null) observer?.observe(element)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [editing, host, measure, suspended])

  const updateSource = (field: SourceField, value: string): void => {
    setCustomScreen({ [field]: value })
    setError(undefined)
  }

  const reset = (): void => {
    if (!window.confirm("Replace this screen's code with the starter screen?")) return
    setCustomScreen({
      ...DEFAULT_CUSTOM_SCREEN,
      designerThreadId: undefined,
      designerProjectId: undefined,
      designerPending: false,
      designerPendingAfterTurnId: undefined,
      designerPendingStartedAt: undefined,
    })
    setError(undefined)
  }

  return (
    <section className="view custom-screen-view">
      <header className="view-header custom-screen-header">
        <CodeXml size={16} aria-hidden />
        <h1 className="view-title-bounded">{screen.name}</h1>
        <span className="view-subtitle">Your Runrail screen</span>
        <div className="custom-screen-header-actions">
          {editing ? (
            <>
              <label className="custom-screen-name">
                <span className="sr-only">Screen name</span>
                <input maxLength={40} value={screen.name} onChange={(event) => { if (event.target.value.trim().length > 0) setCustomScreen({ name: event.target.value }) }} />
              </label>
              <label className="custom-screen-icon">
                <span className="sr-only">Rail icon</span>
                <select value={screen.icon} onChange={(event) => setCustomScreen({ icon: event.target.value as CustomScreenIcon })}>
                  <option value="code">Code</option>
                  <option value="workflow">Workflow</option>
                  <option value="terminal">Terminal</option>
                  <option value="layout">Layout</option>
                </select>
              </label>
              <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={reset}>Reset</Button>
              <Button size="sm" variant="primary" icon={<Play size={13} />} disabled={tooLarge} onClick={() => { setEditing(false); setError(undefined) }}>Run</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" icon={<Code2 size={13} />} onClick={() => setEditing(true)}>Edit code</Button>
            </>
          )}
        </div>
      </header>
      {editing ? (
        <div className="custom-screen-editor">
          <nav className="custom-screen-tabs" aria-label="Custom screen code">
            {TABS.map((item) => <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
            <span className={tooLarge ? "is-over-limit" : ""}>{(bytes / 1024).toFixed(1)} / 256 KB</span>
          </nav>
          <div className="custom-screen-editor-body">
            {tab === "api" ? <ApiGuide /> : <EditorPane field={tab} value={screen[tab]} onChange={(value) => updateSource(tab, value)} onSave={() => { setEditing(false); setError(undefined) }} />}
            <aside className="custom-screen-help">
              <h2>Build with Runrail</h2>
              <p>Your code can use Runrail's feature API. Requests run through the same project, thread, integration, and approval checks as the app.</p>
              <p>Runrail keeps your credentials in its secure host. Custom code cannot call arbitrary Tauri commands or access the app's storage.</p>
              {error !== undefined && <p className="custom-screen-error" role="alert">{error}</p>}
              {tooLarge && <p className="custom-screen-error" role="alert">Reduce the combined source below 256 KB before running.</p>}
            </aside>
          </div>
        </div>
      ) : (
        <div className="custom-screen-workspace">
          <HarnessDesigner screen={screen} />
          <div className="custom-screen-preview-column">
            <div ref={preview} className="custom-screen-preview" aria-label="Custom screen preview" />
            {host.kind !== "tauri" && <div className="custom-screen-preview-placeholder"><CodeXml size={24} /><p>Run this screen in the Runrail desktop app to use its isolated runtime.</p></div>}
            {error !== undefined && <div className="custom-screen-preview-error" role="alert"><strong>Screen stopped</strong><span>{error}</span><Button size="sm" onClick={() => setEditing(true)}>Edit code</Button></div>}
          </div>
        </div>
      )}
    </section>
  )
}

function EditorPane({ field, value, onChange, onSave }: { readonly field: SourceField; readonly value: string; readonly onChange: (value: string) => void; readonly onSave: () => void }) {
  const parent = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }
  const path = TABS.find((item) => item.id === field)?.path ?? "screen.txt"

  useEffect(() => {
    if (parent.current === null) return
    const instance = createCodeEditor({
      parent: parent.current,
      text: value,
      path,
      onChange: (next) => handlers.current.onChange(next),
      onSave: () => handlers.current.onSave(),
    })
    return () => {
      instance.destroy()
    }
  }, [field, path])

  return <div className="custom-screen-editor-code" ref={parent} />
}

function ApiGuide() {
  return (
    <div className="custom-screen-api-guide">
      <h2>Runrail API v1</h2>
      <p>The screen receives a <code>runrail</code> bridge. Read state, subscribe to changes, and call feature methods from your own UI.</p>
      <pre>{`const state = await runrail.app.snapshot()
const projects = await runrail.projects.list()
const projectId = projects.items[0]?.id
const threads = projectId ? await runrail.threads.list({ projectId }) : { items: [] }

if (projectId) {
  const thread = threads.items[0]
  if (thread) await runrail.threads.send(thread.id, { text: "Continue this task" })
}

const unsubscribe = runrail.app.subscribe((next) => render(next))`}</pre>
      <p>Subscribe to state changes with <code>runrail.app.subscribe((snapshot, previous) =&gt; render(snapshot))</code>. The default poll is one second and the interval is bounded.</p>
      <p>Project and thread lists return <code>{`{ items, total, offset }`}</code> and accept a bounded <code>limit</code> and <code>offset</code>. Thread detail defaults to the newest 50 timeline items; set <code>historyLimit</code> up to 200.</p>
      <h3>API groups</h3>
      <ul>
        <li><code>runrail.app</code> - state snapshot and native feature navigation</li>
        <li><code>runrail.projects</code> and <code>runrail.threads</code> - project and run controls</li>
        <li><code>runrail.panels</code> - open thread panels beside your custom screen, and create, select, or close tabs</li>
        <li><code>runrail.rpc</code> - supported thread, project, and system feature calls</li>
        <li><code>runrail.host.call</code> - allowlisted desktop, simulator, and Android features, plus native pickers</li>
      </ul>
      <p>Thread panels include Review, Files, Tasks, Terminal, Browser, Simulator, and Android. For example, <code>await runrail.panels.open(threadId, "files")</code> opens a Runrail panel beside this screen. External browser previews and device URL launches ask for confirmation.</p>
      <p>Use <code>await runrail.catalog()</code> to list methods, limits, and confirmation behavior. The screen can open every Runrail feature; thread approvals and workflow reviews open in their normal feature view. Credentials and arbitrary Tauri commands are not exposed.</p>
    </div>
  )
}
