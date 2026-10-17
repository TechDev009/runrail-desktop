import { Download, Search, TriangleAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { closeDialog } from "../../app/actions"
import { bumpImportRevision, OTHER_TOOL_LABELS, serversToAdd, serverState, type OtherToolsSection, type ServerState } from "../../app/otherTools"
import { restartEngines } from "../../app/engines"
import { toast } from "../../app/store"
import { getHost, toHostError, type AgentDefinition, type McpServer, type OtherTool, type OtherTools } from "../../host"
import { plural } from "../../lib/format"
import { fuzzyScore } from "../../lib/fuzzy"
import { Button, cx, EmptyState, Modal, Segmented, Spinner } from "../common"
import { useProject } from "../hooks"

/**
 * Skills, MCP servers, or subagents found in Claude Code, Codex, and the other tools on this
 * computer, to bring into Runrail. Skills and subagents are copied into the project; servers join
 * Runrail's own list after the host's confirmation. Values of variables never come along.
 */

interface Item {
  readonly key: string
  readonly tool: OtherTool
  readonly title: string
  readonly detail?: string
  readonly place: string
  readonly notes: readonly string[]
  /** Why it cannot be picked. */
  readonly blocked?: string
  readonly server?: McpServer
  readonly path?: string
}

const TITLES: Readonly<Record<OtherToolsSection, string>> = { skills: "Skills from other tools", servers: "MCP servers from other tools", agents: "Subagents from other tools" }

function items(section: OtherToolsSection, found: OtherTools, servers: readonly McpServer[], agents: readonly AgentDefinition[], projectPath: string): readonly Item[] {
  if (section === "skills")
    return found.skills.map((skill) => ({ key: skill.path, tool: skill.tool, title: skill.name, ...(skill.description === undefined ? {} : { detail: skill.description }), place: skill.place, notes: [], path: skill.path }))
  if (section === "agents")
    return found.agents.map((agent) => ({
      key: agent.path,
      tool: agent.tool,
      title: agent.name,
      ...(agent.description.length === 0 ? {} : { detail: agent.description }),
      place: agent.place,
      notes: [],
      path: agent.path,
      ...(agents.some((item) => item.name === agent.name) ? { blocked: "The project already has a subagent with this name." } : {}),
    }))
  return found.servers.map((found, index): Item => {
    const state: ServerState = serverState(found, servers, projectPath)
    const line = found.server === undefined ? undefined : found.server.url ?? [found.server.command, ...found.server.args].join(" ")
    return {
      key: `${found.place}:${found.original}:${String(index)}`,
      tool: found.tool,
      title: found.server?.name ?? found.original,
      ...(line === undefined ? {} : { detail: line }),
      place: found.scope === "project" ? `${found.place} · this project` : found.place,
      notes: state.kind === "unusable" ? [] : found.leftOut,
      ...(state.kind === "ready" ? { server: state.server } : { blocked: state.kind === "taken" ? "Runrail already has a server with this name." : `Cannot be added: ${state.reason}.` }),
    }
  })
}

export function OtherToolsDialog({ section, projectId }: { readonly section: OtherToolsSection; readonly projectId: string }) {
  const project = useProject(projectId)
  const [found, setFound] = useState<OtherTools | undefined>()
  const [servers, setServers] = useState<readonly McpServer[]>([])
  const [agents, setAgents] = useState<readonly AgentDefinition[]>([])
  const [error, setError] = useState<string | undefined>()
  const [tool, setTool] = useState<"all" | OtherTool>("all")
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const path = project?.path

  useEffect(() => {
    if (path === undefined) return
    let live = true
    const host = getHost()
    Promise.all([host.otherToolsScan(path), section === "servers" ? host.mcpList() : Promise.resolve([]), section === "agents" ? host.agentsList(path) : Promise.resolve([])])
      .then(([scan, mcp, list]) => {
        if (!live) return
        setFound(scan)
        setServers(mcp)
        setAgents(list)
      })
      .catch((caught: unknown) => live && setError(toHostError(caught).message))
    return () => {
      live = false
    }
  }, [path, section])

  const all = useMemo(() => (found === undefined || path === undefined ? [] : items(section, found, servers, agents, path)), [found, servers, agents, path, section])
  const tools = useMemo(() => {
    const counts = new Map<OtherTool, number>()
    for (const item of all) counts.set(item.tool, (counts.get(item.tool) ?? 0) + 1)
    return [...counts.entries()]
  }, [all])
  const visible = useMemo(() => {
    const list = all.filter((item) => tool === "all" || item.tool === tool)
    const q = query.trim()
    return q.length === 0 ? list : list.filter((item) => fuzzyScore(q, `${item.title} ${item.detail ?? ""}`) !== -1)
  }, [all, tool, query])

  if (project === undefined) return null
  const chosen = all.filter((item) => picked.has(item.key) && item.blocked === undefined)
  const toggle = (key: string): void => setPicked((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const run = async (): Promise<void> => {
    setBusy(true)
    const host = getHost()
    try {
      if (section === "servers") {
        await host.mcpImport(serversToAdd(chosen.flatMap((item) => (item.server === undefined ? [] : [item.server]))))
        toast("success", `${plural(chosen.length, "MCP server")} added. Threads on Runrail's own loop use them from their next start.`)
        restartEngines()
      } else {
        const failed: string[] = []
        for (const item of chosen) {
          if (item.path === undefined) continue
          try {
            if (section === "skills") await host.otherSkillImport(project.path, item.path)
            else await host.otherAgentImport(project.path, item.path)
          } catch (caught) {
            failed.push(`${item.title}: ${toHostError(caught).message}`)
          }
        }
        const copied = chosen.length - failed.length
        const what = section === "skills" ? "skill" : "subagent"
        if (copied > 0) toast("success", `${plural(copied, what)} copied into ${project.name}.`)
        if (failed.length > 0) toast("error", `Not copied: ${failed.join("; ")}`)
        if (section === "skills" && copied > 0) restartEngines(projectId)
      }
      bumpImportRevision(section)
      closeDialog()
    } catch (caught) {
      const failure = toHostError(caught)
      if (failure.code !== "MCP_DECLINED") toast("error", failure.message)
    } finally {
      setBusy(false)
    }
  }

  const lead =
    section === "skills"
      ? `Copies the skills you pick into ${project.name}'s .agents/skills, where every thread in the project finds them. Skills already in the project's .claude, .codex, or .pi folders are used as they are.`
      : section === "servers"
        ? "Adds the servers you pick to Runrail's list, for threads on its own loop, after you confirm the exact commands. Values of variables and other secrets are never copied; set them in your shell."
        : `Copies the subagents you pick into ${project.name}'s .claude/agents, where Claude Code threads find them.`

  return (
    <Modal
      title={
        <>
          <Download size={15} /> {TITLES[section]}
        </>
      }
      onClose={closeDialog}
      width={680}
      footer={
        <>
          <span className="dialog-note">{chosen.length === 0 ? "Pick what to bring over." : `${String(chosen.length)} picked`}</span>
          <Button variant="ghost" onClick={closeDialog} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={chosen.length === 0} loading={busy} onClick={() => void run()}>
            {section === "servers" ? "Add servers…" : "Copy into project"}
          </Button>
        </>
      }
    >
      <p className="dialog-text">{lead}</p>
      <div className="import-toolbar">
        <Segmented
          label="Tool"
          size="sm"
          value={tool}
          onChange={setTool}
          options={[{ value: "all" as const, label: "All", count: all.length }, ...tools.map(([id, count]) => ({ value: id, label: OTHER_TOOL_LABELS[id], count }))]}
        />
        <div className="search-field">
          <Search size={13} />
          <input value={query} placeholder="Filter" aria-label="Filter" onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      <div className="import-list">
        {error !== undefined ? (
          <EmptyState icon={<TriangleAlert size={18} />} title="Could not read the other tools' settings">
            {error}
          </EmptyState>
        ) : found === undefined ? (
          <div className="pane-loading">
            <Spinner size={12} /> Reading other tools' settings…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title={all.length === 0 ? "Nothing found" : "No matches"}>{all.length === 0 ? "Claude Code, Codex, Cursor, Gemini CLI, opencode, and Pi have none set up on this computer." : "Try a different filter."}</EmptyState>
        ) : (
          <ul>
            {visible.map((item) => (
              <li key={item.key} className={cx("import-row", "is-pickable", item.blocked !== undefined && "is-blocked")}>
                <input type="checkbox" checked={picked.has(item.key) && item.blocked === undefined} disabled={item.blocked !== undefined || busy} onChange={() => toggle(item.key)} aria-label={`Pick ${item.title}`} />
                <span className={cx("source-badge", `is-${item.tool}`)}>{OTHER_TOOL_LABELS[item.tool]}</span>
                <span className="import-text">
                  <span className="import-title" title={item.title}>
                    {item.title}
                  </span>
                  {item.detail !== undefined && (
                    <span className={cx("import-detail", section === "servers" && "mono")} title={item.detail}>
                      {item.detail}
                    </span>
                  )}
                  <span className="import-place">{item.place}</span>
                  {item.blocked !== undefined && <span className="import-note">{item.blocked}</span>}
                  {item.notes.map((note) => (
                    <span key={note} className="import-note">
                      Left out: {note}.
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
