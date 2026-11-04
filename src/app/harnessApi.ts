import { z } from "zod"
import { getHost, toHostError } from "../host"
import type { CustomScreenRequest } from "../host/types"
import { PANEL_KINDS, SINGLE_PANELS } from "./persist"
import { closePanelTab, newPanelTab, openPanel, panelOf, selectPanelTab } from "./panels"
import { isLocalUrl } from "./previews"
import { useConnectors } from "./integrations"
import { useInbox } from "./inbox"
import { useMemory } from "./memory"
import { useEvals } from "./evals"
import { selectReview, useReviews } from "./reviews"
import { useSetups } from "./setups"
import { systemRpc } from "./connections"
import { useWorkflows, loadWorkflows, runWorkflow, stopWorkflowRun, enableWorkflow, deleteWorkflow } from "./workflowRuns"
import { archiveWithUndo, confirmDeleteForever } from "./archive"
import { confirmAction } from "./actions"
import { cancel, reloadHistory, renameThread, send, setAccess, setMode, setModel, setPermission, steer, threadRpc, projectRpc, threadStatus } from "./engines"
import { showList, showOffice } from "./office"
import { createThread, get, openThread, projectById, set, setLayout, threadById, runtimeOf, toast, type NewThreadInput } from "./store"

const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 512 * 1024

function confirmationLabel(value: string, limit = 160): string {
  const safe = value.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "�")
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe
}

const THREAD_RPC = new Set([
  "git.diff", "git.fetch", "git.pr.checks.logs", "git.pr.merge", "git.pr.status", "git.pull", "git.push.preview", "git.remote.list", "git.status",
  "metrics.snapshot", "session.checkpoint.changes", "session.compact", "session.conversation.read", "session.external.import", "session.external.refresh", "task.create", "turn.cancel", "turn.steer", "workspace.list",
])

const PROJECT_RPC = new Set([
  "check.run", "check.stop", "codehost.remotes", "eval.list", "eval.mine", "eval.run", "eval.stop", "eval.suite.get", "eval.suite.save", "eval.suites", "eval.validate",
  "git.diff", "git.fetch", "harness.status", "mcp.check", "memory.add", "memory.forget", "memory.list", "memory.settings.get", "memory.settings.set",
  "memory.source.add", "memory.source.list", "memory.source.remove", "memory.source.sync", "memory.status", "memory.update", "session.external.list",
  "setup.delete", "setup.list", "setup.run.list", "setup.run.restore", "setup.save", "skills.setEnabled",
  "workflow.delete", "workflow.list", "workflow.propose", "workflow.run.list", "workflow.run.start", "workflow.run.stop", "workflow.save",
  "workspace.list", "workspace.read",
])

const SYSTEM_RPC = new Set([
  "account.create", "account.get", "account.list", "account.remove", "account.upsert", "auth.flows", "auth.logout",
  "auth.mcp.client.clear", "auth.mcp.signout", "claude.sdk.install", "claude.sdk.status", "codehost.connect", "codehost.list",
  "codehost.remotes", "codehost.status", "connection.addTool", "connection.detect", "connection.importable", "connection.list", "connection.models", "connection.presets", "connection.setDefault", "connection.setImageModel",
  "connection.status", "connection.test", "connection.update", "connection.vendorSignOut", "connector.setup.list", "connector.setup.remove", "connector.setup.save", "conversation.peek",
  "git.pr.diff", "git.pr.merge", "git.pr.review.post", "git.pr.review.threads", "git.pr.search", "git.pr.teams", "git.pr.view", "harness.status", "push.vapid", "setup.run.saved",
  "thread.copy", "usage.read", "workflow.due", "workflow.upcoming",
])

const HOST_METHODS = new Set([
  "info", "githubRelayStatus", "githubRelayFetchEvents", "githubRelayAcknowledge", "authOpen", "workspacePick", "appStarters", "appCreate",
  "computerAccess", "computerRequestAccess", "computerOpenSettings", "computerRunningApps", "computerAllowed",
  "simulatorStatus", "simulatorDevices", "simulatorBoot", "simulatorShutdown", "simulatorOpen", "simulatorScreenshot", "simulatorApps", "simulatorInstall", "simulatorLaunch", "simulatorOpenUrl", "simulatorInput", "simulatorAgents",
  "androidStatus", "androidDevices", "androidBoot", "androidShutdown", "androidScreenshot", "androidApps", "androidInstall", "androidLaunch", "androidOpenUrl", "androidInput", "androidAgents",
  "archivePick", "workspaceInspect", "workspaceReveal", "workspaceOpenIn", "openInApps", "attachmentSave", "instructionsRead", "instructionsWrite", "mcpList", "mcpImport",
  "keepAwake", "loginItem", "wakeService", "remoteList", "remoteCheck", "sshHosts",
  "tailscaleStatus",
  "quickStatus", "shellsList", "skillImport", "agentsList", "otherToolsScan", "otherSkillImport", "otherAgentImport",
  "signInsSaved", "signInsSupport", "openUrl",
  "updateCheck", "notifyStatus", "notifyRequest", "notifyTakeOpened",
])

export const CUSTOM_SCREEN_API_CATALOG = {
  version: 1,
  methods: ["app.snapshot", "app.open", "app.subscribe", "features.open", "projects.list", "projects.open", "threads.list", "threads.get", "threads.create", "threads.open", "threads.openApproval", "threads.send", "threads.steer", "threads.cancel", "threads.setPermission", "threads.setMode", "threads.setAccess", "threads.setModel", "threads.rename", "threads.archive", "threads.delete", "threads.reload", "workflows.list", "workflows.run", "workflows.openRun", "workflows.stop", "workflows.openForApproval", "workflows.enable", "workflows.delete", "panels.list", "panels.open", "panels.create", "panels.select", "panels.close", "rpc.thread", "rpc.project", "rpc.system", "host.call"],
  features: ["threads", "reviews", "agents", "workflows", "evals", "integrations", "memory", "office", "compare", "archived", "settings", "custom-screen"],
  rpc: { thread: [...THREAD_RPC].sort(), project: [...PROJECT_RPC].sort(), system: [...SYSTEM_RPC].sort() },
  host: [...HOST_METHODS].sort(),
  limits: { requestBytes: MAX_REQUEST_BYTES, responseBytes: MAX_RESULT_BYTES, listPageSize: 100, threadHistoryItems: 200, requestsPerMinute: 120, pendingRequests: 16 },
  confirmationRequired: ["threads.delete", "threads.setPermission(permission=full)", "threads.setAccess(access=full)", "workflows.delete", "panels.create(browser, external URL)", "rpc.project(memory.forget)", "rpc.project(memory.source.remove)", "rpc.project(setup.delete)", "rpc.project(workflow.delete)", "rpc.thread(git.pull)", "rpc.thread(session.external.import)", "rpc.system(account.remove)", "rpc.system(auth.logout)", "rpc.system(auth.mcp.client.clear)", "rpc.system(auth.mcp.signout)", "rpc.system(connection.vendorSignOut)", "rpc.system(connector.setup.remove)", "rpc.system(git.pr.merge)", "rpc.system(git.pr.review.post)", "rpc.project(memory.settings.set, remote provider)", "host.call(instructionsWrite)", "host.call(openUrl)", "host.call(simulatorOpenUrl)", "host.call(androidOpenUrl)", "host.call(mcpImport)"],
  routesToRunrailUi: ["threads.openApproval", "workflows.openRun", "workflows.openForApproval"],
} as const

const NewThreadSchema = z.object({
  projectId: z.string().min(1).max(128),
  backend: z.enum(["native", "replay", "pi", "codex", "claude-code", "copilot", "opencode", "gemini", "goose"]).optional(),
  model: z.string().max(256).optional(),
  connectionId: z.string().max(256).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  fastMode: z.boolean().optional(),
  mode: z.enum(["agent", "plan", "goal"]).optional(),
  permission: z.enum(["ask", "auto-edit", "auto", "full"]).optional(),
  title: z.string().max(256).optional(),
}).strict()

const RecordValue = z.record(z.string(), z.unknown()).default({})

function requestObject(value: unknown): Record<string, unknown> {
  const parsed = RecordValue.safeParse(value)
  if (!parsed.success) throw new Error("Runrail API arguments must be an object")
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > MAX_REQUEST_BYTES) throw new Error("Runrail API request is too large")
  return parsed.data
}

function safeValue(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json === undefined) return null
  if (new TextEncoder().encode(json).byteLength > MAX_RESULT_BYTES) throw new Error("Runrail API response is too large; request a smaller result")
  return JSON.parse(json) as unknown
}

function openFeature(name: unknown, detail: unknown): void {
  if (typeof name !== "string") throw new Error("Feature name is required")
  switch (name) {
    case "threads": {
      if (typeof detail === "string" && threadById(detail) !== undefined) openThread(detail)
      else showList()
      return
    }
    case "office": showOffice(); return
    case "reviews": {
      if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
        const ref = z.object({ owner: z.string().min(1).max(128), repo: z.string().min(1).max(128), number: z.number().int().positive() }).strict().parse(detail)
        selectReview(ref)
      }
      set({ view: { kind: "reviews" } })
      return
    }
    case "agents": {
      const run = typeof detail === "string" ? useSetups.getState().runs[detail] : undefined
      if (run !== undefined) setLayout({ activeProjectId: run.projectId })
      const runId = run === undefined || typeof detail !== "string" ? undefined : detail
      set({ view: { kind: "agents", ...(runId === undefined ? {} : { runId }) } })
      return
    }
    case "workflows": {
      const projectId = typeof detail === "string" && projectById(detail) !== undefined ? detail : undefined
      if (projectId !== undefined) setLayout({ activeProjectId: projectId })
      set({ view: { kind: "workflows", ...(projectId === undefined ? {} : { projectId }) } })
      return
    }
    case "evals": set({ view: { kind: "evals", ...(typeof detail === "string" ? { runId: detail } : {}) } }); return
    case "integrations": {
      const section = typeof detail === "string" && ["connectors", "mcp", "grants", "extensions"].includes(detail) ? detail as "connectors" | "mcp" | "grants" | "extensions" : undefined
      set({ view: { kind: "integrations", ...(section === undefined ? {} : { section }) } })
      return
    }
    case "compare": {
      const groupId = z.string().min(1).max(128).parse(detail)
      const thread = get().threads.find((entry) => entry.group?.id === groupId)
      if (thread === undefined) throw new Error("Comparison was not found")
      setLayout({ activeProjectId: thread.projectId, activeThreadId: thread.id })
      set({ view: { kind: "compare", groupId } })
      return
    }
    case "memory": set({ view: { kind: "memory" } }); return
    case "archived": set({ view: { kind: "archived" } }); return
    case "custom-screen": set({ view: { kind: "custom-screen" } }); return
    case "settings": {
      const section = typeof detail === "string" ? detail : "general"
      if (!["general", "ai", "voice", "instructions", "models", "connections", "permissions", "skills", "mcp", "agents", "projects", "import", "shortcuts", "developer"].includes(section)) throw new Error("Settings section is not supported")
      set({ settings: section as NonNullable<ReturnType<typeof get>["settings"]> })
      return
    }
    default: throw new Error("Runrail feature is not supported")
  }
}

function snapshot(): unknown {
  const app = get()
  const reviews = useReviews.getState()
  const setups = useSetups.getState()
  const evals = useEvals.getState()
  const workflows = useWorkflows.getState()
  const memory = useMemory.getState()
  const connectors = useConnectors.getState()
  const inbox = useInbox.getState()
  return safeValue({
    app: {
      loaded: app.loaded,
      view: app.view,
      projectsTotal: app.projects.length,
      threadsTotal: app.threads.length,
      projects: app.projects.slice(-50).map(({ id, name, git, addedAt }) => ({ id, name, git, addedAt })),
      threads: app.threads.slice(-100).map((thread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title, backend: thread.backend, mode: thread.mode, permission: thread.permission, updatedAt: thread.updatedAt, group: thread.group, status: threadStatus(thread, runtimeOf(thread.id)) })),
      activeProjectId: app.layout.activeProjectId,
      activeThreadId: app.layout.activeThreadId,
      prefs: { theme: app.prefs.theme, palette: app.prefs.palette, accent: app.prefs.accent, officeMode: app.prefs.officeMode, defaultMode: app.prefs.defaultMode, defaultPermission: app.prefs.defaultPermission },
    },
    features: {
      reviews: { waiting: reviews.waiting, connection: reviews.connection, groups: Object.fromEntries(Object.entries(reviews.groups).map(([key, group]) => [key, { state: group.state, total: group.total }])) },
      setups: { byProject: Object.fromEntries(Object.entries(setups.byProject).slice(-50).map(([id, project]) => [id, { state: project.state, setups: project.setups.slice(0, 100).map(({ id: setupId, name, trust }) => ({ id: setupId, name, trusted: trust?.trusted ?? false })) }])), runs: Object.values(setups.runs).slice(-100).map(({ projectId, run }) => ({ projectId, runId: run.runId, setupName: run.setupName, state: run.state, waiting: run.waiting?.kind })) },
      evals: { byProject: Object.fromEntries(Object.entries(evals.byProject).slice(-50).map(([id, project]) => [id, { state: project.state, suites: project.suites.slice(0, 100).map(({ name, cases }) => ({ name, cases })) }])), runs: Object.values(evals.runs).slice(-100).map(({ projectId, run }) => ({ projectId, runId: run.runId, state: run.state })) },
      workflows: { byProject: Object.fromEntries(Object.entries(workflows.byProject).slice(-50).map(([id, project]) => [id, { state: project.state, workflows: project.workflows.slice(0, 100).map(({ id: workflowId, name, state, trigger }) => ({ id: workflowId, name, state, trigger })) }])), runs: Object.values(workflows.runs).slice(-100).map(({ projectId, run }) => ({ projectId, runId: run.runId, workflowId: run.workflowId, state: run.state })) },
      memory: { byProject: Object.fromEntries(Object.entries(memory.byProject).slice(-50).map(([id, project]) => [id, { state: project.state, memories: project.memories.length, sources: project.sources.slice(0, 100).map(({ id: sourceId, name, kind, entries }) => ({ id: sourceId, name, kind, entries })) }])) },
      connectors,
      inbox: { open: inbox.open, items: inbox.items },
    },
  })
}

async function openWorkflowForReview(projectId: string, id: string): Promise<{ readonly opened: true; readonly actionRequired: string }> {
  if (projectById(projectId) === undefined) throw new Error("Project was not found")
  await loadWorkflows(projectId)
  if (!useWorkflows.getState().byProject[projectId]?.workflows.some((workflow) => workflow.id === id)) throw new Error("Workflow was not found")
  setLayout({ activeProjectId: projectId })
  set({ view: { kind: "workflows", projectId, workflowId: id } })
  return { opened: true, actionRequired: "Review and approve in Workflows" }
}

function focusPanelThread(threadId: string): void {
  const thread = threadById(threadId)
  if (thread === undefined) throw new Error("Thread was not found")
  if (get().view.kind === "custom-screen") setLayout({ activeProjectId: thread.projectId, activeThreadId: threadId })
  else openThread(threadId)
}

async function hostCall(args: Record<string, unknown>): Promise<unknown> {
  const name = args.name
  const values = Array.isArray(args.args) ? args.args : []
  if (typeof name !== "string" || !HOST_METHODS.has(name) || values.length > 8) throw new Error("Runrail host method is not available")
  const host = getHost()
  const method = (host as unknown as Record<string, unknown>)[name]
  if (typeof method !== "function") throw new Error("Runrail host method is unavailable on this platform")
  if (name === "instructionsWrite") {
    const workspace = z.string().min(1).max(4_096).parse(values[0])
    z.string().max(256 * 1024).parse(values[1])
    return requireConfirmation({
      title: "Save project instructions?",
      body: `This replaces AGENTS.md in the selected workspace: ${confirmationLabel(workspace, 240)}`,
      confirm: "Save instructions",
      danger: true,
      run: () => (method as (...args: unknown[]) => Promise<unknown>).apply(host, values),
    })
  }
  if (name === "openUrl") {
    const address = z.string().url().max(2_048).parse(values[0])
    const url = new URL(address)
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) throw new Error("Runrail opens only safe https addresses")
    const addressForPrompt = `${url.origin}${confirmationLabel(url.pathname, 240)}${url.search.length > 0 ? "?…" : ""}${url.hash.length > 0 ? "#…" : ""}`
    return requireConfirmation({
      title: "Open this website?",
      body: `Runrail will open ${addressForPrompt} in your default browser. Query values and fragments are hidden.`,
      confirm: "Open website",
      danger: false,
      run: () => (method as (...args: unknown[]) => Promise<unknown>).apply(host, values),
    })
  }
  if (name === "simulatorOpenUrl" || name === "androidOpenUrl") {
    const targetId = z.string().min(1).max(256).parse(values[0])
    const address = z.string().min(1).max(2_048).parse(values[1])
    const scheme = address.split(":", 1)[0] ?? ""
    if (scheme.length === 0 || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) || /[\s\u0000-\u001f\u007f]/u.test(address)) throw new Error("The device address is invalid")
    const [withoutFragment, fragment] = address.split("#", 2)
    const [path, query] = (withoutFragment ?? address).split("?", 2)
    const target = `${confirmationLabel(path ?? address, 200)}${query === undefined ? "" : "?…"}${fragment === undefined ? "" : "#…"}`
    return requireConfirmation({
      title: name === "simulatorOpenUrl" ? "Open this address in the simulator?" : "Open this address on the Android device?",
      body: `Runrail will open ${target} on ${confirmationLabel(targetId, 80)}.`,
      confirm: "Open address",
      run: () => (method as (...args: unknown[]) => Promise<unknown>).apply(host, values),
    })
  }
  return safeValue(await (method as (...args: unknown[]) => Promise<unknown>).apply(host, values))
}

function requireConfirmation(input: {
  readonly title: string
  readonly body: string
  readonly confirm: string
  readonly danger?: boolean
  readonly run: () => Promise<unknown>
}): { readonly confirmationShown: true } {
  if (get().dialog !== undefined) throw new Error("Finish the open Runrail dialog first")
  confirmAction({
    title: input.title,
    body: input.body,
    confirm: input.confirm,
    ...(input.danger === true ? { danger: true } : {}),
    onConfirm: () => void input.run().catch((error: unknown) => toast("error", toHostError(error).message)),
  })
  return { confirmationShown: true }
}

function rpcConfirmation(
  scope: "thread" | "project" | "system",
  method: string,
  params: Record<string, unknown>,
  context?: { readonly projectId?: string; readonly threadId?: string },
): { readonly title: string; readonly body: string; readonly confirm: string; readonly danger: boolean } | undefined {
  const text = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof params[key] === "string") return params[key] as string
    return undefined
  }
  const rawTarget = text("name", "id", "accountId", "connectionId", "runId", "path", "url")
  let target = rawTarget
  if (rawTarget !== undefined) {
    try {
      const parsed = new URL(rawTarget)
      if (parsed.protocol === "http:" || parsed.protocol === "https:") target = parsed.origin
      else target = confirmationLabel(rawTarget)
    } catch {
      target = confirmationLabel(rawTarget)
    }
  }
  if (scope === "project") {
    if (method === "memory.forget") {
      const item = useMemory.getState().byProject[context?.projectId ?? ""]?.memories.find((memory) => memory.id === target)
      return { title: "Forget this memory?", body: item === undefined ? "This removes the selected memory from the project." : confirmationLabel(item.text, 2_000), confirm: "Forget", danger: true }
    }
    if (method === "memory.source.remove") {
      const source = useMemory.getState().byProject[context?.projectId ?? ""]?.sources.find((entry) => entry.id === target)
      const body = source === undefined
        ? "Runrail will stop syncing this source and remove its saved entries."
        : `${confirmationLabel(source.name)} has ${String(source.entries)} saved entries. They will be forgotten; the source stays as it is.`
      return { title: source === undefined ? "Remove this memory source?" : `Remove ${confirmationLabel(source.name, 80)}?`, body, confirm: "Remove", danger: true }
    }
    if (method === "setup.delete") {
      const setup = useSetups.getState().byProject[context?.projectId ?? ""]?.setups.find((entry) => entry.id === target)
      return { title: setup === undefined ? "Delete this setup?" : `Delete ${confirmationLabel(setup.name, 80)}?`, body: "The setup is removed from this project. Past run threads stay.", confirm: "Delete", danger: true }
    }
    if (method === "workflow.delete") {
      const workflow = useWorkflows.getState().byProject[context?.projectId ?? ""]?.workflows.find((entry) => entry.id === target)
      return { title: workflow === undefined ? "Delete this workflow?" : `Delete ${confirmationLabel(workflow.name, 80)}?`, body: "The workflow and its run history are removed. Threads its runs opened stay.", confirm: "Delete", danger: true }
    }
  }
  if (scope === "thread") {
    if (method === "session.external.import") return { title: "Import this session?", body: "This adds an external session's messages to the selected Runrail thread.", confirm: "Import", danger: false }
    if (method === "git.pull") {
      const thread = threadById(context?.threadId)
      return { title: "Pull into this workspace?", body: `Pulling can change files in ${thread?.titled ? confirmationLabel(thread.title) : "the selected thread's workspace"}.`, confirm: "Pull", danger: true }
    }
  }
  if (scope === "system") {
    if (method === "account.remove") return { title: "Remove this account?", body: `Runrail will remove the saved account${target === undefined ? "" : ` ${target}`}.`, confirm: "Remove account", danger: true }
    if (method === "connection.removeTool") return { title: "Remove this coding tool?", body: `Runrail will remove this saved tool connection${target === undefined ? "" : ` (${target})`}.`, confirm: "Remove", danger: true }
    if (method === "connection.vendorSignOut" || method === "auth.logout" || method === "auth.mcp.signout") return { title: "Sign out?", body: `Runrail will end this sign-in${target === undefined ? "" : ` (${target})`} on this computer.`, confirm: "Sign out", danger: true }
    if (method === "auth.mcp.client.clear") return { title: "Clear the saved sign-in?", body: `Runrail will remove the saved MCP client credentials${target === undefined ? "" : ` (${target})`}.`, confirm: "Clear", danger: true }
    if (method === "connector.setup.remove") return { title: "Disconnect this integration?", body: `Runrail will turn off this integration${target === undefined ? "" : ` (${target})`} and forget its saved key.`, confirm: "Disconnect", danger: true }
  }
  return undefined
}

export async function dispatchCustomScreenRequest(method: string, value: unknown): Promise<unknown> {
  const args = requestObject(value)
  switch (method) {
    case "v1.api.catalog":
      return safeValue(CUSTOM_SCREEN_API_CATALOG)
    case "v1.runtime.error": {
      const message = typeof args.message === "string" ? args.message.slice(0, 500) : "Custom screen runtime error"
      toast("error", `Custom screen: ${message}`)
      return { recorded: true }
    }
    case "v1.app.snapshot": return snapshot()
    case "v1.app.open": openFeature(args.view, args.detail); return { opened: true }
    case "v1.features.open": openFeature(args.name, args.detail); return { opened: true }
    case "v1.projects.list": {
      const offset = z.number().int().min(0).max(256).default(0).parse(args.offset)
      const limit = z.number().int().min(1).max(100).default(50).parse(args.limit)
      const projects = get().projects
      return safeValue({ items: projects.slice(offset, offset + limit), total: projects.length, offset })
    }
    case "v1.projects.open": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (projectById(id) === undefined) throw new Error("Project was not found")
      setLayout({ activeProjectId: id })
      set({ view: { kind: "thread" } })
      return { opened: true }
    }
    case "v1.threads.list": {
      const projectId = typeof args.projectId === "string" ? args.projectId : undefined
      const offset = z.number().int().min(0).max(4_096).default(0).parse(args.offset)
      const limit = z.number().int().min(1).max(100).default(50).parse(args.limit)
      const threads = get().threads.filter((thread) => projectId === undefined || thread.projectId === projectId)
      return safeValue({ items: threads.slice(offset, offset + limit).map((thread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt, backend: thread.backend, model: thread.model, connectionId: thread.connectionId, mode: thread.mode, permission: thread.permission, worktree: thread.worktree, archived: thread.archived, pinned: thread.pinned, status: threadStatus(thread, runtimeOf(thread.id)) })), total: threads.length, offset })
    }
    case "v1.threads.get": {
      const id = z.string().min(1).max(128).parse(args.id)
      const thread = threadById(id)
      if (thread === undefined) throw new Error("Thread was not found")
      const historyLimit = z.number().int().min(1).max(200).default(50).parse(args.historyLimit)
      const runtime = runtimeOf(id)
      return safeValue({ thread, runtime: { ...runtime, timeline: { ...runtime.timeline, items: runtime.timeline.items.slice(-historyLimit) } } })
    }
    case "v1.threads.create": {
      const input: NewThreadInput = NewThreadSchema.parse(args)
      if (projectById(input.projectId) === undefined) throw new Error("Project was not found")
      const thread = createThread(input)
      return safeValue(thread)
    }
    case "v1.threads.open": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      openThread(id)
      return { opened: true }
    }
    case "v1.threads.send": {
      const id = z.string().min(1).max(128).parse(args.id)
      const input = z.object({ text: z.string().max(64 * 1024), skills: z.array(z.string().max(128)).max(32).optional() }).strict().parse(args.input)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      send(id, { ...input, trackUsage: true })
      return { sent: true }
    }
    case "v1.threads.steer": {
      const id = z.string().min(1).max(128).parse(args.id)
      const input = z.object({ text: z.string().max(64 * 1024) }).strict().parse(args.input)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      await steer(id, { ...input, trackUsage: true })
      return { sent: true }
    }
    case "v1.threads.cancel": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      await cancel(id)
      return { cancelled: true }
    }
    case "v1.threads.setPermission": {
      const id = z.string().min(1).max(128).parse(args.id)
      const permission = z.enum(["ask", "auto-edit", "auto", "full"]).parse(args.permission)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      if (permission === "full") return requireConfirmation({ title: "Use full access?", body: "With full access, the executor's commands and edits run with no approval. Use it only for projects you can throw away.", confirm: "Use full access", danger: true, run: async () => setPermission(id, permission) })
      setPermission(id, permission)
      return { updated: true }
    }
    case "v1.threads.setMode": {
      const id = z.string().min(1).max(128).parse(args.id)
      const mode = z.enum(["agent", "plan", "goal"]).parse(args.mode)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      setMode(id, mode)
      return { updated: true }
    }
    case "v1.threads.setAccess": {
      const id = z.string().min(1).max(128).parse(args.id)
      const access = z.enum(["plan", "ask", "auto-edit", "auto", "full"]).parse(args.access)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      if (access === "full") return requireConfirmation({ title: "Use full access?", body: "With full access, the executor's commands and edits run with no approval. Use it only for projects you can throw away.", confirm: "Use full access", danger: true, run: async () => setAccess(id, access) })
      setAccess(id, access)
      return { updated: true }
    }
    case "v1.threads.setModel": {
      const id = z.string().min(1).max(128).parse(args.id)
      const selection = z.object({ model: z.string().max(256).optional(), connectionId: z.string().max(256).optional() }).strict().parse(args.selection)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      setModel(id, selection.model === undefined ? undefined : { model: selection.model, ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }) })
      return { updated: true }
    }
    case "v1.threads.rename": {
      const id = z.string().min(1).max(128).parse(args.id)
      const title = z.string().trim().min(1).max(256).parse(args.title)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      renameThread(id, title)
      return { updated: true }
    }
    case "v1.threads.archive": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      await archiveWithUndo(id)
      return { archived: true }
    }
    case "v1.threads.delete": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      if (get().dialog !== undefined) throw new Error("Finish the open Runrail dialog first")
      confirmDeleteForever(id)
      return { confirmationShown: true }
    }
    case "v1.threads.reload": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      await reloadHistory(id)
      return { loaded: true }
    }
    case "v1.panels.list": {
      const threadId = z.string().min(1).max(128).parse(args.threadId)
      if (threadById(threadId) === undefined) throw new Error("Thread was not found")
      return safeValue(panelOf(threadId))
    }
    case "v1.panels.open": {
      const threadId = z.string().min(1).max(128).parse(args.threadId)
      const kind = z.enum(PANEL_KINDS).parse(args.kind)
      if (threadById(threadId) === undefined) throw new Error("Thread was not found")
      focusPanelThread(threadId)
      openPanel(threadId, kind)
      const panel = panelOf(threadId)
      if (!panel.tabs.some((tab) => tab.kind === kind)) throw new Error("This thread has no room for another panel of that type")
      return safeValue({ opened: true, panel })
    }
    case "v1.panels.create": {
      const input = z.object({ threadId: z.string().min(1).max(128), kind: z.enum(PANEL_KINDS), url: z.string().url().max(2_048).optional() }).strict().parse(args)
      if (threadById(input.threadId) === undefined) throw new Error("Thread was not found")
      if (input.url !== undefined && input.kind !== "browser") throw new Error("Only browser panels accept a URL")
      const address = input.url === undefined ? undefined : new URL(input.url)
      if (address !== undefined && ((address.protocol !== "http:" && address.protocol !== "https:") || address.username.length > 0 || address.password.length > 0)) throw new Error("Browser panel URLs must be safe http or https addresses")
      if (address !== undefined && !isLocalUrl(address) && address.protocol !== "https:") throw new Error("External browser previews must use https")
      const create = (): { readonly created: boolean; readonly tabId: string } => {
        focusPanelThread(input.threadId)
        if (SINGLE_PANELS.has(input.kind)) {
          const existed = panelOf(input.threadId).tabs.some((tab) => tab.kind === input.kind)
          openPanel(input.threadId, input.kind)
          const tab = panelOf(input.threadId).tabs.find((entry) => entry.kind === input.kind)
          if (tab === undefined) throw new Error("This thread has no room for another panel of that type")
          return { created: !existed, tabId: tab.id }
        }
        const tabId = newPanelTab(input.threadId, input.kind, input.url)
        if (tabId === undefined) {
          const existing = [...panelOf(input.threadId).tabs].reverse().find((tab) => tab.kind === input.kind)
          if (existing !== undefined) return { created: false, tabId: existing.id }
          throw new Error("This thread has no room for another panel tab")
        }
        return { created: true, tabId }
      }
      if (address !== undefined && !isLocalUrl(address)) {
        const thread = threadById(input.threadId)
        const project = thread === undefined ? undefined : projectById(thread.projectId)
        const target = `${address.origin}${confirmationLabel(address.pathname, 240)}${address.search.length > 0 ? "?query included" : ""}`
        return requireConfirmation({
          title: "Open an external browser preview?",
          body: `Runrail will load ${target} in this thread's browser panel. Query values and fragments are not saved.${project?.browserSignIns === true ? " This project has saved browser sign-ins that the preview may reuse." : ""}`,
          confirm: "Open preview",
          run: async () => create(),
        })
      }
      return create()
    }
    case "v1.panels.select": {
      const threadId = z.string().min(1).max(128).parse(args.threadId)
      const tabId = z.string().min(1).max(128).parse(args.tabId)
      if (threadById(threadId) === undefined || !panelOf(threadId).tabs.some((tab) => tab.id === tabId)) throw new Error("Panel tab was not found")
      focusPanelThread(threadId)
      selectPanelTab(threadId, tabId)
      return { selected: true }
    }
    case "v1.panels.close": {
      const threadId = z.string().min(1).max(128).parse(args.threadId)
      const tabId = z.string().min(1).max(128).parse(args.tabId)
      if (threadById(threadId) === undefined || !panelOf(threadId).tabs.some((tab) => tab.id === tabId)) throw new Error("Panel tab was not found")
      closePanelTab(threadId, tabId)
      return { closed: true }
    }
    case "v1.threads.openApproval": {
      const id = z.string().min(1).max(128).parse(args.id)
      if (threadById(id) === undefined) throw new Error("Thread was not found")
      openThread(id)
      return { opened: true, actionRequired: "Answer in Runrail" }
    }
    case "v1.workflows.list": {
      const projectId = z.string().min(1).max(128).parse(args.projectId)
      if (projectById(projectId) === undefined) throw new Error("Project was not found")
      await loadWorkflows(projectId)
      return safeValue(useWorkflows.getState().byProject[projectId] ?? null)
    }
    case "v1.workflows.run": {
      const projectId = z.string().min(1).max(128).parse(args.projectId)
      const id = z.string().min(1).max(128).parse(args.id)
      if (projectById(projectId) === undefined) throw new Error("Project was not found")
      const input = typeof args.input === "string" ? args.input.slice(0, 8_000) : undefined
      return safeValue(await runWorkflow(projectId, id, "manual", undefined, input))
    }
    case "v1.workflows.openRun": {
      const runId = z.string().min(1).max(128).parse(args.runId)
      const known = useWorkflows.getState().runs[runId]
      if (known === undefined) throw new Error("Workflow run was not found")
      setLayout({ activeProjectId: known.projectId })
      set({ view: { kind: "workflows", projectId: known.projectId, runId } })
      return { opened: true, actionRequired: "Review the run in Workflows" }
    }
    case "v1.workflows.stop": {
      const runId = z.string().min(1).max(128).parse(args.runId)
      await stopWorkflowRun(runId)
      return { stopped: true }
    }
    case "v1.workflows.openForApproval": {
      const projectId = z.string().min(1).max(128).parse(args.projectId)
      const id = z.string().min(1).max(128).parse(args.id)
      return openWorkflowForReview(projectId, id)
    }
    case "v1.workflows.enable": {
      const projectId = z.string().min(1).max(128).parse(args.projectId)
      const id = z.string().min(1).max(128).parse(args.id)
      const on = z.boolean().parse(args.on)
      if (projectById(projectId) === undefined) throw new Error("Project was not found")
      if (on) {
        await loadWorkflows(projectId)
        if (useWorkflows.getState().byProject[projectId]?.workflows.find((workflow) => workflow.id === id)?.state === "proposed") {
          return openWorkflowForReview(projectId, id)
        }
      }
      return safeValue(await enableWorkflow(projectId, id, on))
    }
    case "v1.workflows.delete": {
      const projectId = z.string().min(1).max(128).parse(args.projectId)
      const id = z.string().min(1).max(128).parse(args.id)
      if (projectById(projectId) === undefined) throw new Error("Project was not found")
      await loadWorkflows(projectId)
      const workflow = useWorkflows.getState().byProject[projectId]?.workflows.find((entry) => entry.id === id)
      if (workflow === undefined) throw new Error("Workflow was not found")
      return requireConfirmation({ title: `Delete ${confirmationLabel(workflow.name, 80)}?`, body: "The workflow and its run history are removed. Threads its runs opened stay.", confirm: "Delete", danger: true, run: () => deleteWorkflow(projectId, id) })
    }
    case "v1.rpc.thread": {
      const threadId = z.string().min(1).max(128).parse(args.threadId)
      const methodName = z.string().min(1).max(128).parse(args.method)
      const params = requestObject(args.params)
      if (!THREAD_RPC.has(methodName) || threadById(threadId) === undefined) throw new Error("Thread API method is not available")
      const prompt = rpcConfirmation("thread", methodName, params, { threadId })
      if (prompt !== undefined) return requireConfirmation({ ...prompt, run: () => threadRpc(threadId, methodName, params) })
      return safeValue(await threadRpc(threadId, methodName, params))
    }
    case "v1.rpc.project": {
      const projectId = z.string().min(1).max(128).parse(args.projectId)
      const methodName = z.string().min(1).max(128).parse(args.method)
      const params = requestObject(args.params)
      if (!PROJECT_RPC.has(methodName) || projectById(projectId) === undefined) throw new Error("Project API method is not available")
      const prompt = rpcConfirmation("project", methodName, params, { projectId })
      if (prompt !== undefined) return requireConfirmation({ ...prompt, run: () => projectRpc(projectId, methodName, params) })
      return safeValue(await projectRpc(projectId, methodName, params))
    }
    case "v1.rpc.system": {
      const methodName = z.string().min(1).max(128).parse(args.method)
      const params = requestObject(args.params)
      if (!SYSTEM_RPC.has(methodName)) throw new Error("System API method is not available")
      const prompt = rpcConfirmation("system", methodName, params)
      if (prompt !== undefined) return requireConfirmation({ ...prompt, run: () => systemRpc(methodName, methodName === "connection.vendorSignOut" ? { ...params, confirm: true } : params) })
      return safeValue(await systemRpc(methodName, params))
    }
    case "v1.host.call": return hostCall(args)
    default: throw new Error("Runrail API method is not available")
  }
}

export async function answerCustomScreenRequest(request: CustomScreenRequest): Promise<void> {
  const host = getHost()
  try {
    const value = await dispatchCustomScreenRequest(request.method, request.args)
    await host.customScreenReply(request.id, { ok: true, value }).catch(() => undefined)
  } catch (error) {
    const safe = toHostError(error)
    await host.customScreenReply(request.id, { ok: false, error: safe.message }).catch(() => undefined)
  }
}
