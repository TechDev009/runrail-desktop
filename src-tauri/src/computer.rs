//! Computer use: an agent sees and uses apps on the person's computer, only those
//! the person allowed. The renderer forwards each engine request here; this side keeps the allow list
//! (an app is added only through a dialog the page cannot draw or click), brings the app to the
//! front, checks a click lands in that app's own window, posts the input, and captures the window
//! again. Screen Recording and Accessibility are the person's to grant in System Settings. Linux
//! does the same in `computer/linux.rs`.
// The checks and geometry here serve the macOS and Linux backends; elsewhere nothing uses them.
#![cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{BridgeError, BridgeResult};
use crate::store;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
use linux::{NEVER as NEVER_HERE, SECRET_HOLDERS as SECRET_HOLDERS_HERE};
#[cfg(not(target_os = "linux"))]
const SECRET_HOLDERS_HERE: &[&str] = &[];
#[cfg(not(target_os = "linux"))]
const NEVER_HERE: &[&str] = &[];

const FILE: &str = "computer-apps.json";
const MAX_APPS: usize = 64;
const MAX_TEXT: usize = 2_000;
const MAX_COORDINATE: u32 = 20_000;
/// The longest side of a screenshot, in pixels; a smaller window is captured at one pixel per point.
const MAX_SIDE: f64 = 1_280.0;
const MAX_IMAGE_BASE64: usize = 900 * 1024;

/// Apps that hold passwords or change security settings: no agent uses them, and quick chat never
/// pictures their windows.
const SECRET_HOLDERS: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.SecurityAgent",
    "com.apple.loginwindow",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
];

/// Apps no agent may use: those above, and terminals and script runners, which would run commands
/// without Runrail's approvals.
const NEVER: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty",
    "org.alacritty",
    "net.kovidgoyal.kitty",
    "com.github.wez.wezterm",
    "com.apple.ScriptEditor2",
    "com.apple.Automator",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedApp {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub bundle_id: String,
    pub name: String,
    /// Refused for every agent, whatever the person picks.
    pub never: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub supported: bool,
    pub screen: bool,
    pub accessibility: bool,
    /// Linux: the desktop session, "x11" or "wayland".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<&'static str>,
    /// Linux on Wayland: the desktop's portal is "missing", "ready" for the person to share a
    /// window, or has one "shared".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal: Option<&'static str>,
    /// Why agents cannot use apps here, when they cannot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

static ALLOWED: OnceLock<Allowed> = OnceLock::new();

struct Allowed {
    file: PathBuf,
    apps: Mutex<Vec<AllowedApp>>,
}

/// Opens the allow list for this app's data folder. Called once, before the page loads.
pub fn init(app_data: &Path) {
    let file = app_data.join(FILE);
    let apps = std::fs::read(&file).ok().and_then(|bytes| parse(&bytes)).unwrap_or_default();
    let _ = ALLOWED.set(Allowed { file, apps: Mutex::new(apps) });
}

fn parse(bytes: &[u8]) -> Option<Vec<AllowedApp>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let apps: Vec<AllowedApp> = serde_json::from_value(value["apps"].clone()).ok()?;
    Some(apps.into_iter().filter(|app| valid_bundle_id(&app.bundle_id) && !never(&app.bundle_id)).take(MAX_APPS).collect())
}

fn unavailable() -> BridgeError {
    BridgeError::new("COMPUTER_UNAVAILABLE", "the allowed apps could not be read")
}

pub fn allowed() -> Vec<AllowedApp> {
    ALLOWED.get().and_then(|allowed| allowed.apps.lock().ok().map(|apps| apps.clone())).unwrap_or_default()
}

fn save(change: impl FnOnce(&mut Vec<AllowedApp>)) -> BridgeResult<Vec<AllowedApp>> {
    let allowed = ALLOWED.get().ok_or_else(unavailable)?;
    let mut apps = allowed.apps.lock().map_err(|_| unavailable())?;
    change(&mut apps);
    store::write_atomic(&allowed.file, json!({ "version": 1, "apps": *apps }).to_string().as_bytes())?;
    Ok(apps.clone())
}

pub fn valid_bundle_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && value.chars().all(|char| char.is_ascii_alphanumeric() || char == '.' || char == '-' || char == '_')
}

pub fn never(bundle_id: &str) -> bool {
    holds_secrets(bundle_id) || NEVER.iter().chain(NEVER_HERE).any(|refused| refused.eq_ignore_ascii_case(bundle_id))
}

/// A window quick chat never pictures, even when the person ticks the box.
pub fn holds_secrets(bundle_id: &str) -> bool {
    SECRET_HOLDERS.iter().chain(SECRET_HOLDERS_HERE).any(|refused| refused.eq_ignore_ascii_case(bundle_id))
}

/// Adds a running app, once the person agrees in the system's own dialog.
pub fn allow(app: &tauri::AppHandle, bundle_id: &str) -> BridgeResult<Vec<AllowedApp>> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !valid_bundle_id(bundle_id) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the app is invalid"));
    }
    if never(bundle_id) || bundle_id.eq_ignore_ascii_case(&app.config().identifier) {
        return Err(BridgeError::new("COMPUTER_APP_REFUSED", "agents may not use this app").with_status(403));
    }
    if allowed().iter().any(|entry| entry.bundle_id == bundle_id) {
        return Ok(allowed());
    }
    let running = running_apps(&app.config().identifier).into_iter().find(|running| running.bundle_id == bundle_id).ok_or_else(|| BridgeError::new("COMPUTER_NOT_FOUND", "open the app first, then add it").with_status(404))?;
    // On Linux an app has other names than the one kept here, and any of them can refuse it.
    if running.never {
        return Err(BridgeError::new("COMPUTER_APP_REFUSED", "agents may not use this app").with_status(403));
    }
    let name = running.name;
    let (title, message) = (
        format!("Let agents use {name}?"),
        format!("Threads you turn computer use on in can see {name}'s windows and click, type, and press keys in it.\n\nWhatever {name} can do, they can do too, such as sending, deleting, or buying. You can remove it in Settings at any time."),
    );
    #[cfg(debug_assertions)]
    let queued = crate::automation::dialog_answer(&title, &message);
    #[cfg(not(debug_assertions))]
    let queued = None;
    let agreed = queued.unwrap_or_else(|| app.dialog().message(message).title(title).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into())).blocking_show());
    if !agreed {
        return Err(BridgeError::new("COMPUTER_DECLINED", "The person did not allow the app.").with_status(403));
    }
    save(|apps| {
        if apps.len() < MAX_APPS {
            apps.push(AllowedApp { bundle_id: bundle_id.to_string(), name });
        }
    })
}

pub fn disallow(bundle_id: &str) -> BridgeResult<Vec<AllowedApp>> {
    #[cfg(target_os = "linux")]
    if bundle_id == linux::SHARED_WINDOW {
        linux::stop_sharing();
        return Ok(allowed());
    }
    save(|apps| apps.retain(|app| app.bundle_id != bundle_id))
}

// ---------------------------------------------------------------------------------------------
// One request from an agent

#[derive(Clone, Debug, PartialEq)]
enum Action {
    Apps,
    Screenshot,
    Click { x: u32, y: u32, right: bool, clicks: i64 },
    Type { text: String },
    Key { key: String, modifiers: Vec<String> },
    Scroll { x: u32, y: u32, dx: i32, dy: i32 },
}

struct Refusal {
    code: &'static str,
    message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

fn coordinate(params: &Value, name: &str) -> Result<u32, Refusal> {
    params[name].as_u64().filter(|value| *value <= u64::from(MAX_COORDINATE)).map(|value| value as u32).ok_or_else(|| refuse("COMPUTER_FAILED", format!("{name} is invalid")))
}

/// The engine checked these already; a page that calls on its own gets the same checks.
fn parse_action(action: &str, params: &Value) -> Result<Action, Refusal> {
    let invalid = |what: &str| refuse("COMPUTER_FAILED", format!("{what} is invalid"));
    match action {
        "apps" => Ok(Action::Apps),
        "screenshot" => Ok(Action::Screenshot),
        "click" => {
            let right = match params["button"].as_str().unwrap_or("left") {
                "left" => false,
                "right" => true,
                _ => return Err(invalid("button")),
            };
            let clicks = params["clicks"].as_i64().unwrap_or(1);
            if clicks != 1 && clicks != 2 {
                return Err(invalid("clicks"));
            }
            Ok(Action::Click { x: coordinate(params, "x")?, y: coordinate(params, "y")?, right, clicks })
        }
        "type" => {
            let text = params["text"].as_str().filter(|text| !text.is_empty() && text.chars().count() <= MAX_TEXT).ok_or_else(|| invalid("text"))?;
            Ok(Action::Type { text: text.to_string() })
        }
        "key" => {
            let key = params["key"].as_str().filter(|key| key_code(key).is_some()).ok_or_else(|| invalid("key"))?;
            let modifiers: Vec<String> = match &params["modifiers"] {
                Value::Null => Vec::new(),
                Value::Array(items) => items.iter().map(|item| item.as_str().filter(|name| modifier_flag(name).is_some()).map(str::to_string)).collect::<Option<Vec<_>>>().ok_or_else(|| invalid("modifiers"))?,
                _ => return Err(invalid("modifiers")),
            };
            Ok(Action::Key { key: key.to_string(), modifiers })
        }
        "scroll" => {
            let amount = params["amount"].as_i64().unwrap_or(3);
            if !(1..=20).contains(&amount) {
                return Err(invalid("amount"));
            }
            let amount = amount as i32;
            let (dx, dy) = match params["direction"].as_str() {
                Some("up") => (0, amount),
                Some("down") => (0, -amount),
                Some("left") => (amount, 0),
                Some("right") => (-amount, 0),
                _ => return Err(invalid("direction")),
            };
            Ok(Action::Scroll { x: coordinate(params, "x")?, y: coordinate(params, "y")?, dx, dy })
        }
        _ => Err(refuse("COMPUTER_FAILED", "the action is unknown")),
    }
}

/// An allowed app by its bundle id, or by its name in any case.
fn find_allowed<'a>(apps: &'a [AllowedApp], named: &str) -> Option<&'a AllowedApp> {
    let named = named.trim();
    apps.iter().find(|app| app.bundle_id.eq_ignore_ascii_case(named)).or_else(|| apps.iter().find(|app| app.name.eq_ignore_ascii_case(named)))
}

/// A US-layout virtual key, and whether it needs Shift.
pub fn key_code(key: &str) -> Option<(u16, bool)> {
    let named = match key {
        "Return" => Some(36),
        "Tab" => Some(48),
        "Space" => Some(49),
        "Backspace" => Some(51),
        "Escape" => Some(53),
        "Delete" => Some(117),
        "Home" => Some(115),
        "PageUp" => Some(116),
        "End" => Some(119),
        "PageDown" => Some(121),
        "ArrowLeft" => Some(123),
        "ArrowRight" => Some(124),
        "ArrowDown" => Some(125),
        "ArrowUp" => Some(126),
        "F1" => Some(122),
        "F2" => Some(120),
        "F3" => Some(99),
        "F4" => Some(118),
        "F5" => Some(96),
        "F6" => Some(97),
        "F7" => Some(98),
        "F8" => Some(100),
        "F9" => Some(101),
        "F10" => Some(109),
        "F11" => Some(103),
        "F12" => Some(111),
        _ => None,
    };
    if let Some(code) = named {
        return Some((code, false));
    }
    let mut chars = key.chars();
    let char = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    const SHIFTED: &[(char, char)] = &[('!', '1'), ('@', '2'), ('#', '3'), ('$', '4'), ('%', '5'), ('^', '6'), ('&', '7'), ('*', '8'), ('(', '9'), (')', '0'), ('_', '-'), ('+', '='), ('{', '['), ('}', ']'), ('|', '\\'), (':', ';'), ('"', '\''), ('<', ','), ('>', '.'), ('?', '/'), ('~', '`')];
    let (base, shift) = if char.is_ascii_uppercase() {
        (char.to_ascii_lowercase(), true)
    } else if let Some((_, base)) = SHIFTED.iter().find(|(shifted, _)| *shifted == char) {
        (*base, true)
    } else {
        (char, false)
    };
    const CODES: &[(char, u16)] = &[
        ('a', 0), ('s', 1), ('d', 2), ('f', 3), ('h', 4), ('g', 5), ('z', 6), ('x', 7), ('c', 8), ('v', 9), ('b', 11), ('q', 12), ('w', 13), ('e', 14), ('r', 15), ('y', 16), ('t', 17),
        ('1', 18), ('2', 19), ('3', 20), ('4', 21), ('6', 22), ('5', 23), ('=', 24), ('9', 25), ('7', 26), ('-', 27), ('8', 28), ('0', 29), (']', 30), ('o', 31), ('u', 32), ('[', 33),
        ('i', 34), ('p', 35), ('l', 37), ('j', 38), ('\'', 39), ('k', 40), (';', 41), ('\\', 42), (',', 43), ('/', 44), ('n', 45), ('m', 46), ('.', 47), ('`', 50),
    ];
    CODES.iter().find(|(name, _)| *name == base).map(|(_, code)| (*code, shift))
}

pub fn modifier_flag(name: &str) -> Option<u64> {
    match name {
        "shift" => Some(0x20000),
        "control" => Some(0x40000),
        "option" => Some(0x80000),
        "command" => Some(0x100000),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub id: u32,
    pub pid: i32,
    pub layer: i64,
    pub alpha: f64,
    pub bounds: Rect,
    pub title: Option<String>,
}

/// Pixels in a screenshot per point of the window.
fn scale(bounds: &Rect) -> f64 {
    (MAX_SIDE / bounds.width.max(bounds.height)).min(1.0)
}

/// A point in the screenshot as a point on screen, if it falls in the window.
fn to_screen(bounds: &Rect, x: u32, y: u32) -> Option<(f64, f64)> {
    let scale = scale(bounds);
    let point = (bounds.x + f64::from(x) / scale, bounds.y + f64::from(y) / scale);
    bounds.contains(point.0, point.1).then_some(point)
}

/// The app's front window: windows come front to back, and normal ones sit on layer 0.
fn front_window(windows: &[Window], pid: i32) -> Option<&Window> {
    windows.iter().find(|window| window.pid == pid && window.layer == 0 && window.alpha > 0.0 && window.bounds.width >= 1.0 && window.bounds.height >= 1.0)
}

/// Whether the first visible window under the point is the app's, so a click cannot land on a
/// panel, the Dock, or another app's window floating over it.
fn reaches(windows: &[Window], pid: i32, point: (f64, f64)) -> bool {
    windows.iter().find(|window| window.layer >= 0 && window.alpha > 0.0 && window.bounds.contains(point.0, point.1)).is_some_and(|window| window.pid == pid)
}

/// Typed text in pieces: runs of characters, and the keys for a new line and a tab.
fn type_pieces(text: &str) -> Vec<Result<String, u16>> {
    let mut pieces: Vec<Result<String, u16>> = Vec::new();
    let mut run = String::new();
    for char in text.chars() {
        let key = match char {
            '\n' => Some(36),
            '\t' => Some(48),
            '\r' => continue,
            _ => None,
        };
        if let Some(key) = key {
            if !run.is_empty() {
                pieces.push(Ok(std::mem::take(&mut run)));
            }
            pieces.push(Err(key));
        } else {
            // One event carries a few characters; longer runs go as several.
            if run.encode_utf16().count() >= 16 {
                pieces.push(Ok(std::mem::take(&mut run)));
            }
            run.push(char);
        }
    }
    if !run.is_empty() {
        pieces.push(Ok(run));
    }
    pieces
}

fn describe(app: &AllowedApp, window: &Window, size: (u32, u32)) -> String {
    let title = window.title.as_deref().filter(|title| !title.trim().is_empty()).map(|title| format!(", window \"{}\"", title.chars().filter(|char| !char.is_control()).take(200).collect::<String>())).unwrap_or_default();
    format!("{} ({}){}: {} by {} pixels. x and y for the other computer tools are pixels in this image.", app.name, app.bundle_id, title, size.0, size.1)
}

fn answer(result: Result<(String, Option<(String, u32, u32)>), Refusal>) -> Value {
    match result {
        Ok((text, None)) => json!({ "ok": true, "result": { "text": text } }),
        Ok((text, Some((data, _, _)))) => json!({ "ok": true, "result": { "text": text, "image": { "mediaType": "image/jpeg", "dataBase64": data } } }),
        Err(refusal) => json!({ "ok": false, "code": refusal.code, "message": refusal.message }),
    }
}

/// Carries out one request and returns the answer for `computer.respond`.
pub fn act(own_bundle_id: &str, action: &str, params: &Value) -> Value {
    answer(run(own_bundle_id, action, params))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn run(_own: &str, _action: &str, _params: &Value) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    Err(refuse("COMPUTER_OFF", "computer use works on macOS and Linux only"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn access() -> Access {
    Access { reason: Some("Agents can use apps on macOS and Linux only.".into()), ..Access::default() }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn request_access(_kind: &str) -> Access {
    access()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn running_apps(_own: &str) -> Vec<RunningApp> {
    Vec::new()
}

#[cfg(target_os = "macos")]
pub use mac::{access, request_access, running_apps};

#[cfg(target_os = "linux")]
pub use linux::{access, request_access, running_apps};

#[cfg(target_os = "linux")]
fn run(own: &str, action: &str, params: &Value) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    linux::run(own, action, params)
}

/// The window in front when quick chat opened: another app's, never Runrail's.
#[derive(Clone, Debug, PartialEq)]
pub struct FrontWindow {
    pub window: Window,
    pub app: String,
    pub bundle_id: String,
}

#[cfg(target_os = "macos")]
pub fn front_window_now(own_pid: i32) -> Option<FrontWindow> {
    mac::front_window_now(own_pid)
}

#[cfg(target_os = "linux")]
pub fn front_window_now(own_pid: i32) -> Option<FrontWindow> {
    linux::front_window_now(own_pid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn front_window_now(_own_pid: i32) -> Option<FrontWindow> {
    None
}

/// A JPEG of one window, base64, with its size: taken only when the person asks for it.
#[cfg(target_os = "macos")]
pub fn picture(window: &Window) -> Result<(String, u32, u32), String> {
    capture(window)
}

#[cfg(target_os = "linux")]
pub fn picture(window: &Window) -> Result<(String, u32, u32), String> {
    linux::picture(window)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn picture(_window: &Window) -> Result<(String, u32, u32), String> {
    Err("window pictures work on macOS and Linux only".into())
}

#[cfg(target_os = "macos")]
fn run(own: &str, action: &str, params: &Value) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    use std::time::Duration;
    let action = parse_action(action, params)?;
    let apps = allowed();
    let simulators = crate::simulator::agents_on();
    if action == Action::Apps {
        if apps.is_empty() && !simulators && !crate::android::agents_on() {
            return Ok(("The person has not allowed any apps yet. They add them in Runrail's settings, under Computer use.".into(), None));
        }
        let mut text = String::new();
        if !apps.is_empty() {
            let running = mac::running_apps(own);
            let lines: Vec<String> = apps.iter().map(|app| format!("- {} ({}){}", app.name, app.bundle_id, if running.iter().any(|entry| entry.bundle_id == app.bundle_id) { "" } else { ", not running" })).collect();
            text = format!("Apps you may use, as the person allowed them:\n{}", lines.join("\n"));
        }
        if simulators {
            let booted: Vec<String> = crate::simulator::devices().unwrap_or_default().into_iter().filter(|device| device.booted).map(|device| format!("- {}, {} simulator ({})", device.name, device.runtime, device.udid)).collect();
            let part = if booted.is_empty() { "The person lets you use iOS simulators, and none is running; `xcrun simctl boot` starts one.".to_string() } else { format!("iOS simulators you may use; name one as the app:\n{}", booted.join("\n")) };
            text = if text.is_empty() { part } else { format!("{text}\n\n{part}") };
        }
        return Ok((with_emulators(text), None));
    }
    let named = params["app"].as_str().unwrap_or_default();
    if simulators && find_allowed(&apps, named).is_none() {
        if let Some(device) = crate::simulator::find_booted(named) {
            return simulator_run(&device, &action);
        }
    }
    if let Some(device) = emulator_named(&apps, named) {
        return emulator_run(&device, &action);
    }
    let app = find_allowed(&apps, named).ok_or_else(|| refuse("COMPUTER_DENIED", format!("{} is not an app the person allowed. computer_apps lists the ones you may use.", named.chars().filter(|char| !char.is_control()).take(80).collect::<String>())))?;
    if never(&app.bundle_id) || app.bundle_id.eq_ignore_ascii_case(own) {
        return Err(refuse("COMPUTER_DENIED", "agents may not use this app"));
    }
    let access = mac::access();
    if !access.screen {
        return Err(refuse("COMPUTER_PERMISSION", "Runrail needs Screen Recording access to see apps. The person grants it in System Settings, Privacy & Security, then reopens Runrail."));
    }
    let acting = action != Action::Screenshot;
    if acting && !access.accessibility {
        return Err(refuse("COMPUTER_PERMISSION", "Runrail needs Accessibility access to click and type. The person grants it in System Settings, Privacy & Security."));
    }
    let pid = mac::pid_of(&app.bundle_id).ok_or_else(|| refuse("COMPUTER_NOT_FOUND", format!("{} is not running. The person can open it.", app.name)))?;
    if acting && !mac::bring_to_front(pid, &app.bundle_id) {
        return Err(refuse("COMPUTER_FAILED", format!("{} did not come to the front. Nothing was clicked or typed.", app.name)));
    }
    let windows = mac::windows();
    let window = front_window(&windows, pid).cloned().ok_or_else(|| refuse("COMPUTER_NOT_FOUND", format!("{} has no window on screen.", app.name)))?;
    let done = match &action {
        Action::Apps | Action::Screenshot => None,
        Action::Click { x, y, right, clicks } => {
            let point = to_screen(&window.bounds, *x, *y).ok_or_else(|| refuse("COMPUTER_DENIED", "that point is outside the app's window; take a new screenshot"))?;
            if !reaches(&windows, pid, point) {
                return Err(refuse("COMPUTER_DENIED", "another window covers that point, so nothing was clicked"));
            }
            mac::click(point, *right, *clicks);
            Some(format!("Clicked at {x}, {y} in {}.", app.name))
        }
        Action::Type { text } => {
            mac::type_text(&type_pieces(text));
            Some(format!("Typed {} characters in {}.", text.chars().count(), app.name))
        }
        Action::Key { key, modifiers } => {
            let (code, shift) = key_code(key).ok_or_else(|| refuse("COMPUTER_FAILED", "key is invalid"))?;
            let flags = modifiers.iter().filter_map(|name| modifier_flag(name)).fold(if shift { 0x20000 } else { 0 }, |all, flag| all | flag);
            mac::key(code, flags);
            Some(format!("Pressed {}{key} in {}.", modifiers.iter().map(|name| format!("{name}+")).collect::<String>(), app.name))
        }
        Action::Scroll { x, y, dx, dy } => {
            let point = to_screen(&window.bounds, *x, *y).ok_or_else(|| refuse("COMPUTER_DENIED", "that point is outside the app's window; take a new screenshot"))?;
            if !reaches(&windows, pid, point) {
                return Err(refuse("COMPUTER_DENIED", "another window covers that point, so nothing was scrolled"));
            }
            mac::scroll(point, *dx, *dy);
            Some(format!("Scrolled at {x}, {y} in {}.", app.name))
        }
    };
    let window = if done.is_some() {
        // The app takes a moment to draw what the input did.
        std::thread::sleep(Duration::from_millis(400));
        front_window(&mac::windows(), pid).cloned().unwrap_or(window)
    } else {
        window
    };
    let picture = capture(&window).map_err(|message| refuse("COMPUTER_FAILED", message))?;
    let described = describe(app, &window, (picture.1, picture.2));
    Ok((done.map(|done| format!("{done} {described}")).unwrap_or(described), Some(picture)))
}

/// One request on a booted simulator the person lets agents use: `simctl` captures it, `idb` sends input.
#[cfg(target_os = "macos")]
fn simulator_run(device: &crate::simulator::Device, action: &Action) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    use crate::simulator;
    let failed = |message: String| refuse("COMPUTER_FAILED", message);
    let side = MAX_SIDE as u32;
    let done = match action {
        Action::Apps | Action::Screenshot => None,
        acting => {
            if !simulator::idb_installed() {
                return Err(refuse("COMPUTER_PERMISSION", format!("Runrail can only see {}: tapping and typing in a simulator needs idb, which is not installed. The person can install it, or allow the Simulator app itself under Computer use.", device.name)));
            }
            let geometry = simulator::geometry(&device.udid).map_err(failed)?;
            let outside = || refuse("COMPUTER_DENIED", "that point is outside the simulator's screen; take a new screenshot");
            Some(match acting {
                Action::Click { x, y, right, clicks } => {
                    if *right {
                        return Err(refuse("COMPUTER_FAILED", "a simulator takes taps, not right clicks"));
                    }
                    let point = simulator::to_points(&geometry, MAX_SIDE, *x, *y).ok_or_else(outside)?;
                    for _ in 0..*clicks {
                        simulator::tap_points(&device.udid, point).map_err(failed)?;
                    }
                    format!("Tapped at {x}, {y} in {}.", device.name)
                }
                Action::Type { text } => {
                    simulator::type_text(&device.udid, text).map_err(failed)?;
                    format!("Typed {} characters in {}.", text.chars().count(), device.name)
                }
                Action::Key { key, modifiers } => {
                    if !modifiers.is_empty() {
                        return Err(refuse("COMPUTER_FAILED", "modifier keys do not reach a simulator from Runrail"));
                    }
                    if key == "Home" {
                        simulator::press_button(&device.udid, "HOME").map_err(failed)?;
                    } else if let Some(code) = simulator::hid_key(key) {
                        simulator::press_key(&device.udid, code).map_err(failed)?;
                    } else if key.chars().count() == 1 {
                        simulator::type_text(&device.udid, key).map_err(failed)?;
                    } else {
                        return Err(refuse("COMPUTER_FAILED", "that key does not reach a simulator"));
                    }
                    format!("Pressed {key} in {}.", device.name)
                }
                Action::Scroll { x, y, dx, dy } => {
                    let point = simulator::to_points(&geometry, MAX_SIDE, *x, *y).ok_or_else(outside)?;
                    let (from, to) = simulator::scroll_swipe(&geometry, point, *dx, *dy);
                    simulator::swipe_points(&device.udid, from, to).map_err(failed)?;
                    format!("Scrolled at {x}, {y} in {}.", device.name)
                }
                Action::Apps | Action::Screenshot => unreachable!(),
            })
        }
    };
    if done.is_some() {
        // The app takes a moment to draw what the input did.
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    let screen = simulator::screenshot(&device.udid, side).map_err(|error| refuse("COMPUTER_FAILED", error.message))?;
    if screen.data_base64.len() > MAX_IMAGE_BASE64 {
        return Err(refuse("COMPUTER_FAILED", "the simulator's screen is too large to capture"));
    }
    let described = format!(
        "{} ({} simulator): {} by {} pixels. x and y for the other computer tools are pixels in this image; computer_key with Home presses the Home button.",
        device.name, device.runtime, screen.width, screen.height
    );
    Ok((done.map(|done| format!("{done} {described}")).unwrap_or(described), Some((screen.data_base64, screen.width, screen.height))))
}

/// The listing's part for Android emulators, which the person lets agents use.
fn emulators_listed(running: &[crate::android::Device]) -> String {
    if running.is_empty() {
        return "The person lets you use Android emulators, and none is running; the person starts one in Runrail's Android tab.".into();
    }
    let lines: Vec<String> = running.iter().map(|device| format!("- {} ({})", device.name, device.serial.as_deref().unwrap_or_default())).collect();
    format!("Android emulators you may use; name one as the app:\n{}", lines.join("\n"))
}

/// The apps listing with the running emulators after it, when the person lets agents use them.
fn with_emulators(text: String) -> String {
    if !crate::android::agents_on() {
        return text;
    }
    let part = emulators_listed(&crate::android::running_devices().unwrap_or_default());
    if text.is_empty() {
        part
    } else {
        format!("{text}\n\n{part}")
    }
}

/// A running emulator the agent named, when the person lets agents use them; an allowed app by
/// the same name wins.
fn emulator_named(apps: &[AllowedApp], named: &str) -> Option<crate::android::Device> {
    if !crate::android::agents_on() || find_allowed(apps, named).is_some() {
        return None;
    }
    crate::android::find_running(named)
}

/// One request on a running emulator the person lets agents use, all through `adb`.
fn emulator_run(device: &crate::android::Device, action: &Action) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    use crate::android;
    let failed = |error: BridgeError| refuse("COMPUTER_FAILED", error.message);
    let outside = || refuse("COMPUTER_DENIED", "that point is outside the emulator's screen; take a new screenshot");
    let serial = device.serial.as_deref().unwrap_or_default();
    let done = match action {
        Action::Apps | Action::Screenshot => None,
        Action::Click { x, y, right, clicks } => {
            if *right {
                return Err(refuse("COMPUTER_FAILED", "an emulator takes taps, not right clicks"));
            }
            let size = android::size(serial).map_err(failed)?;
            let point = android::to_pixels(size, MAX_SIDE, *x, *y).ok_or_else(outside)?;
            for _ in 0..*clicks {
                android::tap(serial, point).map_err(failed)?;
            }
            Some(format!("Tapped at {x}, {y} in {}.", device.name))
        }
        Action::Type { text } => {
            if android::text_pieces(text).is_err() {
                return Err(refuse("COMPUTER_FAILED", "an emulator takes ASCII text only, so nothing was typed; type it again in plain ASCII"));
            }
            android::type_text(serial, text).map_err(failed)?;
            Some(format!("Typed {} characters in {}.", text.chars().count(), device.name))
        }
        Action::Key { key, modifiers } => {
            if !modifiers.is_empty() {
                return Err(refuse("COMPUTER_FAILED", "modifier keys do not reach an emulator from Runrail"));
            }
            if let Some(code) = android::agent_key(key) {
                android::press_key(serial, code).map_err(failed)?;
            } else if key.chars().count() == 1 {
                android::type_text(serial, key).map_err(failed)?;
            } else {
                return Err(refuse("COMPUTER_FAILED", "that key does not reach an emulator"));
            }
            Some(format!("Pressed {key} in {}.", device.name))
        }
        Action::Scroll { x, y, dx, dy } => {
            let size = android::size(serial).map_err(failed)?;
            let point = android::to_pixels(size, MAX_SIDE, *x, *y).ok_or_else(outside)?;
            let (from, to) = android::scroll_swipe(size, point, *dx, *dy);
            android::swipe(serial, from, to).map_err(failed)?;
            Some(format!("Scrolled at {x}, {y} in {}.", device.name))
        }
    };
    if done.is_some() {
        // The app takes a moment to draw what the input did.
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    let screen = android::screenshot(serial, MAX_SIDE as u32).map_err(failed)?;
    if screen.data_base64.len() > MAX_IMAGE_BASE64 {
        return Err(refuse("COMPUTER_FAILED", "the emulator's screen is too large to capture"));
    }
    let described = format!(
        "{} (Android emulator {serial}): {} by {} pixels. x and y for the other computer tools are pixels in this image; computer_key with Home goes to the home screen and Escape goes back.",
        device.name, screen.width, screen.height
    );
    Ok((done.map(|done| format!("{done} {described}")).unwrap_or(described), Some((screen.data_base64, screen.width, screen.height))))
}

/// The window as a JPEG at most `MAX_SIDE` pixels on its longer side and 900 KiB as base64.
#[cfg(target_os = "macos")]
fn capture(window: &Window) -> Result<(String, u32, u32), String> {
    use base64::Engine;
    use std::process::{Command, Stdio};
    let failed = "the window could not be captured";
    let scale = scale(&window.bounds);
    let size = (((window.bounds.width * scale).round() as u32).max(1), ((window.bounds.height * scale).round() as u32).max(1));
    let folder = std::env::temp_dir().join(format!("runrail-computer-{}", std::process::id()));
    std::fs::create_dir_all(&folder).map_err(|_| failed.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700));
    }
    let stem = format!("{}-{}", window.id, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default());
    let (png, jpeg) = (folder.join(format!("{stem}.png")), folder.join(format!("{stem}.jpg")));
    let quiet = |command: &mut Command| command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success());
    let captured = quiet(Command::new("/usr/sbin/screencapture").arg("-x").arg("-o").arg(format!("-l{}", window.id)).arg("-t").arg("png").arg(&png));
    let mut chosen: Option<String> = None;
    if captured {
        for quality in ["70", "50", "35"] {
            let converted = quiet(Command::new("/usr/bin/sips").args(["-s", "format", "jpeg", "-s", "formatOptions", quality, "-z", &size.1.to_string(), &size.0.to_string()]).arg(&png).arg("--out").arg(&jpeg));
            let Some(bytes) = converted.then(|| std::fs::read(&jpeg).ok()).flatten() else { break };
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            let fits = data.len() <= MAX_IMAGE_BASE64;
            chosen = Some(data);
            if fits {
                break;
            }
        }
    }
    let _ = std::fs::remove_file(&png);
    let _ = std::fs::remove_file(&jpeg);
    match chosen {
        Some(data) if data.len() <= MAX_IMAGE_BASE64 => Ok((data, size.0, size.1)),
        Some(_) => Err("the window is too large to capture".into()),
        None => Err(failed.into()),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::time::{Duration, Instant};

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
    use objc2_core_foundation::CGPoint;
    use objc2_core_graphics::{kCGNullWindowID, CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess, CGScrollEventUnit, CGWindowListCopyWindowInfo, CGWindowListOption};
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

    use super::{front_window, never, Access, FrontWindow, Rect, RunningApp, Window};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    pub fn access() -> Access {
        Access { supported: true, screen: CGPreflightScreenCaptureAccess(), accessibility: unsafe { AXIsProcessTrusted() }, ..Access::default() }
    }

    /// Shows the system's own request, which lists Runrail in System Settings for the person to turn on.
    pub fn request_access(kind: &str) -> Access {
        match kind {
            "screen" => {
                let _ = CGRequestScreenCaptureAccess();
            }
            "accessibility" => {
                let key = NSString::from_str("AXTrustedCheckOptionPrompt");
                let yes = NSNumber::new_bool(true);
                let options: Retained<NSDictionary<NSString, NSNumber>> = NSDictionary::from_slices(&[&*key], &[&*yes]);
                let _ = unsafe { AXIsProcessTrustedWithOptions(Retained::as_ptr(&options).cast()) };
            }
            _ => {}
        }
        access()
    }

    /// Apps with a Dock icon that are running now, other than Runrail.
    pub fn running_apps(own: &str) -> Vec<RunningApp> {
        let mut apps: Vec<RunningApp> = Vec::new();
        for app in NSWorkspace::sharedWorkspace().runningApplications().iter() {
            if app.activationPolicy() != NSApplicationActivationPolicy::Regular || app.isTerminated() {
                continue;
            }
            let Some(bundle_id) = app.bundleIdentifier().map(|id| id.to_string()) else { continue };
            if bundle_id.eq_ignore_ascii_case(own) || apps.iter().any(|entry| entry.bundle_id == bundle_id) {
                continue;
            }
            let name = app.localizedName().map(|name| name.to_string()).unwrap_or_else(|| bundle_id.clone());
            apps.push(RunningApp { never: never(&bundle_id), bundle_id, name });
        }
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps
    }

    pub fn pid_of(bundle_id: &str) -> Option<i32> {
        let found = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id));
        found.iter().find(|app| !app.isTerminated()).map(|app| app.processIdentifier())
    }

    /// The frontmost app's front window, unless the frontmost app is Runrail.
    pub fn front_window_now(own_pid: i32) -> Option<FrontWindow> {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let pid = app.processIdentifier();
        if pid == own_pid {
            return None;
        }
        let bundle_id = app.bundleIdentifier().map(|id| id.to_string()).unwrap_or_default();
        let name = app.localizedName().map(|name| name.to_string()).unwrap_or_else(|| bundle_id.clone());
        let all = windows();
        let window = front_window(&all, pid)?.clone();
        Some(FrontWindow { window, app: name, bundle_id })
    }

    fn frontmost() -> Option<i32> {
        NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier())
    }

    /// Activates the app, or asks Launch Services to when macOS refuses an app in the background.
    pub fn bring_to_front(pid: i32, bundle_id: &str) -> bool {
        if frontmost() == Some(pid) {
            return true;
        }
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            #[allow(deprecated)]
            let _ = app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
        }
        if wait_front(pid, Duration::from_millis(600)) {
            return true;
        }
        let _ = std::process::Command::new("/usr/bin/open").arg("-b").arg(bundle_id).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
        wait_front(pid, Duration::from_millis(1_200))
    }

    fn wait_front(pid: i32, limit: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if frontmost() == Some(pid) {
                // Its window comes up a moment after the app.
                std::thread::sleep(Duration::from_millis(150));
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn number(dictionary: &NSDictionary<NSString, AnyObject>, key: &str) -> Option<f64> {
        dictionary.objectForKey(&NSString::from_str(key)).and_then(|value| value.downcast::<NSNumber>().ok()).map(|value| value.as_f64())
    }

    /// The windows on screen, front to back.
    pub fn windows() -> Vec<Window> {
        let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, kCGNullWindowID) else {
            return Vec::new();
        };
        // Safety: a CFArray of CFDictionary is toll-free bridged to NSArray of NSDictionary, and `list` outlives the borrow.
        let array: &NSArray<NSDictionary<NSString, AnyObject>> = unsafe { &*(objc2_core_foundation::CFRetained::as_ptr(&list).as_ptr() as *const NSArray<NSDictionary<NSString, AnyObject>>) };
        let mut windows = Vec::new();
        for entry in array.iter() {
            let bounds = entry.objectForKey(&NSString::from_str("kCGWindowBounds")).and_then(|value| value.downcast::<NSDictionary>().ok());
            let Some(bounds) = bounds else { continue };
            // Safety: the bounds dictionary holds NSString keys and NSNumber values.
            let bounds: &NSDictionary<NSString, AnyObject> = unsafe { &*(Retained::as_ptr(&bounds) as *const NSDictionary<NSString, AnyObject>) };
            let (Some(id), Some(pid), Some(x), Some(y), Some(width), Some(height)) = (number(&entry, "kCGWindowNumber"), number(&entry, "kCGWindowOwnerPID"), number(bounds, "X"), number(bounds, "Y"), number(bounds, "Width"), number(bounds, "Height")) else {
                continue;
            };
            let title = entry.objectForKey(&NSString::from_str("kCGWindowName")).and_then(|value| value.downcast::<NSString>().ok()).map(|name| name.to_string());
            windows.push(Window { id: id as u32, pid: pid as i32, layer: number(&entry, "kCGWindowLayer").unwrap_or(0.0) as i64, alpha: number(&entry, "kCGWindowAlpha").unwrap_or(1.0), bounds: Rect { x, y, width, height }, title });
        }
        windows
    }

    fn post(event: Option<objc2_core_foundation::CFRetained<CGEvent>>) {
        CGEvent::post(CGEventTapLocation::HIDEventTap, event.as_deref());
    }

    fn mouse(kind: CGEventType, point: CGPoint, button: CGMouseButton, click_state: i64) {
        let event = CGEvent::new_mouse_event(None, kind, point, button);
        if click_state > 0 {
            CGEvent::set_integer_value_field(event.as_deref(), CGEventField::MouseEventClickState, click_state);
        }
        post(event);
    }

    pub fn click(point: (f64, f64), right: bool, clicks: i64) {
        let at = CGPoint { x: point.0, y: point.1 };
        let (down, up, button) = if right { (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right) } else { (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left) };
        mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, 0);
        std::thread::sleep(Duration::from_millis(30));
        for state in 1..=clicks {
            mouse(down, at, button, state);
            mouse(up, at, button, state);
        }
    }

    pub fn key(code: u16, flags: u64) {
        for down in [true, false] {
            let event = CGEvent::new_keyboard_event(None, code, down);
            CGEvent::set_flags(event.as_deref(), CGEventFlags::from_bits_retain(flags));
            post(event);
        }
    }

    pub fn type_text(pieces: &[Result<String, u16>]) {
        for piece in pieces {
            match piece {
                Err(code) => key(*code, 0),
                Ok(run) => {
                    let units: Vec<u16> = run.encode_utf16().collect();
                    for down in [true, false] {
                        let event = CGEvent::new_keyboard_event(None, 0, down);
                        CGEvent::set_flags(event.as_deref(), CGEventFlags::empty());
                        // Safety: `units` lives through the call and its length is passed with it.
                        unsafe { CGEvent::keyboard_set_unicode_string(event.as_deref(), units.len() as _, units.as_ptr()) };
                        post(event);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    }

    pub fn scroll(point: (f64, f64), dx: i32, dy: i32) {
        mouse(CGEventType::MouseMoved, CGPoint { x: point.0, y: point.1 }, CGMouseButton::Left, 0);
        std::thread::sleep(Duration::from_millis(30));
        post(CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, dy, dx, 0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(pid: i32, layer: i64, bounds: Rect) -> Window {
        Window { id: 1, pid, layer, alpha: 1.0, bounds, title: None }
    }

    #[test]
    fn keys_map_to_us_virtual_keys() {
        assert_eq!(key_code("Return"), Some((36, false)));
        assert_eq!(key_code("s"), Some((1, false)));
        assert_eq!(key_code("S"), Some((1, true)));
        assert_eq!(key_code("?"), Some((44, true)));
        assert_eq!(key_code("F12"), Some((111, false)));
        assert_eq!(key_code("é"), None);
        assert_eq!(key_code("ab"), None);
        assert_eq!(modifier_flag("command"), Some(0x100000));
        assert_eq!(modifier_flag("hyper"), None);
    }

    #[test]
    fn requests_are_checked_again() {
        assert_eq!(parse_action("click", &json!({ "x": 5, "y": 6, "button": "right", "clicks": 2 })).ok(), Some(Action::Click { x: 5, y: 6, right: true, clicks: 2 }));
        assert_eq!(parse_action("scroll", &json!({ "x": 1, "y": 2, "direction": "left" })).ok(), Some(Action::Scroll { x: 1, y: 2, dx: 3, dy: 0 }));
        assert_eq!(parse_action("key", &json!({ "key": "s", "modifiers": ["command", "shift"] })).ok(), Some(Action::Key { key: "s".into(), modifiers: vec!["command".into(), "shift".into()] }));
        for (action, params) in [("click", json!({ "x": -1, "y": 0 })), ("click", json!({ "x": 1, "y": 1, "clicks": 3 })), ("type", json!({ "text": "" })), ("type", json!({ "text": "x".repeat(2_001) })), ("key", json!({ "key": "F13" })), ("key", json!({ "key": "a", "modifiers": ["hyper"] })), ("scroll", json!({ "x": 1, "y": 1, "direction": "up", "amount": 21 })), ("drag", json!({}))] {
            assert!(parse_action(action, &params).is_err(), "{action} {params}");
        }
    }

    #[test]
    fn screenshots_map_back_to_points_inside_the_window_only() {
        let small = Rect { x: 100.0, y: 50.0, width: 800.0, height: 600.0 };
        assert_eq!(to_screen(&small, 10, 20), Some((110.0, 70.0)));
        assert_eq!(to_screen(&small, 800, 10), None);
        let large = Rect { x: 0.0, y: 25.0, width: 2_560.0, height: 1_400.0 };
        assert_eq!(scale(&large), 0.5);
        assert_eq!(to_screen(&large, 640, 100), Some((1_280.0, 225.0)));
    }

    #[test]
    fn a_click_reaches_only_the_apps_own_window() {
        let app = Rect { x: 0.0, y: 0.0, width: 500.0, height: 500.0 };
        let floating = Rect { x: 400.0, y: 400.0, width: 200.0, height: 200.0 };
        let windows = vec![Window { alpha: 0.0, ..window(9, 30, app) }, window(7, 3, floating), window(42, 0, app), window(43, 0, app)];
        assert_eq!(front_window(&windows, 42).map(|found| found.pid), Some(42));
        assert!(reaches(&windows, 42, (10.0, 10.0)));
        assert!(!reaches(&windows, 42, (450.0, 450.0)));
        assert!(!reaches(&windows, 43, (10.0, 10.0)));
    }

    #[test]
    fn typing_turns_new_lines_into_keys_and_splits_long_runs() {
        let pieces = type_pieces("hi\nthere\tyou\r");
        assert_eq!(pieces, vec![Ok("hi".into()), Err(36), Ok("there".into()), Err(48), Ok("you".into())]);
        let long = type_pieces(&"x".repeat(40));
        assert_eq!(long.iter().map(|piece| piece.as_ref().map(|run| run.len()).unwrap_or(0)).collect::<Vec<_>>(), vec![16, 16, 8]);
    }

    #[test]
    fn allowed_apps_are_found_by_id_or_name_and_unsafe_apps_never() {
        let apps = vec![AllowedApp { bundle_id: "com.apple.Notes".into(), name: "Notes".into() }];
        assert_eq!(find_allowed(&apps, "notes").map(|app| app.name.as_str()), Some("Notes"));
        assert_eq!(find_allowed(&apps, "COM.APPLE.NOTES").map(|app| app.name.as_str()), Some("Notes"));
        assert!(find_allowed(&apps, "Safari").is_none());
        assert!(never("com.apple.Terminal") && never("com.apple.systempreferences"));
        assert!(!never("com.apple.Notes"));
        assert!(valid_bundle_id("com.apple.Notes") && !valid_bundle_id("a b") && !valid_bundle_id(""));
        let saved = json!({ "version": 1, "apps": [{ "bundleId": "com.apple.Notes", "name": "Notes" }, { "bundleId": "com.apple.Terminal", "name": "Terminal" }] }).to_string();
        assert_eq!(parse(saved.as_bytes()), Some(vec![AllowedApp { bundle_id: "com.apple.Notes".into(), name: "Notes".into() }]));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn running_emulators_are_listed_and_found_by_any_of_their_names() {
        let none = {
            let _sdk = crate::android::FakeSdk::new("none-running", &[], (1080, 2400));
            emulators_listed(&crate::android::running_devices().unwrap())
        };
        assert_eq!(none, "The person lets you use Android emulators, and none is running; the person starts one in Runrail's Android tab.");
        let sdk = crate::android::FakeSdk::new("listed", &[("emulator-5554", "Pixel_Test"), ("emulator-5556", "Tablet_API_35")], (1080, 2400));
        sdk.allow_agents();
        let listed = "Android emulators you may use; name one as the app:\n- Pixel Test (emulator-5554)\n- Tablet API 35 (emulator-5556)";
        assert_eq!(with_emulators(String::new()), listed);
        assert_eq!(with_emulators("Apps you may use, as the person allowed them:\n- Notes (com.apple.Notes)".into()), format!("Apps you may use, as the person allowed them:\n- Notes (com.apple.Notes)\n\n{listed}"));
        let found = |named: &str| crate::android::find_running(named).and_then(|device| device.serial);
        assert_eq!(found("EMULATOR-5556").as_deref(), Some("emulator-5556"));
        assert_eq!(found(" tablet_api_35 ").as_deref(), Some("emulator-5556"));
        assert_eq!(found("pixel test").as_deref(), Some("emulator-5554"));
        assert_eq!(found("Other_AVD"), None);
        assert_eq!(found(""), None);
        let apps = vec![AllowedApp { bundle_id: "com.example.pixel".into(), name: "Pixel Test".into() }];
        assert!(emulator_named(&apps, "pixel test").is_none());
        assert_eq!(emulator_named(&apps, "Pixel_Test").and_then(|device| device.serial).as_deref(), Some("emulator-5554"));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn an_agent_taps_scrolls_types_and_presses_keys_in_an_emulator_by_adb() {
        // A narrow screen, scaled by 0.8 like a phone's, keeps the debug build's captures quick.
        let sdk = crate::android::FakeSdk::new("agent", &[("emulator-5554", "Pixel_Test")], (400, 1600));
        sdk.allow_agents();
        let ask = |action: &str, params: Value| act("com.runrail.test", action, &params);
        let shown = ask("screenshot", json!({ "app": "pixel test" }));
        assert_eq!(shown["result"]["text"], "Pixel Test (Android emulator emulator-5554): 320 by 1280 pixels. x and y for the other computer tools are pixels in this image; computer_key with Home goes to the home screen and Escape goes back.");
        assert_eq!(shown["result"]["image"]["mediaType"], "image/jpeg");
        for (action, params) in [
            ("click", json!({ "app": "emulator-5554", "x": 288, "y": 640 })),
            ("scroll", json!({ "app": "Pixel_Test", "x": 288, "y": 640, "direction": "down" })),
            ("scroll", json!({ "app": "Pixel_Test", "x": 100, "y": 640, "direction": "left", "amount": 1 })),
            ("type", json!({ "app": "pixel test", "text": "hi you" })),
            ("key", json!({ "app": "pixel test", "key": "Escape" })),
            ("key", json!({ "app": "pixel test", "key": "a" })),
        ] {
            let answer = ask(action, params);
            assert_eq!(answer["ok"], true, "{action}: {answer}");
        }
        assert!(ask("click", json!({ "app": "pixel test", "x": 2, "y": 3 }))["result"]["text"].as_str().unwrap().starts_with("Tapped at 2, 3 in Pixel Test. Pixel Test (Android emulator emulator-5554)"));
        for (action, params, message) in [
            ("click", json!({ "app": "pixel test", "x": 320, "y": 10 }), "that point is outside the emulator's screen; take a new screenshot"),
            ("scroll", json!({ "app": "pixel test", "x": 10, "y": 1280, "direction": "up" }), "that point is outside the emulator's screen; take a new screenshot"),
            ("click", json!({ "app": "pixel test", "x": 10, "y": 10, "button": "right" }), "an emulator takes taps, not right clicks"),
            ("type", json!({ "app": "pixel test", "text": "café" }), "an emulator takes ASCII text only, so nothing was typed; type it again in plain ASCII"),
            ("key", json!({ "app": "pixel test", "key": "s", "modifiers": ["command"] }), "modifier keys do not reach an emulator from Runrail"),
            ("key", json!({ "app": "pixel test", "key": "F5" }), "that key does not reach an emulator"),
        ] {
            assert_eq!(ask(action, params), json!({ "ok": false, "code": if message.starts_with("that point") { "COMPUTER_DENIED" } else { "COMPUTER_FAILED" }, "message": message }));
        }
        let input: Vec<String> = sdk.asked().into_iter().filter(|line| line.starts_with("-s|emulator-5554|shell|input|")).collect();
        assert_eq!(input, vec![
            "-s|emulator-5554|shell|input|tap|361|801|",
            "-s|emulator-5554|shell|input|swipe|361|801|361|561|300|",
            "-s|emulator-5554|shell|input|swipe|126|801|206|801|300|",
            "-s|emulator-5554|shell|input|text|'hi%syou'|",
            "-s|emulator-5554|shell|input|keyevent|4|",
            "-s|emulator-5554|shell|input|text|'a'|",
            "-s|emulator-5554|shell|input|tap|3|4|",
        ]);
    }
}
