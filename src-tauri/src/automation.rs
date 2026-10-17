//! Debug builds only, and only with `RUNRAIL_AUTOMATION=1`: a socket on 127.0.0.1 that runs a
//! script in the app's own page and answers with its result, so the app can be driven end to end
//! with no one at the keyboard. Release builds do not compile this module (`lib.rs`).
//!
//! The port and a fresh token are written to `automation.json` in the app's data folder, readable
//! by its owner only; every request carries the token. `scripts/automation.ts` is the client.
//!
//! - `POST /eval`: the body is the body of an async function; its return value comes back as JSON.
//! - `POST /dialog`: `accept` or `decline`, queued as the answer to the next GitHub write
//!   confirmation, which is then recorded instead of shown.
//! - `GET /dialogs`: the confirmations answered that way, with the text each one would have shown.
//! - `POST /pick`: an absolute folder path, returned by the next project folder dialog instead of
//!   showing it. It is approved as though the person had chosen it there.
//! - `GET /previews`: where each browser preview sits relative to the main page, and whether it shows.
//! - `POST /window-size`: `WIDTHxHEIGHT` in points, the main window's new inner size.
//! - `POST /preview-key` (macOS): `{"tab", "keys"}`, a key pressed while that preview has the keyboard.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};

const EVENT: &str = "runrail-automation";
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const EVAL_TIMEOUT: Duration = Duration::from_secs(120);

static WAITING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<String>>>> = OnceLock::new();
static ANSWERS: Mutex<VecDeque<bool>> = Mutex::new(VecDeque::new());
static ANSWERED: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static PICKS: Mutex<VecDeque<PathBuf>> = Mutex::new(VecDeque::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn waiting() -> &'static Mutex<HashMap<u64, mpsc::Sender<String>>> {
    WAITING.get_or_init(Mutex::default)
}

pub fn start(app: &AppHandle, app_data: &Path) {
    if std::env::var("RUNRAIL_AUTOMATION").as_deref() != Ok("1") {
        return;
    }
    let Ok(token) = random_token() else {
        eprintln!("automation: no random token; not started");
        return;
    };
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        eprintln!("automation: could not bind a local port");
        return;
    };
    let Ok(address) = listener.local_addr() else {
        return;
    };
    if let Err(error) = write_info(&app_data.join("automation.json"), address.port(), &token) {
        eprintln!("automation: could not write automation.json: {error}");
        return;
    }
    app.listen_any(EVENT, |event| {
        let Ok(text) = serde_json::from_str::<String>(event.payload()) else {
            return;
        };
        let Some(id) = serde_json::from_str::<Value>(&text).ok().and_then(|value| value["id"].as_u64()) else {
            return;
        };
        if let Some(sender) = waiting().lock().ok().and_then(|mut waiting| waiting.remove(&id)) {
            let _ = sender.send(text);
        }
    });
    let handle = app.clone();
    let _ = std::thread::Builder::new().name("runrail-automation".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let handle = handle.clone();
            let token = token.clone();
            let _ = std::thread::spawn(move || serve(stream, &handle, &token));
        }
    });
    eprintln!("automation: listening on {address}");
}

/// The answer the automation queued for a GitHub write confirmation, recorded with its text.
pub fn dialog_answer(title: &str, message: &str) -> Option<bool> {
    let answer = ANSWERS.lock().ok()?.pop_front()?;
    if let Ok(mut answered) = ANSWERED.lock() {
        answered.push(json!({ "title": title, "message": message, "accepted": answer }));
    }
    Some(answer)
}

/// The folder the automation queued for the next project folder dialog.
pub fn picked_folder() -> Option<PathBuf> {
    PICKS.lock().ok()?.pop_front()
}

fn serve(mut stream: TcpStream, app: &AppHandle, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let (status, body) = match read_request(&mut stream) {
        Ok(request) if !authorized(&request.authorization, token) => (401, json!({ "ok": false, "error": "unauthorized" }).to_string()),
        Ok(request) => route(app, &request),
        Err(error) => (400, json!({ "ok": false, "error": error }).to_string()),
    };
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        504 => "Gateway Timeout",
        _ => "Bad Request",
    };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn route(app: &AppHandle, request: &Request) -> (u16, String) {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/eval") => eval(app, &request.body),
        ("POST", "/dialog") => match request.body.trim() {
            "accept" | "decline" => {
                if let Ok(mut answers) = ANSWERS.lock() {
                    answers.push_back(request.body.trim() == "accept");
                }
                (200, json!({ "ok": true }).to_string())
            }
            _ => (400, json!({ "ok": false, "error": "say accept or decline" }).to_string()),
        },
        ("POST", "/pick") => match PathBuf::from(request.body.trim()) {
            path if path.is_absolute() => {
                if let Ok(mut picks) = PICKS.lock() {
                    picks.push_back(path);
                }
                (200, json!({ "ok": true }).to_string())
            }
            _ => (400, json!({ "ok": false, "error": "give an absolute folder path" }).to_string()),
        },
        // macOS keeps menu bar items from scripts without Accessibility access.
        ("POST", "/menu-bar") => match request.body.trim() {
            action @ ("open" | "quit") => {
                crate::background::menu_action(app, action);
                (200, json!({ "ok": true }).to_string())
            }
            _ => (400, json!({ "ok": false, "error": "say open or quit" }).to_string()),
        },
        ("POST", "/window-size") => {
            let size = request.body.trim().split_once('x').and_then(|(width, height)| Some((width.parse::<f64>().ok()?, height.parse::<f64>().ok()?))).filter(|(width, height)| (1.0..=10_000.0).contains(width) && (1.0..=10_000.0).contains(height));
            match (size, app.get_window("main")) {
                (Some((width, height)), Some(window)) if window.set_size(tauri::LogicalSize::new(width, height)).is_ok() => (200, json!({ "ok": true }).to_string()),
                _ => (400, json!({ "ok": false, "error": "say WIDTHxHEIGHT" }).to_string()),
            }
        }
        ("GET", "/previews") => (200, json!({ "ok": true, "value": app.state::<crate::preview::Previews>().frames(app) }).to_string()),
        #[cfg(target_os = "macos")]
        ("POST", "/preview-key") => preview_key(app, &request.body),
        ("GET", "/dialogs") => (200, json!({ "ok": true, "value": ANSWERED.lock().map(|answered| answered.clone()).unwrap_or_default() }).to_string()),
        _ => (404, json!({ "ok": false, "error": "no such route" }).to_string()),
    }
}

/// Gives a browser preview the keyboard and presses `keys` (as `src/ui/shell/shortcuts.ts` writes
/// them): the key goes on the app's event queue, so AppKit routes it as it does the keyboard's.
#[cfg(target_os = "macos")]
fn preview_key(app: &AppHandle, body: &str) -> (u16, String) {
    let bad = |error: &str| (400, json!({ "ok": false, "error": error }).to_string());
    let Ok(request) = serde_json::from_str::<Value>(body) else {
        return bad("send {\"tab\": ..., \"keys\": ...}");
    };
    let (Some(tab), Some(keys)) = (request["tab"].as_str(), request["keys"].as_str()) else {
        return bad("send {\"tab\": ..., \"keys\": ...}");
    };
    let Some(key) = mac_key(keys) else {
        return bad("keys are mod, shift, alt or ctrl and one letter or digit");
    };
    let Ok(webview) = app.state::<crate::preview::Previews>().loaded(app, tab, false) else {
        return bad("no such preview");
    };
    let Some(window) = app.get_window("main") else {
        return bad("the main window is not open");
    };
    // Key equivalents reach only the key window of the active app, and its first responder. macOS
    // may hold activation back while someone works in another app, so this asks a few times.
    let mut seen = Value::Null;
    for _ in 0..6 {
        if window.set_focus().is_err() || webview.set_focus().is_err() {
            return bad("the preview could not take the keyboard");
        }
        std::thread::sleep(Duration::from_millis(500));
        let (sender, receiver) = mpsc::channel();
        let key = key.clone();
        let sent = webview.with_webview(move |platform| {
            let _ = sender.send(press(platform.inner(), platform.ns_window(), key));
        });
        match sent.ok().and_then(|()| receiver.recv_timeout(Duration::from_secs(5)).ok()) {
            Some(value) if value["sent"] == true => return (200, json!({ "ok": true, "value": value }).to_string()),
            Some(value) => seen = value,
            None => return bad("the key was not sent"),
        }
    }
    (200, json!({ "ok": true, "value": seen }).to_string())
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct MacKey {
    flags: objc2_app_kit::NSEventModifierFlags,
    characters: String,
    code: u16,
}

/// "mod+shift+f" as macOS has it: Command and Shift, "F", on the ANSI F key.
#[cfg(target_os = "macos")]
fn mac_key(keys: &str) -> Option<MacKey> {
    use objc2_app_kit::NSEventModifierFlags;
    // ANSI virtual key codes in order; a space marks a code that is not a letter or digit.
    const CODES: &str = "asdfhgzxcv bqweryt123465 97 80 ou ip lj k    nm";
    let mut flags = NSEventModifierFlags::empty();
    let mut parts = keys.split('+').peekable();
    let mut last = None;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            last = Some(part);
            break;
        }
        flags |= match part {
            "mod" => NSEventModifierFlags::Command,
            "shift" => NSEventModifierFlags::Shift,
            "alt" => NSEventModifierFlags::Option,
            "ctrl" => NSEventModifierFlags::Control,
            _ => return None,
        };
    }
    let character = last.filter(|last| last.len() == 1 && last != &" ")?.chars().next()?;
    let code = u16::try_from(CODES.find(character)?).ok()?;
    let characters = if flags.contains(NSEventModifierFlags::Shift) { character.to_ascii_uppercase() } else { character }.to_string();
    Some(MacKey { flags, characters, code })
}

/// Runs on the main thread: a key down and up for the preview's window, once it has the keyboard,
/// and the app menu's titles.
#[cfg(target_os = "macos")]
fn press(preview: *mut std::ffi::c_void, ns_window: *mut std::ffi::c_void, key: MacKey) -> Value {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventType, NSWindow};
    use objc2_foundation::{NSPoint, NSProcessInfo, NSString};
    let Some(main) = MainThreadMarker::new() else {
        return json!({ "sent": false });
    };
    // SAFETY: Tauri hands over the preview's live NSWindow for the length of this callback.
    let window: Retained<NSWindow> = match unsafe { Retained::retain(ns_window.cast::<NSWindow>()) } {
        Some(window) => window,
        None => return json!({ "sent": false }),
    };
    let app = NSApplication::sharedApplication(main);
    let focused = window.firstResponder().is_some_and(|responder| Retained::as_ptr(&responder).cast::<std::ffi::c_void>() == preview.cast_const());
    let (active, key_window) = (app.isActive(), window.isKeyWindow());
    let menus: Vec<String> = app.mainMenu().map(|menu| menu.itemArray().iter().map(|item| item.title().to_string()).collect()).unwrap_or_default();
    if !(active && key_window && focused) {
        return json!({ "sent": false, "active": active, "keyWindow": key_window, "previewFocused": focused, "menus": menus });
    }
    let characters = NSString::from_str(&key.characters);
    let time = NSProcessInfo::processInfo().systemUptime();
    let mut sent = 0;
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        // With the window's number, as the keyboard's keys come: without one, AppKit skips the menu
        // and hands a Command key straight to the first responder.
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(kind, NSPoint::ZERO, key.flags, time, window.windowNumber(), None, &characters, &characters, false, key.code);
        if let Some(event) = event {
            app.postEvent_atStart(&event, false);
            sent += 1;
        }
    }
    json!({ "sent": sent == 2, "active": active, "keyWindow": key_window, "previewFocused": focused, "menus": menus })
}

fn eval(app: &AppHandle, source: &str) -> (u16, String) {
    // Not get_webview_window: Tauri stops calling the window one while browser previews share it.
    let Some(window) = app.get_webview("main") else {
        return (400, json!({ "ok": false, "error": "the main window is not open" }).to_string());
    };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut waiting) = waiting().lock() {
        waiting.insert(id, sender);
    }
    // The result travels back as an event the page emits, the one way out its security policy leaves.
    let script = format!(
        r#"(async () => {{
  const send = (result) => {{
    let text
    try {{ text = JSON.stringify({{ id: {id}, ...result }}) }} catch (error) {{ text = JSON.stringify({{ id: {id}, ok: false, error: "the result is not JSON: " + error }}) }}
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {{ event: "{EVENT}", payload: text }})
  }}
  try {{
    const value = await (async () => {{
{source}
    }})()
    send({{ ok: true, value: value === undefined ? null : value }})
  }} catch (error) {{
    send({{ ok: false, error: String(error) + (error && error.stack ? "\n" + error.stack : "") }})
  }}
}})()"#
    );
    if window.eval(&script).is_err() {
        if let Ok(mut waiting) = waiting().lock() {
            waiting.remove(&id);
        }
        return (400, json!({ "ok": false, "error": "the page did not take the script" }).to_string());
    }
    match receiver.recv_timeout(EVAL_TIMEOUT) {
        Ok(text) => (200, text),
        Err(_) => {
            if let Ok(mut waiting) = waiting().lock() {
                waiting.remove(&id);
            }
            (504, json!({ "ok": false, "error": "the script did not answer in time" }).to_string())
        }
    }
}

struct Request {
    method: String,
    path: String,
    authorization: String,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut data = Vec::new();
    let mut buffer = [0_u8; 8192];
    let head_end = loop {
        if let Some(at) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        if data.len() > MAX_HEAD_BYTES {
            return Err("request head is too large".into());
        }
        let count = stream.read(&mut buffer).map_err(|_| "request was not read")?;
        if count == 0 {
            return Err("request ended early".into());
        }
        data.extend_from_slice(&buffer[..count]);
    };
    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let mut length = 0_usize;
    let mut authorization = String::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().map_err(|_| "content-length is invalid")?,
            "authorization" => authorization = value.trim().to_string(),
            _ => {}
        }
    }
    if length > MAX_BODY_BYTES {
        return Err("request body is too large".into());
    }
    let mut body = data[head_end + 4..].to_vec();
    while body.len() < length {
        let count = stream.read(&mut buffer).map_err(|_| "request body was not read")?;
        if count == 0 {
            return Err("request body ended early".into());
        }
        body.extend_from_slice(&buffer[..count]);
    }
    body.truncate(length);
    Ok(Request { method, path, authorization, body: String::from_utf8(body).map_err(|_| "request body is not UTF-8")? })
}

fn authorized(header: &str, token: &str) -> bool {
    let Some(given) = header.strip_prefix("Bearer ") else {
        return false;
    };
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0_u8, |difference, (left, right)| difference | (left ^ right)) == 0
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0_u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).map_err(|_| std::io::Error::other("no random bytes"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn write_info(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(json!({ "port": port, "token": token }).to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_token_is_let_in() {
        let token = random_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(authorized(&format!("Bearer {token}"), &token));
        assert!(!authorized(&token, &token), "the scheme is required");
        assert!(!authorized(&format!("Bearer {}", &token[..63]), &token));
        assert!(!authorized(&format!("Bearer {}x", &token[..63]), &token));
        assert!(!authorized("Bearer ", &token));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shortcut_keys_become_mac_key_codes() {
        use objc2_app_kit::NSEventModifierFlags;
        let key = mac_key("mod+k").unwrap();
        assert_eq!((key.code, key.characters.as_str(), key.flags), (40, "k", NSEventModifierFlags::Command));
        let key = mac_key("mod+shift+f").unwrap();
        assert_eq!((key.code, key.characters.as_str(), key.flags), (3, "F", NSEventModifierFlags::Command | NSEventModifierFlags::Shift));
        assert_eq!([mac_key("mod+a"), mac_key("mod+1"), mac_key("mod+8"), mac_key("mod+n"), mac_key("mod+m")].map(|key| key.unwrap().code), [0, 18, 28, 45, 46]);
        assert!(mac_key("mod+,").is_none() && mac_key("hyper+k").is_none() && mac_key("mod+").is_none());
    }

    #[test]
    fn a_queued_answer_is_used_once_and_recorded() {
        assert_eq!(dialog_answer("t", "m"), None);
        ANSWERS.lock().unwrap().push_back(false);
        assert_eq!(dialog_answer("Merge?", "Merge example-org/app #12?"), Some(false));
        assert_eq!(dialog_answer("t", "m"), None);
        let answered = ANSWERED.lock().unwrap();
        assert_eq!(answered.last().unwrap()["message"], "Merge example-org/app #12?");
    }
}
