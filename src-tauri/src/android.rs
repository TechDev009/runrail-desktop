//! Android emulators: the person's emulators in a side-panel tab, on macOS and
//! Linux, and, once the person turns it on, for agents through the computer tools. The SDK's
//! `emulator` lists and starts virtual devices; `adb` captures the screen, sends taps, swipes, text
//! and keys, installs APKs and opens addresses. Only emulators are listed, never a phone plugged in
//! over USB.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{BridgeError, BridgeResult};
use crate::process::{clean, complaint, run, Ran};
use crate::simulator::{scaled, to_points, valid_url, Geometry, Screen, MAX_TEXT};
use crate::store;

const FILE: &str = "android.json";
const MAX_IMAGE_BASE64: usize = 3 * 1024 * 1024;
const QUICK: Duration = Duration::from_secs(20);
/// Installing a large APK on a busy machine.
const SLOW: Duration = Duration::from_secs(180);
/// A cold boot without a snapshot can take minutes.
const BOOT: Duration = Duration::from_secs(300);
/// The ports the emulator console takes; the device is `emulator-<port>`.
const PORTS: std::ops::RangeInclusive<u16> = 5554..=5682;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    /// `adb` was found, in the SDK or on the login PATH.
    pub sdk: bool,
    /// The SDK's `emulator`, which lists and starts virtual devices.
    pub emulator: bool,
    /// The emulator needs KVM on Linux; always true on macOS.
    pub kvm: bool,
    /// The person lets agents use running emulators.
    pub agents: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// The virtual device's name, as `emulator -list-avds` prints it.
    pub avd: String,
    pub name: String,
    /// `emulator-<port>` while it runs.
    pub serial: Option<String>,
    pub booted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidApp {
    pub package: String,
    pub name: String,
}

/// Input from the panel, with places as fractions of the screen so any image size maps the same.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Tap { x: f64, y: f64 },
    Swipe { from: (f64, f64), to: (f64, f64) },
    Text(String),
    Key(u32),
}

// ---------------------------------------------------------------------------------------------
// Whether agents may use emulators

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
            .message("Threads you turn computer use on in can see running Android emulators and tap, swipe, and type in them.\n\nAn emulator can reach the network and uses the apps installed in it. You can turn this off in Settings at any time.")
            .title("Let agents use Android emulators?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
            .blocking_show();
        if !agreed {
            return Err(BridgeError::new("COMPUTER_DECLINED", "The person did not allow emulators.").with_status(403));
        }
    }
    save_agents(on)?;
    Ok(status())
}

fn save_agents(on: bool) -> BridgeResult<()> {
    let unreadable = || BridgeError::new("ANDROID_UNAVAILABLE", "the emulator settings could not be read");
    let settings = SETTINGS.get().ok_or_else(unreadable)?;
    let mut agents = settings.agents.lock().map_err(|_| unreadable())?;
    store::write_atomic(&settings.file, json!({ "version": 1, "agents": on }).to_string().as_bytes())?;
    *agents = on;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The SDK

#[derive(Clone, Debug, PartialEq)]
pub struct Sdk {
    pub adb: PathBuf,
    pub emulator: Option<PathBuf>,
    pub root: Option<PathBuf>,
}

/// Where an SDK may be: the variables Android's tools read, then Android Studio's default folder.
pub fn sdk_roots(env: &dyn Fn(&str) -> Option<OsString>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].iter().filter_map(|name| env(name)).filter(|value| !value.is_empty()).map(PathBuf::from).collect();
    if let Some(home) = home {
        roots.push(home.join(if cfg!(target_os = "macos") { "Library/Android/sdk" } else { "Android/Sdk" }));
    }
    roots
}

pub fn sdk_in(roots: &[PathBuf], on_path: &dyn Fn(&str) -> Option<PathBuf>) -> Option<Sdk> {
    for root in roots {
        let adb = root.join("platform-tools/adb");
        if adb.is_file() {
            let emulator = Some(root.join("emulator/emulator")).filter(|path| path.is_file());
            return Some(Sdk { adb, emulator, root: Some(root.clone()) });
        }
    }
    let adb = on_path("adb")?;
    Some(Sdk { adb, emulator: on_path("emulator"), root: None })
}

pub fn find_sdk() -> Option<Sdk> {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    sdk_in(&sdk_roots(&|name| std::env::var_os(name), home.as_deref()), &crate::engine::find_on_path)
}

fn sdk() -> BridgeResult<Sdk> {
    find_sdk().ok_or_else(|| BridgeError::new("ANDROID_UNAVAILABLE", "the Android SDK is not installed, so there are no emulators").with_status(501))
}

/// The emulator runs only with hardware acceleration, which on Linux is KVM.
fn kvm_ready() -> bool {
    #[cfg(target_os = "linux")]
    {
        let path = c"/dev/kvm";
        // SAFETY: access only reads the path, a valid NUL-terminated string.
        unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

pub fn status() -> Status {
    let found = find_sdk();
    Status { supported: cfg!(any(target_os = "macos", target_os = "linux")), sdk: found.is_some(), emulator: found.as_ref().is_some_and(|sdk| sdk.emulator.is_some()), kvm: kvm_ready(), agents: agents_on() }
}

/// The first `adb` call starts its server, which keeps the output pipes open; starting it first
/// with no pipes keeps every later call from waiting on them.
fn start_server(sdk: &Sdk) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let Ok(mut child) = Command::new(&sdk.adb).arg("start-server").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return };
        let started = Instant::now();
        while started.elapsed() < QUICK {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    });
}

pub fn adb(sdk: &Sdk, serial: Option<&str>, args: &[&str], timeout: Duration) -> BridgeResult<Ran> {
    start_server(sdk);
    let mut command = Command::new(&sdk.adb);
    if let Some(serial) = serial {
        command.args(["-s", serial]);
    }
    command.args(args);
    run(command, None, timeout).map_err(|message| BridgeError::new("ANDROID_FAILED", message))
}

fn adb_ok(sdk: &Sdk, serial: &str, args: &[&str], timeout: Duration, fallback: &str) -> BridgeResult<Ran> {
    let ran = adb(sdk, Some(checked(serial)?), args, timeout)?;
    if ran.ok {
        Ok(ran)
    } else {
        Err(BridgeError::new("ANDROID_FAILED", complaint(&ran.stderr, fallback)))
    }
}

pub fn valid_avd(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.chars().all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-'))
}

pub fn valid_serial(value: &str) -> bool {
    value.strip_prefix("emulator-").is_some_and(|port| port.parse::<u16>().is_ok_and(|port| PORTS.contains(&port)))
}

pub fn valid_package(value: &str) -> bool {
    value.len() <= 255
        && value.split('.').count() >= 2
        && value.split('.').all(|part| part.chars().next().is_some_and(|char| char.is_ascii_alphabetic()) && part.chars().all(|char| char.is_ascii_alphanumeric() || char == '_'))
}

fn checked(serial: &str) -> BridgeResult<&str> {
    if valid_serial(serial) {
        Ok(serial)
    } else {
        Err(BridgeError::new("CONTROL_INVALID_INPUT", "the emulator is invalid"))
    }
}

// ---------------------------------------------------------------------------------------------
// Devices

/// "Pixel_8_API_35" as "Pixel 8 API 35".
pub fn display_name(avd: &str) -> String {
    clean(&avd.replace('_', " "), 100)
}

/// `emulator -list-avds`: one name a line; the tool's own notices are not names.
pub fn parse_avds(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout).lines().map(str::trim).filter(|line| valid_avd(line)).map(str::to_string).collect()
}

/// `adb devices`: the emulators, and whether each is up.
pub fn parse_adb_devices(stdout: &[u8]) -> Vec<(String, bool)> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            let state = parts.next()?;
            valid_serial(serial).then(|| (serial.to_string(), state == "device"))
        })
        .collect()
}

pub fn merge_devices(avds: Vec<String>, running: Vec<(String, bool, Option<String>)>) -> Vec<Device> {
    let mut devices: Vec<Device> = Vec::new();
    for (serial, up, avd) in running {
        let avd = avd.filter(|name| valid_avd(name)).unwrap_or_else(|| serial.clone());
        devices.push(Device { name: display_name(&avd), avd, serial: Some(serial), booted: up });
    }
    for avd in avds {
        if !devices.iter().any(|device| device.avd == avd) {
            devices.push(Device { name: display_name(&avd), avd, serial: None, booted: false });
        }
    }
    devices.sort_by(|a, b| b.serial.is_some().cmp(&a.serial.is_some()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    devices
}

fn running(sdk: &Sdk) -> BridgeResult<Vec<(String, bool, Option<String>)>> {
    let listed = adb(sdk, None, &["devices"], QUICK)?;
    if !listed.ok {
        return Err(BridgeError::new("ANDROID_FAILED", complaint(&listed.stderr, "the emulators could not be listed")));
    }
    Ok(parse_adb_devices(&listed.stdout)
        .into_iter()
        .map(|(serial, up)| {
            // The console answers with the name, then OK.
            let avd = adb(sdk, Some(&serial), &["emu", "avd", "name"], QUICK).ok().filter(|ran| ran.ok).and_then(|ran| String::from_utf8_lossy(&ran.stdout).lines().next().map(|line| line.trim().to_string()));
            (serial, up, avd)
        })
        .collect())
}

pub fn devices() -> BridgeResult<Vec<Device>> {
    let sdk = sdk()?;
    let avds = match &sdk.emulator {
        Some(emulator) => {
            let mut command = Command::new(emulator);
            command.arg("-list-avds");
            run(command, None, QUICK).ok().filter(|ran| ran.ok).map(|ran| parse_avds(&ran.stdout)).unwrap_or_default()
        }
        None => Vec::new(),
    };
    Ok(merge_devices(avds, running(&sdk)?))
}

/// The emulators that are up, found through `adb` alone.
pub fn running_devices() -> BridgeResult<Vec<Device>> {
    let sdk = sdk()?;
    Ok(merge_devices(Vec::new(), running(&sdk)?).into_iter().filter(|device| device.booted).collect())
}

/// A running emulator by its serial, its virtual device's name, or the name shown for it, in any case.
pub fn find_running(named: &str) -> Option<Device> {
    let named = named.trim();
    let running = running_devices().ok()?;
    running
        .iter()
        .find(|device| device.serial.as_deref().is_some_and(|serial| serial.eq_ignore_ascii_case(named)))
        .or_else(|| running.iter().find(|device| device.avd.eq_ignore_ascii_case(named)))
        .or_else(|| running.iter().find(|device| device.name.eq_ignore_ascii_case(named)))
        .cloned()
}

fn free_port(taken: &HashSet<u16>) -> Option<u16> {
    PORTS.step_by(2).find(|port| !taken.contains(port))
}

/// Starts a virtual device in its own window and waits until Android has finished booting.
pub fn boot(avd: &str) -> BridgeResult<String> {
    if !valid_avd(avd) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the emulator is invalid"));
    }
    let sdk = sdk()?;
    let emulator = sdk.emulator.clone().ok_or_else(|| BridgeError::new("ANDROID_UNAVAILABLE", "the Android emulator is not installed; add it in Android Studio's SDK Manager").with_status(501))?;
    if !kvm_ready() {
        return Err(BridgeError::new("ANDROID_UNAVAILABLE", "the emulator needs KVM: /dev/kvm is missing or you are not in its group (often `kvm`)").with_status(501));
    }
    let running = running(&sdk)?;
    if let Some((serial, _, _)) = running.iter().find(|(_, _, name)| name.as_deref() == Some(avd)) {
        return wait_booted(&sdk, serial, None).map(|()| serial.clone());
    }
    let taken: HashSet<u16> = running.iter().filter_map(|(serial, _, _)| serial.strip_prefix("emulator-")?.parse().ok()).collect();
    let port = free_port(&taken).ok_or_else(|| BridgeError::new("ANDROID_FAILED", "too many emulators are running"))?;
    let mut command = Command::new(emulator);
    command.args(["-avd", avd, "-port", &port.to_string()]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so it outlives a restart of Runrail like one started by hand.
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| BridgeError::new("ANDROID_FAILED", "the emulator could not be started"))?;
    // The emulator logs to stdout; the last lines say why when it stops early.
    let log = Arc::new(Mutex::new(Vec::<u8>::new()));
    if let Some(mut stdout) = child.stdout.take() {
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stdout.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                if let Ok(mut log) = log.lock() {
                    log.extend_from_slice(&buffer[..read]);
                    let excess = log.len().saturating_sub(8 * 1024);
                    log.drain(..excess);
                }
            }
        });
    }
    let exited = Arc::new(Mutex::new(None::<bool>));
    {
        let exited = Arc::clone(&exited);
        std::thread::spawn(move || {
            let status = child.wait().map(|status| status.success()).unwrap_or(false);
            if let Ok(mut exited) = exited.lock() {
                *exited = Some(status);
            }
        });
    }
    let serial = format!("emulator-{port}");
    let stopped: &dyn Fn() -> bool = &|| exited.lock().ok().and_then(|exited| *exited).is_some();
    wait_booted(&sdk, &serial, Some(stopped)).map_err(|error| {
        if stopped() {
            let log = log.lock().map(|log| String::from_utf8_lossy(&log).into_owned()).unwrap_or_default();
            let reason = log.lines().rev().map(str::trim).find(|line| line.contains("ERROR") || line.contains("FATAL")).map(|line| clean(line, 300));
            BridgeError::new("ANDROID_FAILED", reason.unwrap_or_else(|| "the emulator stopped while starting".into()))
        } else {
            error
        }
    })?;
    Ok(serial)
}

fn wait_booted(sdk: &Sdk, serial: &str, stopped: Option<&dyn Fn() -> bool>) -> BridgeResult<()> {
    let started = Instant::now();
    while started.elapsed() < BOOT {
        if stopped.is_some_and(|stopped| stopped()) {
            return Err(BridgeError::new("ANDROID_FAILED", "the emulator stopped while starting"));
        }
        let booted = adb(sdk, Some(serial), &["shell", "getprop", "sys.boot_completed"], QUICK).ok().is_some_and(|ran| ran.ok && String::from_utf8_lossy(&ran.stdout).trim() == "1");
        if booted {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Err(BridgeError::new("ANDROID_FAILED", "the emulator did not finish starting in time"))
}

pub fn shutdown(serial: &str) -> BridgeResult<()> {
    let sdk = sdk()?;
    adb_ok(&sdk, serial, &["emu", "kill"], QUICK, "the emulator could not shut down").map(|_| ())
}

// ---------------------------------------------------------------------------------------------
// Apps and addresses

/// `pm list packages -3`: the apps the person installed.
pub fn parse_packages(stdout: &[u8]) -> Vec<AndroidApp> {
    let mut apps: Vec<AndroidApp> = String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .filter(|package| valid_package(package))
        .map(|package| AndroidApp { package: package.to_string(), name: package.to_string() })
        .collect();
    apps.sort_by(|a, b| a.package.cmp(&b.package));
    apps
}

pub fn apps(serial: &str) -> BridgeResult<Vec<AndroidApp>> {
    let sdk = sdk()?;
    let listed = adb_ok(&sdk, serial, &["shell", "pm", "list", "packages", "-3"], QUICK, "the apps could not be listed")?;
    Ok(parse_packages(&listed.stdout))
}

pub fn launch(serial: &str, package: &str) -> BridgeResult<()> {
    if !valid_package(package) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the app is invalid"));
    }
    let sdk = sdk()?;
    let ran = adb_ok(&sdk, serial, &["shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"], QUICK, "the app could not be opened")?;
    // monkey exits 0 even when the package has no launcher activity.
    if String::from_utf8_lossy(&ran.stdout).contains("No activities found") {
        return Err(BridgeError::new("ANDROID_FAILED", "the app has nothing to open"));
    }
    Ok(())
}

/// One argument for the device's shell, which joins `adb shell`'s arguments and parses them again.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub fn open_url(serial: &str, url: &str) -> BridgeResult<()> {
    if !valid_url(url) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the address is invalid"));
    }
    let sdk = sdk()?;
    let quoted = shell_quote(url);
    adb_ok(&sdk, serial, &["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", &quoted], QUICK, "the address could not be opened").map(|_| ())
}

/// The newest `aapt2` in the SDK's build tools, which names an APK's package.
fn aapt2(sdk: &Sdk) -> Option<PathBuf> {
    let tools = sdk.root.as_ref()?.join("build-tools");
    let mut versions: Vec<(Vec<u32>, PathBuf)> = std::fs::read_dir(tools)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version: Vec<u32> = name.split(['.', '-']).filter_map(|part| part.parse().ok()).collect();
            let aapt2 = entry.path().join("aapt2");
            aapt2.is_file().then_some((version, aapt2))
        })
        .collect();
    versions.sort();
    versions.pop().map(|(_, path)| path)
}

/// Installs an APK the person picks in the system's file dialog, so the page never names a path.
pub fn install(app: &tauri::AppHandle, serial: &str) -> BridgeResult<Option<AndroidApp>> {
    use tauri_plugin_dialog::DialogExt;
    let serial = checked(serial)?.to_string();
    let Some(picked) = app.dialog().file().set_title("Install an app in the emulator").add_filter("Android app", &["apk"]).blocking_pick_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|_| BridgeError::new("CONTROL_INVALID_INPUT", "the app is invalid"))?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("apk") || !path.is_file() {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "pick an .apk"));
    }
    let sdk = sdk()?;
    let before: HashSet<String> = apps(&serial)?.into_iter().map(|app| app.package).collect();
    let path_text = path.to_string_lossy().into_owned();
    adb_ok(&sdk, &serial, &["install", "-r", "-t", &path_text], SLOW, "the app could not be installed")?;
    let named = aapt2(&sdk).and_then(|aapt2| {
        let mut command = Command::new(aapt2);
        command.args(["dump", "packagename"]).arg(&path);
        let ran = run(command, None, QUICK).ok().filter(|ran| ran.ok)?;
        Some(String::from_utf8_lossy(&ran.stdout).trim().to_string()).filter(|package| valid_package(package))
    });
    let package = named.or_else(|| {
        let added: Vec<String> = apps(&serial).ok()?.into_iter().map(|app| app.package).filter(|package| !before.contains(package)).collect();
        (added.len() == 1).then(|| added[0].clone())
    });
    let file = path.file_stem().map(|stem| clean(&stem.to_string_lossy(), 100)).unwrap_or_default();
    Ok(Some(match package {
        Some(package) => AndroidApp { name: package.clone(), package },
        // Reinstalled over itself with no aapt2 to name it: installed, but nothing to open.
        None => AndroidApp { package: String::new(), name: file },
    }))
}

// ---------------------------------------------------------------------------------------------
// Screens and input

fn sizes() -> &'static Mutex<HashMap<String, (f64, f64)>> {
    static SIZES: OnceLock<Mutex<HashMap<String, (f64, f64)>>> = OnceLock::new();
    SIZES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The screen as a JPEG whose longer side is at most `max_side` pixels. Its full size is kept,
/// since input takes pixels as the screen is turned now.
pub fn screenshot(serial: &str, max_side: u32) -> BridgeResult<Screen> {
    let sdk = sdk()?;
    let ran = adb(&sdk, Some(checked(serial)?), &["exec-out", "screencap", "-p"], QUICK)?;
    if !ran.ok || ran.stdout.is_empty() {
        return Err(BridgeError::new("ANDROID_FAILED", complaint(&ran.stderr, "the emulator is not running")));
    }
    let screen = encode(&ran.stdout, max_side)?;
    if let (Ok(mut sizes), Some(size)) = (sizes().lock(), png_size(&ran.stdout)) {
        sizes.insert(serial.to_string(), size);
    }
    Ok(screen)
}

pub fn png_size(bytes: &[u8]) -> Option<(f64, f64)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let read = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    Some((f64::from(read(16)), f64::from(read(20))))
}

pub fn encode(png: &[u8], max_side: u32) -> BridgeResult<Screen> {
    use base64::Engine;
    let failed = || BridgeError::new("ANDROID_FAILED", "the screen could not be captured");
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|_| failed())?;
    let (width, height) = scaled((f64::from(image.width()), f64::from(image.height())), f64::from(max_side));
    let resized = if (width, height) == (image.width(), image.height()) { image } else { image.resize_exact(width, height, image::imageops::FilterType::Triangle) };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70).encode_image(&resized.to_rgb8()).map_err(|_| failed())?;
    let data = base64::engine::general_purpose::STANDARD.encode(jpeg);
    if data.len() > MAX_IMAGE_BASE64 {
        return Err(BridgeError::new("ANDROID_FAILED", "the screen is too large to capture"));
    }
    Ok(Screen { media_type: "image/jpeg", data_base64: data, width, height })
}

/// The screen's size in pixels, from the last capture or a new one.
pub fn size(serial: &str) -> BridgeResult<(f64, f64)> {
    if let Some(known) = sizes().lock().ok().and_then(|sizes| sizes.get(serial).copied()) {
        return Ok(known);
    }
    screenshot(serial, 64)?;
    sizes().lock().ok().and_then(|sizes| sizes.get(serial).copied()).ok_or_else(|| BridgeError::new("ANDROID_FAILED", "the screen size is unknown"))
}

/// A point in a capture scaled to `max_side`, in the screen's pixels, which input takes; none
/// outside it.
pub fn to_pixels(size: (f64, f64), max_side: f64, x: u32, y: u32) -> Option<(f64, f64)> {
    to_points(&Geometry { points: size, pixels: size }, max_side, x, y)
}

/// A swipe that moves the content `dx` and `dy` steps from a point, kept on the screen. A step is a
/// twentieth of the longer side, about what one moves on an iOS simulator.
pub fn scroll_swipe(size: (f64, f64), from: (f64, f64), dx: i32, dy: i32) -> ((f64, f64), (f64, f64)) {
    let step = size.0.max(size.1) / 20.0;
    // Content moves the way the finger does, so seeing further down means swiping up.
    let to = (from.0 + f64::from(dx) * step, from.1 + f64::from(dy) * step);
    (from, (to.0.clamp(1.0, size.0 - 1.0), to.1.clamp(1.0, size.1 - 1.0)))
}

/// An Android key code, which `input keyevent` takes.
pub fn key_code(key: &str) -> Option<u32> {
    Some(match key {
        "Return" | "Enter" => 66,
        "Backspace" => 67,
        "Delete" => 112,
        "Tab" => 61,
        "Escape" => 111,
        "Space" => 62,
        "ArrowUp" => 19,
        "ArrowDown" => 20,
        "ArrowLeft" => 21,
        "ArrowRight" => 22,
        "PageUp" => 92,
        "PageDown" => 93,
        "End" => 123,
        "Back" => 4,
        "Home" => 3,
        "Recents" => 187,
        "Power" => 26,
        _ => return None,
    })
}

/// The key code an agent's key presses. Escape goes back, since Android apps close and go back on
/// Back and few heed Escape.
pub fn agent_key(key: &str) -> Option<u32> {
    if key == "Escape" {
        Some(4)
    } else {
        key_code(key)
    }
}

/// Typed text in pieces for `input text`, which reads `%s` as a space and takes ASCII only: runs
/// of characters, and the keys for a new line and a tab.
pub fn text_pieces(text: &str) -> Result<Vec<Result<String, u32>>, String> {
    let mut pieces: Vec<Result<String, u32>> = Vec::new();
    let mut run = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (at, char) in chars.iter().enumerate() {
        match char {
            '\r' => continue,
            '\n' | '\t' => {
                if !run.is_empty() {
                    pieces.push(Ok(std::mem::take(&mut run)));
                }
                pieces.push(Err(if *char == '\n' { 66 } else { 61 }));
            }
            ' ' => run.push_str("%s"),
            char if char.is_ascii_graphic() => {
                run.push(*char);
                // A typed "%s" would come out as a space; the next piece starts with the s.
                if *char == '%' && chars.get(at + 1) == Some(&'s') {
                    pieces.push(Ok(std::mem::take(&mut run)));
                }
            }
            _ => return Err("the emulator's input types ASCII only; paste other text in the emulator".into()),
        }
    }
    if !run.is_empty() {
        pieces.push(Ok(run));
    }
    Ok(pieces)
}

fn pixel(value: f64) -> String {
    format!("{}", value.round().max(0.0) as u32)
}

pub fn tap(serial: &str, point: (f64, f64)) -> BridgeResult<()> {
    let sdk = sdk()?;
    adb_ok(&sdk, serial, &["shell", "input", "tap", &pixel(point.0), &pixel(point.1)], QUICK, "the tap did not reach the emulator").map(|_| ())
}

pub fn swipe(serial: &str, from: (f64, f64), to: (f64, f64)) -> BridgeResult<()> {
    let sdk = sdk()?;
    adb_ok(&sdk, serial, &["shell", "input", "swipe", &pixel(from.0), &pixel(from.1), &pixel(to.0), &pixel(to.1), "300"], QUICK, "the swipe did not reach the emulator").map(|_| ())
}

pub fn press_key(serial: &str, code: u32) -> BridgeResult<()> {
    let sdk = sdk()?;
    adb_ok(&sdk, serial, &["shell", "input", "keyevent", &code.to_string()], QUICK, "the key did not reach the emulator").map(|_| ())
}

pub fn type_text(serial: &str, text: &str) -> BridgeResult<()> {
    let pieces = text_pieces(text).map_err(|message| BridgeError::new("ANDROID_FAILED", message))?;
    let sdk = sdk()?;
    for piece in pieces {
        match piece {
            Ok(run) => adb_ok(&sdk, serial, &["shell", "input", "text", &shell_quote(&run)], QUICK, "the text did not reach the emulator")?,
            Err(code) => adb_ok(&sdk, serial, &["shell", "input", "keyevent", &code.to_string()], QUICK, "the key did not reach the emulator")?,
        };
    }
    Ok(())
}

pub fn parse_input(value: &Value) -> Option<Input> {
    let fraction = |name: &str| value[name].as_f64().filter(|number| (0.0..=1.0).contains(number));
    match value["kind"].as_str()? {
        "tap" => Some(Input::Tap { x: fraction("x")?, y: fraction("y")? }),
        "swipe" => Some(Input::Swipe { from: (fraction("x")?, fraction("y")?), to: (fraction("toX")?, fraction("toY")?) }),
        "text" => value["text"].as_str().filter(|text| !text.is_empty() && text.chars().count() <= MAX_TEXT).map(|text| Input::Text(text.to_string())),
        "key" => value["key"].as_str().and_then(key_code).map(Input::Key),
        "button" => match value["button"].as_str()? {
            "back" => Some(Input::Key(4)),
            "home" => Some(Input::Key(3)),
            "recents" => Some(Input::Key(187)),
            "power" => Some(Input::Key(26)),
            _ => None,
        },
        _ => None,
    }
}

/// One input from the panel.
pub fn input(serial: &str, input: &Input) -> BridgeResult<()> {
    let serial = checked(serial)?;
    match input {
        Input::Tap { x, y } => {
            let size = size(serial)?;
            tap(serial, (x * size.0, y * size.1))
        }
        Input::Swipe { from, to } => {
            let size = size(serial)?;
            swipe(serial, (from.0 * size.0, from.1 * size.1), (to.0 * size.0, to.1 * size.1))
        }
        Input::Text(text) => type_text(serial, text),
        Input::Key(code) => press_key(serial, *code),
    }
}

/// The SDK's tools faked by scripts that answer as `adb` and `emulator` do and log what they are
/// asked, so the commands, their quoting and the capture run on any Unix without Android. The SDK
/// is found through `ANDROID_HOME`, so tests that fake one take turns.
#[cfg(all(test, unix))]
pub struct FakeSdk {
    root: PathBuf,
    _turn: std::sync::MutexGuard<'static, ()>,
}

#[cfg(all(test, unix))]
impl FakeSdk {
    /// `running` names the emulators that are up, by serial and virtual device; every screen is
    /// `screen` pixels.
    pub fn new(name: &str, running: &[(&str, &str)], screen: (u32, u32)) -> FakeSdk {
        use std::os::unix::fs::PermissionsExt;
        static TURN: Mutex<()> = Mutex::new(());
        let turn = TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = std::env::temp_dir().join(format!("runrail-fake-sdk-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("platform-tools")).unwrap();
        std::fs::create_dir_all(root.join("emulator")).unwrap();
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(screen.0, screen.1, image::Rgb([0, 0, 0]))).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        std::fs::write(root.join("screen.png"), png).unwrap();
        std::fs::write(root.join("devices"), running.iter().map(|(serial, _)| format!("{serial}\tdevice\n")).collect::<String>()).unwrap();
        for (serial, avd) in running {
            std::fs::write(root.join(format!("avd-{serial}")), avd).unwrap();
        }
        let script = |body: &str| format!("#!/bin/sh\nroot='{}'\n{body}", root.display());
        std::fs::write(root.join("emulator/emulator"), script(r#"[ "$1" = -list-avds ] && printf 'Pixel_Test\nOther_AVD\n'"#)).unwrap();
        let adb = r#"printf '%s|' "$@" >> "$root/log"; echo >> "$root/log"
[ "$1" = devices ] && { printf 'List of devices attached\n'; cat "$root/devices"; echo; exit 0; }
[ "$1" = -s ] || exit 0
serial=$2
shift 2
case "$*" in
  'emu avd name') printf '%s\r\nOK\r\n' "$(cat "$root/avd-$serial")" ;;
  'exec-out screencap -p') cat "$root/screen.png" ;;
  'shell pm list packages -3') printf 'package:com.example.app\n' ;;
  'shell monkey -p com.example.none'*) echo '** No activities found to run, monkey aborted.' ;;
esac
"#;
        std::fs::write(root.join("platform-tools/adb"), script(adb)).unwrap();
        for tool in ["emulator/emulator", "platform-tools/adb"] {
            std::fs::set_permissions(root.join(tool), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("ANDROID_HOME", &root);
        // A size kept from another test's screen would place taps by it.
        sizes().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
        FakeSdk { root, _turn: turn }
    }

    /// What `adb` was asked, a call a line, each argument followed by `|`.
    pub fn asked(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.join("log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    /// Lets agents use emulators for the rest of the test run.
    pub fn allow_agents(&self) {
        if agents_on() {
            return;
        }
        let data = self.root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        init(&data);
        save_agents(true).unwrap();
    }
}

#[cfg(all(test, unix))]
impl Drop for FakeSdk {
    fn drop(&mut self) {
        std::env::remove_var("ANDROID_HOME");
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_sdk_is_found_from_the_variables_then_android_studios_folder_then_path() {
        let root = std::env::temp_dir().join(format!("runrail-android-sdk-{}", std::process::id()));
        let studio = root.join("home").join(if cfg!(target_os = "macos") { "Library/Android/sdk" } else { "Android/Sdk" });
        std::fs::create_dir_all(studio.join("platform-tools")).unwrap();
        std::fs::create_dir_all(studio.join("emulator")).unwrap();
        std::fs::write(studio.join("platform-tools/adb"), "").unwrap();
        std::fs::write(studio.join("emulator/emulator"), "").unwrap();
        let unset = root.join("unset");
        let env = |name: &str| (name == "ANDROID_HOME").then(|| unset.clone().into_os_string());
        let roots = sdk_roots(&env, Some(&root.join("home")));
        assert_eq!(roots, vec![unset.clone(), studio.clone()]);
        let found = sdk_in(&roots, &|_| None).unwrap();
        assert_eq!(found, Sdk { adb: studio.join("platform-tools/adb"), emulator: Some(studio.join("emulator/emulator")), root: Some(studio.clone()) });
        let on_path = sdk_in(&[unset], &|name| (name == "adb").then(|| PathBuf::from("/usr/bin/adb"))).unwrap();
        assert_eq!(on_path, Sdk { adb: "/usr/bin/adb".into(), emulator: None, root: None });
        assert_eq!(sdk_in(&[], &|_| None), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn devices_are_emulators_with_the_running_ones_first() {
        let avds = parse_avds(b"INFO    | Storing crashdata in: /tmp/android/emu-crash.db\nPixel_8_API_35\nTablet_API_34\n");
        assert_eq!(avds, vec!["Pixel_8_API_35".to_string(), "Tablet_API_34".to_string()]);
        let listed = parse_adb_devices(b"List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M12ABCDE\tdevice\n\n");
        assert_eq!(listed, vec![("emulator-5554".to_string(), true), ("emulator-5556".to_string(), false)]);
        let devices = merge_devices(avds, vec![("emulator-5556".into(), false, None), ("emulator-5554".into(), true, Some("Tablet_API_34".into()))]);
        assert_eq!(devices, vec![
            Device { avd: "emulator-5556".into(), name: "emulator-5556".into(), serial: Some("emulator-5556".into()), booted: false },
            Device { avd: "Tablet_API_34".into(), name: "Tablet API 34".into(), serial: Some("emulator-5554".into()), booted: true },
            Device { avd: "Pixel_8_API_35".into(), name: "Pixel 8 API 35".into(), serial: None, booted: false },
        ]);
        assert_eq!(free_port(&HashSet::from([5554, 5556])), Some(5558));
    }

    #[test]
    fn ids_packages_and_addresses_are_checked() {
        assert!(valid_serial("emulator-5554"));
        assert!(!valid_serial("emulator-80"));
        assert!(!valid_serial("R58M12ABCDE"));
        assert!(!valid_serial("emulator-5554; reboot"));
        assert!(valid_avd("Pixel_8_API_35"));
        assert!(!valid_avd("Pixel 8"));
        assert!(!valid_avd("a;b"));
        assert!(valid_package("com.example.app_1"));
        assert!(!valid_package("example"));
        assert!(!valid_package("com.1example"));
        assert!(!valid_package("com.example;rm"));
        assert_eq!(parse_packages(b"package:com.zeta\npackage:com.alpha.app\npackage:bad\n").into_iter().map(|app| app.package).collect::<Vec<_>>(), vec!["com.alpha.app".to_string(), "com.zeta".to_string()]);
        assert_eq!(shell_quote("https://x.test/?a='b'&c=$(id)"), "'https://x.test/?a='\\''b'\\''&c=$(id)'");
    }

    #[test]
    fn typed_text_becomes_pieces_input_can_take() {
        assert_eq!(text_pieces("hi there\nyou\t!").unwrap(), vec![Ok("hi%sthere".into()), Err(66), Ok("you".into()), Err(61), Ok("!".into())]);
        assert_eq!(text_pieces("100%sure").unwrap(), vec![Ok("100%".into()), Ok("sure".into())]);
        assert!(text_pieces("café").is_err());
        assert_eq!(parse_input(&json!({ "kind": "tap", "x": 0.5, "y": 0.25 })), Some(Input::Tap { x: 0.5, y: 0.25 }));
        assert_eq!(parse_input(&json!({ "kind": "tap", "x": -0.1, "y": 0.25 })), None);
        assert_eq!(parse_input(&json!({ "kind": "button", "button": "back" })), Some(Input::Key(4)));
        assert_eq!(parse_input(&json!({ "kind": "button", "button": "siri" })), None);
        assert_eq!(parse_input(&json!({ "kind": "key", "key": "Return" })), Some(Input::Key(66)));
        assert_eq!(parse_input(&json!({ "kind": "key", "key": "F13" })), None);
    }

    #[test]
    fn a_point_in_a_scaled_capture_lands_on_the_screens_pixels_and_scrolls_stay_on_it() {
        assert_eq!(scaled((1080.0, 2400.0), 1_280.0), (576, 1280));
        let (x, y) = to_pixels((1080.0, 2400.0), 1_280.0, 288, 640).unwrap();
        assert!((x - 540.9).abs() < 0.1 && (y - 1200.9).abs() < 0.1, "{x} {y}");
        assert_eq!(to_pixels((1080.0, 2400.0), 1_280.0, 576, 10), None);
        assert_eq!(to_pixels((1080.0, 2400.0), 1_280.0, 10, 1280), None);
        // Down swipes up by a twentieth of the longer side a step; right swipes left.
        assert_eq!(scroll_swipe((1080.0, 2400.0), (540.0, 1200.0), 0, -3), ((540.0, 1200.0), (540.0, 840.0)));
        assert_eq!(scroll_swipe((1080.0, 2400.0), (540.0, 1200.0), -2, 0), ((540.0, 1200.0), (300.0, 1200.0)));
        assert_eq!(scroll_swipe((1080.0, 2400.0), (540.0, 100.0), 0, -20), ((540.0, 100.0), (540.0, 1.0)));
    }

    #[test]
    fn an_agents_keys_map_to_android_key_codes() {
        let keys = ["Return", "Enter", "Backspace", "Tab", "Escape", "Home", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "F5", "a"];
        assert_eq!(keys.map(agent_key), [Some(66), Some(66), Some(67), Some(61), Some(4), Some(3), Some(19), Some(20), Some(21), Some(22), Some(62), None, None]);
        assert_eq!(key_code("Escape"), Some(111));
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_sdk_is_driven_through_adb() {
        let sdk = FakeSdk::new("panel", &[("emulator-5554", "Pixel_Test")], (1080, 2400));
        assert!(status().sdk && status().emulator);
        assert_eq!(devices().unwrap(), vec![
            Device { avd: "Pixel_Test".into(), name: "Pixel Test".into(), serial: Some("emulator-5554".into()), booted: true },
            Device { avd: "Other_AVD".into(), name: "Other AVD".into(), serial: None, booted: false },
        ]);
        let screen = screenshot("emulator-5554", 1_100).unwrap();
        assert_eq!((screen.width, screen.height), (495, 1100));
        input("emulator-5554", &Input::Tap { x: 0.5, y: 0.25 }).unwrap();
        input("emulator-5554", &Input::Swipe { from: (0.5, 0.8), to: (0.5, 0.2) }).unwrap();
        input("emulator-5554", &Input::Text("it's 100%sure\n".into())).unwrap();
        input("emulator-5554", &Input::Key(4)).unwrap();
        open_url("emulator-5554", "myapp://open?x='1'").unwrap();
        assert_eq!(apps("emulator-5554").unwrap(), vec![AndroidApp { package: "com.example.app".into(), name: "com.example.app".into() }]);
        launch("emulator-5554", "com.example.app").unwrap();
        assert_eq!(launch("emulator-5554", "com.example.none").unwrap_err().message, "the app has nothing to open");
        shutdown("emulator-5554").unwrap();
        assert_eq!(input("R58M12ABCDE", &Input::Key(4)).unwrap_err().code, "CONTROL_INVALID_INPUT");
        let asked: Vec<String> = sdk.asked().into_iter().filter(|line| line.starts_with("-s|emulator-5554|shell|") || line.contains("|emu|kill|")).collect();
        assert_eq!(asked, vec![
            "-s|emulator-5554|shell|input|tap|540|600|",
            "-s|emulator-5554|shell|input|swipe|540|1920|540|480|300|",
            r"-s|emulator-5554|shell|input|text|'it'\''s%s100%'|",
            "-s|emulator-5554|shell|input|text|'sure'|",
            "-s|emulator-5554|shell|input|keyevent|66|",
            "-s|emulator-5554|shell|input|keyevent|4|",
            r"-s|emulator-5554|shell|am|start|-a|android.intent.action.VIEW|-d|'myapp://open?x='\''1'\'''|",
            "-s|emulator-5554|shell|pm|list|packages|-3|",
            "-s|emulator-5554|shell|monkey|-p|com.example.app|-c|android.intent.category.LAUNCHER|1|",
            "-s|emulator-5554|shell|monkey|-p|com.example.none|-c|android.intent.category.LAUNCHER|1|",
            "-s|emulator-5554|emu|kill|",
        ]);
    }

    /// Against the person's own SDK: `cargo test -- --ignored a_real_emulator`. Starts the first
    /// virtual device (or `RUNRAIL_TEST_AVD`) in its window and shuts it down at the end.
    #[test]
    #[ignore = "starts a real Android emulator"]
    fn a_real_emulator_starts_shows_and_takes_input() {
        let listed = devices().unwrap();
        let avd = std::env::var("RUNRAIL_TEST_AVD").ok().or_else(|| listed.first().map(|device| device.avd.clone())).expect("no virtual device");
        let serial = boot(&avd).unwrap();
        assert!(devices().unwrap().iter().any(|device| device.avd == avd && device.booted && device.serial.as_deref() == Some(serial.as_str())));
        let screen = screenshot(&serial, 1_100).unwrap();
        assert!(screen.width.max(screen.height) <= 1_100 && screen.data_base64.len() > 1_000);
        input(&serial, &Input::Key(3)).unwrap();
        input(&serial, &Input::Swipe { from: (0.5, 0.85), to: (0.5, 0.3) }).unwrap();
        input(&serial, &Input::Key(3)).unwrap();
        input(&serial, &Input::Tap { x: 0.5, y: 0.5 }).unwrap();
        assert_eq!(open_url(&serial, "https://example.com/?q='a b'").unwrap_err().code, "CONTROL_INVALID_INPUT");
        // An image without a browser cannot open it, and says so.
        if let Err(error) = open_url(&serial, "https://example.com/?q='ab'") {
            assert!(error.message.contains("unable to resolve Intent"), "{}", error.message);
        }
        type_text(&serial, "it's 100%sure").unwrap();
        assert!(apps(&serial).is_ok());
        shutdown(&serial).unwrap();
    }

    /// Against the person's own SDK, as an agent would: `cargo test -- --ignored an_agent_uses`.
    /// Starts the first virtual device (or `RUNRAIL_TEST_AVD`), lets agents use emulators, opens
    /// Settings and taps its Display row through the computer tools, and shuts the device down at
    /// the end.
    #[test]
    #[ignore = "starts a real Android emulator"]
    fn an_agent_uses_a_real_emulator_through_the_computer_tools() {
        struct Running(String);
        impl Drop for Running {
            fn drop(&mut self) {
                let _ = shutdown(&self.0);
            }
        }
        let listed = devices().unwrap();
        let avd = std::env::var("RUNRAIL_TEST_AVD").ok().or_else(|| listed.first().map(|device| device.avd.clone())).expect("no virtual device");
        let running = Running(boot(&avd).unwrap());
        let serial = running.0.clone();
        let sdk = sdk().unwrap();
        // A quick-boot snapshot can say booted while Android is still starting again.
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(120) && adb(&sdk, Some(&serial), &["shell", "getprop", "init.svc.bootanim"], QUICK).map(|ran| String::from_utf8_lossy(&ran.stdout).trim() != "stopped").unwrap_or(true) {
            std::thread::sleep(Duration::from_secs(1));
        }
        let data = std::env::temp_dir().join(format!("runrail-android-agents-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        init(&data);
        save_agents(true).unwrap();
        let act = |action: &str, params: Value| {
            let answer = crate::computer::act("com.runrail.test", action, &params);
            assert_eq!(answer["ok"], true, "{action}: {answer}");
            answer["result"]["text"].as_str().unwrap_or_default().to_string()
        };
        assert!(act("apps", json!({})).contains(&format!("({serial})")));
        act("key", json!({ "app": avd, "key": "Home" }));
        // Back closes a notification shade a snapshot may have kept open; Settings starts on its
        // first page rather than the one it was left on.
        act("key", json!({ "app": avd, "key": "Escape" }));
        adb(&sdk, Some(&serial), &["shell", "am", "force-stop", "com.android.settings"], QUICK).unwrap();
        launch(&serial, "com.android.settings").unwrap();
        std::thread::sleep(Duration::from_secs(2));
        // Where a label starting so is on the screen, in pixels, from the view hierarchy Android
        // dumps; shared storage may not be mounted yet, so the dump goes to the shell's own folder.
        let find = |label: &str| -> Option<(f64, f64)> {
            adb(&sdk, Some(&serial), &["shell", "uiautomator", "dump", "/data/local/tmp/runrail-ui.xml"], QUICK).ok()?;
            let dumped = adb(&sdk, Some(&serial), &["shell", "cat", "/data/local/tmp/runrail-ui.xml"], QUICK).ok()?;
            let xml = String::from_utf8_lossy(&dumped.stdout).into_owned();
            let node = &xml[xml.find(&format!("text=\"{label}"))?..];
            let bounds = &node[node.find("bounds=\"[")? + 9..];
            let numbers: Vec<f64> = bounds[..bounds.find('"')?].split(|char: char| !char.is_ascii_digit()).filter(|part| !part.is_empty()).filter_map(|part| part.parse().ok()).collect();
            (numbers.len() == 4).then(|| ((numbers[0] + numbers[2]) / 2.0, (numbers[1] + numbers[3]) / 2.0))
        };
        let shown = act("screenshot", json!({ "app": serial }));
        assert!(shown.contains("Android emulator"), "{shown}");
        let mut display = find("Display");
        for _ in 0..4 {
            if display.is_some_and(|point| point.1 < size(&serial).unwrap().1 * 0.85) {
                break;
            }
            let (width, height) = scaled(size(&serial).unwrap(), 1_280.0);
            act("scroll", json!({ "app": serial, "x": width / 2, "y": height / 2, "direction": "down" }));
            display = find("Display");
        }
        let display = display.expect("Settings shows no Display row");
        let pixels = size(&serial).unwrap();
        let (width, height) = scaled(pixels, 1_280.0);
        let (x, y) = ((display.0 / pixels.0 * f64::from(width)) as u32, (display.1 / pixels.1 * f64::from(height)) as u32);
        assert!(act("click", json!({ "app": avd, "x": x, "y": y })).starts_with(&format!("Tapped at {x}, {y}")));
        std::thread::sleep(Duration::from_secs(1));
        assert!(find("Brightness level").or_else(|| find("Dark theme")).is_some(), "the tap did not open Display");
        act("key", json!({ "app": serial, "key": "Escape" }));
        let refused = crate::computer::act("com.runrail.test", "type", &json!({ "app": serial, "text": "café" }));
        assert_eq!(refused["ok"], false);
        drop(running);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_capture_is_scaled_into_a_jpeg() {
        let mut png = Vec::new();
        let image = image::RgbImage::from_pixel(1080, 2400, image::Rgb([20, 120, 220]));
        image::DynamicImage::ImageRgb8(image).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        assert_eq!(png_size(&png), Some((1080.0, 2400.0)));
        let screen = encode(&png, 1_100).unwrap();
        assert_eq!((screen.media_type, screen.width, screen.height), ("image/jpeg", 495, 1100));
        assert!(encode(b"not a png", 1_100).is_err());
    }
}
