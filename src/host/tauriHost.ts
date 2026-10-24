import { Channel, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { openUrl } from "@tauri-apps/plugin-opener"
import type { AgentDefinition, AndroidApp, AndroidDevice, AndroidStatus, ComputerAccess, ComputerApp, EditorId, EngineInfo, EngineStartInput, Host, HostInfo, ImportedSkill, ListenInput, LoginItemStatus, McpServer, ModelProgress, NotifyStatus, OtherTools, PreviewState, ProjectInstructions, RunningComputerApp, SimulatorApp, SimulatorDevice, SimulatorScreen, SimulatorStatus, StartupTiming, StreamFrame, StreamState, Unsubscribe, VoiceDevice, VoiceEvent, VoiceModel, PhoneCall, PhonePushTarget, NewPhoneHook, PhoneShare, PhoneStatus, QuickMessage, QuickStatus, RemoteCheck, TailscaleStatus, RemoteMachine, WakeServiceStatus, WorkspaceInfo, SignInsSupport } from "./types"
import { HostError, toHostError } from "./types"

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toHostError(error)
  }
}

function subscribe<T>(event: string, handler: (payload: T) => void): Unsubscribe {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<T>(event, (message) => handler(message.payload)).then((stop) => {
    if (disposed) stop()
    else unlisten = stop
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

interface BatchPayload {
  readonly engineId: string
  readonly frames: readonly StreamFrame[]
}

type BatchListener = (engineId: string, frames: readonly StreamFrame[]) => void

export function createTauriHost(): Host {
  const batchListeners = new Set<BatchListener>()
  return {
    kind: "tauri",
    info: () => call<HostInfo>("host_info"),
    startupReady: () => call<StartupTiming | null>("startup_ready"),
    engineStart: (input: EngineStartInput) => call<EngineInfo>("engine_start", { input }),
    engineStop: (engineId) => call<void>("engine_stop", { engineId }),
    engineList: () => call<EngineInfo[]>("engine_list"),
    rpc: (engineId, method, params = {}) => call<unknown>("control_rpc", { engineId, method, params }),
    systemEngine: () => call<EngineInfo>("system_engine"),
    connectionSecretSet: (connectionId, secret, target) => call<unknown>("connection_secret_set", { connectionId, secret, tool: target === "tool", connector: target === "connector" }),
    connectionSecretFromClipboard: (connectionId, target) => call<unknown>("connection_secret_from_clipboard", { connectionId, tool: target === "tool", connector: target === "connector" }),
    authOpen: (loginId) => call<void>("auth_open", { loginId }),
    authSubmitInput: (loginId, input) => call<unknown>("auth_submit_input", { loginId, input }),
    streamStart: (engineId, afterSeq, afterLiveSeq) => {
      // Batches arrive on a channel per stream; the host drops it, and Tauri frees it here, when
      // the stream ends or is restarted.
      const onBatch = new Channel<BatchPayload>((payload) => {
        for (const listener of batchListeners) listener(payload.engineId, payload.frames)
      })
      return call<void>("control_stream_start", { engineId, afterSeq, afterLiveSeq: afterLiveSeq ?? null, onBatch })
    },
    streamStop: (engineId) => call<void>("control_stream_stop", { engineId }),
    threadForget: (sessionId) => call<void>("thread_forget", { sessionId }),
    computerAccess: () => call<ComputerAccess>("computer_access"),
    computerRequestAccess: (kind) => call<ComputerAccess>("computer_request_access", { kind }),
    computerOpenSettings: (kind) => call<void>("computer_open_settings", { kind }),
    computerRunningApps: () => call<readonly RunningComputerApp[]>("computer_running_apps"),
    computerAllowed: () => call<readonly ComputerApp[]>("computer_allowed"),
    computerAllow: (bundleId) => call<readonly ComputerApp[]>("computer_allow", { bundleId }),
    computerDisallow: (bundleId) => call<readonly ComputerApp[]>("computer_disallow", { bundleId }),
    computerAct: (action, params) => call<unknown>("computer_act", { action, params }),
    simulatorStatus: () => call<SimulatorStatus>("simulator_status"),
    simulatorDevices: () => call<readonly SimulatorDevice[]>("simulator_devices"),
    simulatorBoot: (udid) => call<void>("simulator_boot", { udid }),
    simulatorShutdown: (udid) => call<void>("simulator_shutdown", { udid }),
    simulatorOpen: (udid) => call<void>("simulator_open", { udid }),
    simulatorScreenshot: (udid) => call<SimulatorScreen>("simulator_screenshot", { udid }),
    simulatorApps: (udid) => call<readonly SimulatorApp[]>("simulator_apps", { udid }),
    simulatorInstall: (udid) => call<SimulatorApp | null>("simulator_install", { udid }),
    simulatorLaunch: (udid, bundleId) => call<void>("simulator_launch", { udid, bundleId }),
    simulatorOpenUrl: (udid, url) => call<void>("simulator_open_url", { udid, url }),
    simulatorInput: (udid, input) => call<void>("simulator_input", { udid, input }),
    simulatorAgents: (on) => call<SimulatorStatus>("simulator_agents", { on }),
    androidStatus: () => call<AndroidStatus>("android_status"),
    androidDevices: () => call<readonly AndroidDevice[]>("android_devices"),
    androidBoot: (avd) => call<string>("android_boot", { avd }),
    androidShutdown: (serial) => call<void>("android_shutdown", { serial }),
    androidScreenshot: (serial) => call<SimulatorScreen>("android_screenshot", { serial }),
    androidApps: (serial) => call<readonly AndroidApp[]>("android_apps", { serial }),
    androidInstall: (serial) => call<AndroidApp | null>("android_install", { serial }),
    androidLaunch: (serial, packageName) => call<void>("android_launch", { serial, package: packageName }),
    androidOpenUrl: (serial, url) => call<void>("android_open_url", { serial, url }),
    androidInput: (serial, input) => call<void>("android_input", { serial, input }),
    androidAgents: (on) => call<AndroidStatus>("android_agents", { on }),
    workspacePick: (options) => call<WorkspaceInfo | null>("workspace_pick", { near: options?.near ?? null, related: options?.related === true }),
    appStarters: () => call<unknown>("app_starters"),
    appCreate: (name, starter) => call<unknown>("app_create", { name, starter }),
    archivePick: () => call<string | null>("archive_pick"),
    workspaceInspect: (path) => call<WorkspaceInfo>("workspace_inspect", { path }),
    workspaceReveal: (workspace, relative) => call<void>("workspace_reveal", { workspace, relative: relative ?? null }),
    workspaceOpenIn: (workspace, relative, editor: EditorId) =>
      call<void>("workspace_open_in", { workspace, relative: relative ?? null, editor }),
    openInApps: () => call<EditorId[]>("open_in_apps"),
    attachmentSave: (workspace, mediaType, data) => call<string>("attachment_save", { workspace, mediaType, data: Array.from(data) }),
    instructionsRead: (workspace) => call<ProjectInstructions>("instructions_read", { workspace }),
    instructionsWrite: (workspace, text) => call<ProjectInstructions>("instructions_write", { workspace, text }),
    mcpList: () => call<McpServer[]>("mcp_list"),
    mcpSave: (server, previous) => call<McpServer[]>("mcp_save", { server, previous: previous ?? null }),
    mcpSetEnabled: (name, enabled) => call<McpServer[]>("mcp_set_enabled", { name, enabled }),
    mcpRemove: (name) => call<McpServer[]>("mcp_remove", { name }),
    keepAwake: (on, display = false) => call<boolean>("keep_awake", { on, display }),
    quitGuard: (on) => call<void>("quit_guard", { on }),
    appQuit: () => call<void>("app_quit"),
    backgroundHold: (reasons, lines) => call<void>("background_hold", { reasons, ...(lines === undefined ? {} : { lines }) }),
    loginItem: () => call<LoginItemStatus>("login_item_status"),
    setLoginItem: (on) => call<LoginItemStatus>("login_item_set", { on }),
    wakeService: () => call<WakeServiceStatus>("wake_service_status"),
    setWakeService: (on) => call<WakeServiceStatus>("wake_service_set", { on }),
    launchWoken: () => call<boolean>("launch_woken"),
    remoteList: () => call<RemoteMachine[]>("remote_list"),
    remoteSave: (machine) => call<RemoteMachine[]>("remote_save", { id: machine.id ?? null, host: machine.host, engine: machine.engine ?? null }),
    remoteRemove: (id) => call<RemoteMachine[]>("remote_remove", { id }),
    remoteCheck: (id, folder) => call<RemoteCheck>("remote_check", { id, folder: folder ?? null }),
    sshHosts: () => call<string[]>("ssh_hosts"),
    phoneStatus: () => call<PhoneStatus>("phone_status"),
    setPhone: (on) => call<PhoneStatus>("phone_set", { on }),
    phonePair: () => call<PhoneStatus>("phone_pair"),
    phoneForget: (id) => call<PhoneStatus>("phone_forget", { id }),
    phoneAnswer: (id, ok, body) => call<void>("phone_answer", { id, ok, body }),
    onPhoneCall: (listener) => subscribe<PhoneCall>("phone:call", listener),
    onPhoneChanged: (listener) => subscribe<PhoneStatus>("phone:changed", listener),
    phoneSetPush: (device, push) => call<void>("phone_set_push", { device, push }),
    phonePushTargets: () => call<PhonePushTarget[]>("phone_push_targets"),
    phoneShareThread: (threadId, title) => call<PhoneShare>("phone_share_thread", { threadId, title }),
    phonePublish: () => call<PhoneShare | null>("phone_publish"),
    phoneUnshare: (id) => call<PhoneStatus>("phone_unshare", { id }),
    phoneHookCreate: (projectId, workflowId) => call<NewPhoneHook>("phone_hook_create", { projectId, workflowId }),
    phoneHookRemove: (id) => call<PhoneStatus>("phone_hook_remove", { id }),
    quickStatus: () => call<QuickStatus>("quick_status"),
    quickSet: (enabled, shortcut) => call<QuickStatus>("quick_set", { enabled, shortcut }),
    onQuickSubmit: (listener) => subscribe<QuickMessage>("quick:submit", listener),
    tailscaleStatus: () => call<TailscaleStatus>("tailscale_status"),
    tailscaleServe: (on) => call<TailscaleStatus>("tailscale_serve", { on }),
    onBackground: (listener) => subscribe<{ hidden: boolean; tray?: boolean }>("background:hidden", (payload) => listener(payload.hidden === true, payload.tray !== false)),
    notifyStatus: () => call<NotifyStatus>("notify_status"),
    notifyRequest: () => call<NotifyStatus>("notify_request"),
    notifySend: (note) => call<void>("notify_send", { note }),
    notifyClear: (threadId) => call<void>("notify_clear", { threadId }),
    notifyTakeOpened: () => call<string | null>("notify_take_opened"),
    onNotificationOpen: (listener) => subscribe<{ threadId: string }>("notification:open", (payload) => listener(payload.threadId)),
    voiceDevices: () => call<VoiceDevice[]>("voice_devices"),
    voiceModels: () => call<VoiceModel[]>("voice_models"),
    voiceModelDownload: (id) => call<void>("voice_model_download", { id }),
    voiceModelCancel: (id) => call<void>("voice_model_cancel", { id }),
    voiceModelRemove: (id) => call<VoiceModel[]>("voice_model_remove", { id }),
    voiceStart: (input: ListenInput) => call<number>("voice_start", { input }),
    voiceStop: (session) => call<void>("voice_stop", { session }),
    voiceCancel: (session) => call<void>("voice_cancel", { session }),
    onVoice: (listener) => subscribe<VoiceEvent>("voice:event", listener),
    onVoiceModel: (listener) => subscribe<ModelProgress>("voice:model", listener),
    shellsList: () => call<string[]>("shells_list"),
    skillImport: (workspace) => call<ImportedSkill | null>("skill_import", { workspace }),
    agentsList: (workspace) => call<AgentDefinition[]>("agents_list", { workspace }),
    agentSave: (workspace, agent, previous) => call<AgentDefinition[]>("agent_save", { workspace, agent, previous: previous ?? null }),
    agentRemove: (workspace, name) => call<AgentDefinition[]>("agent_remove", { workspace, name }),
    otherToolsScan: (workspace) => call<OtherTools>("other_tools_scan", { workspace: workspace ?? null }),
    otherSkillImport: (workspace, path) => call<ImportedSkill>("other_skill_import", { workspace, path }),
    otherAgentImport: (workspace, path) => call<AgentDefinition[]>("other_agent_import", { workspace, path }),
    mcpImport: (servers) => call<McpServer[]>("mcp_import", { servers }),
    stateLoad: () => call<unknown>("state_load"),
    stateSave: (value) => call<void>("state_save", { value }),
    onQuit: (save) => subscribe<null>("app:quitting", () => void save().finally(() => void call<void>("state_flushed").catch(() => undefined))),
    previewNative: true,
    previewOpen: (tab, url, bounds, hidden, project) => call<{ reachable: boolean }>("preview_open", { tab, url, bounds, ...(hidden === true ? { hidden: true } : {}), ...(project === undefined ? {} : { project }) }),
    signInsSaved: (project) => call<boolean>("sign_ins_saved", { project }),
    signInsSupport: () => call<SignInsSupport>("sign_ins_support"),
    signInsForget: (project) => call<void>("sign_ins_forget", { project }),
    previewBounds: (tab, bounds) => call<void>("preview_bounds", { tab, bounds }),
    previewZoom: (tab, scale) => call<void>("preview_zoom", { tab, scale }),
    previewAction: (tab, action) => call<void>("preview_action", { tab, action }),
    previewExternal: (tab) => call<void>("preview_external", { tab }),
    previewClose: (tab) => call<void>("preview_close", { tab }),
    previewRetain: (tabs) => call<void>("preview_retain", { tabs }),
    onPreview: (listener) => subscribe<PreviewState>("preview:state", listener),
    previewScript: (tab, script, anySite) => call<{ text: string }>("preview_script", { tab, script, anySite }),
    previewEval: (tab, expression, anySite) => call<{ text: string }>("preview_eval", { tab, expression, anySite }),
    previewScreenshot: (tab, anySite, width) => call<{ mediaType: "image/jpeg" | "image/png"; dataBase64: string }>("preview_screenshot", { tab, anySite, ...(width === undefined ? {} : { width }) }),
    updateCheck: () => call<unknown>("update_check"),
    updateInstall: () => call<void>("update_install"),
    openUrl: async (url) => {
      // The opener is allowed https only; anything else is refused here, where the caller hears of it.
      if (!/^https:\/\//i.test(url)) throw new HostError("LINK_REFUSED", "Only https links open in your browser.")
      try {
        await openUrl(url)
      } catch (error) {
        throw toHostError(error)
      }
    },
    onBatch: (listener) => {
      batchListeners.add(listener)
      return () => {
        batchListeners.delete(listener)
      }
    },
    onStream: (listener) =>
      subscribe<{ engineId: string; state: StreamState; code?: string }>("control:stream", (payload) => listener(payload.engineId, payload.state, payload.code)),
    onEngineExit: (listener) =>
      subscribe<{ engineId: string; code: number | null; signal?: number | null }>("engine:exit", (payload) => listener(payload.engineId, payload.code, payload.signal ?? undefined)),
  }
}
