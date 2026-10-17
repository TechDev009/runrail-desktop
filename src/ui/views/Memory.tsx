import { Brain, CircleAlert, CircleDot, FileText, FolderOpen, Pencil, Plus, RefreshCw, Rss, Settings2, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { confirmAction } from "../../app/actions"
import { addMemory, addSource, forgetMemory, loadMemory, memoryLabel, readSettings, removeSource, saveSettings, sourceEntries, syncSource, updateMemory, useMemory, type ScopeName } from "../../app/memory"
import { useWords } from "../../app/platformWords"
import { activeProject, setPrefs, toast, useApp } from "../../app/store"
import { toHostError } from "../../host"
import { timeAgo } from "../../lib/format"
import type { MemoryInfo, MemorySettings, MemorySourceInfo } from "../../protocol/schemas"
import { Button, cx, EmptyState, IconButton, Spinner, Toggle, useTicker } from "../common"
import { ProjectPicker } from "./ProjectPicker"

/**
 * Memory: what Runrail remembers for this project and for the person, the sources that
 * feed it, and where it is kept. Recalled memories show on each message they were sent with.
 */

type Selected = { readonly kind: "scope"; readonly scope: ScopeName } | { readonly kind: "source"; readonly id: string } | { readonly kind: "add-source" } | { readonly kind: "settings" }

const SOURCE_ICONS = { folder: <FolderOpen size={13} />, github: <CircleDot size={13} />, feed: <Rss size={13} /> } as const

export function MemoryView() {
  const words = useWords()
  const projects = useApp((state) => state.projects)
  const [projectId, setProjectId] = useState(() => activeProject()?.id ?? projects[0]?.id)
  const [selected, setSelected] = useState<Selected>({ kind: "scope", scope: "project" })
  const memory = useMemory((state) => (projectId === undefined ? undefined : state.byProject[projectId]))
  const now = useTicker(true, 30_000)

  useEffect(() => {
    if (projectId !== undefined) void loadMemory(projectId)
  }, [projectId])

  if (projectId === undefined)
    return (
      <main className="agents" aria-label="Memory">
        <div className="agents-empty">
          <EmptyState icon={<Brain size={20} />} title="Add a project first">
            Memory is kept for each project and for you. Add a project from the threads list.
          </EmptyState>
        </div>
      </main>
    )

  const counts = memory?.status?.counts
  const sources = memory?.sources ?? []
  return (
    <main className="agents" aria-label="Memory">
      <nav className="agents-list" aria-label="Memory">
        <div className="agents-list-top" data-tauri-drag-region>
          <span className="agents-title">Memory</span>
        </div>
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        <div className="agents-section">
          <span>Memories</span>
        </div>
        {(["project", "person"] as const).map((scope) => (
          <button key={scope} type="button" className={cx("agents-item", selected.kind === "scope" && selected.scope === scope && "is-active")} onClick={() => setSelected({ kind: "scope", scope })}>
            <span className="agents-item-title">{scope === "project" ? "This project" : "All my projects"}</span>
            <span className="agents-item-meta">{counts === undefined ? "…" : `${String(counts[scope])} memor${counts[scope] === 1 ? "y" : "ies"}`}</span>
          </button>
        ))}
        <div className="agents-section">
          <span>Sources</span>
          <IconButton label="Add a source" size="sm" onClick={() => setSelected({ kind: "add-source" })}>
            <Plus size={14} />
          </IconButton>
        </div>
        {sources.length === 0 && <p className="agents-note">No sources. A folder of notes, a repository's issues, or a feed can feed memory.</p>}
        {sources.map((source) => (
          <button key={source.id} type="button" className={cx("agents-item", selected.kind === "source" && selected.id === source.id && "is-active")} onClick={() => setSelected({ kind: "source", id: source.id })}>
            <span className="agents-item-title">
              {SOURCE_ICONS[source.kind]}
              <span className="agents-item-text">{source.name}</span>
            </span>
            <span className={cx("agents-item-meta", source.lastSync?.ok === false && "tone-red")}>{sourceLine(source, now)}</span>
          </button>
        ))}
        <div className="agents-section">
          <span>Settings</span>
        </div>
        <button type="button" className={cx("agents-item", selected.kind === "settings" && "is-active")} onClick={() => setSelected({ kind: "settings" })}>
          <span className="agents-item-title">
            <Settings2 size={13} /> Where memory is kept
          </span>
          <span className={cx("agents-item-meta", memory?.status?.health.ok === false && "tone-red")}>
            {memory?.status === undefined ? "…" : memory.status.provider.kind === "local" ? `On this ${words.computer}` : (memory.status.provider.name ?? "Memory server")}
          </span>
        </button>
        {memory?.state === "error" && <p className="agents-note is-error">{memory.message}</p>}
      </nav>
      <section className="agents-detail">
        <div className="agents-detail-top" data-tauri-drag-region />
        {selected.kind === "scope" ? (
          <ScopeDetail
            key={`${projectId}:${selected.scope}`}
            projectId={projectId}
            scope={selected.scope}
            memories={(memory?.memories ?? []).filter((item) => item.scope === selected.scope || (item.scope === "external" && selected.scope === "project"))}
            loading={memory?.state === "loading"}
            now={now}
          />
        ) : selected.kind === "source" ? (
          <SourceDetail key={selected.id} projectId={projectId} source={sources.find((source) => source.id === selected.id)} now={now} onRemoved={() => setSelected({ kind: "scope", scope: "project" })} />
        ) : selected.kind === "add-source" ? (
          <AddSource projectId={projectId} onAdded={() => setSelected({ kind: "scope", scope: "project" })} />
        ) : (
          <SettingsDetail projectId={projectId} />
        )}
      </section>
    </main>
  )
}

function sourceLine(source: MemorySourceInfo, now: number): string {
  if (source.lastSync === undefined) return "Not synced yet"
  if (!source.lastSync.ok) return source.lastSync.error ?? "Sync failed"
  return `${String(source.entries)} entr${source.entries === 1 ? "y" : "ies"} · synced ${timeAgo(source.lastSync.at, now)}`
}

// ---------------------------------------------------------------------------------------------

function ScopeDetail({ projectId, scope, memories, loading, now }: { readonly projectId: string; readonly scope: ScopeName; readonly memories: readonly MemoryInfo[]; readonly loading: boolean; readonly now: number }) {
  const [text, setText] = useState("")
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return words.length === 0 ? memories : memories.filter((item) => words.every((word) => item.text.toLowerCase().includes(word)))
  }, [memories, query])

  const add = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await addMemory(projectId, scope, text.trim())
      setText("")
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="agents-body">
      <div className="form">
        <header className="agents-run-head">
          <h1>{scope === "project" ? "This project" : "All my projects"}</h1>
          <p className="muted">{scope === "project" ? "Facts about this repository: decisions, conventions, commands, where things live." : "How you like to work, recalled in every project."}</p>
        </header>
        <section className="agents-run-box">
          <label className="field">
            <span className="field-label">Remember</span>
            <textarea
              className="textarea"
              rows={2}
              maxLength={4_000}
              value={text}
              placeholder={scope === "project" ? "Releases are cut from main on Tuesdays." : "I prefer small pull requests."}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="agents-row">
            <span className="form-hint">Recalled when a message shares its words. Each recall shows on the message.</span>
            <span className="agents-spacer" />
            <Button variant="primary" icon={<Plus size={13} />} loading={busy} disabled={text.trim().length === 0} onClick={() => void add()}>
              Add
            </Button>
          </div>
          {error !== undefined && (
            <p className="form-warning" role="alert">
              <CircleAlert size={13} /> {error}
            </p>
          )}
        </section>
        <input className="input" type="search" aria-label="Search memories" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        {loading && memories.length === 0 && (
          <p className="form-hint" role="status">
            <Spinner size={12} /> Reading memory…
          </p>
        )}
        {!loading && shown.length === 0 && <p className="form-hint">{query.length > 0 ? "Nothing matches." : "Nothing remembered yet."}</p>}
        <ul className="memory-list">
          {shown.map((item) => (
            <MemoryRow key={item.id} projectId={projectId} item={item} now={now} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function MemoryRow({ projectId, item, now }: { readonly projectId: string; readonly item: MemoryInfo; readonly now: number }) {
  const [editing, setEditing] = useState<string>()
  const fromSource = item.source.kind === "folder" || item.source.kind === "github" || item.source.kind === "feed"
  const save = async (): Promise<void> => {
    if (editing === undefined) return
    try {
      await updateMemory(projectId, item.id, editing)
      setEditing(undefined)
    } catch (cause) {
      toast("error", toHostError(cause).message)
    }
  }
  return (
    <li className="memory-item">
      {editing === undefined ? (
        <p className="memory-text">{item.text}</p>
      ) : (
        <textarea className="textarea" rows={3} maxLength={4_000} value={editing} aria-label="Memory" onChange={(event) => setEditing(event.target.value)} />
      )}
      <div className="memory-meta">
        <span className="muted">
          {memoryLabel(item)}
          {item.source.kind === "suggested" ? " · suggested" : ""} · {timeAgo(item.updatedAt, now)}
        </span>
        <span className="agents-spacer" />
        {editing === undefined ? (
          <>
            {!fromSource && (
              <IconButton size="sm" label="Edit" onClick={() => setEditing(item.text)}>
                <Pencil size={12} />
              </IconButton>
            )}
            <IconButton
              size="sm"
              label="Forget"
              onClick={() =>
                confirmAction({
                  title: "Forget this memory?",
                  body: item.text,
                  confirm: "Forget",
                  danger: true,
                  onConfirm: () => void forgetMemory(projectId, item.id).catch((cause: unknown) => toast("error", toHostError(cause).message)),
                })
              }
            >
              <Trash2 size={12} />
            </IconButton>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={editing.trim().length === 0} onClick={() => void save()}>
              Save
            </Button>
          </>
        )}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------------------------

function SourceDetail({ projectId, source, now, onRemoved }: { readonly projectId: string; readonly source: MemorySourceInfo | undefined; readonly now: number; readonly onRemoved: () => void }) {
  const syncing = useMemory((state) => (source === undefined ? false : state.syncing[source.id] === true))
  const [entries, setEntries] = useState<readonly MemoryInfo[]>()
  useEffect(() => {
    if (source !== undefined) void sourceEntries(projectId, source.id).then(setEntries, () => setEntries([]))
  }, [projectId, source?.id, source?.lastSync?.at])
  if (source === undefined) return null
  return (
    <div className="agents-body">
      <div className="form">
        <header className="agents-run-head">
          <div className="agents-run-title">
            {SOURCE_ICONS[source.kind]}
            <h1>{source.name}</h1>
          </div>
          <p className="muted">
            <span className="mono">{source.target}</span> · {source.scope === "project" ? "this project" : "all my projects"}
          </p>
          <p className={cx("muted", source.lastSync?.ok === false && "tone-red")}>
            {sourceLine(source, now)}
            {source.lastSync?.ok === true && ` (${String(source.lastSync.added)} added, ${String(source.lastSync.removed)} removed, ${String(source.lastSync.kept)} unchanged)`}
          </p>
        </header>
        <div className="agents-row">
          <Button variant="secondary" icon={<RefreshCw size={13} />} loading={syncing} onClick={() => void syncSource(projectId, source.id).catch((cause: unknown) => toast("error", toHostError(cause).message))}>
            Sync now
          </Button>
          <span className="form-hint">Synced every hour while Runrail is open.</span>
          <span className="agents-spacer" />
          <Button
            variant="ghost"
            icon={<Trash2 size={13} />}
            onClick={() =>
              confirmAction({
                title: `Remove ${source.name}?`,
                body: `Its ${String(source.entries)} entr${source.entries === 1 ? "y is" : "ies are"} forgotten. The ${source.kind === "folder" ? "files" : source.kind === "github" ? "issues" : "feed"} stay as they are.`,
                confirm: "Remove",
                danger: true,
                onConfirm: () => void removeSource(projectId, source.id).then(onRemoved),
              })
            }
          >
            Remove
          </Button>
        </div>
        {entries === undefined ? (
          <p className="form-hint" role="status">
            <Spinner size={12} /> Reading entries…
          </p>
        ) : (
          <ul className="memory-list">
            {entries.map((item) => (
              <li key={item.id} className="memory-item">
                <p className="memory-text is-clamped">{item.text}</p>
                <div className="memory-meta">
                  <span className="muted">
                    <FileText size={11} aria-hidden="true" /> {item.source.ref ?? source.name}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const TARGET_HINTS = {
  folder: { label: "Folder", placeholder: "/Users/me/notes", hint: "Notes only (.md, .txt, .rst and the like). Hidden files, dependency folders and credential files are never read." },
  github: { label: "Repository", placeholder: "owner/name", hint: "Read through your GitHub CLI (gh); the newest 100 issues, then those that change." },
  feed: { label: "Feed URL", placeholder: "https://example.com/feed.xml", hint: "An RSS or Atom feed; its newest 100 items." },
} as const

function AddSource({ projectId, onAdded }: { readonly projectId: string; readonly onAdded: () => void }) {
  const words = useWords()
  const [kind, setKind] = useState<MemorySourceInfo["kind"]>("folder")
  const [target, setTarget] = useState("")
  const [scope, setScope] = useState<ScopeName>("project")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const hint = TARGET_HINTS[kind]
  const add = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await addSource(projectId, { kind, scope, target: target.trim() })
      onAdded()
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="agents-body">
      <div className="form">
        <header className="agents-run-head">
          <h1>Add a source</h1>
          <p className="muted">Runrail reads it into memory on this {words.computer} and keeps it up to date.</p>
        </header>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Kind</span>
            <select className="select" value={kind} onChange={(event) => setKind(event.target.value as MemorySourceInfo["kind"])}>
              <option value="folder">A folder of notes</option>
              <option value="github">GitHub issues</option>
              <option value="feed">A feed</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">For</span>
            <select className="select" value={scope} onChange={(event) => setScope(event.target.value as ScopeName)}>
              <option value="project">This project</option>
              <option value="person">All my projects</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field-label">{hint.label}</span>
          <input className="input mono" value={target} spellCheck={false} placeholder={hint.placeholder} onChange={(event) => setTarget(event.target.value)} />
          <span className="form-hint">{hint.hint}</span>
        </label>
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
        <div className="agents-row">
          <span className="agents-spacer" />
          <Button variant="primary" loading={busy} disabled={target.trim().length === 0} onClick={() => void add()}>
            Add and sync
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

type ProviderChoice = "local" | "server-memory" | "custom"

function SettingsDetail({ projectId }: { readonly projectId: string }) {
  const words = useWords()
  const prefs = useApp((state) => state.prefs.memory)
  const status = useMemory((state) => state.byProject[projectId]?.status)
  const [settings, setSettings] = useState<MemorySettings>()
  const [choice, setChoice] = useState<ProviderChoice>("local")
  const [custom, setCustom] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void readSettings(projectId).then((value) => {
      setSettings(value)
      const provider = value?.provider
      if (provider === undefined || provider === "local") setChoice("local")
      else if (provider.command === "npx" && provider.args?.includes("@modelcontextprotocol/server-memory") === true) setChoice("server-memory")
      else {
        setChoice("custom")
        setCustom(JSON.stringify(provider, null, 2))
      }
    })
  }, [projectId])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      let provider: "local" | "server-memory" | Record<string, unknown> = choice === "custom" ? {} : choice
      if (choice === "custom") {
        try {
          provider = JSON.parse(custom) as Record<string, unknown>
        } catch {
          throw new Error("The server's settings are not valid JSON.")
        }
      }
      await saveSettings(projectId, provider)
      setSettings(await readSettings(projectId))
      toast("success", "Memory settings saved")
    } catch (cause) {
      setError(toHostError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="agents-body">
      <div className="form">
        <header className="agents-run-head">
          <h1>Where memory is kept</h1>
          {status !== undefined && (
            <p className={cx("muted", !status.health.ok && "tone-red")}>
              {status.provider.kind === "local" ? `On this ${words.computer}` : (status.provider.name ?? "Memory server")}: {status.health.ok ? (status.health.detail ?? "working") : (status.health.detail ?? "not answering")}
            </p>
          )}
        </header>
        <fieldset className="memory-choices">
          <label className="memory-choice">
            <input type="radio" name="memory-provider" checked={choice === "local"} onChange={() => setChoice("local")} />
            <span>
              <strong>On this {words.computer}</strong>
              <span className="form-hint">In ~/.runrail/memory. Nothing leaves this machine.</span>
            </span>
          </label>
          <label className="memory-choice">
            <input type="radio" name="memory-provider" checked={choice === "server-memory"} onChange={() => setChoice("server-memory")} />
            <span>
              <strong>MCP memory server</strong>
              <span className="form-hint">
                The official knowledge-graph server, started with <span className="mono">npx -y @modelcontextprotocol/server-memory</span>. Sources stay on this {words.computer}.
              </span>
            </span>
          </label>
          <label className="memory-choice">
            <input type="radio" name="memory-provider" checked={choice === "custom"} onChange={() => setChoice("custom")} />
            <span>
              <strong>Another MCP server</strong>
              <span className="form-hint">Its command or URL, and which of its tools recall, add, forget and list.</span>
            </span>
          </label>
        </fieldset>
        {choice === "custom" && (
          <textarea
            className="textarea mono"
            rows={10}
            spellCheck={false}
            aria-label="Server settings"
            value={custom}
            placeholder={
              '{\n  "name": "My memory",\n  "command": "my-memory-server",\n  "inherit": ["MY_MEMORY_TOKEN"],\n  "mapping": {\n    "recall": { "tool": "search", "args": { "query": "{query}", "limit": "{limit}" } },\n    "add": { "tool": "add", "args": { "text": "{text}" } }\n  }\n}'
            }
            onChange={(event) => setCustom(event.target.value)}
          />
        )}
        {choice !== "local" && <p className="form-hint">If the server does not answer, recall uses local memory and the message says so.</p>}
        {error !== undefined && (
          <p className="form-warning" role="alert">
            <CircleAlert size={13} /> {error}
          </p>
        )}
        <div className="agents-row">
          <span className="agents-spacer" />
          <Button variant="primary" loading={busy} disabled={settings === undefined} onClick={() => void save()}>
            Save
          </Button>
        </div>
        <div className="toggle-row">
          <Toggle label="Recall memories" checked={prefs.recall} onChange={(value) => setPrefs({ memory: { ...prefs, recall: value } })} />
          <span>Add up to three memories a message shares words with, shown on the message</span>
        </div>
        <div className="toggle-row">
          <Toggle label="Offer to remember" checked={prefs.suggest} onChange={(value) => setPrefs({ memory: { ...prefs, suggest: value } })} />
          <span>After two turns, offer to suggest facts to keep from a thread</span>
        </div>
      </div>
    </div>
  )
}
