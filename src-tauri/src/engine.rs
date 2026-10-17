//! Supervisor for `runrail control` sidecar processes: one engine per thread.
//!
//! Each engine owns one Runrail session and its own session directory, so concurrent threads
//! never share native task state. The host keeps the bearer token in memory only, performs RPC
//! on blocking worker threads, and forwards the SSE stream to the renderer in small batches.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use tauri::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::connections::{self, CredentialStorage, SYSTEM_ENGINE_ID};
use crate::error::{BridgeError, BridgeResult};
use crate::http::{self, ChunkDecoder, SseEvent, SseParser};
use crate::mcp::McpStore;
use crate::store::write_atomic;
use crate::workspace::{require_id, resolve_workspace};

/// Sends a named event with a JSON payload to the renderer.
pub type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Delivers one serialized `{ engineId, frames }` batch to the renderer.
pub type BatchSink = Arc<dyn Fn(String) + Send + Sync>;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);
const RPC_TIMEOUT: Duration = Duration::from_secs(120);
/// Turn-bearing methods resolve when the turn ends; cancellation goes through a second request.
const LONG_RPC_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
const MAX_RPC_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// How long the engine has to answer the stream request with its response head.
const STREAM_HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const BATCH_INTERVAL: Duration = Duration::from_millis(16);
const BATCH_FRAMES: usize = 64;
/// Server frames are capped at 1 MiB; allow the SSE field prefix on top.
const MAX_SSE_EVENT_BYTES: usize = 1_048_576 + 4096;
const REPLAY_EVENTS: u32 = 4096;
const MONITOR_INTERVAL: Duration = Duration::from_millis(500);
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(3);
const LOGIN_ENV_TIMEOUT: Duration = Duration::from_secs(5);

const LONG_METHODS: &[&str] = &[
    "task.start",
    "task.enqueue",
    "task.steer",
    "turn.enqueue",
    "turn.steer",
    "agent.run",
    "agent.runMany",
    "git.commit",
    "git.push",
    "git.pr.create",
    "check.run",
    "eval.mine",
    "eval.validate",
    "memory.source.sync",
    "session.compact",
    "session.transcript.compact",
    "session.import",
    "backend.switch",
    "provider.discover",
    "model.discover",
    "connector.invoke",
    "plugin.invoke",
    "plugins.invoke",
    "plugin.install",
    "plugins.install",
    "plugin.update",
    "plugins.update",
    "package.install",
    "packages.install",
    "package.update",
    "packages.update",
    "share.create",
];

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Behavior {
    pub mode: String,
    pub effort: String,
    pub permission_default: String,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
    /// Instructions every turn starts with, written to the behavior file as text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// The shell the thread's terminals run; one of the system's login shells.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Who may use what: this thread's grant per connector id or `mcp:<server>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrations: Option<std::collections::BTreeMap<String, String>>,
}

/// One tool permission rule written to the session behavior file. First match wins in core.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct PermissionRule {
    pub tool: String,
    #[serde(rename = "match")]
    pub pattern: String,
    pub policy: String,
}

const MAX_RULES: usize = 64;
/// The engine takes at most eight related folders (`control --add-dir`).
const MAX_FOLDERS: usize = 8;
/// The engine's own limit on behavior-file instruction text, in characters.
const MAX_INSTRUCTIONS: usize = 8 * 1024;

impl Default for Behavior {
    fn default() -> Self {
        Self {
            mode: "ask".into(),
            effort: "medium".into(),
            permission_default: "ask".into(),
            rules: Vec::new(),
            instructions: None,
            shell: None,
            integrations: None,
        }
    }
}

impl Behavior {
    fn validate(&self) -> BridgeResult<()> {
        let ok = matches!(self.mode.as_str(), "ask" | "auto" | "plan")
            && matches!(self.effort.as_str(), "off" | "low" | "medium" | "high" | "xhigh" | "max")
            && matches!(self.permission_default.as_str(), "allow" | "ask" | "deny")
            && self.rules.len() <= MAX_RULES
            && self.rules.iter().all(|rule| {
                !rule.tool.is_empty()
                    && rule.tool.len() <= 64
                    && rule.tool.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b':'))
                    && !rule.pattern.is_empty()
                    && rule.pattern.len() <= 256
                    && !rule.pattern.chars().any(char::is_control)
                    && matches!(rule.policy.as_str(), "allow" | "ask" | "deny")
            })
            && self.instructions.as_deref().is_none_or(|text| text.chars().count() <= MAX_INSTRUCTIONS && !text.contains('\0'))
            && self.shell.as_deref().is_none_or(crate::shells::is_login_shell)
            && self.integrations.as_ref().is_none_or(|grants| grants.len() <= MAX_INTEGRATIONS && grants.iter().all(|(key, grant)| valid_integration_key(key) && matches!(grant.as_str(), "off" | "read" | "ask" | "write")));
        if ok {
            Ok(())
        } else {
            Err(BridgeError::new("CONTROL_INVALID_INPUT", "behavior settings are invalid"))
        }
    }

    fn file_contents(&self) -> Value {
        let mut contents = json!({
            "version": 1,
            "mode": self.mode,
            "effort": self.effort,
            "permissions": { "default": self.permission_default, "rules": self.rules },
        });
        if let Some(text) = self.instructions.as_deref().filter(|text| !text.trim().is_empty()) {
            contents["instructions"] = json!({ "text": text });
        }
        if let Some(grants) = self.integrations.as_ref().filter(|grants| !grants.is_empty()) {
            contents["integrations"] = json!(grants);
        }
        contents
    }
}

const MAX_INTEGRATIONS: usize = 128;

/// A connector id, or `mcp:` and a server name, as the engine's behavior file takes them.
fn valid_integration_key(key: &str) -> bool {
    let name = key.strip_prefix("mcp:").unwrap_or(key);
    let mut bytes = name.bytes();
    name.len() <= 64 && bytes.next().is_some_and(|first| first.is_ascii_alphanumeric()) && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineStartInput {
    pub engine_id: String,
    pub workspace: String,
    pub backend: String,
    pub session_id: String,
    #[serde(default)]
    pub behavior: Option<Behavior>,
    #[serde(default)]
    pub model: Option<String>,
    /// The account the engine runs on. It fixes the provider, the address, and the credential.
    #[serde(default)]
    pub connection_id: Option<String>,
    /// The coding-tool connection a tool runs as. The engine resolves its login, folder, or key;
    /// the renderer names it only.
    #[serde(default)]
    pub tool_connection_id: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    /// The thread this one continues. The engine copies that thread's conversation in the first
    /// time it starts; the renderer names the thread, and the bridge finds its storage.
    #[serde(default)]
    pub continue_from: Option<String>,
    /// The person lets the agent use this thread's browser preview; off unless set.
    #[serde(default)]
    pub browser_tools: bool,
    /// Pages on any site, not only on this computer. Needs `browser_tools`.
    #[serde(default)]
    pub browser_any_site: bool,
    /// The agent may list, read and message the person's other threads; the renderer answers each call.
    #[serde(default)]
    pub thread_tools: bool,
    /// The agent may see and use apps the person allowed; this host answers each request.
    #[serde(default)]
    pub computer_tools: bool,
    /// The agent may make pictures with the image model the person picked; the
    /// engine asks that connection itself, so nothing here answers its calls.
    #[serde(default)]
    pub image_tools: bool,
    /// The project's related folders, which the agent may read and edit beside the workspace. Each
    /// must be a folder the person picked, as a project folder must.
    #[serde(default)]
    pub folders: Vec<String>,
    /// The remote machine the engine runs on, by its id in the host's list; the
    /// workspace is then a path on that machine.
    #[serde(default)]
    pub remote: Option<String>,
    /// Leaves out Nifra's tools, instructions, and check, which a Nifra project gets otherwise.
    #[serde(default)]
    pub no_nifra: bool,
}

impl EngineStartInput {
    fn normalized(mut self) -> BridgeResult<Self> {
        require_id(&self.engine_id, "engine id")?;
        require_id(&self.session_id, "session id")?;
        if !matches!(self.backend.as_str(), "native" | "replay" | "pi" | "codex" | "claude-code" | "copilot" | "opencode" | "gemini" | "goose") {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "backend is not supported"));
        }
        if let Some(remote) = &self.remote {
            // Keys, this Mac's folders, and its browser stay here: a remote engine gets none of them.
            let local_only = self.connection_id.is_some() || self.tool_connection_id.is_some() || self.continue_from.is_some() || !self.folders.is_empty() || self.browser_tools || self.computer_tools || self.image_tools;
            if self.engine_id == SYSTEM_ENGINE_ID || remote.len() > 40 || !remote.starts_with("rm-") || !crate::remote::valid_remote_path(&self.workspace) || local_only {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "a remote thread runs on what is set up on that machine"));
            }
        } else {
            self.workspace = resolve_workspace(&self.workspace)?.to_string_lossy().into_owned();
        }
        let behavior = self.behavior.take().unwrap_or_default();
        behavior.validate()?;
        self.behavior = Some(behavior);
        if self.model.as_deref().is_some_and(|model| !valid_model_token(model)) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "model selection is invalid"));
        }
        // The renderer names a connection, never a provider address or a credential: the engine
        // resolves both from the account it stored.
        if let Some(connection) = &self.connection_id {
            if !connections::valid_connection_id(connection) {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "connection is invalid"));
            }
            if self.backend != "native" || self.model.is_none() {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "a connection needs the native backend and a model"));
            }
        }
        if let Some(tool_connection) = &self.tool_connection_id {
            if !connections::valid_connection_id(tool_connection) {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "tool connection is invalid"));
            }
            if matches!(self.backend.as_str(), "native" | "replay") || self.connection_id.is_some() || self.engine_id == SYSTEM_ENGINE_ID {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "a tool connection needs a coding-tool backend"));
            }
        }
        if let Some(thinking) = &self.thinking {
            if !matches!(thinking.as_str(), "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra") {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "thinking level is invalid"));
            }
        }
        if (self.browser_any_site && !self.browser_tools) || (self.browser_tools && self.engine_id == SYSTEM_ENGINE_ID) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "browser use is invalid"));
        }
        if self.thread_tools && self.engine_id == SYSTEM_ENGINE_ID {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "thread tools are for a thread's engine"));
        }
        // Only the routes whose tool results carry a screenshot take the computer tools.
        if self.computer_tools && (self.engine_id == SYSTEM_ENGINE_ID || !matches!(self.backend.as_str(), "codex" | "claude-code")) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "computer tools are for a Codex or Claude Code thread"));
        }
        if self.image_tools && (self.engine_id == SYSTEM_ENGINE_ID || !matches!(self.backend.as_str(), "native" | "codex" | "claude-code")) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "image tools are for a Runrail, Codex, or Claude Code thread"));
        }
        if !self.folders.is_empty() {
            if self.folders.len() > MAX_FOLDERS || self.engine_id == SYSTEM_ENGINE_ID || !matches!(self.backend.as_str(), "native" | "codex" | "claude-code") {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "related folders are invalid"));
            }
            let workspace = PathBuf::from(&self.workspace);
            let mut folders: Vec<PathBuf> = Vec::with_capacity(self.folders.len());
            // One that is gone, was never picked, or overlaps another is left out, so it cannot stop the thread.
            for folder in &self.folders {
                let Ok(resolved) = resolve_workspace(folder) else { continue };
                let overlaps = |other: &Path| resolved.starts_with(other) || other.starts_with(&resolved);
                if !overlaps(&workspace) && !folders.iter().any(|taken| overlaps(taken)) {
                    folders.push(resolved);
                }
            }
            self.folders = folders.into_iter().map(|folder| folder.to_string_lossy().into_owned()).collect();
        }
        if let Some(parent) = &self.continue_from {
            require_id(parent, "thread to continue")?;
            if parent == &self.session_id || self.engine_id == SYSTEM_ENGINE_ID {
                return Err(BridgeError::new("CONTROL_INVALID_INPUT", "thread to continue is invalid"));
            }
        }
        Ok(self)
    }
}

/// A model id goes to the engine as one argument. It never starts with a hyphen, so it cannot be
/// read as a flag by the engine or by a coding tool the engine starts. Brackets are allowed for
/// Claude Code's context variants, such as `opus[1m]`.
fn valid_model_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/' | b'@' | b'+' | b'[' | b']'))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine_id: String,
    pub state: String,
    pub workspace: String,
    pub backend: String,
    pub session_id: String,
    pub behavior: Behavior,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// Increments for every spawned process, so the renderer can tell a reused engine from a
    /// restarted one (a restarted engine numbers its events from zero again).
    pub instance: u64,
    pub contract: Value,
}

static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

struct Engine {
    input: EngineStartInput,
    instance: u64,
    child: Mutex<Child>,
    address: SocketAddr,
    token: String,
    contract: Value,
    stream_stop: Mutex<Option<Arc<StreamStop>>>,
    exited: AtomicBool,
}

/// Ends one event stream. Shutting its socket wakes a read waiting on an idle engine, so an idle
/// stream blocks instead of waking on a timer to look at the flag.
#[derive(Default)]
struct StreamStop {
    stopped: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
}

impl StreamStop {
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut socket) = self.socket.lock() {
            if let Some(socket) = socket.take() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    /// Lets `stop` reach this socket; false when the stream was stopped first. The flag is read
    /// under the lock `stop` takes after setting it, so a stop never misses the socket.
    fn watch(&self, stream: &TcpStream) -> std::io::Result<bool> {
        let clone = stream.try_clone()?;
        let mut socket = self.socket.lock().map_err(|_| std::io::Error::other("stream stop lock poisoned"))?;
        if self.is_stopped() {
            return Ok(false);
        }
        *socket = Some(clone);
        Ok(true)
    }

    fn unwatch(&self) {
        if let Ok(mut socket) = self.socket.lock() {
            *socket = None;
        }
    }
}

impl Engine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            engine_id: self.input.engine_id.clone(),
            state: if self.exited.load(Ordering::Acquire) { "exited".into() } else { "running".into() },
            workspace: self.input.workspace.clone(),
            backend: self.input.backend.clone(),
            session_id: self.input.session_id.clone(),
            behavior: self.input.behavior.clone().unwrap_or_default(),
            model: self.input.model.clone(),
            connection_id: self.input.connection_id.clone(),
            instance: self.instance,
            contract: self.contract.clone(),
        }
    }

    fn stop_stream(&self) {
        if let Ok(mut guard) = self.stream_stop.lock() {
            if let Some(stop) = guard.take() {
                stop.stop();
            }
        }
    }

    /// SIGTERM first so the engine flushes session state and closes its terminals, then SIGKILL.
    fn terminate(&self) {
        self.exited.store(true, Ordering::Release);
        self.stop_stream();
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        terminate_child(&mut child);
    }
}

fn terminate_child(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: plain kill(2) on our own un-reaped child; the pid cannot be recycled
            // before we wait on it.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            let deadline = Instant::now() + STOP_GRACE;
            while Instant::now() < deadline {
                if !matches!(child.try_wait(), Ok(None)) {
                    return;
                }
                thread::sleep(Duration::from_millis(40));
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub struct Supervisor {
    engines: Mutex<HashMap<String, Arc<Engine>>>,
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    app_data: PathBuf,
    resource_dir: Option<PathBuf>,
    credentials: CredentialStorage,
    emit: Emitter,
    monitor_started: AtomicBool,
}

fn state_error() -> BridgeError {
    BridgeError::new("CONTROL_STATE", "engine state is unavailable")
}

fn reserved_error() -> BridgeError {
    BridgeError::new("CONTROL_INVALID_INPUT", "this engine belongs to the app")
}

impl Supervisor {
    pub fn new(app_data: PathBuf, resource_dir: Option<PathBuf>, credentials: CredentialStorage, emit: Emitter) -> Arc<Self> {
        Arc::new(Self {
            engines: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            app_data,
            resource_dir,
            credentials,
            emit,
            monitor_started: AtomicBool::new(false),
        })
    }

    pub fn app_data(&self) -> &Path {
        &self.app_data
    }

    pub fn credentials(&self) -> &CredentialStorage {
        &self.credentials
    }

    pub fn thread_dir(&self, session_id: &str) -> BridgeResult<PathBuf> {
        require_id(session_id, "session id")?;
        Ok(self.app_data.join("threads").join(session_id))
    }

    fn engine(&self, engine_id: &str) -> BridgeResult<Arc<Engine>> {
        let engines = self.engines.lock().map_err(|_| state_error())?;
        let engine = engines
            .get(engine_id)
            .cloned()
            .ok_or_else(|| BridgeError::new("ENGINE_NOT_RUNNING", "engine is not running"))?;
        if engine.exited.load(Ordering::Acquire) {
            return Err(BridgeError::new("ENGINE_NOT_RUNNING", "engine is not running"));
        }
        Ok(engine)
    }

    pub fn list(&self) -> BridgeResult<Vec<EngineInfo>> {
        let engines = self.engines.lock().map_err(|_| state_error())?;
        Ok(engines.values().map(|engine| engine.info()).collect())
    }

    /// Starts a project engine for the renderer. The system engine's ids are not the renderer's.
    pub fn start(self: &Arc<Self>, input: EngineStartInput) -> BridgeResult<EngineInfo> {
        if input.engine_id == SYSTEM_ENGINE_ID || input.session_id == SYSTEM_ENGINE_ID {
            return Err(reserved_error());
        }
        self.start_engine(input)
    }

    /// Returns the system engine, starting it when needed. It has no project and no model: it
    /// holds the account list, the vault, and running sign-ins, so connections work before any
    /// project is open. The host fixes its folder; the renderer cannot choose it.
    pub fn system(self: &Arc<Self>) -> BridgeResult<EngineInfo> {
        let workspace = self.app_data.join("system").join("workspace");
        std::fs::create_dir_all(&workspace)
            .map_err(|_| BridgeError::new("SESSION_STORAGE_INVALID", "system storage is unavailable"))?;
        self.start_engine(EngineStartInput {
            engine_id: SYSTEM_ENGINE_ID.into(),
            workspace: workspace.to_string_lossy().into_owned(),
            backend: "native".into(),
            session_id: SYSTEM_ENGINE_ID.into(),
            behavior: Some(Behavior { permission_default: "deny".into(), ..Behavior::default() }),
            model: None,
            connection_id: None,
            tool_connection_id: None,
            thinking: None,
            continue_from: None,
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: false,
            folders: Vec::new(),
            remote: None,
            no_nifra: false,
        })
    }

    fn start_engine(self: &Arc<Self>, input: EngineStartInput) -> BridgeResult<EngineInfo> {
        let input = input.normalized()?;
        let engine_id = input.engine_id.clone();
        let lock = {
            let mut locks = self.start_locks.lock().map_err(|_| state_error())?;
            locks.entry(engine_id.clone()).or_default().clone()
        };
        let started = match lock.lock() {
            Ok(_guard) => self.start_locked(input),
            Err(_) => Err(state_error()),
        };
        // The last start for this id takes its lock along; one still waiting holds another handle.
        if let Ok(mut locks) = self.start_locks.lock() {
            if locks.get(&engine_id).is_some_and(|held| Arc::ptr_eq(held, &lock) && Arc::strong_count(held) == 2) {
                locks.remove(&engine_id);
            }
        }
        started
    }

    fn start_locked(self: &Arc<Self>, input: EngineStartInput) -> BridgeResult<EngineInfo> {
        // Reuse a live engine with identical settings; replace anything else holding this engine
        // id or this session (a session directory has exactly one writer).
        let replaced: Vec<Arc<Engine>> = {
            let mut engines = self.engines.lock().map_err(|_| state_error())?;
            if let Some(existing) = engines.get(&input.engine_id) {
                if !existing.exited.load(Ordering::Acquire) && existing.input == input {
                    return Ok(existing.info());
                }
            }
            let ids: Vec<String> = engines
                .iter()
                .filter(|(id, engine)| **id == input.engine_id || engine.input.session_id == input.session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| engines.remove(id)).collect()
        };
        for engine in replaced {
            engine.terminate();
        }

        let session_dir = if input.engine_id == SYSTEM_ENGINE_ID {
            self.app_data.join("system").join("session")
        } else {
            self.thread_dir(&input.session_id)?
        };
        std::fs::create_dir_all(&session_dir)
            .map_err(|_| BridgeError::new("SESSION_STORAGE_INVALID", "thread storage is unavailable"))?;
        let config_path = session_dir.join("config.json");
        let behavior = input.behavior.clone().unwrap_or_default();
        let mut contents = behavior.file_contents();
        // The MCP list comes from the host's own store, never from the start request.
        if input.engine_id != SYSTEM_ENGINE_ID {
            if let Some(section) = McpStore::new(&self.app_data).behavior_section(&input.workspace) {
                contents["mcp"] = section;
            }
        }
        let config = serde_json::to_vec_pretty(&contents)
            .map_err(|_| BridgeError::new("CONTROL_INVALID_INPUT", "behavior settings are invalid"))?;
        write_atomic(&config_path, &config)?;

        let engine = match input.remote.clone() {
            Some(remote) => self.spawn_remote(input, &remote, &String::from_utf8_lossy(&config))?,
            None => {
                let mut command = self.launch_command(&input, &session_dir, &config_path)?;
                spawn_engine(&mut command, input, None)?
            }
        };
        let engine = Arc::new(engine);
        let info = engine.info();
        self.engines
            .lock()
            .map_err(|_| state_error())?
            .insert(info.engine_id.clone(), engine);
        self.ensure_monitor();
        Ok(info)
    }

    pub fn stop(&self, engine_id: &str) -> BridgeResult<()> {
        if engine_id == SYSTEM_ENGINE_ID {
            return Err(reserved_error());
        }
        let engine = self.engines.lock().map_err(|_| state_error())?.remove(engine_id);
        if let Some(engine) = engine {
            engine.terminate();
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let engines: Vec<Arc<Engine>> = match self.engines.lock() {
            Ok(mut engines) => engines.drain().map(|(_, engine)| engine).collect(),
            Err(_) => return,
        };
        let handles: Vec<_> = engines
            .into_iter()
            .map(|engine| thread::spawn(move || engine.terminate()))
            .collect();
        for handle in handles {
            let _ = handle.join();
        }
    }

    /// Stops any engine for the session and deletes its thread directory. User-initiated only.
    pub fn forget_thread(&self, session_id: &str) -> BridgeResult<()> {
        if session_id == SYSTEM_ENGINE_ID {
            return Err(reserved_error());
        }
        let dir = self.thread_dir(session_id)?;
        let owners: Vec<Arc<Engine>> = {
            let mut engines = self.engines.lock().map_err(|_| state_error())?;
            let ids: Vec<String> = engines
                .iter()
                .filter(|(_, engine)| engine.input.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| engines.remove(id)).collect()
        };
        for engine in owners {
            engine.terminate();
        }
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(BridgeError::new("SESSION_STORAGE_INVALID", "thread storage could not be removed")),
        }
    }

    pub fn rpc(&self, engine_id: &str, method: &str, params: Value) -> BridgeResult<Value> {
        if !valid_method(method) {
            return Err(BridgeError::new("CONTROL_INVALID_METHOD", "control method is invalid"));
        }
        if !params.is_object() {
            return Err(BridgeError::new("CONTROL_INVALID_REQUEST", "control params must be an object"));
        }
        let body = serde_json::to_vec(&json!({ "protocol": 1, "method": method, "params": params }))
            .map_err(|_| BridgeError::new("CONTROL_INVALID_REQUEST", "control request cannot be encoded"))?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(BridgeError::new("CONTROL_BODY_LIMIT", "control request is too large"));
        }
        let engine = self.engine(engine_id)?;
        let timeout = if LONG_METHODS.contains(&method) { LONG_RPC_TIMEOUT } else { RPC_TIMEOUT };
        let (status, bytes) = http::request(engine.address, &engine.token, "POST", "/rpc", Some(&body), timeout, MAX_RPC_RESPONSE_BYTES)?;
        parse_rpc_response(status, &bytes).map_err(with_login_shell_hint)
    }

    /// A control request from the renderer: checked against the host rules, then forwarded.
    pub fn renderer_rpc(&self, engine_id: &str, method: &str, params: Value) -> BridgeResult<Value> {
        connections::guard_renderer_rpc(engine_id, method, &params)?;
        self.rpc(engine_id, method, params)
    }

    /// Posts to one of the system engine's private endpoints. They sit outside `/rpc`, so the
    /// body skips the idempotency cache, the event log, and the journal.
    fn post_private(self: &Arc<Self>, path: &str, body: &[u8]) -> BridgeResult<Value> {
        self.system()?;
        let engine = self.engine(SYSTEM_ENGINE_ID)?;
        let (status, bytes) = http::request(engine.address, &engine.token, "POST", path, Some(body), RPC_TIMEOUT, MAX_RPC_RESPONSE_BYTES)?;
        parse_rpc_response(status, &bytes)
    }

    /// Hands a secret to the engine's vault. The answer is the account without the secret, and no
    /// other call returns it. Both host copies are wiped before this returns.
    #[cfg(test)]
    pub fn store_secret(self: &Arc<Self>, connection_id: &str, secret: Zeroizing<String>) -> BridgeResult<Value> {
        self.store_secret_for(connections::SecretOwner::Account, connection_id, secret)
    }

    /// Same, for a key that belongs to an account or to a coding-tool connection.
    pub fn store_secret_for(self: &Arc<Self>, owner: connections::SecretOwner, connection_id: &str, secret: Zeroizing<String>) -> BridgeResult<Value> {
        let mut body = connections::secret_body_for(owner, connection_id, &secret)?;
        drop(secret);
        let result = self.post_private("/secret", &body);
        body.zeroize();
        result
    }

    /// Sends the address a user landed on to a waiting sign-in. It carries a one-time code, so
    /// it takes the same private path as a secret.
    pub fn submit_sign_in_input(self: &Arc<Self>, login_id: &str, input: Zeroizing<String>) -> BridgeResult<Value> {
        let mut body = connections::sign_in_input_body(login_id, &input)?;
        drop(input);
        let result = self.post_private("/login-input", &body);
        body.zeroize();
        result
    }

    /// The page to open for a running sign-in. The engine names it and the flow's host list
    /// bounds it; nothing from the renderer takes part beyond the sign-in id.
    pub fn sign_in_url(self: &Arc<Self>, login_id: &str) -> BridgeResult<Url> {
        if !connections::valid_login_id(login_id) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "sign-in id is invalid"));
        }
        self.system()?;
        let status = self.rpc(SYSTEM_ENGINE_ID, "auth.login.status", json!({ "loginId": login_id }))?;
        let flows = self.rpc(SYSTEM_ENGINE_ID, "auth.flows", json!({}))?;
        connections::sign_in_target(&status, &flows)
    }

    pub fn health(&self, engine_id: &str) -> BridgeResult<Value> {
        let engine = self.engine(engine_id)?;
        let (status, bytes) = http::request(engine.address, &engine.token, "GET", "/health", None, RPC_TIMEOUT, MAX_RPC_RESPONSE_BYTES)?;
        if !(200..300).contains(&status) {
            return Err(BridgeError::new("CONTROL_UNAVAILABLE", "control engine is unhealthy").with_status(status));
        }
        serde_json::from_slice(&bytes).map_err(|_| BridgeError::new("CONTROL_INVALID_RESPONSE", "control response JSON is invalid"))
    }

    /// Starts (or restarts) forwarding the event stream from the given cursors.
    pub fn stream_start(self: &Arc<Self>, engine_id: &str, after_seq: i64, after_live_seq: Option<u64>, sink: BatchSink) -> BridgeResult<()> {
        if !(-1..=4_000_000).contains(&after_seq) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "event cursor is invalid"));
        }
        let engine = self.engine(engine_id)?;
        let stop = Arc::new(StreamStop::default());
        {
            let mut guard = engine.stream_stop.lock().map_err(|_| state_error())?;
            if let Some(previous) = guard.replace(stop.clone()) {
                previous.stop();
            }
        }
        let emit = self.emit.clone();
        let cursor = Cursor { seq: after_seq, live: after_live_seq };
        thread::Builder::new()
            .name(format!("runrail-stream-{engine_id}"))
            .spawn(move || run_stream(engine, cursor, stop, emit, sink))
            .map_err(|_| BridgeError::new("CONTROL_STREAM_FAILED", "event stream could not start"))?;
        Ok(())
    }

    pub fn stream_stop(&self, engine_id: &str) -> BridgeResult<()> {
        if let Some(engine) = self.engines.lock().map_err(|_| state_error())?.get(engine_id) {
            engine.stop_stream();
        }
        Ok(())
    }

    fn ensure_monitor(self: &Arc<Self>) {
        if self.monitor_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        let _ = thread::Builder::new().name("runrail-monitor".into()).spawn(move || loop {
            thread::sleep(MONITOR_INTERVAL);
            let Some(supervisor) = weak.upgrade() else {
                break;
            };
            let engines: Vec<(String, Arc<Engine>)> = match supervisor.engines.lock() {
                Ok(engines) => engines.iter().map(|(id, engine)| (id.clone(), engine.clone())).collect(),
                Err(_) => break,
            };
            for (id, engine) in engines {
                if engine.exited.load(Ordering::Acquire) {
                    continue;
                }
                let code = match engine.child.try_lock() {
                    Ok(mut child) => match child.try_wait() {
                        Ok(Some(status)) => Some((status.code(), exit_signal(&status))),
                        Ok(None) => None,
                        Err(_) => Some((None, None)),
                    },
                    Err(_) => None,
                };
                let Some((code, signal)) = code else {
                    continue;
                };
                engine.exited.store(true, Ordering::Release);
                engine.stop_stream();
                if let Ok(mut engines) = supervisor.engines.lock() {
                    if engines.get(&id).is_some_and(|current| Arc::ptr_eq(current, &engine)) {
                        engines.remove(&id);
                    }
                }
                (supervisor.emit)("engine:exit", json!({ "engineId": id, "code": code, "signal": signal }));
            }
        });
    }

    /// An engine on another machine: started over the thread's own SSH
    /// connection, which then forwards a port on this Mac's loopback to the engine's.
    fn spawn_remote(&self, input: EngineStartInput, remote_id: &str, config: &str) -> BridgeResult<Engine> {
        let remote = crate::remote::RemoteStore::new(&self.app_data).get(remote_id)?;
        let sockets = self.app_data.join("ssh");
        std::fs::create_dir_all(&sockets).map_err(|_| BridgeError::new("SESSION_STORAGE_INVALID", "thread storage is unavailable"))?;
        // Short, since a socket path is limited to about a hundred bytes.
        let control = sockets.join(format!("{:x}-{:x}.sock", std::process::id(), NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)));
        if control.as_os_str().len() > 100 {
            return Err(BridgeError::new("REMOTE_UNAVAILABLE", "Runrail's data folder path is too long for an SSH connection socket"));
        }
        let _ = std::fs::remove_file(&control);
        let script = crate::remote::engine_script(&remote, &input.session_id, &input.workspace, config, &remote_args(&input));
        let mut command = crate::remote::engine_command(&remote, &control, &script);
        command.envs(login_environment().vars.iter().map(|(key, value)| (key.as_str(), value.as_str())));
        let forward = move |address: SocketAddr| crate::remote::forward(&remote, &control, address);
        spawn_engine(&mut command, input, Some(Box::new(forward)))
    }

    /// The engine for a one-off job such as `runrail new`, with the same program and login
    /// environment a thread's engine gets.
    pub fn job_command(&self, cwd: &Path) -> BridgeResult<Command> {
        let (mut command, dir) = resolve_program(self.resource_dir.as_deref(), cwd)?;
        command.current_dir(dir);
        command.envs(login_environment().vars.iter().map(|(key, value)| (key.as_str(), value.as_str())));
        command.env("RUNRAIL_DESKTOP", "1");
        Ok(command)
    }

    fn launch_command(&self, input: &EngineStartInput, session_dir: &Path, config_path: &Path) -> BridgeResult<Command> {
        let mut args: Vec<String> = vec![
            "control".into(),
            "--backend".into(),
            input.backend.clone(),
            "--cwd".into(),
            input.workspace.clone(),
            "--session-dir".into(),
            session_dir.to_string_lossy().into_owned(),
            "--session-id".into(),
            input.session_id.clone(),
            "--config".into(),
            config_path.to_string_lossy().into_owned(),
            // Every engine shares one account list and one vault; the engine alone opens them.
            "--accounts-dir".into(),
            self.credentials.accounts_dir.to_string_lossy().into_owned(),
            "--credential-vault".into(),
            self.credentials.vault.flag().into(),
            "--port".into(),
            "0".into(),
            "--json".into(),
            // The engine stops when the stdin pipe this process holds closes, so a crash or a
            // kill that skips `stop_all` cannot leave an engine running.
            "--exit-on-stdin-close".into(),
        ];
        // The system engine runs no turns: it gets no transcript, worktrees, or terminal.
        if input.engine_id != SYSTEM_ENGINE_ID {
            args.extend([
                "--transcript-dir".into(),
                session_dir.join("transcript").to_string_lossy().into_owned(),
                "--worktree-root".into(),
                self.app_data.join("worktrees").to_string_lossy().into_owned(),
                // The work tree before each turn, so a message can be rewound with its files.
                "--checkpoints".into(),
            ]);
            if cfg!(unix) {
                args.push("--terminal".into());
                if let Some(shell) = input.behavior.as_ref().and_then(|behavior| behavior.shell.as_ref()) {
                    args.extend(["--terminal-shell".into(), shell.clone()]);
                }
            }
            if input.browser_tools {
                args.push("--browser-tools".into());
                if input.browser_any_site {
                    args.push("--browser-any-site".into());
                }
            }
            if input.thread_tools {
                args.push("--thread-tools".into());
            }
            if input.computer_tools {
                args.push("--computer-tools".into());
            }
            if input.image_tools {
                args.push("--image-tools".into());
            }
            for folder in &input.folders {
                args.extend(["--add-dir".into(), folder.clone()]);
            }
            if input.no_nifra {
                args.push("--no-nifra".into());
            }
        } else {
            // Its one look into thread folders: a thread's history, read before that thread's own
            // engine is up (`conversation.peek`).
            args.extend(["--threads-dir".into(), self.app_data.join("threads").to_string_lossy().into_owned()]);
        }
        if let Some(model) = &input.model {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(connection) = &input.connection_id {
            args.extend(["--connection".into(), connection.clone()]);
        }
        if let Some(tool_connection) = &input.tool_connection_id {
            args.extend(["--tool-connection".into(), tool_connection.clone()]);
        }
        if let Some(thinking) = &input.thinking {
            args.extend(["--thinking".into(), thinking.clone()]);
        }
        if let Some(parent) = &input.continue_from {
            args.extend([
                "--continue-from-dir".into(),
                self.thread_dir(parent)?.join("transcript").to_string_lossy().into_owned(),
                "--continue-from-session".into(),
                parent.clone(),
            ]);
        }
        let workspace = PathBuf::from(&input.workspace);
        let (mut command, cwd) = resolve_program(self.resource_dir.as_deref(), &workspace)?;
        command.args(&args).current_dir(cwd);
        command.envs(login_environment().vars.iter().map(|(key, value)| (key.as_str(), value.as_str())));
        command.env("RUNRAIL_DESKTOP", "1");
        // A release sidecar fetches the Claude Agent SDK here the first time it needs it.
        command.env("RUNRAIL_AGENT_SDK_DIR", self.app_data.join("agent-sdk"));
        Ok(command)
    }
}

/// The signal that ended a process, which then has no exit code: a crash or a kill, never a clean stop.
#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// The dev entry that registers this repository's Claude Agent SDK before the CLI runs, as the
/// release sidecar does; absent the SDK, the bare CLI runs and Claude Code uses print mode.
#[cfg(debug_assertions)]
fn dev_entry() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let entry = root.join("scripts/dev-engine.ts");
    (entry.is_file() && root.join("node_modules/@anthropic-ai/claude-agent-sdk").is_dir()).then_some(entry)
}

/// Resolution order: explicit override, the dev checkout (debug builds with `bun` on the login
/// PATH), bundled sidecar, sibling of the app binary, then `runrail` on the login PATH. A release
/// build runs only the engine shipped inside the app: an environment variable or a `runrail` on
/// the PATH would let whatever sets either replace it.
fn resolve_program(resource_dir: Option<&Path>, workspace: &Path) -> BridgeResult<(Command, PathBuf)> {
    resolve_program_for(resource_dir, workspace, !cfg!(debug_assertions))
}

fn resolve_program_for(resource_dir: Option<&Path>, workspace: &Path, release: bool) -> BridgeResult<(Command, PathBuf)> {
    if !release {
        if let Some(value) = std::env::var_os("RUNRAIL_CONTROL_BIN") {
            let path = PathBuf::from(value);
            if !path.is_absolute() || !path.is_file() {
                return Err(BridgeError::new("CONTROL_EXECUTABLE_INVALID", "configured Runrail executable is invalid"));
            }
            return Ok((Command::new(path), workspace.to_path_buf()));
        }
    }
    // Ahead of the bundled sidecar, which the Tauri build also copies next to debug binaries: a
    // dev build runs the current engine source, not the last compiled one. Its timings are not
    // release timings.
    #[cfg(debug_assertions)]
    if !release {
        let core_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../runrail");
        let cli = core_root.join("src/cli.ts");
        if let Some(bun) = find_on_path("bun").filter(|_| cli.is_file()) {
            let mut command = Command::new(bun);
            command.arg("run").arg(dev_entry().unwrap_or(cli));
            return Ok((command, core_root));
        }
    }
    let mut candidates = Vec::new();
    if let Some(dir) = resource_dir {
        for base in [dir.to_path_buf(), dir.join("bin")] {
            candidates.push(base.join(executable("runrail")));
            candidates.push(base.join(sidecar_name()));
        }
    }
    if let Some(parent) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        // Where Tauri installs the sidecar: beside the app, its target triple dropped.
        candidates.push(parent.join(executable("runrail")));
        candidates.push(parent.join(sidecar_name()));
        // The AppImage keeps the engine out of usr/bin, whose files linuxdeploy patches.
        if cfg!(target_os = "linux") {
            candidates.push(parent.join("../libexec/runrail/runrail"));
        }
    }
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Ok((Command::new(path), workspace.to_path_buf()));
    }
    if release {
        return Err(BridgeError::new("CONTROL_EXECUTABLE_MISSING", "Runrail's engine is missing from the app; reinstall Runrail"));
    }
    let program = find_on_path("runrail").unwrap_or_else(|| PathBuf::from("runrail"));
    Ok((Command::new(program), workspace.to_path_buf()))
}

/// The login shell's PATH (apps launched from Finder get a minimal one).
pub(crate) fn login_path() -> Option<String> {
    login_environment()
        .vars
        .iter()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("PATH").ok())
}

/// Looks a program up on the login-shell PATH.
pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = login_path()?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(executable(name)))
        .find(|candidate| candidate.is_file())
}

/// A program's file name on this system: Windows adds `.exe`.
fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
fn sidecar_name() -> &'static str {
    "runrail-aarch64-apple-darwin"
}

#[cfg(all(target_arch = "x86_64", target_os = "macos"))]
fn sidecar_name() -> &'static str {
    "runrail-x86_64-apple-darwin"
}

#[cfg(all(target_arch = "aarch64", target_os = "linux"))]
fn sidecar_name() -> &'static str {
    "runrail-aarch64-unknown-linux-gnu"
}

#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
fn sidecar_name() -> &'static str {
    "runrail-x86_64-unknown-linux-gnu"
}

#[cfg(all(target_arch = "x86_64", target_os = "windows"))]
fn sidecar_name() -> &'static str {
    "runrail-x86_64-pc-windows-msvc.exe"
}

#[cfg(not(any(
    all(target_arch = "aarch64", target_os = "macos"),
    all(target_arch = "x86_64", target_os = "macos"),
    all(target_arch = "aarch64", target_os = "linux"),
    all(target_arch = "x86_64", target_os = "linux"),
    all(target_arch = "x86_64", target_os = "windows"),
)))]
fn sidecar_name() -> &'static str {
    "runrail"
}

/// The user's login-shell environment, captured once. GUI apps on macOS inherit a minimal
/// launchd environment without the PATH entries that `bun`, `codex`, `claude`, and `pi` need.
/// Values are applied to the engine spawn only and never logged.
static LOGIN_ENVIRONMENT: OnceLock<LoginEnvironment> = OnceLock::new();

struct LoginEnvironment {
    vars: Vec<(String, String)>,
    /// Set when the shell could not be read; `vars` then carries a fallback PATH.
    failure: Option<LoginShellFailure>,
}

// Windows reads no login shell, so it has no failure to report.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoginShellFailure {
    TimedOut,
    Unreadable,
}

impl LoginEnvironment {
    #[cfg_attr(not(unix), allow(dead_code))]
    fn fallback(failure: LoginShellFailure) -> Self {
        let path = fallback_path(std::env::var_os("PATH"), std::env::var_os("HOME").map(PathBuf::from), |dir| dir.is_dir());
        Self { vars: vec![("PATH".into(), path)], failure: Some(failure) }
    }
}

fn login_environment() -> &'static LoginEnvironment {
    LOGIN_ENVIRONMENT.get_or_init(capture_login_environment)
}

#[cfg(unix)]
fn capture_login_environment() -> LoginEnvironment {
    const MARKER: &[u8] = b"__RUNRAIL_ENV_BEGIN__";
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| Path::new(shell).is_absolute() && Path::new(shell).is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", "printf '__RUNRAIL_ENV_BEGIN__'; env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return LoginEnvironment::fallback(LoginShellFailure::Unreadable);
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return LoginEnvironment::fallback(LoginShellFailure::Unreadable);
    };
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.by_ref().take(4 * 1024 * 1024).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let received = receiver.recv_timeout(LOGIN_ENV_TIMEOUT);
    let _ = child.kill();
    let _ = child.wait();
    let Ok(bytes) = received else {
        return LoginEnvironment::fallback(LoginShellFailure::TimedOut);
    };
    let vars = parse_login_environment(&bytes, MARKER);
    if vars.iter().any(|(key, _)| key == "PATH") {
        LoginEnvironment { vars, failure: None }
    } else {
        LoginEnvironment::fallback(LoginShellFailure::Unreadable)
    }
}

/// Windows GUI apps inherit the full user environment, so there is nothing to capture.
#[cfg(not(unix))]
fn capture_login_environment() -> LoginEnvironment {
    LoginEnvironment { vars: Vec::new(), failure: None }
}

/// PATH for engines when the login shell could not be read: the usual install folders that exist,
/// then the app's own PATH, so a slow or broken shell profile does not hide every coding tool.
#[cfg_attr(not(unix), allow(dead_code))]
fn fallback_path(current: Option<std::ffi::OsString>, home: Option<PathBuf>, is_dir: impl Fn(&Path) -> bool) -> String {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"]
        .into_iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home.filter(|home| home.is_absolute()) {
        dirs.extend([".local/bin", ".bun/bin", ".volta/bin", ".npm-global/bin", "Library/pnpm", ".cargo/bin"].map(|dir| home.join(dir)));
    }
    dirs.retain(|dir| is_dir(dir));
    let current = current.unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    for dir in std::env::split_paths(&current) {
        if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs)
        .unwrap_or(current)
        .to_string_lossy()
        .into_owned()
}

/// Codes meaning a program was not found, which the login shell's PATH usually fixes.
const MISSING_PROGRAM_CODES: [&str; 2] = ["CONTROL_EXECUTABLE_MISSING", "COMMAND_AGENT_NOT_FOUND"];

/// Says why a program may be missing when the login shell's PATH could not be read. Reads the
/// captured state without capturing it, so it never runs the shell itself.
fn with_login_shell_hint(error: BridgeError) -> BridgeError {
    login_shell_hint(error, LOGIN_ENVIRONMENT.get().and_then(|environment| environment.failure))
}

fn login_shell_hint(mut error: BridgeError, failure: Option<LoginShellFailure>) -> BridgeError {
    let Some(failure) = failure else {
        return error;
    };
    if !MISSING_PROGRAM_CODES.iter().any(|code| error.code == *code || error.message.contains(code)) {
        return error;
    }
    let reason = match failure {
        LoginShellFailure::TimedOut => format!("your login shell took over {} s to start", LOGIN_ENV_TIMEOUT.as_secs()),
        LoginShellFailure::Unreadable => "your login shell's PATH could not be read".into(),
    };
    error.message = format!("{} ({reason}, so only common install folders were searched)", error.message);
    error
}

#[cfg_attr(not(unix), allow(dead_code))]
fn parse_login_environment(bytes: &[u8], marker: &[u8]) -> Vec<(String, String)> {
    let Some(start) = bytes.windows(marker.len()).position(|window| window == marker) else {
        return Vec::new();
    };
    bytes[start + marker.len()..]
        .split(|byte| *byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok())
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| {
            !key.is_empty()
                && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                && !matches!(*key, "PWD" | "OLDPWD" | "SHLVL" | "_" | "TERM_SESSION_ID" | "RUNRAIL_CONTROL_TOKEN")
        })
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[derive(Debug, Deserialize)]
struct ReadyHandshake {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    token: String,
    #[serde(flatten)]
    contract: Map<String, Value>,
}

static NEXT_SOCKET: AtomicU64 = AtomicU64::new(0);

/// Turns the engine's own loopback address into the one this Mac reaches it at.
type Forward = Box<dyn FnOnce(SocketAddr) -> BridgeResult<SocketAddr>>;

/// What a remote engine is started with besides its folders, which its machine decides.
fn remote_args(input: &EngineStartInput) -> Vec<String> {
    // The terminal runs that machine's own shell; the one picked here may not be there.
    let mut args: Vec<String> = vec!["--backend".into(), input.backend.clone(), "--session-id".into(), input.session_id.clone(), "--port".into(), "0".into(), "--json".into(), "--exit-on-stdin-close".into(), "--checkpoints".into(), "--terminal".into()];
    if input.thread_tools {
        args.push("--thread-tools".into());
    }
    if input.no_nifra {
        args.push("--no-nifra".into());
    }
    if let Some(model) = &input.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(thinking) = &input.thinking {
        args.extend(["--thinking".into(), thinking.clone()]);
    }
    args
}

fn spawn_engine(command: &mut Command, input: EngineStartInput, forward: Option<Forward>) -> BridgeResult<Engine> {
    // stdin stays piped and unused: `Child` owns the write end for as long as the engine is tracked.
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => with_login_shell_hint(BridgeError::new(
                "CONTROL_EXECUTABLE_MISSING",
                "Runrail is not installed or not on PATH",
            )),
            _ => BridgeError::new("CONTROL_START_FAILED", "could not start the Runrail engine"),
        })?;
    let stdout = child.stdout.take();
    let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        thread::spawn(move || drain_tail(stderr, &tail));
    }
    let Some(stdout) = stdout else {
        terminate_child(&mut child);
        return Err(BridgeError::new("CONTROL_START_FAILED", "engine output is unavailable"));
    };
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = match reader.by_ref().take(256 * 1024).read_line(&mut line) {
            Ok(count) if count > 0 => Some(line),
            _ => None,
        };
        let _ = sender.send(result);
        let mut sink = [0_u8; 8192];
        while matches!(reader.read(&mut sink), Ok(count) if count > 0) {}
    });
    let fail = |child: &mut Child, code: &str, message: &str| {
        terminate_child(child);
        let detail = stderr_tail.lock().ok().and_then(|tail| error_code_in(&tail));
        let mut error = BridgeError::new(start_error_code(code, detail.as_deref()), message);
        if let Some(detail) = detail {
            error.message = format!("{message} ({detail})");
        }
        with_login_shell_hint(error)
    };
    let line = match receiver.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(Some(line)) => line,
        Ok(None) => {
            // Give stderr a moment to flush the failure reason.
            thread::sleep(Duration::from_millis(100));
            return Err(fail(&mut child, "CONTROL_START_FAILED", "engine exited before it was ready"));
        }
        Err(_) => return Err(fail(&mut child, "CONTROL_START_TIMEOUT", "engine did not become ready in time")),
    };
    let ready: ReadyHandshake = match serde_json::from_str(line.trim()) {
        Ok(ready) => ready,
        Err(_) => return Err(fail(&mut child, "CONTROL_HANDSHAKE_INVALID", "engine handshake is invalid")),
    };
    if ready.kind != "control.ready" || !valid_token(&ready.token) {
        return Err(fail(&mut child, "CONTROL_HANDSHAKE_INVALID", "engine handshake is invalid"));
    }
    let address = match http::loopback_address(&ready.url).and_then(|address| match forward {
        Some(forward) => forward(address),
        None => Ok(address),
    }) {
        Ok(address) => address,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error);
        }
    };
    Ok(Engine {
        instance: NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed),
        input,
        child: Mutex::new(child),
        address,
        token: ready.token,
        contract: Value::Object(ready.contract),
        stream_stop: Mutex::new(None),
        exited: AtomicBool::new(false),
    })
}

/// Keeps the last 4 KiB of stderr in memory for extracting a stable error code; never logged.
fn drain_tail(mut stderr: impl Read, tail: &Mutex<Vec<u8>>) {
    let mut buffer = [0_u8; 4096];
    while let Ok(count) = stderr.read(&mut buffer) {
        if count == 0 {
            break;
        }
        if let Ok(mut tail) = tail.lock() {
            tail.extend_from_slice(&buffer[..count]);
            let excess = tail.len().saturating_sub(4096);
            tail.drain(..excess);
        }
    }
}

/// Engine start refusals the renderer handles by name; every other failure stays a start failure.
const START_REFUSALS: [&str; 3] = ["CONNECTION_NOT_FOUND", "CONNECTION_INVALID", "ENDPOINT_DENIED"];

/// A start the engine refused for a reason the person can act on keeps that reason as its code.
fn start_error_code<'a>(code: &'a str, detail: Option<&'a str>) -> &'a str {
    detail.filter(|detail| START_REFUSALS.contains(detail)).unwrap_or(code)
}

/// Finds the last stable error code token (for example `BEHAVIOR_CONFIG_INVALID`) in engine
/// stderr so failures are diagnosable without surfacing free-form process output.
fn error_code_in(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    text.split(|char: char| !(char.is_ascii_uppercase() || char.is_ascii_digit() || char == '_'))
        .filter(|token| token.len() >= 6 && token.len() <= 64 && token.contains('_') && token.starts_with(|c: char| c.is_ascii_uppercase()))
        .last()
        .map(str::to_string)
}

fn valid_token(token: &str) -> bool {
    (16..=256).contains(&token.len())
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

fn valid_method(method: &str) -> bool {
    let bytes = method.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn bounded_code(value: Option<&str>) -> String {
    value
        .filter(|code| !code.is_empty() && code.len() <= 64 && code.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
        .unwrap_or("CONTROL_REQUEST_FAILED")
        .to_string()
}

fn bounded_message(value: Option<&str>) -> String {
    let message = value.unwrap_or("control request failed");
    message.chars().filter(|char| !char.is_control()).take(512).collect()
}

fn parse_rpc_response(status: u16, bytes: &[u8]) -> BridgeResult<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        BridgeError::new("CONTROL_INVALID_RESPONSE", "control response JSON is invalid").with_status(status)
    })?;
    if (200..300).contains(&status) && value.get("ok").and_then(Value::as_bool) == Some(true) {
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| BridgeError::new("CONTROL_INVALID_RESPONSE", "control response result is missing"));
    }
    let error = value.get("error");
    let (code, message) = match error {
        Some(Value::String(code)) => (Some(code.as_str()), None),
        Some(Value::Object(object)) => (
            object.get("code").and_then(Value::as_str),
            object.get("message").and_then(Value::as_str),
        ),
        _ => (None, None),
    };
    Err(BridgeError::new(bounded_code(code), bounded_message(message)).with_status(status))
}

#[derive(Debug, Clone, Copy)]
struct Cursor {
    seq: i64,
    live: Option<u64>,
}

enum StreamEnd {
    Stopped,
    Failed(BridgeError),
}

fn run_stream(engine: Arc<Engine>, mut cursor: Cursor, stop: Arc<StreamStop>, emit: Emitter, sink: BatchSink) {
    let engine_id = engine.input.engine_id.clone();
    let mut attempt: u32 = 0;
    let mut reported = false;
    loop {
        if stop.is_stopped() || engine.exited.load(Ordering::Acquire) {
            break;
        }
        // Reported when the stream opens, not when it ends: a healthy stream stays open.
        let end = stream_once(&engine, &mut cursor, &stop, &sink, &mut || {
            attempt = 0;
            if reported {
                emit("control:stream", json!({ "engineId": engine_id, "state": "connected" }));
                reported = false;
            }
        });
        match end {
            StreamEnd::Stopped => break,
            StreamEnd::Failed(error) => {
                if stop.is_stopped() || engine.exited.load(Ordering::Acquire) {
                    break;
                }
                if !reported {
                    emit("control:stream", json!({ "engineId": engine_id, "state": "reconnecting", "code": error.code }));
                    reported = true;
                }
                attempt = attempt.saturating_add(1);
                let delay = Duration::from_millis((150_u64 << attempt.min(5)).min(4_000));
                let deadline = Instant::now() + delay;
                while Instant::now() < deadline {
                    if stop.is_stopped() || engine.exited.load(Ordering::Acquire) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
            }
        }
    }
}

fn stream_once(engine: &Engine, cursor: &mut Cursor, stop: &StreamStop, sink: &BatchSink, opened: &mut dyn FnMut()) -> StreamEnd {
    let stream = match http::connect(engine.address) {
        Ok(stream) => stream,
        Err(error) => return StreamEnd::Failed(error),
    };
    match stop.watch(&stream) {
        Ok(true) => {}
        Ok(false) => return StreamEnd::Stopped,
        Err(error) => return StreamEnd::Failed(error.into()),
    }
    let end = read_stream(engine, stream, cursor, stop, sink, opened);
    stop.unwatch();
    end
}

fn read_stream(engine: &Engine, mut stream: TcpStream, cursor: &mut Cursor, stop: &StreamStop, sink: &BatchSink, opened: &mut dyn FnMut()) -> StreamEnd {
    // A read that `stop` woke by shutting the socket fails; that is a stop, not a lost engine.
    let fail = |error: BridgeError| if stop.is_stopped() { StreamEnd::Stopped } else { StreamEnd::Failed(error) };
    if stream.set_read_timeout(Some(STREAM_HEAD_TIMEOUT)).is_err() {
        return fail(BridgeError::new("CONTROL_STREAM_FAILED", "event stream could not be configured"));
    }
    let live = cursor.live.map(|value| format!("&afterLiveSeq={value}")).unwrap_or_default();
    let request = format!(
        "GET /events?afterSeq={}&maxEvents={REPLAY_EVENTS}{live} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
        cursor.seq, engine.address, engine.token
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return fail(error.into());
    }
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut pending = Vec::new();
    let head_deadline = Instant::now() + STREAM_HEAD_TIMEOUT;
    let (head, consumed) = loop {
        if stop.is_stopped() {
            return StreamEnd::Stopped;
        }
        match stream.read(&mut buffer) {
            Ok(0) => return fail(BridgeError::new("CONTROL_STREAM_CLOSED", "event stream closed")),
            Ok(count) => {
                pending.extend_from_slice(&buffer[..count]);
                if Instant::now() > head_deadline {
                    return fail(BridgeError::new("CONTROL_TIMEOUT", "event stream did not respond"));
                }
                match http::parse_head(&pending) {
                    Ok(Some(parsed)) => break parsed,
                    Ok(None) => {}
                    Err(error) => return fail(error),
                }
            }
            Err(error) if is_timeout(&error) => return fail(BridgeError::new("CONTROL_TIMEOUT", "event stream did not respond")),
            Err(error) => return fail(error.into()),
        }
    };
    if head.status != 200 || !head.content_type.starts_with("text/event-stream") {
        return fail(BridgeError::new("CONTROL_STREAM_REJECTED", "event stream was rejected").with_status(head.status));
    }
    opened();
    let mut decoder = head.chunked.then(ChunkDecoder::default);
    let mut parser = SseParser::new(MAX_SSE_EVENT_BYTES);
    let mut events: Vec<SseEvent> = Vec::new();
    let mut batch: Vec<BatchFrame> = Vec::new();
    let mut batch_started: Option<Instant> = None;
    let mut decoded = Vec::new();
    let mut input = pending.split_off(consumed);
    let mut read_timeout = Some(STREAM_HEAD_TIMEOUT);
    loop {
        if !input.is_empty() {
            decoded.clear();
            let bytes: &[u8] = match decoder.as_mut() {
                Some(decoder) => {
                    if let Err(error) = decoder.push(&input, &mut decoded) {
                        return fail(error);
                    }
                    &decoded
                }
                None => &input,
            };
            if let Err(error) = parser.push(bytes, &mut events) {
                return fail(error);
            }
            input.clear();
            for event in events.drain(..) {
                let kind = match event.event.as_str() {
                    "runrail.event" => "event",
                    "runrail.live" => "live",
                    _ => continue,
                };
                // Passed through as raw JSON: the host only reads the cursors, and the page
                // parses each frame once.
                let Ok(data) = RawValue::from_string(event.data) else {
                    return fail(BridgeError::new("CONTROL_INVALID_EVENT", "event frame is invalid"));
                };
                let cursors = frame_cursors(data.get());
                if kind == "event" {
                    if let Some(seq) = cursors.seq.as_ref().and_then(serde_json::Number::as_i64) {
                        cursor.seq = cursor.seq.max(seq);
                    }
                } else if let Some(live) = cursors.live_seq.as_ref().and_then(serde_json::Number::as_u64) {
                    cursor.live = Some(cursor.live.unwrap_or(0).max(live));
                }
                batch.push(BatchFrame { kind, data });
                batch_started.get_or_insert_with(Instant::now);
            }
            if decoder.as_ref().is_some_and(ChunkDecoder::is_done) {
                flush(sink, &engine.input.engine_id, &mut batch, &mut batch_started, stop.is_stopped());
                return fail(BridgeError::new("CONTROL_STREAM_CLOSED", "event stream closed"));
            }
        }
        if batch.len() >= BATCH_FRAMES || batch_started.is_some_and(|started| started.elapsed() >= BATCH_INTERVAL) {
            flush(sink, &engine.input.engine_id, &mut batch, &mut batch_started, stop.is_stopped());
        }
        if stop.is_stopped() {
            return StreamEnd::Stopped;
        }
        // Idle, the read blocks until the engine writes or `stop` shuts the socket. A pending batch
        // waits only for the rest of its window, so the last frame of a burst is not held back.
        let wait = batch_started.map(|started| BATCH_INTERVAL.saturating_sub(started.elapsed()).max(Duration::from_millis(1)));
        if wait != read_timeout {
            if stream.set_read_timeout(wait).is_err() {
                return fail(BridgeError::new("CONTROL_STREAM_FAILED", "event stream could not be configured"));
            }
            read_timeout = wait;
        }
        match stream.read(&mut buffer) {
            Ok(0) => {
                flush(sink, &engine.input.engine_id, &mut batch, &mut batch_started, stop.is_stopped());
                return fail(BridgeError::new("CONTROL_STREAM_CLOSED", "event stream closed"));
            }
            Ok(count) => input.extend_from_slice(&buffer[..count]),
            Err(error) if is_timeout(&error) => {}
            Err(error) => {
                flush(sink, &engine.input.engine_id, &mut batch, &mut batch_started, stop.is_stopped());
                return fail(error.into());
            }
        }
    }
}

#[derive(Serialize)]
struct BatchFrame {
    kind: &'static str,
    data: Box<RawValue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchPayload<'a> {
    engine_id: &'a str,
    frames: &'a [BatchFrame],
}

#[derive(Deserialize, Default)]
struct FrameCursors {
    seq: Option<serde_json::Number>,
    #[serde(rename = "liveSeq")]
    live_seq: Option<serde_json::Number>,
}

/// Reads a frame's cursors without building its tree. A frame that is not an object, or whose
/// cursors are not numbers, has none.
fn frame_cursors(json: &str) -> FrameCursors {
    if !json.starts_with('{') {
        return FrameCursors::default();
    }
    serde_json::from_str(json).unwrap_or_default()
}

fn flush(sink: &BatchSink, engine_id: &str, batch: &mut Vec<BatchFrame>, started: &mut Option<Instant>, stopped: bool) {
    *started = None;
    if !batch.is_empty() && !stopped {
        if let Ok(payload) = serde_json::to_string(&BatchPayload { engine_id, frames: batch }) {
            sink(payload);
        }
    }
    batch.clear();
}

fn is_timeout(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A remote engine end to end: `RUNRAIL_R2_SSH_CONFIG` names an ssh config whose host `r2test`
    /// is a throwaway server, and `RUNRAIL_R2_ENGINE` how that machine starts Runrail.
    #[test]
    #[ignore = "needs an SSH server set up for it"]
    fn a_remote_engine_answers_and_streams_through_its_forward() {
        let (Ok(_), Ok(engine)) = (std::env::var("RUNRAIL_R2_SSH_CONFIG"), std::env::var("RUNRAIL_R2_ENGINE")) else { return };
        // Short: an SSH socket path must fit in about a hundred bytes.
        let root = PathBuf::from(format!("/tmp/rr-r2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let workspace = root.join("remote workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let credentials = CredentialStorage { accounts_dir: root.join("appdata/accounts"), vault: connections::Vault::File };
        let supervisor = Supervisor::new(root.join("appdata"), None, credentials, Arc::new(|_, _| {}));
        let remotes = crate::remote::RemoteStore::new(&root.join("appdata"));
        let id = remotes.save(None, "r2test", Some(&engine), |_| true).unwrap()[0].id.clone();
        let input = EngineStartInput {
            engine_id: "r1".into(),
            workspace: workspace.to_string_lossy().into_owned(),
            backend: "replay".into(),
            session_id: "r2live".into(),
            behavior: Some(Behavior { mode: "auto".into(), ..Behavior::default() }),
            model: None,
            connection_id: None,
            tool_connection_id: None,
            thinking: None,
            continue_from: None,
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: false,
            folders: Vec::new(),
            remote: Some(id),
            no_nifra: false,
        };
        let info = supervisor.start(input).expect("remote engine starts");
        assert_eq!(info.state, "running");
        assert!(supervisor.rpc("r1", "control.describe", json!({})).unwrap().is_object());
        assert_eq!(supervisor.health("r1").unwrap().get("ok"), Some(&Value::Bool(true)));
        let batches: Arc<Mutex<Vec<Value>>> = Arc::default();
        let seen = batches.clone();
        supervisor.stream_start("r1", -1, None, Arc::new(move |payload| seen.lock().unwrap().push(serde_json::from_str(&payload).unwrap()))).unwrap();
        assert!(supervisor.rpc("r1", "turn.enqueue", json!({ "message": "hello" })).is_ok());
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && batches.lock().unwrap().is_empty() {
            thread::sleep(Duration::from_millis(100));
        }
        assert!(!batches.lock().unwrap().is_empty(), "the stream came through the forward");
        // The behavior file was written on that machine, in its own folder for the thread.
        let home = std::env::var("HOME").unwrap();
        assert!(Path::new(&home).join(".runrail/remote/r2live/config.json").is_file());
        supervisor.stop("r1").unwrap();
        assert!(supervisor.rpc("r1", "control.describe", json!({})).is_err());
        let _ = std::fs::remove_dir_all(Path::new(&home).join(".runrail/remote/r2live"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_finished_start_leaves_no_lock_behind() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-start-locks-{}", std::process::id()));
        let credentials = CredentialStorage { accounts_dir: root.join("appdata/accounts"), vault: connections::Vault::File };
        let supervisor = Supervisor::new(root.join("appdata"), None, credentials, Arc::new(|_, _| {}));
        std::fs::create_dir_all(root.join("project")).unwrap();
        for id in ["a1", "a2", "a3"] {
            let input = EngineStartInput {
                engine_id: id.into(),
                workspace: root.join("project").to_string_lossy().into_owned(),
                backend: "native".into(),
                session_id: id.into(),
                behavior: None,
                model: Some("gpt-5.5".into()),
                connection_id: Some("nobody".into()),
                tool_connection_id: None,
                thinking: None,
                continue_from: None,
                browser_tools: false,
                browser_any_site: false,
                thread_tools: false,
                computer_tools: false,
                image_tools: false,
                folders: Vec::new(),
                remote: None,
                no_nifra: false,
            };
            assert!(supervisor.start(input).is_err());
        }
        assert!(supervisor.start_locks.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn image_tools_go_only_to_a_thread_on_a_route_that_takes_them() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-image-tools-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let input = |engine_id: &str, backend: &str| EngineStartInput {
            engine_id: engine_id.into(),
            workspace: root.to_string_lossy().into_owned(),
            backend: backend.into(),
            session_id: "s1".into(),
            behavior: None,
            model: None,
            connection_id: None,
            tool_connection_id: None,
            thinking: None,
            continue_from: None,
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: true,
            folders: Vec::new(),
            remote: None,
            no_nifra: false,
        };
        for backend in ["native", "codex", "claude-code"] {
            assert!(input("e1", backend).normalized().is_ok());
        }
        assert!(input("e1", "pi").normalized().is_err());
        assert!(input(SYSTEM_ENGINE_ID, "native").normalized().is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_release_build_runs_only_the_engine_inside_the_app() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-release-engine-{}", std::process::id()));
        let resources = root.join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        let missing = resolve_program_for(Some(&resources), &root, true).err().expect("nothing bundled");
        assert_eq!(missing.code, "CONTROL_EXECUTABLE_MISSING");
        std::fs::write(resources.join(sidecar_name()), b"").unwrap();
        let (command, _) = resolve_program_for(Some(&resources), &root, true).unwrap();
        assert_eq!(Path::new(command.get_program()), resources.join(sidecar_name()));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn login_environment_parsing_skips_noise_and_shell_state() {
        let raw = b"motd banner\n__RUNRAIL_ENV_BEGIN__PATH=/opt/bin:/usr/bin\0PWD=/x\0SHLVL=2\0MULTI=a\nb\0BAD-KEY=1\0EMPTY=\0";
        let env = parse_login_environment(raw, b"__RUNRAIL_ENV_BEGIN__");
        assert_eq!(
            env,
            vec![
                ("PATH".to_string(), "/opt/bin:/usr/bin".to_string()),
                ("MULTI".to_string(), "a\nb".to_string()),
                ("EMPTY".to_string(), String::new()),
            ]
        );
        assert!(parse_login_environment(b"no marker", b"__RUNRAIL_ENV_BEGIN__").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn fallback_path_puts_existing_install_folders_before_the_app_path() {
        let present = ["/opt/homebrew/bin", "/Users/me/.bun/bin", "/Users/me/.local/bin"];
        let path = fallback_path(Some("/usr/bin:/opt/homebrew/bin::/bin".into()), Some(PathBuf::from("/Users/me")), |dir| {
            present.iter().any(|known| dir == Path::new(known))
        });
        assert_eq!(path, "/opt/homebrew/bin:/Users/me/.local/bin:/Users/me/.bun/bin:/usr/bin:/bin");
        let bare = fallback_path(None, Some(PathBuf::from("relative")), |_| true);
        assert!(bare.starts_with("/opt/homebrew/bin:"), "{bare}");
        assert!(bare.ends_with(":/usr/bin:/bin:/usr/sbin:/sbin"), "{bare}");
        assert!(!bare.contains("relative"), "{bare}");
    }

    #[test]
    fn missing_program_errors_say_the_login_shell_was_not_read() {
        let missing = BridgeError::new("COMMAND_AGENT_NOT_FOUND", "Codex app-server command was not found");
        assert_eq!(login_shell_hint(missing.clone(), None), missing);
        let hinted = login_shell_hint(missing, Some(LoginShellFailure::TimedOut));
        assert_eq!(hinted.code, "COMMAND_AGENT_NOT_FOUND");
        assert!(hinted.message.contains("took over 5 s"), "{}", hinted.message);
        let start = BridgeError::new("CONTROL_START_FAILED", "engine exited before it was ready (COMMAND_AGENT_NOT_FOUND)");
        assert!(login_shell_hint(start, Some(LoginShellFailure::Unreadable)).message.contains("PATH could not be read"));
        let other = BridgeError::new("CONTROL_TASK_BUSY", "task is busy");
        assert_eq!(login_shell_hint(other.clone(), Some(LoginShellFailure::Unreadable)), other);
    }

    #[test]
    fn batches_pass_frames_through_unchanged() {
        let payloads: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = payloads.clone();
        let sink: BatchSink = Arc::new(move |payload| seen.lock().unwrap().push(payload));
        let frame = r#"{"seq":7,"type":"assistant.delta","text":"a \"quoted\" \u00e9 é"}"#;
        let mut batch = vec![BatchFrame { kind: "event", data: RawValue::from_string(format!(" {frame}\n")).unwrap() }];
        let mut started = Some(Instant::now());
        flush(&sink, "t1", &mut batch, &mut started, false);
        assert!(batch.is_empty() && started.is_none());
        assert_eq!(payloads.lock().unwrap().as_slice(), [format!(r#"{{"engineId":"t1","frames":[{{"kind":"event","data":{frame}}}]}}"#)]);
        assert_eq!(frame_cursors(frame).seq.and_then(|seq| seq.as_i64()), Some(7));
        assert_eq!(frame_cursors(r#"{"liveSeq":3}"#).live_seq.and_then(|live| live.as_u64()), Some(3));
        assert!(frame_cursors("[7]").seq.is_none());
        assert!(frame_cursors(r#"{"seq":"7"}"#).seq.is_none());
        let mut stopped = vec![BatchFrame { kind: "live", data: RawValue::from_string("{}".into()).unwrap() }];
        flush(&sink, "t1", &mut stopped, &mut None, true);
        assert!(stopped.is_empty());
        assert_eq!(payloads.lock().unwrap().len(), 1, "a stopped stream sends nothing");
    }

    #[cfg(unix)]
    fn test_engine(address: SocketAddr) -> Engine {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        Engine {
            input: EngineStartInput {
                engine_id: "t1".into(),
                workspace: "/tmp".into(),
                backend: "native".into(),
                session_id: "t1".into(),
                behavior: None,
                model: None,
                connection_id: None,
                tool_connection_id: None,
                thinking: None,
                continue_from: None,
                browser_tools: false,
                browser_any_site: false,
                thread_tools: false,
                computer_tools: false,
                image_tools: false,
                folders: Vec::new(),
                remote: None,
                no_nifra: false,
            },
            instance: 0,
            child: Mutex::new(child),
            address,
            token: "x".repeat(32),
            contract: Value::Null,
            stream_stop: Mutex::new(None),
            exited: AtomicBool::new(false),
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_idle_stream_stops_at_once() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n").unwrap();
            // Open and silent, as an idle engine's stream is, until the client goes.
            let _ = socket.read(&mut request);
        });
        let engine = Arc::new(test_engine(address));
        let stop = Arc::new(StreamStop::default());
        let (done_tx, done_rx) = mpsc::channel();
        let reader = {
            let (engine, stop) = (engine.clone(), stop.clone());
            thread::spawn(move || {
                let sink: BatchSink = Arc::new(|_| {});
                let mut cursor = Cursor { seq: 0, live: None };
                let end = stream_once(&engine, &mut cursor, &stop, &sink, &mut || {});
                done_tx.send((Instant::now(), matches!(end, StreamEnd::Stopped))).unwrap();
            })
        };
        thread::sleep(Duration::from_millis(400));
        assert!(done_rx.try_recv().is_err(), "an idle stream keeps reading");
        let stopped_at = Instant::now();
        stop.stop();
        let (ended_at, stopped) = done_rx.recv_timeout(Duration::from_secs(2)).expect("the stop wakes the read");
        assert!(stopped, "a stop ends as a stop, not a lost engine");
        assert!(ended_at - stopped_at < Duration::from_millis(100), "took {:?}", ended_at - stopped_at);
        reader.join().unwrap();
        server.join().unwrap();
        terminate_child(&mut engine.child.lock().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_lone_event_is_delivered_within_one_batch_window() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent_tx, sent_rx) = mpsc::channel::<Instant>();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n").unwrap();
            for seq in 1..=30 {
                thread::sleep(Duration::from_millis(100));
                sent_tx.send(Instant::now()).unwrap();
                socket.write_all(format!("event: runrail.event\ndata: {{\"seq\":{seq}}}\n\n").as_bytes()).unwrap();
            }
            thread::sleep(Duration::from_millis(150));
        });
        let engine = test_engine(address);
        let (got_tx, got_rx) = mpsc::channel::<Instant>();
        let got_tx = Mutex::new(got_tx);
        let sink: BatchSink = Arc::new(move |_| {
            let _ = got_tx.lock().unwrap().send(Instant::now());
        });
        let stop = StreamStop::default();
        let mut cursor = Cursor { seq: 0, live: None };
        let _ = stream_once(&engine, &mut cursor, &stop, &sink, &mut || {});
        server.join().unwrap();
        terminate_child(&mut engine.child.lock().unwrap());
        let mut delays: Vec<f64> = sent_rx.try_iter().zip(got_rx.try_iter()).map(|(sent, got)| (got - sent).as_secs_f64() * 1000.0).collect();
        delays.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(delays.len(), 30, "one batch per lone event");
        eprintln!("lone event latency: p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms", delays[15], delays[28], delays[29]);
        // The window is 16 ms; the slack absorbs scheduling noise on a loaded machine.
        assert!(delays[28] < 30.0, "p95 {:.1} ms", delays[28]);
    }

    #[test]
    fn rpc_errors_are_bounded_and_coded() {
        let ok = parse_rpc_response(200, br#"{"ok":true,"result":{"a":1}}"#).unwrap();
        assert_eq!(ok, json!({ "a": 1 }));
        let error = parse_rpc_response(409, br#"{"ok":false,"error":{"code":"CONTROL_TASK_BUSY","message":"task is busy"}}"#).unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str(), error.status), ("CONTROL_TASK_BUSY", "task is busy", Some(409)));
        let error = parse_rpc_response(401, br#"{"ok":false,"error":"CONTROL_UNAUTHORIZED"}"#).unwrap_err();
        assert_eq!(error.code, "CONTROL_UNAUTHORIZED");
        let error = parse_rpc_response(500, br#"{"ok":false,"error":{"code":"lower case","message":"x"}}"#).unwrap_err();
        assert_eq!(error.code, "CONTROL_REQUEST_FAILED");
        assert!(parse_rpc_response(200, b"not json").is_err());
    }

    #[test]
    fn a_continued_thread_names_its_parent_storage() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-continue-{}", std::process::id()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let credentials = CredentialStorage { accounts_dir: root.join("appdata/accounts"), vault: connections::Vault::File };
        let supervisor = Supervisor::new(root.join("appdata"), None, credentials, Arc::new(|_, _| {}));
        let input = EngineStartInput {
            engine_id: "child".into(),
            workspace: workspace.to_string_lossy().into_owned(),
            backend: "claude-code".into(),
            session_id: "child".into(),
            behavior: None,
            model: None,
            connection_id: None,
            tool_connection_id: None,
            thinking: None,
            continue_from: Some("parent".into()),
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: false,
            folders: Vec::new(),
            remote: None,
            no_nifra: false,
        }
        .normalized()
        .unwrap();
        let Ok(command) = supervisor.launch_command(&input, &root.join("appdata/threads/child"), &root.join("config.json")) else {
            eprintln!("skipping: no engine program to launch");
            return;
        };
        let sdk_dir = command.get_envs().find(|(key, _)| *key == "RUNRAIL_AGENT_SDK_DIR").and_then(|(_, value)| value);
        assert_eq!(sdk_dir.map(PathBuf::from), Some(supervisor.app_data().join("agent-sdk")));
        let args: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = args.iter().position(|arg| arg == "--continue-from-dir").expect("continue flag");
        assert_eq!(args[at + 1], root.join("appdata/threads/parent/transcript").to_string_lossy());
        assert_eq!(args[at + 2], "--continue-from-session");
        assert_eq!(args[at + 3], "parent");
        assert!(!args.iter().any(|arg| arg.starts_with("--browser")), "browser use is off unless asked");
        assert!(!args.iter().any(|arg| arg == "--threads-dir"), "only the system engine reads thread folders");
        assert!(args.contains(&"--checkpoints".to_string()), "a thread keeps each turn's work tree");
        let system = EngineStartInput { engine_id: SYSTEM_ENGINE_ID.into(), session_id: SYSTEM_ENGINE_ID.into(), continue_from: None, ..input.clone() };
        let args: Vec<String> = supervisor.launch_command(&system, &root.join("appdata/system/session"), &root.join("config.json")).unwrap().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = args.iter().position(|arg| arg == "--threads-dir").expect("threads folder flag");
        assert_eq!(args[at + 1], root.join("appdata/threads").to_string_lossy());
        assert!(!args.iter().any(|arg| arg == "--transcript-dir" || arg == "--checkpoints"));
        let browsing = EngineStartInput { browser_tools: true, browser_any_site: true, ..input.clone() };
        let args: Vec<String> = supervisor.launch_command(&browsing, &root.join("appdata/threads/child"), &root.join("config.json")).unwrap().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"--browser-tools".to_string()) && args.contains(&"--browser-any-site".to_string()));
        assert!(!args.contains(&"--thread-tools".to_string()));
        let messaging = EngineStartInput { thread_tools: true, ..input.clone() };
        let args: Vec<String> = supervisor.launch_command(&messaging, &root.join("appdata/threads/child"), &root.join("config.json")).unwrap().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"--thread-tools".to_string()));
        assert!(!args.iter().any(|arg| arg == "--tool-connection" || arg == "--add-dir"));
        let related = EngineStartInput { folders: vec!["/work/api".into(), "/work/web".into()], ..input.clone() };
        let args: Vec<String> = supervisor.launch_command(&related, &root.join("appdata/threads/child"), &root.join("config.json")).unwrap().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = args.iter().position(|arg| arg == "--add-dir").expect("related folder flag");
        assert_eq!(args[at..at + 4], ["--add-dir", "/work/api", "--add-dir", "/work/web"]);
        let routed = EngineStartInput { tool_connection_id: Some("claude-code-2".into()), ..input.clone() }.normalized().unwrap();
        let args: Vec<String> = supervisor.launch_command(&routed, &root.join("appdata/threads/child"), &root.join("config.json")).unwrap().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let at = args.iter().position(|arg| arg == "--tool-connection").expect("tool connection flag");
        assert_eq!(args[at + 1], "claude-code-2");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn start_input_is_validated() {
        let base = EngineStartInput {
            engine_id: "thread-1".into(),
            workspace: std::env::temp_dir().to_string_lossy().into_owned(),
            backend: "native".into(),
            session_id: "thread-1".into(),
            behavior: None,
            model: Some("anthropic/claude-sonnet-5-5".into()),
            connection_id: None,
            tool_connection_id: None,
            thinking: Some("high".into()),
            continue_from: None,
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: false,
            folders: Vec::new(),
            remote: None,
            no_nifra: false,
        };
        let normalized = base.clone().normalized().unwrap();
        assert_eq!(normalized.behavior, Some(Behavior::default()));
        assert!(EngineStartInput { backend: "bash".into(), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { session_id: "../x".into(), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { model: Some("a b".into()), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { model: Some("--dangerously-skip-permissions".into()), ..base.clone() }.normalized().is_err());
        // A coding tool takes a model with no connection, brackets included.
        assert!(EngineStartInput { model: Some("opus[1m]".into()), backend: "claude-code".into(), connection_id: None, ..base.clone() }.normalized().is_ok());
        // Copilot takes a typed model, and Pi one named with its provider.
        assert!(EngineStartInput { model: Some("gpt-typed".into()), backend: "copilot".into(), connection_id: None, ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { model: Some("github-copilot/gpt-typed".into()), backend: "pi".into(), connection_id: None, ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { connection_id: Some("openai-1".into()), backend: "copilot".into(), ..base.clone() }.normalized().is_err());
        // OpenCode, Gemini CLI, and Goose take a model, and Goose also runs without one.
        assert!(EngineStartInput { model: Some("lmstudio/qwen".into()), backend: "opencode".into(), connection_id: None, ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { model: Some("gemini-2.5-pro".into()), backend: "gemini".into(), connection_id: None, tool_connection_id: Some("gemini-1".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { model: None, backend: "goose".into(), connection_id: None, tool_connection_id: Some("goose-1".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { model: Some("qwen/qwen3.6-35b-a3b".into()), backend: "goose".into(), connection_id: None, ..base.clone() }.normalized().is_ok());
        // A coding tool runs as a tool connection, which a connected model and the system engine never take.
        assert!(EngineStartInput { tool_connection_id: Some("claude-code-2".into()), backend: "claude-code".into(), model: Some("opus".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { tool_connection_id: Some("claude-code-2".into()), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { tool_connection_id: Some("-x".into()), backend: "codex".into(), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { tool_connection_id: Some("codex-1".into()), connection_id: Some("openai".into()), backend: "codex".into(), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { thinking: Some("max".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { browser_tools: true, browser_any_site: true, ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { browser_any_site: true, ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { browser_tools: true, engine_id: SYSTEM_ENGINE_ID.into(), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { thread_tools: true, engine_id: SYSTEM_ENGINE_ID.into(), ..base.clone() }.normalized().is_err());
        // Related folders: real folders beside the workspace, for the routes that take them, never the system engine.
        let root = std::env::temp_dir().join(format!("runrail-related-{}", std::process::id()));
        let (app, related, inside) = (root.join("app"), root.join("api"), root.join("app/src"));
        for folder in [&related, &inside] {
            std::fs::create_dir_all(folder).unwrap();
        }
        let project = EngineStartInput { workspace: app.to_string_lossy().into_owned(), ..base.clone() };
        let named = related.to_string_lossy().into_owned();
        let taken = EngineStartInput { folders: vec![named.clone(), named.clone(), project.workspace.clone()], ..project.clone() }.normalized().unwrap();
        assert_eq!(taken.folders, vec![related.canonicalize().unwrap().to_string_lossy().into_owned()]);
        // One that is gone, relative, or inside the workspace is left out rather than stopping the thread.
        let skipped = EngineStartInput { folders: vec!["relative".into(), root.join("gone").to_string_lossy().into_owned(), inside.to_string_lossy().into_owned()], ..project.clone() }.normalized().unwrap();
        assert!(skipped.folders.is_empty());
        assert!(EngineStartInput { folders: vec![named.clone()], backend: "copilot".into(), model: None, ..project.clone() }.normalized().is_err());
        assert!(EngineStartInput { folders: vec![named.clone()], engine_id: SYSTEM_ENGINE_ID.into(), ..project.clone() }.normalized().is_err());
        assert!(EngineStartInput { folders: vec![named.clone(); 9], ..project.clone() }.normalized().is_err());
        let _ = std::fs::remove_dir_all(&root);
        // A remote thread: a path on that machine, and nothing that lives only on this Mac.
        let remote = EngineStartInput { remote: Some("rm-0a1b".into()), workspace: "/home/me/app".into(), backend: "claude-code".into(), model: Some("opus".into()), connection_id: None, ..base.clone() };
        assert_eq!(remote.clone().normalized().unwrap().workspace, "/home/me/app");
        assert!(EngineStartInput { workspace: "relative".into(), ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { remote: Some("../x".into()), ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { connection_id: Some("openai".into()), backend: "native".into(), ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { tool_connection_id: Some("claude-code-2".into()), ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { browser_tools: true, ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { image_tools: true, ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { folders: vec!["/home/me/api".into()], ..remote.clone() }.normalized().is_err());
        assert!(EngineStartInput { continue_from: Some("th-old".into()), ..remote.clone() }.normalized().is_err());
        let args = remote_args(&EngineStartInput { thread_tools: true, ..remote.clone() });
        assert!(args.windows(2).any(|pair| pair == ["--backend", "claude-code"]) && args.contains(&"--exit-on-stdin-close".to_string()) && args.contains(&"--thread-tools".to_string()));
        assert!(!args.iter().any(|arg| arg == "--accounts-dir" || arg == "--credential-vault" || arg == "--cwd"));
        // Codex's top level, which the picker offers and the engine takes.
        assert!(EngineStartInput { thinking: Some("ultra".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { thinking: Some("extreme".into()), ..base.clone() }.normalized().is_err());
        // A thread continues another thread by id; the bridge, not the renderer, finds its storage.
        assert!(EngineStartInput { continue_from: Some("thread-0".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { continue_from: Some("thread-1".into()), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { continue_from: Some("../thread-0".into()), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { connection_id: Some("signin-chatgpt".into()), ..base.clone() }.normalized().is_ok());
        assert!(EngineStartInput { connection_id: Some("https://relay.example/v1".into()), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { connection_id: Some("openai-1".into()), backend: "codex".into(), ..base.clone() }.normalized().is_err());
        assert!(EngineStartInput { connection_id: Some("openai-1".into()), model: None, ..base.clone() }.normalized().is_err());
        // Unknown fields are refused, so a request that still names a provider or an address
        // fails instead of starting an engine that quietly ignores it.
        let request = |extra: Value| {
            let mut value = json!({ "engineId": "t", "workspace": base.workspace, "backend": "native", "sessionId": "t", "model": "gpt-5" });
            value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            serde_json::from_value::<EngineStartInput>(value)
        };
        assert_eq!(request(json!({ "connectionId": "openai-1" })).unwrap().connection_id.as_deref(), Some("openai-1"));
        assert!(request(json!({ "provider": "openai" })).is_err());
        assert!(request(json!({ "endpoint": "https://relay.example/v1" })).is_err());
        let bad_mode = Behavior { mode: "yolo".into(), ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(bad_mode), ..base.clone() }.normalized().is_err());
        let rule = |tool: &str, pattern: &str, policy: &str| PermissionRule { tool: tool.into(), pattern: pattern.into(), policy: policy.into() };
        let good_rules = Behavior { rules: vec![rule("edit_file", "*", "allow")], ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(good_rules.clone()), ..base.clone() }.normalized().is_ok());
        assert_eq!(good_rules.file_contents()["permissions"]["rules"][0]["match"], "*");
        let bad_rule = Behavior { rules: vec![rule("edit file", "*", "allow")], ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(bad_rule), ..base.clone() }.normalized().is_err());
        let told = Behavior { instructions: Some("Use pnpm.".into()), ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(told.clone()), ..base.clone() }.normalized().is_ok());
        assert_eq!(told.file_contents()["instructions"]["text"], "Use pnpm.");
        assert!(Behavior { instructions: Some("  ".into()), ..Behavior::default() }.file_contents().get("instructions").is_none());
        let long = Behavior { instructions: Some("x".repeat(MAX_INSTRUCTIONS + 1)), ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(long), ..base.clone() }.normalized().is_err());
        let nul = Behavior { instructions: Some("a\0b".into()), ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(nul), ..base.clone() }.normalized().is_err());
        // A terminal shell is one the system lists as a login shell, never any program.
        let listed = Behavior { shell: Some("/bin/sh".into()), ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(listed), ..base.clone() }.normalized().is_ok());
        let program = Behavior { shell: Some("/usr/bin/true".into()), ..Behavior::default() };
        assert!(EngineStartInput { behavior: Some(program), ..base.clone() }.normalized().is_err());
        let grants = |pairs: &[(&str, &str)]| Behavior { integrations: Some(pairs.iter().map(|(key, grant)| (key.to_string(), grant.to_string())).collect()), ..Behavior::default() };
        let granted = grants(&[("github", "read"), ("mcp:docs", "ask")]);
        assert_eq!(granted.file_contents()["integrations"], json!({ "github": "read", "mcp:docs": "ask" }));
        assert!(EngineStartInput { behavior: Some(granted), ..base.clone() }.normalized().is_ok());
        for bad in [grants(&[("github", "admin")]), grants(&[("bad key", "read")]), grants(&[("mcp:", "read")])] {
            assert!(EngineStartInput { behavior: Some(bad), ..base.clone() }.normalized().is_err());
        }
        assert!(Behavior::default().file_contents().get("integrations").is_none());
    }

    #[test]
    fn stderr_code_extraction() {
        assert_eq!(error_code_in(b"error: behavior config is invalid BEHAVIOR_CONFIG_INVALID\n"), Some("BEHAVIOR_CONFIG_INVALID".into()));
        assert_eq!(error_code_in(b"plain failure with secret sk-abc"), None);
        let missing = error_code_in(b"connection was not found (CONNECTION_NOT_FOUND)\n");
        assert_eq!(start_error_code("CONTROL_START_FAILED", missing.as_deref()), "CONNECTION_NOT_FOUND");
        assert_eq!(start_error_code("CONTROL_START_FAILED", Some("BEHAVIOR_CONFIG_INVALID")), "CONTROL_START_FAILED");
        assert_eq!(start_error_code("CONTROL_START_FAILED", None), "CONTROL_START_FAILED");
        assert!(valid_method("git.pr.create"));
        assert!(!valid_method("../x"));
    }

    /// The engine's `runrail new`, run the way the New app dialog runs it.
    #[test]
    fn real_engine_makes_an_app_from_a_starter() {
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../runrail/src/cli.ts");
        if !core.is_file() || find_on_path("bun").is_none() {
            eprintln!("skipping: runrail core or bun unavailable");
            return;
        }
        let root = std::env::temp_dir().join(format!("runrail-desktop-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let credentials = CredentialStorage { accounts_dir: root.join("appdata/accounts"), vault: connections::Vault::File };
        let supervisor = Supervisor::new(root.join("appdata"), None, credentials, Arc::new(|_, _| {}));
        let mut command = supervisor.job_command(&root).unwrap();
        command.arg("new").arg(root.join("shop")).args(["--starter", "empty", "--json"]);
        let ran = crate::process::run(command, None, std::time::Duration::from_secs(60)).unwrap();
        let result = crate::starters::result_of(&ran.stdout).unwrap();
        assert_eq!(result["ok"], true, "{}", ran.stderr);
        assert!(root.join("shop").is_dir());
        let mut list = supervisor.job_command(&root).unwrap();
        list.args(["new", "--list", "--json"]);
        let listed = crate::starters::result_of(&crate::process::run(list, None, std::time::Duration::from_secs(60)).unwrap().stdout).unwrap();
        assert_eq!(listed["default"], "nifra");
        let ids: Vec<&str> = listed["starters"].as_array().unwrap().iter().filter_map(|starter| starter["id"].as_str()).collect();
        assert_eq!(ids, crate::starters::STARTERS);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nifra_off_reaches_the_engine_command_line() {
        let input = EngineStartInput {
            engine_id: "t1".into(),
            workspace: "/tmp".into(),
            backend: "native".into(),
            session_id: "t1".into(),
            behavior: None,
            model: None,
            connection_id: None,
            tool_connection_id: None,
            thinking: None,
            continue_from: None,
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: false,
            folders: Vec::new(),
            remote: None,
            no_nifra: true,
        };
        assert!(remote_args(&input).contains(&"--no-nifra".to_string()));
        assert!(!remote_args(&EngineStartInput { no_nifra: false, ..input.clone() }).contains(&"--no-nifra".to_string()));
        let parsed: EngineStartInput = serde_json::from_value(json!({ "engineId": "t1", "workspace": "/tmp", "backend": "native", "sessionId": "t1", "noNifra": true })).unwrap();
        assert!(parsed.no_nifra);
    }

    /// Full round trip against the real core checkout when `bun` is available: handshake, RPC,
    /// streamed events, and restart with history intact.
    #[test]
    fn real_engine_round_trip() {
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../runrail/src/cli.ts");
        if !core.is_file() || find_on_path("bun").is_none() {
            eprintln!("skipping: runrail core or bun unavailable");
            return;
        }
        let root = std::env::temp_dir().join(format!("runrail-desktop-engine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let batches: Arc<Mutex<Vec<Value>>> = Arc::default();
        let seen = batches.clone();
        let on_batch: BatchSink = Arc::new(move |payload| seen.lock().unwrap().push(serde_json::from_str(&payload).unwrap()));
        // A file vault in the temp folder: tests never touch the keychain or `~/.runrail`.
        let credentials = CredentialStorage { accounts_dir: root.join("appdata/accounts"), vault: connections::Vault::File };
        let supervisor = Supervisor::new(root.join("appdata"), None, credentials, Arc::new(|_, _| {}));
        let input = EngineStartInput {
            engine_id: "t1".into(),
            workspace: workspace.to_string_lossy().into_owned(),
            backend: "replay".into(),
            session_id: "t1".into(),
            behavior: Some(Behavior { mode: "auto".into(), ..Behavior::default() }),
            model: None,
            connection_id: None,
            tool_connection_id: None,
            thinking: None,
            continue_from: None,
            browser_tools: false,
            browser_any_site: false,
            thread_tools: false,
            computer_tools: false,
            image_tools: false,
            folders: Vec::new(),
            remote: None,
            no_nifra: false,
        };
        let server = crate::mcp::McpServer { name: "docs".into(), command: "npx".into(), args: vec!["-y".into(), "docs-mcp".into()], env: vec!["DOCS_TOKEN".into()], url: None, bearer_env: None, project: None, enabled: false };
        McpStore::new(&root.join("appdata")).save(server, None, |_| true).unwrap();
        let info = supervisor.start(input.clone()).expect("engine starts");
        assert_eq!(info.state, "running");
        assert!(root.join("appdata/threads/t1/config.json").is_file());
        // The engine read the host's MCP list from its behavior file and started.
        let written: Value = serde_json::from_slice(&std::fs::read(root.join("appdata/threads/t1/config.json")).unwrap()).unwrap();
        assert_eq!(written["mcp"]["servers"][0]["name"], "docs");
        // Same settings reuse the running engine.
        let again = supervisor.start(input.clone()).unwrap();
        assert_eq!(again.contract, info.contract);
        assert_eq!(supervisor.list().unwrap().len(), 1);

        supervisor.stream_start("t1", -1, None, on_batch).unwrap();
        let described = supervisor.rpc("t1", "control.describe", json!({})).unwrap();
        assert!(described.is_object());
        let error = supervisor.rpc("t1", "no.such.method", json!({})).unwrap_err();
        assert!(error.status.is_some());
        let health = supervisor.health("t1").unwrap();
        assert_eq!(health.get("ok"), Some(&Value::Bool(true)));
        let turn = supervisor.rpc("t1", "turn.enqueue", json!({ "message": "hello" }));
        assert!(turn.is_ok(), "turn failed: {:?}", turn.err());
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let seen = batches
                .lock()
                .unwrap()
                .iter()
                .any(|value| value["frames"].as_array().is_some_and(|frames| frames.iter().any(|frame| frame["data"]["type"] == "turn.started")));
            if seen {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!batches.lock().unwrap().is_empty(), "no streamed batch");

        supervisor.stop("t1").unwrap();
        assert!(supervisor.rpc("t1", "control.describe", json!({})).is_err());
        let restarted = supervisor.start(input.clone()).unwrap();
        assert_eq!(restarted.state, "running");
        let conversation = supervisor.rpc("t1", "session.conversation.read", json!({})).unwrap();
        let items = conversation["items"].as_array().cloned().unwrap_or_default();
        assert!(items.iter().any(|item| item["kind"] == "user"), "history lost after restart: {conversation}");
        supervisor.forget_thread("t1").unwrap();
        assert!(!root.join("appdata/threads/t1").exists());
        assert!(supervisor.list().unwrap().is_empty());

        // The system engine: accounts and secrets with no project and no model. Its ids are the
        // host's, so the renderer can neither start it, stop it, nor delete its storage.
        for taken in [
            EngineStartInput { engine_id: SYSTEM_ENGINE_ID.into(), ..input.clone() },
            EngineStartInput { session_id: SYSTEM_ENGINE_ID.into(), ..input.clone() },
        ] {
            assert_eq!(supervisor.start(taken).unwrap_err().code, "CONTROL_INVALID_INPUT");
        }
        let system = supervisor.system().expect("system engine starts");
        assert_eq!((system.engine_id.as_str(), system.backend.as_str(), system.state.as_str()), (SYSTEM_ENGINE_ID, "native", "running"));
        assert_eq!(system.behavior.permission_default, "deny");
        assert!(root.join("appdata/system/session/config.json").is_file());
        for capability in ["accounts", "connections", "account.secrets", "auth.signin", "conversation.peek", "usage.read"] {
            assert_eq!(system.contract["capabilityStatus"][capability], "available", "{capability}");
        }
        assert_eq!(supervisor.system().unwrap().instance, system.instance, "the running system engine is reused");
        assert_eq!(supervisor.stop(SYSTEM_ENGINE_ID).unwrap_err().code, "CONTROL_INVALID_INPUT");
        assert_eq!(supervisor.forget_thread(SYSTEM_ENGINE_ID).unwrap_err().code, "CONTROL_INVALID_INPUT");

        // A pasted key goes down the write-only path and never comes back.
        const CANARY: &str = "sk-desktop-canary-7f3a9c51d2";
        let account = json!({ "accountId": "relay", "provider": "custom-openai-chat", "label": "Local relay", "authMode": "api-key", "baseUrl": "http://127.0.0.1:9/v1" });
        let created = supervisor.renderer_rpc(SYSTEM_ENGINE_ID, "account.create", account.clone()).expect("account is created");
        assert_ne!(created["status"], "ready", "no key yet: {created}");
        let stored = supervisor.store_secret("relay", Zeroizing::new(format!("  {CANARY}\n"))).expect("secret is stored");
        assert_eq!(stored["status"], "ready", "{stored}");
        let listed = supervisor.renderer_rpc(SYSTEM_ENGINE_ID, "account.list", json!({})).unwrap();
        let fetched = supervisor.renderer_rpc(SYSTEM_ENGINE_ID, "account.get", json!({ "accountId": "relay" })).unwrap();
        for answer in [&created, &stored, &listed, &fetched] {
            assert!(!answer.to_string().contains(CANARY), "an answer carried the key");
        }
        assert!(listed.to_string().contains("relay"));

        // Refusals: the generic channel, a missing account, and a key the host will not send.
        let mut with_key = account.clone();
        with_key["secret"] = json!(CANARY);
        for (engine, method, params) in [
            (SYSTEM_ENGINE_ID, "auth.secret.set", json!({ "accountId": "relay" })),
            (SYSTEM_ENGINE_ID, "account.upsert", with_key),
            (SYSTEM_ENGINE_ID, "control.describe", json!({})),
        ] {
            let error = supervisor.renderer_rpc(engine, method, params).unwrap_err();
            assert_eq!((error.code.as_str(), error.status), ("HOST_RPC_REFUSED", Some(403)), "{method}");
        }
        assert!(supervisor.store_secret("nobody", Zeroizing::new(CANARY.to_string())).unwrap_err().status.is_some());
        assert_eq!(supervisor.store_secret("relay", Zeroizing::new("two\nlines".to_string())).unwrap_err().code, "CONNECTION_SECRET_INVALID");

        // Sign-in: the engine lists its flows with the hosts a page may be on; an unknown sign-in
        // has no page to open and takes no input.
        let flows = supervisor.renderer_rpc(SYSTEM_ENGINE_ID, "auth.flows", json!({})).unwrap();
        let flows = flows.as_array().expect("flows are a list");
        assert!(!flows.is_empty());
        assert!(flows.iter().all(|flow| flow["browserHosts"].as_array().is_some_and(|hosts| !hosts.is_empty())));
        let nobody = "login-0f8fad5b-d9cb-469f-a165-70867728950e";
        assert!(supervisor.sign_in_url(nobody).unwrap_err().status.is_some());
        assert!(supervisor.submit_sign_in_input(nobody, Zeroizing::new("https://127.0.0.1:1455/auth/callback?code=x".to_string())).unwrap_err().status.is_some());
        assert_eq!(supervisor.sign_in_url("login-nope").unwrap_err().code, "CONTROL_INVALID_INPUT");

        // A project engine starts on the stored connection: the key never crosses the host again.
        let on_connection = EngineStartInput {
            engine_id: "t2".into(),
            session_id: "t2".into(),
            backend: "native".into(),
            model: Some("local-model".into()),
            connection_id: Some("relay".into()),
            ..input.clone()
        };
        let bound = supervisor.start(on_connection.clone()).expect("engine starts on a connection");
        assert_eq!(bound.connection_id.as_deref(), Some("relay"));
        let error = supervisor.renderer_rpc("t2", "auth.flows", json!({})).unwrap_err();
        assert_eq!(error.code, "HOST_RPC_REFUSED");
        assert!(supervisor.start(EngineStartInput { engine_id: "t3".into(), session_id: "t3".into(), connection_id: Some("nobody".into()), ..on_connection }).is_err());

        // The key lives in the vault and nowhere else the host writes.
        supervisor.stop_all();
        assert!(root.join("appdata/accounts/vault").is_dir());
        let mut pending = vec![root.join("appdata")];
        let mut holders = Vec::new();
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if std::fs::read(&path).is_ok_and(|bytes| bytes.windows(CANARY.len()).any(|window| window == CANARY.as_bytes())) {
                    holders.push(path);
                }
            }
        }
        assert!(!holders.is_empty(), "the file vault holds the key");
        assert!(holders.iter().all(|path| path.starts_with(root.join("appdata/accounts/vault"))), "the key leaked outside the vault: {holders:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
