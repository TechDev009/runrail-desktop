use std::collections::{HashMap, VecDeque};
use std::sync::{mpsc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, Url, Webview, WebviewBuilder, WebviewUrl};
#[cfg(not(target_os = "linux"))]
use tauri::{LogicalPosition, LogicalSize, Rect};

use crate::error::{BridgeError, BridgeResult};
use crate::preview::Bounds;

pub const LABEL: &str = "custom-screen-runtime";
pub const SCHEME: &str = "runrail-screen";
pub const REQUEST_EVENT: &str = "custom-screen:request";
const MAX_SOURCE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_REPLY_BYTES: usize = 512 * 1024;
const MAX_PENDING: usize = 16;
const MAX_REQUESTS_PER_MINUTE: usize = 120;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_WINDOW: Duration = Duration::from_secs(60);
const MAX_EDGE: f64 = 20_000.0;
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub html: String,
    pub css: String,
    pub javascript: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub method: String,
    pub args: Value,
}

#[derive(Default)]
pub struct CustomScreen {
    source: Mutex<Option<Source>>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Value>>>,
    requests: Mutex<VecDeque<Instant>>,
    next: std::sync::atomic::AtomicU64,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("CUSTOM_SCREEN_INVALID_INPUT", message).with_status(400)
}

fn failed() -> BridgeError {
    BridgeError::new(
        "CUSTOM_SCREEN_FAILED",
        "the custom screen could not be shown",
    )
}

fn source_size(source: &Source) -> usize {
    source.html.len() + source.css.len() + source.javascript.len()
}

fn check_bounds(bounds: &Bounds) -> BridgeResult<()> {
    let valid = |value: f64, min: f64| value.is_finite() && (min..=MAX_EDGE).contains(&value);
    if valid(bounds.x, 0.0)
        && valid(bounds.y, 0.0)
        && valid(bounds.width, 1.0)
        && valid(bounds.height, 1.0)
    {
        Ok(())
    } else {
        Err(invalid("custom screen bounds are invalid"))
    }
}

fn runrail_api() -> &'static str {
    r#"(() => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  const subscriptions = new Set();
  const request = (method, args = {}) => {
    if (typeof invoke !== "function") return Promise.reject(new Error("Runrail API is unavailable"));
    return invoke("custom_screen_request", { method: `v1.${method}`, args }).then((reply) => {
      if (reply && reply.ok === false) throw new Error(reply.error || "Runrail request failed");
      return reply && Object.hasOwn(reply, "value") ? reply.value : reply;
    });
  };
  const api = Object.freeze({
    version: 1,
    request,
    catalog: () => request("api.catalog"),
    app: Object.freeze({
      snapshot: () => request("app.snapshot"),
      open: (view, detail) => request("app.open", { view, detail }),
      subscribe: (listener, interval = 1000) => {
        if (typeof listener !== "function") throw new TypeError("Runrail app subscription needs a function");
        if (subscriptions.size >= 1) throw new Error("Runrail app already has a subscription");
        let stopped = false, busy = false, previous;
        const tick = async () => {
          if (stopped || busy) return;
          busy = true;
          try {
            const next = await api.app.snapshot();
            const encoded = JSON.stringify(next);
            if (encoded !== previous) { const before = previous === undefined ? undefined : JSON.parse(previous); previous = encoded; listener(next, before); }
          } catch (error) { console.error(error); }
          finally { busy = false; }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), Math.max(1000, Math.min(30000, Number(interval) || 1000)));
        const stop = () => { if (stopped) return; stopped = true; window.clearInterval(timer); subscriptions.delete(stop); };
        subscriptions.add(stop);
        return stop;
      },
    }),
    projects: Object.freeze({ list: (options = {}) => request("projects.list", options), open: (id) => request("projects.open", { id }) }),
    threads: Object.freeze({
      list: (filters = {}) => request("threads.list", filters),
      get: (id, options = {}) => request("threads.get", { id, ...options }),
      create: (input) => request("threads.create", input),
      open: (id) => request("threads.open", { id }),
      send: (id, input) => request("threads.send", { id, input }),
      steer: (id, input) => request("threads.steer", { id, input }),
      stop: (id) => request("threads.cancel", { id }),
      setPermission: (id, permission) => request("threads.setPermission", { id, permission }),
      setMode: (id, mode) => request("threads.setMode", { id, mode }),
      setAccess: (id, access) => request("threads.setAccess", { id, access }),
      setModel: (id, selection) => request("threads.setModel", { id, selection }),
      rename: (id, title) => request("threads.rename", { id, title }),
      archive: (id) => request("threads.archive", { id }),
      delete: (id) => request("threads.delete", { id }),
      reload: (id) => request("threads.reload", { id }),
      openApproval: (id) => request("threads.openApproval", { id }),
    }),
    features: Object.freeze({ open: (name, detail) => request("features.open", { name, detail }) }),
    workflows: Object.freeze({
      list: (projectId) => request("workflows.list", { projectId }),
      run: (projectId, id, input) => request("workflows.run", { projectId, id, input }),
      openRun: (runId) => request("workflows.openRun", { runId }),
      stop: (runId) => request("workflows.stop", { runId }),
      openForApproval: (projectId, id) => request("workflows.openForApproval", { projectId, id }),
      enable: (projectId, id, on) => request("workflows.enable", { projectId, id, on }),
      delete: (projectId, id) => request("workflows.delete", { projectId, id }),
    }),
    panels: Object.freeze({
      list: (threadId) => request("panels.list", { threadId }),
      open: (threadId, kind) => request("panels.open", { threadId, kind }),
      create: (threadId, kind, url) => request("panels.create", { threadId, kind, ...(url === undefined ? {} : { url }) }),
      select: (threadId, tabId) => request("panels.select", { threadId, tabId }),
      close: (threadId, tabId) => request("panels.close", { threadId, tabId }),
    }),
    rpc: Object.freeze({
      thread: (threadId, method, params = {}) => request("rpc.thread", { threadId, method, params }),
      project: (projectId, method, params = {}) => request("rpc.project", { projectId, method, params }),
      system: (method, params = {}) => request("rpc.system", { method, params }),
    }),
    host: Object.freeze({ call: (name, ...args) => request("host.call", { name, args }) }),
  });
  Object.defineProperty(window, "runrail", { value: api, configurable: false, enumerable: true, writable: false });
  window.addEventListener("error", (event) => {
    void request("runtime.error", { message: String(event.message || "JavaScript error").slice(0, 500) }).catch(() => undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    void request("runtime.error", { message: String(reason instanceof Error ? reason.message : reason || "Unhandled promise rejection").slice(0, 500) }).catch(() => undefined);
  });
})();"#
}

fn escape_style(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() {
        if offset + 7 <= bytes.len() && bytes[offset..offset + 7].eq_ignore_ascii_case(b"</style") {
            output.push_str("\\3C /style");
            offset += 7;
        } else {
            let character = value[offset..]
                .chars()
                .next()
                .expect("valid UTF-8 boundary");
            output.push(character);
            offset += character.len_utf8();
        }
    }
    output
}

fn escape_script(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() {
        if offset + 8 <= bytes.len() && bytes[offset..offset + 8].eq_ignore_ascii_case(b"</script")
        {
            output.push_str("<\\/script");
            offset += 8;
        } else {
            let character = value[offset..]
                .chars()
                .next()
                .expect("valid UTF-8 boundary");
            output.push(character);
            offset += character.len_utf8();
        }
    }
    output
}

fn document(source: &Source) -> Vec<u8> {
    let mut html = String::with_capacity(source_size(source) + 256);
    html.push_str("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>");
    html.push_str(&escape_style(&source.css));
    html.push_str("</style></head><body>");
    html.push_str(&source.html);
    html.push_str("<script>");
    html.push_str(&escape_script(&source.javascript));
    html.push_str("</script></body></html>");
    html.into_bytes()
}

fn protocol_response(status: u16, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

pub fn respond(
    app: &AppHandle,
    webview: &str,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if webview != LABEL || request.uri().path() != "/screen" {
        return protocol_response(404, b"Not found".to_vec());
    }
    let source = app
        .state::<CustomScreen>()
        .source
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    match source {
        Some(source) => protocol_response(200, document(&source)),
        None => protocol_response(404, b"No custom screen is active".to_vec()),
    }
}

impl CustomScreen {
    pub fn open(&self, app: &AppHandle, source: Source, bounds: Bounds) -> BridgeResult<()> {
        check_bounds(&bounds)?;
        if source_size(&source) > MAX_SOURCE_BYTES {
            return Err(invalid("custom screen source is too large"));
        }
        *self.source.lock().unwrap_or_else(PoisonError::into_inner) = Some(source);
        let url = Url::parse(&format!(
            "{SCHEME}://localhost/screen?revision={}",
            self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
        .map_err(|_| failed())?;
        if let Some(webview) = app.get_webview(LABEL) {
            webview.navigate(url).map_err(|_| failed())?;
            place(&webview, bounds)?;
            return Ok(());
        }
        let window = app.get_window("main").ok_or_else(failed)?;
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::CustomProtocol(url))
            .devtools(cfg!(debug_assertions))
            .initialization_script(runrail_api())
            .on_navigation(|url| {
                url.scheme() == SCHEME
                    && url.host_str() == Some("localhost")
                    && url.path() == "/screen"
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_permission_request(|_, _| PermissionResponse::Deny);
        #[cfg(not(target_os = "linux"))]
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|_| failed())?;
        #[cfg(target_os = "linux")]
        let webview =
            crate::preview_gtk::add_child(&window, app, builder, bounds).ok_or_else(failed)?;
        if webview.label() != LABEL {
            let _ = webview.close();
            return Err(failed());
        }
        Ok(())
    }

    pub fn bounds(&self, app: &AppHandle, bounds: Option<Bounds>) -> BridgeResult<()> {
        let Some(webview) = app.get_webview(LABEL) else {
            return Ok(());
        };
        let Some(bounds) = bounds else {
            webview.hide().map_err(|_| failed())?;
            return Ok(());
        };
        check_bounds(&bounds)?;
        place(&webview, bounds)
    }

    pub fn close(&self, app: &AppHandle) {
        if let Some(webview) = app.get_webview(LABEL) {
            let _ = webview.close();
        }
        self.source
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    pub fn begin_request(
        &self,
        method: String,
        args: Value,
    ) -> BridgeResult<(Request, mpsc::Receiver<Value>)> {
        if !method.starts_with("v1.") || method.len() > 128 {
            return Err(invalid("Runrail API method is invalid"));
        }
        if serde_json::to_vec(&args).map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES) {
            return Err(invalid("Runrail API request is too large"));
        }
        {
            let now = Instant::now();
            let mut requests = self.requests.lock().unwrap_or_else(PoisonError::into_inner);
            while requests
                .front()
                .is_some_and(|started| now.duration_since(*started) >= REQUEST_WINDOW)
            {
                requests.pop_front();
            }
            if requests.len() >= MAX_REQUESTS_PER_MINUTE {
                return Err(BridgeError::new(
                    "CUSTOM_SCREEN_RATE_LIMIT",
                    "custom screen API request limit reached",
                )
                .with_status(429));
            }
            requests.push_back(now);
        }
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if pending.len() >= MAX_PENDING {
            return Err(BridgeError::new(
                "CUSTOM_SCREEN_BUSY",
                "too many Runrail requests are pending",
            )
            .with_status(429));
        }
        let id = format!(
            "h{}",
            self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        pending.insert(id.clone(), sender);
        Ok((Request { id, method, args }, receiver))
    }

    pub fn finish_request(&self, id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }

    pub fn reply(&self, id: &str, response: Value) -> BridgeResult<()> {
        if id.len() > 32
            || serde_json::to_vec(&response).map_or(true, |bytes| bytes.len() > MAX_REPLY_BYTES)
        {
            return Err(invalid("Runrail API reply is invalid"));
        }
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id)
            .ok_or_else(|| invalid("Runrail request has expired"))?;
        sender
            .send(response)
            .map_err(|_| invalid("Runrail request has expired"))
    }
}

pub async fn request(
    app: AppHandle,
    webview: Webview,
    method: String,
    args: Value,
) -> BridgeResult<Value> {
    if webview.label() != LABEL {
        return Err(BridgeError::new(
            "CUSTOM_SCREEN_REFUSED",
            "this webview cannot call the Runrail screen API",
        )
        .with_status(403));
    }
    let (request, receiver) = app.state::<CustomScreen>().begin_request(method, args)?;
    let id = request.id.clone();
    if app.emit_to("main", REQUEST_EVENT, request).is_err() {
        app.state::<CustomScreen>().finish_request(&id);
        return Err(failed());
    }
    let response =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(REQUEST_TIMEOUT))
            .await
            .map_err(|_| BridgeError::new("CUSTOM_SCREEN_FAILED", "Runrail request task failed"))?
            .map_err(|_| {
                BridgeError::new(
                    "CUSTOM_SCREEN_TIMEOUT",
                    "Runrail did not answer the request in time",
                )
                .with_status(504)
            });
    app.state::<CustomScreen>().finish_request(&id);
    response
}

#[cfg(not(target_os = "linux"))]
fn place(webview: &Webview, bounds: Bounds) -> BridgeResult<()> {
    let rect = Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    };
    webview.set_bounds(rect).map_err(|_| failed())?;
    webview.show().map_err(|_| failed())
}

#[cfg(target_os = "linux")]
fn place(webview: &Webview, bounds: Bounds) -> BridgeResult<()> {
    if crate::preview_gtk::place(webview, bounds) {
        Ok(())
    } else {
        Err(failed())
    }
}
