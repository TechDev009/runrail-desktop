//! iOS Simulator: the person's simulators in a side-panel tab and, once the person
//! turns it on, for agents through the computer tools. `simctl` lists, boots, installs, launches
//! and captures; taps, swipes, typing and hardware buttons go through `idb` when it is installed,
//! since `simctl` cannot send input. None of it needs Screen Recording or Accessibility.
// Input and lookup helpers serve the macOS computer tools only; simulators are macOS-only.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::computer::valid_bundle_id;
use crate::error::{BridgeError, BridgeResult};
use crate::process::{clean, complaint, run, Ran};
use crate::store;

const FILE: &str = "simulator.json";
const MAX_URL: usize = 2_048;
pub const MAX_TEXT: usize = 2_000;
const MAX_IMAGE_BASE64: usize = 3 * 1024 * 1024;
/// Booting or installing can take a while on a busy Mac.
const SLOW: Duration = Duration::from_secs(120);
const QUICK: Duration = Duration::from_secs(20);
/// How far one step of a scroll moves, in points.
const SCROLL_STEP: f64 = 40.0;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    /// Xcode's simulator tools are installed.
    pub xcode: bool,
    /// `idb` is on the login PATH, so taps and typing work.
    pub idb: bool,
    /// The person lets agents use booted simulators.
    pub agents: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub udid: String,
    pub name: String,
    pub runtime: String,
    pub booted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimApp {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub media_type: &'static str,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

/// A device's screen in points (what `idb` takes) and in pixels (what a capture has).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub points: (f64, f64),
    pub pixels: (f64, f64),
}

/// Input from the panel, with places as fractions of the screen so any image size maps the same.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Tap { x: f64, y: f64 },
    Swipe { from: (f64, f64), to: (f64, f64) },
    Text(String),
    Key(u32),
    Button(&'static str),
}

// ---------------------------------------------------------------------------------------------
// Whether agents may use simulators

static SETTINGS: OnceLock<Settings> = OnceLock::new();

struct Settings {
    file: PathBuf,
    agents: Mutex<bool>,
}

pub fn init(app_data: &Path) {
    let file = app_data.join(FILE);
    let agents = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).and_then(|value| value["agents"].as_bool()).unwrap_or(false);
    let _ = SETTINGS.set(Settings { file, agents: Mutex::new(agents) });
}

pub fn agents_on() -> bool {
    SETTINGS.get().and_then(|settings| settings.agents.lock().ok().map(|agents| *agents)).unwrap_or(false)
}

/// Turning it on asks the person in a dialog the page cannot draw; turning it off does not.
pub fn set_agents(app: &tauri::AppHandle, on: bool) -> BridgeResult<Status> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if on && !agents_on() {
        let agreed = app
            .dialog()
            .message("Threads you turn computer use on in can see booted iOS simulators and tap, swipe, and type in them.\n\nA simulator can reach the network and uses the apps installed in it. You can turn this off in Settings at any time.")
            .title("Let agents use iOS simulators?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
            .blocking_show();
        if !agreed {
            return Err(BridgeError::new("COMPUTER_DECLINED", "The person did not allow simulators.").with_status(403));
        }
    }
    let settings = SETTINGS.get().ok_or_else(|| BridgeError::new("SIMULATOR_UNAVAILABLE", "the simulator settings could not be read"))?;
    let mut agents = settings.agents.lock().map_err(|_| BridgeError::new("SIMULATOR_UNAVAILABLE", "the simulator settings could not be read"))?;
    store::write_atomic(&settings.file, json!({ "version": 1, "agents": on }).to_string().as_bytes())?;
    *agents = on;
    drop(agents);
    Ok(status())
}

// ---------------------------------------------------------------------------------------------
// Running the tools

/// Xcode's `simctl`, found through `xcode-select` so a Mac without Xcode never shows the
/// command line tools installer.
fn simctl_path() -> Option<PathBuf> {
    static FOUND: Mutex<Option<PathBuf>> = Mutex::new(None);
    if !cfg!(target_os = "macos") {
        return None;
    }
    if let Some(known) = FOUND.lock().ok().and_then(|found| found.clone()).filter(|path| path.is_file()) {
        return Some(known);
    }
    let mut select = Command::new("/usr/bin/xcode-select");
    select.arg("-p");
    let ran = run(select, None, QUICK).ok().filter(|ran| ran.ok)?;
    let developer = String::from_utf8_lossy(&ran.stdout).trim().to_string();
    let simctl = Path::new(&developer).join("usr/bin/simctl");
    let simctl = simctl.is_file().then_some(simctl)?;
    if let Ok(mut found) = FOUND.lock() {
        *found = Some(simctl.clone());
    }
    Some(simctl)
}

fn simctl(args: &[&str], timeout: Duration) -> BridgeResult<Ran> {
    let path = simctl_path().ok_or_else(|| BridgeError::new("SIMULATOR_UNAVAILABLE", "Xcode is not installed, so there are no simulators").with_status(501))?;
    let mut command = Command::new(path);
    command.args(args);
    run(command, None, timeout).map_err(|message| BridgeError::new("SIMULATOR_FAILED", message))
}

fn simctl_ok(args: &[&str], timeout: Duration, fallback: &str) -> BridgeResult<Ran> {
    let ran = simctl(args, timeout)?;
    if ran.ok {
        Ok(ran)
    } else {
        Err(BridgeError::new("SIMULATOR_FAILED", complaint(&ran.stderr, fallback)))
    }
}

fn idb_path() -> Option<PathBuf> {
    cfg!(target_os = "macos").then(|| crate::engine::find_on_path("idb")).flatten()
}

fn idb(udid: &str, args: &[&str]) -> Result<Ran, String> {
    let path = idb_path().ok_or_else(|| "idb is not installed".to_string())?;
    let mut command = Command::new(path);
    if let Some(login) = crate::engine::login_path() {
        // idb starts idb_companion, which it finds on PATH.
        command.env("PATH", login);
    }
    command.args(&args[..2]).args(["--udid", udid]).args(&args[2..]);
    let ran = run(command, None, QUICK)?;
    if ran.ok {
        Ok(ran)
    } else {
        Err(complaint(&ran.stderr, "idb could not do that"))
    }
}

pub fn status() -> Status {
    Status { supported: cfg!(target_os = "macos"), xcode: simctl_path().is_some(), idb: idb_path().is_some(), agents: agents_on() }
}

pub fn valid_udid(value: &str) -> bool {
    value.len() == 36 && value.chars().all(|char| char.is_ascii_hexdigit() || char == '-')
}

fn checked(udid: &str) -> BridgeResult<&str> {
    if valid_udid(udid) {
        Ok(udid)
    } else {
        Err(BridgeError::new("CONTROL_INVALID_INPUT", "the simulator is invalid"))
    }
}

// ---------------------------------------------------------------------------------------------
// Devices and apps

/// "com.apple.CoreSimulator.SimRuntime.iOS-26-3" as "iOS 26.3"; other platforms are left out.
fn runtime_label(identifier: &str) -> Option<(String, Vec<u32>)> {
    let version = identifier.rsplit('.').next()?.strip_prefix("iOS-")?;
    let parts: Vec<u32> = version.split('-').map(str::parse).collect::<Result<_, _>>().ok()?;
    Some((format!("iOS {}", version.replace('-', ".")), parts))
}

pub fn parse_devices(bytes: &[u8]) -> Vec<Device> {
    let value: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let mut found: Vec<(Vec<u32>, Device)> = Vec::new();
    for (identifier, list) in value["devices"].as_object().into_iter().flatten() {
        let Some((runtime, version)) = runtime_label(identifier) else { continue };
        for item in list.as_array().into_iter().flatten() {
            if item["isAvailable"].as_bool() == Some(false) {
                continue;
            }
            let (Some(udid), Some(name)) = (item["udid"].as_str().filter(|udid| valid_udid(udid)), item["name"].as_str()) else { continue };
            found.push((version.clone(), Device { udid: udid.to_string(), name: clean(name, 100), runtime: runtime.clone(), booted: item["state"].as_str() == Some("Booted") }));
        }
    }
    // Booted first, then the newest system, then by name.
    found.sort_by(|a, b| b.1.booted.cmp(&a.1.booted).then_with(|| b.0.cmp(&a.0)).then_with(|| a.1.name.cmp(&b.1.name)));
    found.into_iter().map(|(_, device)| device).collect()
}

pub fn devices() -> BridgeResult<Vec<Device>> {
    let ran = simctl_ok(&["list", "devices", "available", "-j"], QUICK, "the simulators could not be listed")?;
    Ok(parse_devices(&ran.stdout))
}

/// A booted simulator by its id, or by its name in any case.
pub fn find_booted(named: &str) -> Option<Device> {
    let named = named.trim();
    let booted: Vec<Device> = devices().ok()?.into_iter().filter(|device| device.booted).collect();
    booted.iter().find(|device| device.udid.eq_ignore_ascii_case(named)).or_else(|| booted.iter().find(|device| device.name.eq_ignore_ascii_case(named))).cloned()
}

pub fn boot(udid: &str) -> BridgeResult<()> {
    let ran = simctl(&["boot", checked(udid)?], SLOW)?;
    if ran.ok || ran.stderr.contains("current state: Booted") {
        Ok(())
    } else {
        Err(BridgeError::new("SIMULATOR_FAILED", complaint(&ran.stderr, "the simulator could not start")))
    }
}

pub fn shutdown(udid: &str) -> BridgeResult<()> {
    let ran = simctl(&["shutdown", checked(udid)?], SLOW)?;
    if ran.ok || ran.stderr.contains("current state: Shutdown") {
        Ok(())
    } else {
        Err(BridgeError::new("SIMULATOR_FAILED", complaint(&ran.stderr, "the simulator could not shut down")))
    }
}

/// Shows the device in Xcode's Simulator app.
pub fn open_in_simulator(udid: &str) -> BridgeResult<()> {
    let mut command = Command::new("/usr/bin/open");
    command.args(["-a", "Simulator", "--args", "-CurrentDeviceUDID", checked(udid)?]);
    let ran = run(command, None, QUICK).map_err(|message| BridgeError::new("SIMULATOR_FAILED", message))?;
    if ran.ok {
        Ok(())
    } else {
        Err(BridgeError::new("SIMULATOR_FAILED", "the Simulator app could not be opened"))
    }
}

/// The apps the person installed, from `simctl listapps` as JSON.
pub fn parse_apps(value: &Value) -> Vec<SimApp> {
    let mut apps: Vec<SimApp> = value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(bundle_id, info)| valid_bundle_id(bundle_id) && info["ApplicationType"].as_str() == Some("User"))
        .map(|(bundle_id, info)| {
            let name = info["CFBundleDisplayName"].as_str().or_else(|| info["CFBundleName"].as_str()).filter(|name| !name.trim().is_empty()).unwrap_or(bundle_id);
            SimApp { bundle_id: bundle_id.clone(), name: clean(name, 100) }
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

pub fn apps(udid: &str) -> BridgeResult<Vec<SimApp>> {
    let listed = simctl_ok(&["listapps", checked(udid)?], QUICK, "the apps could not be listed")?;
    // listapps prints an old-style property list; plutil turns it into JSON.
    let mut convert = Command::new("/usr/bin/plutil");
    convert.args(["-convert", "json", "-o", "-", "-"]);
    let converted = run(convert, Some(listed.stdout), QUICK).map_err(|message| BridgeError::new("SIMULATOR_FAILED", message))?;
    let value: Value = serde_json::from_slice(&converted.stdout).map_err(|_| BridgeError::new("SIMULATOR_FAILED", "the apps could not be read"))?;
    Ok(parse_apps(&value))
}

pub fn launch(udid: &str, bundle_id: &str) -> BridgeResult<()> {
    if !valid_bundle_id(bundle_id) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the app is invalid"));
    }
    simctl_ok(&["launch", "--terminate-running-process", checked(udid)?, bundle_id], SLOW, "the app could not be opened").map(|_| ())
}

pub fn valid_url(url: &str) -> bool {
    let scheme = url.split(':').next().unwrap_or_default();
    url.len() <= MAX_URL
        && url.len() > scheme.len() + 1
        && scheme.chars().next().is_some_and(|char| char.is_ascii_alphabetic())
        && scheme.chars().all(|char| char.is_ascii_alphanumeric() || matches!(char, '+' | '.' | '-'))
        && !url.chars().any(|char| char.is_control() || char.is_whitespace())
}

pub fn open_url(udid: &str, url: &str) -> BridgeResult<()> {
    if !valid_url(url) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the address is invalid"));
    }
    simctl_ok(&["openurl", checked(udid)?, url], QUICK, "the address could not be opened").map(|_| ())
}

fn plist_string(info: &Path, key: &str) -> Option<String> {
    let mut command = Command::new("/usr/bin/plutil");
    command.args(["-extract", key, "raw", "-o", "-"]).arg(info);
    let ran = run(command, None, QUICK).ok().filter(|ran| ran.ok)?;
    Some(String::from_utf8_lossy(&ran.stdout).trim().to_string()).filter(|value| !value.is_empty())
}

/// Installs a built `.app` the person picks in the system's file dialog, so the page never names a path.
pub fn install(app: &tauri::AppHandle, udid: &str) -> BridgeResult<Option<SimApp>> {
    use tauri_plugin_dialog::DialogExt;
    let udid = checked(udid)?;
    let mut dialog = app.dialog().file().set_title("Install an app in the simulator").add_filter("App", &["app"]);
    if let Some(derived) = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Developer/Xcode/DerivedData")).filter(|path| path.is_dir()) {
        dialog = dialog.set_directory(derived);
    }
    let Some(picked) = dialog.blocking_pick_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|_| BridgeError::new("CONTROL_INVALID_INPUT", "the app is invalid"))?;
    let info = path.join("Info.plist");
    if path.extension().and_then(|extension| extension.to_str()) != Some("app") || !path.is_dir() || !info.is_file() {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "pick a built .app for the simulator"));
    }
    let bundle_id = plist_string(&info, "CFBundleIdentifier").filter(|id| valid_bundle_id(id)).ok_or_else(|| BridgeError::new("CONTROL_INVALID_INPUT", "the app has no bundle id"))?;
    let name = plist_string(&info, "CFBundleDisplayName").or_else(|| plist_string(&info, "CFBundleName")).unwrap_or_else(|| bundle_id.clone());
    let path_text = path.to_string_lossy().into_owned();
    simctl_ok(&["install", udid, &path_text], SLOW, "the app could not be installed")?;
    Ok(Some(SimApp { bundle_id, name: clean(&name, 100) }))
}

// ---------------------------------------------------------------------------------------------
// Screens and input

/// The size of a capture scaled so neither side passes `max_side`.
pub fn scaled(pixels: (f64, f64), max_side: f64) -> (u32, u32) {
    let scale = (max_side / pixels.0.max(pixels.1)).min(1.0);
    (((pixels.0 * scale).round() as u32).max(1), ((pixels.1 * scale).round() as u32).max(1))
}

/// A point in an image of the screen scaled to `max_side`, in device points; none outside it.
pub fn to_points(geometry: &Geometry, max_side: f64, x: u32, y: u32) -> Option<(f64, f64)> {
    let (width, height) = scaled(geometry.pixels, max_side);
    (x < width && y < height).then(|| ((f64::from(x) + 0.5) / f64::from(width) * geometry.points.0, (f64::from(y) + 0.5) / f64::from(height) * geometry.points.1))
}

fn png_size(bytes: &[u8]) -> Option<(f64, f64)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let read = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    Some((f64::from(read(16)), f64::from(read(20))))
}

/// The screen as a JPEG whose longer side is at most `max_side` pixels.
pub fn screenshot(udid: &str, max_side: u32) -> BridgeResult<Screen> {
    use base64::Engine;
    let udid = checked(udid)?;
    let failed = || BridgeError::new("SIMULATOR_FAILED", "the screen could not be captured");
    let folder = std::env::temp_dir().join(format!("runrail-simulator-{}", std::process::id()));
    std::fs::create_dir_all(&folder).map_err(|_| failed())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700));
    }
    let stem = format!("{udid}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default());
    let (png, jpeg) = (folder.join(format!("{stem}.png")), folder.join(format!("{stem}.jpg")));
    let png_text = png.to_string_lossy().into_owned();
    let result = (|| {
        let ran = simctl(&["io", udid, "screenshot", "--type=png", &png_text], QUICK)?;
        if !ran.ok {
            return Err(BridgeError::new("SIMULATOR_FAILED", if ran.stderr.contains("Shutdown") { "the simulator is not running".to_string() } else { complaint(&ran.stderr, "the screen could not be captured") }));
        }
        let pixels = std::fs::read(&png).ok().and_then(|bytes| png_size(&bytes)).ok_or_else(failed)?;
        let size = scaled(pixels, f64::from(max_side));
        let mut convert = Command::new("/usr/bin/sips");
        convert.args(["-s", "format", "jpeg", "-s", "formatOptions", "70", "-z", &size.1.to_string(), &size.0.to_string()]).arg(&png).arg("--out").arg(&jpeg);
        let converted = run(convert, None, QUICK).map_err(|_| failed())?;
        let bytes = converted.ok.then(|| std::fs::read(&jpeg).ok()).flatten().ok_or_else(failed)?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        if data.len() > MAX_IMAGE_BASE64 {
            return Err(BridgeError::new("SIMULATOR_FAILED", "the screen is too large to capture"));
        }
        Ok(Screen { media_type: "image/jpeg", data_base64: data, width: size.0, height: size.1 })
    })();
    let _ = std::fs::remove_file(&png);
    let _ = std::fs::remove_file(&jpeg);
    result
}

/// `idb describe` names the screen's size in pixels and in points.
pub fn parse_describe(value: &Value) -> Option<Geometry> {
    let screen = &value["screen_dimensions"];
    let pixels = (screen["width"].as_f64()?, screen["height"].as_f64()?);
    let density = screen["density"].as_f64().filter(|density| *density > 0.0);
    let points = (screen["width_points"].as_f64().or_else(|| Some(pixels.0 / density?))?, screen["height_points"].as_f64().or_else(|| Some(pixels.1 / density?))?);
    (pixels.0 >= 1.0 && pixels.1 >= 1.0 && points.0 >= 1.0 && points.1 >= 1.0).then_some(Geometry { points, pixels })
}

fn geometries() -> &'static Mutex<HashMap<String, Geometry>> {
    static GEOMETRIES: OnceLock<Mutex<HashMap<String, Geometry>>> = OnceLock::new();
    GEOMETRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The screen's size, asked of `idb` once per device.
pub fn geometry(udid: &str) -> Result<Geometry, String> {
    if let Some(known) = geometries().lock().ok().and_then(|known| known.get(udid).copied()) {
        return Ok(known);
    }
    let ran = idb(udid, &["describe", "--json"])?;
    let value: Value = serde_json::from_slice(&ran.stdout).map_err(|_| "idb did not describe the simulator".to_string())?;
    let found = parse_describe(&value).ok_or_else(|| "idb did not describe the simulator's screen".to_string())?;
    if let Ok(mut known) = geometries().lock() {
        known.insert(udid.to_string(), found);
    }
    Ok(found)
}

/// A USB HID key code, which `idb ui key` takes.
pub fn hid_key(key: &str) -> Option<u32> {
    let named = match key {
        "Return" => Some(40),
        "Escape" => Some(41),
        "Backspace" => Some(42),
        "Tab" => Some(43),
        "Space" => Some(44),
        "PageUp" => Some(75),
        "Delete" => Some(76),
        "End" => Some(77),
        "PageDown" => Some(78),
        "ArrowRight" => Some(79),
        "ArrowLeft" => Some(80),
        "ArrowDown" => Some(81),
        "ArrowUp" => Some(82),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    let mut chars = key.chars();
    let char = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    match char {
        'a'..='z' => Some(4 + u32::from(char) - u32::from('a')),
        '1'..='9' => Some(30 + u32::from(char) - u32::from('1')),
        '0' => Some(39),
        _ => None,
    }
}

/// Typed text in pieces: runs of characters, and the keys for a new line and a tab.
pub fn text_pieces(text: &str) -> Vec<Result<String, u32>> {
    let mut pieces: Vec<Result<String, u32>> = Vec::new();
    let mut run = String::new();
    for char in text.chars() {
        let key = match char {
            '\n' => Some(40),
            '\t' => Some(43),
            '\r' => continue,
            _ => None,
        };
        match key {
            Some(key) => {
                if !run.is_empty() {
                    pieces.push(Ok(std::mem::take(&mut run)));
                }
                pieces.push(Err(key));
            }
            None => run.push(char),
        }
    }
    if !run.is_empty() {
        pieces.push(Ok(run));
    }
    pieces
}

fn points_text(value: f64) -> String {
    format!("{}", value.round().max(0.0) as u32)
}

/// Taps at a point in device points.
pub fn tap_points(udid: &str, point: (f64, f64)) -> Result<(), String> {
    idb(udid, &["ui", "tap", &points_text(point.0), &points_text(point.1)]).map(|_| ())
}

pub fn swipe_points(udid: &str, from: (f64, f64), to: (f64, f64)) -> Result<(), String> {
    idb(udid, &["ui", "swipe", "--duration", "0.3", &points_text(from.0), &points_text(from.1), &points_text(to.0), &points_text(to.1)]).map(|_| ())
}

pub fn type_text(udid: &str, text: &str) -> Result<(), String> {
    for piece in text_pieces(text) {
        match piece {
            // `--` keeps text that starts with a dash from reading as an option.
            Ok(run) => idb(udid, &["ui", "text", "--", &run])?,
            Err(key) => idb(udid, &["ui", "key", &key.to_string()])?,
        };
    }
    Ok(())
}

pub fn press_key(udid: &str, code: u32) -> Result<(), String> {
    idb(udid, &["ui", "key", &code.to_string()]).map(|_| ())
}

pub fn press_button(udid: &str, button: &str) -> Result<(), String> {
    idb(udid, &["ui", "button", button]).map(|_| ())
}

/// A swipe that moves the content `steps` steps in a direction, from a point, kept on the screen.
pub fn scroll_swipe(geometry: &Geometry, from: (f64, f64), dx: i32, dy: i32) -> ((f64, f64), (f64, f64)) {
    // Content moves the way the finger does, so seeing further down means swiping up.
    let to = (from.0 + f64::from(dx) * SCROLL_STEP, from.1 + f64::from(dy) * SCROLL_STEP);
    (from, (to.0.clamp(1.0, geometry.points.0 - 1.0), to.1.clamp(1.0, geometry.points.1 - 1.0)))
}

pub fn parse_input(value: &Value) -> Option<Input> {
    let fraction = |name: &str| value[name].as_f64().filter(|number| (0.0..=1.0).contains(number));
    match value["kind"].as_str()? {
        "tap" => Some(Input::Tap { x: fraction("x")?, y: fraction("y")? }),
        "swipe" => Some(Input::Swipe { from: (fraction("x")?, fraction("y")?), to: (fraction("toX")?, fraction("toY")?) }),
        "text" => value["text"].as_str().filter(|text| !text.is_empty() && text.chars().count() <= MAX_TEXT).map(|text| Input::Text(text.to_string())),
        "key" => value["key"].as_str().and_then(hid_key).map(Input::Key),
        "button" => match value["button"].as_str()? {
            "home" => Some(Input::Button("HOME")),
            "lock" => Some(Input::Button("LOCK")),
            "siri" => Some(Input::Button("SIRI")),
            _ => None,
        },
        _ => None,
    }
}

/// One input from the panel.
pub fn input(udid: &str, input: &Input) -> BridgeResult<()> {
    let udid = checked(udid)?;
    let failed = |message: String| BridgeError::new("SIMULATOR_FAILED", message);
    match input {
        Input::Tap { x, y } => {
            let geometry = geometry(udid).map_err(failed)?;
            tap_points(udid, (x * geometry.points.0, y * geometry.points.1)).map_err(failed)
        }
        Input::Swipe { from, to } => {
            let geometry = geometry(udid).map_err(failed)?;
            swipe_points(udid, (from.0 * geometry.points.0, from.1 * geometry.points.1), (to.0 * geometry.points.0, to.1 * geometry.points.1)).map_err(failed)
        }
        Input::Text(text) => type_text(udid, text).map_err(failed),
        Input::Key(code) => press_key(udid, *code).map_err(failed),
        Input::Button(button) => press_button(udid, button).map_err(failed),
    }
}

pub fn idb_installed() -> bool {
    idb_path().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: &str = "4744AA9D-4D49-4B67-80E1-DE8AC68FEDC3";
    const PAD: &str = "408CC8E7-2569-4052-9FA1-D6C1AC7E34C9";

    #[test]
    fn devices_are_ios_and_available_with_the_booted_ones_first() {
        let listed = json!({ "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ "udid": PAD, "name": "iPad Air", "state": "Shutdown", "isAvailable": true }],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
                { "udid": PHONE, "name": "iPhone 17 Pro", "state": "Booted", "isAvailable": true },
                { "udid": "11111111-2222-3333-4444-555555555555", "name": "Gone", "state": "Shutdown", "isAvailable": false },
                { "udid": "not-a-udid", "name": "Odd", "state": "Shutdown" }
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ "udid": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "name": "Watch", "state": "Booted", "isAvailable": true }]
        } });
        let devices = parse_devices(listed.to_string().as_bytes());
        assert_eq!(devices, vec![
            Device { udid: PHONE.into(), name: "iPhone 17 Pro".into(), runtime: "iOS 26.3".into(), booted: true },
            Device { udid: PAD.into(), name: "iPad Air".into(), runtime: "iOS 18.5".into(), booted: false },
        ]);
        assert!(parse_devices(b"not json").is_empty());
    }

    #[test]
    fn only_the_apps_the_person_installed_are_listed() {
        let listed = json!({
            "com.apple.mobilesafari": { "ApplicationType": "System", "CFBundleDisplayName": "Safari" },
            "com.example.zeta": { "ApplicationType": "User", "CFBundleName": "Zeta" },
            "com.example.alpha": { "ApplicationType": "User", "CFBundleDisplayName": "alpha", "CFBundleName": "Ignored" },
            "com.example.bare": { "ApplicationType": "User" },
            "bad id!": { "ApplicationType": "User", "CFBundleName": "Bad" }
        });
        let names: Vec<(String, String)> = parse_apps(&listed).into_iter().map(|app| (app.bundle_id, app.name)).collect();
        assert_eq!(names, vec![("com.example.alpha".into(), "alpha".into()), ("com.example.bare".into(), "com.example.bare".into()), ("com.example.zeta".into(), "Zeta".into())]);
    }

    #[test]
    fn a_point_in_a_scaled_screenshot_lands_on_the_same_place_in_points() {
        let geometry = parse_describe(&json!({ "screen_dimensions": { "width": 1206, "height": 2622, "density": 3.0, "width_points": 402, "height_points": 874 } })).unwrap();
        assert_eq!(scaled(geometry.pixels, 1_280.0), (589, 1280));
        let (x, y) = to_points(&geometry, 1_280.0, 294, 640).unwrap();
        assert!((x - 200.9).abs() < 0.5 && (y - 437.2).abs() < 0.5, "{x} {y}");
        assert_eq!(to_points(&geometry, 1_280.0, 589, 10), None);
        // Points come from the density when idb leaves them out.
        let derived = parse_describe(&json!({ "screen_dimensions": { "width": 1640, "height": 2360, "density": 2.0 } })).unwrap();
        assert_eq!(derived.points, (820.0, 1180.0));
        assert_eq!(parse_describe(&json!({ "screen_dimensions": { "width": 0, "height": 10 } })), None);
        // A small screen is not scaled up.
        assert_eq!(scaled((300.0, 200.0), 1_280.0), (300, 200));
    }

    #[test]
    fn scrolling_down_swipes_up_and_stays_on_the_screen() {
        let geometry = Geometry { points: (402.0, 874.0), pixels: (1206.0, 2622.0) };
        assert_eq!(scroll_swipe(&geometry, (200.0, 400.0), 0, -3), ((200.0, 400.0), (200.0, 280.0)));
        assert_eq!(scroll_swipe(&geometry, (200.0, 100.0), 0, -20), ((200.0, 100.0), (200.0, 1.0)));
        assert_eq!(scroll_swipe(&geometry, (380.0, 400.0), 5, 0), ((380.0, 400.0), (401.0, 400.0)));
    }

    #[test]
    fn keys_text_and_panel_input_are_checked() {
        assert_eq!(hid_key("Return"), Some(40));
        assert_eq!(hid_key("a"), Some(4));
        assert_eq!(hid_key("z"), Some(29));
        assert_eq!(hid_key("1"), Some(30));
        assert_eq!(hid_key("0"), Some(39));
        assert_eq!(hid_key("A"), None);
        assert_eq!(hid_key("F1"), None);
        assert_eq!(text_pieces("hi\nthere\r\n\tyou"), vec![Ok("hi".into()), Err(40), Ok("there".into()), Err(40), Err(43), Ok("you".into())]);
        assert_eq!(parse_input(&json!({ "kind": "tap", "x": 0.5, "y": 0.25 })), Some(Input::Tap { x: 0.5, y: 0.25 }));
        assert_eq!(parse_input(&json!({ "kind": "tap", "x": 1.5, "y": 0.25 })), None);
        assert_eq!(parse_input(&json!({ "kind": "swipe", "x": 0.5, "y": 0.8, "toX": 0.5, "toY": 0.2 })), Some(Input::Swipe { from: (0.5, 0.8), to: (0.5, 0.2) }));
        assert_eq!(parse_input(&json!({ "kind": "button", "button": "home" })), Some(Input::Button("HOME")));
        assert_eq!(parse_input(&json!({ "kind": "button", "button": "APPLE_PAY" })), None);
        assert_eq!(parse_input(&json!({ "kind": "text", "text": "" })), None);
        assert_eq!(parse_input(&json!({ "kind": "key", "key": "Escape" })), Some(Input::Key(41)));
    }

    #[test]
    fn ids_and_addresses_are_checked() {
        assert!(valid_udid(PHONE));
        assert!(!valid_udid("booted"));
        assert!(!valid_udid("4744AA9D-4D49-4B67-80E1-DE8AC68FEDC3; rm"));
        assert!(valid_url("https://example.com/a?b=c"));
        assert!(valid_url("myapp://settings/profile"));
        assert!(!valid_url("https://exa mple.com"));
        assert!(!valid_url("no scheme"));
        assert!(!valid_url("1http://x"));
        assert!(!valid_url("myapp:"));
        assert_eq!(runtime_label("com.apple.CoreSimulator.SimRuntime.iOS-26-3"), Some(("iOS 26.3".into(), vec![26, 3])));
        assert_eq!(runtime_label("com.apple.CoreSimulator.SimRuntime.tvOS-18-0"), None);
        assert_eq!(png_size(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\x04\xb6\0\0\x0a\x3e"), Some((1206.0, 2622.0)));
    }
}
