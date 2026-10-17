import { BookOpen, Box, Ellipsis, FolderOpen, Plus, Puzzle, RefreshCw, Search, ShieldCheck, Sparkles, Undo2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { confirmAction } from "../../app/actions"
import { invalidateCatalog } from "../../app/catalog"
import { projectRpc, setSkillEnabled } from "../../app/engines"
import { toast, useApp } from "../../app/store"
import { getHost, isUnsupported, toHostError } from "../../host"
import { fuzzyScore } from "../../lib/fuzzy"
import { PackageEntrySchema, parseList, PluginEntrySchema, SkillSchema, type PackageEntry, type PluginEntry, type Skill } from "../../protocol/schemas"
import { Button, cx, EmptyState, IconButton, Menu, Spinner, Tabs, Toggle } from "../common"

/**
 * Extensions: plugins, packages, and skills for a project, with install, update, rollback,
 * enable, and remove. Every mutation goes through the project's engine, which verifies package
 * integrity before anything activates.
 */

type Tab = "plugins" | "packages" | "skills"

interface Listing<T> {
  readonly items: readonly T[]
  readonly loading: boolean
  readonly error?: { readonly code: string; readonly message: string }
  readonly reload: () => void
}

function useListing<T>(projectId: string | undefined, method: string, parse: (value: unknown) => T[]): Listing<T> {
  const [state, setState] = useState<{ items: readonly T[]; loading: boolean; error?: { code: string; message: string } }>({ items: [], loading: true })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (projectId === undefined) return
    let live = true
    setState((current) => ({ ...current, loading: true, error: undefined }))
    projectRpc(projectId, method)
      .then((value) => live && setState({ items: parse(value), loading: false }))
      .catch((error: unknown) => {
        const failure = toHostError(error)
        if (live) setState({ items: [], loading: false, error: { code: failure.code, message: failure.message } })
      })
    return () => {
      live = false
    }
    // parse is a module-level function per call site; the method identifies the listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, method, nonce])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { ...state, reload }
}

const parsePlugins = (value: unknown): PluginEntry[] => parseList(PluginEntrySchema, value)
const parsePackages = (value: unknown): PackageEntry[] => parseList(PackageEntrySchema, value)
const parseSkills = (value: unknown): Skill[] => parseList(SkillSchema, value)

const FRIENDLY: Record<string, string> = {
  PLUGIN_ROLLBACK_UNAVAILABLE: "There is no earlier verified version to roll back to.",
  PLUGIN_INTEGRITY_MISMATCH: "The package failed its integrity check and was not installed.",
  PLUGIN_DUPLICATE: "A plugin with this id is already installed. Use Update instead.",
  PLUGIN_PACKAGE_NOT_FOUND: "No plugin package was found at that location.",
  CONTROL_BUSY: "Wait for the running turn to finish, then try again.",
  CONTROL_SESSION_BUSY: "Wait for the running turn to finish, then try again.",
}

function explain(error: unknown): string {
  const failure = toHostError(error)
  return FRIENDLY[failure.code] ?? failure.message
}

/** Plugins, packages and skills; `embedded` shows them inside Integrations without a page of their own. */
export function ExtensionsView({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const projects = useApp((state) => state.projects)
  const activeProjectId = useApp((state) => state.layout.activeProjectId)
  const [projectId, setProjectId] = useState(activeProjectId ?? projects[0]?.id)
  const [tab, setTab] = useState<Tab>("plugins")
  const [query, setQuery] = useState("")
  const plugins = useListing(projectId, "plugin.list", parsePlugins)
  const packages = useListing(projectId, "package.list", parsePackages)
  const skills = useListing(projectId, "skills.list", parseSkills)

  useEffect(() => {
    if (projectId === undefined || !projects.some((project) => project.id === projectId)) setProjectId(activeProjectId ?? projects[0]?.id)
  }, [projects, projectId, activeProjectId])

  const header = (
    <header className="view-header" data-tauri-drag-region>
      <div className="pane-toolbar-spacer" data-tauri-drag-region />
      {projects.length > 1 && (
        <select className="select select-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Project">
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      )}
    </header>
  )

  const project = projects.find((item) => item.id === projectId)
  const head = (
    <div className="page-head">
      <div className="page-head-text">
        <h1 className="page-title">Extensions</h1>
        <p className="page-lead">What the agent can do beyond its built-in tools{project === undefined ? "" : ` in ${project.name}`}: plugins, packages, and skills.</p>
      </div>
    </div>
  )

  const projectSelect = projects.length > 1 && (
    <select className="select select-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Project">
      {projects.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </select>
  )

  if (projectId === undefined) {
    if (embedded)
      return (
        <EmptyState icon={<Puzzle size={20} />} title="Open a project to manage plugins and skills">
          Plugins, packages, and skills are resolved per project by its engine.
        </EmptyState>
      )
    return (
      <main className="view">
        {header}
        {head}
        <EmptyState icon={<Puzzle size={20} />} title="Open a project to manage extensions">
          Plugins, packages, and skills are resolved per project by its engine.
        </EmptyState>
      </main>
    )
  }

  const toolbar = (
    <div className="view-toolbar">
        <Tabs
          label="Extension kind"
          value={tab}
          onChange={setTab}
          options={[
            { value: "plugins", label: "Plugins", ...(plugins.loading ? {} : { count: plugins.items.length }) },
            { value: "packages", label: "Packages", ...(packages.loading ? {} : { count: packages.items.length }) },
            { value: "skills", label: "Skills", ...(skills.loading ? {} : { count: skills.items.length }) },
          ]}
        />
        <div className="search-field">
          <Search size={13} />
          <input value={query} placeholder={`Filter ${tab}`} aria-label={`Filter ${tab}`} onChange={(event) => setQuery(event.target.value)} />
          {query.length > 0 && (
            <button type="button" className="search-clear" aria-label="Clear filter" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </div>
        {embedded && projectSelect}
      </div>
  )
  const body = (
    <div className="view-body">
      {tab === "plugins" && <Plugins projectId={projectId} listing={plugins} query={query} />}
      {tab === "packages" && <Packages projectId={projectId} listing={packages} query={query} />}
      {tab === "skills" && <Skills projectId={projectId} listing={skills} query={query} />}
    </div>
  )
  if (embedded)
    return (
      <div className="integrations-extensions">
        {toolbar}
        {body}
      </div>
    )
  return (
    <main className="view">
      {header}
      {head}
      {toolbar}
      {body}
    </main>
  )
}

function filterBy<T>(items: readonly T[], query: string, text: (item: T) => string): readonly T[] {
  const q = query.trim()
  if (q.length === 0) return items
  return items.filter((item) => fuzzyScore(q, text(item)) !== -1)
}

function ListState<T>({ listing, kind, empty, children }: { readonly listing: Listing<T>; readonly kind: string; readonly empty: ReactNode; readonly children: ReactNode }) {
  if (listing.loading && listing.items.length === 0)
    return (
      <div className="pane-loading">
        <Spinner size={12} /> Loading {kind}…
      </div>
    )
  if (listing.error !== undefined) {
    const unsupported = isUnsupported(listing.error.code)
    return (
      <EmptyState
        title={unsupported ? `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)} are not available` : `Could not load ${kind}`}
        actions={
          unsupported ? undefined : (
            <Button size="sm" icon={<RefreshCw size={13} />} onClick={listing.reload}>
              Try again
            </Button>
          )
        }
      >
        {unsupported ? `This engine does not manage ${kind}.` : listing.error.message}
      </EmptyState>
    )
  }
  if (listing.items.length === 0) return <>{empty}</>
  return <>{children}</>
}

function InstallBar({ label, onInstall }: { readonly label: string; readonly onInstall: (source: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  if (!open)
    return (
      <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
        Install {label}
      </Button>
    )
  const submit = async (): Promise<void> => {
    if (source.trim().length === 0) return
    setBusy(true)
    try {
      await onInstall(source.trim())
      setSource("")
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="install-bar"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <input className="input grow" autoFocus value={source} placeholder="Folder or .tar/.tgz archive path" aria-label={`${label} source`} onChange={(event) => setSource(event.target.value)} />
      <Button
        size="sm"
        variant="ghost"
        icon={<FolderOpen size={13} />}
        onClick={() =>
          void getHost()
            .workspacePick()
            .then((picked) => picked !== null && setSource(picked.path))
        }
      >
        Choose…
      </Button>
      <Button size="sm" variant="primary" type="submit" loading={busy} disabled={source.trim().length === 0}>
        Install
      </Button>
      <IconButton label="Cancel" size="sm" onClick={() => setOpen(false)}>
        <X size={13} />
      </IconButton>
    </form>
  )
}

function Plugins({ projectId, listing, query }: { readonly projectId: string; readonly listing: Listing<PluginEntry>; readonly query: string }) {
  const [busy, setBusy] = useState<string | undefined>()
  const visible = useMemo(() => filterBy(listing.items, query, (item) => `${item.manifest.id} ${item.manifest.description ?? ""}`), [listing.items, query])

  const mutate = async (id: string, method: string, params: Record<string, unknown>, done: string): Promise<void> => {
    setBusy(id)
    try {
      await projectRpc(projectId, method, params)
      toast("success", done)
      invalidateCatalog(projectId)
      listing.reload()
    } catch (error) {
      toast("error", explain(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="ext-section">
      <div className="ext-toolbar">
        <p className="ext-lead">Plugins add tools, commands, and hooks to the agent. Each package is integrity-checked before it loads; updates keep the previous version for rollback.</p>
        <InstallBar
          label="plugin"
          onInstall={async (source) => {
            try {
              await projectRpc(projectId, "plugin.install", { source })
              toast("success", "Plugin installed. Enable it to load it into new turns.")
              listing.reload()
            } catch (error) {
              toast("error", explain(error))
              throw error
            }
          }}
        />
      </div>
      <ListState listing={listing} kind="plugins" empty={<EmptyState icon={<Puzzle size={20} />} title="No plugins installed">Install a plugin from a local folder or archive. Runrail verifies its manifest and file digests first.</EmptyState>}>
        <ul className="ext-list">
          {visible.map((item) => {
            const id = item.manifest.id
            const working = busy === id
            return (
              <li key={id} className={cx("ext-card", item.enabled !== true && "is-disabled")}>
                <div className="ext-icon">
                  <Puzzle size={16} />
                </div>
                <div className="ext-main">
                  <div className="ext-title">
                    <span className="ext-name">{id}</span>
                    {item.manifest.version !== undefined && <span className="ext-version">v{item.manifest.version}</span>}
                    {item.manifest.mode !== undefined && (
                      <span className={cx("pill", item.manifest.mode === "isolated" ? "is-ok" : "is-warn")} title={item.manifest.mode === "isolated" ? "Runs in a separate process with only its declared capabilities" : "Runs inside the engine process with full access"}>
                        {item.manifest.mode === "isolated" ? "Isolated" : "Trusted"}
                      </span>
                    )}
                    {(item.manifest.contributes ?? []).map((kind) => (
                      <span key={kind} className="chip">
                        {kind}
                      </span>
                    ))}
                  </div>
                  {item.manifest.description !== undefined && <p className="ext-desc">{item.manifest.description}</p>}
                  {(item.manifest.capabilities?.length ?? 0) > 0 && (
                    <div className="ext-caps">
                      <ShieldCheck size={11} />
                      {item.manifest.capabilities?.map((capability) => (
                        <span key={capability} className="chip">
                          {capability}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ext-actions">
                  {working && <Spinner size={12} />}
                  <Toggle label={`${item.enabled === true ? "Disable" : "Enable"} ${id}`} checked={item.enabled === true} disabled={working} onChange={(enabled) =>
                      enabled
                        ? confirmAction({
                            title: `Enable ${id}?`,
                            body: `A plugin runs its own code as your user in this project's threads${(item.manifest.capabilities?.length ?? 0) > 0 ? `, with ${item.manifest.capabilities?.join(", ") ?? ""}` : ""}. Enable only plugins you trust.`,
                            confirm: "Enable",
                            danger: true,
                            onConfirm: () => void mutate(id, "plugin.enable", { id }, `${id} enabled`),
                          })
                        : void mutate(id, "plugin.disable", { id }, `${id} disabled`)
                    }
                  />
                  <Menu
                    align="end"
                    trigger={({ toggle, ref }) => (
                      <IconButton ref={ref} label={`${id} actions`} size="sm" disabled={working} onClick={toggle}>
                        <Ellipsis size={14} />
                      </IconButton>
                    )}
                    items={[
                      {
                        id: "update",
                        label: "Update from folder…",
                        icon: <RefreshCw size={13} />,
                        onSelect: () =>
                          void getHost()
                            .workspacePick()
                            .then((picked) => {
                              if (picked !== null) void mutate(id, "plugin.update", { id, source: picked.path }, `${id} updated`)
                            }),
                      },
                      {
                        id: "update-archive",
                        label: "Update from archive…",
                        icon: <RefreshCw size={13} />,
                        onSelect: () =>
                          void getHost()
                            .archivePick()
                            .then((path) => {
                              if (path !== null) void mutate(id, "plugin.update", { id, source: path }, `${id} updated`)
                            }),
                      },
                      {
                        id: "rollback",
                        label: "Roll back to previous version",
                        icon: <Undo2 size={13} />,
                        onSelect: () =>
                          confirmAction({
                            title: `Roll back ${id}?`,
                            body: "The previous verified version replaces the current one. New turns use the rolled-back version.",
                            confirm: "Roll back",
                            onConfirm: () => void mutate(id, "plugin.rollback", { id }, `${id} rolled back`),
                          }),
                      },
                      { separator: true, id: "sep" },
                      {
                        id: "remove",
                        label: "Remove",
                        icon: <X size={13} />,
                        danger: true,
                        onSelect: () =>
                          confirmAction({
                            title: `Remove ${id}?`,
                            body: "The plugin and its rollback copy are deleted from this project's plugin store.",
                            confirm: "Remove",
                            danger: true,
                            onConfirm: () => void mutate(id, "plugin.remove", { id }, `${id} removed`),
                          }),
                      },
                    ]}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </ListState>
    </section>
  )
}

function Packages({ projectId, listing, query }: { readonly projectId: string; readonly listing: Listing<PackageEntry>; readonly query: string }) {
  const [busy, setBusy] = useState<string | undefined>()
  const [verify, setVerify] = useState<{ loading: boolean; results?: readonly { id: string; integrity: string; signature?: string }[] }>({ loading: false })
  const visible = useMemo(() => filterBy(listing.items, query, (item) => `${item.manifest.displayName ?? item.manifest.id} ${item.manifest.description ?? ""} ${(item.manifest.tags ?? []).join(" ")}`), [listing.items, query])
  const integrity = useMemo(() => new Map((verify.results ?? []).map((entry) => [entry.id, entry])), [verify.results])

  const mutate = async (id: string, method: string, params: Record<string, unknown>, done: string): Promise<void> => {
    setBusy(id)
    try {
      await projectRpc(projectId, method, params)
      toast("success", done)
      invalidateCatalog(projectId)
      listing.reload()
    } catch (error) {
      toast("error", explain(error))
    } finally {
      setBusy(undefined)
    }
  }

  const runVerify = async (): Promise<void> => {
    setVerify({ loading: true })
    try {
      const value = await projectRpc(projectId, "package.verify")
      const list = Array.isArray(value) ? value : Array.isArray((value as { packages?: unknown }).packages) ? (value as { packages: unknown[] }).packages : []
      const results = list.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return []
        const record = entry as { id?: unknown; integrity?: unknown; signature?: unknown }
        return typeof record.id === "string" && typeof record.integrity === "string" ? [{ id: record.id, integrity: record.integrity, ...(typeof record.signature === "string" ? { signature: record.signature } : {}) }] : []
      })
      setVerify({ loading: false, results })
      const failed = results.filter((entry) => entry.integrity !== "verified").length
      toast(failed > 0 ? "error" : "success", failed > 0 ? `${String(failed)} package${failed === 1 ? "" : "s"} failed verification` : "All packages verified")
    } catch (error) {
      setVerify({ loading: false })
      toast("error", explain(error))
    }
  }

  return (
    <section className="ext-section">
      <div className="ext-toolbar">
        <p className="ext-lead">Packages bundle skills, prompts, agents, and plugins. Activation checks the lockfile and each package's digest.</p>
        <Button size="sm" variant="ghost" icon={<ShieldCheck size={13} />} loading={verify.loading} disabled={listing.items.length === 0} onClick={() => void runVerify()}>
          Verify all
        </Button>
        <InstallBar
          label="package"
          onInstall={async (source) => {
            try {
              await projectRpc(projectId, "package.install", { source })
              toast("success", "Package installed. Activate it to use it.")
              listing.reload()
            } catch (error) {
              toast("error", explain(error))
              throw error
            }
          }}
        />
      </div>
      <ListState listing={listing} kind="packages" empty={<EmptyState icon={<Box size={20} />} title="No packages installed">Install a package from a local folder or archive.</EmptyState>}>
        <ul className="ext-list">
          {visible.map((item) => {
            const id = item.manifest.id
            const working = busy === id
            const check = integrity.get(id)
            return (
              <li key={id} className={cx("ext-card", item.enabled !== true && "is-disabled")}>
                <div className="ext-icon">
                  <Box size={16} />
                </div>
                <div className="ext-main">
                  <div className="ext-title">
                    <span className="ext-name">{item.manifest.displayName ?? id}</span>
                    {item.manifest.version !== undefined && <span className="ext-version">v{item.manifest.version}</span>}
                    {item.manifest.packageType !== undefined && <span className="pill">{item.manifest.packageType}</span>}
                    <span className={cx("pill", item.active === true ? "is-ok" : "is-muted")}>{item.active === true ? "Active" : "Inactive"}</span>
                    {check !== undefined && <span className={cx("pill", check.integrity === "verified" ? "is-ok" : "is-error")}>{check.integrity === "verified" ? "Verified" : "Integrity failed"}</span>}
                  </div>
                  {item.manifest.description !== undefined && <p className="ext-desc">{item.manifest.description}</p>}
                  <div className="ext-meta">
                    {item.manifest.publisher !== undefined && <span>by {item.manifest.publisher}</span>}
                    {(item.manifest.tags ?? []).slice(0, 6).map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="ext-actions">
                  {working && <Spinner size={12} />}
                  <Button size="sm" variant={item.active === true ? "ghost" : "secondary"} disabled={working || item.enabled !== true} onClick={() => void mutate(id, item.active === true ? "package.deactivate" : "package.activate", { id }, item.active === true ? `${id} deactivated` : `${id} activated`)}>
                    {item.active === true ? "Deactivate" : "Activate"}
                  </Button>
                  <Toggle label={`${item.enabled === true ? "Disable" : "Enable"} ${id}`} checked={item.enabled === true} disabled={working} onChange={(enabled) =>
                      enabled
                        ? confirmAction({
                            title: `Enable ${id}?`,
                            body: "A package runs its own code as your user once it is active. Enable only packages you trust.",
                            confirm: "Enable",
                            danger: true,
                            onConfirm: () => void mutate(id, "package.enable", { id }, `${id} enabled`),
                          })
                        : void mutate(id, "package.disable", { id }, `${id} disabled`)
                    }
                  />
                  <Menu
                    align="end"
                    trigger={({ toggle, ref }) => (
                      <IconButton ref={ref} label={`${id} actions`} size="sm" disabled={working} onClick={toggle}>
                        <Ellipsis size={14} />
                      </IconButton>
                    )}
                    items={[
                      {
                        id: "update",
                        label: "Update from source…",
                        icon: <RefreshCw size={13} />,
                        onSelect: () =>
                          void getHost()
                            .workspacePick()
                            .then((picked) => {
                              if (picked !== null) void mutate(id, "package.update", { id, source: picked.path }, `${id} updated`)
                            }),
                      },
                      {
                        id: "rollback",
                        label: "Roll back to previous version",
                        icon: <Undo2 size={13} />,
                        onSelect: () =>
                          confirmAction({
                            title: `Roll back ${item.manifest.displayName ?? id}?`,
                            body: "The previous verified version replaces the current one.",
                            confirm: "Roll back",
                            onConfirm: () => void mutate(id, "package.rollback", { id }, `${id} rolled back`),
                          }),
                      },
                      { separator: true, id: "sep" },
                      {
                        id: "remove",
                        label: "Remove",
                        icon: <X size={13} />,
                        danger: true,
                        onSelect: () =>
                          confirmAction({
                            title: `Remove ${item.manifest.displayName ?? id}?`,
                            body: "The package is deleted from this project's package store.",
                            confirm: "Remove",
                            danger: true,
                            onConfirm: () => void mutate(id, "package.remove", { id }, `${id} removed`),
                          }),
                      },
                    ]}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </ListState>
    </section>
  )
}

/** A project's skills with their switches, as Settings shows them. */
export function ProjectSkills({ projectId, reloadSignal = 0 }: { readonly projectId: string; readonly reloadSignal?: number }) {
  const listing = useListing(projectId, "skills.list", parseSkills)
  const { reload } = listing
  useEffect(() => {
    if (reloadSignal > 0) reload()
  }, [reloadSignal, reload])
  return <Skills projectId={projectId} listing={listing} query="" />
}

function Skills({ projectId, listing, query }: { readonly projectId: string; readonly listing: Listing<Skill>; readonly query: string }) {
  const [busy, setBusy] = useState<string | undefined>()
  const visible = useMemo(() => filterBy(listing.items, query, (item) => `${item.name ?? item.id} ${item.description ?? ""}`), [listing.items, query])
  const scopes = useMemo(() => {
    const groups = new Map<string, Skill[]>()
    for (const skill of visible) groups.set(skill.scope ?? "project", [...(groups.get(skill.scope ?? "project") ?? []), skill])
    return [...groups.entries()]
  }, [visible])

  const toggleSkill = async (skill: Skill, enabled: boolean): Promise<void> => {
    setBusy(skill.id)
    try {
      await setSkillEnabled(projectId, skill.id, enabled)
      invalidateCatalog(projectId)
      listing.reload()
    } catch (error) {
      toast("error", explain(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="ext-section">
      <div className="ext-toolbar">
        <p className="ext-lead">
          Skills are instructions the agent loads on demand. Type <code>/</code> in the composer to use one directly.
        </p>
      </div>
      <ListState
        listing={listing}
        kind="skills"
        empty={
          <EmptyState icon={<Sparkles size={20} />} title="No skills found">
            Add a <code>SKILL.md</code> under the project's or your user skills folder and it shows up here.
          </EmptyState>
        }
      >
        {scopes.map(([scope, list]) => (
          <div key={scope} className="ext-group">
            <div className="ext-group-head">{scope === "user" ? "Your skills" : scope === "project" ? "Project skills" : scope}</div>
            <ul className="ext-list">
              {list.map((skill) => (
                <li key={skill.id} className={cx("ext-card", "is-compact", skill.enabled === false && "is-disabled")}>
                  <div className="ext-icon">
                    <BookOpen size={15} />
                  </div>
                  <div className="ext-main">
                    <div className="ext-title">
                      <span className="ext-name">{skill.name ?? skill.id}</span>
                    </div>
                    {skill.description !== undefined && <p className="ext-desc">{skill.description}</p>}
                  </div>
                  <div className="ext-actions">
                    {busy === skill.id && <Spinner size={12} />}
                    <Toggle label={`${skill.enabled === false ? "Enable" : "Disable"} ${skill.name ?? skill.id}`} checked={skill.enabled !== false} disabled={busy === skill.id} onChange={(enabled) => void toggleSkill(skill, enabled)} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </ListState>
    </section>
  )
}
