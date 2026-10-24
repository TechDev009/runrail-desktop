import { z } from "zod"
import { CONNECTION_ID, EDITOR_IDS, toHostError, type BackendId, type EditorId, type Thinking } from "../host/types"
import { DEFAULT_TONE_VOLUME } from "../lib/tones"
import type { ConnectedTo } from "./gitHosts"
import { MAX_PANES } from "./split"
import { EXTERNAL_SOURCES } from "../protocol/schemas"

/**
 * Desktop state persisted by the host (app data, atomic writes). It holds projects, thread
 * metadata, preferences, and layout. It never holds transcripts, tool payloads, drafts, queued
 * prompts, or credentials; conversation history lives in the engine's store.
 */

export type PermissionPreset = "ask" | "auto-edit" | "auto" | "full"
export type ThreadMode = "agent" | "plan" | "goal"
export type Theme = "system" | "dark" | "light"
/** `mono` is the default: white on black, color kept for status. `theme` is the palette's own. */
export const ACCENTS = ["mono", "theme", "blue", "violet", "orange", "green", "teal", "rose", "amber", "indigo", "cyan"] as const
export type Accent = (typeof ACCENTS)[number]
/** `default` is the neutral black cockpit; the others are Japanese flower palettes, each with a light and a dark side. */
export const PALETTES = ["default", "sakura", "ume", "fuji", "ajisai", "tsubaki", "matcha"] as const
export type Palette = (typeof PALETTES)[number]

/** A flower palette picked while the accent is mono brings its own accent, once; a chosen accent stays. */
export function paletteChange(prefs: Pick<Prefs, "accent">, palette: Palette): Partial<Prefs> {
  return { palette, ...(palette !== "default" && prefs.accent === "mono" ? { accent: "theme" as const } : {}) }
}

/** The window is transparent with the sidebar material behind it only in the macOS app. */
export function glassAvailable(platform: string | undefined): boolean {
  return platform === "macos"
}
export const PANEL_KINDS = ["review", "files", "tasks", "terminal", "browser", "simulator", "android"] as const
export type PanelKind = (typeof PANEL_KINDS)[number]

/** One tab in a thread's side panel. A browser tab keeps the page's origin and path only. */
export interface PanelTab {
  readonly id: string
  readonly kind: PanelKind
  readonly url?: string
}

export interface PanelState {
  readonly tabs: readonly PanelTab[]
  readonly active?: string
}

/** How many of each a thread's panel holds, and how many threads' panels are kept. */
export const PANEL_LIMITS = { tabs: 12, terminal: 6, browser: 4, threads: 200 } as const
export const SINGLE_PANELS: ReadonlySet<PanelKind> = new Set(["review", "files", "tasks", "simulator", "android"])
export type ThreadStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "stopped"
/** Turns whose model a thread remembers for its rows; older turns show the thread's own. */
export const MAX_THREAD_RUNS = 64
/** What earlier builds kept per thread, read so their newest runs survive the lower bound. */
const MAX_SAVED_RUNS = 2_048

export interface Project {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly git: boolean
  readonly addedAt: number
  /** Skills turned off for this project; every engine of the project starts with them off. */
  readonly disabledSkills?: readonly string[]
  /** What the folder's git remote is, as last read; shown by the project's name. */
  readonly connectedTo?: ConnectedTo
  /** The check command last used for Best of N here, offered next time. */
  readonly checkCommand?: string
  /**
   * Related folders: absolute paths the agent may read and edit beside the
   * project's own folder. Every thread still runs in the project's folder.
   */
  readonly folders?: readonly string[]
  /**
   * The project's browser previews keep their sign-ins: cookies are saved,
   * sealed, by the host, and handed to the next preview. Off unless the person turns it on.
   */
  readonly browserSignIns?: true
  /**
   * The machine the project lives on, by its id in the host's list, with its
   * host for display; `path` is then a path on that machine.
   */
  readonly remote?: ProjectRemote
}

export interface ProjectRemote {
  readonly id: string
  readonly host: string
}

/** The engine takes at most eight related folders. */
export const MAX_PROJECT_FOLDERS = 8

/** Skills a project may turn off (the engine takes at most 128), and the ids it accepts. */
export const MAX_DISABLED_SKILLS = 128
export const SKILL_ID = /^[a-z][a-z0-9._:-]{0,127}$/i

/** Where a worktree started, when it was not the project's own HEAD. */
export type WorktreeBase = { readonly kind: "branch"; readonly name: string } | { readonly kind: "pr"; readonly number: number; readonly title?: string }

export interface ThreadWorktree {
  readonly id: string
  readonly path: string
  readonly cwd: string
  readonly branch?: string
  readonly base?: WorktreeBase
}

export interface ThreadMeta {
  readonly id: string
  readonly projectId: string
  readonly title: string
  /** True once the title came from the user or the first prompt; false shows a placeholder. */
  readonly titled: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly backend: BackendId
  /** A connected model, or the model a coding tool is started with. */
  readonly model?: string
  /**
   * Connection `model` is reached through; a Runrail thread needs both to start. On a coding tool,
   * the tool connection it runs as; a thread from before those has none and uses the tool's own login.
   */
  readonly connectionId?: string
  /** Selection used by each completed or started turn, kept so old rows survive a model switch. */
  readonly runHistory?: readonly ThreadRun[]
  readonly thinking?: Thinking
  readonly mode: ThreadMode
  readonly permission: PermissionPreset
  readonly worktree?: ThreadWorktree
  readonly archived?: boolean
  /** When it was last archived; one archived before this was kept goes by `updatedAt`. */
  readonly archivedAt?: number
  readonly pinned?: boolean
  readonly lastStatus?: ThreadStatus
  readonly unread?: boolean
  /**
   * Best-of-N group: threads with the same group id compare against each other. `appliedAt` is
   * when this run's changes were applied to the project. `check` is the command each run is checked
   * with, and `autoCheck` runs it when a run finishes.
   */
  readonly group?: { readonly id: string; readonly label: string; readonly appliedAt?: number; readonly check?: string; readonly autoCheck?: boolean }
  readonly parentThreadId?: string
  /** A review of a pull request (Reviews): which one, and the head commit it read. */
  readonly review?: ThreadReview
  /** A review of another thread's changes: its findings go to that thread's Review pane. */
  readonly reviewOf?: string
  /** A role's thread in a setup run. */
  readonly setup?: { readonly runId: string; readonly role: "planner" | "executor" | "reviewer" }
  /** The other tool's session this thread continues, so the import list can link back to it. */
  readonly importedFrom?: { readonly source: (typeof EXTERNAL_SOURCES)[number]; readonly id: string }
  /** The person lets the agent use this thread's browser preview. Absent means off. */
  readonly browser?: { readonly agent: true; readonly anySite?: true }
  /** The person lets the agent use the apps they allowed on this Mac. Absent means off. */
  readonly computer?: true
  /** Goes on at `at` after a usage limit: with "Continue", or its last message `again`. */
  readonly resume?: { readonly at: number; readonly again: boolean }
  /**
   * The person asked this thread's agent to fix each CI failure on pull request `number`.
   * `heads` are the commits it was already asked about; `rounds` counts the fixes since
   * the checks last passed. No log or message is stored.
   */
  readonly ciWatch?: { readonly number: number; readonly heads: readonly string[]; readonly rounds: number }
  /**
   * Pull requests this thread has seen for its branch. `card` puts one in the timeline after turn
   * `turnId`, or at `at` when that turn is not loaded; PRs that existed at the first read are kept
   * with `card: false`. No PR content is stored.
   */
  readonly pullRequests?: readonly ThreadPullRequest[]
}

export interface ThreadRun {
  readonly turnId: string
  readonly backend: BackendId
  readonly model?: string
  readonly connectionId?: string
}

export interface ThreadReview {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly headCommit?: string
}

export interface ThreadPullRequest {
  readonly number: number
  readonly url?: string
  readonly turnId?: string
  readonly at: number
  readonly card: boolean
}

export const MAX_THREAD_PULL_REQUESTS = 20

/** A model picked before: ids only, never a key. */
export interface RecentModel {
  readonly model: string
  readonly connectionId: string
}

export interface Prefs {
  readonly theme: Theme
  readonly palette: Palette
  readonly accent: Accent
  /** macOS: the sidebar shows the system's translucent material. */
  readonly sidebarGlass: boolean
  /** Commits and pushes from the Review pane run the repository's own git hooks, as `git` does. */
  readonly gitHooks: boolean
  readonly editor: EditorId
  readonly sendKey: "enter" | "mod-enter"
  /** A turn's reasoning: left out, a line that opens, or open while it streams. */
  readonly reasoning: ReasoningDisplay
  /** Mode a new thread starts in. */
  readonly defaultMode: "agent" | "plan"
  /** What Return does while the agent works: queue the message for after the turn, or steer the turn with it. */
  readonly followUp: "queue" | "steer"
  readonly defaultBackend: BackendId
  readonly defaultPermission: PermissionPreset
  readonly defaultModel?: string
  /** Connection `defaultModel` is reached through. */
  readonly defaultConnectionId?: string
  /** Model a new thread starts on when `defaultBackend` is a coding tool that takes one. */
  readonly defaultToolModel?: string
  /** The coding-tool connection a new thread on `defaultBackend` runs as. */
  readonly defaultToolConnectionId?: string
  /** Models picked lately, newest first, for the top of the model menu. */
  readonly recentModels: readonly RecentModel[]
  readonly defaultThinking: Thinking
  readonly density: "comfortable" | "compact"
  readonly showThreadTimestamps: boolean
  /** One step smaller or larger than the default type, for the whole window. */
  readonly textSize: "small" | "default" | "large"
  readonly diffView: "unified" | "split"
  readonly notifications: boolean
  readonly developer: boolean
  readonly worktreeByDefault: boolean
  /** Which other threads an agent may read and message: none, its project's, or any. */
  readonly threadMessages: "off" | "project" | "all"
  /** After a usage limit, wait for the reset and continue without being asked. */
  readonly continueAfterLimit: boolean
  /** Reading Claude Code's and Codex's plan limits starts them as the person, so only after a yes; "ask" is not asked yet and reads nothing. */
  readonly planLimits: "ask" | "on" | "off"
  /** Claude Code's first message asks to download the Claude Agent SDK until the person says to go on without it. */
  readonly claudeSdk: "ask" | "without"
  /** The first-run walkthrough was finished or skipped. */
  readonly onboarded: boolean
  readonly checkUpdates: boolean
  /** The context ring always shows, or shows only once the context is nearly full. */
  readonly contextDisplay: "used" | "near-full"
  /** Starred models, shown first in the model menu. Ids only. */
  readonly favoriteModels: readonly RecentModel[]
  /** Instructions every thread starts with, before the project's own AGENTS.md. */
  readonly instructions?: string
  /** Hold off idle sleep while any thread is running a turn. */
  readonly keepAwake: boolean
  /** Told once that a closed window leaves Runrail in the menu bar. */
  readonly toldMenuBar: boolean
  /** With `keepAwake`, the display stays on too. */
  readonly keepDisplayAwake: boolean
  /** Quitting while a turn runs asks first. */
  readonly confirmQuit: boolean
  /** A short sound when a thread you are not looking at finishes or needs you. */
  readonly sounds: boolean
  /** How loud those sounds are, from 0 to 1. */
  readonly volume: number
  /** macOS notifications: never, only while Runrail is not in front, or always. */
  readonly systemNotifications: "off" | "background" | "always"
  /** Which events notify, in the window and from macOS. */
  readonly notifyOn: NotifyOn
  /** Minutes a running turn may send nothing before it shows as quiet in the tray; 0 never does. */
  readonly quietMinutes: QuietMinutes
  /** Office mode: off, or on and opening on the office floor or on the thread list. */
  readonly officeMode: "off" | "office" | "list"
  /** Learn mode; while unset it follows office mode: Standard while that is on, off otherwise. */
  readonly learn?: LearnLevel
  /** XP, levels, and quests; while unset it follows office mode. */
  readonly game?: boolean
  /** Nifra's tools, instructions, and check in Nifra projects (the README's Nifra in Runrail); on while unset. */
  readonly nifra?: boolean
  /** Animations follow the system's setting, or are always reduced. */
  readonly motion: "system" | "reduce"
  readonly voice: VoicePrefs
  readonly uiFont: UiFont
  readonly codeFont: CodeFont
  /** Where a file named in an answer opens: Runrail's Files pane, or the person's editor. */
  readonly fileLinks: "app" | "editor"
  /** A paste longer than this many characters becomes one line in the composer; 0 never folds. */
  readonly pasteThreshold: PasteThreshold
  /** The login shell new terminals run; unset means the person's own shell. */
  readonly terminalShell?: string
  /** Memory: add recalled memories to messages, and offer to keep some after a thread. */
  readonly memory: MemoryPrefs
  /** Who may use what: the person's changes to each role's default, per connector id or `mcp:<server>`. */
  readonly integrationGrants: IntegrationGrants
}

export type IntegrationGrant = "off" | "read" | "ask" | "write"
export type GrantRole = "threads" | "planner" | "executor" | "reviewer"
export type IntegrationGrants = Readonly<Partial<Record<GrantRole, Readonly<Record<string, IntegrationGrant>>>>>

export interface MemoryPrefs {
  readonly recall: boolean
  readonly suggest: boolean
}

export const DEFAULT_MEMORY_PREFS: MemoryPrefs = { recall: true, suggest: true }

export type ReasoningDisplay = "hidden" | "folded" | "open"

export interface NotifyOn {
  readonly finished: boolean
  readonly failed: boolean
  readonly approvals: boolean
}

export const DEFAULT_NOTIFY_ON: NotifyOn = { finished: true, failed: true, approvals: true }

export interface VoicePrefs {
  /** The microphone button in the composer, and its shortcut. */
  readonly dictation: boolean
  /** Apple's recognizer, or Whisper on this Mac. */
  readonly engine: "apple" | "whisper"
  /** Apple's recognizer must not send audio to Apple. */
  readonly onDevice: boolean
  /** A microphone id from the host; unset uses the system's input. */
  readonly device?: string
  /** The Whisper model to use. */
  readonly model?: string
  /** Names and terms the recognizer should expect. */
  readonly words: readonly string[]
  /** A BCP 47 tag; unset follows the system's language. */
  readonly language?: string
  /** Dictation sends the message once you stop talking. */
  readonly autoSend: boolean
  /** Soft tones when listening starts and stops. */
  readonly sounds: boolean
  /** Finished answers in the open thread are read out. */
  readonly readAloud: boolean
  /** A system voice's identifier; unset uses the system's default voice for the language. */
  readonly voiceId?: string
  readonly rate: number
}

export const DEFAULT_VOICE: VoicePrefs = { dictation: true, engine: "apple", onDevice: false, words: [], autoSend: false, sounds: true, readAloud: false, rate: 1 }
export const MAX_VOICE_WORDS = 100
export const MAX_VOICE_WORD = 64
export const VOICE_RATES = [0.8, 1, 1.25, 1.5, 1.75, 2] as const
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/

export const UI_FONTS = ["system", "rounded"] as const
export type UiFont = (typeof UI_FONTS)[number]
export const CODE_FONTS = ["sf-mono", "menlo", "monaco"] as const
export type CodeFont = (typeof CODE_FONTS)[number]
export const PASTE_THRESHOLDS = [0, 2_000, 5_000, 10_000] as const
export type PasteThreshold = (typeof PASTE_THRESHOLDS)[number]
export const QUIET_MINUTES = [0, 2, 5, 10, 15, 30] as const
export type QuietMinutes = (typeof QUIET_MINUTES)[number]

export const LEARN_LEVELS = ["off", "brief", "standard", "deep"] as const
export type LearnLevel = (typeof LEARN_LEVELS)[number]

export interface LessonRead {
  readonly id: string
  readonly level: Exclude<LearnLevel, "off">
  readonly at: number
}

/** Learn mode's history, kept on this machine only. */
export interface Learning {
  /** `level:id` of each lesson already shown long enough at that level; it is not offered there again. */
  readonly seen: readonly string[]
  /** Each lesson read once per level, oldest first. */
  readonly read: readonly LessonRead[]
}

export const EMPTY_LEARNING: Learning = { seen: [], read: [] }
export const MAX_LESSONS_SEEN = 256
export const MAX_LESSONS_READ = 512

/** What the game layer counts: outcomes the app can confirm, never volume. */
export const GAME_EVENTS = ["request-answered", "diff-reviewed", "commit", "push", "pr-opened", "lesson-read", "quiet-rescued", "tests-fixed"] as const
export type GameEvent = (typeof GAME_EVENTS)[number]

/** One local day of play. */
export interface GameDay {
  readonly xp: number
  readonly counts: Readonly<Partial<Record<GameEvent, number>>>
  /** How long each answered request waited, in ms, for the shift report's median. */
  readonly answerMs: readonly number[]
  /** Keys of the quests finished that day. */
  readonly quests: readonly string[]
}

/** A quest's count in its current period: a day, an ISO week, or its season. */
export interface QuestProgress {
  readonly period: string
  readonly count: number
  readonly done: boolean
}

/** What the person decided about a project's quest file, by its content hash. */
export interface SeasonChoice {
  readonly season: string
  readonly hash: string
  readonly accepted: boolean
  /** The file as accepted, so its quests count before it is read again. */
  readonly text?: string
}

/** The game layer's ledger, kept on this machine only. */
export interface Game {
  readonly xp: number
  /** By local date, `YYYY-MM-DD`, the last 30 days. */
  readonly days: Readonly<Record<string, GameDay>>
  /** By quest key. */
  readonly progress: Readonly<Record<string, QuestProgress>>
  /** By project id. */
  readonly seasons: Readonly<Record<string, SeasonChoice>>
}

export const EMPTY_GAME: Game = { xp: 0, days: {}, progress: {}, seasons: {} }
export const MAX_GAME_DAYS = 30
export const MAX_ANSWER_TIMES = 200
/** A wait longer than this is recorded as this long. */
export const MAX_ANSWER_MS = 30 * 86_400_000
export const MAX_QUEST_PROGRESS = 512
export const MAX_SEASONS = 32
export const MAX_QUEST_FILE_BYTES = 32 * 1024
export const MAX_XP = 10_000_000

/** How the sidebar lists threads: under their projects, or all together by time. */
export interface SidebarView {
  readonly organize: "project" | "chronological"
  readonly threadSort: "updated" | "created"
  /** By project only: projects stay in the order added unless sorted by name or latest activity. */
  readonly projectSort: "added" | "name" | "activity"
  readonly showArchived: boolean
}

export const DEFAULT_SIDEBAR_VIEW: SidebarView = { organize: "project", threadSort: "updated", projectSort: "added", showArchived: false }

export interface Layout {
  /** The focused thread; with `panes`, the focused pane. */
  readonly activeThreadId?: string
  /** Threads shown side by side, two to four; absent when one thread fills the view. */
  readonly panes?: readonly string[]
  readonly activeProjectId?: string
  readonly collapsedProjects: readonly string[]
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly sidebarView: SidebarView
  readonly inspectorOpen: boolean
  readonly inspectorWidth: number
  /** Each thread's side-panel tabs, by thread id. */
  readonly panels: Readonly<Record<string, PanelState>>
}

export interface DesktopState {
  readonly version: 1
  readonly projects: readonly Project[]
  readonly threads: readonly ThreadMeta[]
  readonly prefs: Prefs
  readonly layout: Layout
  readonly learning: Learning
  readonly game: Game
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  palette: "default",
  accent: "mono",
  sidebarGlass: true,
  gitHooks: true,
  editor: "vscode",
  sendKey: "enter",
  reasoning: "folded",
  defaultMode: "agent",
  followUp: "queue",
  defaultBackend: "native",
  defaultPermission: "auto",
  recentModels: [],
  defaultThinking: "medium",
  density: "comfortable",
  showThreadTimestamps: false,
  textSize: "default",
  diffView: "unified",
  notifications: true,
  developer: false,
  worktreeByDefault: false,
  threadMessages: "project",
  continueAfterLimit: false,
  planLimits: "ask",
  claudeSdk: "ask",
  onboarded: false,
  checkUpdates: true,
  contextDisplay: "used",
  favoriteModels: [],
  keepAwake: false,
  toldMenuBar: false,
  keepDisplayAwake: false,
  confirmQuit: true,
  sounds: false,
  volume: DEFAULT_TONE_VOLUME,
  systemNotifications: "background",
  notifyOn: DEFAULT_NOTIFY_ON,
  quietMinutes: 5,
  officeMode: "off",
  motion: "system",
  voice: DEFAULT_VOICE,
  uiFont: "system",
  codeFont: "sf-mono",
  fileLinks: "app",
  pasteThreshold: 5_000,
  memory: DEFAULT_MEMORY_PREFS,
  integrationGrants: {},
}

export const DEFAULT_LAYOUT: Layout = {
  collapsedProjects: [],
  sidebarOpen: true,
  sidebarWidth: 272,
  sidebarView: DEFAULT_SIDEBAR_VIEW,
  inspectorOpen: false,
  inspectorWidth: 520,
  panels: {},
}

export function defaultState(): DesktopState {
  return { version: 1, projects: [], threads: [], prefs: DEFAULT_PREFS, layout: DEFAULT_LAYOUT, learning: EMPTY_LEARNING, game: EMPTY_GAME }
}

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/)
/** What `check.run` accepts: shell text up to 4000 characters. */
const CheckCommand = z.string().min(1).max(4_000).refine((value) => value.trim().length > 0 && !value.includes("\0"))
const Backend = z.enum(["native", "replay", "pi", "codex", "claude-code", "copilot", "opencode", "gemini", "goose"])
const ConnectionId = z.string().regex(CONNECTION_ID)
const Permission = z.enum(["ask", "auto-edit", "auto", "full"])
const ThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
const Status = z.enum(["idle", "running", "waiting", "completed", "failed", "stopped"])
/** How many recently picked models are remembered. */
export const RECENT_MODELS = 5
export const MAX_FAVORITE_MODELS = 32
/** The engine takes at most this much instruction text from the behavior file. */
export const MAX_INSTRUCTIONS = 8 * 1024
/** Coding tools a thread can run on. Each takes a model from Runrail, or runs on its own when none is named. */
export const MODEL_TOOLS = ["claude-code", "codex", "copilot", "opencode", "gemini", "goose", "pi"] as const satisfies readonly BackendId[]
/** Offered on their own logins while the tool connections are not known: before they are read, or when the system engine cannot list them. */
export const LEGACY_TOOLS = ["claude-code", "codex", "copilot", "pi"] as const satisfies readonly (typeof MODEL_TOOLS)[number][]
/** A coding tool's model id. Claude Code names context variants in brackets, such as `opus[1m]`. */
export const TOOL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-:/@+[\]]{0,127}$/

export function takesModel(backend: BackendId): backend is (typeof MODEL_TOOLS)[number] {
  return (MODEL_TOOLS as readonly BackendId[]).includes(backend)
}

const ProjectSchema = z.object({
  id: Id,
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  git: z.boolean(),
  addedAt: z.number(),
  // A bad list is dropped, not the project.
  disabledSkills: z.array(z.string().regex(SKILL_ID)).max(MAX_DISABLED_SKILLS).optional().catch(undefined),
  checkCommand: CheckCommand.optional().catch(undefined),
  folders: z
    .array(z.string().regex(/^\/[^\0\r\n]{0,4095}$/))
    .max(MAX_PROJECT_FOLDERS)
    .optional()
    .catch(undefined),
  browserSignIns: z.literal(true).optional().catch(undefined),
  remote: z
    .object({ id: z.string().regex(/^rm-[A-Za-z0-9]{1,37}$/), host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,252}$/) })
    .optional()
    .catch(undefined),
  connectedTo: z
    .object({
      service: z.enum(["github", "gitlab", "bitbucket", "unknown", "local"]),
      certain: z.boolean(),
      host: z.string().min(1).max(256).optional(),
      path: z.string().min(1).max(2048).optional(),
      upstream: z.string().min(1).max(2048).optional(),
    })
    .optional()
    .catch(undefined),
})

const ThreadSchema = z.object({
  id: Id,
  projectId: Id,
  title: z.string().max(256),
  titled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  backend: Backend,
  model: z.string().max(256).optional(),
  connectionId: ConnectionId.optional().catch(undefined),
  runHistory: z
    .array(
      z.object({
        turnId: Id,
        backend: Backend,
        model: z.string().max(256).optional(),
        connectionId: ConnectionId.optional().catch(undefined),
      }),
    )
    .max(MAX_SAVED_RUNS)
    .transform((runs) => runs.slice(-MAX_THREAD_RUNS))
    .optional()
    .catch(undefined),
  thinking: ThinkingSchema.optional(),
  mode: z.enum(["agent", "plan", "goal"]).catch("agent"),
  permission: Permission.catch("ask"),
  worktree: z
    .object({
      id: Id,
      path: z.string().max(4096),
      cwd: z.string().max(4096),
      branch: z.string().max(512).optional(),
      base: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("branch"), name: z.string().min(1).max(255) }),
          z.object({ kind: z.literal("pr"), number: z.number().int().positive().max(1_000_000_000), title: z.string().max(256).optional() }),
        ])
        .optional()
        .catch(undefined),
    })
    .optional(),
  archived: z.boolean().optional(),
  archivedAt: z.number().optional().catch(undefined),
  pinned: z.boolean().optional(),
  lastStatus: Status.optional(),
  unread: z.boolean().optional(),
  group: z.object({ id: Id, label: z.string().max(128), appliedAt: z.number().optional(), check: CheckCommand.optional().catch(undefined), autoCheck: z.boolean().optional() }).optional(),
  parentThreadId: Id.optional(),
  reviewOf: Id.optional().catch(undefined),
  setup: z
    .object({ runId: z.string().regex(/^setup-[0-9a-f-]{36}$/), role: z.enum(["planner", "executor", "reviewer"]) })
    .optional()
    .catch(undefined),
  review: z
    .object({
      owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
      repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
      number: z.number().int().positive().max(1_000_000_000),
      headCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    })
    .optional()
    .catch(undefined),
  importedFrom: z.object({ source: z.enum(EXTERNAL_SOURCES), id: z.string().min(1).max(256) }).optional(),
  // Anything else reads as off: browser use is never turned on by a damaged file.
  browser: z.object({ agent: z.literal(true), anySite: z.literal(true).optional() }).optional().catch(undefined),
  computer: z.literal(true).optional().catch(undefined),
  resume: z.object({ at: z.number().int().positive(), again: z.boolean() }).optional().catch(undefined),
  ciWatch: z
    .object({ number: z.number().int().positive().max(1_000_000_000), heads: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(10), rounds: z.number().int().min(0).max(100) })
    .optional()
    .catch(undefined),
  // Each damaged entry is dropped on its own; the newest twenty are kept.
  pullRequests: z
    .array(
      z
        .object({
          number: z.number().int().positive().max(1_000_000_000),
          url: z.string().regex(/^https:\/\/\S{1,2040}$/).optional(),
          turnId: z.string().min(1).max(256).optional(),
          at: z.number(),
          card: z.boolean(),
        })
        .nullable()
        .catch(null),
    )
    .max(200)
    .transform((list) => list.filter((entry) => entry !== null).slice(-MAX_THREAD_PULL_REQUESTS))
    .optional()
    .catch(undefined),
})

const PrefsSchema = z.object({
  theme: z.enum(["system", "dark", "light"]).catch("system"),
  palette: z.enum(PALETTES).catch("default"),
  accent: z.enum(ACCENTS).catch("mono"),
  sidebarGlass: z.boolean().catch(true),
  gitHooks: z.boolean().catch(true),
  editor: z.enum(EDITOR_IDS).catch("vscode"),
  sendKey: z.enum(["enter", "mod-enter"]).catch("enter"),
  reasoning: z.enum(["hidden", "folded", "open"]).catch("folded"),
  defaultMode: z.enum(["agent", "plan"]).catch("agent"),
  followUp: z.enum(["queue", "steer"]).catch("queue"),
  defaultBackend: Backend.catch("native"),
  defaultPermission: Permission.default("auto").catch("ask"),
  defaultModel: z.string().max(256).optional(),
  defaultConnectionId: ConnectionId.optional().catch(undefined),
  defaultToolModel: z.string().regex(TOOL_MODEL_ID).optional().catch(undefined),
  defaultToolConnectionId: ConnectionId.optional().catch(undefined),
  recentModels: z
    .array(z.object({ model: z.string().min(1).max(256), connectionId: ConnectionId }))
    .max(RECENT_MODELS)
    .catch([]),
  defaultThinking: ThinkingSchema.catch("medium"),
  density: z.enum(["comfortable", "compact"]).catch("comfortable"),
  showThreadTimestamps: z.boolean().catch(false),
  textSize: z.enum(["small", "default", "large"]).catch("default"),
  diffView: z.enum(["unified", "split"]).catch("unified"),
  notifications: z.boolean().catch(true),
  developer: z.boolean().catch(false),
  worktreeByDefault: z.boolean().catch(false),
  threadMessages: z.enum(["off", "project", "all"]).catch("project"),
  continueAfterLimit: z.boolean().catch(false),
  planLimits: z.enum(["ask", "on", "off"]).catch("ask"),
  claudeSdk: z.enum(["ask", "without"]).catch("ask"),
  onboarded: z.boolean().catch(false),
  checkUpdates: z.boolean().catch(true),
  contextDisplay: z.enum(["used", "near-full"]).catch("used"),
  favoriteModels: z
    .array(z.object({ model: z.string().min(1).max(256), connectionId: ConnectionId }))
    .max(MAX_FAVORITE_MODELS)
    .catch([]),
  instructions: z.string().max(MAX_INSTRUCTIONS).optional().catch(undefined),
  keepAwake: z.boolean().catch(false),
  toldMenuBar: z.boolean().catch(false),
  keepDisplayAwake: z.boolean().catch(false),
  confirmQuit: z.boolean().catch(true),
  sounds: z.boolean().catch(false),
  volume: z.number().min(0).max(1).catch(DEFAULT_TONE_VOLUME),
  systemNotifications: z.enum(["off", "background", "always"]).catch("background"),
  notifyOn: z.object({ finished: z.boolean().catch(true), failed: z.boolean().catch(true), approvals: z.boolean().catch(true) }).catch(DEFAULT_NOTIFY_ON),
  memory: z.object({ recall: z.boolean().catch(true), suggest: z.boolean().catch(true) }).catch(DEFAULT_MEMORY_PREFS),
  integrationGrants: z.partialRecord(z.enum(["threads", "planner", "executor", "reviewer"]), z.record(z.string().regex(/^(mcp:)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), z.enum(["off", "read", "ask", "write"]))).catch({}),
  quietMinutes: z.union([z.literal(0), z.literal(2), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).catch(5),
  officeMode: z.enum(["off", "office", "list"]).catch("off"),
  learn: z.enum(LEARN_LEVELS).optional().catch(undefined),
  game: z.boolean().optional().catch(undefined),
  nifra: z.boolean().optional().catch(undefined),
  motion: z.enum(["system", "reduce"]).catch("system"),
  voice: z
    .object({
      dictation: z.boolean().catch(true),
      engine: z.enum(["apple", "whisper"]).catch("apple"),
      onDevice: z.boolean().catch(false),
      device: z.string().min(1).max(512).optional().catch(undefined),
      model: z.string().regex(/^[a-z0-9.-]{1,32}$/).optional().catch(undefined),
      words: z
        .array(z.string())
        .catch([])
        .transform((words) => words.map((word) => word.trim()).filter((word) => word.length > 0 && word.length <= MAX_VOICE_WORD && [...word].every((char) => char.charCodeAt(0) >= 32)).slice(0, MAX_VOICE_WORDS)),
      language: z.string().max(35).regex(LANGUAGE_TAG).optional().catch(undefined),
      autoSend: z.boolean().catch(false),
      sounds: z.boolean().catch(true),
      readAloud: z.boolean().catch(false),
      voiceId: z.string().min(1).max(256).optional().catch(undefined),
      rate: z.number().min(0.5).max(2).catch(1),
    })
    .catch({ ...DEFAULT_VOICE, words: [] }),
  uiFont: z.enum(UI_FONTS).catch("system"),
  codeFont: z.enum(CODE_FONTS).catch("sf-mono"),
  fileLinks: z.enum(["app", "editor"]).catch("app"),
  pasteThreshold: z.union([z.literal(0), z.literal(2_000), z.literal(5_000), z.literal(10_000)]).catch(5_000),
  terminalShell: z.string().min(2).max(256).regex(/^\/[^\0]*$/).optional().catch(undefined),
})

const LayoutSchema = z.object({
  activeThreadId: Id.optional(),
  panes: z.array(Id).min(2).max(MAX_PANES).optional().catch(undefined),
  activeProjectId: Id.optional(),
  collapsedProjects: z.array(Id).max(512).catch([]),
  sidebarOpen: z.boolean().catch(true),
  sidebarWidth: z.number().min(200).max(480).catch(272),
  sidebarView: z
    .object({
      organize: z.enum(["project", "chronological"]).catch("project"),
      threadSort: z.enum(["updated", "created"]).catch("updated"),
      projectSort: z.enum(["added", "name", "activity"]).catch("added"),
      showArchived: z.boolean().catch(false),
    })
    .catch(DEFAULT_SIDEBAR_VIEW),
  inspectorOpen: z.boolean().catch(false),
  inspectorWidth: z.number().min(320).max(1200).catch(520),
  panels: z.unknown().optional().transform((value) => cleanPanels(value)),
})

const PanelTabSchema = z.object({ id: Id, kind: z.enum(PANEL_KINDS), url: z.string().optional().catch(undefined) })

/**
 * Saved address of a browser tab: http or https, no user info, and no query or fragment, which
 * can carry tokens. Undefined for anything else.
 */
export function savedUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return undefined
  return `${url.origin}${url.pathname}`
}

/** One thread's tabs within the limits: singles once, terminals and browsers capped, an active tab that exists. */
export function cleanPanel(value: unknown): PanelState | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as { tabs?: unknown; active?: unknown }
  const tabs: PanelTab[] = []
  const seen = new Set<string>()
  for (const tab of listOf(PanelTabSchema, record.tabs, PANEL_LIMITS.tabs * 2)) {
    if (tabs.length >= PANEL_LIMITS.tabs || seen.has(tab.id)) continue
    const count = tabs.filter((other) => other.kind === tab.kind).length
    if (SINGLE_PANELS.has(tab.kind) ? count >= 1 : count >= (tab.kind === "terminal" ? PANEL_LIMITS.terminal : PANEL_LIMITS.browser)) continue
    const url = tab.kind === "browser" ? savedUrl(tab.url) : undefined
    seen.add(tab.id)
    tabs.push(url === undefined ? { id: tab.id, kind: tab.kind } : { id: tab.id, kind: tab.kind, url })
  }
  if (tabs.length === 0) return undefined
  const active = typeof record.active === "string" && seen.has(record.active) ? record.active : undefined
  return active === undefined ? { tabs } : { tabs, active }
}

/** Every thread's tabs, the most recently saved threads kept. */
export function cleanPanels(value: unknown): Readonly<Record<string, PanelState>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const entries: [string, PanelState][] = []
  for (const [threadId, panel] of Object.entries(value as Record<string, unknown>)) {
    if (!Id.safeParse(threadId).success) continue
    const clean = cleanPanel(panel)
    if (clean !== undefined) entries.push([threadId, clean])
  }
  return Object.fromEntries(entries.slice(-PANEL_LIMITS.threads))
}

function listOf<T>(schema: z.ZodType<T>, value: unknown, max: number): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const item of value.slice(0, max)) {
    const parsed = schema.safeParse(item)
    if (parsed.success) result.push(parsed.data)
  }
  return result
}

/**
 * A Runrail model is only usable through a connection. State written before connections existed
 * names a model alone; keeping it would start the thread on nothing, so the model is dropped and
 * the user picks one again. A coding tool keeps a model it can be started with and nothing else.
 */
function boundThread<T extends { readonly backend: BackendId; readonly model?: string | undefined; readonly connectionId?: string | undefined }>(thread: T): T {
  if (thread.model === undefined) return thread
  if (thread.backend === "native" ? thread.connectionId !== undefined : takesModel(thread.backend) && TOOL_MODEL_ID.test(thread.model)) return thread
  const { model: _unbound, ...rest } = thread
  return rest as T
}

function boundPrefs<T extends { readonly defaultModel?: string | undefined; readonly defaultConnectionId?: string | undefined }>(prefs: T): T {
  if (prefs.defaultModel === undefined || prefs.defaultConnectionId !== undefined) return prefs
  const { defaultModel: _unbound, ...rest } = prefs
  return rest as T
}

const LessonKeySchema = z.string().regex(/^(brief|standard|deep):[a-z][a-z-]{0,31}$/)
const LessonReadSchema = z.object({ id: z.string().regex(/^[a-z][a-z-]{0,31}$/), level: z.enum(["brief", "standard", "deep"]), at: z.number().finite() })

/** The newest entries are the ones kept when a list is over its bound. */
function parseLearning(value: unknown): Learning {
  if (typeof value !== "object" || value === null) return EMPTY_LEARNING
  const record = value as Record<string, unknown>
  const newest = (list: unknown, max: number): unknown[] => (Array.isArray(list) ? list.slice(-max) : [])
  return {
    seen: [...new Set(listOf(LessonKeySchema, newest(record.seen, MAX_LESSONS_SEEN), MAX_LESSONS_SEEN))],
    read: listOf(LessonReadSchema, newest(record.read, MAX_LESSONS_READ), MAX_LESSONS_READ),
  }
}

const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Count = z.number().int().min(0).max(1_000_000)
const QuestKey = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/)
const GameDaySchema = z.object({
  xp: Count.catch(0),
  counts: z.partialRecord(z.enum(GAME_EVENTS), Count).catch({}),
  answerMs: z.array(z.number().int().min(0).max(MAX_ANSWER_MS)).catch([]).transform((list) => list.slice(-MAX_ANSWER_TIMES)),
  quests: z.array(QuestKey).catch([]).transform((list) => [...new Set(list)].slice(0, 256)),
})
const QuestProgressSchema = z.object({ period: z.string().min(1).max(160), count: Count, done: z.boolean() })
const SeasonChoiceSchema = z.object({
  season: z.string().min(1).max(64),
  hash: z.string().regex(/^[0-9a-f]{8,64}$/),
  accepted: z.boolean(),
  text: z.string().max(MAX_QUEST_FILE_BYTES).optional(),
})

/** Each part of the ledger is read on its own; a bad entry is dropped, not the rest. */
function parseGame(value: unknown): Game {
  if (typeof value !== "object" || value === null) return EMPTY_GAME
  const record = value as Record<string, unknown>
  const entries = <T>(source: unknown, key: z.ZodType<string>, schema: z.ZodType<T>, max: number): [string, T][] => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) return []
    const kept: [string, T][] = []
    for (const [name, item] of Object.entries(source)) {
      if (kept.length >= max) break
      const parsed = schema.safeParse(item)
      if (key.safeParse(name).success && parsed.success) kept.push([name, parsed.data])
    }
    return kept
  }
  const xp = z.number().int().min(0).max(MAX_XP).safeParse(record.xp)
  return {
    xp: xp.success ? xp.data : 0,
    days: Object.fromEntries(entries(record.days, DayKey, GameDaySchema, 366).sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_GAME_DAYS)),
    progress: Object.fromEntries(entries(record.progress, QuestKey, QuestProgressSchema, MAX_QUEST_PROGRESS)),
    seasons: Object.fromEntries(entries(record.seasons, Id, SeasonChoiceSchema, MAX_SEASONS)),
  }
}

/** Parses persisted state; invalid entries are dropped individually rather than losing everything. */
export function parseState(value: unknown): DesktopState {
  if (typeof value !== "object" || value === null) return defaultState()
  const record = value as Record<string, unknown>
  if (record.version !== 1) return defaultState()
  const projects = listOf(ProjectSchema, record.projects, 256)
  const projectIds = new Set(projects.map((project) => project.id))
  const threads = listOf(ThreadSchema, record.threads, 4096)
    .filter((thread) => projectIds.has(thread.projectId))
    .map(boundThread)
  const prefs = PrefsSchema.safeParse(record.prefs)
  const layout = LayoutSchema.safeParse(record.layout)
  return {
    version: 1,
    projects,
    threads: threads as ThreadMeta[],
    prefs: prefs.success ? (boundPrefs(prefs.data) as Prefs) : DEFAULT_PREFS,
    layout: layout.success ? { ...(layout.data as Layout), panels: Object.fromEntries(Object.entries(layout.data.panels).filter(([threadId]) => threads.some((thread) => thread.id === threadId))) } : DEFAULT_LAYOUT,
    learning: parseLearning(record.learning),
    game: parseGame(record.game),
  }
}

/** Why the saved state was not used: the host could not read it, or another version of Runrail wrote it. */
export type StateProblem = "unreadable" | "unknown-version"

export interface LoadedState {
  readonly state: DesktopState
  readonly problem?: StateProblem
  readonly message?: string
}

/**
 * Reads the saved state at startup. Only no saved file at all (the host moves a corrupt one aside)
 * starts fresh; a problem means the file is still there and this session must not save over it.
 */
export async function loadState(read: () => Promise<unknown>): Promise<LoadedState> {
  let raw: unknown
  try {
    raw = await read()
  } catch (error) {
    return { state: defaultState(), problem: "unreadable", message: toHostError(error).message }
  }
  if (raw === null || raw === undefined) return { state: defaultState() }
  if (typeof raw !== "object" || Array.isArray(raw)) return { state: defaultState(), problem: "unreadable" }
  if ((raw as Record<string, unknown>).version !== 1) return { state: defaultState(), problem: "unknown-version" }
  return { state: parseState(raw) }
}

export function newId(prefix: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

/** Thread title from the first prompt: first line, bounded, whitespace collapsed. */
export function titleFromPrompt(text: string): string {
  const line = text.replace(/@([\w./-]+)/g, "$1").split("\n").find((part) => part.trim().length > 0) ?? ""
  const collapsed = line.replace(/\s+/g, " ").trim()
  if (collapsed.length <= 80) return collapsed
  const cut = collapsed.slice(0, 80)
  const space = cut.lastIndexOf(" ")
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export interface BehaviorSpec {
  readonly mode: "ask" | "auto" | "plan"
  readonly effort: "off" | "low" | "medium" | "high" | "xhigh" | "max"
  readonly permissionDefault: "allow" | "ask" | "deny"
  readonly rules: readonly { readonly tool: string; readonly match: string; readonly policy: "allow" | "ask" | "deny" }[]
  readonly instructions?: string
  /** Checked by the host against the system's login shells. */
  readonly shell?: string
  /** This thread's grant per connector id or `mcp:<server>`; one left out is Write. */
  readonly integrations?: Readonly<Record<string, IntegrationGrant>>
}

/** Global instructions ride along with the behavior file; blank text sends none. */
export function withInstructions(spec: BehaviorSpec, instructions: string | undefined): BehaviorSpec {
  const text = instructions?.trim()
  return text === undefined || text.length === 0 ? spec : { ...spec, instructions: text.slice(0, MAX_INSTRUCTIONS) }
}

/** The terminal shell the person chose, if any; the host refuses one the system does not list. */
export function withShell(spec: BehaviorSpec, shell: string | undefined): BehaviorSpec {
  return shell === undefined ? spec : { ...spec, shell }
}

/** Maps the UI's permission preset and mode onto engine behavior configuration. */
export function behaviorFor(permission: PermissionPreset, mode: ThreadMode, thinking: Thinking | undefined): BehaviorSpec {
  // The behavior file's levels stop at Max; Ultra reaches Codex with the thread's model instead.
  const effort = thinking === undefined || thinking === "minimal" ? "low" : thinking === "ultra" ? "max" : thinking
  if (mode === "plan") return { mode: "plan", effort, permissionDefault: "ask", rules: [] }
  switch (permission) {
    case "ask":
      return { mode: "ask", effort, permissionDefault: "ask", rules: [] }
    case "auto-edit":
      return {
        mode: "ask",
        effort,
        permissionDefault: "ask",
        rules: ["apply_patch", "write_file", "edit_file"].map((tool) => ({ tool, match: "*", policy: "allow" as const })),
      }
    // The tool's own reviewer answers: Claude Code's auto mode, Codex's Approve for me. Elsewhere it is Ask (app/access.ts).
    case "auto":
      return { mode: "auto", effort, permissionDefault: "ask", rules: [] }
    case "full":
      return { mode: "auto", effort, permissionDefault: "allow", rules: [] }
  }
}

/** The levels a connected model offers. Coding tools offer their own lists (app/picker.ts). */
export const THINKING_LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high"]
/** Every level, lowest first. */
export const ALL_THINKING_LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
export const PERMISSION_LABELS: Record<PermissionPreset, string> = { ask: "Ask", "auto-edit": "Auto-edit", auto: "Auto", full: "Full access" }
export const MODE_LABELS: Record<ThreadMode, string> = { agent: "Agent", plan: "Plan", goal: "Goal" }
export const BACKEND_LABELS: Record<BackendId, string> = { native: "Runrail", "claude-code": "Claude Code", codex: "Codex", copilot: "GitHub Copilot", opencode: "OpenCode", gemini: "Gemini CLI", goose: "Goose", pi: "Pi", replay: "Replay" }
