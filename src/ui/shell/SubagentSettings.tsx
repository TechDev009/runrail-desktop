import { Bot, Download, MoreHorizontal, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { confirmAction, openDialog } from "../../app/actions"
import { useImportRevision } from "../../app/otherTools"
import { toast } from "../../app/store"
import { getHost, toHostError, type AgentDefinition } from "../../host"
import { plural } from "../../lib/format"
import { Button, cx, Menu, Spinner } from "../common"

/**
 * Settings → Subagents: the project's `.claude/agents` files, which Claude Code reads. The host
 * reads and writes them; this page only edits their fields.
 */

const NAME = /^[a-z][a-z0-9-]{0,63}$/
const TOOL = /^[A-Za-z][A-Za-z0-9_:*().-]{0,127}$/
const MODELS = ["", "inherit", "sonnet", "opus", "haiku"] as const
const MODEL_LABELS: Readonly<Record<(typeof MODELS)[number], string>> = { "": "Claude Code's default", inherit: "Same as the main agent", sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" }

interface Draft {
  readonly name: string
  readonly description: string
  readonly tools: string
  readonly model: string
  readonly prompt: string
}

const EMPTY: Draft = { name: "", description: "", tools: "", model: "", prompt: "" }

function draftOf(agent: AgentDefinition): Draft {
  return { name: agent.name, description: agent.description, tools: agent.tools.join(", "), model: agent.model ?? "", prompt: agent.prompt }
}

/** The draft as a definition, or the first thing wrong with it, worded for the form. */
export function parseAgentDraft(draft: Draft): AgentDefinition | string {
  const name = draft.name.trim()
  if (!NAME.test(name)) return "Name: lowercase letters, digits, or -, starting with a letter."
  const description = draft.description.trim()
  if (description.length === 0) return "Say when the main agent should use it; Claude Code picks subagents by this line."
  if (description.length > 1_024 || /[\n\r]/.test(description)) return "The description is one line of up to 1,024 characters."
  const tools = draft.tools.split(/[\s,]+/).filter((tool) => tool.length > 0)
  if (tools.length > 64 || tools.some((tool) => !TOOL.test(tool))) return "Tools: names such as Read, Grep, or Bash, comma separated."
  if (draft.prompt.length > 64 * 1024) return "The instructions are longer than 64 KB."
  return { name, description, tools, ...(draft.model.length === 0 ? {} : { model: draft.model }), prompt: draft.prompt }
}

function AgentForm({ workspace, initial, previous, onDone, onCancel }: { readonly workspace: string; readonly initial: Draft; readonly previous?: string; readonly onDone: (agents: readonly AgentDefinition[]) => void; readonly onCancel: () => void }) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const submit = (): void => {
    const parsed = parseAgentDraft(draft)
    if (typeof parsed === "string") return setError(parsed)
    setError(undefined)
    setSaving(true)
    getHost()
      .agentSave(workspace, parsed, previous)
      .then((agents) => {
        onDone(agents)
        toast("success", `${parsed.name} saved to .claude/agents.`)
      })
      .catch((caught: unknown) => setError(toHostError(caught).message))
      .finally(() => setSaving(false))
  }
  return (
    <form
      className="entry-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label className="entry-field">
        <span className="entry-field-label">Name</span>
        <input className="input" value={draft.name} maxLength={64} placeholder="code-reviewer" spellCheck={false} autoFocus={previous === undefined} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <label className="entry-field">
        <span className="entry-field-label">When to use it</span>
        <input className="input" value={draft.description} maxLength={1_024} placeholder="Reviews a diff for bugs before it is committed" onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        <span className="entry-field-hint">The main agent reads this line to decide when to hand work over.</span>
      </label>
      <label className="entry-field">
        <span className="entry-field-label">Tools</span>
        <input className="input mono" value={draft.tools} maxLength={2_000} placeholder="Read, Grep, Glob" spellCheck={false} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} />
        <span className="entry-field-hint">Leave empty to give it every tool the main agent has.</span>
      </label>
      <label className="entry-field">
        <span className="entry-field-label">Model</span>
        <select className="select" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} aria-label="Model">
          {MODELS.map((model) => (
            <option key={model} value={model}>
              {MODEL_LABELS[model]}
            </option>
          ))}
          {!(MODELS as readonly string[]).includes(draft.model) && <option value={draft.model}>{draft.model}</option>}
        </select>
      </label>
      <label className="entry-field">
        <span className="entry-field-label">Instructions</span>
        <textarea className="textarea instructions-editor" value={draft.prompt} rows={8} maxLength={65_536} placeholder="You review code changes. Look for…" onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
      </label>
      {error !== undefined && (
        <p className="setting-hint is-error" role="alert">
          {error}
        </p>
      )}
      <div className="entry-form-actions">
        <span className="entry-field-hint">Saved as .claude/agents/{draft.name.trim() || "name"}.md</span>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving}>
          {previous === undefined ? "Add subagent" : "Save"}
        </Button>
      </div>
    </form>
  )
}

export function SubagentEditor({ project }: { readonly project: { readonly id: string; readonly name: string; readonly path: string } }) {
  const revision = useImportRevision((state) => state.agents)
  const [agents, setAgents] = useState<readonly AgentDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [editing, setEditing] = useState<string | "new" | undefined>()

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(undefined)
    setEditing(undefined)
    getHost()
      .agentsList(project.path)
      .then((list) => live && setAgents(list))
      .catch((caught: unknown) => live && setError(toHostError(caught).message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project.path, revision])

  if (loading)
    return (
      <div className="pane-loading">
        <Spinner size={12} /> Loading subagents…
      </div>
    )
  if (error !== undefined) return <p className="setting-hint is-error">{error}</p>
  return (
    <>
      {agents.length === 0 && editing !== "new" && (
        <div className="entry-empty">
          <Bot size={18} />
          <span>{project.name} has no subagents yet. Add one, such as a reviewer or a test writer, to give Claude Code a specialist to hand work to.</span>
        </div>
      )}
      {agents.length > 0 && (
        <ul className="entry-list">
          {agents.map((agent) =>
            editing === agent.name ? (
              <li key={agent.name} className="entry-row is-editing">
                <AgentForm
                  workspace={project.path}
                  initial={draftOf(agent)}
                  previous={agent.name}
                  onCancel={() => setEditing(undefined)}
                  onDone={(list) => {
                    setAgents(list)
                    setEditing(undefined)
                  }}
                />
              </li>
            ) : (
              <li key={agent.name} className="entry-row">
                <span className="entry-mark" aria-hidden="true">
                  <Bot size={13} />
                </span>
                <span className="entry-text">
                  <span className="entry-name">{agent.name}</span>
                  <span className="entry-scope">{agent.description}</span>
                  <span className="entry-status">
                    {agent.tools.length === 0 ? "Every tool" : plural(agent.tools.length, "tool")}
                    {agent.model === undefined ? "" : ` · ${MODEL_LABELS[agent.model as (typeof MODELS)[number]] ?? agent.model}`}
                  </span>
                </span>
                <Menu
                  align="end"
                  width={180}
                  items={[
                    { id: "edit", label: "Edit", onSelect: () => setEditing(agent.name) },
                    {
                      id: "remove",
                      label: "Remove",
                      danger: true,
                      onSelect: () =>
                        confirmAction({
                          title: `Remove ${agent.name}?`,
                          body: `Deletes .claude/agents/${agent.name}.md from ${project.name}.`,
                          confirm: "Remove",
                          danger: true,
                          onConfirm: () => {
                            getHost()
                              .agentRemove(project.path, agent.name)
                              .then(setAgents)
                              .catch((caught: unknown) => toast("error", toHostError(caught).message))
                          },
                        }),
                    },
                  ]}
                  trigger={({ toggle, ref, open }) => (
                    <button ref={ref} type="button" className={cx("icon-btn", "icon-btn-sm", open && "is-active")} onClick={toggle} aria-haspopup="menu" aria-label={`More for ${agent.name}`}>
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                />
              </li>
            ),
          )}
        </ul>
      )}
      {editing === "new" ? (
        <div className="entry-row is-editing">
          <AgentForm
            workspace={project.path}
            initial={EMPTY}
            onCancel={() => setEditing(undefined)}
            onDone={(list) => {
              setAgents(list)
              setEditing(undefined)
            }}
          />
        </div>
      ) : (
        <div className="entry-add">
          <Button size="sm" icon={<Plus size={13} />} disabled={editing !== undefined} onClick={() => setEditing("new")}>
            Add subagent
          </Button>
          <Button size="sm" variant="ghost" icon={<Download size={13} />} disabled={editing !== undefined} title="Subagents set up in Claude Code and opencode" onClick={() => openDialog({ kind: "other-tools", section: "agents", projectId: project.id })} data-setting="subagent-import">
            From other tools…
          </Button>
        </div>
      )}
    </>
  )
}
