import { z } from "zod"

/**
 * Bounded schemas for everything the renderer reads from the host. Every engine payload is
 * parsed before use; unknown event types are rejected (counted, never rendered).
 */

const MAX_TEXT = 1024 * 1024
const MAX_PATH = 4096

const Id = z.string().min(1).max(256)
const Code = z.string().max(128)
/** Lines a file write added or removed. */
const LineCount = z.number().int().min(0).max(10_000_000)
const PathText = z.string().max(MAX_PATH)

export const ErrorSchema = z.looseObject({ code: Code.optional(), message: z.string().max(4096).optional() })

// The optional extras below drop on their own when malformed, so one bad field never turns the questions into a plain approval.
const QuestionNumber = z.number().optional().catch(undefined)

export const QuestionOptionSchema = z.looseObject({
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  recommended: z.literal(true).optional().catch(undefined),
  preview: z.string().max(8000).optional().catch(undefined),
})
export type QuestionOption = z.infer<typeof QuestionOptionSchema>

/** A question a coding tool asks the person (Claude Code's AskUserQuestion, Codex's request_user_input, an MCP form's field). */
export const QuestionSchema = z.looseObject({
  id: Id,
  question: z.string().min(1).max(1000),
  header: z.string().max(64).optional(),
  description: z.string().max(500).optional().catch(undefined),
  // Absent is a choice question; an unknown kind is asked as one.
  kind: z.enum(["text", "number"]).optional().catch(undefined),
  options: z.array(QuestionOptionSchema).max(8),
  multiSelect: z.boolean().optional(),
  other: z.boolean().optional(),
  secret: z.boolean().optional(),
  placeholder: z.string().max(200).optional().catch(undefined),
  min: QuestionNumber,
  max: QuestionNumber,
  step: z.number().positive().optional().catch(undefined),
  defaultValue: QuestionNumber,
  unit: z.string().max(16).optional().catch(undefined),
})
export type Question = z.infer<typeof QuestionSchema>
// Malformed questions leave a plain approval, never a dropped one nobody can answer.
const Questions = z.array(QuestionSchema).min(1).max(8).optional().catch(undefined)
const Answers = z.record(Id, z.array(z.string().max(2000)).max(9)).optional().catch(undefined)
const Withdrawn = z.literal(true).optional().catch(undefined)
/** The tool may be asked for more questions instead of all the answers; the person did, with an optional note. */
const TakesFollowUp = z.literal(true).optional().catch(undefined)
const FollowedUp = z.literal(true).optional().catch(undefined)
const FollowUpNote = z.string().max(2000).optional().catch(undefined)

export const SessionStatusSchema = z.enum(["idle", "running", "waiting", "completed", "failed", "stopped"])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SnapshotSchema = z.looseObject({
  id: Id,
  backend: z.string().max(128),
  cwd: PathText.optional(),
  status: SessionStatusSchema,
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  lastSeq: z.number().int().optional(),
  activeTurnId: Id.optional(),
  capabilities: z.array(z.string().max(128)).max(512).optional(),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const TOOL_KINDS = ["read", "write", "edit", "patch", "shell", "search", "list", "web", "agent", "plan", "verify", "mcp", "other"] as const
export type ToolKind = (typeof TOOL_KINDS)[number]
/** What a shell or verify call is for; the engine names it only when the call's status is that work's. */
export const COMMAND_INTENTS = ["test", "build", "lint", "typecheck", "commit", "push", "pr"] as const
export type CommandIntent = (typeof COMMAND_INTENTS)[number]

export const PlanStepSchema = z.looseObject({
  text: z.string().max(2048),
  status: z.enum(["pending", "in_progress", "completed"]).catch("pending"),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const ToolPresentationSchema = z.looseObject({
  kind: z.enum(TOOL_KINDS).catch("other"),
  title: z.string().max(1024),
  path: PathText.optional(),
  paths: z.array(PathText).max(256).optional(),
  command: z.string().max(16 * 1024).optional(),
  intent: z.enum(COMMAND_INTENTS).optional().catch(undefined),
  query: z.string().max(4096).optional(),
  url: z.string().max(MAX_PATH).optional(),
  server: z.string().max(256).optional(),
  tool: z.string().max(256).optional(),
  edits: z.array(z.looseObject({ oldText: z.string().max(128 * 1024), newText: z.string().max(128 * 1024) })).max(32).optional(),
  content: z.string().max(128 * 1024).optional(),
  plan: z.array(PlanStepSchema).max(128).optional(),
  // Lines a coding tool's file change adds and removes; a bad count is dropped, not the row.
  additions: LineCount.optional().catch(undefined),
  deletions: LineCount.optional().catch(undefined),
  truncated: z.boolean().optional(),
})
export type ToolPresentation = z.infer<typeof ToolPresentationSchema>

const EventBase = {
  sessionId: z.string().max(256).optional(),
  seq: z.number().int().min(0),
  at: z.number(),
}

const Reviewer = z.enum(["codex", "claude-code"])

/** A call the coding tool's own reviewer, rules, or mode decided without asking the person. */
const ReviewFields = {
  reviewId: Id,
  reviewer: Reviewer,
  decision: z.enum(["reviewing", "approved", "denied", "timed-out", "aborted"]),
  action: z.string().max(64),
  capability: z.string().max(256),
  risk: z.enum(["low", "medium", "high", "critical"]).optional().catch(undefined),
  source: z.enum(["reviewer", "rule", "mode"]).optional().catch(undefined),
  detail: z.string().max(1024).optional(),
  rationale: z.string().max(4096).optional(),
}
const ReviewerNoticeKind = z.enum(["unavailable", "warning"])

/** A coding tool's retry of a failed request: counts, the HTTP status, and the tool's kind of error. */
const ApiRetryFields = {
  attempt: z.number().int().min(1).max(1_000),
  maxRetries: z.number().int().min(0).max(1_000),
  delayMs: z.number().int().min(0).max(86_400_000),
  status: z.number().int().min(100).max(599).optional().catch(undefined),
  error: z.string().regex(/^[a-z_]{1,40}$/).optional().catch(undefined),
  waitedMs: z.number().int().min(0).max(86_400_000).optional().catch(undefined),
}
export type ApiRetry = { readonly attempt: number; readonly maxRetries: number; readonly delayMs: number; readonly status?: number; readonly error?: string; readonly waitedMs?: number }

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ ...EventBase, type: z.literal("session.started"), snapshot: SnapshotSchema }),
  z.looseObject({ ...EventBase, type: z.literal("session.updated"), snapshot: SnapshotSchema }),
  z.looseObject({ ...EventBase, type: z.literal("session.completed"), snapshot: SnapshotSchema }),
  z.looseObject({
    ...EventBase,
    type: z.literal("turn.started"),
    turnId: Id,
    prompt: z.string().max(MAX_TEXT),
    /** Selection used for this run. Older engines omit these fields. */
    backend: z.string().max(128).optional(),
    model: z.string().max(256).optional(),
    connectionId: z.string().max(256).optional(),
  }),
  z.looseObject({ ...EventBase, type: z.literal("assistant.delta"), turnId: Id, text: z.string().max(MAX_TEXT) }),
  z.looseObject({ ...EventBase, type: z.literal("assistant.message"), turnId: Id, text: z.string().max(MAX_TEXT) }),
  z.looseObject({
    ...EventBase,
    type: z.literal("tool.started"),
    turnId: Id,
    callId: Id,
    name: z.string().max(256),
    input: z.unknown().optional(),
    presentation: ToolPresentationSchema.optional(),
  }),
  z.looseObject({ ...EventBase, type: z.literal("tool.delta"), turnId: Id, callId: Id, text: z.string().max(MAX_TEXT) }),
  z.looseObject({
    ...EventBase,
    type: z.literal("tool.completed"),
    turnId: Id,
    callId: Id,
    name: z.string().max(256),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: ErrorSchema.optional(),
  }),
  z.looseObject({
    ...EventBase,
    type: z.literal("approval.required"),
    turnId: Id,
    approvalId: Id,
    action: z.string().max(16 * 1024),
    capability: z.string().max(256),
    reason: z.string().max(4096).optional(),
    questions: Questions,
    takesFollowUp: TakesFollowUp,
  }),
  z.looseObject({
    ...EventBase,
    type: z.literal("approval.resolved"),
    turnId: Id.optional(),
    approvalId: Id,
    approved: z.boolean(),
    reason: z.string().max(4096).optional(),
    answers: Answers,
    withdrawn: Withdrawn,
    followUp: FollowedUp,
    note: FollowUpNote,
  }),
  z.looseObject({
    ...EventBase,
    type: z.literal("repair.required"),
    turnId: Id.optional(),
    task: z.looseObject({ id: z.string().max(256).optional(), reason: z.string().max(4096).optional(), verification: z.string().max(64).optional() }),
  }),
  z.looseObject({ ...EventBase, type: z.literal("verification.completed"), name: z.string().max(256), ok: z.boolean(), report: z.unknown().optional() }),
  z.looseObject({ ...EventBase, type: z.literal("memory.compacted"), before: z.number(), after: z.number(), reason: z.string().max(64) }),
  z.looseObject({ ...EventBase, type: z.literal("extension.reloaded"), revision: z.string().max(256).optional(), rolledBack: z.boolean().optional() }),
  z.looseObject({ ...EventBase, type: z.literal("session.failed"), error: ErrorSchema, recoverable: z.boolean().optional() }),
  z.looseObject({ ...EventBase, type: z.literal("session.stopped"), reason: z.string().max(4096).optional() }),
])
export type AgentEvent = z.infer<typeof AgentEventSchema>

const LiveBase = {
  version: z.unknown().optional(),
  sessionId: z.string().max(256).optional(),
  liveSeq: z.number().int().min(0),
  at: z.number().optional(),
  afterSeq: z.number().int().optional(),
}

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/** Work an agent left running (a subagent or a shell command). The engine redacts labels before they leave it. */
export const BackgroundEntrySchema = z.object({
  id: Id,
  kind: z.enum(["agent", "command"]),
  status: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
  label: z.string().min(1).max(512),
  detail: z.string().max(2_048).optional(),
  agentType: z.string().max(128).optional(),
  callId: Id.optional(),
  foreground: z.boolean().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  exitCode: z.number().int().optional(),
  tokens: Count.optional(),
  toolUses: Count.optional(),
  durationMs: Count.optional(),
  stoppable: z.boolean(),
  stopHint: z.literal("turn").optional(),
  hasOutput: z.boolean(),
})
export type BackgroundEntry = z.infer<typeof BackgroundEntrySchema>

export const ListeningServerSchema = z.object({ port: z.number().int().min(1).max(65_535), host: z.string().max(256), process: z.string().max(256) })
export type ListeningServer = z.infer<typeof ListeningServerSchema>

export const BackgroundListSchema = z.object({
  entries: z.array(BackgroundEntrySchema).max(128),
  servers: z.array(ListeningServerSchema).max(256).optional(),
  serversAvailable: z.boolean().optional(),
  lastLiveSeq: z.number().int().optional(),
})

export const BackgroundOutputSchema = z.looseObject({ id: Id, text: z.string().max(MAX_TEXT), truncated: z.boolean().optional() })

export const BROWSER_ACTIONS = ["open", "snapshot", "screenshot", "click", "type", "press", "console", "network", "eval"] as const
export type BrowserAction = (typeof BROWSER_ACTIONS)[number]
const BrowserRequestId = z.string().regex(/^br-[0-9a-f]{32}$/)

/** What `browser.take` hands over: the parameters the engine checked, once. */
export const BrowserTaskSchema = z.looseObject({
  requestId: BrowserRequestId,
  action: z.enum(BROWSER_ACTIONS),
  params: z.record(z.string(), z.unknown()),
  expiresAt: z.number(),
  anySite: z.boolean().optional(),
})
export type BrowserTask = z.infer<typeof BrowserTaskSchema>

export const THREADS_ACTIONS = ["list", "read", "send"] as const
const ThreadsRequestId = z.string().regex(/^tr-[0-9a-f]{32}$/)

/** What `threads.take` hands over: the parameters the engine checked, once. */
export const ThreadsTaskSchema = z.looseObject({
  requestId: ThreadsRequestId,
  action: z.enum(THREADS_ACTIONS),
  params: z.record(z.string(), z.unknown()),
  expiresAt: z.number(),
})
export type ThreadsTask = z.infer<typeof ThreadsTaskSchema>

export const COMPUTER_ACTIONS = ["apps", "screenshot", "click", "type", "key", "scroll"] as const
const ComputerRequestId = z.string().regex(/^cu-[0-9a-f]{32}$/)
export const ComputerTaskSchema = z.looseObject({
  requestId: ComputerRequestId,
  action: z.enum(COMPUTER_ACTIONS),
  params: z.record(z.string(), z.unknown()),
  expiresAt: z.number(),
})
export type ComputerTask = z.infer<typeof ComputerTaskSchema>

export const LiveFrameSchema = z.discriminatedUnion("type", [
  /** The agent asked for the browser; the frame carries no parameters, and a replay finds nothing to take. */
  z.looseObject({ ...LiveBase, type: z.literal("browser.request"), requestId: BrowserRequestId, action: z.enum(BROWSER_ACTIONS) }),
  /** Browser use is on, but this Codex conversation started without the tools. */
  z.looseObject({ ...LiveBase, type: z.literal("browser.notice"), code: z.literal("BROWSER_TOOLS_UNAVAILABLE") }),
  /** The agent asked about or messaged another thread; like `browser.request`, it carries no parameters. */
  z.looseObject({ ...LiveBase, type: z.literal("threads.request"), requestId: ThreadsRequestId, action: z.enum(THREADS_ACTIONS) }),
  /** The agent asked to see or use an app on this Mac; like `browser.request`, it carries no parameters. */
  z.looseObject({ ...LiveBase, type: z.literal("computer.request"), requestId: ComputerRequestId, action: z.enum(COMPUTER_ACTIONS) }),
  z.looseObject({ ...LiveBase, type: z.literal("reasoning.delta"), turnId: Id.optional(), parentCallId: Id.optional(), itemId: Id.optional(), text: z.string().max(MAX_TEXT) }),
  z.looseObject({ ...LiveBase, type: z.literal("reasoning.completed"), turnId: Id.optional(), parentCallId: Id.optional(), itemId: Id.optional(), text: z.string().max(MAX_TEXT).optional() }),
  z.looseObject({
    ...LiveBase,
    type: z.literal("plan.updated"),
    turnId: Id.optional(),
    callId: Id.optional(),
    explanation: z.string().max(8192).optional(),
    steps: z.array(PlanStepSchema).max(128),
  }),
  z.looseObject({
    ...LiveBase,
    type: z.literal("agent.spawned"),
    turnId: Id.optional(),
    callId: Id,
    parentCallId: Id.optional(),
    title: z.string().max(1024),
    agentType: z.string().max(128).optional(),
  }),
  z.looseObject({ ...LiveBase, type: z.literal("agent.completed"), turnId: Id.optional(), callId: Id, ok: z.boolean() }),
  z.looseObject({ ...LiveBase, type: z.literal("lineage"), parentCallId: Id, callId: Id.optional(), eventSeq: z.number().int().optional() }),
  z.looseObject({ ...LiveBase, type: z.literal("background.state"), entry: BackgroundEntrySchema }),
  /** A reasoning level the model refused; the turn went out without one. */
  z.looseObject({ ...LiveBase, type: z.literal("model.notice"), turnId: Id.optional(), code: z.literal("THINKING_REFUSED"), thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) }),
  /** A coding tool's request Runrail refused without asking. Codex shows only its own fixed words, so this line is the why. */
  z.looseObject({ ...LiveBase, type: z.literal("request.refused"), turnId: Id.optional(), source: z.enum(["codex", "claude-code"]), message: z.string().min(1).max(1024) }),
  /** The shared protocol takes only its own event types, so a coding tool's reviews come as live frames; the engine records them too. */
  z.looseObject({ ...LiveBase, type: z.literal("approval.reviewed"), turnId: Id.optional(), ...ReviewFields }),
  z.looseObject({ ...LiveBase, type: z.literal("reviewer.notice"), turnId: Id.optional(), reviewer: Reviewer, notice: ReviewerNoticeKind, message: z.string().max(4096).optional() }),
  /** Claude Code waiting to retry a request; recorded by the engine like a review. */
  z.looseObject({ ...LiveBase, type: z.literal("api.retry"), turnId: Id.optional(), source: z.literal("claude-code"), ...ApiRetryFields }),
  /** Counts only: the latest request's prompt plus answer, against the model's window. */
  z.looseObject({ ...LiveBase, type: z.literal("context.usage"), turnId: Id.optional(), usedTokens: z.number().int().min(0).max(20_000_000), windowTokens: z.number().int().min(1).max(20_000_000).optional(), autoCompactAt: z.number().int().min(1).max(20_000_000).optional(), estimated: z.boolean() }),
  /** Shares of a Codex or Claude Code subscription used, per window. Account-wide, so no turn. */
  z.looseObject({
    ...LiveBase,
    type: z.literal("plan.limits"),
    source: z.enum(["codex", "claude-code"]),
    plan: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    windows: z
      .array(
        z
          .object({
            id: z.enum(["five-hour", "weekly", "weekly-opus", "weekly-sonnet", "weekly-model", "primary", "secondary"]),
            /** A `weekly-model` window's model, as the vendor's server names it, such as `Fable`. */
            model: z
              .string()
              .min(1)
              .max(40)
              .regex(/^[^\p{C}]+$/u)
              .optional(),
            usedPercent: z.number().min(0).max(100),
            resetsAt: z.number().int().positive().optional(),
            windowMinutes: z.number().int().positive().max(44_640).optional(),
          })
          .refine((window) => (window.id === "weekly-model") === (window.model !== undefined)),
      )
      .min(1)
      .max(12),
    /** Whether extra usage can serve requests past a used-up window, when the tool says. */
    extraUsage: z.boolean().optional().catch(undefined),
  }),
])
export type LiveFrame = z.infer<typeof LiveFrameSchema>
export type ReviewFrame = Extract<LiveFrame, { readonly type: "approval.reviewed" }>

/** Items from `session.conversation.read`, rebuilt by the engine from its transcript store. */
const ConversationBase = {
  id: Id,
  seq: z.number().int(),
  at: z.number(),
  turnId: Id.optional(),
  /** Selection used for this run when the engine recorded it. */
  backend: z.string().max(128).optional(),
  model: z.string().max(256).optional(),
  connectionId: z.string().max(256).optional(),
}
export const ConversationItemSchema = z.discriminatedUnion("kind", [
  z.looseObject({ ...ConversationBase, kind: z.literal("user"), text: z.string().max(MAX_TEXT), attachments: z.number().int().min(0).max(64).optional(), steer: z.boolean().optional() }),
  z.looseObject({ ...ConversationBase, kind: z.literal("assistant"), text: z.string().max(MAX_TEXT), partial: z.boolean().optional() }),
  z.looseObject({
    ...ConversationBase,
    kind: z.literal("tool"),
    callId: Id,
    name: z.string().max(256),
    presentation: ToolPresentationSchema,
    status: z.enum(["running", "ok", "failed"]),
    errorCode: Code.optional(),
    output: z.string().max(MAX_TEXT).optional(),
    additions: LineCount.optional(),
    deletions: LineCount.optional(),
    created: z.boolean().optional(),
  }),
  z.looseObject({
    ...ConversationBase,
    kind: z.literal("approval"),
    approvalId: Id,
    action: z.string().max(16 * 1024),
    capability: z.string().max(256),
    reason: z.string().max(4096).optional(),
    status: z.enum(["pending", "approved", "rejected"]),
    questions: Questions,
    answers: Answers,
    withdrawn: Withdrawn,
    denial: z.string().max(4096).optional().catch(undefined),
    takesFollowUp: TakesFollowUp,
    followUp: FollowedUp,
    note: FollowUpNote,
  }),
  z.looseObject({ ...ConversationBase, kind: z.literal("review"), ...ReviewFields }),
  z.looseObject({ ...ConversationBase, kind: z.literal("notice"), level: z.enum(["info", "error"]), code: Code, name: z.string().max(256).optional(), message: z.string().max(4096).optional(), inTool: z.literal(true).optional(), turns: z.number().int().min(1).optional(), retry: z.object(ApiRetryFields).optional().catch(undefined) }),
])
export type ConversationItem = z.infer<typeof ConversationItemSchema>

export const ConversationSchema = z.looseObject({
  sessionId: z.string().max(256).optional(),
  source: z.enum(["live", "transcript"]).optional(),
  items: z.array(z.unknown()).max(8192),
  truncated: z.boolean().optional(),
  lastSeq: z.number().int(),
})
export type Conversation = z.infer<typeof ConversationSchema>

/** `session.snapshot`: whether the engine is in a turn right now. */
export const ControlStateSchema = z.looseObject({ active: z.boolean(), historyUnavailable: z.boolean().optional().catch(undefined) })

/** `live.frames`, read for its cursor only. */
export const LiveCursorSchema = z.looseObject({ lastLiveSeq: z.number().int().min(0) })

/** Same pattern the engine enforces for a connection id. */
const ConnectionId = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/)

/**
 * A stored connection (an API key, a shell variable, or a subscription sign-in) as the engine
 * reports it. The record never carries the key itself.
 */
export const ConnectionSchema = z.looseObject({
  reference: z.looseObject({
    accountId: ConnectionId,
    provider: z.string().min(1).max(128),
    label: z.string().max(256),
    authMode: z.string().min(1).max(64),
    preset: z.string().max(128).optional(),
    environmentName: z.string().max(128).optional(),
    baseUrl: z.string().max(2_048).optional(),
  }),
  status: z.enum(["unconfigured", "ready", "expired", "refreshing", "error", "revoked"]),
  statusCode: Code.optional(),
  expiresAt: z.number().optional(),
})
export type ConnectionRecord = z.infer<typeof ConnectionSchema>

/** A connection's chosen models, the first being its default. Absent: every model it lists. */
const ChosenModels = z.array(z.string().min(1).max(256)).min(1).max(256)

/**
 * `connection.list`: each connection's settings. A provider entry adds them to an account the
 * account methods also report; a tool entry is a coding tool with the login it runs as.
 */
export const ConnectionEntrySchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("provider"), connectionId: ConnectionId, enabled: z.boolean(), models: ChosenModels.optional() }),
  z.looseObject({
    kind: z.literal("tool"),
    connectionId: ConnectionId,
    tool: z.string().min(1).max(64),
    label: z.string().min(1).max(160),
    authMode: z.enum(["subscription", "api-key"]),
    separateAccount: z.boolean().catch(false),
    enabled: z.boolean(),
    models: ChosenModels.optional(),
  }),
])
export type ConnectionEntry = z.infer<typeof ConnectionEntrySchema>

export const ConnectionDefaultSchema = z.looseObject({ connectionId: ConnectionId, model: z.string().min(1).max(256), usable: z.boolean().catch(true) })

/** How the engine asks an image model for a picture: OpenAI's images API, or a chat answer with an image. */
export const ImageRouteSchema = z.enum(["images", "chat"])

/** The image model the person picked from one of their connections. */
export const ImageChoiceSchema = z.looseObject({ connectionId: ConnectionId, model: z.string().min(1).max(256), route: ImageRouteSchema, usable: z.boolean().catch(true) })

export const ConnectionListingSchema = z.looseObject({
  connections: z.array(z.unknown()).max(4_352),
  default: ConnectionDefaultSchema.optional().catch(undefined),
  image: ImageChoiceSchema.optional().catch(undefined),
})

/**
 * `connection.status` for a coding-tool connection. It says whether the tool is installed and
 * signed in, or whether a key is stored, and never which account.
 */
export const ToolConnectionStatusSchema = z.looseObject({
  connectionId: ConnectionId,
  keyStored: z.boolean().optional(),
  installed: z.boolean().optional(),
  version: z.string().max(128).optional(),
  signedIn: z.boolean().optional(),
})

/**
 * `connection.loginCommand`: the tool's own sign-in for a terminal the person sees. Each part is
 * typed into a shell, so anything but a plain word or an absolute path is refused here.
 */
export const LoginCommandSchema = z.looseObject({
  command: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  args: z.array(z.string().regex(/^[A-Za-z0-9._=-]{1,64}$/)).max(8),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().min(1).max(4_096).regex(/^\/[^\0\n\r]*$/)).refine((env) => Object.keys(env).length <= 4),
})
export type LoginCommand = z.infer<typeof LoginCommandSchema>

/** `connection.loginRead`: what the tool's sign-in printed since `afterSeq`, for a terminal on screen. */
export const ToolLoginReadSchema = z.looseObject({
  chunks: z.array(z.looseObject({ seq: z.number().int().min(0), data: z.string().max(64 * 1024) })).max(2_048),
  nextSeq: z.number().int().min(0),
  closed: z.boolean(),
})

export const ConnectionModelSchema = z.looseObject({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  contextTokens: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  reasoning: z.boolean().optional(),
  images: z.boolean().optional(),
  /** List price in US dollars per million tokens. A malformed price is dropped, not the model. */
  pricing: z
    .object({ inputUsdPerMillionTokens: z.number().min(0).max(100_000).optional(), outputUsdPerMillionTokens: z.number().min(0).max(100_000).optional() })
    .optional()
    .catch(undefined),
  /** `live`: the endpoint listed it. `snapshot`: only the engine's bundled data knows it. */
  source: z.enum(["live", "snapshot"]).optional(),
})
export type ConnectionModel = z.infer<typeof ConnectionModelSchema>

/** An image generator a connection's own list names. */
export const ImageModelSchema = z.looseObject({ id: z.string().min(1).max(256), name: z.string().max(256).optional(), route: ImageRouteSchema })
export type ImageModel = z.infer<typeof ImageModelSchema>

/** `connection.models`: what one connection can run, and whether its endpoint answered. */
export const ConnectionModelsSchema = z.looseObject({
  connectionId: ConnectionId,
  presetId: z.string().max(128),
  models: z.array(z.unknown()).max(2_000),
  /** Absent from an engine without image tools. */
  images: z.array(z.unknown()).max(500).optional().catch(undefined),
  live: z.looseObject({ ok: z.boolean(), code: Code }),
})

/** A provider a key can be added for. Its address is fixed by the engine, never by this window. */
export const ConnectionPresetSchema = z.looseObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  protocol: z.string().max(64).optional(),
  baseUrl: z.string().max(2_048).optional(),
  /** The shell variable this provider's key is conventionally kept in. */
  environment: z.string().max(128).optional(),
  models: z.enum(["list", "none"]).optional(),
  /** True for an address a plan sign-in leads to. It takes no pasted key, so it has no key form. */
  signInOnly: z.boolean().optional(),
})
export type ConnectionPreset = z.infer<typeof ConnectionPresetSchema>

/** A kind of custom address: which request format it speaks. */
export const CustomPresetSchema = z.looseObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  protocol: z.string().max(64).optional(),
})
export type CustomPreset = z.infer<typeof CustomPresetSchema>

/** `connection.presets`. */
export const ConnectionPresetsSchema = z.looseObject({
  presets: z.array(z.unknown()).max(512),
  custom: z.array(z.unknown()).max(32),
})

/** `connection.detect`: provider keys already set in the login shell. Names only, never values. */
export const DetectedConnectionSchema = z.looseObject({
  presetId: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  environmentName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
})
export type DetectedConnection = z.infer<typeof DetectedConnectionSchema>
export const DetectedConnectionsSchema = z.looseObject({ detected: z.array(z.unknown()).max(512) })

/** A provider another coding tool is set up with. Addresses, model ids, and a variable name only. */
export const ImportableConnectionSchema = z.looseObject({
  source: z.enum(["codex", "pi", "opencode"]),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  baseUrl: z.string().regex(/^https?:\/\//).max(2_048),
  kind: z.enum(["preset", "local", "remote"]),
  presetId: z.string().min(1).max(128).optional(),
  environmentName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  environmentSet: z.boolean().optional(),
  models: z.array(z.string().min(1).max(256)).max(64).catch([]),
})
export type ImportableConnection = z.infer<typeof ImportableConnectionSchema>
export const ImportableConnectionsSchema = z.looseObject({ candidates: z.array(z.unknown()).max(64) })

/** `connection.test`: one live check of a connection. */
export const ConnectionTestSchema = z.looseObject({
  connectionId: ConnectionId,
  status: z.enum(["ok", "unverified", "failed"]),
  code: Code,
  modelCount: z.number().int().min(0).optional(),
})
export type ConnectionTest = z.infer<typeof ConnectionTestSchema>

/** `auth.flows`: one subscription sign-in the engine can run. */
export const SignInFlowSchema = z.looseObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(160),
  preset: z.string().min(1).max(128),
  kind: z.enum(["browser", "device-code"]),
  /** How the resulting connection holds its sign-in: `oauth` or `device`. */
  authMode: z.string().max(64).optional(),
  /** True when the vendor does not document this sign-in for third-party tools. */
  unofficial: z.boolean(),
  browserHosts: z.array(z.string().min(1).max(253)).max(16),
})
export type SignInFlow = z.infer<typeof SignInFlowSchema>

const LoginId = z.string().regex(/^login-[0-9a-f-]{36}$/)
const Seq = z.number().int().min(1).max(1_000_000)

/**
 * One step of a running sign-in. Unknown kinds are rejected. The page address of `open-url` is
 * dropped on purpose: the host opens it, this window never handles it.
 */
export const SignInEventSchema = z.discriminatedUnion("type", [
  z.object({ seq: Seq, type: z.literal("open-url"), redirect: z.enum(["loopback", "manual"]), notice: Code.optional() }),
  z.object({ seq: Seq, type: z.literal("device-code"), userCode: z.string().min(1).max(64), verificationUrl: z.string().max(2_048), expiresAt: z.number() }),
  z.object({ seq: Seq, type: z.literal("waiting") }),
  z.object({ seq: Seq, type: z.literal("finishing") }),
  z.object({ seq: Seq, type: z.literal("done"), accountId: ConnectionId }),
  z.object({ seq: Seq, type: z.literal("failed"), code: Code }),
])
export type SignInEvent = z.infer<typeof SignInEventSchema>

/** `auth.login.start`, `auth.login.status`, and `auth.login.cancel`. */
export const SignInSnapshotSchema = z.looseObject({
  loginId: LoginId,
  flow: z.string().max(64),
  accountId: ConnectionId,
  state: z.enum(["starting", "waiting", "finishing", "done", "failed", "cancelled"]),
  code: Code.optional(),
  acceptsInput: z.boolean(),
  events: z.array(z.unknown()).max(1_000),
  lastSeq: z.number().int().min(0).max(1_000_000),
  expiresAt: z.number(),
})
export type SignInSnapshot = z.infer<typeof SignInSnapshotSchema>

export const HarnessSchema = z.looseObject({
  id: z.string().min(1).max(128),
  name: z.string().max(256).optional(),
  version: z.string().max(128).optional(),
  kind: z.string().max(64).optional(),
  firstParty: z.boolean().optional(),
})
export type Harness = z.infer<typeof HarnessSchema>

/** Effort names a tool lists. Ones Runrail does not know are dropped later, so they never cost the model its place. */
const EffortList = z.array(z.unknown()).max(16)

/** One model a coding tool offers. The id is what the tool is started with. */
export const ToolModelSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-:/@+[\]]{0,127}$/),
  name: z.string().min(1).max(128).optional(),
  /** The effort levels this model takes, when the tool lists them per model. */
  efforts: EffortList.optional(),
  /** False when the tool says the model does not reason. */
  reasoning: z.boolean().optional(),
  /** The exact model an alias runs, as the tool reported it (`opus` -> `claude-opus-5-5`). */
  resolved: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-:/@+[\]]{0,127}$/).optional().catch(undefined),
  /** The model the tool starts on when none is named. */
  default: z.boolean().optional().catch(undefined),
  /** Not in the tool's own list: from the engine's model catalog, run by its id. The account may not have it. */
  catalog: z.boolean().optional().catch(undefined),
})

/**
 * What the engine learned by asking an installed coding tool about itself. It says whether someone
 * is signed in and never who: no account name, plan, or address is in it.
 */
export const HarnessStatusSchema = z.looseObject({
  descriptor: HarnessSchema,
  available: z.boolean(),
  version: z.string().max(128).optional(),
  signedIn: z.boolean().optional(),
  // Read one by one, so a model the app cannot use never hides the tool. Pi lists up to 256.
  models: z.array(z.unknown()).max(256).optional(),
  efforts: EffortList.optional(),
  freeTextModel: z.boolean().optional(),
  // Host and port only: the engine leaves out a path or query, which can carry a key.
  proxy: z.looseObject({ address: z.string().min(1).max(260), name: z.string().max(80).optional() }).optional(),
})
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>

export const BackendInfoSchema = z.looseObject({ name: z.string().min(1).max(128), version: z.string().max(128).optional() })

export const GitEntrySchema = z.looseObject({
  path: PathText,
  originalPath: PathText.optional(),
  index: z.string().max(32),
  worktree: z.string().max(32),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  conflicted: z.boolean(),
  sensitive: z.boolean().optional(),
})
export type GitEntry = z.infer<typeof GitEntrySchema>

export const GitStatusSchema = z.looseObject({
  branch: z.string().max(512).nullish(),
  detached: z.boolean().optional(),
  initial: z.boolean().optional(),
  head: z.string().max(128).nullish(),
  ahead: z.number().int().nullish(),
  behind: z.number().int().nullish(),
  upstream: z.string().max(512).nullish(),
  entries: z.array(GitEntrySchema).max(10_000),
  counts: z.looseObject({ staged: z.number(), unstaged: z.number(), untracked: z.number(), conflicted: z.number() }),
  truncated: z.boolean().optional(),
})
export type GitStatus = z.infer<typeof GitStatusSchema>

export const GitDiffFileSchema = z.looseObject({
  path: PathText,
  originalPath: PathText.optional(),
  change: z.string().max(32),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  truncated: z.boolean().optional(),
  patch: z.string().max(16 * 1024 * 1024).optional(),
})
export type GitDiffFile = z.infer<typeof GitDiffFileSchema>

export const GitDiffSchema = z.looseObject({
  scope: z.string().max(32).optional(),
  files: z.array(GitDiffFileSchema).max(1000),
  totals: z.looseObject({ files: z.number(), additions: z.number(), deletions: z.number() }),
  truncated: z.boolean().optional(),
})
export type GitDiff = z.infer<typeof GitDiffSchema>

export const GitCommitSchema = z.looseObject({
  commit: z.string().max(128),
  shortCommit: z.string().max(64),
  summary: z.string().max(2048),
  authorName: z.string().max(512).optional(),
  authoredAt: z.union([z.number(), z.string().max(64)]).optional(),
})
export type GitCommit = z.infer<typeof GitCommitSchema>

export const GitPushPreviewSchema = z.looseObject({
  remote: z.string().max(256),
  branch: z.string().max(512),
  localBranch: z.string().max(512).optional(),
  head: z.string().max(128),
  remoteHead: z.string().max(128).optional(),
  newBranch: z.boolean(),
  setUpstream: z.boolean().optional(),
  ahead: z.number().int(),
  commits: z.array(GitCommitSchema).max(1000),
  commitsTruncated: z.boolean().optional(),
  confirmation: z.string().regex(/^[0-9a-f]{32}$/),
})
export type GitPushPreview = z.infer<typeof GitPushPreviewSchema>

export const WorktreeSchema = z.looseObject({
  id: Id,
  path: PathText,
  cwd: PathText,
  head: z.string().max(128).optional(),
  branch: z.string().max(512).optional(),
  detached: z.boolean().optional(),
  locked: z.boolean().optional(),
  prunable: z.boolean().optional(),
})
export type Worktree = z.infer<typeof WorktreeSchema>

const BranchName = z.string().min(1).max(255)

export const GitBranchesSchema = z.looseObject({
  current: BranchName.optional(),
  local: z.array(z.looseObject({ name: BranchName, commit: z.string().max(128), updatedAt: z.number(), upstream: z.string().max(384).optional() })).max(500),
  remote: z.array(z.looseObject({ remote: z.string().min(1).max(128), name: BranchName, commit: z.string().max(128), updatedAt: z.number() })).max(500),
  truncated: z.boolean().optional(),
})
export type GitBranches = z.infer<typeof GitBranchesSchema>

export const GitFetchSchema = z.looseObject({
  remote: z.string().min(1).max(128),
  revision: z.string().min(1).max(512),
  commit: z.string().max(128),
  branch: BranchName.optional(),
  pullRequest: z.number().int().positive().optional(),
})

export const PullRequestEntrySchema = z.looseObject({
  number: z.number().int().positive(),
  url: z.string().max(2048).optional(),
  draft: z.boolean().optional(),
  title: z.string().max(256).optional(),
  head: z.string().max(256).optional(),
  base: z.string().max(256).optional(),
  author: z.string().max(64).optional(),
  updatedAt: z.number().optional(),
})
export type PullRequestEntry = z.infer<typeof PullRequestEntrySchema>

const CheckState = z.enum(["passed", "failed", "pending", "skipped"])

export const PullRequestStatusEntrySchema = PullRequestEntrySchema.extend({
  state: z.enum(["open", "closed", "merged"]).catch("open"),
  headCommit: z.string().regex(/^[0-9a-f]{40}$/).optional().catch(undefined),
  merged: z.boolean().optional(),
  mergedAt: z.number().optional(),
  closedAt: z.number().optional(),
  review: z.enum(["approved", "changes-requested", "required", "none"]).optional().catch(undefined),
  mergeable: z.enum(["yes", "conflicts", "unknown"]).optional().catch(undefined),
  checks: z
    .looseObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      items: z.array(z.looseObject({ name: z.string().max(120), state: CheckState, url: z.string().max(2048).optional() })).max(20),
    })
    .optional()
    .catch(undefined),
})
export type PullRequestStatusEntry = z.infer<typeof PullRequestStatusEntrySchema>

/** What `git.pr.checks.logs` answers: the failing checks, with the end of each Actions job's log. */
export const FailedChecksSchema = z.looseObject({
  number: z.number().int().positive(),
  headCommit: z.string().regex(/^[0-9a-f]{40}$/).optional().catch(undefined),
  failed: z.number().int().nonnegative(),
  checks: z.array(z.looseObject({ name: z.string().max(120), url: z.string().max(2048).optional(), log: z.string().max(20_000).optional(), cut: z.boolean().optional() })).max(10),
})
export type FailedChecks = z.infer<typeof FailedChecksSchema>

export const PullRequestStatusSchema = z.looseObject({
  owner: z.string().max(100),
  repo: z.string().max(100),
  remote: z.string().max(256).optional(),
  head: z.string().max(512).optional(),
  source: z.enum(["gh", "connector"]).optional().catch(undefined),
  pullRequests: z.array(PullRequestStatusEntrySchema).max(10),
})

export const PullRequestListSchema = z.looseObject({
  owner: z.string().max(100),
  repo: z.string().max(100),
  pullRequests: z.array(PullRequestEntrySchema).max(100),
})

const REVIEW_DECISION = z.enum(["approved", "changes-requested", "required", "none"]).catch("none")
const CHECKS_STATE = z.enum(["passed", "failed", "pending", "none"]).catch("none")

export const ReviewEntrySchema = z.looseObject({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  number: z.number().int().positive(),
  url: z.string().max(2048).optional(),
  title: z.string().max(256).optional(),
  author: z.string().max(64).optional(),
  updatedAt: z.number().optional(),
  draft: z.boolean().catch(false),
  review: REVIEW_DECISION,
  checks: CHECKS_STATE,
})
export type ReviewEntry = z.infer<typeof ReviewEntrySchema>

export const ReviewSearchSchema = z.looseObject({
  total: z.number().int().nonnegative(),
  pullRequests: z.array(z.unknown()).max(50).transform((items) => parseList(ReviewEntrySchema, items, 50)),
})

export const ReviewTeamsSchema = z.looseObject({
  teams: z.array(z.unknown()).max(100).transform((items) => parseList(z.looseObject({ org: z.string().min(1).max(100), slug: z.string().min(1).max(100), name: z.string().max(120).optional() }), items, 100)),
})
export type ReviewTeam = z.infer<typeof ReviewTeamsSchema>["teams"][number]

export const ReviewDetailSchema = z.looseObject({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  number: z.number().int().positive(),
  url: z.string().max(2048).optional(),
  title: z.string().max(256).optional(),
  body: z.string().max(20_000).catch(""),
  bodyTruncated: z.boolean().catch(false),
  state: z.enum(["open", "closed", "merged"]).catch("open"),
  draft: z.boolean().catch(false),
  author: z.string().max(64).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  base: z.string().max(256).optional(),
  head: z.string().max(256).optional(),
  headCommit: z.string().regex(/^[0-9a-f]{40}$/).optional().catch(undefined),
  headRepository: z.string().max(201).optional(),
  crossRepository: z.boolean().catch(false),
  mergeable: z.enum(["yes", "conflicts", "unknown"]).catch("unknown"),
  mergeState: z.string().max(32).catch("unknown"),
  review: REVIEW_DECISION,
  additions: z.number().int().nonnegative().catch(0),
  deletions: z.number().int().nonnegative().catch(0),
  changedFiles: z.number().int().nonnegative().catch(0),
  files: z
    .array(z.unknown())
    .max(100)
    .catch([])
    .transform((items) => parseList(z.looseObject({ path: z.string().min(1).max(1024), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), change: z.enum(["added", "deleted", "modified", "renamed", "copied", "changed"]).catch("changed") }), items, 100)),
  filesTruncated: z.boolean().catch(false),
  reviews: z
    .array(z.unknown())
    .max(20)
    .catch([])
    .transform((items) => parseList(z.looseObject({ author: z.string().max(64).optional(), state: z.enum(["approved", "changes-requested", "commented", "dismissed", "pending"]), submittedAt: z.number().optional() }), items, 20)),
  requested: z
    .array(z.unknown())
    .max(20)
    .catch([])
    .transform((items) => parseList(z.union([z.looseObject({ kind: z.literal("user"), login: z.string().min(1).max(64) }), z.looseObject({ kind: z.literal("team"), org: z.string().min(1).max(100), slug: z.string().min(1).max(100) })]), items, 20)),
  checks: z
    .looseObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      items: z.array(z.unknown()).max(20).catch([]).transform((items) => parseList(z.looseObject({ name: z.string().max(120), state: z.enum(["passed", "failed", "pending", "skipped"]), url: z.string().max(2048).optional() }), items, 20)),
    })
    .catch({ passed: 0, failed: 0, pending: 0, skipped: 0, items: [] }),
  checksState: CHECKS_STATE,
  mergeMethods: z.array(z.enum(["merge", "squash", "rebase"])).max(3).catch([]),
  permission: z.string().max(20).optional().catch(undefined),
})
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>

export const ReviewDiffSchema = z.looseObject({ diff: z.string(), truncated: z.boolean().catch(false), found: z.boolean().optional() })

export const GIT_SERVICES = ["github", "gitlab", "bitbucket", "unknown"] as const
export type GitService = (typeof GIT_SERVICES)[number]

export const GitRemoteSchema = z.looseObject({
  name: z.string().min(1).max(256),
  url: z.string().max(2048),
  host: z.string().max(256).optional(),
  owner: z.string().max(100).optional(),
  repo: z.string().max(100).optional(),
  path: z.string().max(2048).optional(),
  // A service this app does not know yet reads as unknown, not as a broken list.
  service: z.enum(GIT_SERVICES).optional().catch("unknown"),
  serviceFrom: z.enum(["host", "path", "name", "ci", "user"]).optional().catch(undefined),
})
export type GitRemote = z.infer<typeof GitRemoteSchema>
export const GitRemoteListSchema = z.looseObject({ remotes: z.array(GitRemoteSchema).max(256) })
/** `codehost.remotes`: a project folder's remotes and checked-out branch, read without a thread there. */
export const ProjectRemotesSchema = z.looseObject({
  git: z.boolean(),
  remotes: z.array(GitRemoteSchema).max(256).optional(),
  // An engine before the branch was added answers none of these.
  branch: z.string().max(512).optional().catch(undefined),
  detached: z.boolean().optional().catch(undefined),
  initial: z.boolean().optional().catch(undefined),
  head: z.string().max(128).optional().catch(undefined),
})

export const GitPullSchema = z.looseObject({
  remote: z.string().max(256),
  branch: z.string().max(512),
  upstream: z.string().max(512),
  pulled: z.number().int().nonnegative(),
  outcome: z.enum(["fast-forwarded", "up-to-date"]),
  status: z.unknown().optional(),
})

export const CodeHostRecordSchema = z.looseObject({
  host: z.string().min(1).max(260),
  service: z.enum(GIT_SERVICES).optional().catch(undefined),
  connection: z.looseObject({ via: z.literal("gh"), enabled: z.boolean(), addedAt: z.number() }).optional().catch(undefined),
})
export type CodeHostRecord = z.infer<typeof CodeHostRecordSchema>
export const CodeHostListSchema = z.looseObject({ hosts: z.array(CodeHostRecordSchema).max(64), problem: z.string().max(64).optional() })
export const CodeHostStatusSchema = z.looseObject({ state: z.enum(["ready", "signed-out", "missing"]), login: z.string().max(64).optional() })
export type CodeHostStatus = z.infer<typeof CodeHostStatusSchema>

export const WorktreeApplySchema = z.looseObject({
  files: z.array(PathText).max(10_000),
  conflicts: z.array(PathText).max(10_000),
  base: z.string().max(128).optional(),
})
export type WorktreeApply = z.infer<typeof WorktreeApplySchema>

/** The coding tools whose sessions the engine can import. */
export const EXTERNAL_SOURCES = ["claude-code", "codex", "pi", "opencode", "gemini", "goose", "copilot"] as const
export const ExternalSessionSchema = z.looseObject({
  source: z.enum(EXTERNAL_SOURCES),
  id: z.string().min(1).max(256),
  title: z.string().max(512).optional(),
  updatedAt: z.number(),
  messages: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  branch: z.string().max(512).optional(),
  /** The folder the tool recorded it in; listing every folder, `missing` when that folder is gone. */
  cwd: z.string().min(1).max(MAX_PATH).optional(),
  missing: z.literal(true).optional(),
})
export type ExternalSession = z.infer<typeof ExternalSessionSchema>
export const UpdateStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }),
  z.object({ state: z.literal("current"), version: z.string().min(1).max(64) }),
  z.object({
    state: z.literal("available"),
    version: z.string().min(1).max(64),
    current: z.string().min(1).max(64),
    date: z.string().max(64).optional(),
    notes: z.string().max(8_000).optional(),
  }),
])

export const ExternalSessionListSchema = z.looseObject({ sessions: z.array(ExternalSessionSchema).max(1_000), truncated: z.boolean().optional() })
/** `session.external.refresh`: the turns an imported session gained in its tool. */
export const ExternalRefreshSchema = z.looseObject({ source: z.enum(EXTERNAL_SOURCES), turns: z.number().int().min(0), imported: z.number().int().min(0) })

export const WorkspaceEntrySchema = z.looseObject({ path: PathText, type: z.enum(["file", "directory"]), bytes: z.number().optional() })
export const WorkspaceListSchema = z.looseObject({ path: z.string().max(MAX_PATH), entries: z.array(WorkspaceEntrySchema).max(4096), truncated: z.boolean().optional() })
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>
const SetupRoleSchema = z.looseObject({
  route: z.enum(["native", "claude-code", "codex", "pi", "copilot", "opencode", "gemini", "goose", "replay"]),
  model: z.string().max(200).optional(),
  connectionId: z.string().max(128).optional(),
  effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  access: z.enum(["ask", "auto-edit", "auto", "full"]).optional(),
})
export type SetupRole = z.infer<typeof SetupRoleSchema>

/** One setup from `setup.list`. */
export const SetupSchema = z.looseObject({
  id: z.string().max(64),
  name: z.string().max(80),
  description: z.string().max(500).optional(),
  source: z.enum(["user", "project"]).catch("user"),
  /** A project's setup that runs a check or with full access runs once the person trusts this version. */
  trust: z.looseObject({ digest: z.string().regex(/^[0-9a-f]{64}$/), trusted: z.boolean() }).optional().catch(undefined),
  roles: z.looseObject({ planner: SetupRoleSchema.optional(), executor: SetupRoleSchema, reviewer: SetupRoleSchema.optional() }),
  rules: z.looseObject({
    approvePlan: z.boolean(),
    reviewRounds: z.number().int().min(0).max(5),
    check: z.string().max(4_000).optional(),
    budget: z.looseObject({ maxTurns: z.number().int().positive(), maxMinutes: z.number().int().positive() }),
  }),
})
export type SetupInfo = z.infer<typeof SetupSchema>
export const SetupListSchema = z.looseObject({ setups: z.array(z.unknown()).max(128), skipped: z.number().int().catch(0) })

const SetupPlanSchema = z.looseObject({ summary: z.string().max(2_000).optional(), steps: z.array(z.looseObject({ title: z.string().max(200), detail: z.string().max(4_000).optional() })).max(20) })
export type SetupPlanInfo = z.infer<typeof SetupPlanSchema>

export const SetupRunSchema = z.looseObject({
  runId: z.string().max(80),
  setupId: z.string().max(64),
  setupName: z.string().max(80),
  task: z.string().max(20_000),
  state: z.enum(["running", "waiting", "succeeded", "failed", "stopped"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  turns: z.number().int(),
  worktree: z.string().max(64).optional(),
  checkout: z.boolean().optional(),
  plan: SetupPlanSchema.optional().catch(undefined),
  steps: z.array(
    z.looseObject({
      id: z.string().max(16),
      kind: z.enum(["plan", "approve", "step", "check", "review", "fix"]),
      title: z.string().max(240),
      status: z.enum(["running", "done", "failed", "skipped"]),
      role: z.enum(["planner", "executor", "reviewer"]).optional(),
      note: z.string().max(200).optional(),
    }),
  ).max(400),
  waiting: z
    .discriminatedUnion("kind", [
      z.looseObject({
        kind: z.literal("turn"),
        stepId: z.string().max(40),
        role: z.enum(["planner", "executor", "reviewer"]),
        thread: z.string().max(120),
        runsOn: SetupRoleSchema,
        mode: z.enum(["plan", "agent"]),
        access: z.enum(["ask", "auto-edit", "auto", "full"]),
        title: z.string().max(200),
        prompt: z.string().max(300_000),
        /** An eval's run names the worktree every role works in. */
        worktree: z.looseObject({ id: z.string().max(64), path: z.string().max(4_096), cwd: z.string().max(4_096), branch: z.string().max(256).optional() }).optional().catch(undefined),
        /** A workflow that runs in the project's checkout asks for its turns there, not in a worktree. */
        checkout: z.literal(true).optional().catch(undefined),
      }),
      z.looseObject({ kind: z.literal("approve"), stepId: z.string().max(40), plan: SetupPlanSchema }),
    ])
    .optional(),
  error: z.looseObject({ code: z.string().max(64), message: z.string().max(500) }).optional(),
  /** The workflow run whose step this is. */
  owner: z.looseObject({ kind: z.literal("workflow"), runId: z.string().max(80), name: z.string().max(80) }).optional().catch(undefined),
})
export type SetupRun = z.infer<typeof SetupRunSchema>
export const SetupRunListSchema = z.looseObject({ runs: z.array(SetupRunSchema).max(64) })

/** Evals: cases mined from a project's history, suites, and runs of setups against them. */
const Commit = z.string().regex(/^[0-9a-f]{40,64}$/)
export const EvalCaseSchema = z.looseObject({ id: z.string().max(64), base: Commit, fix: Commit, tests: z.array(z.string().max(1_024)).min(1).max(20) })
export type EvalCaseInfo = z.infer<typeof EvalCaseSchema>
export const EvalCandidatesSchema = z.looseObject({ candidates: z.array(z.unknown()).max(50) })
export const EvalVerdictSchema = z.looseObject({ id: z.string().max(64), verdict: z.enum(["valid", "passes-before", "fails-after", "error"]) })
export const EvalSuiteListSchema = z.looseObject({ suites: z.array(z.looseObject({ name: z.string().max(64), cases: z.number().int().nonnegative(), check: z.string().max(4_000) })).max(100), skipped: z.array(z.string().max(256)).max(100).catch([]) })
export const EvalSuiteSchema = z.looseObject({ name: z.string().max(64), check: z.string().max(4_000), cases: z.array(EvalCaseSchema).max(200) })
export type EvalSuiteInfo = z.infer<typeof EvalSuiteSchema>
const EvalCountsSchema = z.object({ runner: z.string().max(20), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
export const EvalRunSchema = z.looseObject({
  runId: z.string().max(80),
  suite: z.string().max(64),
  setups: z.array(z.looseObject({ id: z.string().max(64), name: z.string().max(80) })).max(4),
  cases: z.array(z.string().max(64)).max(200),
  repeats: z.number().int().positive(),
  state: z.enum(["running", "succeeded", "stopped", "failed"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  jobs: z
    .array(
      z.looseObject({
        index: z.number().int().nonnegative(),
        caseId: z.string().max(64),
        setupId: z.string().max(64),
        repeat: z.number().int().positive(),
        state: z.enum(["queued", "running", "checking", "passed", "failed", "skipped", "error"]),
        setupRunId: z.string().max(80).optional(),
        setupState: z.string().max(20).optional(),
        worktree: z.string().max(64).optional(),
        turns: z.number().int().nonnegative().optional(),
        durationMs: z.number().nonnegative().optional(),
        check: z.looseObject({ exitCode: z.number().int().optional(), timedOut: z.boolean().catch(false), counts: EvalCountsSchema.optional().catch(undefined) }).optional().catch(undefined),
        error: z.string().max(64).optional().catch(undefined),
      }),
    )
    .max(400),
  error: z.looseObject({ code: z.string().max(64), message: z.string().max(500) }).optional(),
})
export type EvalRun = z.infer<typeof EvalRunSchema>
export type EvalJob = EvalRun["jobs"][number]
export const EvalRunListSchema = z.looseObject({ runs: z.array(z.unknown()).max(500) })

/** Memory. A scope arrives by name; another project's never does. */
// Workflows ---------------------------------------------------------------------------

const ScheduleSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(10_080) }),
  z.looseObject({ kind: z.literal("daily"), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.looseObject({ kind: z.literal("weekdays"), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.looseObject({ kind: z.literal("weekly"), day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
])
export type WorkflowSchedule = z.infer<typeof ScheduleSchema>

const TriggerSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("manual") }),
  z.looseObject({ kind: z.literal("schedule"), schedule: ScheduleSchema }),
  z.looseObject({ kind: z.literal("pr-review-requested") }),
  z.looseObject({ kind: z.literal("pr-opened") }),
  z.looseObject({ kind: z.literal("webhook") }),
])
export type WorkflowTrigger = z.infer<typeof TriggerSchema>

const StepBase = { id: z.string().max(64), title: z.string().max(80) }
const WorkflowStepSchema = z.union([
  z.looseObject({ ...StepBase, kind: z.literal("agent"), prompt: z.string().max(16_000), runsOn: SetupRoleSchema }),
  z.looseObject({ ...StepBase, kind: z.literal("setup"), setupId: z.string().max(64), task: z.string().max(16_000) }),
  z.looseObject({ ...StepBase, kind: z.literal("check"), command: z.string().max(4_000), repeat: z.number().int().min(1).max(10), timeoutMinutes: z.number().int().min(1).max(120), retry: z.looseObject({ step: z.string().max(64), times: z.number().int().min(1).max(5) }).optional() }),
  z.looseObject({ ...StepBase, kind: z.literal("decision"), question: z.string().max(300), stopWhen: z.enum(["yes", "no"]) }),
  z.looseObject({ ...StepBase, kind: z.literal("approval"), detail: z.string().max(500).optional() }),
  z.looseObject({ ...StepBase, kind: z.literal("action"), action: z.literal("open-pr"), draft: z.boolean() }),
  z.looseObject({ ...StepBase, kind: z.literal("action"), action: z.literal("notify"), text: z.string().max(500) }),
  z.looseObject({ ...StepBase, kind: z.literal("action"), action: z.literal("slack"), channel: z.string().max(80), text: z.string().max(4_000) }),
])
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

const RunState = z.enum(["running", "waiting", "succeeded", "failed", "stopped"])

const WorkflowRunRecordSchema = z.looseObject({
  runId: z.string().max(80),
  trigger: z.enum(["manual", "schedule", "pr-review-requested", "pr-opened", "webhook"]).catch("manual"),
  pr: z.number().int().optional().catch(undefined),
  state: RunState,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  steps: z.array(z.looseObject({ id: z.string().max(64), status: z.string().max(16), note: z.string().max(200).optional() })).max(40),
  error: z.string().max(64).optional(),
})
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>

/** One workflow from `workflow.list`, with the store's fields beside it. */
export const WorkflowSchema = z.looseObject({
  id: z.string().max(64),
  name: z.string().max(80),
  description: z.string().max(500).optional(),
  state: z.enum(["proposed", "on", "off"]),
  trigger: TriggerSchema,
  where: z.enum(["worktree", "checkout"]),
  steps: z.array(WorkflowStepSchema).min(1).max(20),
  budget: z.looseObject({ maxMinutes: z.number().int().positive() }),
  proposedBy: z.looseObject({ thread: z.string().max(120) }).optional().catch(undefined),
  root: z.string().max(4_096),
  createdAt: z.number(),
  updatedAt: z.number(),
  enabledAt: z.number().optional(),
  /** The runs that still read; one that does not is left out, not the workflow. */
  runs: z
    .array(z.unknown())
    .max(20)
    .catch([])
    .transform((items) => parseList(WorkflowRunRecordSchema, items, 20)),
})
export type WorkflowInfo = z.infer<typeof WorkflowSchema>
export const WorkflowListSchema = z.looseObject({ workflows: z.array(z.unknown()).max(256) })

export function parseWorkflowInfo(value: unknown): WorkflowInfo | undefined {
  const parsed = WorkflowSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const PullRequestRefSchema = z.looseObject({ number: z.number().int().positive(), title: z.string().max(200).optional(), url: z.string().max(500).optional() })
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>

export const WorkflowRunSchema = z.looseObject({
  runId: z.string().max(80),
  workflowId: z.string().max(64),
  workflowName: z.string().max(80),
  trigger: z.enum(["manual", "schedule", "pr-review-requested", "pr-opened", "webhook"]).catch("manual"),
  pr: PullRequestRefSchema.optional().catch(undefined),
  state: RunState,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  worktree: z.string().max(64).optional(),
  steps: z.array(
    z.looseObject({
      id: z.string().max(64),
      kind: z.enum(["agent", "setup", "check", "decision", "approval", "action"]),
      title: z.string().max(80),
      status: z.enum(["pending", "running", "done", "failed", "skipped"]),
      note: z.string().max(200).optional(),
      setupRuns: z.array(z.string().max(80)).max(20).catch([]),
    }),
  ).max(20),
  waiting: z
    .discriminatedUnion("kind", [
      z.looseObject({ kind: z.literal("approve"), stepId: z.string().max(64), title: z.string().max(80), detail: z.string().max(500).optional() }),
      z.looseObject({ kind: z.literal("slack"), stepId: z.string().max(64), title: z.string().max(80), channel: z.string().max(80), text: z.string().max(8_000) }),
    ])
    .optional()
    .catch(undefined),
  notices: z.array(z.looseObject({ stepId: z.string().max(64), text: z.string().max(1_000) })).max(40).catch([]),
  openedPr: z.looseObject({ number: z.number().int(), url: z.string().max(500).optional() }).optional().catch(undefined),
  error: z.looseObject({ code: z.string().max(64), message: z.string().max(500) }).optional(),
})
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>
export const WorkflowRunListSchema = z.looseObject({ runs: z.array(z.unknown()).max(64) })
/** `workflow.upcoming`: workflows that start by themselves, and the next scheduled start. */
export const WorkflowUpcomingSchema = z.looseObject({
  armed: z.number().int().min(0),
  next: z.looseObject({ workflowId: z.string().max(64), name: z.string().max(80), root: z.string().max(4_096), at: z.number() }).optional().catch(undefined),
})
export type WorkflowUpcoming = z.infer<typeof WorkflowUpcomingSchema>

export const WorkflowDueSchema = z.looseObject({
  due: z.array(z.looseObject({ workflowId: z.string().max(64), name: z.string().max(80), root: z.string().max(4_096), trigger: z.enum(["schedule", "pr-review-requested", "pr-opened", "manual"]), pr: PullRequestRefSchema.optional().catch(undefined) })).max(64),
})

export const MemorySchema = z.looseObject({
  id: z.string().max(80),
  scope: z.enum(["project", "person", "external", "other"]).catch("other"),
  text: z.string().max(4_000),
  source: z.looseObject({ kind: z.enum(["manual", "suggested", "folder", "github", "feed"]).catch("manual"), id: z.string().max(80).optional(), ref: z.string().max(1_024).optional() }).catch({ kind: "manual" }),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type MemoryInfo = z.infer<typeof MemorySchema>
export const MemoryListSchema = z.looseObject({ memories: z.array(z.unknown()).max(500) })
export const MemoryStatusSchema = z.looseObject({
  provider: z.looseObject({ kind: z.enum(["local", "mcp"]), name: z.string().max(80).optional() }),
  health: z.looseObject({ ok: z.boolean(), detail: z.string().max(500).optional() }),
  counts: z.looseObject({ project: z.number().int().nonnegative(), person: z.number().int().nonnegative() }),
})
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>
export const MemorySourceSchema = z.looseObject({
  id: z.string().max(80),
  kind: z.enum(["folder", "github", "feed"]),
  scope: z.enum(["project", "person", "external", "other"]).catch("other"),
  name: z.string().max(80),
  target: z.string().max(4_096),
  addedAt: z.number(),
  entries: z.number().int().nonnegative().catch(0),
  lastSync: z.looseObject({ at: z.number(), ok: z.boolean(), error: z.string().max(500).optional(), added: z.number().int(), removed: z.number().int(), kept: z.number().int() }).optional().catch(undefined),
})
export type MemorySourceInfo = z.infer<typeof MemorySourceSchema>
export const MemorySourceListSchema = z.looseObject({ sources: z.array(z.unknown()).max(50) })
export const MemorySettingsSchema = z.looseObject({
  provider: z.union([z.literal("local"), z.looseObject({ kind: z.literal("mcp"), name: z.string().max(80), command: z.string().max(1_024).optional(), args: z.array(z.string().max(4_096)).max(64).optional(), inherit: z.array(z.string().max(128)).max(32).optional(), url: z.string().max(4_096).optional(), mapping: z.unknown() })]),
})
export type MemorySettings = z.infer<typeof MemorySettingsSchema>

/** `check.run`: one check of a worktree. */
export const CheckResultSchema = z.looseObject({
  id: z.string().max(64),
  exitCode: z.number().int().optional(),
  passed: z.boolean(),
  timedOut: z.boolean().catch(false),
  stopped: z.boolean().catch(false),
  durationMs: z.number().nonnegative(),
  tail: z.string().max(256 * 1024).catch(""),
  truncated: z.boolean().catch(false),
  counts: z
    .object({ runner: z.string().max(20), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .optional()
    .catch(undefined),
})
export type CheckResult = z.infer<typeof CheckResultSchema>

const TextHash = z.string().regex(/^[0-9a-f]{64}$/)
export const WorkspaceReadSchema = z.looseObject({ path: PathText, bytes: z.number().optional(), content: z.string().max(16 * 1024 * 1024), truncated: z.boolean().optional(), hash: TextHash.optional() })
/** What `workspace.write` answers: the saved text's hash, the base for the next save. */
export const WorkspaceWriteSchema = z.looseObject({ path: PathText, bytes: z.number(), hash: TextHash })

export const CAPABILITY_STATES = ["available", "configurable", "unavailable"] as const
export type CapabilityState = (typeof CAPABILITY_STATES)[number]

function capabilityState(value: unknown): CapabilityState {
  const status = typeof value === "object" && value !== null && "status" in value ? (value as { status?: unknown }).status : value
  if (status === true || status === "available") return "available"
  return status === "configurable" ? "configurable" : "unavailable"
}

/**
 * The handshake contract. The engine sends capability names as a list plus a `capabilityStatus`
 * map; both (and the older name-to-status record) are normalized to one name-to-state record.
 */
export const ContractSchema = z
  .looseObject({
    protocol: z.number().optional(),
    apiVersion: z.string().max(32).optional(),
    runrailVersion: z.string().max(64).optional(),
    capabilities: z.union([z.array(z.string().max(128)).max(512), z.record(z.string().max(128), z.unknown())]).optional(),
    capabilityStatus: z.record(z.string().max(128), z.unknown()).optional(),
  })
  .transform(({ capabilities, capabilityStatus, ...rest }) => {
    const states: Record<string, CapabilityState> = {}
    if (Array.isArray(capabilities)) for (const name of capabilities) states[name] = "available"
    else for (const [name, value] of Object.entries(capabilities ?? {})) states[name] = capabilityState(value)
    for (const [name, value] of Object.entries(capabilityStatus ?? {})) states[name] = capabilityState(value)
    return { ...rest, capabilities: states }
  })
export type Contract = z.infer<typeof ContractSchema>

/** Returns whether a contract capability is available. Unknown capabilities are unavailable. */
export function hasCapability(contract: Contract | undefined, name: string): boolean {
  return contract?.capabilities[name] === "available"
}

export function parseOr<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

export const SkillSchema = z.looseObject({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  scope: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
})
export type Skill = z.infer<typeof SkillSchema>

export const AgentInfoSchema = z.looseObject({
  id: z.string().min(1).max(256),
  role: z.string().max(128).optional(),
  description: z.string().max(2048).optional(),
  capabilities: z.array(z.string().max(64)).max(64).optional(),
})
export type AgentInfo = z.infer<typeof AgentInfoSchema>

export const PluginEntrySchema = z.looseObject({
  manifest: z.looseObject({
    id: z.string().min(1).max(256),
    version: z.string().max(64).optional(),
    mode: z.string().max(64).optional(),
    description: z.string().max(2048).optional(),
    capabilities: z.array(z.string().max(128)).max(128).optional(),
    contributes: z.array(z.string().max(64)).max(64).optional(),
  }),
  enabled: z.boolean().optional(),
  previousVersion: z.string().max(64).optional(),
})
export type PluginEntry = z.infer<typeof PluginEntrySchema>

export const PackageEntrySchema = z.looseObject({
  manifest: z.looseObject({
    id: z.string().min(1).max(256),
    version: z.string().max(64).optional(),
    displayName: z.string().max(256).optional(),
    packageType: z.string().max(64).optional(),
    description: z.string().max(2048).optional(),
    publisher: z.string().max(256).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
  }),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
})
export type PackageEntry = z.infer<typeof PackageEntrySchema>

export const MetricsSchema = z.looseObject({
  modelCalls: z.number().optional(),
  cacheHits: z.number().optional(),
  cacheMisses: z.number().optional(),
  runs: z.number().optional(),
  successfulRuns: z.number().optional(),
  repairs: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
  toolCalls: z.number().optional(),
  elapsedMs: z.number().optional(),
})
export type Metrics = z.infer<typeof MetricsSchema>

/** Parses a list response, dropping malformed entries instead of failing the whole list. */
export function parseList<T>(schema: z.ZodType<T>, value: unknown, max = 1_000): T[] {
  const items = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : []
  const out: T[] = []
  for (const item of items.slice(0, max)) {
    const parsed = schema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}
