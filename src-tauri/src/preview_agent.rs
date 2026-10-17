//! What the agent may do in a browser preview when the person lets it. Reading and acting on a
//! page run fixed scripts with checked inputs; the agent's own script runs only after the person
//! says yes in a native dialog, every time; a screenshot is WebKit's own snapshot of the view.

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Webview;

use crate::error::{BridgeError, BridgeResult};

pub const MAX_TEXT: usize = 4096;
pub const MAX_EXPRESSION: usize = 8192;
const MAX_RESULT: usize = 64 * 1024;
const MAX_MESSAGE: usize = 500;
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10);
const KEYS: &[&str] = &["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"];

/// Keeps a page's console errors and warnings, at most 100, for `browser_console`. Runs in every
/// preview before the page's own scripts; it reads nothing and sends nothing.
pub const CONSOLE_RECORDER: &str = r#"(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, "__runrailConsole")) return;
  const entries = [];
  Object.defineProperty(window, "__runrailConsole", { value: entries });
  const text = (value) => {
    try {
      if (value instanceof Error) return String(value.stack || value);
      if (typeof value === "string") return value;
      return JSON.stringify(value) ?? String(value);
    } catch { return String(value); }
  };
  const keep = (level, values) => {
    try {
      entries.push({ level, text: Array.from(values, text).join(" ").slice(0, 2000) });
      if (entries.length > 100) entries.shift();
    } catch {}
  };
  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = function (...values) { keep(level, values); return original.apply(this, values); };
  }
  addEventListener("error", (event) => keep("uncaught", [event.error || event.message]));
  addEventListener("unhandledrejection", (event) => keep("unhandled rejection", [event.reason]));
})();"#;

/// Keeps a page's recent requests, at most 100, for `browser_network`: method,
/// address without its query or fragment (they can carry tokens), status, kind, and time. No
/// headers or bodies. Runs in every preview before the page's own scripts; it sends nothing.
pub const NETWORK_RECORDER: &str = r#"(() => {
  if (window.top !== window || Object.prototype.hasOwnProperty.call(window, "__runrailNetwork")) return;
  const entries = [];
  Object.defineProperty(window, "__runrailNetwork", { value: entries });
  const address = (value) => {
    try { const url = new URL(String(value), location.href); return url.origin + url.pathname + (url.search ? "?..." : ""); }
    catch { return String(value).split(/[?#]/)[0].slice(0, 300); }
  };
  const keep = (entry) => { try { entries.push(entry); if (entries.length > 100) entries.shift(); } catch {} };
  const since = (begun) => Math.round(performance.now() - begun);
  const fetch = window.fetch;
  if (typeof fetch === "function") {
    window.fetch = function (input, init) {
      const begun = performance.now();
      let method = "GET", url = "";
      try { method = String((init && init.method) || (input && input.method) || "GET").toUpperCase(); url = address(typeof input === "string" || input instanceof URL ? input : input && input.url); } catch {}
      return fetch.apply(this, arguments).then(
        (response) => { keep({ kind: "fetch", method, url, status: response.status, ms: since(begun) }); return response; },
        (error) => { keep({ kind: "fetch", method, url, failed: String((error && error.message) || error).slice(0, 200), ms: since(begun) }); throw error; });
    };
  }
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__runrailRequest = { method: String(method).toUpperCase(), url: address(url) }; } catch {}
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const request = this.__runrailRequest, begun = performance.now();
    if (request) this.addEventListener("loadend", () => keep(this.status ? { kind: "xhr", method: request.method, url: request.url, status: this.status, ms: since(begun) } : { kind: "xhr", method: request.method, url: request.url, failed: "no response", ms: since(begun) }));
    return send.apply(this, arguments);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") continue;
        const status = entry.responseStatus;
        keep(status ? { kind: entry.initiatorType || "resource", method: "GET", url: address(entry.name), status, ms: Math.round(entry.duration) } : { kind: entry.initiatorType || "resource", method: "GET", url: address(entry.name), ms: Math.round(entry.duration) });
      }
    }).observe({ type: "resource", buffered: true });
  } catch {}
})();"#;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum Script {
    Snapshot,
    Click {
        #[serde(rename = "ref")]
        target: String,
    },
    Type {
        #[serde(rename = "ref")]
        target: String,
        text: String,
        #[serde(default)]
        submit: bool,
    },
    Press {
        key: String,
    },
    Console,
    Network,
    /// The person picks an element to comment on: the page shows a highlight
    /// until a click or Escape, and the click does not reach the page.
    PickStart,
    PickRead,
    PickStop,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    pub media_type: &'static str,
    pub data_base64: String,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("PREVIEW_INVALID_INPUT", message).with_status(400)
}

fn page_failed(message: &str) -> BridgeError {
    BridgeError::new("PREVIEW_SCRIPT_FAILED", message)
}

fn valid_ref(value: &str) -> bool {
    value.len() >= 2 && value.len() <= 7 && value.starts_with('e') && value[1..].bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_key(value: &str) -> bool {
    KEYS.contains(&value) || (value.len() == 1 && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)))
}

/// A JavaScript string literal; JSON's escaping is valid JavaScript.
fn literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

const HELPERS: &str = r#"
const refs = window.__runrailRefs instanceof Map ? window.__runrailRefs : new Map();
try { Object.defineProperty(window, "__runrailRefs", { value: refs, configurable: true }); } catch {}
const clip = (value, max) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > max ? text.slice(0, max) + "..." : text; };
const done = (text) => JSON.stringify({ ok: true, text: String(text) });
const fail = (message) => JSON.stringify({ ok: false, message: String(message) });
const roleOf = (el) => el.getAttribute("role") || { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" }[el.tagName] || (el.tagName === "INPUT" ? { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", range: "slider" }[el.type] || "textbox" : el.isContentEditable ? "textbox" : "element");
const nameOf = (el) => clip(el.getAttribute("aria-label") || (el.labels && el.labels[0] ? el.labels[0].innerText : "") || el.getAttribute("placeholder") || el.innerText || el.getAttribute("title") || el.getAttribute("alt") || (el.tagName === "INPUT" && /^(submit|button|reset)$/.test(el.type) ? el.value : ""), 80);
const describe = (el) => roleOf(el) + ' "' + nameOf(el) + '"';
const target = (ref) => { const el = refs.get(ref); return el && el.isConnected ? el : undefined; };
"#;

const SNAPSHOT: &str = r#"
const visible = (el) => { const box = el.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) return false; const style = getComputedStyle(el); return style.visibility !== "hidden" && style.display !== "none"; };
const hidden = (el) => el.type === "password" || /password|cc-|one-time-code/i.test(el.getAttribute("autocomplete") || "");
refs.clear();
const lines = [];
let count = 0;
for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true]')) {
  if (count >= 300) break;
  if (!visible(el)) continue;
  const id = "e" + String(++count);
  refs.set(id, el);
  let line = id + " " + describe(el);
  if (el.tagName === "A") line += " -> " + clip(el.getAttribute("href"), 160);
  const field = (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && !/^(submit|button|reset|checkbox|radio)$/.test(el.type);
  if (field) line += hidden(el) ? " (value hidden)" : el.value ? ' value="' + clip(el.value, 100) + '"' : "";
  if ((el.type === "checkbox" || el.type === "radio") && el.checked) line += " checked";
  if (el.disabled) line += " disabled";
  lines.push(line);
}
const body = document.body ? String(document.body.innerText || "") : "";
const text = body.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, 24000);
return done("Address: " + location.href + "\nTitle: " + clip(document.title, 200) + "\n\nText:\n" + text + "\n\nElements:\n" + (lines.join("\n") || "(none)") + (count >= 300 ? "\n(more elements are not listed)" : ""));
"#;

const CONSOLE: &str = r#"
const entries = Array.isArray(window.__runrailConsole) ? window.__runrailConsole : [];
return done(entries.length === 0 ? "No console errors or warnings since the page loaded." : entries.map((entry) => "[" + clip(entry.level, 40) + "] " + String(entry.text).slice(0, 2000)).join("\n"));
"#;

const NETWORK: &str = r#"
const entries = Array.isArray(window.__runrailNetwork) ? window.__runrailNetwork : [];
const bad = entries.filter((entry) => entry.failed || Number(entry.status) >= 400).length;
const line = (entry) => clip(entry.method, 10) + " " + (entry.failed ? "failed (" + clip(entry.failed, 200) + ")" : entry.status ? String(Number(entry.status)) : "-") + " " + clip(entry.url, 300) + " (" + clip(entry.kind, 20) + ", " + String(Number(entry.ms) || 0) + " ms)";
return done(entries.length === 0 ? "No network requests recorded since the page loaded." : String(bad) + " of the last " + String(entries.length) + " requests failed or returned an error status.\n" + entries.map(line).join("\n"));
"#;

const PICK_START: &str = r##"
if (window.__runrailPicking === true) return done("picking");
const box = document.createElement("div");
box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #f59e0b;background:rgba(245,158,11,0.14);border-radius:3px;display:none;";
document.documentElement.appendChild(box);
const simple = (name) => /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(name);
const selectorOf = (el) => {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && simple(node.id)) { parts.unshift(part + "#" + node.id); break; }
    const classes = Array.from(node.classList).filter(simple).slice(0, 2);
    if (classes.length > 0) part += "." + classes.join(".");
    const parent = node.parentElement;
    if (parent) { const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName); if (same.length > 1) part += ":nth-of-type(" + String(same.indexOf(node) + 1) + ")"; }
    parts.unshift(part);
  }
  return parts.join(" > ").slice(0, 300);
};
const swallow = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
const over = (event) => {
  const el = event.target;
  if (!(el instanceof Element)) return;
  const rect = el.getBoundingClientRect();
  box.style.display = "block"; box.style.left = rect.left + "px"; box.style.top = rect.top + "px"; box.style.width = rect.width + "px"; box.style.height = rect.height + "px";
};
const presses = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "auxclick", "contextmenu"];
const finish = (pick) => {
  removeEventListener("mouseover", over, true); removeEventListener("click", click, true); removeEventListener("keydown", key, true);
  for (const name of presses) removeEventListener(name, swallow, true);
  box.remove();
  window.__runrailPicking = false;
  window.__runrailPicked = pick;
};
const click = (event) => {
  swallow(event);
  const el = event.target instanceof Element ? event.target : null;
  if (el) finish({ role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), selector: selectorOf(el), text: clip(el.innerText || el.textContent, 200), url: location.origin + location.pathname });
};
const key = (event) => { if (event.key === "Escape") { swallow(event); finish({ cancelled: true }); } };
addEventListener("mouseover", over, true); addEventListener("click", click, true); addEventListener("keydown", key, true);
for (const name of presses) addEventListener(name, swallow, true);
window.__runrailPicking = true;
window.__runrailPicked = undefined;
window.__runrailStopPick = () => finish({ cancelled: true });
return done("picking");
"##;

const PICK_READ: &str = r#"
const pick = window.__runrailPicked;
if (pick === undefined || pick === null) return done(JSON.stringify({ state: window.__runrailPicking === true ? "picking" : "idle" }));
window.__runrailPicked = undefined;
return done(JSON.stringify({ state: "picked", pick }).slice(0, 4000));
"#;

const PICK_STOP: &str = r#"
if (window.__runrailPicking === true && typeof window.__runrailStopPick === "function") window.__runrailStopPick();
window.__runrailPicked = undefined;
return done("stopped");
"#;

/// Runs `body` with the helpers and always ends with a string: WebKit hands any other value to a
/// JSON encoder that would stop the app on what it cannot encode.
fn wrap(body: &str) -> String {
    format!(
        "(() => {{ let out; try {{ out = (() => {{ {HELPERS}\n{body} }})(); }} catch (error) {{ out = '{{\"ok\":false,\"message\":\"the page script failed\"}}'; }} try {{ return \"\" + out; }} catch {{ return '{{\"ok\":false,\"message\":\"the page script failed\"}}'; }} }})()"
    )
}

/// The fixed script for one checked action.
pub fn script_source(script: &Script) -> BridgeResult<String> {
    let body = match script {
        Script::Snapshot => SNAPSHOT.to_string(),
        Script::Console => CONSOLE.to_string(),
        Script::Network => NETWORK.to_string(),
        Script::PickStart => PICK_START.to_string(),
        Script::PickRead => PICK_READ.to_string(),
        Script::PickStop => PICK_STOP.to_string(),
        Script::Click { target } => {
            if !valid_ref(target) {
                return Err(invalid("ref is invalid"));
            }
            format!(
                "const el = target({ref_}); if (!el) return fail('that ref is gone; take a new browser_snapshot'); el.scrollIntoView({{ block: 'center', inline: 'center' }}); if (typeof el.focus === 'function') el.focus(); el.click(); return done('Clicked ' + {ref_} + ' (' + describe(el) + ').');",
                ref_ = literal(target)
            )
        }
        Script::Type { target, text, submit } => {
            if !valid_ref(target) {
                return Err(invalid("ref is invalid"));
            }
            if text.chars().count() > MAX_TEXT || text.contains('\0') {
                return Err(invalid("text is too long"));
            }
            format!(
                r#"const el = target({ref_}); if (!el) return fail('that ref is gone; take a new browser_snapshot');
const text = {text};
el.scrollIntoView({{ block: 'center' }});
if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {{
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  el.focus();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
}} else if (el.isContentEditable) {{
  el.focus();
  el.textContent = text;
  el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
}} else return fail('that element does not take text');
if ({submit}) {{ if (el.form) {{ if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit(); }} else el.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true, cancelable: true }})); }}
return done('Typed into ' + {ref_} + ' (' + describe(el) + ')' + ({submit} ? ' and submitted.' : '.'));"#,
                ref_ = literal(target),
                text = literal(text),
                submit = if *submit { "true" } else { "false" }
            )
        }
        Script::Press { key } => {
            if !valid_key(key) {
                return Err(invalid("key is invalid"));
            }
            format!(
                r#"const key = {key} === 'Space' ? ' ' : {key};
const el = document.activeElement || document.body;
const options = {{ key, bubbles: true, cancelable: true }};
const proceed = el.dispatchEvent(new KeyboardEvent('keydown', options));
if (key.length === 1) {{ el.dispatchEvent(new KeyboardEvent('keypress', options)); if (proceed && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) document.execCommand('insertText', false, key); }}
el.dispatchEvent(new KeyboardEvent('keyup', options));
if (proceed && key === 'Enter' && el.tagName === 'INPUT' && el.form) {{ if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit(); }}
return done('Pressed ' + {key} + ' in ' + (el === document.body ? 'the page' : describe(el)) + '.');"#,
                key = literal(key)
            )
        }
    };
    Ok(wrap(&body))
}

/// The person's script, as the agent wrote it, inside the same always-a-string wrapper. A promise
/// is reported, not awaited.
pub fn eval_source(expression: &str) -> BridgeResult<String> {
    if expression.trim().is_empty() || expression.chars().count() > MAX_EXPRESSION || expression.contains('\0') {
        return Err(invalid("expression is invalid"));
    }
    let body = format!(
        r#"let value;
try {{ value = (
{expression}
); }} catch (error) {{ return fail('The expression threw: ' + clip(error && error.message ? error.message : error, 500)); }}
if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') return done('A promise (not awaited).');
if (typeof value === 'function') return done('A function.');
if (value === undefined) return done('undefined');
if (typeof value === 'string') return done(value);
let text;
try {{ text = JSON.stringify(value, null, 2); }} catch {{ text = undefined; }}
return done(text === undefined ? String(value) : text);"#
    );
    Ok(wrap(&body))
}

/// The script's string, parsed: `{ok: true, text}` or `{ok: false, message}`.
pub fn parse_result(raw: &str) -> BridgeResult<Answer> {
    let inner: String = serde_json::from_str(raw).map_err(|_| page_failed("the page did not answer"))?;
    let value: serde_json::Value = serde_json::from_str(&inner).map_err(|_| page_failed("the page answered with something unreadable"))?;
    let text = |field: &str| value.get(field).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let mut text = text("text");
        if text.len() > MAX_RESULT {
            let mut end = MAX_RESULT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        return Ok(Answer { text });
    }
    let message: String = text("message").chars().filter(|char| !char.is_control()).take(MAX_MESSAGE).collect();
    Err(page_failed(if message.is_empty() { "the page script failed" } else { &message }))
}

/// Runs a script in the page and waits for its string. Call from a blocking thread.
pub fn run(webview: &Webview, source: String) -> BridgeResult<Answer> {
    let (sender, receiver) = mpsc::channel::<String>();
    let sender = Mutex::new(sender);
    webview
        .eval_with_callback(source, move |raw| {
            let _ = sender.lock().map(|sender| sender.send(raw));
        })
        .map_err(|_| page_failed("the page could not be reached"))?;
    let raw = receiver.recv_timeout(SCRIPT_TIMEOUT).map_err(|_| BridgeError::new("PREVIEW_TIMEOUT", "the page did not answer in time").with_status(504))?;
    parse_result(&raw)
}

/// The visible part of the page as a JPEG, at most `max_width` pixels wide and 900 KiB as base64.
#[cfg(target_os = "macos")]
pub fn screenshot(webview: &Webview, points_wide: f64) -> BridgeResult<Picture> {
    use base64::Engine;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    const MAX_BASE64: usize = 900 * 1024;
    let failed = || BridgeError::new("PREVIEW_SCREENSHOT_FAILED", "the page could not be captured; show the browser tab and try again");
    let (sender, receiver) = mpsc::channel::<Option<Vec<u8>>>();
    webview
        .with_webview(move |platform| {
            let Some(marker) = MainThreadMarker::new() else {
                let _ = sender.send(None);
                return;
            };
            // Safety: on macOS the platform webview is the WKWebView wry created, alive for this call.
            let view: &WKWebView = unsafe { &*platform.inner().cast::<WKWebView>() };
            let configuration = unsafe { WKSnapshotConfiguration::new(marker) };
            unsafe { configuration.setSnapshotWidth(Some(&NSNumber::new_f64(points_wide))) };
            let sender = Mutex::new(Some(sender));
            let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let tiff = if image.is_null() { None } else { unsafe { &*image }.TIFFRepresentation() };
                let bytes = tiff.and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff)).map(|bitmap| {
                    let mut chosen = Vec::new();
                    for quality in [0.7, 0.55, 0.4, 0.3] {
                        let number: Retained<NSNumber> = NSNumber::new_f64(quality);
                        let object: &AnyObject = &number;
                        let properties = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[object]);
                        let Some(data) = (unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties) }) else { continue };
                        chosen = data.to_vec();
                        if chosen.len() / 3 * 4 + 4 <= MAX_BASE64 {
                            break;
                        }
                    }
                    chosen
                });
                if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                    let _ = sender.send(bytes.filter(|bytes| !bytes.is_empty()));
                }
            });
            unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block) };
        })
        .map_err(|_| failed())?;
    let bytes = receiver.recv_timeout(SCRIPT_TIMEOUT).map_err(|_| failed())?.ok_or_else(failed)?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    if data.len() > MAX_BASE64 {
        return Err(BridgeError::new("PREVIEW_SCREENSHOT_FAILED", "the page is too large to capture"));
    }
    Ok(Picture { media_type: "image/jpeg", data_base64: data })
}

/// The visible part of the page as a JPEG, as on macOS: WebKitGTK's snapshot of the view.
#[cfg(target_os = "linux")]
pub fn screenshot(webview: &Webview, points_wide: f64) -> BridgeResult<Picture> {
    use base64::Engine;

    const MAX_BASE64: usize = 900 * 1024;
    let failed = || BridgeError::new("PREVIEW_SCREENSHOT_FAILED", "the page could not be captured; show the browser tab and try again");
    let image = crate::preview_gtk::snapshot(webview, points_wide).ok_or_else(failed)?;
    let bytes = jpeg(&image, MAX_BASE64).ok_or_else(failed)?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    if data.len() > MAX_BASE64 {
        return Err(BridgeError::new("PREVIEW_SCREENSHOT_FAILED", "the page is too large to capture"));
    }
    Ok(Picture { media_type: "image/jpeg", data_base64: data })
}

/// The image as a JPEG at the best of a few qualities that fits `max_base64` once encoded.
#[cfg(target_os = "linux")]
pub fn jpeg(image: &image::RgbImage, max_base64: usize) -> Option<Vec<u8>> {
    let mut chosen = Vec::new();
    for quality in [70, 55, 40, 30] {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality).encode_image(image).ok()?;
        chosen = bytes;
        if chosen.len() / 3 * 4 + 4 <= max_base64 {
            break;
        }
    }
    (!chosen.is_empty()).then_some(chosen)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn screenshot(_webview: &Webview, _points_wide: f64) -> BridgeResult<Picture> {
    Err(BridgeError::new("PREVIEW_UNSUPPORTED", "screenshots are available on macOS and Linux only").with_status(501))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_take_only_checked_inputs() {
        assert!(script_source(&Script::Click { target: "e12".into() }).is_ok());
        for bad in ["", "e", "12", "e1234567", "e1'); alert(1); ('", "E1"] {
            assert!(script_source(&Script::Click { target: bad.into() }).is_err(), "{bad}");
        }
        assert!(script_source(&Script::Type { target: "e1".into(), text: "x".repeat(MAX_TEXT + 1), submit: false }).is_err());
        assert!(script_source(&Script::Press { key: "Enter".into() }).is_ok());
        assert!(script_source(&Script::Press { key: "a".into() }).is_ok());
        for bad in ["F13", "ab", " ", "\n", "é"] {
            assert!(script_source(&Script::Press { key: bad.into() }).is_err(), "{bad}");
        }
        assert!(eval_source(" ").is_err());
        assert!(eval_source(&"1".repeat(MAX_EXPRESSION + 1)).is_err());
    }

    #[test]
    fn the_network_log_is_read_by_a_fixed_script() {
        assert_eq!(serde_json::from_value::<Script>(serde_json::json!({ "action": "network" })).unwrap(), Script::Network);
        let source = script_source(&Script::Network).unwrap();
        assert!(source.contains("__runrailNetwork"));
        // Queries can carry tokens, so the recorder keeps none.
        assert!(NETWORK_RECORDER.contains(r#"url.search ? "?..." : """#));
    }

    #[test]
    fn picking_an_element_runs_fixed_scripts() {
        for (action, script) in [("pickStart", Script::PickStart), ("pickRead", Script::PickRead), ("pickStop", Script::PickStop)] {
            assert_eq!(serde_json::from_value::<Script>(serde_json::json!({ "action": action })).unwrap(), script);
            assert!(script_source(&script).unwrap().contains("__runrailPick"));
        }
    }

    #[test]
    fn typed_text_stays_a_string_literal() {
        let source = script_source(&Script::Type { target: "e1".into(), text: "\"); alert(1); (\"\u{2028}".into(), submit: true }).unwrap();
        assert!(source.contains(r#"const text = "\"); alert(1); (\" ";"#) || source.contains("const text = \"\\\"); alert(1); (\\\"\u{2028}\";"));
        assert!(!source.contains("text = \"\"); alert(1)"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_large_picture_is_made_to_fit() {
        let fine = |x: u32, y: u32| (x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503)).rotate_left(7);
        let busy = image::RgbImage::from_fn(1600, 1200, |x, y| {
            let value = fine(x, y);
            image::Rgb([value as u8 / 4 + 96, (value >> 8) as u8 / 4 + 96, (value >> 16) as u8 / 4 + 96])
        });
        let mut first = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut first, 70).encode_image(&busy).unwrap();
        assert!(first.len() / 3 * 4 + 4 > 900 * 1024);
        let bytes = jpeg(&busy, 900 * 1024).unwrap();
        assert!(bytes.len() / 3 * 4 + 4 <= 900 * 1024);
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn script_answers_are_parsed_and_bounded() {
        let wrap = |value: serde_json::Value| serde_json::to_string(&value.to_string()).unwrap();
        assert_eq!(parse_result(&wrap(serde_json::json!({ "ok": true, "text": "hi" }))).unwrap().text, "hi");
        let long = parse_result(&wrap(serde_json::json!({ "ok": true, "text": "é".repeat(MAX_RESULT) }))).unwrap();
        assert!(long.text.len() <= MAX_RESULT);
        let failed = parse_result(&wrap(serde_json::json!({ "ok": false, "message": "no\nway" }))).unwrap_err();
        assert_eq!(failed.code, "PREVIEW_SCRIPT_FAILED");
        assert_eq!(failed.message, "noway");
        assert!(parse_result("").is_err());
        assert!(parse_result("\"not json\"").is_err());
        assert!(parse_result("{\"ok\":true}").is_err());
    }
}
