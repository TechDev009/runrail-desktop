/**
 * The renderer's only door to the machine. The Tauri host implements it with typed commands;
 * the preview host implements it with a scripted in-memory engine for browser development.
 * Tokens never cross this boundary.
 */

export type BackendId = "native" | "replay" | "pi" | "codex" | "claude-code" | "copilot" | "opencode" | "gemini" | "goose"
export const BACKENDS: readonly BackendId[] = ["native", "claude-code", "codex", "copilot", "opencode", "gemini", "goose", "pi", "replay"]

/**
 * The engine that owns connections and sign-ins. The host starts it with no project, so keys and
 * subscriptions can be set up before any project is open. Only `account.*`, `connection.*` and
 * `auth.*` methods reach it.
 */
export const SYSTEM_ENGINE_ID = "system"

/** Same pattern the engine enforces for a connection id. */
export const CONNECTION_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/

/** `xhigh`, `max`, and `ultra` are the top levels some coding tools take; a connected model runs them as high. */
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
export type BehaviorMode = "ask" | "auto" | "plan"
export type PermissionPolicy = "allow" | "ask" | "deny"

export interface PermissionRule {
  readonly tool: string
  readonly match: string
  readonly policy: PermissionPolicy
}

export interface Behavior {
  readonly mode: BehaviorMode
  readonly effort: "off" | "low" | "medium" | "high" | "xhigh" | "max"
  readonly permissionDefault: PermissionPolicy
  readonly rules: readonly PermissionRule[]
  /** Instructions every turn starts with; the host bounds them to 8 KiB. */
  readonly instructions?: string
  /** The terminal shell; the host refuses one the system does not list as a login shell. */
  readonly shell?: string
  /** Who may use what: the thread's grant per connector id or `mcp:<server>`; one left out is Write. */
  readonly integrations?: Readonly<Record<string, "off" | "read" | "ask" | "write">>
}

/** Whose key: an account's, a coding-tool connection's, or a built-in connector's (named by its kind). */
export type SecretTarget = "account" | "tool" | "connector"

export interface EngineStartInput {
  readonly engineId: string
  readonly workspace: string
  readonly backend: BackendId
  readonly sessionId: string
  readonly behavior?: Behavior
  readonly model?: string
  /** The stored connection the model is reached through. Runrail's own loop only. */
  readonly connectionId?: string
  /** The coding-tool connection a tool runs as: its login, its own folder or key, and its models. */
  readonly toolConnectionId?: string
  readonly thinking?: Thinking
  /** The thread this one continues: the engine copies its conversation in the first time it starts. */
  readonly continueFrom?: string
  /** Lets the agent use the thread's browser preview; pages on this computer only unless `browserAnySite`. */
  readonly browserTools?: boolean
  readonly browserAnySite?: boolean
  /** Lets the agent list, read and message the person's other threads. */
  readonly threadTools?: boolean
  /** The project's related folders; each must be a folder the person picked. */
  readonly folders?: readonly string[]
  /** The agent may see and use apps the person allowed; Codex and Claude Code only. */
  readonly computerTools?: boolean
  /** The agent may make pictures with the image model the person picked. */
  readonly imageTools?: boolean
  /** Leaves out Nifra's tools, instructions, and check, which a Nifra project gets otherwise. */
  readonly noNifra?: boolean
  /** The remote machine the engine runs on, by id; `workspace` is then a path there. */
  readonly remote?: string
}

/** A machine a project can live on, reached with the person's own `ssh`. */
export interface RemoteMachine {
  readonly id: string
  /** An alias from ~/.ssh/config, a host name, or user@host. */
  readonly host: string
  /** How that machine's login shell starts Runrail's engine; `runrail` when unset. */
  readonly engine?: string
}

export interface RemoteCheck {
  /** The engine's version there. */
  readonly version?: string
  /** Whether the folder asked about is there, and a git repository. */
  readonly folder?: boolean
  readonly git?: boolean
}

/** Computer use: what Runrail may do on this computer, as the system says. */
export interface ComputerAccess {
  readonly supported: boolean
  readonly screen: boolean
  readonly accessibility: boolean
  /** Linux: the desktop session. */
  readonly session?: "x11" | "wayland"
  /** Linux on Wayland: the desktop's portal is missing, ready for the person to share a window, or has one shared. */
  readonly portal?: "missing" | "ready" | "shared"
  /** Why agents cannot use apps here, when they cannot. */
  readonly reason?: string
}

export interface ComputerApp {
  readonly bundleId: string
  readonly name: string
}

export interface RunningComputerApp extends ComputerApp {
  /** Refused for every agent: password managers, security settings, terminals. */
  readonly never: boolean
}

/** iOS Simulator: Xcode's tools, idb for input, and whether agents may use simulators. */
export interface SimulatorStatus {
  readonly supported: boolean
  readonly xcode: boolean
  readonly idb: boolean
  readonly agents: boolean
}

export interface SimulatorDevice {
  readonly udid: string
  readonly name: string
  readonly runtime: string
  readonly booted: boolean
}

export interface SimulatorApp {
  readonly bundleId: string
  readonly name: string
}

export interface SimulatorScreen {
  readonly mediaType: string
  readonly dataBase64: string
  readonly width: number
  readonly height: number
}

/** Places are fractions of the screen, 0 to 1, so any size the image is shown at maps the same. */
export type SimulatorInput =
  | { readonly kind: "tap"; readonly x: number; readonly y: number }
  | { readonly kind: "swipe"; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "button"; readonly button: "home" | "lock" | "siri" }

/** Android emulators: the SDK's `adb` and `emulator`, KVM on Linux, and whether agents may use emulators. */
export interface AndroidStatus {
  readonly supported: boolean
  readonly sdk: boolean
  readonly emulator: boolean
  readonly kvm: boolean
  readonly agents: boolean
}

export interface AndroidDevice {
  /** The virtual device's name in the SDK, which starts it. */
  readonly avd: string
  readonly name: string
  /** `emulator-<port>` while it runs; every other call takes it. */
  readonly serial?: string | null
  readonly booted: boolean
}

export interface AndroidApp {
  /** Empty when an install could not name the package. */
  readonly package: string
  readonly name: string
}

export type AndroidInput =
  | Exclude<SimulatorInput, { readonly kind: "button" }>
  | { readonly kind: "button"; readonly button: "back" | "home" | "recents" | "power" }

export interface EngineInfo {
  readonly engineId: string
  readonly state: "running" | "exited"
  readonly workspace: string
  readonly backend: string
  readonly sessionId: string
  readonly behavior: Behavior
  readonly model?: string
  readonly connectionId?: string
  readonly instance: number
  readonly contract: unknown
}

export interface WorkspaceInfo {
  readonly path: string
  readonly name: string
  readonly git: boolean
}

export interface WorkspacePickOptions {
  /** A folder the dialog opens at, such as where an imported session was recorded; the person still chooses. */
  readonly near?: string
  /** The folder is to be a project's related folder; the dialog says so. */
  readonly related?: boolean
}

export interface HostInfo {
  readonly version: string
  readonly platform: string
  readonly terminal: boolean
  /** True when this build can check for and install signed updates. */
  readonly updates?: boolean
  /** Where keys are kept. `file` means a development build that does not use the OS keychain. */
  readonly credentialStore?: "keychain" | "file"
  /** True when the host can read a key from the clipboard itself, so it never enters the page. */
  readonly clipboardSecrets?: boolean
}

/** How long the last launch took, from process start to saved state on screen. */
export interface StartupTiming {
  readonly readyMs: number
  readonly at: number
}

export type UpdateStatus =
  | { readonly state: "unavailable" }
  | { readonly state: "current"; readonly version: string }
  | { readonly state: "available"; readonly version: string; readonly current: string; readonly date?: string; readonly notes?: string }

export interface StreamFrame {
  readonly kind: "event" | "live"
  readonly data: unknown
}

export type StreamState = "connected" | "reconnecting"

/** An MCP server Runrail's own loop starts. Variables are named, never valued. */
export interface McpServer {
  readonly name: string
  /** The program a local server runs; empty for one reached by `url`. */
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly string[]
  /** A server reached over HTTP: `https`, or `http` on this computer. */
  readonly url?: string
  /** The shell variable whose value is sent to `url` as the access token. */
  readonly bearerEnv?: string
  /** The project folder the server belongs to; unset means every project. */
  readonly project?: string
  readonly enabled: boolean
}

/** A skill folder the host copied into the project. */
export interface ImportedSkill {
  readonly name: string
  readonly path: string
  readonly files: number
}

/** Another coding tool whose settings the host can read. `shared` is `~/.agents/skills`. */
export type OtherTool = "claude-code" | "claude-desktop" | "codex" | "copilot" | "cursor" | "gemini" | "opencode" | "pi" | "shared"

/** An instruction file another tool reads. */
export interface FoundInstructions {
  readonly tool: OtherTool
  readonly scope: "global" | "project"
  /** Where it is, with the home folder shown as `~`. */
  readonly place: string
  readonly text: string
}

export interface FoundSkill {
  readonly tool: OtherTool
  readonly name: string
  readonly description?: string
  /** The folder; the import names it and the host checks it is one it found. */
  readonly path: string
  readonly place: string
}

/** An MCP server from another tool, converted to Runrail's rules. Values of variables never come along. */
export interface FoundServer {
  readonly tool: OtherTool
  readonly scope: "global" | "project"
  readonly place: string
  /** Absent when it cannot run here as written; `leftOut` says why. */
  readonly server?: McpServer
  readonly original: string
  readonly leftOut: readonly string[]
}

export interface FoundAgent {
  readonly tool: OtherTool
  readonly name: string
  readonly description: string
  readonly path: string
  readonly place: string
}

export interface OtherTools {
  readonly instructions: readonly FoundInstructions[]
  readonly skills: readonly FoundSkill[]
  readonly servers: readonly FoundServer[]
  readonly agents: readonly FoundAgent[]
}

/** A subagent definition in the project's `.claude/agents`. */
export interface AgentDefinition {
  readonly name: string
  readonly description: string
  readonly tools: readonly string[]
  readonly model?: string
  readonly prompt: string
}

/** A project's `AGENTS.md` as the host read it. */
export interface ProjectInstructions {
  readonly exists: boolean
  readonly text: string
  /** The project also has a `CLAUDE.md`; the agent reads both. */
  readonly claudeFile: boolean
}

/** macOS's fixed "Open in" list, then the Linux file manager, terminals and IDEs. */
export const EDITOR_IDS = [
  "vscode",
  "cursor",
  "zed",
  "xcode",
  "terminal",
  "iterm",
  "ghostty",
  "finder",
  "files",
  "gnome-terminal",
  "gnome-console",
  "ptyxis",
  "konsole",
  "xfce4-terminal",
  "kitty",
  "wezterm",
  "alacritty",
  "idea",
  "pycharm",
  "webstorm",
  "goland",
  "clion",
  "rustrover",
  "phpstorm",
  "rider",
  "rubymine",
] as const
export type EditorId = (typeof EDITOR_IDS)[number]

/** Whether saved browser sign-ins work here; Linux needs a Secret Service. */
export interface SignInsSupport {
  readonly available: boolean
  readonly reason?: string
}

/** Content-free error from the host: a stable code, a short message, and an HTTP status if any. */
export class HostError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = "HostError"
    this.code = code
    this.status = status
  }
}

export function toHostError(error: unknown): HostError {
  if (error instanceof HostError) return error
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; message?: unknown; status?: unknown }
    const code = typeof value.code === "string" && /^[A-Z0-9_]{1,64}$/.test(value.code) ? value.code : "HOST_ERROR"
    const message = typeof value.message === "string" ? value.message.slice(0, 512) : "request failed"
    const status = typeof value.status === "number" ? value.status : undefined
    return new HostError(code, message, status)
  }
  return new HostError("HOST_ERROR", typeof error === "string" ? error.slice(0, 512) : "request failed")
}

/** True when the engine does not implement a method or capability (older engine, other launch path). */
export function isUnsupported(code: string | undefined): boolean {
  return code === "CONTROL_UNKNOWN_METHOD" || code === "CONTROL_METHOD_UNKNOWN" || code === "CONTROL_CAPABILITY_UNAVAILABLE" || (code !== undefined && /_(UNAVAILABLE|UNSUPPORTED)$/.test(code) && code !== "PLUGIN_ROLLBACK_UNAVAILABLE")
}

export type Unsubscribe = () => void

export interface NotifyStatus {
  /** Only the installed app can post; a development build cannot. */
  readonly available: boolean
  readonly permission: "unknown" | "granted" | "denied"
}

export interface SystemNote {
  readonly threadId: string
  readonly title: string
  readonly body: string
  readonly sound: boolean
}

export interface VoiceDevice {
  readonly id: string
  readonly name: string
  readonly default: boolean
}

export interface VoiceModel {
  readonly id: string
  readonly label: string
  readonly size: number
  readonly englishOnly: boolean
  readonly installed: boolean
  readonly downloading: boolean
}

export interface ListenInput {
  readonly engine: "apple" | "whisper"
  /** A microphone from `voiceDevices`; unset uses the system's input. */
  readonly device?: string
  readonly language: string
  /** Apple's recognizer must stay on this Mac. */
  readonly onDevice: boolean
  /** A Whisper model id from `voiceModels`. */
  readonly model?: string
  /** Names and terms to listen for. */
  readonly words: readonly string[]
  /** The host ends the session once speech stops. */
  readonly untilSilence: boolean
}

export type VoiceEvent =
  | { readonly session: number; readonly kind: "level"; readonly level: number }
  | { readonly session: number; readonly kind: "partial" | "final"; readonly text: string }
  | { readonly session: number; readonly kind: "transcribing" | "ended" }
  | { readonly session: number; readonly kind: "error"; readonly code: string; readonly message: string }

export interface ModelProgress {
  readonly id: string
  readonly state: "downloading" | "verifying" | "done" | "failed" | "cancelled"
  readonly received?: number
  readonly total?: number
  readonly code?: string
  readonly message?: string
}

export interface Host {
  readonly kind: "tauri" | "preview"
  info(): Promise<HostInfo>
  /** Tells the host the window is ready; it keeps the first answer per launch. */
  startupReady(): Promise<StartupTiming | null>
  engineStart(input: EngineStartInput): Promise<EngineInfo>
  engineStop(engineId: string): Promise<void>
  engineList(): Promise<readonly EngineInfo[]>
  /**
   * Generic engine call. It never carries a credential: the host refuses secret methods, raw
   * credential fields, and sign-in input here. Those have the dedicated calls below.
   */
  rpc(engineId: string, method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Starts (or returns) the system engine. Its id is `SYSTEM_ENGINE_ID`. */
  systemEngine(): Promise<EngineInfo>
  /**
   * Write-only: stores a key for a connection. Returns the connection record, never the key. A
   * coding-tool connection's key is stored under its own id (`target: "tool"`).
   */
  connectionSecretSet(connectionId: string, secret: string, target?: SecretTarget): Promise<unknown>
  /** Same, but the host reads the clipboard itself. */
  connectionSecretFromClipboard(connectionId: string, target?: SecretTarget): Promise<unknown>
  /** Opens the sign-in page of a running sign-in. The page address comes from the engine. */
  authOpen(loginId: string): Promise<void>
  /** Hands over the address or code a person pasted to finish a sign-in. Returns its status. */
  authSubmitInput(loginId: string, input: string): Promise<unknown>
  streamStart(engineId: string, afterSeq: number, afterLiveSeq?: number): Promise<void>
  streamStop(engineId: string): Promise<void>
  threadForget(sessionId: string): Promise<void>
  workspacePick(options?: WorkspacePickOptions): Promise<WorkspaceInfo | null>
  /** The starters `runrail new` offers, as the engine lists them. */
  appStarters(): Promise<unknown>
  /** Makes a new app from a starter where the person picks in the system's dialog; null when they cancel. */
  appCreate(name: string, starter: string): Promise<unknown>
  computerAccess(): Promise<ComputerAccess>
  /** Shows the system's own request; the person answers it in System Settings. */
  computerRequestAccess(kind: "screen" | "accessibility"): Promise<ComputerAccess>
  computerOpenSettings(kind: "screen" | "accessibility"): Promise<void>
  computerRunningApps(): Promise<readonly RunningComputerApp[]>
  computerAllowed(): Promise<readonly ComputerApp[]>
  /** Adds an app once the person agrees in a dialog the page cannot draw; refused otherwise. */
  computerAllow(bundleId: string): Promise<readonly ComputerApp[]>
  computerDisallow(bundleId: string): Promise<readonly ComputerApp[]>
  /** One agent request, as taken from its engine; the answer goes back with `computer.respond`. */
  computerAct(action: string, params: Readonly<Record<string, unknown>>): Promise<unknown>
  simulatorStatus(): Promise<SimulatorStatus>
  simulatorDevices(): Promise<readonly SimulatorDevice[]>
  simulatorBoot(udid: string): Promise<void>
  simulatorShutdown(udid: string): Promise<void>
  /** Shows the device in Xcode's Simulator app. */
  simulatorOpen(udid: string): Promise<void>
  simulatorScreenshot(udid: string): Promise<SimulatorScreen>
  /** The apps the person installed on the device. */
  simulatorApps(udid: string): Promise<readonly SimulatorApp[]>
  /** Installs a built app the person picks in the system's file dialog; null when they cancel. */
  simulatorInstall(udid: string): Promise<SimulatorApp | null>
  simulatorLaunch(udid: string, bundleId: string): Promise<void>
  simulatorOpenUrl(udid: string, url: string): Promise<void>
  /** Needs idb; refused with `SIMULATOR_FAILED` otherwise. */
  simulatorInput(udid: string, input: SimulatorInput): Promise<void>
  /** Turning it on asks the person in a dialog the page cannot draw. */
  simulatorAgents(on: boolean): Promise<SimulatorStatus>
  androidStatus(): Promise<AndroidStatus>
  androidDevices(): Promise<readonly AndroidDevice[]>
  /** Resolves once Android has booted, with the emulator's serial. */
  androidBoot(avd: string): Promise<string>
  androidShutdown(serial: string): Promise<void>
  androidScreenshot(serial: string): Promise<SimulatorScreen>
  androidApps(serial: string): Promise<readonly AndroidApp[]>
  /** Installs an APK picked in the native file dialog; null when the person cancels. */
  androidInstall(serial: string): Promise<AndroidApp | null>
  androidLaunch(serial: string, packageName: string): Promise<void>
  androidOpenUrl(serial: string, url: string): Promise<void>
  androidInput(serial: string, input: AndroidInput): Promise<void>
  /** Turning it on asks the person in a dialog the page cannot draw. */
  androidAgents(on: boolean): Promise<AndroidStatus>
  /** A plugin archive's path from the native file picker; null when the person cancels. */
  archivePick(): Promise<string | null>
  workspaceInspect(path: string): Promise<WorkspaceInfo>
  workspaceReveal(workspace: string, relative?: string): Promise<void>
  workspaceOpenIn(workspace: string, relative: string | undefined, editor: EditorId): Promise<void>
  /** The "Open in" choices: macOS's fixed list, or what is installed on Linux, in menu order. */
  openInApps(): Promise<readonly EditorId[]>
  attachmentSave(workspace: string, mediaType: string, data: Uint8Array): Promise<string>
  /** The project's `AGENTS.md`. The host fixes the file name and refuses links. */
  instructionsRead(workspace: string): Promise<ProjectInstructions>
  instructionsWrite(workspace: string, text: string): Promise<ProjectInstructions>
  mcpList(): Promise<readonly McpServer[]>
  /**
   * Adds a server, or replaces the one named `previous`. A command not confirmed before is shown
   * in a native dialog first; declining fails with `MCP_DECLINED`.
   */
  mcpSave(server: McpServer, previous?: string): Promise<readonly McpServer[]>
  mcpSetEnabled(name: string, enabled: boolean): Promise<readonly McpServer[]>
  mcpRemove(name: string): Promise<readonly McpServer[]>
  /** Holds off idle sleep while on; returns whether the host is holding it. */
  keepAwake(on: boolean, display?: boolean): Promise<boolean>
  /** While on, quitting or closing the window asks first. */
  quitGuard(on: boolean): Promise<void>
  /** Quits as the app menu's Quit does: asked first while work runs. Linux's Ctrl+Q, which has no app menu. */
  appQuit(): Promise<void>
  /** Why the app stays in the menu bar when its window closes, none letting a close quit; and what its menu says. */
  backgroundHold(reasons: readonly string[], lines?: readonly string[]): Promise<void>
  /** The window closed into the menu bar, or came back; `tray` is false on a Linux desktop that shows no tray icon. */
  onBackground(listener: (hidden: boolean, tray: boolean) => void): Unsubscribe
  /** "Start in the menu bar at login", as System Settings holds it. */
  loginItem(): Promise<LoginItemStatus>
  setLoginItem(on: boolean): Promise<LoginItemStatus>
  /** The helper that opens Runrail in the menu bar when work is due after Quit. */
  wakeService(): Promise<WakeServiceStatus>
  setWakeService(on: boolean): Promise<WakeServiceStatus>
  /** Whether that helper opened this launch, to run what is due and quit when done. */
  launchWoken(): Promise<boolean>
  /** Remote machines over SSH. Saving shows anything new to the person in a native dialog. */
  remoteList(): Promise<readonly RemoteMachine[]>
  remoteSave(machine: { readonly id?: string; readonly host: string; readonly engine?: string }): Promise<readonly RemoteMachine[]>
  remoteRemove(id: string): Promise<readonly RemoteMachine[]>
  /** Reaches the machine, asks its engine for its version, and looks at `folder` there. */
  remoteCheck(id: string, folder?: string): Promise<RemoteCheck>
  /** The host aliases in ~/.ssh/config. */
  sshHosts(): Promise<readonly string[]>
  /**
   * Phone access: a server on 127.0.0.1 for paired phones, which the person's own
   * `tailscale serve` brings to their tailnet. A phone's calls come to `onPhoneCall`, and each is
   * answered once with `phoneAnswer`; the host gives up on one after 30 seconds.
   */
  phoneStatus(): Promise<PhoneStatus>
  setPhone(on: boolean): Promise<PhoneStatus>
  /** A one-time code, good for five minutes and five tries. */
  phonePair(): Promise<PhoneStatus>
  phoneForget(id: string): Promise<PhoneStatus>
  phoneAnswer(id: number, ok: boolean, body: unknown): Promise<void>
  onPhoneCall(listener: (call: PhoneCall) => void): Unsubscribe
  /** A phone paired, or asked for notifications. */
  onPhoneChanged(listener: (status: PhoneStatus) => void): Unsubscribe
  /** A paired phone's Web Push subscription and its page's origin, or null to stop. */
  phoneSetPush(device: string, push: { readonly subscription: unknown; readonly origin: string } | null): Promise<void>
  /** The phones that asked for notifications. */
  phonePushTargets(): Promise<readonly PhonePushTarget[]>
  /** A thread's read-only link on the tailnet, made the first time it is asked for. */
  phoneShareThread(threadId: string, title: string): Promise<PhoneShare>
  /** Picks a folder in a native dialog, says what it holds, and publishes a copy; null when cancelled. */
  phonePublish(): Promise<PhoneShare | null>
  /** Revokes a thread link or unpublishes a page. */
  phoneUnshare(id: string): Promise<PhoneStatus>
  /** A new webhook link for a workflow, replacing its old one; its secret comes only here. */
  phoneHookCreate(projectId: string, workflowId: string): Promise<NewPhoneHook>
  phoneHookRemove(id: string): Promise<PhoneStatus>
  /** Quick chat's global shortcut. */
  quickStatus(): Promise<QuickStatus>
  /** Turns the shortcut on or off or changes it; one another app holds fails with `QUICK_SHORTCUT_TAKEN`. */
  quickSet(enabled: boolean, shortcut: string): Promise<QuickStatus>
  /** A message from the quick window, with a picture of the window in front when the person asked for one. */
  onQuickSubmit(listener: (message: QuickMessage) => void): Unsubscribe
  /** The person's own Tailscale, as phone access needs it. Reads its status only. */
  tailscaleStatus(): Promise<TailscaleStatus>
  /** Shares phone access on the tailnet with `tailscale serve` after a native confirmation, or stops; declining fails with `TAILSCALE_DECLINED`. */
  tailscaleServe(on: boolean): Promise<TailscaleStatus>
  /** The login shells the system lists. */
  shellsList(): Promise<readonly string[]>
  /** Opens the system's folder dialog and copies the chosen skill in; null when cancelled. */
  skillImport(workspace: string): Promise<ImportedSkill | null>
  agentsList(workspace: string): Promise<readonly AgentDefinition[]>
  agentSave(workspace: string, agent: AgentDefinition, previous?: string): Promise<readonly AgentDefinition[]>
  agentRemove(workspace: string, name: string): Promise<readonly AgentDefinition[]>
  /** What Claude Code, Codex, and other tools on this computer are set up with. Reads only. */
  otherToolsScan(workspace?: string): Promise<OtherTools>
  /** Copies a skill `otherToolsScan` found into the project's `.agents/skills`. */
  otherSkillImport(workspace: string, path: string): Promise<ImportedSkill>
  /** Copies a subagent `otherToolsScan` found into the project's `.claude/agents`. */
  otherAgentImport(workspace: string, path: string): Promise<readonly AgentDefinition[]>
  /** Adds several new servers after one native confirmation; declining fails with `MCP_DECLINED`. */
  mcpImport(servers: readonly McpServer[]): Promise<readonly McpServer[]>
  stateLoad(): Promise<unknown>
  stateSave(value: unknown): Promise<void>
  /** The app is quitting: `save` runs, then the host quits; it quits anyway after a short wait. */
  onQuit(save: () => Promise<void>): Unsubscribe
  /**
   * Browser previews: each tab's page in its own webview over the side panel, with no access to
   * the app. Bounds are in the window's CSS pixels; `null` hides the page. False `reachable` means
   * nothing answers at a local address, and nothing was loaded.
   */
  readonly previewNative: boolean
  /** `hidden` loads the page without showing it, for the agent in a tab not on screen. */
  /** `project` names a project that keeps its browser sign-ins; a new preview starts with them. */
  previewOpen(tab: string, url: string, bounds: PreviewBounds, hidden?: boolean, project?: string): Promise<{ readonly reachable: boolean }>
  /** Whether a project has browser sign-ins saved. */
  signInsSaved(project: string): Promise<boolean>
  signInsSupport(): Promise<SignInsSupport>
  /** Removes a project's saved browser sign-ins and stops saving them. */
  signInsForget(project: string): Promise<void>
  previewBounds(tab: string, bounds: PreviewBounds | null): Promise<void>
  previewAction(tab: string, action: PreviewAction): Promise<void>
  /** Opens the page's current address in the default browser. */
  previewExternal(tab: string): Promise<void>
  previewClose(tab: string): Promise<void>
  /** Closes every preview whose tab is not listed. */
  previewRetain(tabs: readonly string[]): Promise<void>
  onPreview(listener: (state: PreviewState) => void): Unsubscribe
  /**
   * A fixed page action for the agent: read the page, click or type by ref, press a key, or read the
   * console. Without `anySite`, the host refuses a page not on this computer with `BROWSER_SITE_REFUSED`.
   */
  previewScript(tab: string, script: PreviewScript, anySite?: boolean): Promise<{ readonly text: string }>
  /** The agent's own script. The host asks the person in a native dialog every time; a no fails with `PREVIEW_DENIED`. */
  previewEval(tab: string, expression: string, anySite?: boolean): Promise<{ readonly text: string }>
  /** The visible page as a JPEG, at most 1600 pixels wide, or `width` pixels wide for an artboard. */
  previewScreenshot(tab: string, anySite?: boolean, width?: number): Promise<{ readonly mediaType: "image/jpeg" | "image/png"; readonly dataBase64: string }>
  /** Scales a preview's page, so a view narrower than `width` points lays the page out `width` CSS pixels wide (0.1 to 1). */
  previewZoom(tab: string, scale: number): Promise<void>
  openUrl(url: string): Promise<void>
  /** Asks the signed update feed for a newer build. Downloads nothing. */
  updateCheck(): Promise<unknown>
  /** Downloads, verifies, and installs the newest build, then restarts the app. */
  updateInstall(): Promise<void>
  onBatch(listener: (engineId: string, frames: readonly StreamFrame[]) => void): Unsubscribe
  onStream(listener: (engineId: string, state: StreamState, code?: string) => void): Unsubscribe
  /** An engine ended without being asked to. No code means it never exited on its own: a signal, or unknown. */
  onEngineExit(listener: (engineId: string, code: number | null, signal?: number) => void): Unsubscribe
  notifyStatus(): Promise<NotifyStatus>
  /** Shows macOS's permission prompt the first time; later calls return the answer. */
  notifyRequest(): Promise<NotifyStatus>
  notifySend(note: SystemNote): Promise<void>
  /** Clears the thread's notifications from Notification Center. */
  notifyClear(threadId: string): Promise<void>
  /** A thread a notification click opened before the window was listening, once. */
  notifyTakeOpened(): Promise<string | null>
  onNotificationOpen(listener: (threadId: string) => void): Unsubscribe
  voiceDevices(): Promise<readonly VoiceDevice[]>
  voiceModels(): Promise<readonly VoiceModel[]>
  /** Starts downloading a model from the host's fixed list; progress comes through `onVoiceModel`. */
  voiceModelDownload(id: string): Promise<void>
  voiceModelCancel(id: string): Promise<void>
  voiceModelRemove(id: string): Promise<readonly VoiceModel[]>
  /** Resolves with a session id once the microphone and recognizer run. */
  voiceStart(input: ListenInput): Promise<number>
  /** Ends listening; the text arrives as a `final` event. */
  voiceStop(session: number): Promise<void>
  /** Ends listening and drops what was heard. */
  voiceCancel(session: number): Promise<void>
  onVoice(listener: (event: VoiceEvent) => void): Unsubscribe
  onVoiceModel(listener: (progress: ModelProgress) => void): Unsubscribe
}

export interface PreviewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type PreviewAction = "back" | "forward" | "reload" | "stop"

export type PreviewScript =
  | { readonly action: "snapshot" }
  | { readonly action: "console" }
  | { readonly action: "network" }
  | { readonly action: "pickStart" }
  | { readonly action: "pickRead" }
  | { readonly action: "pickStop" }
  | { readonly action: "click"; readonly ref: string }
  | { readonly action: "type"; readonly ref: string; readonly text: string; readonly submit?: boolean }
  | { readonly action: "press"; readonly key: string }

/** What a preview's page is doing. The address and title come from the host, as the page reports them. */
export interface PreviewState {
  readonly tab: string
  readonly url?: string
  readonly title?: string
  readonly loading?: boolean
  /** The page was closed to make room for others; showing the tab loads it again. */
  readonly unloaded?: boolean
}

/** Unavailable outside the installed app; needs-approval waits on System Settings > General > Login Items. */
export type LoginItemStatus = "on" | "off" | "needs-approval" | "unavailable"
/** `no-systemd`: a Linux without systemd's user services, which keep the helper running. */
export type WakeServiceStatus = "on" | "off" | "unavailable" | "no-systemd"

export interface PhoneDevice {
  readonly id: string
  readonly name: string
  readonly addedAt: number
  readonly seenAt: number
  /** It asked for notifications. */
  readonly notifies: boolean
}

export interface PhonePushTarget {
  readonly device: string
  readonly subscription: unknown
  readonly origin: string
}

export interface PhoneStatus {
  readonly enabled: boolean
  readonly running: boolean
  /** The loopback port `tailscale serve` points at; the same from launch to launch. */
  readonly port: number
  readonly problem?: string
  readonly devices: readonly PhoneDevice[]
  readonly pairing?: { readonly code: string; readonly expiresAt: number }
  readonly shares: readonly PhoneShare[]
  readonly hooks: readonly PhoneHook[]
}

export interface QuickStatus {
  readonly enabled: boolean
  /** In the shortcut plugin's words, such as `Alt+Space`. */
  readonly shortcut: string
  readonly problem?: string
  /** `Alt+Space` on macOS, `Ctrl+Alt+Space` on Linux. */
  readonly defaultShortcut?: string
  /** A Wayland desktop holds the shortcut through its portal; `trigger` is its keys once it said. */
  readonly desktop?: boolean
  readonly trigger?: string
}

export interface QuickMessage {
  readonly text: string
  readonly image?: { readonly dataBase64: string; readonly mediaType: string; readonly width: number; readonly height: number; readonly name: string }
}

/** A workflow's webhook link, `POST /hook/<token>`. Only a fingerprint of the token is kept. */
export interface PhoneHook {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly createdAt: number
  readonly usedAt?: number
}

export interface NewPhoneHook extends PhoneHook {
  /** The link's secret, shown once. */
  readonly token: string
}

/** A read-only link: a thread at `/s/<token>`, or a published page at `/p/<token>/`. */
export interface PhoneShare {
  readonly id: string
  /** The secret in the link's address. */
  readonly token: string
  readonly kind: "thread" | "page"
  readonly title: string
  readonly threadId?: string
  readonly files?: number
  readonly bytes?: number
  readonly createdAt: number
}

export interface TailscaleStatus {
  readonly installed: boolean
  /** Connected to a tailnet. */
  readonly running: boolean
  /** This Mac's name on the tailnet, such as `mac.tail1234.ts.net`. */
  readonly name?: string
  /** The tailnet gives out HTTPS certificates, which `tailscale serve --https` needs. */
  readonly https: boolean
  /** The tailnet's port 8443 on this Mac goes to phone access. */
  readonly served: boolean
}

/** A paired phone's call: `device` is the phone's id, never its token. */
export interface PhoneCall {
  readonly id: number
  readonly device: string
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}
