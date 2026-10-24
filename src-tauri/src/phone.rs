//! Phone access: a small HTTP server on 127.0.0.1 that the person's own
//! `tailscale serve` brings to their tailnet over HTTPS. It serves the phone page, pairs a phone with
//! a one-time code shown on this Mac, and hands a paired phone's calls to the app's page, which runs
//! them with the same code as the window. Nothing listens beyond loopback, a phone's token is kept
//! only as its SHA-256, and no request or answer is logged.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::engine::Emitter;
use crate::error::{BridgeError, BridgeResult};
use crate::store::write_atomic;

const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;
const MAX_ANSWER: usize = 4 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_DEVICES: usize = 20;
const MAX_NAME: usize = 60;
const MAX_PUSH: usize = 4096;
const MAX_SHARES: usize = 100;
const MAX_HOOKS: usize = 50;
/// What one webhook call may send; the engine takes no more.
const MAX_HOOK_INPUT: usize = 16 * 1024;
/// A workflow's link starts at most one run this often, whoever calls it.
const HOOK_SPACING_MS: u64 = 10_000;
/// A published page runs on an origin of its own, so it can never read a paired phone's token.
const PAGE_SANDBOX: &str = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'none'";
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const PAIRING_MS: u64 = 5 * 60_000;
const PAIRING_TRIES: u32 = 5;
/// How stale a phone's "last seen" may get before it is written again.
const SEEN_WRITE_MS: u64 = 10 * 60_000;
/// A phone unused this long is unpaired: its token can send prompts and answer approvals.
const IDLE_UNPAIR_MS: u64 = 30 * 24 * 60 * 60_000;
/// No 0, O, 1 or I, so a code read off the screen is typed right; 32 letters keep the draw unbiased.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 8;
const PAGE_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    token_hash: String,
    added_at: u64,
    #[serde(default)]
    seen_at: u64,
    /// The phone's Web Push subscription and its page's origin, when it asked for notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push: Option<Value>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    devices: Vec<Device>,
    #[serde(default)]
    shares: Vec<Share>,
    #[serde(default)]
    hooks: Vec<Hook>,
}

/// A workflow's webhook: `POST /hook/<token>` starts a run. Only the token's SHA-256
/// is kept, so the link is shown once, when it is made.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Hook {
    id: String,
    project_id: String,
    workflow_id: String,
    token_hash: String,
    created_at: u64,
    #[serde(default)]
    used_at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub id: String,
    pub project_id: String,
    pub workflow_id: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_at: Option<u64>,
}

/// A link just made, with the secret that is never shown again.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewHook {
    #[serde(flatten)]
    pub hook: HookInfo,
    pub token: String,
}

impl Hook {
    fn info(&self) -> HookInfo {
        HookInfo { id: self.id.clone(), project_id: self.project_id.clone(), workflow_id: self.workflow_id.clone(), created_at: self.created_at, used_at: (self.used_at > 0).then_some(self.used_at) }
    }
}

/// A read-only link: a thread at `/s/<token>`, or a published page at `/p/<token>/`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    /// The secret in the link's address: anyone on the tailnet with the link can open it.
    pub token: String,
    pub kind: ShareKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShareKind {
    Thread,
    Page,
}

struct Pairing {
    code: String,
    expires_at: u64,
    tries: u32,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
}

struct State {
    saved: Saved,
    pairing: Option<Pairing>,
    server: Option<Server>,
    problem: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub added_at: u64,
    pub seen_at: u64,
    /// It asked for notifications.
    pub notifies: bool,
}

/// Where to send one paired phone's notifications.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushTarget {
    pub device: String,
    pub subscription: Value,
    pub origin: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub code: String,
    pub expires_at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    pub devices: Vec<DeviceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing: Option<PairingInfo>,
    pub shares: Vec<Share>,
    pub hooks: Vec<HookInfo>,
}

/// The page's answer to one call: a result, or a content-free error `{code, message}`.
struct Answer {
    ok: bool,
    body: Value,
}

/// Reads one of the app's built files by its path, with its media type.
pub type Assets = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// What the phone page and its answers call the computer Runrail runs on.
const COMPUTER: &str = if cfg!(target_os = "linux") { "computer" } else { "Mac" };

/// Marks the page's root as served by Linux, so it names "your computer", not "your Mac".
fn linux_page(page: Vec<u8>) -> Vec<u8> {
    const ROOT: &[u8] = b"<html";
    let Some(at) = page.windows(ROOT.len()).position(|window| window == ROOT).map(|at| at + ROOT.len()) else { return page };
    [&page[..at], b" data-host=\"linux\"", &page[at..]].concat()
}

pub struct Phone {
    path: PathBuf,
    /// Published pages' copies, one folder each.
    pages: PathBuf,
    state: Mutex<State>,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Answer>>>,
    next: AtomicU64,
    open: AtomicUsize,
    emit: Emitter,
    assets: Assets,
    /// This Mac's tailnet name, once Tailscale has said it.
    tailnet: Mutex<Option<String>>,
}

struct Response {
    status: u16,
    kind: String,
    body: Vec<u8>,
    cache: &'static str,
    headers: Vec<(&'static str, String)>,
}

impl Response {
    fn json(status: u16, value: &Value) -> Self {
        Self { status, kind: "application/json".into(), body: serde_json::to_vec(value).unwrap_or_default(), cache: "no-store", headers: Vec::new() }
    }

    fn error(status: u16, code: &str, message: &str) -> Self {
        Self::json(status, &json!({ "error": { "code": code, "message": message } }))
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn random_bytes<const N: usize>() -> BridgeResult<[u8; N]> {
    let mut bytes = [0_u8; N];
    SystemRandom::new().fill(&mut bytes).map_err(|_| BridgeError::new("PHONE_RANDOM_FAILED", "no randomness for a phone token"))?;
    Ok(bytes)
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn same(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0_u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// A code as typed: case, spaces and hyphens do not matter.
fn normal_code(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_ascii_uppercase()
}

fn clean_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { "Phone".into() } else { trimmed.into() }
}

/// Requests reach the server only through loopback: from `tailscale serve`, which names this Mac's
/// tailnet address or the loopback target, or from this Mac itself. Any other name is a page
/// rebinding its own domain to 127.0.0.1. Once Tailscale has said this Mac's name, only that name counts.
pub fn host_allowed(host: &str, tailnet: Option<&str>) -> bool {
    let name = host.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(host, |(name, _)| name).to_ascii_lowercase();
    let tailnet_shaped = name.ends_with(".ts.net") && name.len() > ".ts.net".len() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    name == "127.0.0.1" || name == "localhost" || (tailnet_shaped && tailnet.is_none_or(|own| own.eq_ignore_ascii_case(&name)))
}

/// The built files a phone may load: its page, its service worker and manifest, and the bundle.
pub fn public_asset(name: &str) -> bool {
    let plain = !name.is_empty() && !name.contains("..") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    plain && (name == "phone.html" || (name.starts_with("phone-") && !name.contains('/')) || (name.starts_with("assets/") && name.matches('/').count() == 1))
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// One read that ends by `deadline`, so a client sending a byte at a time cannot hold a connection.
fn read_by(stream: &mut TcpStream, buffer: &mut [u8], deadline: Instant) -> Result<usize, Response> {
    let timed_out = || Response::error(408, "PHONE_TIMEOUT", "request timed out");
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(timed_out());
    }
    stream.set_read_timeout(Some(left)).map_err(|_| timed_out())?;
    stream.read(buffer).map_err(|_| timed_out())
}

fn read_request(stream: &mut TcpStream, deadline: Instant) -> Result<Request, Response> {
    let mut pending = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    let end = loop {
        if let Some(index) = pending.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        if pending.len() > MAX_HEAD {
            return Err(Response::error(431, "PHONE_HEAD_LIMIT", "request headers are too large"));
        }
        let count = read_by(stream, &mut buffer, deadline)?;
        if count == 0 {
            return Err(Response::error(400, "PHONE_BAD_REQUEST", "request ended early"));
        }
        pending.extend_from_slice(&buffer[..count]);
    };
    let head = std::str::from_utf8(&pending[..end]).map_err(|_| Response::error(400, "PHONE_BAD_REQUEST", "request is not text"))?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some(version)) = (first.next(), first.next(), first.next()) else {
        return Err(Response::error(400, "PHONE_BAD_REQUEST", "request line is invalid"));
    };
    if !version.starts_with("HTTP/1.") || !target.starts_with('/') {
        return Err(Response::error(400, "PHONE_BAD_REQUEST", "request line is invalid"));
    }
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(Response::error(400, "PHONE_BAD_REQUEST", "header is invalid"));
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    if headers.contains_key("transfer-encoding") {
        return Err(Response::error(411, "PHONE_LENGTH_REQUIRED", "send a Content-Length"));
    }
    let length = match headers.get("content-length") {
        None => 0,
        Some(value) => value.parse::<usize>().map_err(|_| Response::error(400, "PHONE_BAD_REQUEST", "Content-Length is invalid"))?,
    };
    if length > MAX_BODY {
        return Err(Response::error(413, "PHONE_BODY_LIMIT", "request is too large"));
    }
    let mut body = pending[end + 4..].to_vec();
    while body.len() < length {
        let count = read_by(stream, &mut buffer, deadline)?;
        if count == 0 {
            return Err(Response::error(400, "PHONE_BAD_REQUEST", "request body ended early"));
        }
        body.extend_from_slice(&buffer[..count]);
    }
    body.truncate(length);
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    Ok(Request { method: method.to_string(), path, headers, body })
}

fn write_response(stream: &mut TcpStream, response: &Response, head_only: bool) {
    let reason = match response.status {
        200 => "OK",
        301 => "Moved Permanently",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n",
        response.status,
        response.kind,
        response.body.len(),
        response.cache
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    if !head_only {
        let _ = stream.write_all(&response.body);
    }
    let _ = stream.flush();
}

impl Phone {
    pub fn new(app_data: &Path, emit: Emitter, assets: Assets) -> Arc<Self> {
        let path = app_data.join("phone.json");
        let (saved, problem) = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Saved>(&bytes) {
                Ok(saved) => (saved, None),
                Err(_) => (Saved::default(), Some("The phone access settings could not be read; turn it on again.".to_string())),
            },
            Err(_) => (Saved::default(), None),
        };
        Arc::new(Self {
            path,
            pages: app_data.join("phone-pages"),
            state: Mutex::new(State { saved, pairing: None, server: None, problem }),
            waiting: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            open: AtomicUsize::new(0),
            emit,
            assets,
            tailnet: Mutex::new(None),
        })
    }

    /// Starts the server at launch when the person left phone access on.
    pub fn start_if_enabled(self: &Arc<Self>) {
        let mut state = lock(&self.state);
        if Self::unpair_idle(&mut state, now_ms()) {
            let _ = self.save(&state);
        }
        if state.saved.enabled {
            if let Err(error) = self.start(&mut state) {
                state.problem = Some(error.message);
            }
        }
        if state.server.is_some() {
            let (phone, port) = (Arc::clone(self), state.server.as_ref().map_or(0, |server| server.port));
            let _ = std::thread::Builder::new().name("runrail-phone-tailnet".into()).spawn(move || phone.note_tailnet(crate::tailscale::status(port).name.as_deref()));
        }
    }

    /// Remembers this Mac's tailnet name, so only it is served; a status without one keeps the last.
    pub fn note_tailnet(&self, name: Option<&str>) {
        if let Some(name) = name {
            *lock(&self.tailnet) = Some(name.to_ascii_lowercase());
        }
    }

    /// Drops phones unused for `IDLE_UNPAIR_MS`; true when any went.
    fn unpair_idle(state: &mut State, now: u64) -> bool {
        let before = state.saved.devices.len();
        state.saved.devices.retain(|device| now.saturating_sub(device.seen_at.max(device.added_at)) <= IDLE_UNPAIR_MS);
        state.saved.devices.len() != before
    }

    pub fn status(&self) -> PhoneStatus {
        let mut state = lock(&self.state);
        if Self::unpair_idle(&mut state, now_ms()) {
            let _ = self.save(&state);
        }
        Self::status_of(&state)
    }

    fn status_of(state: &State) -> PhoneStatus {
        let now = now_ms();
        PhoneStatus {
            enabled: state.saved.enabled,
            running: state.server.is_some(),
            port: state.server.as_ref().map_or(state.saved.port, |server| server.port),
            problem: state.problem.clone(),
            devices: state.saved.devices.iter().map(|device| DeviceInfo { id: device.id.clone(), name: device.name.clone(), added_at: device.added_at, seen_at: device.seen_at, notifies: device.push.is_some() }).collect(),
            pairing: state.pairing.as_ref().filter(|pairing| pairing.expires_at > now).map(|pairing| PairingInfo { code: pairing.code.clone(), expires_at: pairing.expires_at }),
            shares: state.saved.shares.clone(),
            hooks: state.saved.hooks.iter().map(Hook::info).collect(),
        }
    }

    fn save(&self, state: &State) -> BridgeResult<()> {
        let bytes = serde_json::to_vec_pretty(&state.saved).map_err(|_| BridgeError::new("PHONE_SAVE_FAILED", "phone access settings could not be written"))?;
        write_atomic(&self.path, &bytes)
    }

    fn changed(&self, state: &State) {
        if let Ok(status) = serde_json::to_value(Self::status_of(state)) {
            (self.emit)("phone:changed", status);
        }
    }

    pub fn set(self: &Arc<Self>, on: bool) -> BridgeResult<PhoneStatus> {
        let mut state = lock(&self.state);
        state.problem = None;
        if on {
            self.start(&mut state)?;
        } else {
            Self::stop_server(&mut state);
            state.pairing = None;
        }
        state.saved.enabled = on;
        self.save(&state)?;
        Ok(Self::status_of(&state))
    }

    fn start(self: &Arc<Self>, state: &mut State) -> BridgeResult<()> {
        if state.server.is_some() {
            return Ok(());
        }
        // The port stays the same from launch to launch, since `tailscale serve` points at it.
        let wanted = state.saved.port;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, wanted)).map_err(|_| BridgeError::new("PHONE_PORT_BUSY", format!("Port {wanted} on this {COMPUTER} is in use by another program.")))?;
        let port = listener.local_addr().map_err(BridgeError::from)?.port();
        state.saved.port = port;
        let stop = Arc::new(AtomicBool::new(false));
        let phone = Arc::clone(self);
        let flag = Arc::clone(&stop);
        std::thread::Builder::new().name("runrail-phone".into()).spawn(move || phone.accept(&listener, &flag)).map_err(|_| BridgeError::new("PHONE_START_FAILED", "phone access could not start"))?;
        state.server = Some(Server { port, stop });
        Ok(())
    }

    fn stop_server(state: &mut State) {
        if let Some(server) = state.server.take() {
            server.stop.store(true, Ordering::SeqCst);
            // Wakes the accept loop so it sees the flag.
            let _ = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, server.port)), Duration::from_millis(200));
        }
    }

    pub fn shutdown(&self) {
        Self::stop_server(&mut lock(&self.state));
    }

    /// A one-time code, good for five minutes and five tries, that a phone pairs with.
    pub fn pair(&self) -> BridgeResult<PhoneStatus> {
        let mut state = lock(&self.state);
        if state.server.is_none() {
            return Err(BridgeError::new("PHONE_OFF", "Turn on phone access first."));
        }
        let draw = random_bytes::<CODE_LENGTH>()?;
        let code = draw.iter().map(|byte| char::from(CODE_ALPHABET[usize::from(*byte) % CODE_ALPHABET.len()])).collect();
        state.pairing = Some(Pairing { code, expires_at: now_ms() + PAIRING_MS, tries: 0 });
        Ok(Self::status_of(&state))
    }

    pub fn forget(&self, id: &str) -> BridgeResult<PhoneStatus> {
        let mut state = lock(&self.state);
        state.saved.devices.retain(|device| device.id != id);
        self.save(&state)?;
        Ok(Self::status_of(&state))
    }

    /// The thread's read-only link, made the first time it is asked for.
    pub fn share_thread(&self, thread_id: &str, title: &str) -> BridgeResult<Share> {
        if thread_id.is_empty() || thread_id.len() > 80 || !thread_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(BridgeError::new("PHONE_SHARE_INVALID", "That thread cannot be shared."));
        }
        let mut state = lock(&self.state);
        if state.server.is_none() {
            return Err(BridgeError::new("PHONE_OFF", "Turn on phone access first."));
        }
        if let Some(existing) = state.saved.shares.iter().find(|share| share.thread_id.as_deref() == Some(thread_id)) {
            return Ok(existing.clone());
        }
        let share = Self::new_share(&state, ShareKind::Thread, title, Some(thread_id.to_string()), None)?;
        state.saved.shares.push(share.clone());
        self.save(&state)?;
        Ok(share)
    }

    /// Publishes a copy of `root` as a page; the caller planned it and asked the person first.
    pub fn publish(&self, root: &Path, plan: &crate::pages::Plan, title: &str) -> BridgeResult<Share> {
        let share = {
            let state = lock(&self.state);
            if state.server.is_none() {
                return Err(BridgeError::new("PHONE_OFF", "Turn on phone access first."));
            }
            Self::new_share(&state, ShareKind::Page, title, None, Some(plan))?
        };
        crate::pages::copy(root, plan, &self.pages.join(&share.id))?;
        let mut state = lock(&self.state);
        state.saved.shares.push(share.clone());
        if let Err(error) = self.save(&state) {
            state.saved.shares.retain(|item| item.id != share.id);
            let _ = std::fs::remove_dir_all(self.pages.join(&share.id));
            return Err(error);
        }
        Ok(share)
    }

    fn new_share(state: &State, kind: ShareKind, title: &str, thread_id: Option<String>, plan: Option<&crate::pages::Plan>) -> BridgeResult<Share> {
        if state.saved.shares.len() >= MAX_SHARES {
            return Err(BridgeError::new("PHONE_SHARE_LIMIT", "Too many links are shared. Revoke some in Settings first."));
        }
        let secret = random_bytes::<24>()?;
        let id = random_bytes::<8>()?;
        let title: String = title.chars().filter(|c| !c.is_control()).take(120).collect();
        Ok(Share {
            id: format!("sh-{}", id.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
            token: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
            kind,
            title: if title.trim().is_empty() { "Untitled".into() } else { title.trim().into() },
            thread_id,
            files: plan.map(|plan| plan.files.len()),
            bytes: plan.map(|plan| plan.bytes),
            created_at: now_ms(),
        })
    }

    /// Revokes a link; a page's copy goes with it.
    pub fn unshare(&self, id: &str) -> BridgeResult<PhoneStatus> {
        let mut state = lock(&self.state);
        let removed: Vec<Share> = state.saved.shares.iter().filter(|share| share.id == id).cloned().collect();
        state.saved.shares.retain(|share| share.id != id);
        self.save(&state)?;
        for share in removed.iter().filter(|share| share.kind == ShareKind::Page) {
            let _ = std::fs::remove_dir_all(self.pages.join(&share.id));
        }
        Ok(Self::status_of(&state))
    }

    /// A new link for a workflow, replacing the one it had; its secret is returned only here.
    pub fn hook_create(&self, project_id: &str, workflow_id: &str) -> BridgeResult<NewHook> {
        let plain = |id: &str, max: usize| !id.is_empty() && id.len() <= max && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !plain(project_id, 80) || !plain(workflow_id, 64) {
            return Err(BridgeError::new("PHONE_HOOK_INVALID", "That workflow cannot have a link."));
        }
        let mut state = lock(&self.state);
        if state.server.is_none() {
            return Err(BridgeError::new("PHONE_OFF", "Turn on phone access first."));
        }
        state.saved.hooks.retain(|hook| hook.project_id != project_id || hook.workflow_id != workflow_id);
        if state.saved.hooks.len() >= MAX_HOOKS {
            return Err(BridgeError::new("PHONE_HOOK_LIMIT", "Too many workflows have links. Remove some first."));
        }
        let secret = random_bytes::<24>()?;
        let id = random_bytes::<8>()?;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret);
        let hook = Hook { id: format!("hk-{}", id.iter().map(|byte| format!("{byte:02x}")).collect::<String>()), project_id: project_id.into(), workflow_id: workflow_id.into(), token_hash: token_hash(&token), created_at: now_ms(), used_at: 0 };
        state.saved.hooks.push(hook.clone());
        self.save(&state)?;
        Ok(NewHook { hook: hook.info(), token })
    }

    pub fn hook_remove(&self, id: &str) -> BridgeResult<PhoneStatus> {
        let mut state = lock(&self.state);
        state.saved.hooks.retain(|hook| hook.id != id);
        self.save(&state)?;
        Ok(Self::status_of(&state))
    }

    /// A call to a workflow's link: the page starts the run, if the workflow is on.
    fn fire(&self, token: &str, body: &[u8]) -> Response {
        let gone = || Response::error(404, "PHONE_HOOK_GONE", "This link was removed or never existed.");
        if token.len() != 32 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return gone();
        }
        if body.len() > MAX_HOOK_INPUT {
            return Response::error(413, "PHONE_HOOK_TOO_LARGE", "Send up to 16 KB.");
        }
        let Ok(input) = std::str::from_utf8(body) else {
            return Response::error(415, "PHONE_HOOK_NOT_TEXT", "Send text, such as JSON.");
        };
        let hash = token_hash(token);
        let hook = {
            let mut state = lock(&self.state);
            let now = now_ms();
            let Some(hook) = state.saved.hooks.iter_mut().find(|hook| same(hook.token_hash.as_bytes(), hash.as_bytes())) else {
                return gone();
            };
            if now.saturating_sub(hook.used_at) < HOOK_SPACING_MS {
                return Response::error(429, "PHONE_HOOK_BUSY", "This link was called moments ago. Try again in a few seconds.");
            }
            hook.used_at = now;
            let hook = hook.clone();
            let _ = self.save(&state);
            hook
        };
        self.relay(&hook.id, "hook.fire", json!({ "projectId": hook.project_id, "workflowId": hook.workflow_id, "input": input }))
    }

    fn shared(&self, token: &str, kind: ShareKind) -> Option<Share> {
        if token.len() != 32 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return None;
        }
        lock(&self.state).saved.shares.iter().find(|share| share.kind == kind && same(share.token.as_bytes(), token.as_bytes())).cloned()
    }

    /// A phone's notifications: its subscription and page origin, or none. The engine checks the
    /// subscription again before sending to it.
    pub fn set_push(&self, device: &str, push: Option<Value>) -> BridgeResult<()> {
        if let Some(push) = &push {
            let origin = push.get("origin").and_then(Value::as_str).unwrap_or_default();
            let fits = serde_json::to_vec(push).map_or(usize::MAX, |bytes| bytes.len()) <= MAX_PUSH;
            if !fits || !push.get("subscription").is_some_and(Value::is_object) || !origin.starts_with("https://") || origin.len() > 300 {
                return Err(BridgeError::new("PHONE_PUSH_INVALID", "That notification subscription is not valid."));
            }
        }
        let mut state = lock(&self.state);
        let entry = state.saved.devices.iter_mut().find(|entry| entry.id == device).ok_or_else(|| BridgeError::new("PHONE_NOT_PAIRED", "That phone is not paired."))?;
        entry.push = push;
        self.save(&state)?;
        self.changed(&state);
        Ok(())
    }

    pub fn push_targets(&self) -> Vec<PushTarget> {
        let mut state = lock(&self.state);
        if Self::unpair_idle(&mut state, now_ms()) {
            let _ = self.save(&state);
        }
        let targets = state
            .saved
            .devices
            .iter()
            .filter_map(|device| {
                let push = device.push.as_ref()?;
                Some(PushTarget { device: device.id.clone(), subscription: push.get("subscription")?.clone(), origin: push.get("origin")?.as_str()?.to_string() })
            })
            .collect();
        targets
    }

    /// The page's answer to call `id`; one that came too late is dropped.
    pub fn answer(&self, id: u64, ok: bool, body: Value) {
        if let Some(sender) = lock(&self.waiting).remove(&id) {
            let _ = sender.send(Answer { ok, body });
        }
    }

    fn accept(self: Arc<Self>, listener: &TcpListener, stop: &AtomicBool) {
        for stream in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            if self.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                self.open.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let phone = Arc::clone(&self);
            let spawned = std::thread::Builder::new().name("runrail-phone-request".into()).spawn(move || {
                phone.serve(stream);
                phone.open.fetch_sub(1, Ordering::SeqCst);
            });
            if spawned.is_err() {
                self.open.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
        let request = match read_request(&mut stream, Instant::now() + READ_TIMEOUT) {
            Ok(request) => request,
            Err(response) => return write_response(&mut stream, &response, false),
        };
        let tailnet = lock(&self.tailnet).clone();
        let response = if request.headers.get("host").is_none_or(|host| !host_allowed(host, tailnet.as_deref())) {
            Response::error(421, "PHONE_HOST_REFUSED", "this address does not serve Runrail")
        } else {
            self.route(&request)
        };
        write_response(&mut stream, &response, request.method == "HEAD");
    }

    fn route(&self, request: &Request) -> Response {
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/api/pair") => self.pair_phone(&request.body),
            ("POST", "/api/call") => self.call(request.headers.get("authorization").map(String::as_str), &request.body),
            ("POST", "/api/share") => self.read_share(&request.body),
            ("POST", path) if path.starts_with("/hook/") => self.fire(&path[6..], &request.body),
            (_, path) if path.starts_with("/hook/") => Response::error(405, "PHONE_METHOD", "use POST"),
            ("GET" | "HEAD", path) if path.starts_with("/s/") => match self.shared(&path[3..], ShareKind::Thread) {
                Some(_) => self.asset("/"),
                None => Response::error(404, "PHONE_NOT_FOUND", "This link was revoked or never existed."),
            },
            ("GET" | "HEAD", path) if path.starts_with("/p/") => self.page(&path[3..]),
            ("GET" | "HEAD", path) if !path.starts_with("/api/") => self.asset(path),
            (_, path) if path.starts_with("/api/") => Response::error(405, "PHONE_METHOD", "use POST"),
            _ => Response::error(405, "PHONE_METHOD", "use GET"),
        }
    }

    fn asset(&self, path: &str) -> Response {
        let name = if path == "/" { "phone.html" } else { path.trim_start_matches('/') };
        if !public_asset(name) {
            return Response::error(404, "PHONE_NOT_FOUND", "not found");
        }
        let Some((bytes, kind)) = (self.assets)(name) else {
            return Response::error(404, "PHONE_NOT_FOUND", "not found");
        };
        let headers = if name == "phone.html" { vec![("Content-Security-Policy", PAGE_CSP.to_string())] } else { Vec::new() };
        // Built bundles carry a hash in their names; the page and its worker must always be fresh.
        let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
        let body = if cfg!(target_os = "linux") && name == "phone.html" { linux_page(bytes) } else { bytes };
        Response { status: 200, kind, body, cache, headers }
    }

    /// A shared thread, read-only, for whoever holds its link.
    fn read_share(&self, body: &[u8]) -> Response {
        let token = serde_json::from_slice::<Value>(body).ok().and_then(|value| value.get("token").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        let Some(share) = self.shared(&token, ShareKind::Thread) else {
            return Response::error(404, "PHONE_SHARE_GONE", "This link was revoked or never existed.");
        };
        self.relay(&share.id, "share.thread", json!({ "threadId": share.thread_id }))
    }

    /// A published page's file, from its copy, run on an origin of its own.
    fn page(&self, rest: &str) -> Response {
        let (token, file) = rest.split_once('/').unwrap_or((rest, ""));
        let Some(share) = self.shared(token, ShareKind::Page) else {
            return Response::error(404, "PHONE_NOT_FOUND", "This page was unpublished or never existed.");
        };
        if !rest.contains('/') {
            return Response { status: 301, kind: "text/plain".into(), body: Vec::new(), cache: "no-store", headers: vec![("Location", format!("/p/{token}/"))] };
        }
        let Some(path) = crate::pages::resolve(&self.pages.join(&share.id), file) else {
            return Response::error(404, "PHONE_NOT_FOUND", "not found");
        };
        let Ok(bytes) = std::fs::read(&path) else {
            return Response::error(404, "PHONE_NOT_FOUND", "not found");
        };
        // Module scripts load with CORS from the sandbox's opaque origin.
        Response { status: 200, kind: crate::pages::media_type(&path).into(), body: bytes, cache: "no-cache", headers: vec![("Content-Security-Policy", PAGE_SANDBOX.to_string()), ("Access-Control-Allow-Origin", "*".into())] }
    }

    fn pair_phone(&self, body: &[u8]) -> Response {
        #[derive(Deserialize)]
        struct Input {
            code: String,
            #[serde(default)]
            name: String,
        }
        let Ok(input) = serde_json::from_slice::<Input>(body) else {
            return Response::error(400, "PHONE_BAD_REQUEST", "send a code");
        };
        let mut state = lock(&self.state);
        let now = now_ms();
        let Some(pairing) = state.pairing.as_mut().filter(|pairing| pairing.expires_at > now) else {
            return Response::error(403, "PHONE_PAIRING_EXPIRED", &format!("No pairing code is open. Show a new one on your {COMPUTER}."));
        };
        pairing.tries += 1;
        if !same(normal_code(&input.code).as_bytes(), pairing.code.as_bytes()) {
            let used = pairing.tries >= PAIRING_TRIES;
            if used {
                state.pairing = None;
            }
            return Response::error(403, "PHONE_PAIRING_WRONG", &if used { format!("That code is not right, and it is used up. Show a new one on your {COMPUTER}.") } else { "That code is not right.".to_string() });
        }
        state.pairing = None;
        if state.saved.devices.len() >= MAX_DEVICES {
            return Response::error(409, "PHONE_DEVICE_LIMIT", &format!("Too many phones are paired. Remove one on your {COMPUTER} first."));
        }
        let (Ok(secret), Ok(id)) = (random_bytes::<32>(), random_bytes::<8>()) else {
            return Response::error(503, "PHONE_RANDOM_FAILED", "Try again.");
        };
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret);
        let id = format!("ph-{}", id.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        state.saved.devices.push(Device { id: id.clone(), name: clean_name(&input.name), token_hash: token_hash(&token), added_at: now, seen_at: now, push: None });
        if self.save(&state).is_err() {
            state.saved.devices.retain(|device| device.id != id);
            return Response::error(503, "PHONE_SAVE_FAILED", &format!("The pairing could not be saved on your {COMPUTER}."));
        }
        self.changed(&state);
        Response::json(200, &json!({ "token": token, "device": id }))
    }

    /// Which paired phone the bearer token belongs to; noting when it was last seen.
    fn device_for(&self, authorization: Option<&str>) -> Option<String> {
        let token = authorization?.strip_prefix("Bearer ")?.trim();
        if token.is_empty() || token.len() > 128 {
            return None;
        }
        let hash = token_hash(token);
        let mut state = lock(&self.state);
        let now = now_ms();
        if Self::unpair_idle(&mut state, now) {
            let _ = self.save(&state);
            self.changed(&state);
        }
        let device = state.saved.devices.iter_mut().find(|device| same(device.token_hash.as_bytes(), hash.as_bytes()))?;
        let id = device.id.clone();
        if now.saturating_sub(device.seen_at) > SEEN_WRITE_MS {
            device.seen_at = now;
            let _ = self.save(&state);
        }
        Some(id)
    }

    fn call(&self, authorization: Option<&str>, body: &[u8]) -> Response {
        #[derive(Deserialize)]
        struct Input {
            method: String,
            #[serde(default)]
            params: Value,
        }
        let Some(device) = self.device_for(authorization) else {
            return Response::error(401, "PHONE_NOT_PAIRED", &format!("This phone is not paired with Runrail. Pair it again from your {COMPUTER}."));
        };
        let Ok(input) = serde_json::from_slice::<Input>(body) else {
            return Response::error(400, "PHONE_BAD_REQUEST", "send a method");
        };
        if input.method.is_empty() || input.method.len() > 64 || !input.method.chars().all(|c| c.is_ascii_lowercase() || c == '.') {
            return Response::error(400, "PHONE_BAD_REQUEST", "method is invalid");
        }
        // These reach the page only through their own links, which name what they act on.
        if input.method.starts_with("share.") || input.method.starts_with("hook.") {
            return Response::error(400, "PHONE_UNKNOWN_METHOD", "Runrail does not do that from a phone.");
        }
        let params = if input.params.is_null() { json!({}) } else { input.params };
        if !params.is_object() {
            return Response::error(400, "PHONE_BAD_REQUEST", "params must be an object");
        }
        self.relay(&device, &input.method, params)
    }

    /// Hands one call to the app's page and waits for its answer.
    fn relay(&self, device: &str, method: &str, params: Value) -> Response {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        lock(&self.waiting).insert(id, sender);
        (self.emit)("phone:call", json!({ "id": id, "device": device, "method": method, "params": params }));
        let answer = receiver.recv_timeout(CALL_TIMEOUT);
        lock(&self.waiting).remove(&id);
        match answer {
            Ok(Answer { ok: true, body }) => {
                let bytes = serde_json::to_vec(&json!({ "result": body })).unwrap_or_default();
                if bytes.len() > MAX_ANSWER {
                    return Response::error(413, "PHONE_ANSWER_LIMIT", "The answer is too large for the phone.");
                }
                Response { status: 200, kind: "application/json".into(), body: bytes, cache: "no-store", headers: Vec::new() }
            }
            Ok(Answer { ok: false, body }) => {
                let code = body.get("code").and_then(Value::as_str).unwrap_or("PHONE_CALL_FAILED");
                let message = body.get("message").and_then(Value::as_str).unwrap_or("Runrail could not do that.");
                // Webhook senders retry a 503, not a 400, so a passing failure to read workflows loses no call.
                if code == "PHONE_HOOK_UNAVAILABLE" {
                    let mut response = Response::error(503, code, message);
                    response.headers.push(("Retry-After", "60".into()));
                    return response;
                }
                Response::error(400, code, message)
            }
            Err(_) => Response::error(504, "PHONE_NO_ANSWER", &format!("Runrail on your {COMPUTER} did not answer in time.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    #[test]
    fn hosts_are_this_mac_or_its_tailnet_name() {
        for host in ["127.0.0.1:4000", "localhost:4000", "mac.tail1234.ts.net", "mac.tail1234.ts.net:8443", "MAC.Tail1234.TS.NET"] {
            assert!(host_allowed(host, None), "{host}");
            assert!(host_allowed(host, Some("mac.tail1234.ts.net")), "{host}");
        }
        for host in ["", "evil.example", "ts.net", ".ts.net", "ts.net.evil.example", "a.ts.net:x", "a b.ts.net", "10.0.0.2:4000"] {
            assert!(!host_allowed(host, None), "{host}");
        }
        // Once this Mac's name is known, another tailnet name is refused.
        assert!(!host_allowed("other.tail9999.ts.net:8443", Some("mac.tail1234.ts.net")));
    }

    #[test]
    fn a_request_sent_a_byte_at_a_time_is_cut_off_at_its_deadline() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let writer = std::thread::spawn(move || {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            for byte in b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX: aaaaaaaaaaaaaaaa" {
                if stream.write_all(&[*byte]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        });
        let (mut stream, _) = listener.accept().expect("accept");
        let started = Instant::now();
        let refused = read_request(&mut stream, started + Duration::from_millis(300)).err().expect("timed out");
        assert_eq!(refused.status, 408);
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(stream);
        let _ = writer.join();
    }

    #[test]
    fn a_phone_unused_for_thirty_days_is_unpaired() {
        let dir = std::env::temp_dir().join(format!("rr-phone-idle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let now = now_ms();
        let device = |id: &str, token: &str, seen_at: u64| json!({ "id": id, "name": id, "tokenHash": token_hash(token), "addedAt": seen_at, "seenAt": seen_at });
        let saved = json!({ "devices": [device("ph-old", "old-token", now - IDLE_UNPAIR_MS - 60_000), device("ph-new", "new-token", now - 60_000)] });
        std::fs::write(dir.join("phone.json"), saved.to_string()).expect("write");
        let phone = Phone::new(&dir, Arc::new(|_, _| {}), Arc::new(|_| None));
        assert_eq!(phone.device_for(Some("Bearer old-token")), None);
        assert_eq!(phone.device_for(Some("Bearer new-token")).as_deref(), Some("ph-new"));
        assert_eq!(phone.status().devices.iter().map(|device| device.id.as_str()).collect::<Vec<_>>(), ["ph-new"]);
        assert!(!std::fs::read_to_string(dir.join("phone.json")).expect("saved").contains("ph-old"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_linux_served_page_says_so_on_its_root() {
        assert_eq!(linux_page(b"<!doctype html>\n<html lang=\"en\"><body>".to_vec()), b"<!doctype html>\n<html data-host=\"linux\" lang=\"en\"><body>");
        assert_eq!(linux_page(b"no root".to_vec()), b"no root");
    }

    #[test]
    fn only_the_phone_page_and_the_bundle_are_served() {
        for name in ["phone.html", "phone-sw.js", "phone-manifest.webmanifest", "assets/phone-AbC123.js", "assets/index-9f.css"] {
            assert!(public_asset(name), "{name}");
        }
        for name in ["index.html", "", "assets/../index.html", "assets/a/b.js", "phone-x/y.js", "src/main.tsx", "assets/a b.js", "..", "phone.html%00"] {
            assert!(!public_asset(name), "{name}");
        }
    }

    #[test]
    fn codes_and_names_are_taken_as_typed() {
        assert_eq!(normal_code(" abcd-efgh "), "ABCDEFGH");
        assert_eq!(clean_name("  "), "Phone");
        assert_eq!(clean_name("Ana's\u{0007} iPhone"), "Ana's iPhone");
        assert_eq!(clean_name(&"x".repeat(100)).len(), MAX_NAME);
        assert!(same(b"abc", b"abc") && !same(b"abc", b"abd") && !same(b"abc", b"ab"));
    }

    fn exchange(port: u16, raw: &str) -> (u16, String) {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        stream.write_all(raw.as_bytes()).expect("write");
        let mut text = String::new();
        stream.read_to_string(&mut text).expect("read");
        let status = text.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
        (status, text)
    }

    fn post(port: u16, path: &str, token: Option<&str>, body: &Value) -> (u16, Value) {
        let body = body.to_string();
        let auth = token.map(|token| format!("Authorization: Bearer {token}\r\n")).unwrap_or_default();
        let (status, text) = exchange(port, &format!("POST {path} HTTP/1.1\r\nHost: mac.tail1.ts.net\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        let json = text.split_once("\r\n\r\n").and_then(|(_, body)| serde_json::from_str(body).ok()).unwrap_or(Value::Null);
        (status, json)
    }

    #[test]
    fn a_paired_phone_calls_the_page_and_nothing_else_gets_in() {
        let dir = std::env::temp_dir().join(format!("rr-phone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let slot: Arc<OnceLock<Arc<Phone>>> = Arc::new(OnceLock::new());
        let page = Arc::clone(&slot);
        let emit: Emitter = Arc::new(move |name, payload| {
            if name != "phone:call" {
                return;
            }
            let phone = Arc::clone(page.get().expect("phone"));
            std::thread::spawn(move || {
                let id = payload["id"].as_u64().expect("id");
                if payload["method"] == "threads" {
                    phone.answer(id, true, json!({ "threads": [], "device": payload["device"] }));
                } else if payload["method"] == "share.thread" {
                    phone.answer(id, true, json!({ "threadId": payload["params"]["threadId"] }));
                } else if payload["method"] == "hook.fire" && payload["params"]["input"] == "unsure" {
                    phone.answer(id, false, json!({ "code": "PHONE_HOOK_UNAVAILABLE", "message": "try again" }));
                } else if payload["method"] == "hook.fire" {
                    phone.answer(id, true, json!({ "workflowId": payload["params"]["workflowId"], "input": payload["params"]["input"], "device": payload["device"] }));
                } else {
                    phone.answer(id, false, json!({ "code": "PHONE_UNKNOWN_METHOD", "message": "unknown" }));
                }
            });
        });
        let assets: Assets = Arc::new(|name| (name == "phone.html").then(|| (b"<!doctype html>".to_vec(), "text/html".to_string())));
        let phone = Phone::new(&dir, emit, assets);
        let _ = slot.set(Arc::clone(&phone));
        let port = phone.set(true).expect("on").port;

        let (status, page) = exchange(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(status, 200);
        assert!(page.contains("Content-Security-Policy: default-src 'self'") && page.ends_with("<!doctype html>"));
        assert_eq!(exchange(port, "GET /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").0, 404);
        assert_eq!(exchange(port, "GET / HTTP/1.1\r\nHost: rebound.example\r\n\r\n").0, 421);

        // No code open, then a wrong code, then the right one.
        assert_eq!(post(port, "/api/pair", None, &json!({ "code": "AAAAAAAA" })).0, 403);
        let code = phone.pair().expect("pair").pairing.expect("code").code;
        assert_eq!(post(port, "/api/pair", None, &json!({ "code": "AAAAAAA2" })).1["error"]["code"], "PHONE_PAIRING_WRONG");
        let (status, paired) = post(port, "/api/pair", None, &json!({ "code": code.to_lowercase(), "name": "Test phone" }));
        assert_eq!(status, 200);
        let token = paired["token"].as_str().expect("token").to_string();
        // A code works once.
        assert_eq!(post(port, "/api/pair", None, &json!({ "code": code })).0, 403);
        let saved = std::fs::read_to_string(dir.join("phone.json")).expect("saved");
        assert!(saved.contains("Test phone") && !saved.contains(&token));

        let (status, answer) = post(port, "/api/call", Some(&token), &json!({ "method": "threads" }));
        assert_eq!(status, 200);
        assert_eq!(answer["result"]["device"], paired["device"]);
        assert_eq!(post(port, "/api/call", Some(&token), &json!({ "method": "nope" })).1["error"]["code"], "PHONE_UNKNOWN_METHOD");
        assert_eq!(post(port, "/api/call", Some("wrong"), &json!({ "method": "threads" })).0, 401);
        assert_eq!(post(port, "/api/call", Some(&token), &json!({ "method": "Threads!" })).0, 400);
        // A thread's read-only view and a workflow's start are reached only through their own links.
        for method in ["share.thread", "hook.fire"] {
            assert_eq!(post(port, "/api/call", Some(&token), &json!({ "method": method, "params": { "threadId": "th-1", "workflowId": "x" } })).1["error"]["code"], "PHONE_UNKNOWN_METHOD");
        }

        // Five wrong tries use a code up.
        let code = phone.pair().expect("pair").pairing.expect("code").code;
        for _ in 0..PAIRING_TRIES {
            post(port, "/api/pair", None, &json!({ "code": "ZZZZZZZZ" }));
        }
        assert_eq!(post(port, "/api/pair", None, &json!({ "code": code })).0, 403);

        let device = paired["device"].as_str().expect("device");
        let push = json!({ "subscription": { "endpoint": "https://web.push.apple.com/x", "keys": { "p256dh": "k", "auth": "a" } }, "origin": "https://mac.tail1.ts.net:8443" });
        assert!(phone.set_push(device, Some(json!({ "subscription": {}, "origin": "http://mac" }))).is_err());
        assert!(phone.set_push("ph-unknown", Some(push.clone())).is_err());
        phone.set_push(device, Some(push.clone())).expect("push");
        assert!(phone.status().devices[0].notifies);
        assert_eq!(phone.push_targets(), vec![PushTarget { device: device.to_string(), subscription: push["subscription"].clone(), origin: "https://mac.tail1.ts.net:8443".into() }]);
        phone.set_push(device, None).expect("no push");
        assert!(phone.push_targets().is_empty());
        assert!(phone.forget(device).expect("forget").devices.is_empty());
        assert_eq!(post(port, "/api/call", Some(&token), &json!({ "method": "threads" })).0, 401);

        // A thread's link opens the page and reads only that thread; one link per thread.
        let link = phone.share_thread("th-1", "Fix the parser").expect("share");
        assert_eq!(phone.share_thread("th-1", "Fix the parser").expect("again").token, link.token);
        assert!(phone.share_thread("../x", "x").is_err());
        assert_eq!(exchange(port, &format!("GET /s/{} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", link.token)).0, 200);
        assert_eq!(exchange(port, "GET /s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").0, 404);
        assert_eq!(post(port, "/api/share", None, &json!({ "token": link.token })).1["result"]["threadId"], "th-1");
        assert_eq!(post(port, "/api/share", None, &json!({ "token": "nope" })).0, 404);

        // A page is a copy, served in a sandbox of its own.
        let site = dir.join("site");
        std::fs::create_dir_all(&site).expect("site");
        std::fs::write(site.join("index.html"), "<p>page</p>").expect("index");
        std::fs::write(site.join(".env"), "SECRET=1").expect("env");
        let plan = crate::pages::plan(&site).expect("plan");
        let page = phone.publish(&site, &plan, "site").expect("publish");
        std::fs::write(site.join("index.html"), "<p>changed</p>").expect("change");
        let base = format!("/p/{}", page.token);
        let (status, moved) = exchange(port, &format!("GET {base} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
        assert!(status == 301 && moved.contains(&format!("Location: {base}/")));
        let (status, served) = exchange(port, &format!("GET {base}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
        assert_eq!(status, 200);
        assert!(served.contains("Content-Security-Policy: sandbox allow-scripts") && served.ends_with("<p>page</p>"));
        assert_eq!(exchange(port, &format!("GET {base}/.env HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).0, 404);
        assert_eq!(phone.status().shares.len(), 2);
        phone.unshare(&page.id).expect("unpublish");
        phone.unshare(&link.id).expect("revoke");
        assert_eq!(exchange(port, &format!("GET {base}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).0, 404);
        assert_eq!(post(port, "/api/share", None, &json!({ "token": link.token })).0, 404);
        assert!(!dir.join("phone-pages").join(&page.id).exists());

        // A workflow's link starts it at most every few seconds; only the link's fingerprint is kept,
        // and a new link ends the old one.
        assert!(phone.hook_create("p 1", "nightly").is_err());
        let made = phone.hook_create("p-1", "nightly").expect("hook");
        assert!(!std::fs::read_to_string(dir.join("phone.json")).expect("saved").contains(&made.token));
        let path = format!("/hook/{}", made.token);
        let fire = |body: &str| exchange(port, &format!("POST {path} HTTP/1.1\r\nHost: mac.tail1.ts.net\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert_eq!(fire(&"x".repeat(MAX_HOOK_INPUT + 1)).0, 413);
        let (status, started) = fire("{\"alert\": \"disk full\"}");
        assert_eq!(status, 200);
        assert!(started.contains("\"workflowId\":\"nightly\"") && started.contains("disk full") && started.contains(&made.hook.id));
        assert_eq!(fire("again").0, 429);
        assert!(phone.status().hooks[0].used_at.is_some());
        assert_eq!(exchange(port, &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).0, 405);
        let renewed = phone.hook_create("p-1", "nightly").expect("renew");
        assert_eq!(phone.status().hooks.len(), 1);
        assert_eq!(fire("old").0, 404);
        let (status, unsure) = exchange(port, &format!("POST /hook/{} HTTP/1.1\r\nHost: mac.tail1.ts.net\r\nContent-Length: 6\r\n\r\nunsure", renewed.token));
        assert!(status == 503 && unsure.contains("Retry-After: 60"), "a page that could not read its workflows asks the sender to retry");
        assert!(phone.hook_remove(&renewed.hook.id).expect("remove").hooks.is_empty());

        // Off closes the port; on again takes the same one.
        phone.set(false).expect("off");
        std::thread::sleep(Duration::from_millis(100));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
        assert_eq!(phone.set(true).expect("on").port, port);
        phone.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
