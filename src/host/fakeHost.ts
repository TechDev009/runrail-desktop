import type { AgentDefinition, Behavior, ComputerAccess, ComputerApp, EngineInfo, EngineStartInput, Host, ListenInput, LoginItemStatus, McpServer, ModelProgress, NotifyStatus, OtherTools, RunningComputerApp, StreamFrame, StreamState, VoiceEvent, VoiceModel, PhoneHook, PhonePushTarget, PhoneShare, QuickMessage, QuickStatus, PhoneStatus, RemoteMachine, TailscaleStatus, WakeServiceStatus, WorkspaceInfo } from "./types"
import { FakeConnections, guardRendererRpc, previewPlan, type PreviewScenario } from "./fakeConnections"
import { QUEST_FILE } from "../app/quests"
import { officeQuestFile, officeScripts, officeState, playOfficeRole, type OfficeScript } from "./fakeOffice"
import { REVIEW_METHODS, reviewsRpc } from "./fakeReviews"
import { FakeEvals } from "./fakeEvals"
import { FakeMemory } from "./fakeMemory"
import { FakeWorkflows } from "./fakeWorkflows"
import { FakeConnectors } from "./fakeConnectors"
import { FakeSetups } from "./fakeSetups"
import { fakeSimulator } from "./fakeSimulator"
import { fakeAndroid } from "./fakeAndroid"
import { HostError, SYSTEM_ENGINE_ID } from "./types"

/**
 * In-memory preview host for browser development and UI tests. It scripts a realistic engine:
 * streamed markdown, reasoning, a plan, explore/edit/shell tools, approvals, subagents, git
 * state, and a toy terminal. No process, file system, network, or credentials are touched.
 */

type Listener<T extends unknown[]> = (...args: T) => void

interface FakeFile {
  path: string
  change: "modified" | "added" | "deleted"
  staged: boolean
  additions: number
  deletions: number
  patch: string
}

interface FakeTerminal {
  cols: number
  rows: number
  chunks: { seq: number; data: string }[]
  nextSeq: number
  line: string
  closed: boolean
}

interface FakeConversationItem {
  id: string
  seq: number
  at: number
  turnId?: string
  kind: "user" | "assistant" | "tool" | "notice" | "review"
  text?: string
  callId?: string
  name?: string
  presentation?: Record<string, unknown>
  status?: "ok" | "failed"
  errorCode?: string
  output?: string
  level?: "info" | "error"
  code?: string
  message?: string
  reviewId?: string
  reviewer?: "codex" | "claude-code"
  decision?: "approved" | "denied"
  action?: string
  capability?: string
  risk?: "low" | "high"
  source?: "reviewer"
  detail?: string
  rationale?: string
  inTool?: true
  turns?: number
  retry?: { attempt: number; maxRetries: number; delayMs: number; status?: number; error?: string; waitedMs?: number }
}

/** The backends whose conversation the engine can compact. */
const COMPACTING_BACKENDS = new Set(["native", "claude-code", "codex"])
/** Backends whose turn takes guidance mid-turn: Claude Code only while one of its tools runs. */
const STEERING_BACKENDS = new Set(["native", "claude-code", "codex"])

/** The fake's second round, after "Ask me more". */
const FOLLOW_UP_QUESTIONS = [
  { id: "q7", header: "Zones", question: "Which time zone should dates default to?", options: [{ label: "UTC (Recommended)", recommended: true, description: "Same everywhere" }, { label: "The reader's own", description: "Follows the browser" }], other: true },
  { id: "q8", header: "Formats", question: "Which date formats should the parser accept?", options: [{ label: "ISO 8601" }, { label: "US (MM/DD)" }, { label: "European (DD.MM)" }], multiSelect: true, other: true },
]

/** What a preview rewind offers to put back. */
const REWIND_FILES = [
  { path: "src/parser.ts", change: "modified" },
  { path: "src/parser.test.ts", change: "added" },
  { path: "docs/old-notes.md", change: "deleted" },
] as const

const CAPABILITIES: Record<string, string> = {
  "workspace.write": "available",
  "workspace.folders": "available",
  "git.read": "available",
  "git.write": "available",
  "git.remote": "available",
  "git.pr": "available",
  "git.branches": "available",
  "git.fetch": "available",
  "git.pr.list": "available",
  "git.pr.reviews": "available",
  "git.pr.review.post": "available",
  "git.pr.merge": "available",
  "git.pr.checks": "available",
  "git.pull": "available",
  "git.diff.stats": "available",
  codehosts: "available",
  "codehost.remotes": "available",
  worktrees: "available",
  checks: "available",
  setups: "available",
  evals: "available",
  memory: "available",
  workflows: "available",
  "terminal.describe": "available",
  "terminal.create": "available",
  "terminal.write": "available",
  "terminal.read": "available",
  "terminal.resize": "available",
  "terminal.close": "available",
  "live.frames": "available",
  "session.conversation": "available",
  "task.rename": "available",
  "harness.status": "available",
  mcp: "available",
  connectors: "available",
  agents: "available",
  accounts: "available",
  connections: "available",
  "connection.settings": "available",
  "connection.tools": "available",
  "connection.signin": "available",
  "connection.login": "available",
  "approval.scope": "available",
  "approval.questions": "available",
  "approval.followUp": "available",
  "account.secrets": "available",
  "auth.signin": "available",
  background: "available",
}

const SAMPLE_PATCH = `@@ -12,9 +12,14 @@ export function parseSession(input: string): Session {
   const lines = input.split("\\n")
-  const entries = lines.map((line) => JSON.parse(line))
-  return { entries }
+  const entries: Entry[] = []
+  for (const [index, line] of lines.entries()) {
+    if (line.trim().length === 0) continue
+    try {
+      entries.push(JSON.parse(line) as Entry)
+    } catch {
+      throw new SessionError("SESSION_INVALID", \`line \${index + 1} is not JSON\`)
+    }
+  }
+  return { entries }
 }

 export function serialize(session: Session): string {`

const TEST_PATCH = `@@ -0,0 +1,18 @@
+import { expect, test } from "bun:test"
+import { parseSession } from "../src/session"
+
+test("skips blank lines", () => {
+  expect(parseSession("{}\\n\\n{}").entries.length).toBe(2)
+})
+
+test("reports the failing line", () => {
+  expect(() => parseSession("{}\\nnope")).toThrow("line 2")
+})`

type SeedItem = Omit<FakeConversationItem, "id" | "seq" | "at">

function importedTranscript(title: string, source: string, inTool = false): SeedItem[] {
  return [
    { kind: "user", turnId: "import-1", text: title },
    { kind: "assistant", turnId: "import-1", text: "I read the current implementation and the tests around it. The loader mixes file discovery with parsing, so I split those into two functions and kept the public signature unchanged." },
    { kind: "user", turnId: "import-2", text: "Keep the old env var names working." },
    { kind: "assistant", turnId: "import-2", text: "Done. The legacy names are read as fallbacks and a notice is logged once per process. Tests cover both spellings." },
    { kind: "notice", turnId: "import-2", level: "info", code: "session.imported", name: source, ...(inTool ? { inTool: true } : {}) },
  ]
}

function grownTurns(source: string, inTool: boolean): SeedItem[] {
  return [
    { kind: "user", turnId: "import-3", text: "Cache the parsed config between calls." },
    { kind: "assistant", turnId: "import-3", text: "The loader now keeps the parsed config per path and drops it when the file changes." },
    { kind: "user", turnId: "import-4", text: "Run the tests once more." },
    { kind: "assistant", turnId: "import-4", text: "All 48 tests pass." },
    { kind: "notice", turnId: "import-4", level: "info", code: "session.refreshed", name: source, turns: 2, ...(inTool ? { inTool: true } : {}) },
  ]
}

/** The preview's checkout state and the person's git host answers, shared by every fake engine. */
let previewGit: PreviewScenario["git"]
let previewGh: PreviewScenario["gh"]
let previewPr: PreviewScenario["pr"]
let previewUsage: PreviewScenario["usage"]

/** Pull requests made in the preview, so a later status read finds them. */
const createdPulls: Record<string, unknown>[] = []
/** The failing preview PR's fix: pushed at this time, its checks run for a few seconds, then pass. */
let ciPushedAt: number | undefined
let autoMerge = false
const FAILING_HEAD = "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d"
const FIXED_HEAD = "2b3c4d5e6f7a8b9c0d1e2b3c4d5e6f7a8b9c0d1e"
const CI_RUN_MS = 4_000

function previewFailingLog(): string {
  return [
    "## Run bun test",
    "bun test v1.4.2",
    "",
    "test/palette.test.ts:",
    "✓ ranks an exact prefix first [0.41ms]",
    "✗ matches across word boundaries [1.20ms]",
    "",
    "error: expect(received).toEqual(expected)",
    '  - "open settings"',
    '  + "open file"',
    "",
    "      at <anonymous> (test/palette.test.ts:42:31)",
    "",
    " 47 pass",
    " 1 fail",
    "Ran 48 tests across 12 files. [312.00ms]",
    "Error: Process completed with exit code 1.",
  ].join("\n")
}
/** The preview's setups and runs, one set for every project. */
const fakeSetups = new FakeSetups()
const fakeEvals = new FakeEvals(fakeSetups)
const fakeMemory = new FakeMemory()
const fakeWorkflows = new FakeWorkflows(fakeSetups)
const fakeConnectors = new FakeConnectors()

async function withFakeRecall(message: unknown): Promise<unknown> {
  const text = typeof message === "string" ? message : typeof message === "object" && message !== null ? String((message as { text?: unknown }).text ?? "") : ""
  const block = await fakeMemory.blockFor(text)
  if (block.length === 0) return message
  return typeof message === "string" ? `${text}${block}` : { ...(message as object), text: `${text}${block}` }
}
/** Running preview checks, by id, so `check.stop` can end one. */
const fakeChecks = new Map<string, () => void>()

function previewPullRequests(): Record<string, unknown>[] {
  if (previewPr === undefined || previewPr === "none") return [...createdPulls]
  const hour = 3_600_000
  const run = (name: string, state: string, detailsUrl = `https://github.com/example/project/actions/runs/${name}`) => ({ name, state, url: detailsUrl })
  const checks = (items: { name: string; state: string; url?: string }[]) => ({
    passed: items.filter((item) => item.state === "passed").length,
    failed: items.filter((item) => item.state === "failed").length,
    pending: items.filter((item) => item.state === "pending").length,
    skipped: items.filter((item) => item.state === "skipped").length,
    items: [...items].sort((a, b) => ["failed", "pending", "passed", "skipped"].indexOf(a.state) - ["failed", "pending", "passed", "skipped"].indexOf(b.state)),
  })
  const passing = [run("build", "passed"), run("test (ubuntu)", "passed"), run("test (macos)", "passed"), run("lint", "passed"), run("typecheck", "passed")]
  const base = { number: 128, url: "https://github.com/example/project/pull/128", title: "Faster fuzzy search in the palette", head: "feat/search", headCommit: FIXED_HEAD, base: "main", author: "mira", draft: false, state: "open", merged: false, updatedAt: Date.now() - hour, review: "required", mergeable: "yes", checks: checks(passing) }
  switch (previewPr) {
    case "running":
      return [{ ...base, checks: checks([run("build", "passed"), run("lint", "passed"), run("typecheck", "passed"), run("test (ubuntu)", "pending"), run("test (macos)", "pending")]) }]
    case "failing":
      if (ciPushedAt !== undefined && Date.now() - ciPushedAt < CI_RUN_MS) return [{ ...base, headCommit: FIXED_HEAD, checks: checks([run("build", "passed"), run("lint", "passed"), run("typecheck", "passed"), run("test (ubuntu)", "pending"), run("test (macos)", "pending")]) }]
      // With auto-merge on, GitHub merges once the checks pass.
      if (ciPushedAt !== undefined && autoMerge) return [{ ...base, state: "merged", merged: true, mergedAt: ciPushedAt + CI_RUN_MS, closedAt: ciPushedAt + CI_RUN_MS }]
      if (ciPushedAt !== undefined) return [{ ...base, headCommit: FIXED_HEAD }]
      return [{ ...base, headCommit: FAILING_HEAD, checks: checks([run("build", "passed"), run("test (ubuntu)", "failed", "https://github.com/example/project/actions/runs/9100/job/51"), run("test (macos)", "passed"), run("lint", "passed"), run("typecheck", "passed")]) }]
    case "draft":
      return [{ ...base, draft: true, review: "none" }]
    case "approved":
      return [{ ...base, review: "approved" }]
    case "changes":
      return [{ ...base, review: "changes-requested" }]
    case "conflicts":
      return [{ ...base, mergeable: "conflicts" }]
    case "merged":
      return [{ ...base, state: "merged", merged: true, mergedAt: Date.now() - 2 * hour, closedAt: Date.now() - 2 * hour }]
    case "closed":
      return [{ ...base, state: "closed", closedAt: Date.now() - 3 * hour }]
    default:
      return [base]
  }
}
const codeHosts = new Map<string, { host: string; service?: string; connection?: { via: "gh"; enabled: boolean; addedAt: number } }>()

function previewRemotes(): Record<string, unknown>[] {
  const github = (owner: string, name: string) => ({ name, url: `https://github.com/${owner}/project.git`, host: "github.com", owner, repo: "project", path: `${owner}/project`, service: "github", serviceFrom: "host" })
  const answered = codeHosts.get("gitlab.corp.example")?.service
  switch (previewGit) {
    case "noremote":
      return []
    case "gitlab":
      return [{ name: "origin", url: "git@gitlab.com:group/sub/project.git", host: "gitlab.com", path: "group/sub/project", service: "gitlab", serviceFrom: "host" }]
    case "guess":
      return [{ name: "origin", url: "https://gitlab.corp.example/example-org/project.git", host: "gitlab.corp.example", owner: "example-org", repo: "project", path: "example-org/project", service: answered ?? "gitlab", serviceFrom: answered === undefined ? "name" : "user" }]
    case "fork":
      return [github("me", "origin"), github("example", "upstream")]
    default:
      return [github("example", "origin")]
  }
}

/** The `projects` preview: one project per line Settings → Projects can show, none with a thread. */
const PREVIEW_PROJECTS = ["example-web", "mobile-app", "corp-api", "web-fork", "local-tool", "notes"] as const

function projectsState(now = Date.now()) {
  return {
    version: 1,
    projects: PREVIEW_PROJECTS.map((name, index) => ({ id: `preview-p${String(index + 1)}`, path: `/Users/preview/code/${name}`, name, git: true, addedAt: now - (30 - index) * 86_400_000 })),
    threads: [],
    prefs: {},
    // Without `panels` the parser drops the whole layout.
    layout: { panels: {} },
  }
}

/**
 * The checkout's branch, the same for the folder read and a thread's status so the bar holds when a
 * thread starts: one `projects` preview folder is detached, one has no commits, else the scenario's.
 */
function folderHead(path: string): { readonly branch?: string; readonly detached: boolean; readonly initial: boolean } {
  const name = path.split("/").filter(Boolean).pop()
  if (name === "mobile-app" || (previewGit === "detached" && !(PREVIEW_PROJECTS as readonly (string | undefined)[]).includes(name))) return { detached: true, initial: false }
  if (name === "local-tool") return { branch: "main", detached: false, initial: true }
  if (name === "web-fork") return { branch: "fix/login-redirect", detached: false, initial: false }
  return { branch: previewGit === "unpublished" || previewGit === "noremote" || previewPr !== undefined ? "feat/search" : "main", detached: false, initial: false }
}

/** What `codehost.remotes` finds in a folder: the `projects` preview's by name, else the scenario's remotes. */
function folderRemotes(path: string): Record<string, unknown> {
  const git = folderGit(path)
  if (!git.git) return git
  const head = folderHead(path)
  return { ...git, ...head, ...(head.initial ? {} : { head: head.detached ? "4f2c9e1a7b3d5e6f8091a2b3c4d5e6f708192a3b" : "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d" }) }
}

function folderGit(path: string): { readonly git: boolean; readonly remotes?: readonly Record<string, unknown>[] } {
  const github = (owner: string, name: string) => ({ name, url: `https://github.com/${owner}/web.git`, host: "github.com", owner, repo: "web", path: `${owner}/web`, service: "github", serviceFrom: "host" })
  const answered = codeHosts.get("git.corp.example")?.service
  switch (path.split("/").filter(Boolean).pop()) {
    case "notes":
      return { git: false }
    case "local-tool":
      return { git: true, remotes: [] }
    case "example-web":
      return { git: true, remotes: [github("example-org", "origin")] }
    case "mobile-app":
      return { git: true, remotes: [{ name: "origin", url: "git@gitlab.com:example-org/mobile/app.git", host: "gitlab.com", path: "example-org/mobile/app", service: "gitlab", serviceFrom: "host" }] }
    case "corp-api":
      return { git: true, remotes: [{ name: "origin", url: "git.corp.example:ops/platform/api.git", host: "git.corp.example", path: "ops/platform/api", service: answered ?? "gitlab", serviceFrom: answered === undefined ? "path" : "user" }] }
    case "web-fork":
      return { git: true, remotes: [github("me", "origin"), github("example-org", "upstream")] }
    default:
      return { git: true, remotes: previewRemotes() }
  }
}

/** The git host answers every fake engine shares, as the engine keeps them in the accounts folder. */
async function codeHostRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "codehost.remotes": {
      const path = params.path
      if (typeof path !== "string" || !path.startsWith("/") || path.length > 4_096 || path.includes("\0")) throw new HostError("CONTROL_INVALID_INPUT", "path must be an absolute folder path", 400)
      await delay(120)
      return folderRemotes(path)
    }
    case "codehost.list":
      return { hosts: [...codeHosts.values()] }
    case "codehost.set":
    case "codehost.connect":
    case "codehost.disconnect": {
      const host = String(params.host ?? "").toLowerCase()
      if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) throw new HostError("CONTROL_INVALID_INPUT", "host must be a host name, optionally with a port", 400)
      const record = { ...(codeHosts.get(host) ?? { host }) }
      if (method === "codehost.set") record.service = String(params.service)
      if (method === "codehost.connect") {
        if (previewGh === "missing") throw new HostError("CONTROL_PR_UNAVAILABLE", "install the GitHub CLI (gh) first", 501)
        record.connection = { via: "gh", enabled: true, addedAt: Date.now() }
      }
      if (method === "codehost.disconnect") delete record.connection
      if (record.service === undefined && record.connection === undefined) codeHosts.delete(host)
      else codeHosts.set(host, record)
      return record
    }
    case "codehost.status":
      await delay(300)
      return previewGh === "missing" ? { state: "missing" } : previewGh === "signed-out" ? { state: "signed-out" } : { state: "ready", login: "preview-user" }
    default:
      throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The preview's src/session.ts, long enough that a link to one of its lines has somewhere to go. */
const FAKE_SESSION_SOURCE = `import { SessionError } from "./errors"
import type { Entry, Session } from "./types"

/**
 * Reads a session transcript: one JSON entry per line. Blank lines are skipped, and a line that
 * is not JSON fails with its 1-based number.
 */
export function parseSession(input: string): Session {
  const lines = input.split("\\n")
  const entries: Entry[] = []

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line) as Entry)
    } catch {
      throw new SessionError("SESSION_INVALID", \`line \${index + 1} is not JSON\`)
    }
  }

  return { entries, startedAt: entries[0]?.at ?? 0 }
}

export function lastEntry(session: Session): Entry | undefined {
  return session.entries[session.entries.length - 1]
}

export function entriesOfKind(session: Session, kind: Entry["kind"]): readonly Entry[] {
  return session.entries.filter((entry) => entry.kind === kind)
}

export function sessionLength(session: Session): number {
  const first = session.entries[0]?.at
  const last = lastEntry(session)?.at
  return first === undefined || last === undefined ? 0 : last - first
}
`

function chunkText(text: string, size: number): string[] {
  const parts: string[] = []
  let position = 0
  while (position < text.length) {
    const next = Math.min(text.length, position + size + Math.floor(Math.random() * size))
    parts.push(text.slice(position, next))
    position = next
  }
  return parts
}

const FAKE_TOOLS = [
  { id: "native", name: "Runrail", kind: "native", firstParty: true },
  { id: "claude-code", name: "Claude Code", kind: "command" },
  { id: "codex", name: "Codex", kind: "command" },
  { id: "copilot", name: "GitHub Copilot CLI", kind: "copilot" },
  { id: "opencode", name: "OpenCode", kind: "opencode" },
  { id: "gemini", name: "Gemini CLI", kind: "gemini" },
  { id: "goose", name: "Goose", kind: "goose" },
  { id: "pi", name: "Pi", kind: "command" },
]

type ToolSeed = NonNullable<PreviewScenario["seed"]>

/**
 * What the engine would learn by asking each coding tool about itself. The default preview has all
 * four ready, `mixed` shows one in each state, and `empty` has Claude Code alone. Copilot never
 * says whether it is signed in, so that is never reported for it.
 */
function fakeToolStatus(seed: ToolSeed): unknown[] {
  const state: Record<string, "ready" | "signed-out" | "missing"> =
    seed === "mixed"
      ? { "claude-code": "ready", codex: "signed-out", copilot: "ready", opencode: "ready", gemini: "ready", goose: "missing", pi: "missing" }
      : seed === "empty"
        ? { "claude-code": "ready", codex: "missing", copilot: "missing", opencode: "missing", gemini: "missing", goose: "missing", pi: "missing" }
        : { "claude-code": "ready", codex: "ready", copilot: "ready", opencode: "ready", gemini: "ready", goose: "ready", pi: "ready" }
  const found: Record<string, Record<string, unknown>> = {
    "claude-code": {
      version: "2.1.287",
      // As the engine lists them: Claude Code's own rows, each alias with the model it runs, then the catalog's other versions.
      models: [
        { id: "opus", name: "Opus 5.5", resolved: "claude-opus-5-5", default: true },
        { id: "claude-fable-5-1[1m]", name: "Fable 5.1", resolved: "claude-fable-5-1[1m]" },
        { id: "sonnet", name: "Sonnet 5.5", resolved: "claude-sonnet-5-5" },
        { id: "haiku", name: "Haiku 4.5", resolved: "claude-haiku-4-5-20251001", reasoning: false },
        ...[["claude-opus-5", "Opus 5"], ["claude-opus-4-8", "Opus 4.8"], ["claude-opus-4-7", "Opus 4.7"], ["claude-opus-4-6", "Opus 4.6"], ["claude-opus-4-5", "Opus 4.5"], ["claude-fable-5", "Fable 5"], ["claude-sonnet-5", "Sonnet 5"], ["claude-sonnet-4-6", "Sonnet 4.6"], ["claude-sonnet-4-5", "Sonnet 4.5"]].map(([id, name]) => ({ id, name, catalog: true })),
      ],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      freeTextModel: true,
    },
    codex: {
      version: "0.155.1",
      models: [
        { id: "preview-codex-large", name: "Preview Codex Large", default: true, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        { id: "preview-codex-small", name: "Preview Codex Small", efforts: ["low", "medium"] },
      ],
      efforts: ["low", "medium", "high"],
      freeTextModel: true,
      // As the engine reads Codex's config.toml when its chosen provider is a local proxy.
      proxy: { address: "127.0.0.1:8787", name: "OpenAI via Headroom proxy" },
    },
    copilot: { version: "1.0.62", efforts: ["low", "medium", "high", "xhigh", "max"], freeTextModel: true },
    opencode: {
      version: "1.2.26",
      models: [
        { id: "lmstudio/preview-qwen", name: "preview-qwen" },
        { id: "anthropic/preview-sonnet/high", name: "preview-sonnet (high)" },
      ],
      freeTextModel: true,
    },
    gemini: { version: "0.62.0", freeTextModel: true },
    goose: { version: "1.53.0", freeTextModel: true },
    pi: {
      version: "0.84.1",
      models: [
        { id: "github-copilot/preview-gpt", name: "preview-gpt", reasoning: true },
        { id: "github-copilot/preview-sonnet", name: "preview-sonnet", reasoning: true },
        { id: "radius/preview-auto", name: "preview-auto", reasoning: false },
      ],
      freeTextModel: true,
    },
  }
  return FAKE_TOOLS.map((descriptor) => {
    const tool = state[descriptor.id]
    if (tool === undefined) return { descriptor, available: true }
    if (tool === "missing") return { descriptor, available: false, reason: "not-installed" }
    // As the engine reports them: these tools have no command that says whether they are signed in.
    const signedIn = ["copilot", "gemini", "goose"].includes(descriptor.id) ? {} : { signedIn: tool === "ready" }
    return { descriptor, available: true, ...(tool === "signed-out" ? { reason: "signed-out" } : {}), ...signedIn, ...found[descriptor.id] }
  })
}

/** What the preview pretends other tools on this computer are set up with. */
const PREVIEW_OTHER_TOOLS: OtherTools = {
  instructions: [
    { tool: "claude-code", scope: "global", place: "~/.claude/CLAUDE.md", text: "Prefer small, reviewable changes.\nRun the tests before saying a change works." },
    { tool: "codex", scope: "global", place: "~/.codex/AGENTS.md", text: "Use the repository's own scripts; never install global packages." },
    { tool: "gemini", scope: "project", place: "GEMINI.md", text: "This project uses pnpm and Vitest." },
  ],
  skills: [
    { tool: "claude-code", name: "code-review", description: "Reviews a diff for bugs before it is committed", path: "/Users/preview/.claude/skills/code-review", place: "~/.claude/skills/code-review" },
    { tool: "codex", name: "release-notes", description: "Drafts release notes from merged pull requests", path: "/Users/preview/.codex/skills/release-notes", place: "~/.codex/skills/release-notes" },
    { tool: "shared", name: "sql-migrations", description: "Writes reversible SQL migrations", path: "/Users/preview/.agents/skills/sql-migrations", place: "~/.agents/skills/sql-migrations" },
  ],
  servers: [
    { tool: "claude-code", scope: "global", place: "~/.claude.json", original: "github", server: { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], enabled: true }, leftOut: ["the values of GITHUB_PERSONAL_ACCESS_TOKEN; set them in your shell"] },
    { tool: "codex", scope: "global", place: "~/.codex/config.toml", original: "linear", server: { name: "linear", command: "", args: [], env: [], url: "https://mcp.linear.app/mcp", bearerEnv: "LINEAR_API_KEY", enabled: true }, leftOut: [] },
    { tool: "cursor", scope: "global", place: "~/.cursor/mcp.json", original: "Remote Docs", leftOut: ["address must be https, or http on this computer, with no user name or password"] },
  ],
  agents: [{ tool: "claude-code", name: "test-writer", description: "Writes focused tests for a change", path: "/Users/preview/.claude/agents/test-writer.md", place: "~/.claude/agents/test-writer.md" }],
}

/** A long answer for the preview's long thread: prose, highlighted code, a table, and a list. */
function longAnswer(turn: number): string {
  const step = String(turn + 1)
  const code = Array.from({ length: 24 }, (_, line) => `  const value${String(line)} = parseLine${step}(lines[${String(line)}] ?? "", { strict: ${line % 2 === 0 ? "true" : "false"} })`).join("\n")
  return [
    `Step ${step} is in. The parser now reads both line endings, reports the line number of a bad entry, and keeps \`parseLegacy${step}\` as a thin wrapper so older callers keep working.`,
    "",
    "```ts",
    `export function parse${step}(input: string): Entry[] {`,
    "  const lines = input.split(/\\r?\\n/)",
    code,
    "  return entries",
    "}",
    "```",
    "",
    "| Input | Before | After |",
    "| --- | --- | --- |",
    `| CRLF file | one entry per file | one entry per line (step ${step}) |`,
    "| Blank lines | parse error | skipped |",
    "| Bad JSON | generic error | `SESSION_INVALID` with the line |",
    "",
    `1. Run \`bun test test/parser-${step}.test.ts\`.`,
    "2. Check the legacy callers in `src/import.ts`.",
    "3. Remove the shim once nothing calls it.",
  ].join("\n")
}

/** The preview's sessions recorded outside any project, by id: one in a folder that exists, one whose folder is gone. */
const ELSEWHERE: Readonly<Record<string, { readonly source: "claude-code" | "codex"; readonly title: string; readonly cwd: string; readonly hoursAgo: number; readonly missing?: true }>> = {
  "cc-51d0": { source: "claude-code", title: "Prototype the CSV importer", cwd: "/Users/preview/scratch/csv-import", hoursAgo: 5 },
  "cx-0e77": { source: "codex", title: "Port billing to the new API", cwd: "/Users/preview/old/billing-v1", hoursAgo: 72, missing: true },
}

/** Git status entries and counts for a fake checkout's changed files. */
function statusEntries(files: readonly FakeFile[]): { readonly entries: Record<string, unknown>[]; readonly counts: Record<string, number> } {
  const entries = files.map((file) => ({
    path: file.path,
    index: file.staged ? (file.change === "added" ? "A" : "M") : file.change === "added" ? "?" : ".",
    worktree: file.staged ? "." : file.change === "added" ? "?" : "M",
    staged: file.staged,
    unstaged: !file.staged,
    untracked: !file.staged && file.change === "added",
    conflicted: false,
  }))
  return {
    entries,
    counts: {
      staged: entries.filter((entry) => entry.staged).length,
      unstaged: entries.filter((entry) => entry.unstaged && !entry.untracked).length,
      untracked: entries.filter((entry) => entry.untracked).length,
      conflicted: 0,
    },
  }
}

function pathsOf(params: Record<string, unknown>): string[] {
  return Array.isArray(params.paths) ? params.paths.filter((path): path is string => typeof path === "string") : []
}

function diffOf(files: readonly FakeFile[], params: Record<string, unknown>): Record<string, unknown> {
  const scope = typeof params.scope === "string" ? params.scope : "unstaged"
  const paths = pathsOf(params)
  const shown = files.filter((file) => (scope === "head" ? true : scope === "staged" ? file.staged : !file.staged) && (paths.length === 0 || paths.includes(file.path)))
  const statsOnly = params.statsOnly === true
  return {
    scope,
    files: shown.map((file) => ({ path: file.path, change: file.change, additions: file.additions, deletions: file.deletions, ...(statsOnly ? {} : { patch: file.patch }) })),
    totals: { files: shown.length, additions: shown.reduce((sum, file) => sum + file.additions, 0), deletions: shown.reduce((sum, file) => sum + file.deletions, 0) },
  }
}

function newCommitId(): string {
  return Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
}

/**
 * A related folder as an engine started with it sees it: a repository with two
 * changes, or, for a folder named for notes or docs, a plain folder git cannot read.
 */
class FakeFolder {
  readonly git: boolean
  readonly files: FakeFile[]
  readonly saved = new Map<string, string>()
  readonly commits = [{ commit: "e4f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b", shortCommit: "e4f60a1", summary: "Add the routes", authoredAt: Date.now() - 86_400_000 }]

  constructor(readonly path: string) {
    this.git = !/notes|docs/i.test(path.split("/").pop() ?? "")
    this.files = this.git
      ? [
          { path: "src/routes.ts", change: "modified", staged: false, additions: 2, deletions: 1, patch: "@@ -1,4 +1,5 @@\n import { health } from \"./health\"\n-export const routes = [health]\n+// Sessions are read through the new parser.\n+export const routes = [health, sessions]\n export default routes\n" },
          { path: "src/sessions.ts", change: "added", staged: false, additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+import { parseSession } from \"../../project/src/session\"\n+\n+export const sessions = { path: \"/sessions\", parse: parseSession }\n" },
        ]
      : []
  }

  text(path: string): string {
    return this.saved.get(path) ?? `// ${path} in ${this.path.split("/").pop() ?? this.path}\nexport const placeholder = true\n`
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "workspace.list") {
      const entries = this.git
        ? [{ path: "README.md", type: "file", bytes: 640 }, { path: "src", type: "directory" }, ...this.files.map((file) => ({ path: file.path, type: "file", bytes: 300 })), { path: "src/health.ts", type: "file", bytes: 210 }]
        : [{ path: "meeting.md", type: "file", bytes: 1_204 }, { path: "todo.md", type: "file", bytes: 380 }]
      return { path: typeof params.path === "string" ? params.path : "", entries }
    }
    if (method === "workspace.read") {
      const content = this.text(String(params.path))
      return { path: params.path, bytes: new TextEncoder().encode(content).length, content, hash: await sha256(content) }
    }
    if (method === "workspace.write") {
      const path = String(params.path)
      if (params.baseHash !== (await sha256(this.text(path)))) throw new HostError("CONTROL_WORKSPACE_CONFLICT", "the file changed since it was opened", 409)
      const content = String(params.content)
      this.saved.set(path, content)
      return { path, bytes: new TextEncoder().encode(content).length, hash: await sha256(content) }
    }
    if (!this.git) throw new HostError("CONTROL_GIT_UNAVAILABLE", "workspace is not a git work tree", 501)
    const status = (): Record<string, unknown> => ({ branch: "main", detached: false, head: this.commits[0]?.commit, ahead: 0, behind: 0, upstream: "origin/main", ...statusEntries(this.files) })
    const paths = pathsOf(params)
    switch (method) {
      case "git.status":
        return status()
      case "git.diff":
        return diffOf(this.files, params)
      case "git.stage":
      case "git.unstage":
        for (const file of this.files) if (paths.includes(file.path)) file.staged = method === "git.stage"
        return { paths, status: status() }
      case "git.discard":
        for (let index = this.files.length - 1; index >= 0; index -= 1) if (paths.includes(this.files[index]?.path ?? "")) this.files.splice(index, 1)
        return { paths, status: status() }
      case "git.commit": {
        const staged = this.files.filter((file) => file.staged)
        if (staged.length === 0) throw new HostError("CONTROL_GIT_NOTHING_TO_COMMIT", "nothing is staged to commit", 409)
        for (const file of staged) this.files.splice(this.files.indexOf(file), 1)
        const commit = newCommitId()
        const summary = String(params.message ?? "").split("\n")[0] ?? ""
        this.commits.unshift({ commit, shortCommit: commit.slice(0, 7), summary, authoredAt: Date.now() })
        return { commit, shortCommit: commit.slice(0, 7), summary, status: status() }
      }
      case "git.log":
        return { commits: this.commits.slice(0, typeof params.limit === "number" ? params.limit : 20) }
      default:
        throw new HostError("CONTROL_INVALID_INPUT", `the preview's related folders do not answer ${method}`, 400)
    }
  }
}

/** A 1 by 1 PNG, standing in for a window's screenshot. */
const FAKE_SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

/** This Mac as the preview has it: its running apps, what the person allowed, and Runrail's access. */
function fakeComputer(scenario: "no-access" | "allowed" | undefined) {
  const running: readonly RunningComputerApp[] = [
    { bundleId: "com.apple.iCal", name: "Calendar", never: false },
    { bundleId: "com.apple.Notes", name: "Notes", never: false },
    { bundleId: "com.apple.Safari", name: "Safari", never: false },
    { bundleId: "com.apple.Terminal", name: "Terminal", never: true },
  ]
  let access: ComputerAccess = { supported: true, screen: scenario !== "no-access", accessibility: scenario !== "no-access" }
  let allowed: ComputerApp[] = scenario === "allowed" ? [{ bundleId: "com.apple.Notes", name: "Notes" }] : []
  const refuse = (code: string, message: string) => ({ ok: false, code, message })
  return {
    running,
    access: () => access,
    grant: (kind: "screen" | "accessibility") => (access = { ...access, [kind]: true }),
    allowed: (): readonly ComputerApp[] => allowed,
    allow: (bundleId: string): readonly ComputerApp[] => {
      const app = running.find((entry) => entry.bundleId === bundleId)
      if (app === undefined) throw new HostError("COMPUTER_NOT_FOUND", "open the app first, then add it", 404)
      if (app.never) throw new HostError("COMPUTER_APP_REFUSED", "agents may not use this app", 403)
      if (!allowed.some((entry) => entry.bundleId === bundleId)) allowed = [...allowed, { bundleId, name: app.name }]
      return allowed
    },
    disallow: (bundleId: string): readonly ComputerApp[] => (allowed = allowed.filter((entry) => entry.bundleId !== bundleId)),
    act: (action: string, params: Readonly<Record<string, unknown>>): unknown => {
      if (action === "apps") return { ok: true, result: { text: allowed.length === 0 ? "The person has not allowed any apps yet." : `Apps you may use, as the person allowed them:\n${allowed.map((app) => `- ${app.name} (${app.bundleId})`).join("\n")}` } }
      const named = String(params.app ?? "").toLowerCase()
      const app = allowed.find((entry) => entry.bundleId.toLowerCase() === named || entry.name.toLowerCase() === named)
      if (app === undefined) return refuse("COMPUTER_DENIED", `${String(params.app)} is not an app the person allowed. computer_apps lists the ones you may use.`)
      if (!access.screen) return refuse("COMPUTER_PERMISSION", "Runrail needs Screen Recording access to see apps. The person grants it in System Settings, Privacy & Security, then reopens Runrail.")
      if (action !== "screenshot" && !access.accessibility) return refuse("COMPUTER_PERMISSION", "Runrail needs Accessibility access to click and type. The person grants it in System Settings, Privacy & Security.")
      const done = action === "click" ? `Clicked at ${String(params.x)}, ${String(params.y)} in ${app.name}. ` : action === "type" ? `Typed ${String(String(params.text ?? "").length)} characters in ${app.name}. ` : ""
      return { ok: true, result: { text: `${done}${app.name} (${app.bundleId}), window "Notes": 800 by 600 pixels.`, image: { mediaType: "image/png", dataBase64: FAKE_SCREENSHOT } } }
    },
  }
}

/** Apps the preview made from the Nifra starter; their threads show what Nifra adds, as a Nifra project's do. */
const previewNifraApps = new Set<string>()

class FakeEngine {
  private readonly workspace: string
  /** The project's related folders this engine started with, by path. */
  readonly folders = new Map<string, FakeFolder>()
  readonly info: EngineInfo
  seq = -1
  liveSeq = 0
  readonly log: StreamFrame[] = []
  streaming = false
  afterSeq = -1
  afterLiveSeq = 0
  turn = 0
  cancelled = false
  running = false
  /** Tool calls started and not finished in the running turn. */
  openTools = 0
  readonly queue: (() => void)[] = []
  readonly approvals = new Map<string, (approved: boolean) => void>()
  /** Answers sent with a question's approval, read when it resolves. */
  readonly answers = new Map<string, Readonly<Record<string, readonly string[]>>>()
  readonly followUps = new Map<string, { readonly note?: string }>()
  readonly files: FakeFile[] = []
  /** Files the person saved from the file view. */
  readonly saved = new Map<string, string>()
  readonly commits: { commit: string; shortCommit: string; summary: string; authoredAt: number }[] = [
    // A diverged preview has two local commits its upstream does not.
    ...(previewGit === "diverged"
      ? [
          { commit: "c3e5f7a9b1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1", shortCommit: "c3e5f7a", summary: "Retry uploads once", authoredAt: Date.now() - 3_600_000 },
          { commit: "b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0", shortCommit: "b2d4f6a", summary: "Log upload failures", authoredAt: Date.now() - 7_200_000 },
        ]
      : []),
    { commit: "a9d1da2e0c4b7f19d3c2a8e6b5f4d3c2b1a09e8f", shortCommit: "a9d1da2", summary: "Initial import", authoredAt: Date.now() - 86_400_000 * 3 },
  ]
  pushed = 0
  /** Commits on the upstream this checkout has not pulled. */
  behind = previewGit === "behind" || previewGit === "diverged" ? 3 : 0
  published = previewGit !== "unpublished" && previewGit !== "noremote"
  readonly terminals = new Map<string, FakeTerminal>()
  readonly conversation: FakeConversationItem[] = []
  /** The session this thread imported, and whether it has turns left to bring in. */
  imported: { readonly source: string; readonly name: string; readonly inTool: boolean; grew: boolean } | undefined
  readonly worktrees: { id: string; path: string; cwd: string; branch: string; head: string; detached: boolean; locked: boolean; prunable: boolean }[] = []
  model = "claude-opus-5-5"
  thinking = "medium"
  contextUsed = 0
  /** Work a turn left running: a turn that mentions a server starts a dev server and a watcher. */
  readonly background = new Map<string, Record<string, unknown>>()
  behavior: Behavior
  /** Browser use, as the thread's switch started the engine; a turn that mentions the browser uses it. */
  readonly browserTools: boolean
  readonly browserRequests = new Map<string, { readonly action: string; readonly params: Record<string, unknown>; taken: boolean; readonly resolve: (answer: unknown) => void }>()
  /** Messaging other threads; a turn that asks another thread uses it. */
  readonly threadTools: boolean
  /** Computer use; a turn that mentions Notes uses it. */
  readonly computerTools: boolean
  /** Pictures from the chosen image model; a turn that asks to draw makes one. */
  readonly imageTools: boolean
  readonly nifra: { readonly mcp: boolean; readonly pi: boolean; readonly check: boolean }
  readonly computerRequests = new Map<string, { readonly action: string; readonly params: Record<string, unknown>; taken: boolean; readonly resolve: (answer: unknown) => void }>()
  /** A turn that asks to hit the usage limit does, once per engine; the same message later goes through. */
  limited = false
  readonly threadRequests = new Map<string, { readonly action: string; readonly params: Record<string, unknown>; taken: boolean; readonly resolve: (answer: unknown) => void }>()

  constructor(
    input: EngineStartInput,
    private readonly emit: (frames: StreamFrame[]) => void,
    instance: number,
    private readonly tools: ToolSeed = "default",
    /** The MCP servers this engine started with, as the host's list stood then. */
    private readonly mcp: readonly McpServer[] = [],
    history = 0,
    /** An office preview thread's role, which its first turn plays instead of the usual flow. */
    private readonly script?: OfficeScript,
  ) {
    this.behavior = input.behavior ?? { mode: "ask", effort: "medium", permissionDefault: "ask", rules: [] }
    this.browserTools = input.browserTools === true
    this.threadTools = input.threadTools === true
    this.computerTools = input.computerTools === true
    this.imageTools = input.imageTools === true
    this.workspace = input.workspace
    const nifra = input.noNifra !== true && previewNifraApps.has(input.workspace)
    this.nifra = { mcp: nifra && input.backend === "native", pi: nifra && input.backend === "pi", check: false }
    for (const folder of input.folders ?? []) this.folders.set(folder, new FakeFolder(folder))
    for (let turn = 0; this.conversation.length < history; turn += 1) {
      const turnId = `long-${String(turn)}`
      this.record({ kind: "user", turnId, text: `Step ${String(turn + 1)}: tighten the parser and keep the old names working.` })
      this.record({ kind: "tool", turnId, callId: `${turnId}-read`, name: "read_file", presentation: { kind: "read", title: "Read src/parser.ts", path: "src/parser.ts" }, status: "ok", output: "export function parse(input: string) {\n  return input.split(\"\\n\")\n}" })
      this.record({ kind: "tool", turnId, callId: `${turnId}-edit`, name: "edit_file", presentation: { kind: "edit", title: "Edit src/parser.ts", path: "src/parser.ts", edits: [{ oldText: `  return input.split("\\n")`, newText: `  // Step ${String(turn + 1)}\n  return input.split(/\\r?\\n/)` }] }, status: "ok" })
      // Each answer differs, as in a real thread, and every third is long, with code and a table.
      this.record({ kind: "assistant", turnId, text: turn % 3 === 2 ? longAnswer(turn) : `Done with step ${String(turn + 1)}. The parser now **splits** on both line endings, and \`parseLegacy${String(turn)}\` keeps the old names working.\n\n- Added test ${String(turn + 1)} for CRLF input\n- Kept the public signature of \`parse${String(turn)}\`` })
    }
    if (input.model !== undefined) this.model = input.model
    if (input.thinking !== undefined) this.thinking = input.thinking
    this.info = {
      engineId: input.engineId,
      state: "running",
      workspace: input.workspace,
      backend: input.backend,
      sessionId: input.sessionId,
      behavior: this.behavior,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      instance,
      contract: {
        protocol: 1,
        apiVersion: "1.0",
        supportedProtocols: [1],
        runrailVersion: "preview",
        capabilities: [...Object.keys(CAPABILITIES), "browser", "session.compact", "session.usage", "turn.steer.live", "checkpoints", "session.rewind"],
        capabilityStatus: { ...CAPABILITIES, checkpoints: "available", "session.rewind": "available", browser: this.browserTools ? "available" : "configurable", "threads.tools": this.threadTools ? "available" : "configurable", "computer.tools": this.computerTools ? "available" : "configurable", "image.tools": this.imageTools ? "available" : "configurable", "session.compact": COMPACTING_BACKENDS.has(input.backend) ? "available" : "unavailable", "session.usage": "available", "turn.steer.live": STEERING_BACKENDS.has(input.backend) ? "available" : "unavailable" },
      },
    }
    this.event("session.started", { snapshot: this.snapshot("idle") })
  }

  snapshot(status: string, activeTurnId?: string): Record<string, unknown> {
    return { version: 1, id: this.info.sessionId, backend: this.info.backend, cwd: this.info.workspace, status, createdAt: Date.now(), updatedAt: Date.now(), lastSeq: this.seq, ...(activeTurnId === undefined ? {} : { activeTurnId }), capabilities: [] }
  }

  event(type: string, fields: Record<string, unknown>): void {
    if (type === "tool.started") this.openTools += 1
    if (type === "tool.completed") this.openTools = Math.max(0, this.openTools - 1)
    this.seq += 1
    this.push({ kind: "event", data: { version: 1, sessionId: this.info.sessionId, seq: this.seq, at: Date.now(), type, ...fields } })
  }

  live(type: string, fields: Record<string, unknown>): void {
    this.liveSeq += 1
    this.push({ kind: "live", data: { version: 1, sessionId: this.info.sessionId, liveSeq: this.liveSeq, afterSeq: this.seq, at: Date.now(), type, ...fields } })
  }

  push(frame: StreamFrame): void {
    this.log.push(frame)
    if (this.log.length > 20_000) this.log.splice(0, this.log.length - 20_000)
    if (this.streaming) this.emit([frame])
  }

  startStream(afterSeq: number, afterLiveSeq: number): void {
    this.streaming = true
    const backlog = this.log.filter((frame) => {
      const data = frame.data as { seq?: number; liveSeq?: number }
      return frame.kind === "event" ? (data.seq ?? -1) > afterSeq : (data.liveSeq ?? 0) > afterLiveSeq
    })
    if (backlog.length > 0) queueMicrotask(() => this.emit(backlog))
  }

  /** The message a rewind names, by its seq in the history or its turn's id. */
  promptAt(params: Record<string, unknown>): FakeConversationItem {
    const found = this.conversation.find((item) => item.kind === "user" && (typeof params.userSeq === "number" ? item.seq === params.userSeq : item.turnId === params.turnId))
    if (found === undefined) throw new HostError("CONTROL_GIT_NOT_FOUND", "that turn has no checkpoint", 404)
    return found
  }

  record(item: Omit<FakeConversationItem, "id" | "seq" | "at">): void {
    // Each record has its own seq, as in a transcript: a seeded history emits no events between records.
    const previous = this.conversation[this.conversation.length - 1]?.seq ?? -1
    this.conversation.push({ id: String(this.conversation.length + 1), seq: Math.max(this.seq, previous + 1), at: Date.now(), ...item })
  }

  async stream(turnId: string, text: string, pace = 18): Promise<void> {
    for (const part of chunkText(text, 6)) {
      if (this.cancelled) return
      this.event("assistant.delta", { turnId, text: part })
      await delay(pace)
    }
  }

  async tool(turnId: string, callId: string, name: string, presentation: Record<string, unknown>, output: string | undefined, ms: number, ok = true): Promise<void> {
    if (this.cancelled) return
    this.event("tool.started", { turnId, callId, name, presentation })
    const shell = presentation.kind === "shell" || presentation.kind === "verify"
    if (shell && output !== undefined) {
      for (const line of output.split("\n")) {
        if (this.cancelled) return
        this.event("tool.delta", { turnId, callId, text: `${line}\n` })
        await delay(ms / Math.max(1, output.split("\n").length))
      }
    } else await delay(ms)
    if (this.cancelled) return
    this.event("tool.completed", { turnId, callId, name, ok, ...(output === undefined ? {} : { output: shell ? { stdout: output } : output }), ...(ok ? {} : { error: { code: "TOOL_FAILED", message: "command exited with status 1" } }) })
    this.record({ kind: "tool", turnId, callId, name, presentation, status: ok ? "ok" : "failed", ...(shell && output !== undefined ? { output } : {}) })
  }

  /** Auto on a coding tool that decides its own calls: Codex's reviewer, Claude Code's auto mode. */
  get reviewed(): boolean {
    return this.behavior.mode === "auto" && this.behavior.permissionDefault === "ask" && (this.info.backend === "codex" || this.info.backend === "claude-code")
  }

  /** Claude Code runs auto mode it cannot use on Haiku as its default mode, and asks. */
  get autoFellBack(): boolean {
    return this.reviewed && this.info.backend === "claude-code" && this.model.includes("haiku")
  }

  /** The tool's own decision on a call, as the engine reports it. Claude Code's auto mode reports only what it denies. */
  async review(turnId: string, callId: string, command: string, allowed: boolean, rationale: string): Promise<void> {
    const codex = this.info.backend === "codex"
    if (this.cancelled || (!codex && allowed)) return
    const base = { turnId, reviewId: codex ? `codex-${callId}` : `claude-denied-${callId}`, reviewer: codex ? "codex" : "claude-code", action: "command", capability: "process.exec", detail: command } as const
    if (codex) {
      this.live("approval.reviewed", { ...base, decision: "reviewing" })
      await delay(700)
      if (this.cancelled) return
    }
    const decision: "approved" | "denied" = allowed ? "approved" : "denied"
    const decided = { ...base, decision, ...(codex ? { risk: allowed ? ("low" as const) : ("high" as const) } : { source: "reviewer" as const }), rationale }
    this.live("approval.reviewed", decided)
    this.record({ kind: "review", ...decided })
  }

  async approval(turnId: string, action: string, capability: string, reason = "Running commands needs your approval in Ask mode."): Promise<boolean> {
    if (this.reviewed && !this.autoFellBack) {
      await this.review(turnId, `${turnId}-c7`, action, true, "Runs the project's own tests inside the workspace.")
      return true
    }
    if (this.behavior.mode === "auto" && !this.autoFellBack) return true
    const approvalId = `ap-${String(this.turn)}-${String(this.seq)}`
    const decision = new Promise<boolean>((resolve) => this.approvals.set(approvalId, resolve))
    this.event("approval.required", { turnId, approvalId, action, capability, reason })
    const approved = await decision
    this.event("approval.resolved", { turnId, approvalId, approved })
    return approved
  }

  /**
   * Claude Code asks the person, as the engine shows AskUserQuestion: a question approval answered with `answers`.
   * The set holds every kind the form takes: choices with previews, a multi-select, free text, a number,
   * a Codex-style choice, and a secret. "Ask me more" gets a second, shorter round.
   */
  async question(turnId: string, round = 1): Promise<{ readonly answers?: Readonly<Record<string, readonly string[]>>; readonly followUp?: { readonly note?: string } }> {
    const callId = `${turnId}-q${String(round)}`
    const questions = round > 1 ? FOLLOW_UP_QUESTIONS : [
      {
        id: "q1",
        header: "Library",
        question: "Which date library should the parser use?",
        description: "The parser reads due dates from issue text.",
        options: [
          { label: "date-fns (Recommended)", recommended: true, description: "Small, tree-shakes well", preview: '```ts\nimport { format, parseISO } from "date-fns"\n\nconst due = parseISO(input)\nformat(due, "yyyy-MM-dd")\n```' },
          { label: "Luxon", description: "Time zones built in", preview: '```ts\nimport { DateTime } from "luxon"\n\nconst due = DateTime.fromISO(input, { zone: "Europe/Berlin" })\ndue.toFormat("yyyy-LL-dd")\n```' },
          { label: "Temporal polyfill", description: "The coming standard", preview: "Bundle size, gzipped:\n\n  date-fns   |##         |  6 kB\n  Luxon      |#####      | 23 kB\n  Temporal   |########## | 52 kB" },
        ],
        other: true,
      },
      { id: "q2", header: "Checks", question: "Which checks should run after the change?", options: [{ label: "Unit tests" }, { label: "Type check" }, { label: "Lint" }], multiSelect: true, other: true },
      { id: "q3", header: "Commit", question: "What should the commit message say?", kind: "text", options: [], placeholder: "e.g. Parse due dates with date-fns" },
      { id: "q4", header: "Deck", question: "How many slides should the summary deck have?", description: "One slide per main change works well.", kind: "number", options: [], min: 1, max: 20, step: 1, defaultValue: 5, unit: "slides" },
      {
        id: "q5",
        header: "Approach",
        question: "Should the old parse function stay as a wrapper?",
        options: [
          { label: "Keep a wrapper (Recommended)", recommended: true, description: "Callers keep working while they move over" },
          { label: "Remove it", description: "Update every caller in this change" },
        ],
        other: true,
      },
      { id: "q6", header: "Token", question: "Paste the staging API token", options: [], other: true, secret: true },
    ]
    this.event("tool.started", { turnId, callId, name: "AskUserQuestion", presentation: { kind: "other", title: `Ask: ${questions[0]?.question ?? ""}` } })
    const approvalId = `ap-${String(this.turn)}-${String(this.seq)}`
    const decision = new Promise<boolean>((resolve) => this.approvals.set(approvalId, resolve))
    this.event("approval.required", { turnId, approvalId, action: "question", capability: "user.input", reason: `${questions[0]?.question ?? ""}${questions.length > 1 ? ` (and ${String(questions.length - 1)} more)` : ""}`, questions, takesFollowUp: true })
    const approved = await decision
    const followUp = approved ? this.followUps.get(approvalId) : undefined
    const answers = approved ? (this.answers.get(approvalId) ?? (followUp === undefined ? undefined : {})) : undefined
    this.answers.delete(approvalId)
    this.followUps.delete(approvalId)
    // A secret answer reaches the tool but is never shown again, so it is not sent back.
    const shown = answers === undefined ? undefined : Object.fromEntries(Object.entries(answers).filter(([id]) => id !== "q6"))
    const more = followUp === undefined ? {} : { followUp: true, ...(followUp.note === undefined ? {} : { note: followUp.note }) }
    this.event("approval.resolved", { turnId, approvalId, approved, ...(shown === undefined ? {} : { answers: shown }), ...more })
    this.event("tool.completed", { turnId, callId, name: "AskUserQuestion", ok: answers !== undefined, ...(answers === undefined ? { error: { code: "TOOL_FAILED", message: "The user chose not to answer." } } : {}) })
    return { ...(answers === undefined ? {} : { answers }), ...(followUp === undefined ? {} : { followUp }) }
  }

  /**
   * An MCP server's form, as the engine shows an elicitation: one question per field under the
   * server's message. A request it cannot show (a web page to open) is declined at once, with why.
   */
  async elicitation(turnId: string): Promise<Readonly<Record<string, readonly string[]>> | undefined> {
    const declinedId = `ap-${String(this.turn)}-${String(this.seq)}-url`
    this.event("approval.required", { turnId, approvalId: declinedId, action: "Sign in to deploys", capability: "user.input", reason: "deploys: Sign in to deploys" })
    this.event("approval.resolved", { turnId, approvalId: declinedId, approved: false, reason: "It asks you to open a web page, which Runrail cannot show yet" })
    const questions = [
      { id: "q1", header: "deploys", question: "Target", options: [{ label: "Staging" }, { label: "Production" }] },
      { id: "q2", header: "deploys", question: "Release notes: One line", options: [], other: true },
      { id: "q3", header: "deploys", question: "Notify the team", options: [{ label: "Yes" }, { label: "No" }] },
    ]
    const approvalId = `ap-${String(this.turn)}-${String(this.seq)}`
    const decision = new Promise<boolean>((resolve) => this.approvals.set(approvalId, resolve))
    this.event("approval.required", { turnId, approvalId, action: "question", capability: "user.input", reason: "deploys: Where should the release go?", questions })
    const approved = await decision
    const answers = approved ? this.answers.get(approvalId) : undefined
    this.answers.delete(approvalId)
    this.event("approval.resolved", { turnId, approvalId, approved, ...(answers === undefined ? {} : { answers }) })
    return answers
  }

  resolveApproval(approvalId: string, approved: boolean, answers?: unknown, followUp?: { readonly note?: string }): Record<string, unknown> {
    const resolve = this.approvals.get(approvalId)
    if (resolve === undefined) throw new HostError("CONTROL_APPROVAL_NOT_FOUND", "approval is not pending", 404)
    if (answers !== undefined && (typeof answers !== "object" || answers === null || Array.isArray(answers))) throw new HostError("CONTROL_INVALID_INPUT", "answers are invalid", 400)
    if (answers !== undefined) this.answers.set(approvalId, answers as Readonly<Record<string, readonly string[]>>)
    if (followUp !== undefined && approved) this.followUps.set(approvalId, followUp)
    this.approvals.delete(approvalId)
    resolve(approved)
    return this.snapshot("running")
  }

  async enqueue(message: unknown, steer: boolean, liveOnly = false): Promise<unknown> {
    const text = typeof message === "string" ? message : typeof message === "object" && message !== null ? String((message as { text?: unknown }).text ?? "") : ""
    if (text.trim().length === 0) throw new HostError("CONTROL_INVALID_INPUT", "message is required", 400)
    const attached = typeof message === "object" && message !== null && Array.isArray((message as { attachments?: unknown }).attachments)
    const takes = STEERING_BACKENDS.has(this.info.backend) && (this.info.backend !== "claude-code" || this.openTools > 0)
    if (steer && this.running && takes && !attached) {
      this.event("assistant.delta", { turnId: `t${String(this.turn)}`, text: "\n\n*Adjusting course based on your note.*\n\n" })
      return { ...(liveOnly ? { steered: true } : {}), events: [], live: [] }
    }
    if (liveOnly) return { steered: false, events: [], live: [] }
    if (this.running) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.running = true
    this.cancelled = false
    try {
      await (this.turn === 0 && this.script !== undefined ? this.runScript(text, this.script) : this.runTurn(text))
    } finally {
      this.running = false
      this.queue.shift()?.()
    }
    return { events: [], live: [] }
  }

  cancel(): void {
    if (!this.running) return
    this.cancelled = true
    for (const [id, resolve] of this.approvals) {
      this.approvals.delete(id)
      resolve(false)
    }
  }

  /** One browser tool call: announced by id only, claimed and answered by the desktop. */
  async browserCall(turnId: string, callId: string, name: string, action: string, params: Record<string, unknown>, title: string): Promise<string> {
    const requestId = `br-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    const answered = new Promise<unknown>((resolve) => this.browserRequests.set(requestId, { action, params, taken: false, resolve }))
    const presentation = { kind: "web", title }
    this.event("tool.started", { turnId, callId, name, presentation })
    this.live("browser.request", { requestId, action })
    const answer = (await Promise.race([answered, delay(30_000).then(() => ({ ok: false, code: "BROWSER_TIMEOUT", message: "the browser did not answer in time" }))])) as { ok?: boolean; code?: string; message?: string; result?: { text?: string } }
    this.browserRequests.delete(requestId)
    const ok = answer.ok === true
    const text = ok ? String(answer.result?.text ?? "") : String(answer.message ?? "the browser could not do that")
    this.event("tool.completed", { turnId, callId, name, ok, output: text.slice(0, 4_000), ...(ok ? {} : { error: { code: answer.code ?? "BROWSER_FAILED", message: text } }) })
    this.record({ kind: "tool", turnId, callId, name, presentation, status: ok ? "ok" : "failed" })
    return text
  }

  /** One thread tool call, announced and answered the way a browser call is. */
  async threadsCall(turnId: string, callId: string, name: string, action: string, params: Record<string, unknown>, title: string): Promise<{ readonly ok: boolean; readonly text: string }> {
    const requestId = `tr-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    const answered = new Promise<unknown>((resolve) => this.threadRequests.set(requestId, { action, params, taken: false, resolve }))
    const presentation = { kind: "other", title }
    this.event("tool.started", { turnId, callId, name, presentation })
    this.live("threads.request", { requestId, action })
    const limit = params.wait === true ? 15 * 60_000 : 30_000
    const answer = (await Promise.race([answered, delay(limit).then(() => ({ ok: false, code: "THREADS_TIMEOUT", message: "the desktop did not answer in time" }))])) as { ok?: boolean; code?: string; message?: string; result?: { text?: string } }
    this.threadRequests.delete(requestId)
    const ok = answer.ok === true
    const text = ok ? String(answer.result?.text ?? "") : String(answer.message ?? "the other thread could not be reached")
    this.event("tool.completed", { turnId, callId, name, ok, output: text.slice(0, 4_000), ...(ok ? {} : { error: { code: answer.code ?? "THREADS_FAILED", message: text } }) })
    this.record({ kind: "tool", turnId, callId, name, presentation, status: ok ? "ok" : "failed" })
    return { ok, text }
  }

  /** One computer tool call, announced and answered the way a browser call is. */
  async computerCall(turnId: string, callId: string, name: string, action: string, params: Record<string, unknown>, title: string): Promise<{ readonly ok: boolean; readonly text: string }> {
    const requestId = `cu-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    const answered = new Promise<unknown>((resolve) => this.computerRequests.set(requestId, { action, params, taken: false, resolve }))
    const presentation = { kind: "other", title }
    this.event("tool.started", { turnId, callId, name, presentation })
    this.live("computer.request", { requestId, action })
    const answer = (await Promise.race([answered, delay(30_000).then(() => ({ ok: false, code: "COMPUTER_TIMEOUT", message: "the desktop did not answer in time" }))])) as { ok?: boolean; code?: string; message?: string; result?: { text?: string } }
    this.computerRequests.delete(requestId)
    const ok = answer.ok === true
    const text = ok ? String(answer.result?.text ?? "") : String(answer.message ?? "the computer could not do that")
    this.event("tool.completed", { turnId, callId, name, ok, output: text.slice(0, 4_000), ...(ok ? {} : { error: { code: answer.code ?? "COMPUTER_FAILED", message: text } }) })
    this.record({ kind: "tool", turnId, callId, name, presentation, status: ok ? "ok" : "failed" })
    return { ok, text }
  }

  setBackground(entry: Record<string, unknown> & { readonly id: string }): void {
    const merged = { ...this.background.get(entry.id), ...entry }
    this.background.set(entry.id, merged)
    this.live("background.state", { entry: merged })
  }

  async runTurn(prompt: string): Promise<void> {
    this.turn += 1
    const turnId = `t${String(this.turn)}`
    const lower = prompt.toLowerCase()
    this.event("turn.started", { turnId, prompt })
    this.record({ kind: "user", turnId, text: prompt })
    this.event("session.updated", { snapshot: this.snapshot("running", turnId) })
    if (this.autoFellBack && this.turn === 1) {
      this.live("reviewer.notice", { turnId, reviewer: "claude-code", notice: "unavailable" })
      this.record({ kind: "notice", turnId, level: "info", code: "reviewer.unavailable", name: "claude-code" })
    }
    if (lower.includes("server")) {
      const at = Date.now()
      this.setBackground({ id: `fake:cmd-${String(this.turn)}`, kind: "command", status: "running", label: "bun run dev --port 5173", foreground: false, startedAt: at, stoppable: true, hasOutput: true })
      this.setBackground({ id: `fake:agent-${String(this.turn)}`, kind: "agent", status: "running", label: "Watch the test suite and report failures", agentType: "tester", detail: "Running bun test --watch", startedAt: at, tokens: 4_200, toolUses: 3, stoppable: true, hasOutput: false })
    }

    const reasoning = "The user wants the parser to survive blank lines and report which line fails. I should read the parser and its tests first, then make a minimal edit, and verify with the test suite."
    for (const part of chunkText(reasoning, 10)) {
      if (this.cancelled) break
      this.live("reasoning.delta", { turnId, itemId: "r1", text: part })
      await delay(14)
    }
    this.live("reasoning.completed", { turnId, itemId: "r1" })

    if (lower.includes("browser") && this.browserTools) {
      const opened = await this.browserCall(turnId, `${turnId}-b1`, "browser_open", "open", { url: "http://localhost:5173/" }, "Open localhost:5173")
      await this.browserCall(turnId, `${turnId}-b2`, "browser_snapshot", "snapshot", {}, "Read the page")
      const answer = `I opened the app in the browser preview and read the page. ${opened}`
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }

    // A scripted usage limit that resets in 20 seconds; nothing came back first.
    if (lower.includes("hit the usage limit") && !this.limited) {
      this.limited = true
      const message = `Claude Code five-hour usage limit reached. Resets at ${new Date(Date.now() + 20_000).toISOString()}.`
      this.event("session.failed", { error: { code: "COMMAND_AGENT_RATE_LIMITED", message } })
      this.record({ kind: "notice", turnId, level: "error", code: "COMMAND_AGENT_RATE_LIMITED", message })
      return
    }

    // A turn that mentions Notes, in a thread with computer use, writes the note there.
    if (this.computerTools && /\bnotes\b/i.test(prompt)) {
      const steps: [string, string, Record<string, unknown>, string][] = [
        ["computer_apps", "apps", {}, "List the apps you allowed"],
        ["computer_screenshot", "screenshot", { app: "Notes" }, "Look at Notes"],
        ["computer_click", "click", { app: "Notes", x: 240, y: 120 }, "Click in Notes"],
        ["computer_type", "type", { app: "Notes", text: "Groceries: oat milk, coffee" }, "Type in Notes"],
      ]
      let failed: string | undefined
      for (const [index, [name, action, params, title]] of steps.entries()) {
        const result = await this.computerCall(turnId, `${turnId}-c${String(index)}`, name, action, params, title)
        if (!result.ok) {
          failed = result.text
          break
        }
      }
      const answer = failed === undefined ? "Added the note in Notes: \"Groceries: oat milk, coffee\"." : `I could not use Notes: ${failed}`
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    // A turn that asks for a picture, in a thread with the image tool, makes one with the chosen model.
    if (this.imageTools && /\b(?:draw|picture|illustration)\b/i.test(prompt)) {
      const callId = `${turnId}-img`
      const presentation = { kind: "other", title: "Make a picture: public/hero.png", path: "public/hero.png" }
      this.event("tool.started", { turnId, callId, name: "image_generate", presentation })
      await delay(900)
      const output = "Saved a 1536x1024 PNG to public/hero.png, made by gpt-image-1 through OpenAI."
      this.event("tool.completed", { turnId, callId, name: "image_generate", ok: true, output })
      this.record({ kind: "tool", turnId, callId, name: "image_generate", presentation, status: "ok", output })
      const answer = "Made the hero picture and saved it to `public/hero.png` (1536 by 1024)."
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    // "Ask the <thread> thread to <do something>": the agent hands work to another thread and waits for it.
    const asked = /^ask (?:the )?"?(.+?)"? thread to (.+)$/is.exec(prompt.trim())
    if (asked !== null && this.threadTools) {
      await this.threadsCall(turnId, `${turnId}-m1`, "list_threads", "list", {}, "List the other threads")
      const reply = await this.threadsCall(turnId, `${turnId}-m2`, "send_to_thread", "send", { thread: asked[1], message: asked[2], wait: true }, `Message ${String(asked[1])}`)
      const answer = reply.ok ? `I asked "${String(asked[1])}", and it answered:\n\n${reply.text}` : `I could not reach "${String(asked[1])}": ${reply.text}`
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    // The failing checks' logs from the PR chip: the preview's test is fixed, and pushed when asked to.
    if (prompt.includes("\n\n[Runrail CI logs for pull request #")) {
      await delay(500)
      const push = prompt.includes("commit and push the fix")
      if (push) ciPushedAt = Date.now() + 600
      const answer = `\`test (ubuntu)\` failed in \`matches across word boundaries\`: the scorer stopped at the first space. Fixed it in \`src/palette/score.ts\` and ran \`bun test\`: 48 pass.${push ? " Committed and pushed to feat/search." : " Not pushed."}`
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    // "Review my changes": findings on the sample patch's lines, and one on the change as a whole.
    if (prompt.startsWith("Review the changes in this checkout that are not committed yet.")) {
      await delay(700)
      const findings = {
        summary: "parseSession now skips blank lines and names the bad line. One parsed value is trusted without a check.",
        findings: [
          { severity: "medium", path: "src/session.ts", line: 17, title: "A parsed line is trusted as an Entry", body: "JSON.parse returns whatever the file holds; the cast lets a line without the Entry fields through. Check the shape before pushing it." },
          { severity: "low", path: "src/session.ts", line: 19, title: "The JSON error itself is dropped", body: "Keep the parser's message as the cause, so a bad escape is easy to find." },
          { severity: "low", title: "No test for a line that is JSON but not an Entry" },
        ],
      }
      const answer = `I read src/session.ts and the new test.\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\``
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    // A message another thread's agent sent: answered briefly, so the thread that waits hears back.
    if (prompt.includes("\n\n[Runrail message from the agent in the thread ")) {
      await delay(600)
      const answer = lower.includes("test") ? "Ran `bun test`: 48 pass, 0 fail across 12 files." : "Done. Nothing else needed changing."
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }

    if (lower.startsWith("plan this task")) {
      const plan = { summary: "Read the parser, change it, then cover it with tests.", steps: [{ title: "Make parseSession skip blank lines", detail: "Replace the map with a loop that skips empty lines." }, { title: "Report the failing line number", detail: "Throw SESSION_INVALID with the 1-based line." }, { title: "Add regression tests" }] }
      const answer = `I read src/session.ts and its tests.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    if (lower.startsWith("do step")) {
      const answer = "Done. The change is in place and the existing tests still pass."
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    if (lower.includes("propose one workflow that does it")) {
      const workflow = {
        id: "fix-parser-weekly",
        name: "Check the session parser weekly",
        trigger: { kind: "schedule", schedule: { kind: "weekly", day: 1, hour: 9, minute: 0 } },
        steps: [
          { id: "check-parser", kind: "agent", title: "Look for parser regressions", prompt: "Run the session parser tests and read any new JSONL fixtures for lines it would drop." },
          { id: "tests", kind: "check", title: "Run the tests", command: "bun test test/session.test.ts", repeat: 1, retry: { step: "check-parser", times: 1 } },
          { id: "say", kind: "action", title: "Tell me", action: "notify", text: "The session parser still reads every line" },
        ],
      }
      const answer = `This is worth checking every week.\n\n\`\`\`json\n${JSON.stringify({ workflow }, null, 2)}\n\`\`\``
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    if (lower.startsWith("read this conversation from a coding thread")) {
      const memories = [
        { text: "Blank lines in a session file are skipped by parseSession, not treated as the end.", scope: "project" },
        { text: "Run bun test test/session.test.ts after changing the parser.", scope: "project" },
        { text: "Prefers the smallest change that fixes a bug.", scope: "person" },
      ]
      const answer = `Three facts look worth keeping.\n\n\`\`\`json\n${JSON.stringify({ memories }, null, 2)}\n\`\`\``
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    if (lower.startsWith("review the changes in this worktree")) {
      const answer = `The change does what the task asks.\n\n\`\`\`json\n${JSON.stringify({ summary: "Looks right.", findings: [] })}\n\`\`\``
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }
    if (lower.startsWith("review pull request #") || lower.startsWith("end your answer with the findings block")) {
      const findings = {
        summary: "Adds a per-person summary to the shift report. The totals are right; two edges are not handled.",
        findings: [
          { severity: "high", path: "src/report/ShiftReport.tsx", line: 3, title: "A person with no finished work crashes the report", body: "`line2` is read before the empty case is checked. Return early when the list is empty." },
          { severity: "medium", path: "src/report/summary.ts", line: 40, title: "Totals round per person, then add up", body: "Sum first, then round once, or the footer drifts from the rows." },
          { severity: "low", title: "No test for a shift that crosses midnight" },
        ],
      }
      const answer = `I read the change against main.\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\``
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }

    if (lower.includes("propose a plan")) {
      await this.stream(turnId, "I've looked around; here is what I'd do.")
      const callId = `${turnId}-plan`
      const plan = "## Move the parser to Luxon\n\n1. Replace `parseDate` in `src/parse.ts` with Luxon's `DateTime.fromISO`\n2. Keep the old signature so callers do not change\n3. Add tests for time zones and invalid input\n\nNo migration is needed."
      this.event("tool.started", { turnId, callId, name: "ExitPlanMode", presentation: { kind: "plan", title: "Proposed plan", content: plan } })
      const approved = await this.approval(turnId, "plan", "tool.use", "Leave plan mode and start making changes")
      this.event("tool.completed", { turnId, callId, name: "ExitPlanMode", ok: approved })
      const answer = approved ? "Starting on the plan." : "Staying in plan mode."
      await this.stream(turnId, `\n\n${answer}`)
      this.finish(turnId, answer)
      return
    }

    if (lower.includes("ask me")) {
      await this.stream(turnId, "Before I change the parser, a few quick questions.")
      const first = await this.question(turnId)
      let answers = first.answers
      if (first.followUp !== undefined) {
        await this.stream(turnId, `\n\nSure, a few more${first.followUp.note === undefined ? "" : ` (you asked: ${first.followUp.note})`}.`)
        const second = await this.question(turnId, 2)
        answers = second.answers === undefined ? undefined : { ...answers, ...second.answers }
      }
      const library = answers?.q1?.join(", ").replace(/\s*\(recommended\)$/i, "") ?? "the current library"
      const answer = answers === undefined ? "No answer, so I'll keep the current library and run the unit tests." : `Going with ${library}, then running ${answers.q2?.join(", ") ?? "the unit tests"}. The deck gets ${answers.q4?.[0] ?? "5"} slides.${answers.q7 === undefined ? "" : ` Dates default to ${answers.q7.join(", ").replace(/\s*\(recommended\)$/i, "")}.`}`
      await this.stream(turnId, `\n\n${answer}`)
      this.finish(turnId, answer)
      return
    }

    if (lower.includes("mcp form")) {
      await this.stream(turnId, "The deploys server needs a few details before it ships.")
      const answers = await this.elicitation(turnId)
      const answer = answers === undefined ? "No details, so nothing was shipped." : `Shipping to ${answers.q1?.join(", ") ?? "staging"}.`
      await this.stream(turnId, `\n\n${answer}`)
      this.finish(turnId, answer)
      return
    }

    if (lower.includes("retry")) {
      // Claude Code's own retries: the engine records only the latest of one request's.
      for (const [attempt, delayMs] of [[1, 600], [2, 1_200], [3, 2_400]] as const) {
        this.live("api.retry", { turnId, source: "claude-code", attempt, maxRetries: 10, delayMs, status: 529, error: "overloaded" })
        await delay(delayMs)
        if (this.cancelled) return
      }
      this.record({ kind: "notice", turnId, level: "info", code: "api.retry", name: "claude-code", retry: { attempt: 3, maxRetries: 10, delayMs: 2_400, status: 529, error: "overloaded" } })
      const answer = "Got through on the fourth try."
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }

    if (lower.includes("refuse")) {
      const message = "Runrail refused a Codex request to run a command: it came from a Codex thread that is not this session's or one of its sub-agents."
      this.live("request.refused", { turnId, source: "codex", message })
      this.record({ kind: "notice", turnId, level: "info", code: "request.refused", name: "codex", message })
      const answer = "The command was not run: approval request failed."
      await this.stream(turnId, answer)
      this.finish(turnId, answer)
      return
    }

    if (lower.includes("hello") || lower.includes("hi ") || prompt.length < 12) {
      await this.stream(turnId, "Hi! I'm ready. Point me at a task - for example *\"add tests for the session parser\"* - and I'll explore, edit, and verify it here. Changes show up in **Review** as they happen.")
      this.finish(turnId, "Hi! I'm ready.")
      return
    }

    await this.stream(turnId, "I'll start by looking at how sessions are parsed and what's already covered by tests.")
    this.event("assistant.message", { turnId, text: "" })
    this.record({ kind: "assistant", turnId, text: "I'll start by looking at how sessions are parsed and what's already covered by tests." })

    await this.tool(turnId, `${turnId}-c1`, "search_files", { kind: "search", title: "parseSession", query: "parseSession" }, "src/session.ts:12\nsrc/cli.ts:88\ntest/session.test.ts:4", 260)
    await this.tool(turnId, `${turnId}-c2`, "read_file", { kind: "read", title: "src/session.ts", path: "src/session.ts" }, undefined, 180)
    await this.tool(turnId, `${turnId}-c3`, "read_file", { kind: "read", title: "test/session.test.ts", path: "test/session.test.ts" }, undefined, 160)
    await this.tool(turnId, `${turnId}-c4`, "list_files", { kind: "list", title: "src", path: "src" }, undefined, 120)

    const steps = [
      { text: "Make parseSession skip blank lines", status: "in_progress" },
      { text: "Report the failing line number", status: "pending" },
      { text: "Add regression tests", status: "pending" },
      { text: "Run the test suite", status: "pending" },
    ]
    this.live("plan.updated", { turnId, explanation: "Small, verifiable change.", steps })

    this.live("agent.spawned", { turnId, callId: `${turnId}-a1`, title: "Check other JSONL readers for the same bug", agentType: "explore" })
    await delay(300)
    this.live("agent.spawned", { turnId, callId: `${turnId}-a2`, parentCallId: `${turnId}-a1`, title: "Scan src/transcript", agentType: "explore" })
    await delay(400)
    this.live("agent.completed", { turnId, callId: `${turnId}-a2`, ok: true })
    this.live("agent.completed", { turnId, callId: `${turnId}-a1`, ok: true })

    if (this.behavior.mode === "plan") {
      await this.stream(
        turnId,
        "\n\nHere's the plan - I'm in **Plan** mode, so I won't edit files:\n\n1. Replace the `map(JSON.parse)` in `src/session.ts` with a loop that skips blank lines.\n2. Wrap each parse in `try/catch` and throw `SESSION_INVALID` with the 1-based line number.\n3. Add two tests to `test/session.test.ts`.\n4. Run `bun test`.\n\nLeave **Plan** to apply it.",
      )
      this.finish(turnId, "plan")
      return
    }

    await this.tool(
      turnId,
      `${turnId}-c5`,
      "edit_file",
      {
        kind: "edit",
        title: "src/session.ts",
        path: "src/session.ts",
        edits: [{ oldText: "  const entries = lines.map((line) => JSON.parse(line))\n  return { entries }", newText: "  const entries: Entry[] = []\n  for (const [index, line] of lines.entries()) {\n    if (line.trim().length === 0) continue\n    try {\n      entries.push(JSON.parse(line) as Entry)\n    } catch {\n      throw new SessionError(\"SESSION_INVALID\", `line ${index + 1} is not JSON`)\n    }\n  }\n  return { entries }" }],
      },
      undefined,
      420,
    )
    this.upsertFile({ path: "src/session.ts", change: "modified", staged: false, additions: 10, deletions: 2, patch: SAMPLE_PATCH })
    steps[0] = { text: steps[0]?.text ?? "", status: "completed" }
    steps[1] = { text: steps[1]?.text ?? "", status: "completed" }
    steps[2] = { text: steps[2]?.text ?? "", status: "in_progress" }
    this.live("plan.updated", { turnId, explanation: "Small, verifiable change.", steps })

    await this.tool(turnId, `${turnId}-c6`, "write_file", { kind: "write", title: "test/session-lines.test.ts", path: "test/session-lines.test.ts", content: TEST_PATCH.split("\n").slice(1).map((line) => line.slice(1)).join("\n") }, undefined, 320)
    this.upsertFile({ path: "test/session-lines.test.ts", change: "added", staged: false, additions: 10, deletions: 0, patch: TEST_PATCH })
    steps[2] = { text: steps[2]?.text ?? "", status: "completed" }
    steps[3] = { text: steps[3]?.text ?? "", status: "in_progress" }
    this.live("plan.updated", { turnId, steps })

    if (this.reviewed && !this.autoFellBack) {
      // The model reaches for a push the task never asked for, and the tool's own reviewer stops it.
      const callId = `${turnId}-c6p`
      const presentation = { kind: "shell", title: "git push origin main", command: "git push origin main" }
      this.event("tool.started", { turnId, callId, name: "run_command", presentation })
      await this.review(turnId, callId, "git push origin main", false, this.info.backend === "codex" ? "Pushes to the shared remote, which the task did not ask for." : "Pushing to the remote was not part of the task.")
      if (this.cancelled) return this.stop(turnId)
      this.event("tool.completed", { turnId, callId, name: "run_command", ok: false, error: { code: "REVIEW_DENIED", message: this.info.backend === "codex" ? "Codex's reviewer denied this call" : "Claude Code denied this call without asking" } })
      this.record({ kind: "tool", turnId, callId, name: "run_command", presentation, status: "failed", errorCode: "REVIEW_DENIED" })
    }
    const approved = await this.approval(turnId, "bun test test/session-lines.test.ts", "shell")
    if (this.cancelled) return this.stop(turnId)
    if (!approved) {
      await this.stream(turnId, "\n\nOkay - I won't run the tests. The edit is in place; you can run `bun test` yourself or approve next time.")
      this.finish(turnId, "declined")
      return
    }
    await this.tool(
      turnId,
      `${turnId}-c7`,
      "run_command",
      { kind: "shell", title: "bun test test/session-lines.test.ts", command: "bun test test/session-lines.test.ts", intent: "test" },
      "bun test v1.4.0\n\ntest/session-lines.test.ts:\n✓ skips blank lines [0.41ms]\n✓ reports the failing line [0.22ms]\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [18.00ms]",
      900,
    )
    if (this.cancelled) return this.stop(turnId)
    steps[3] = { text: steps[3]?.text ?? "", status: "completed" }
    this.live("plan.updated", { turnId, steps })
    this.event("verification.completed", { name: "bun test", ok: true })

    const summary = [
      "\n\nDone. `parseSession` in `src/session.ts:14` now skips blank lines and reports the failing line; the cases are in [the new tests](test/session-lines.test.ts):",
      "",
      "```ts",
      "for (const [index, line] of lines.entries()) {",
      "  if (line.trim().length === 0) continue",
      "  try {",
      "    entries.push(JSON.parse(line) as Entry)",
      "  } catch {",
      "    throw new SessionError(\"SESSION_INVALID\", `line ${index + 1} is not JSON`)",
      "  }",
      "}",
      "```",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| New tests | 2 pass |",
      "| Other JSONL readers | `src/transcript` already skips blanks |",
      "",
      "Review the diff and commit when you're happy.",
    ].join("\n")
    await this.stream(turnId, summary, 10)
    this.finish(turnId, summary)
  }

  async runScript(prompt: string, script: OfficeScript): Promise<void> {
    this.turn += 1
    const turnId = `t${String(this.turn)}`
    this.event("turn.started", { turnId, prompt })
    this.record({ kind: "user", turnId, text: prompt })
    this.event("session.updated", { snapshot: this.snapshot("running", turnId) })
    await playOfficeRole(this, turnId, script)
  }

  /** As the engine does it: a coding tool compacts its own conversation and says so in the timeline. */
  private async compact(): Promise<unknown> {
    if (this.info.backend === "native") {
      const removed = this.contextUsed > 0 ? 6 : 0
      return { before: this.contextUsed, after: this.contextUsed, reason: "manual", removed }
    }
    if (this.contextUsed === 0) throw new HostError("SESSION_COMPACT_FAILED", "the conversation has nothing to compact yet", 502)
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    const before = this.contextUsed
    this.contextUsed = Math.round(before * 0.12)
    this.event("memory.compacted", { before, after: this.contextUsed, reason: "manual" })
    this.live("context.usage", { usedTokens: this.contextUsed, windowTokens: 200_000, ...this.autoCompact(), estimated: true })
    return { before, after: this.contextUsed, reason: "manual" }
  }

  private readUsage(): unknown {
    const context = { usedTokens: this.contextUsed, windowTokens: 200_000, ...this.autoCompact(), estimated: true }
    if (this.contextUsed > 0) this.live("context.usage", context)
    if (this.contextUsed > 0) this.planLimits()
    return this.contextUsed > 0 ? { context } : {}
  }

  /** The plan usage a coding tool reports as it works, for the sidebar footer. */
  private planLimits(): void {
    const backend = this.info.backend
    if (backend !== "claude-code" && backend !== "codex") return
    const { type, ...frame } = previewPlan(backend, previewUsage) as { readonly type: string } & Record<string, unknown>
    this.live(type, frame)
  }

  /** Claude Code says where it compacts on its own; Codex does not by default. */
  private autoCompact(): { readonly autoCompactAt?: number } {
    return this.info.backend === "claude-code" ? { autoCompactAt: 167_000 } : {}
  }

  finish(turnId: string, text: string): void {
    this.event("assistant.message", { turnId, text: "" })
    this.record({ kind: "assistant", turnId, text })
    // The context fills as the conversation grows, so the ring has something to show.
    this.contextUsed = Math.min(200_000, this.contextUsed + 38_000 + text.length)
    this.live("context.usage", { turnId, usedTokens: this.contextUsed, windowTokens: 200_000, estimated: false })
    this.planLimits()
    this.event("session.completed", { snapshot: this.snapshot("idle") })
  }

  stop(turnId: string): void {
    void turnId
    this.event("session.stopped", { reason: "cancelled" })
    this.record({ kind: "notice", level: "info", code: "stopped" })
  }

  /** A file's text: what the person saved, else a stand-in that each agent turn changes when the turn touched it. */
  fileText(path: string): string {
    const saved = this.saved.get(path)
    if (saved !== undefined) return saved
    const touched = this.files.some((file) => file.path === path) ? `// Changed by the agent in turn ${String(this.turn)}.\n` : ""
    if (path === "src/session.ts") return `${touched}${FAKE_SESSION_SOURCE}`
    return `// ${path}\n${touched}export function parseSession(input: string): Session {\n  const lines = input.split("\\n")\n  return { entries: [] }\n}\n`
  }

  upsertFile(file: FakeFile): void {
    const index = this.files.findIndex((entry) => entry.path === file.path)
    if (index >= 0) this.files[index] = file
    else this.files.push(file)
  }

  gitStatus(): Record<string, unknown> {
    const own = folderHead(this.workspace)
    const detached = own.detached
    const branch = own.branch ?? "main"
    return {
      ...(detached ? {} : { branch }),
      detached,
      ...(own.initial ? { initial: true } : { head: this.commits[0]?.commit }),
      ahead: this.published ? this.commits.length - 1 - this.pushed : 0,
      behind: this.published ? this.behind : 0,
      ...(this.published && !detached ? { upstream: `origin/${branch}` } : {}),
      ...statusEntries(this.files),
    }
  }

  gitDiff(params: Record<string, unknown>): Record<string, unknown> {
    return diffOf(this.files, params)
  }

  paths(params: Record<string, unknown>): string[] {
    return pathsOf(params)
  }

  terminal(id: string): FakeTerminal {
    const terminal = this.terminals.get(id)
    if (terminal === undefined) throw new HostError("CONTROL_TERMINAL_NOT_FOUND", "terminal session was not found", 404)
    return terminal
  }

  termWrite(terminal: FakeTerminal, data: string): void {
    const out = (text: string): void => {
      terminal.chunks.push({ seq: terminal.nextSeq, data: text })
      terminal.nextSeq += 1
    }
    for (const char of data) {
      if (char === "\r") {
        const command = terminal.line.trim()
        terminal.line = ""
        out("\r\n")
        if (command === "ls") out("README.md  package.json  src  test\r\n")
        else if (command === "git status") out(`On branch main\r\n${this.files.map((file) => `\t${file.change}:   ${file.path}`).join("\r\n")}\r\n`)
        else if (command.startsWith("echo ")) out(`${command.slice(5)}\r\n`)
        else if (command === "clear") out("\x1b[2J\x1b[H")
        else if (command.length > 0) out(`preview: ${command.split(" ")[0] ?? ""}: runs in the desktop app\r\n`)
        out("\x1b[38;5;110m~/project\x1b[0m $ ")
      } else if (char === "\x7f") {
        if (terminal.line.length > 0) {
          terminal.line = terminal.line.slice(0, -1)
          out("\b \b")
        }
      } else if (char >= " ") {
        terminal.line += char
        out(char)
      }
    }
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (params.folder !== undefined && (method.startsWith("git.") || method.startsWith("workspace."))) {
      const folder = typeof params.folder === "string" ? this.folders.get(params.folder) : undefined
      if (folder === undefined) throw new HostError("CONTROL_INVALID_INPUT", "folder is not one of this project's related folders", 400)
      return folder.rpc(method, params)
    }
    switch (method) {
      case "control.describe":
        return this.info.contract
      case "session.conversation.read": {
        if (params.source === "live") return { sessionId: this.info.sessionId, source: "live", items: [], truncated: false, lastSeq: this.seq }
        const max = typeof params.maxItems === "number" ? params.maxItems : 512
        return { sessionId: this.info.sessionId, source: "transcript", items: this.conversation.slice(-max), truncated: this.conversation.length > max, lastSeq: this.seq }
      }
      case "turn.enqueue":
        return this.enqueue(params.recall === true ? await withFakeRecall(params.message) : params.message, false)
      case "session.checkpoint.changes":
        return { checkpoint: { n: 1, at: this.promptAt(params).at }, files: REWIND_FILES }
      case "session.rewind": {
        const prompt = this.promptAt(params)
        const at = this.conversation.indexOf(prompt)
        const removed = this.conversation.length - at
        this.conversation.splice(at)
        this.record({ kind: "notice", level: "info", code: "session.rewound" })
        // The engine starts its session again, so a stream started over replays none of the old events.
        this.log.length = 0
        const files = Array.isArray(params.files) ? params.files.filter((path): path is string => typeof path === "string") : []
        return { removed, restored: files, failed: [] }
      }
      case "turn.steer":
        if (params.liveOnly !== undefined && typeof params.liveOnly !== "boolean") throw new HostError("CONTROL_INVALID_INPUT", "liveOnly is invalid", 400)
        return this.enqueue(params.message, true, params.liveOnly === true)
      case "turn.cancel":
        this.cancel()
        return this.snapshot("stopped")
      case "approval.resolve":
        if (params.scope !== undefined && params.scope !== "once" && params.scope !== "session") throw new HostError("CONTROL_INVALID_INPUT", "approval scope is invalid", 400)
        if ((params.followUp !== undefined && params.followUp !== true) || (params.note !== undefined && (params.followUp !== true || typeof params.note !== "string"))) throw new HostError("CONTROL_INVALID_INPUT", "followUp is invalid", 400)
        return this.resolveApproval(String(params.approvalId), params.approved === true, params.answers, params.followUp === true ? { ...(typeof params.note === "string" ? { note: params.note } : {}) } : undefined)
      case "model.list":
        return []
      case "harness.list":
        return FAKE_TOOLS
      case "harness.status":
        // The real engine runs each tool's own commands, which takes a moment.
        await delay(600)
        return fakeToolStatus(this.tools)
      case "background.list":
        return {
          entries: [...this.background.values()],
          ...(params.servers === true ? { servers: [...this.background.values()].some((entry) => entry.kind === "command" && entry.status === "running") ? [{ port: 5173, host: "127.0.0.1", process: "bun" }] : [], serversAvailable: true } : {}),
          lastLiveSeq: this.liveSeq,
        }
      case "background.output": {
        const entry = this.background.get(String(params.id))
        if (entry === undefined) throw new HostError("BACKGROUND_NOT_FOUND", "no background task has this id", 404)
        return { id: entry.id, text: "\u001b[32m  VITE v7.1.0\u001b[0m  ready in \u001b[1m312\u001b[0m ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n", truncated: false }
      }
      case "browser.take": {
        const request = this.browserRequests.get(String(params.requestId))
        if (!this.browserTools) throw new HostError("CONTROL_CAPABILITY_UNAVAILABLE", "this thread does not let the agent use the browser", 501)
        if (request === undefined || request.taken) throw new HostError("BROWSER_REQUEST_NOT_FOUND", "no open browser request has this id", 404)
        request.taken = true
        return { requestId: params.requestId, action: request.action, params: request.params, expiresAt: Date.now() + 30_000, anySite: false }
      }
      case "threads.take": {
        const request = this.threadRequests.get(String(params.requestId))
        if (!this.threadTools) throw new HostError("CONTROL_CAPABILITY_UNAVAILABLE", "this thread does not let the agent reach other threads", 501)
        if (request === undefined || request.taken) throw new HostError("THREADS_REQUEST_NOT_FOUND", "no open thread request has this id", 404)
        request.taken = true
        return { requestId: params.requestId, action: request.action, params: request.params, expiresAt: Date.now() + 30_000 }
      }
      case "computer.take": {
        const request = this.computerRequests.get(String(params.requestId))
        if (!this.computerTools) throw new HostError("CONTROL_CAPABILITY_UNAVAILABLE", "this thread does not let the agent use the computer", 501)
        if (request === undefined || request.taken) throw new HostError("COMPUTER_REQUEST_NOT_FOUND", "no open computer request has this id", 404)
        request.taken = true
        return { requestId: params.requestId, action: request.action, params: request.params, expiresAt: Date.now() + 30_000 }
      }
      case "computer.respond": {
        const request = this.computerRequests.get(String(params.requestId))
        if (request === undefined || !request.taken) throw new HostError("COMPUTER_REQUEST_NOT_FOUND", "no claimed computer request has this id", 404)
        request.resolve(params.answer)
        return { ok: true }
      }
      case "threads.respond": {
        const request = this.threadRequests.get(String(params.requestId))
        if (request === undefined || !request.taken) throw new HostError("THREADS_REQUEST_NOT_FOUND", "no claimed thread request has this id", 404)
        request.resolve(params.answer)
        return { ok: true }
      }
      case "browser.respond": {
        const request = this.browserRequests.get(String(params.requestId))
        if (request === undefined || !request.taken) throw new HostError("BROWSER_REQUEST_NOT_FOUND", "no claimed browser request has this id", 404)
        request.resolve(params.answer)
        return { ok: true }
      }
      case "background.stop": {
        const entry = this.background.get(String(params.id))
        if (entry === undefined) throw new HostError("BACKGROUND_NOT_FOUND", "no background task has this id", 404)
        if (entry.status === "running") this.setBackground({ id: String(entry.id), status: "stopped", stoppable: false, endedAt: Date.now() })
        return { id: entry.id, status: this.background.get(String(params.id))?.status }
      }
      case "metrics.snapshot":
        return { modelCalls: this.turn * 4, cacheHits: this.turn * 3, cacheMisses: this.turn, runs: this.turn, successfulRuns: this.turn, repairs: 0, inputTokens: this.turn * 18_400, outputTokens: this.turn * 1_320, costUsd: this.turn * 0.071, toolCalls: this.turn * 7, elapsedMs: this.turn * 9_000 }
      case "nifra.status":
        return this.nifra
      case "mcp.status":
        return { servers: this.mcp.map((server) => (server.enabled ? { name: server.name, state: "ready", tools: 3 } : { name: server.name, state: "off", tools: 0 })) }
      case "mcp.check": {
        const server = this.mcp.find((item) => item.name === params.name)
        if (server === undefined) throw new HostError("CONTROL_INVALID_INPUT", "no MCP server has this name", 400)
        await delay(500)
        // A command that names a program the preview cannot find fails the way a missing one would.
        return server.command.includes("missing") ? { name: server.name, state: "failed", tools: 0, code: "MCP_TRANSPORT_FAILED" } : { name: server.name, state: "ready", tools: 3 }
      }
      case "skills.list":
        return [
          { id: "review", name: "review", description: "Review the current diff for bugs", scope: "project", enabled: true },
          { id: "test-writer", name: "test-writer", description: "Write focused regression tests", scope: "user", enabled: true },
          { id: "release-notes", name: "release-notes", description: "Draft release notes from commits", scope: "user", enabled: false },
        ]
      case "skills.setEnabled":
        return { id: params.id, name: params.id, scope: "user", enabled: params.enabled === true }
      case "agent.list":
        return [
          { id: "explore", role: "explorer", description: "Read-only codebase search", capabilities: ["read"] },
          { id: "reviewer", role: "reviewer", description: "Reviews diffs for defects", capabilities: ["read"] },
        ]
      case "workspace.list": {
        const entries = [
          { path: "README.md", type: "file", bytes: 2_310 },
          { path: "package.json", type: "file", bytes: 812 },
          { path: "src", type: "directory" },
          { path: "src/session.ts", type: "file", bytes: 4_120 },
          { path: "src/cli.ts", type: "file", bytes: 9_830 },
          { path: "src/transcript", type: "directory" },
          { path: "src/transcript/index.ts", type: "file", bytes: 6_004 },
          { path: "src/transcript/store.ts", type: "file", bytes: 3_311 },
          { path: "test", type: "directory" },
          { path: "test/session.test.ts", type: "file", bytes: 1_902 },
          ...this.files.filter((file) => file.change === "added").map((file) => ({ path: file.path, type: "file", bytes: 400 })),
        ]
        return { path: typeof params.path === "string" ? params.path : "", entries }
      }
      case "workspace.read": {
        if (params.path === QUEST_FILE) {
          const quests = officeQuestFile(this.info.workspace)
          if (quests === undefined) throw new HostError("CONTROL_WORKSPACE_NOT_FOUND", "workspace path was not found", 404)
          return { path: QUEST_FILE, bytes: quests.length, content: quests }
        }
        const content = this.fileText(String(params.path))
        return { path: params.path, bytes: new TextEncoder().encode(content).length, content, hash: await sha256(content) }
      }
      case "workspace.write": {
        const path = String(params.path)
        if (params.baseHash !== (await sha256(this.fileText(path)))) throw new HostError("CONTROL_WORKSPACE_CONFLICT", "the file changed since it was opened", 409)
        const content = String(params.content)
        this.saved.set(path, content)
        return { path, bytes: new TextEncoder().encode(content).length, hash: await sha256(content) }
      }
      case "git.status":
        return this.gitStatus()
      case "git.diff":
        return this.gitDiff(params)
      case "git.stage":
        for (const file of this.files) if (this.paths(params).includes(file.path)) file.staged = true
        return { paths: this.paths(params), status: this.gitStatus() }
      case "git.unstage":
        for (const file of this.files) if (this.paths(params).includes(file.path)) file.staged = false
        return { paths: this.paths(params), status: this.gitStatus() }
      case "git.discard": {
        const paths = this.paths(params)
        // Mirrors the engine: staged changes need scope "all", new files need includeUntracked.
        for (let index = this.files.length - 1; index >= 0; index -= 1) {
          const file = this.files[index]
          if (file === undefined || !paths.includes(file.path)) continue
          const untracked = !file.staged && file.change === "added"
          if (untracked ? params.includeUntracked !== true : file.staged && params.scope !== "all") continue
          this.files.splice(index, 1)
        }
        return { paths, status: this.gitStatus() }
      }
      case "git.commit": {
        const message = String(params.message ?? "").trim()
        if (message.length === 0) throw new HostError("CONTROL_INVALID_INPUT", "commit message is required", 400)
        const staged = this.files.filter((file) => file.staged)
        if (staged.length === 0) throw new HostError("CONTROL_GIT_NOTHING_TO_COMMIT", "nothing is staged to commit", 409)
        for (const file of staged) this.files.splice(this.files.indexOf(file), 1)
        const commit = newCommitId()
        const summary = message.split("\n")[0] ?? message
        this.commits.unshift({ commit, shortCommit: commit.slice(0, 7), summary, authoredAt: Date.now() })
        return { commit, shortCommit: commit.slice(0, 7), summary, status: this.gitStatus() }
      }
      case "git.log":
        return { commits: this.commits.slice(0, typeof params.limit === "number" ? params.limit : 20) }
      case "git.remote.list":
        // The same remotes the project's own folder read finds, so the bar's name holds when a thread starts.
        return { remotes: folderGit(this.workspace).remotes ?? [] }
      case "git.pull": {
        await delay(400)
        const status = this.gitStatus()
        if (status.upstream === undefined) throw new HostError("CONTROL_GIT_CONFLICT", "the branch has no upstream; publish it first", 409)
        if (Number(status.ahead) > 0 && this.behind > 0) throw new HostError("CONTROL_GIT_DIVERGED", "the branch and its upstream have both changed", 409)
        const pulled = this.behind
        for (let index = 0; index < pulled; index += 1) {
          const commit = Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
          this.commits.splice(this.commits.length - 1 - this.pushed, 0, { commit, shortCommit: commit.slice(0, 7), summary: `Upstream change ${String(index + 1)}`, authoredAt: Date.now() - 3_600_000 })
          this.pushed += 1
        }
        this.behind = 0
        return { remote: "origin", branch: "main", upstream: status.upstream, from: "", to: this.commits[0]?.commit ?? "", pulled, outcome: pulled === 0 ? "up-to-date" : "fast-forwarded", status: this.gitStatus() }
      }
      case "codehost.list":
      case "codehost.set":
      case "codehost.connect":
      case "codehost.disconnect":
      case "codehost.status":
      case "codehost.remotes":
        return codeHostRpc(method, params)
      case "git.push.preview": {
        if (!this.published) {
          if (previewGit === "noremote") throw new HostError("CONTROL_GIT_NOT_FOUND", "remote is not configured", 404)
          return { remote: "origin", branch: "feat/search", localBranch: "feat/search", head: this.commits[0]?.commit ?? "", newBranch: true, setUpstream: true, ahead: this.commits.length, commits: this.commits.slice(0, 50), confirmation: "0123456789abcdef0123456789abcdef" }
        }
        const ahead = this.commits.length - 1 - this.pushed
        const current = String(this.gitStatus().branch ?? "main")
        return { remote: "origin", branch: current, localBranch: current, head: this.commits[0]?.commit ?? "", remoteHead: this.commits[ahead]?.commit, newBranch: false, setUpstream: false, ahead, commits: this.commits.slice(0, ahead), confirmation: "0123456789abcdef0123456789abcdef" }
      }
      case "git.push":
        if (params.confirmation !== "0123456789abcdef0123456789abcdef") throw new HostError("GIT_PUSH_CONFIRMATION_STALE", "push preview is stale", 409)
        this.pushed = this.commits.length - 1
        this.published = true
        return { remote: "origin", branch: "main", commit: this.commits[0]?.commit, outcome: "pushed", upstreamSet: false, status: this.gitStatus() }
      case "git.pr.checks.logs": {
        await delay(300)
        const failing = previewPr === "failing" && ciPushedAt === undefined
        return {
          host: "github.com",
          number: 128,
          headCommit: failing ? FAILING_HEAD : FIXED_HEAD,
          failed: failing ? 1 : 0,
          checks: failing ? [{ name: "test (ubuntu)", url: "https://github.com/example/project/actions/runs/9100/job/51", log: previewFailingLog() }] : [],
        }
      }
      case "git.pr.view": {
        const pull = previewPullRequests().find((entry) => entry.number === params.number)
        if (pull === undefined) throw new HostError("CONTROL_PR_NOT_FOUND", "no such pull request", 404)
        return { ...pull, owner: "example", repo: "project", body: "", bodyTruncated: false, crossRepository: false, mergeState: "blocked", mergeMethods: ["squash", "rebase"], permission: "write", files: [], reviews: [], requested: [] }
      }
      case "git.pr.merge": {
        if (params.confirm !== true) throw new HostError("CONTROL_CONFIRMATION_REQUIRED", "confirm must be true to write to GitHub", 428)
        if (params.headCommit !== (previewPullRequests()[0]?.headCommit ?? "")) throw new HostError("CONTROL_PR_HEAD_MOVED", "the pull request changed since it was read; read it again before merging", 409)
        if (params.auto === true) {
          autoMerge = true
          return { host: "github.com", merged: false, auto: true, method: params.method }
        }
        return { host: "github.com", merged: true, method: params.method }
      }
      case "git.pr.status":
        await delay(200)
        if (previewPr === "disconnected" && codeHosts.get("github.com")?.connection === undefined) throw new HostError("CONTROL_PR_NOT_CONNECTED", "GitHub is not connected for github.com", 501)
        return { owner: "example", repo: "project", remote: "origin", head: String(this.gitStatus().branch ?? "main"), source: "gh", pullRequests: previewPullRequests() }
      case "git.branches": {
        const hour = 3_600_000
        const head = this.commits[0]?.commit ?? ""
        return {
          current: "main",
          local: [
            { name: "main", commit: head, updatedAt: Date.now() - 2 * hour, upstream: "origin/main" },
            { name: "feat/search", commit: head, updatedAt: Date.now() - 30 * hour },
          ],
          remote: [
            { remote: "origin", name: "main", commit: head, updatedAt: Date.now() - 2 * hour },
            { remote: "origin", name: "fix/login-timeout", commit: head, updatedAt: Date.now() - 5 * hour },
            { remote: "origin", name: "release/2.4", commit: head, updatedAt: Date.now() - 9 * 24 * hour },
          ],
          truncated: false,
        }
      }
      case "git.fetch": {
        await delay(300)
        const commit = this.commits[0]?.commit ?? ""
        if (typeof params.pullRequest === "number") {
          if (params.pullRequest > 500) throw new HostError("CONTROL_GIT_NOT_FOUND", "the remote has no such branch or pull request", 404)
          return { remote: "origin", revision: `refs/runrail/pull/origin/${String(params.pullRequest)}`, commit, pullRequest: params.pullRequest }
        }
        return { remote: "origin", revision: `refs/remotes/origin/${String(params.branch)}`, commit, branch: params.branch }
      }
      case "git.pr.list": {
        await delay(250)
        const day = 24 * 3_600_000
        return {
          owner: "example",
          repo: "project",
          remote: "origin",
          source: "gh",
          pullRequests: [
            { number: 128, title: "Faster fuzzy search in the palette", head: "feat/fuzzy-palette", base: "main", author: "mira", draft: false, state: "open", merged: false, updatedAt: Date.now() - 3 * 3_600_000, url: "https://github.com/example/project/pull/128" },
            { number: 121, title: "Retry flaky uploads", head: "fix/upload-retry", base: "main", author: "devon", draft: true, state: "open", merged: false, updatedAt: Date.now() - 2 * day, url: "https://github.com/example/project/pull/121" },
            { number: 117, title: "Docs: worktree guide", head: "docs/worktrees", base: "main", author: "sam", draft: false, state: "open", merged: false, updatedAt: Date.now() - 6 * day, url: "https://github.com/example/project/pull/117" },
          ],
        }
      }
      case "git.pr.create": {
        if (params.confirm !== true) throw new HostError("CONTROL_INVALID_INPUT", "confirmation is required", 400)
        const pull = { number: 42, url: "https://github.com/example/project/pull/42", title: params.title, head: String(this.gitStatus().branch ?? "main"), base: params.base, draft: params.draft === true, state: "open", merged: false, review: "required", mergeable: "unknown", checks: { passed: 0, failed: 0, pending: 2, skipped: 0, items: [{ name: "build", state: "pending" }, { name: "test", state: "pending" }] } }
        createdPulls.splice(0, createdPulls.length, pull)
        return pull
      }
      case "worktree.list":
        return { worktrees: this.worktrees }
      case "worktree.create": {
        const id = String(params.id)
        if (this.worktrees.some((entry) => entry.branch === params.branch)) throw new HostError("CONTROL_GIT_CONFLICT", "branch already exists", 409)
        const worktree = { id, path: `/preview/worktrees/${id}`, cwd: `/preview/worktrees/${id}`, branch: typeof params.branch === "string" ? params.branch : `runrail/${id}`, head: this.commits[0]?.commit ?? "", detached: false, locked: false, prunable: false }
        this.worktrees.push(worktree)
        return worktree
      }
      case "worktree.remove": {
        const index = this.worktrees.findIndex((worktree) => worktree.id === params.id)
        if (index >= 0) this.worktrees.splice(index, 1)
        return { removed: true, id: params.id }
      }
      case "setup.list":
      case "setup.save":
      case "setup.delete":
      case "setup.trust":
      case "setup.run.start":
      case "setup.run.status":
      case "setup.run.list":
      case "setup.run.answer":
      case "setup.run.stop":
        return fakeSetups.rpc(method, params)
      case "eval.mine":
      case "eval.validate":
      case "eval.suites":
      case "eval.suite.get":
      case "eval.suite.save":
      case "eval.run":
      case "eval.status":
      case "eval.list":
      case "eval.stop":
        return fakeEvals.rpc(method, params)
      case "workflow.list":
      case "workflow.get":
      case "workflow.save":
      case "workflow.propose":
      case "workflow.approve":
      case "workflow.enable":
      case "workflow.delete":
      case "workflow.run.start":
      case "workflow.run.status":
      case "workflow.run.list":
      case "workflow.run.answer":
      case "workflow.run.stop":
        return fakeWorkflows.rpc(method, params, this.info.workspace)
      case "memory.status":
      case "memory.recall":
      case "memory.add":
      case "memory.update":
      case "memory.forget":
      case "memory.list":
      case "memory.settings.get":
      case "memory.settings.set":
      case "memory.source.list":
      case "memory.source.add":
      case "memory.source.remove":
      case "memory.source.sync":
        return fakeMemory.rpc(method, params)
      case "check.run": {
        const worktree = this.worktrees.find((entry) => entry.id === params.worktree)
        if (worktree === undefined) throw new HostError("CONTROL_CHECK_NOT_A_WORKTREE", "no worktree of this project has that id", 404)
        const id = String(params.id)
        const started = Date.now()
        const stopped = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 2_500)
          fakeChecks.set(id, () => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        fakeChecks.delete(id)
        // Every other worktree fails two tests, so a comparison shows both kinds.
        const fails = [...worktree.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 === 1
        const durationMs = Date.now() - started
        if (stopped) return { id, passed: false, timedOut: false, stopped: true, durationMs, tail: "src/session.test.ts:\n(pass) parses a line", truncated: false }
        const tail = fails
          ? "test/session.test.ts:\n(pass) parses a line\n(fail) skips blank lines\n  Expected: 2\n  Received: 3\n(fail) reports the failing line\n\n 126 pass\n 2 fail\nRan 128 tests across 9 files. [2.40s]"
          : "test/session.test.ts:\n(pass) parses a line\n(pass) skips blank lines\n\n 128 pass\n 0 fail\nRan 128 tests across 9 files. [2.40s]"
        return { id, ...(fails ? { exitCode: 1 } : { exitCode: 0 }), passed: !fails, timedOut: false, stopped: false, durationMs, tail, truncated: false, counts: { runner: "bun", passed: fails ? 126 : 128, failed: fails ? 2 : 0, skipped: 0, total: 128 } }
      }
      case "check.stop": {
        const stop = fakeChecks.get(String(params.id))
        stop?.()
        return { stopped: stop !== undefined }
      }
      case "worktree.apply": {
        await delay(400)
        const found = this.worktrees.some((worktree) => worktree.id === params.id)
        if (!found) throw new HostError("CONTROL_WORKTREE_NOT_FOUND", "worktree was not found", 404)
        return { files: ["src/app.ts", "README.md"], conflicts: [], base: this.commits[0]?.commit ?? "" }
      }
      case "session.external.list": {
        await delay(250)
        const hour = 3_600_000
        const here = this.info.workspace
        const sessions = [
          { source: "claude-code", id: "cc-7f3a", title: "Refactor the settings loader", updatedAt: Date.now() - 2 * hour, bytes: 412_880, branch: "main", cwd: here },
          { source: "codex", id: "cx-19b2", title: "Add retry to the HTTP client", updatedAt: Date.now() - 26 * hour, bytes: 96_214, cwd: here },
          { source: "pi", id: "pi-a04c", title: "Investigate flaky e2e test", updatedAt: Date.now() - 5 * 24 * hour, bytes: 18_502, branch: "fix/flaky", cwd: here },
          { source: "opencode", id: "ses_9f2a", title: "Speed up the test suite", updatedAt: Date.now() - 8 * hour, messages: 42, cwd: here },
        ].sort((left, right) => right.updatedAt - left.updatedAt)
        if (params.scope !== "all") return { sessions }
        // Every folder: two from folders that are no project, one of them gone.
        const elsewhere = Object.entries(ELSEWHERE).map(([id, { hoursAgo, ...session }]) => ({ ...session, id, updatedAt: Date.now() - hoursAgo * hour, bytes: 54_120 }))
        return { sessions: [...sessions, ...elsewhere].sort((left, right) => right.updatedAt - left.updatedAt) }
      }
      case "session.external.import": {
        // Like the engine: only an empty thread can take an import, and it emits no stream events.
        await delay(300)
        if (this.conversation.length > 0) throw new HostError("CONTROL_TRANSCRIPT_CONFLICT", "only a new thread can import a session", 409)
        const source = String(params.source)
        const other = ELSEWHERE[String(params.id)]
        // A session from another folder is found only by a thread in a workspace that holds it.
        const reachable = other === undefined || other.cwd === this.info.workspace || other.cwd.startsWith(`${this.info.workspace}/`)
        const title = reachable ? ({ "cc-7f3a": "Refactor the settings loader", "cx-19b2": "Add retry to the HTTP client", "pi-a04c": "Investigate flaky e2e test", ses_9f2a: "Speed up the test suite" }[String(params.id)] ?? other?.title) : undefined
        if (title === undefined) throw new HostError("CONTROL_NOT_FOUND", "external session was not found", 404)
        const inTool = params.continueIn === "tool"
        if (inTool && source !== this.info.backend) throw new HostError("CONTROL_CAPABILITY_UNAVAILABLE", "this thread cannot continue that session in its own tool", 409)
        const name = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode", gemini: "Gemini CLI", goose: "Goose", copilot: "Copilot CLI" }[source] ?? "another tool"
        const items = importedTranscript(title, name, inTool)
        for (const item of items) this.record(item)
        this.imported = { source, name, inTool, grew: true }
        return { sessionId: this.info.sessionId, source, title, imported: items.length - 1, historyMessages: 4, ...(inTool ? { inTool: true } : {}) }
      }
      case "session.external.refresh": {
        // In the preview every imported session gained two turns in its tool, brought in once.
        await delay(200)
        const imported = this.imported
        if (imported === undefined) throw new HostError("CONTROL_NOT_FOUND", "this thread did not import a session", 404)
        const marker = this.conversation.map((item) => item.code).lastIndexOf(this.conversation.some((item) => item.code === "session.refreshed") ? "session.refreshed" : "session.imported")
        if (this.conversation.slice(marker + 1).some((item) => item.kind === "user")) throw new HostError("CONTROL_TRANSCRIPT_CONFLICT", "the thread has moved on since the import", 409)
        const turns = imported.grew ? 2 : 0
        if (params.dryRun === true || turns === 0) return { sessionId: this.info.sessionId, source: imported.source, turns, imported: 0 }
        for (const item of grownTurns(imported.name, imported.inTool)) this.record(item)
        imported.grew = false
        return { sessionId: this.info.sessionId, source: imported.source, turns, imported: 4, historyMessages: 8 }
      }
      case "package.verify":
        await delay(300)
        return [
          { id: "provider-openrouter", version: "0.3.0", digest: "sha256:preview-1", integrity: "verified", platform: "any", signature: "unsigned" },
          { id: "workflow-release", version: "1.0.0", digest: "sha256:preview-2", integrity: "verified", platform: "any", signature: "unsigned" },
        ]
      case "terminal.describe":
        return { id: "preview", version: "1", capabilities: ["create", "write", "read", "resize", "close"] }
      case "terminal.create": {
        const id = String(params.sessionId)
        const terminal: FakeTerminal = { cols: Number(params.cols ?? 120), rows: Number(params.rows ?? 40), chunks: [], nextSeq: 0, line: "", closed: false }
        this.terminals.set(id, terminal)
        terminal.chunks.push({ seq: 0, data: "\x1b[2mPreview terminal - type ls, git status or echo.\x1b[0m\r\n\x1b[38;5;110m~/project\x1b[0m $ " })
        terminal.nextSeq = 1
        return { sessionId: id, cols: terminal.cols, rows: terminal.rows, status: "running" }
      }
      case "terminal.write": {
        const terminal = this.terminal(String(params.sessionId))
        const data = String(params.data ?? "")
        this.termWrite(terminal, data)
        return { acceptedBytes: new TextEncoder().encode(data).length }
      }
      case "terminal.read": {
        const id = String(params.sessionId)
        const terminal = this.terminal(id)
        const after = typeof params.afterSeq === "number" ? params.afterSeq : -1
        const chunks = terminal.chunks.filter((chunk) => chunk.seq > after)
        return { session: { sessionId: id, cols: terminal.cols, rows: terminal.rows, status: terminal.closed ? "closed" : "running" }, chunks, nextSeq: terminal.nextSeq, closed: terminal.closed }
      }
      case "terminal.resize": {
        const id = String(params.sessionId)
        const terminal = this.terminal(id)
        terminal.cols = Number(params.cols)
        terminal.rows = Number(params.rows)
        return { sessionId: id, cols: terminal.cols, rows: terminal.rows, status: "running" }
      }
      case "terminal.close": {
        const id = String(params.sessionId)
        const terminal = this.terminal(id)
        terminal.closed = true
        this.terminals.delete(id)
        return { sessionId: id, cols: terminal.cols, rows: terminal.rows, status: "closed" }
      }
      case "plugin.list":
        return [
          { manifest: { id: "lint-guard", version: "1.2.0", mode: "isolated", capabilities: ["tools"], contributes: ["tools"], enabled: true }, enabled: true },
          { manifest: { id: "docs-search", version: "0.4.1", mode: "trusted", capabilities: ["tools", "network"], contributes: ["tools", "commands"], enabled: false }, enabled: false },
        ]
      case "package.list":
        return [
          { manifest: { id: "provider-openrouter", version: "0.3.0", displayName: "OpenRouter provider", packageType: "provider", description: "Route models through OpenRouter", publisher: "community", tags: ["provider"] }, enabled: true, active: true },
          { manifest: { id: "workflow-release", version: "1.0.0", displayName: "Release workflow", packageType: "workflow", description: "Tag, changelog and draft release", publisher: "runrail", tags: ["workflow"] }, enabled: true, active: false },
        ]
      case "plugin.enable":
      case "plugin.disable":
      case "plugin.rollback":
      case "plugin.remove":
      case "plugin.install":
      case "plugin.update":
      case "package.install":
      case "package.update":
      case "package.activate":
      case "package.deactivate":
      case "package.rollback":
      case "package.remove":
      case "package.enable":
      case "package.disable":
        await delay(300)
        return { ok: true }
      case "task.create":
        return { taskId: typeof params.taskId === "string" ? params.taskId : `task-${String(Date.now())}`, title: params.title, status: "open", digest: "sha256:preview" }
      case "share.create":
        return { share: { shareId: `share-${String(Date.now())}`, taskId: params.taskId, mode: params.mode ?? "local-export", revision: 0, createdAt: Date.now() }, bundle: { contractVersion: 1, taskDigest: "sha256:preview", artifacts: [] } }
      case "share.list":
        return []
      case "share.revoke":
        return { revoked: true }
      case "session.fork":
      case "session.branch":
        return { sessionId: typeof params.targetSessionId === "string" ? params.targetSessionId : `fork-${String(Date.now())}` }
      case "session.compact":
        return await this.compact()
      case "session.usage.read":
        return this.readUsage()
      default:
        throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
    }
  }
}

const PREVIEW_MODELS: readonly Omit<VoiceModel, "installed" | "downloading">[] = [
  { id: "tiny.en", label: "Tiny (English)", size: 32_166_155, englishOnly: true },
  { id: "tiny", label: "Tiny", size: 32_152_673, englishOnly: false },
  { id: "base.en", label: "Base (English)", size: 59_721_011, englishOnly: true },
  { id: "base", label: "Base", size: 59_707_625, englishOnly: false },
  { id: "small.en", label: "Small (English)", size: 190_098_681, englishOnly: true },
  { id: "small", label: "Small", size: 190_085_487, englishOnly: false },
  { id: "large-v3-turbo", label: "Large v3 Turbo", size: 574_041_195, englishOnly: false },
]

const PREVIEW_SPEECH = "Add a test for the empty cart and run it"

/** Pretend listening: a level that moves, then the words of one sentence. */
function createFakeVoice() {
  const listeners = new Set<(event: VoiceEvent) => void>()
  const progress = new Set<(update: ModelProgress) => void>()
  const installed = new Set<string>(["base.en"])
  let downloading: { readonly id: string; readonly timer: ReturnType<typeof setInterval> } | undefined
  let session = 0
  let running: { readonly id: number; readonly timer: ReturnType<typeof setInterval>; readonly input: ListenInput; words: number } | undefined
  const emit = (event: VoiceEvent): void => listeners.forEach((listener) => listener(event))
  const words = PREVIEW_SPEECH.split(" ")
  const finish = (id: number, keep: boolean): void => {
    if (running?.id !== id) return
    clearInterval(running.timer)
    const heard = words.slice(0, running.words).join(" ")
    running = undefined
    if (!keep) {
      emit({ session: id, kind: "ended" })
      return
    }
    emit({ session: id, kind: "transcribing" })
    setTimeout(() => {
      emit({ session: id, kind: "final", text: heard })
      emit({ session: id, kind: "ended" })
    }, 400)
  }
  const models = (): readonly VoiceModel[] => PREVIEW_MODELS.map((model) => ({ ...model, installed: installed.has(model.id), downloading: downloading?.id === model.id }))
  return {
    voiceDevices: async () => [
      { id: "preview:built-in", name: "MacBook Pro Microphone", default: true },
      { id: "preview:usb", name: "USB Audio Device", default: false },
    ],
    voiceModels: async () => models(),
    voiceModelDownload: async (id: string) => {
      const model = PREVIEW_MODELS.find((item) => item.id === id)
      if (model === undefined) throw new HostError("VOICE_MODEL_UNKNOWN", "no such model")
      if (downloading !== undefined) throw new HostError("VOICE_MODEL_BUSY", "another model is downloading")
      let received = 0
      const timer = setInterval(() => {
        received = Math.min(model.size, received + model.size / 12)
        progress.forEach((listener) => listener({ id, state: "downloading", received, total: model.size }))
        if (received < model.size) return
        clearInterval(timer)
        downloading = undefined
        installed.add(id)
        progress.forEach((listener) => listener({ id, state: "done" }))
      }, 200)
      downloading = { id, timer }
    },
    voiceModelCancel: async (id: string) => {
      if (downloading?.id !== id) return
      clearInterval(downloading.timer)
      downloading = undefined
      progress.forEach((listener) => listener({ id, state: "cancelled" }))
    },
    voiceModelRemove: async (id: string) => {
      installed.delete(id)
      return models()
    },
    voiceStart: async (input: ListenInput) => {
      if (input.engine === "whisper" && (input.model === undefined || !installed.has(input.model))) throw new HostError("VOICE_MODEL_MISSING", "download the Whisper model first, in Settings > Voice")
      if (running !== undefined) finish(running.id, false)
      const id = ++session
      let tick = 0
      const timer = setInterval(() => {
        const current = running
        if (current?.id !== id) return
        tick += 1
        const speaking = current.words < words.length
        emit({ session: id, kind: "level", level: speaking ? 0.3 + Math.random() * 0.5 : 0.04 })
        if (speaking && tick % 3 === 0) {
          current.words += 1
          if (input.engine === "apple") emit({ session: id, kind: "partial", text: words.slice(0, current.words).join(" ") })
        }
        if (!speaking && input.untilSilence && tick > words.length * 3 + 12) finish(id, true)
      }, 110)
      running = { id, timer, input, words: 0 }
      return id
    },
    voiceStop: async (id: number) => finish(id, true),
    voiceCancel: async (id: number) => finish(id, false),
    onVoice: (listener: (event: VoiceEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onVoiceModel: (listener: (update: ModelProgress) => void) => {
      progress.add(listener)
      return () => progress.delete(listener)
    },
  }
}

export function createFakeHost(scenario: PreviewScenario = {}): Host {
  let loginItem: LoginItemStatus = "off"
  let wakeService: WakeServiceStatus = "off"
  let remotes: RemoteMachine[] = []
  let tailscale: TailscaleStatus = { installed: true, running: true, name: "preview-mac.tail1234.ts.net", https: true, served: false }
  // A phone paired a week ago, so the preview's Settings shows one.
  let phone: PhoneStatus = { enabled: false, running: false, port: 47615, devices: [{ id: "ph-preview", name: "iPhone", addedAt: Date.now() - 7 * 86_400_000, seenAt: Date.now() - 3_600_000, notifies: false }], shares: [], hooks: [] }
  let pushTargets: PhonePushTarget[] = []
  let sharesMade = 0
  let quick: QuickStatus = { enabled: true, shortcut: "Alt+Space" }
  const quickListeners = new Set<(message: QuickMessage) => void>()
  previewGit = scenario.git
  previewGh = scenario.gh
  previewPr = scenario.pr
  previewUsage = scenario.usage
  fakeSetups.seedProject(scenario.projectSetup === true)
  createdPulls.length = 0
  ciPushedAt = undefined
  autoMerge = false
  codeHosts.clear()
  let notify: NotifyStatus = { available: true, permission: "unknown" }
  const engines = new Map<string, FakeEngine>()
  const batch = new Set<Listener<[string, readonly StreamFrame[]]>>()
  const stream = new Set<Listener<[string, StreamState, string | undefined]>>()
  const exit = new Set<Listener<[string, number | null]>>()
  const connections = new FakeConnections(scenario, () => fakeToolStatus(scenario.seed ?? "default"))
  const system: EngineInfo = {
    engineId: SYSTEM_ENGINE_ID,
    state: "running",
    workspace: "/preview/system",
    backend: "native",
    sessionId: "system",
    behavior: { mode: "ask", effort: "medium", permissionDefault: "deny", rules: [] },
    instance: 0,
    contract: { protocol: 1, apiVersion: "1.0", supportedProtocols: [1], runrailVersion: "preview", capabilities: [...Object.keys(CAPABILITIES), "conversation.peek", "usage.read", "claude.sdk", "thread.copy", "push"], capabilityStatus: { ...CAPABILITIES, "conversation.peek": "available", "usage.read": "available", "claude.sdk": "available", "thread.copy": "available", push: "available" } },
  }
  let instance = 0
  let picks = 0
  const computer = fakeComputer(scenario.computer)
  const simulator = fakeSimulator(scenario.simulator)
  const android = fakeAndroid(scenario.android)
  /** Projects with browser sign-ins saved. */
  const signIns = new Set<string>()
  /** Browser tabs the person is picking an element in, with how often the pick was read. */
  const picking = new Map<string, number>()
  const agentFiles = new Map<string, string>()
  let mcpServers: McpServer[] = []
  const agentDefinitions = new Map<string, readonly AgentDefinition[]>()
  /** Office threads whose script an engine took. Once per host, so a restarted engine does not play it again. */
  const scripted = new Set<string>()
  let state: unknown = null
  try {
    state = JSON.parse(localStorage.getItem("runrail.preview.state") ?? "null")
  } catch {
    state = null
  }

  /** Conversations `thread.copy` made, by the thread they were copied to. */
  const copies = new Map<string, FakeConversationItem[]>()

  function copyThread(params: Record<string, unknown>): unknown {
    const { from, to } = params
    if (typeof from !== "string" || typeof to !== "string" || from === to) throw new HostError("CONTROL_INVALID_INPUT", "from and to are required", 400)
    if (copies.has(to) || [...engines.values()].some((entry) => entry.info.sessionId === to && entry.conversation.length > 0)) throw new HostError("CONTROL_TRANSCRIPT_CONFLICT", "the copy's thread already has a conversation", 409)
    const whole = [...engines.values()].find((entry) => entry.info.sessionId === from)?.conversation ?? []
    const { beforeSeq } = params
    let items = whole
    if (beforeSeq !== undefined) {
      const at = whole.findIndex((item) => item.seq === beforeSeq && item.kind === "user")
      if (at < 0) throw new HostError("CONTROL_TRANSCRIPT_INVALID", "beforeSeq does not name a message that starts a turn", 400)
      items = whole.slice(0, at)
    }
    if (items.length === 0) return { copied: false }
    copies.set(to, [...items.map((item) => ({ ...item })), { id: String(items.length + 1), seq: items[items.length - 1]?.seq ?? 0, at: Date.now(), kind: "notice", level: "info", code: "session.continued" }])
    return { copied: true }
  }

  /** A thread's history as its transcript holds it: its engine's when one ran here, else what one would start with. */
  function peekThread(params: Record<string, unknown>): unknown {
    const threadId = params.threadId
    if (typeof threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(threadId)) throw new HostError("CONTROL_INVALID_INPUT", "session id is invalid", 400)
    const workspace = params.workspace
    if (typeof workspace !== "string" || !workspace.startsWith("/")) throw new HostError("CONTROL_INVALID_INPUT", "workspace must be an absolute folder path", 400)
    const max = typeof params.maxItems === "number" ? params.maxItems : 512
    const copied = copies.get(threadId)
    if (copied !== undefined && ![...engines.values()].some((entry) => entry.info.sessionId === threadId)) return { threadId, items: copied.slice(-max), truncated: copied.length > max, lastSeq: copied[copied.length - 1]?.seq ?? -1 }
    const source = [...engines.values()].find((entry) => entry.info.sessionId === threadId) ?? new FakeEngine({ engineId: `peek-${threadId}`, workspace, backend: "native", sessionId: threadId }, () => undefined, 0, scenario.seed ?? "default", [], scenario.long === true ? 2_000 : 0)
    return { threadId, items: source.conversation.slice(-max), truncated: source.conversation.length > max, lastSeq: source.seq }
  }

  function engine(id: string): FakeEngine {
    const found = engines.get(id)
    // As the desktop host answers: an engine it does not know is one that is not running.
    if (found === undefined) throw new HostError("ENGINE_NOT_RUNNING", "engine is not running", 409)
    return found
  }

  return {
    kind: "preview",
    info: async () => ({ version: "preview", platform: "browser", terminal: true, updates: true, credentialStore: "file", clipboardSecrets: true }),
    startupReady: async () => ({ readyMs: Math.round(performance.now()), at: Date.now() }),
    updateCheck: async () => {
      await delay(600)
      return { state: "available", version: "0.2.0", current: "0.1.0", date: "2026-09-30T09:00:00Z", notes: "Import sessions from Claude Code, Codex, and Pi.\nApply a worktree's changes to the main checkout.\nThreads keep their context across restarts." }
    },
    updateInstall: async () => {
      await delay(1_200)
      throw new HostError("UPDATE_UNAVAILABLE", "the preview cannot install updates", 501)
    },
    engineStart: async (input) => {
      if (input.engineId === SYSTEM_ENGINE_ID) throw new HostError("CONTROL_INVALID_INPUT", "engine id is reserved", 400)
      const existing = engines.get(input.engineId)
      if (existing !== undefined) return existing.info
      if (input.connectionId !== undefined && !connections.usable(input.connectionId)) throw new HostError("CONNECTION_NOT_FOUND", "engine exited before it was ready (CONNECTION_NOT_FOUND)")
      if (input.toolConnectionId !== undefined) {
        if (input.connectionId !== undefined || input.backend === "native" || input.backend === "replay") throw new HostError("CONTROL_INVALID_INPUT", "a tool connection needs a coding-tool backend", 400)
        const problem = connections.toolProblem(input.toolConnectionId, input.backend, input.model)
        if (problem !== undefined) throw new HostError(problem, `engine exited before it was ready (${problem})`)
      }
      await delay(120)
      instance += 1
      const script = scripted.has(input.sessionId) ? undefined : officeScripts(scenario).get(input.sessionId)
      if (script !== undefined) scripted.add(input.sessionId)
      const created = new FakeEngine(input, (frames) => batch.forEach((listener) => listener(input.engineId, frames)), instance, scenario.seed ?? "default", mcpServers, scenario.long === true ? 2_000 : 0, script)
      // A continued thread starts with the conversation of the thread it continues, as the engine copies it.
      const parent = input.continueFrom === undefined ? undefined : [...engines.values()].find((engine) => engine.info.sessionId === input.continueFrom)
      if (parent !== undefined && created.conversation.length === 0) {
        for (const item of parent.conversation) created.conversation.push({ ...item })
        created.record({ kind: "notice", level: "info", code: "session.continued" })
      }
      // A rewind's kept copy or a fork, as `thread.copy` wrote it, is the thread's transcript in place of any seed.
      const copied = copies.get(input.sessionId)
      if (copied !== undefined) created.conversation.splice(0, created.conversation.length, ...copied.map((item) => ({ ...item })))
      engines.set(input.engineId, created)
      return created.info
    },
    engineStop: async (engineId) => {
      const found = engines.get(engineId)
      if (found === undefined) return
      found.cancel()
      // Stopped before its first turn, it never played its script; the thread's next engine will.
      if (found.turn === 0) scripted.delete(found.info.sessionId)
      engines.delete(engineId)
      exit.forEach((listener) => listener(engineId, 0))
    },
    engineList: async () => [...engines.values()].map((entry) => entry.info),
    rpc: async (engineId, method, params = {}) => {
      guardRendererRpc(engineId, method, params)
      // The person ran a tool's own sign-in for a connection's folder in a terminal tab.
      const folder = method === "terminal.write" && typeof params.data === "string" && /\blogin\b/.test(params.data) ? /tool-homes\/([A-Za-z][A-Za-z0-9._:-]*)/.exec(params.data)?.[1] : undefined
      if (folder !== undefined) setTimeout(() => connections.finishToolSignIn(folder), scenario.signInDelayMs ?? 1_200)
      await delay(method.startsWith("git.") || method.startsWith("workspace.") ? 40 : 10)
      if (engineId !== SYSTEM_ENGINE_ID) return engine(engineId).rpc(method, params)
      if (connections.offline) throw new HostError("ENGINE_NOT_RUNNING", "engine is not running", 409)
      if (method.startsWith("codehost.")) return codeHostRpc(method, params)
      if (REVIEW_METHODS.has(method)) return reviewsRpc(method, params, codeHosts.get("github.com")?.connection?.enabled === true)
      if (method === "conversation.peek") return peekThread(params)
      if (method === "thread.copy") return copyThread(params)
      // The preview's own VAPID key: RFC 8291's example server key, a valid P-256 point.
      if (method === "push.vapid") return { publicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" }
      if (method === "push.send") return { delivered: true }
      if (method === "workflow.due" || method === "workflow.upcoming") return fakeWorkflows.rpc(method, params, "/preview/system")
      if (method.startsWith("connector.setup.")) return fakeConnectors.rpc(method, params)
      return connections.rpc(method, params)
    },
    systemEngine: async () => {
      if (connections.offline) throw new HostError("CONTROL_START_FAILED", "the engine could not be started")
      return system
    },
    connectionSecretSet: async (connectionId, secret, target) => {
      await delay(80)
      return target === "connector" ? fakeConnectors.setSecret(connectionId) : connections.setSecret(connectionId, secret, target)
    },
    // The preview has no clipboard access; a placeholder stands in for whatever would be read.
    connectionSecretFromClipboard: async (connectionId, target) => {
      await delay(80)
      return target === "connector" ? fakeConnectors.setSecret(connectionId) : connections.setSecret(connectionId, "preview-placeholder", target)
    },
    authOpen: async (loginId) => connections.open(loginId),
    authSubmitInput: async (loginId, input) => connections.submitInput(loginId, input),
    streamStart: async (engineId, afterSeq, afterLiveSeq) => {
      engine(engineId).startStream(afterSeq, afterLiveSeq ?? 0)
      stream.forEach((listener) => listener(engineId, "connected", undefined))
    },
    streamStop: async (engineId) => {
      const found = engines.get(engineId)
      if (found !== undefined) found.streaming = false
    },
    threadForget: async () => undefined,
    // The preview has no dialog: a pick near a folder takes that folder, as a person clicking Open would.
    computerAccess: async () => computer.access(),
    computerRequestAccess: async (kind) => computer.grant(kind),
    computerOpenSettings: async () => undefined,
    computerRunningApps: async () => computer.running,
    computerAllowed: async () => computer.allowed(),
    computerAllow: async (bundleId) => computer.allow(bundleId),
    computerDisallow: async (bundleId) => computer.disallow(bundleId),
    computerAct: async (action, params) => {
      await delay(120)
      return computer.act(action, params)
    },
    simulatorStatus: async () => simulator.status(),
    simulatorDevices: async () => simulator.devices(),
    simulatorBoot: async (udid) => {
      await delay(400)
      simulator.boot(udid)
    },
    simulatorShutdown: async (udid) => simulator.shutdown(udid),
    simulatorOpen: async (udid) => simulator.open(udid),
    simulatorScreenshot: async (udid) => simulator.screenshot(udid),
    simulatorApps: async (udid) => simulator.apps(udid),
    simulatorInstall: async (udid) => simulator.install(udid),
    simulatorLaunch: async (udid, bundleId) => simulator.launch(udid, bundleId),
    simulatorOpenUrl: async (udid, url) => simulator.openUrl(udid, url),
    simulatorInput: async (udid, input) => simulator.input(udid, input),
    simulatorAgents: async (on) => simulator.setAgents(on),
    androidStatus: async () => android.status(),
    androidDevices: async () => android.devices(),
    androidBoot: async (avd) => {
      await delay(400)
      return android.boot(avd)
    },
    androidShutdown: async (serial) => android.shutdown(serial),
    androidScreenshot: async (serial) => android.screenshot(serial),
    androidApps: async (serial) => android.apps(serial),
    androidInstall: async (serial) => android.install(serial),
    androidLaunch: async (serial, packageName) => android.launch(serial, packageName),
    androidOpenUrl: async (serial, url) => android.openUrl(serial, url),
    androidInput: async (serial, input) => android.input(serial, input),
    androidAgents: async (on) => android.setAgents(on),
    // A related folder is, in turn, a repository beside the project and a notes folder git cannot read.
    workspacePick: async (options): Promise<WorkspaceInfo | null> => {
      if (options?.related === true) {
        picks += 1
        return picks % 2 === 1 ? { path: "/Users/preview/code/api", name: "api", git: true } : { path: "/Users/preview/notes", name: "notes", git: false }
      }
      return options?.near === undefined ? { path: "/Users/preview/code/project", name: "project", git: true } : { path: options.near, name: options.near.split("/").filter(Boolean).pop() ?? options.near, git: false }
    },
    // The engine's own list, so the preview shows what the app offers.
    appStarters: async () => ({
      default: "nifra",
      starters: [
        { id: "nifra", label: "Nifra", description: "A full-stack TypeScript app: typed API routes and a React frontend, with Nifra's checks and agent tools set up.", maker: "the authors of Runrail", recommended: true, creator: "create-nifra@5.3.0" },
        { id: "vite", label: "Vite + React", description: "A React and TypeScript app on Vite.", maker: "the Vite team", recommended: false, creator: "create-vite@9.2.1" },
        { id: "next", label: "Next.js", description: "A Next.js app with the App Router, TypeScript, Tailwind CSS, and ESLint.", maker: "Vercel", recommended: false, creator: "create-next-app@16.3.8" },
        { id: "empty", label: "Empty", description: "An empty folder with a git repository.", maker: "Runrail", recommended: false },
      ],
    }),
    appCreate: async (name, starter) => {
      await new Promise((done) => setTimeout(done, 1_200))
      const path = `/Users/preview/code/${name}`
      if (starter === "nifra") previewNifraApps.add(path)
      return { ok: true, workspace: { path, name, git: true }, warnings: [] }
    },
    archivePick: async () => null,
    workspaceInspect: async (path) => ({ path, name: path.split("/").filter(Boolean).pop() ?? path, git: true }),
    workspaceReveal: async () => undefined,
    workspaceOpenIn: async () => undefined,
    openInApps: async () => ["vscode", "cursor", "zed", "xcode", "finder", "terminal", "iterm", "ghostty"],
    attachmentSave: async (_workspace, mediaType) => `.runrail/attachments/preview-${String(Date.now())}.${mediaType.split("/")[1] ?? "png"}`,
    instructionsRead: async (workspace) => {
      const text = agentFiles.get(workspace)
      return { exists: text !== undefined, text: text ?? "", claudeFile: false }
    },
    instructionsWrite: async (workspace, text) => {
      if (text.length > 256 * 1024) throw new HostError("INSTRUCTIONS_INVALID", "instructions are longer than the agent reads")
      agentFiles.set(workspace, text)
      return { exists: true, text, claudeFile: false }
    },
    mcpList: async () => mcpServers,
    mcpSave: async (server, previous) => {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(server.name)) throw new HostError("MCP_INVALID", "server name must be lowercase letters, digits, - or _, starting with a letter")
      if (server.url !== undefined) {
        if (!/^(https:\/\/[^\s@/]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)(\/\S*)?$/.test(server.url)) throw new HostError("MCP_INVALID", "address must be https, or http on this computer, with no user name or password")
      } else if (server.command.length === 0 || /\s/.test(server.command) || server.command.startsWith("-")) throw new HostError("MCP_INVALID", "command must be one program name or path without spaces; put the rest in arguments")
      const replacing = previous ?? server.name
      if (mcpServers.some((item) => item.name === server.name && item.name !== replacing)) throw new HostError("MCP_INVALID", "another server already has this name")
      mcpServers = mcpServers.some((item) => item.name === replacing) ? mcpServers.map((item) => (item.name === replacing ? server : item)) : [...mcpServers, server]
      return mcpServers
    },
    mcpSetEnabled: async (name, enabled) => {
      mcpServers = mcpServers.map((item) => (item.name === name ? { ...item, enabled } : item))
      return mcpServers
    },
    mcpRemove: async (name) => {
      mcpServers = mcpServers.filter((item) => item.name !== name)
      return mcpServers
    },
    keepAwake: async (on) => on,
    quitGuard: async () => undefined,
    appQuit: async () => undefined,
    backgroundHold: async () => undefined,
    onBackground: () => () => undefined,
    loginItem: async () => loginItem,
    setLoginItem: async (on: boolean) => (loginItem = on ? "on" : "off"),
    wakeService: async () => wakeService,
    setWakeService: async (on: boolean) => (wakeService = on ? "on" : "off"),
    launchWoken: async () => false,
    remoteList: async () => remotes,
    remoteSave: async (machine) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,252}$/.test(machine.host)) throw new HostError("REMOTE_INVALID", "use an SSH host alias, a host name, or user@host", 400)
      const saved: RemoteMachine = { id: machine.id ?? `rm-${String(remotes.length + 1)}`, host: machine.host, ...(machine.engine === undefined || machine.engine === "runrail" ? {} : { engine: machine.engine }) }
      remotes = [...remotes.filter((remote) => remote.id !== saved.id), saved]
      return remotes
    },
    remoteRemove: async (id) => (remotes = remotes.filter((remote) => remote.id !== id)),
    // The preview's machines answer; a folder under /home is there, and a git repository.
    remoteCheck: async (id, folder) => {
      await delay(300)
      if (!remotes.some((remote) => remote.id === id)) throw new HostError("REMOTE_NOT_FOUND", "that remote machine is not set up", 404)
      return { version: "0.1.0", ...(folder === undefined ? {} : { folder: folder.startsWith("/home/"), git: folder.startsWith("/home/") }) }
    },
    sshHosts: async () => ["dev-box", "build-server"],
    phoneStatus: async () => phone,
    setPhone: async (on) => (phone = { ...phone, enabled: on, running: on, ...(on ? {} : { pairing: undefined }) }),
    phonePair: async () => {
      if (!phone.running) throw new HostError("PHONE_OFF", "Turn on phone access first.", 409)
      return (phone = { ...phone, pairing: { code: "K7Q2M9XP", expiresAt: Date.now() + 5 * 60_000 } })
    },
    phoneForget: async (id) => (phone = { ...phone, devices: phone.devices.filter((device) => device.id !== id) }),
    phoneAnswer: async () => undefined,
    onPhoneCall: () => () => undefined,
    onPhoneChanged: () => () => undefined,
    phoneSetPush: async (device, push) => {
      phone = { ...phone, devices: phone.devices.map((item) => (item.id === device ? { ...item, notifies: push !== null } : item)) }
      pushTargets = [...pushTargets.filter((target) => target.device !== device), ...(push === null ? [] : [{ device, subscription: push.subscription, origin: push.origin }])]
    },
    phonePushTargets: async () => pushTargets,
    phoneShareThread: async (threadId, title) => {
      if (!phone.running) throw new HostError("PHONE_OFF", "Turn on phone access first.", 409)
      const existing = phone.shares.find((share) => share.threadId === threadId)
      if (existing !== undefined) return existing
      const share: PhoneShare = { id: `sh-${String(++sharesMade)}`, token: `preview${threadId.replace(/[^A-Za-z0-9]/g, "").padEnd(25, "x").slice(0, 25)}`, kind: "thread", title, threadId, createdAt: Date.now() }
      phone = { ...phone, shares: [...phone.shares, share] }
      return share
    },
    phonePublish: async () => {
      if (!phone.running) throw new HostError("PHONE_OFF", "Turn on phone access first.", 409)
      const share: PhoneShare = { id: `sh-${String(++sharesMade)}`, token: "previewpagexxxxxxxxxxxxxxxxxxxxx", kind: "page", title: "dist", files: 14, bytes: 482_000, createdAt: Date.now() }
      phone = { ...phone, shares: [...phone.shares, share] }
      return share
    },
    phoneUnshare: async (id) => (phone = { ...phone, shares: phone.shares.filter((share) => share.id !== id) }),
    phoneHookCreate: async (projectId, workflowId) => {
      if (!phone.running) throw new HostError("PHONE_OFF", "Turn on phone access first.", 409)
      const hook: PhoneHook = { id: `hk-${String(++sharesMade)}`, projectId, workflowId, createdAt: Date.now() }
      phone = { ...phone, hooks: [...phone.hooks.filter((item) => item.projectId !== projectId || item.workflowId !== workflowId), hook] }
      return { ...hook, token: `previewhook${String(sharesMade).padStart(21, "x")}` }
    },
    phoneHookRemove: async (id) => (phone = { ...phone, hooks: phone.hooks.filter((hook) => hook.id !== id) }),
    quickStatus: async () => quick,
    quickSet: async (enabled, shortcut) => {
      if (!/^((Alt|Option|Shift|Control|Ctrl|Command|Cmd|Super|CmdOrCtrl|CommandOrControl)\+)+[A-Za-z0-9]+$/.test(shortcut)) throw new HostError("QUICK_SHORTCUT_INVALID", "A shortcut needs Option, Command, Control or Shift with its key.", 400)
      return (quick = { enabled, shortcut })
    },
    onQuickSubmit: (listener) => {
      quickListeners.add(listener)
      return () => quickListeners.delete(listener)
    },
    tailscaleStatus: async () => tailscale,
    tailscaleServe: async (on) => {
      await delay(400)
      if (on && !phone.running) throw new HostError("PHONE_OFF", "Turn on phone access first.", 409)
      return (tailscale = { ...tailscale, served: on })
    },
    notifyStatus: async () => notify,
    notifyRequest: async () => {
      notify = { available: true, permission: "granted" }
      return notify
    },
    notifySend: async () => undefined,
    notifyClear: async () => undefined,
    notifyTakeOpened: async () => null,
    onNotificationOpen: () => () => undefined,
    ...createFakeVoice(),
    shellsList: async () => ["/bin/zsh", "/bin/bash", "/bin/sh"],
    skillImport: async () => {
      // The preview has no folder dialog; it pretends one folder was chosen.
      await delay(300)
      return { name: "release-notes", path: ".agents/skills/release-notes", files: 2 }
    },
    agentsList: async (workspace) => agentDefinitions.get(workspace) ?? [],
    agentSave: async (workspace, agent, previous) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent.name)) throw new HostError("AGENT_INVALID", "name must be lowercase letters, digits, or -, starting with a letter")
      if (agent.description.trim().length === 0 || /[\n\r]/.test(agent.description)) throw new HostError("AGENT_INVALID", "description must be one line of up to 1,024 characters")
      const list = agentDefinitions.get(workspace) ?? []
      const replacing = previous ?? agent.name
      if (replacing !== agent.name && list.some((item) => item.name === agent.name)) throw new HostError("AGENT_INVALID", "another subagent already has this name")
      const next = [...list.filter((item) => item.name !== replacing), agent].sort((left, right) => left.name.localeCompare(right.name))
      agentDefinitions.set(workspace, next)
      return next
    },
    agentRemove: async (workspace, name) => {
      const next = (agentDefinitions.get(workspace) ?? []).filter((item) => item.name !== name)
      agentDefinitions.set(workspace, next)
      return next
    },
    otherToolsScan: async () => {
      await delay(400)
      return PREVIEW_OTHER_TOOLS
    },
    otherSkillImport: async (_workspace, path) => {
      const skill = PREVIEW_OTHER_TOOLS.skills.find((item) => item.path === path)
      if (skill === undefined) throw new HostError("SKILL_INVALID", "that folder is not one of the skills found")
      await delay(200)
      return { name: skill.name, path: `.agents/skills/${skill.name}`, files: 1 }
    },
    otherAgentImport: async (workspace, path) => {
      const found = PREVIEW_OTHER_TOOLS.agents.find((item) => item.path === path)
      if (found === undefined) throw new HostError("AGENT_INVALID", "that file is not one of the subagents found")
      const list = agentDefinitions.get(workspace) ?? []
      if (list.some((item) => item.name === found.name)) throw new HostError("AGENT_EXISTS", "the project already has a subagent with this name")
      const next = [...list, { name: found.name, description: found.description, tools: [], prompt: "" }].sort((left, right) => left.name.localeCompare(right.name))
      agentDefinitions.set(workspace, next)
      return next
    },
    mcpImport: async (servers) => {
      if (servers.some((server) => mcpServers.some((item) => item.name === server.name))) throw new HostError("MCP_INVALID", "another server already has this name")
      if (mcpServers.length + servers.length > 16) throw new HostError("MCP_INVALID", "at most 16 MCP servers")
      mcpServers = [...mcpServers, ...servers]
      return mcpServers
    },
    // Office mode and the projects preview never write over the usual preview's saved state.
    stateLoad: async () => (scenario.office === true ? officeState(scenario) : scenario.projects === true ? projectsState() : state),
    onQuit: () => () => undefined,
    stateSave: async (value) => {
      state = value
      if (scenario.office === true || scenario.projects === true) return
      try {
        localStorage.setItem("runrail.preview.state", JSON.stringify(value))
      } catch {
        // Preview persistence is best effort.
      }
    },
    // A plain browser has no native webview; the panel shows the page in a frame instead.
    previewNative: false,
    // A project that keeps its sign-ins has some saved once one of its pages opens.
    previewOpen: async (_tab, _url, _bounds, _hidden, project) => {
      if (project !== undefined) signIns.add(project)
      return { reachable: true }
    },
    signInsSaved: async (project) => signIns.has(project),
    signInsSupport: async () => ({ available: true }),
    signInsForget: async (project) => {
      signIns.delete(project)
    },
    previewBounds: async () => undefined,
    previewZoom: async () => undefined,
    previewAction: async () => undefined,
    previewExternal: async () => undefined,
    previewClose: async () => undefined,
    previewRetain: async () => undefined,
    onPreview: () => () => undefined,
    // The frame's page is another origin, so the preview answers for it.
    previewScript: async (tab, script) => {
      await delay(120)
      if (script.action === "snapshot") return { text: "Address: http://localhost:5173/\nTitle: Preview app\n\nText:\nWelcome to the preview app.\n\nElements:\ne1 link \"Docs\" -> /docs\ne2 button \"Sign up\"" }
      if (script.action === "console") return { text: "No console errors or warnings since the page loaded." }
      // Picking: the person "clicks" the Sign up button on the second look.
      if (script.action === "pickStart") {
        picking.set(tab, 0)
        return { text: "picking" }
      }
      if (script.action === "pickStop") {
        picking.delete(tab)
        return { text: "stopped" }
      }
      if (script.action === "pickRead") {
        const reads = picking.get(tab)
        if (reads === undefined) return { text: JSON.stringify({ state: "idle" }) }
        if (reads < 1) {
          picking.set(tab, reads + 1)
          return { text: JSON.stringify({ state: "picking" }) }
        }
        picking.delete(tab)
        return { text: JSON.stringify({ state: "picked", pick: { role: "button", name: "Sign up", tag: "button", selector: "main > form.signup > button.primary", text: "Sign up", url: "http://localhost:5173/" } }) }
      }
      if (script.action === "network") return { text: "1 of the last 3 requests failed or returned an error status.\nGET 200 http://localhost:5173/ (navigation, 42 ms)\nGET 200 http://localhost:5173/assets/app.js (script, 18 ms)\nPOST 500 http://localhost:5173/api/sessions (fetch, 64 ms)" }
      return { text: `Done (${script.action}).` }
    },
    previewEval: async () => {
      await delay(120)
      throw new HostError("PREVIEW_DENIED", "The person declined to run the script.", 403)
    },
    previewScreenshot: async () => {
      throw new HostError("PREVIEW_UNSUPPORTED", "screenshots need the desktop app", 501)
    },
    openUrl: async (url) => {
      if (!/^https:\/\//i.test(url)) throw new HostError("LINK_REFUSED", "Only https links open in your browser.")
      window.open(url, "_blank", "noopener,noreferrer")
    },
    onBatch: (listener) => {
      batch.add(listener)
      return () => batch.delete(listener)
    },
    onStream: (listener) => {
      stream.add(listener)
      return () => stream.delete(listener)
    },
    onEngineExit: (listener) => {
      exit.add(listener)
      return () => exit.delete(listener)
    },
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
