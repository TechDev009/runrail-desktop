//! Computer use on Linux. In an X11 session the X server lists, captures, and
//! raises an allowed app's windows and takes the input, with the same allow list as on macOS. An
//! app is known by its WM_CLASS class, or its program's name when it sets none; it is refused when
//! any of its names is on the lists below. On Wayland the desktop's portal does it for the one
//! window the person shares (`portal.rs`).

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use serde_json::Value;

use super::{allowed, describe, find_allowed, never, parse_action, refuse, scale, to_screen, type_pieces, valid_bundle_id, Access, Action, AllowedApp, FrontWindow, Rect, Refusal, RunningApp, Window, MAX_IMAGE_BASE64};

mod frames;
mod portal;
mod x11;

pub use portal::SHARED_ID as SHARED_WINDOW;

use x11::{Client, X11};

/// Password managers and keyrings, their prompts, and the settings apps, by WM_CLASS, GTK
/// application id, or program name.
pub const SECRET_HOLDERS: &[&str] = &[
    "seahorse",
    "org.gnome.seahorse.Application",
    "gcr-prompter",
    "gcr-viewer",
    "kwalletmanager",
    "kwalletmanager5",
    "org.kde.kwalletmanager5",
    "kwalletd5",
    "kwalletd6",
    "keepassxc",
    "org.keepassxc.KeePassXC",
    "keepass2",
    "1password",
    "bitwarden",
    "pinentry",
    "pinentry-gnome3",
    "pinentry-gtk-2",
    "pinentry-qt",
    "polkit-gnome-authentication-agent-1",
    "polkit-kde-authentication-agent-1",
    "polkit-mate-authentication-agent-1",
    "lxpolkit",
    "gnome-control-center",
    "org.gnome.Settings",
    "systemsettings",
    "systemsettings5",
    "org.kde.systemsettings",
    "xfce4-settings-manager",
    "cinnamon-settings",
    "mate-control-center",
    "lxqt-config",
];

/// Terminals, which would run commands without Runrail's approvals.
pub const NEVER: &[&str] = &[
    "gnome-terminal",
    "gnome-terminal-server",
    "org.gnome.Terminal",
    "kgx",
    "org.gnome.Console",
    "ptyxis",
    "org.gnome.Ptyxis",
    "konsole",
    "org.kde.konsole",
    "yakuake",
    "xterm",
    "uxterm",
    "urxvt",
    "rxvt",
    "xfce4-terminal",
    "lxterminal",
    "qterminal",
    "mate-terminal",
    "tilix",
    "com.gexperts.Tilix",
    "terminator",
    "alacritty",
    "kitty",
    "wezterm",
    "wezterm-gui",
    "org.wezfurlong.wezterm",
    "ghostty",
    "foot",
    "footclient",
    "st",
    "st-256color",
    "terminology",
    "guake",
    "tilda",
    "sakura",
    "cool-retro-term",
    "deepin-terminal",
    "blackbox",
    "com.raggesilver.BlackBox",
    "warp",
    "dev.warp.Warp",
    "tabby",
    "hyper",
    "contour",
    "rio",
    "cosmic-term",
    "com.system76.CosmicTerm",
    "io.elementary.terminal",
    "x-terminal-emulator",
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Session {
    X11,
    Wayland,
    Neither,
}

pub fn session() -> Session {
    session_from(std::env::var("XDG_SESSION_TYPE").ok().as_deref(), std::env::var_os("WAYLAND_DISPLAY").is_some(), std::env::var_os("DISPLAY").is_some())
}

/// Wayland wins when both are around: X11 there reaches only the apps that run through XWayland.
fn session_from(kind: Option<&str>, wayland: bool, display: bool) -> Session {
    match kind {
        Some("wayland") => Session::Wayland,
        Some("x11") if display => Session::X11,
        _ if wayland => Session::Wayland,
        _ if display => Session::X11,
        _ => Session::Neither,
    }
}

fn off(reason: &str) -> Access {
    Access { reason: Some(reason.into()), ..Access::default() }
}

const NO_DISPLAY: &str = "Runrail found no desktop session to use apps in: neither X11 nor Wayland is running here.";
const NO_X_SERVER: &str = "Runrail cannot reach the X server named by DISPLAY.";
const PORTAL_MISSING: &str = "Agents use apps on Wayland through a portal that shares one window and takes input for it, and PipeWire to see it: xdg-desktop-portal with the GNOME or KDE backend. This desktop lacks one of them.";

pub fn access() -> Access {
    match session() {
        Session::X11 => match X11::connect() {
            Some(x11) => Access { supported: true, screen: true, accessibility: x11.xtest, session: Some("x11"), ..Access::default() },
            None => Access { session: Some("x11"), ..off(NO_X_SERVER) },
        },
        Session::Wayland => match portal::state() {
            portal::State::Missing => Access { session: Some("wayland"), portal: Some("missing"), ..off(PORTAL_MISSING) },
            portal::State::Ready => Access { supported: true, session: Some("wayland"), portal: Some("ready"), ..Access::default() },
            portal::State::Shared => Access { supported: true, screen: true, accessibility: true, session: Some("wayland"), portal: Some("shared"), reason: None },
        },
        Session::Neither => off(NO_DISPLAY),
    }
}

/// On Wayland, the desktop's own dialog: the person picks a window and lets Runrail control it.
/// X11 asks no one, as an app connected to the display may see and drive it.
pub fn request_access(_kind: &str) -> Access {
    if session() == Session::Wayland && portal::state() == portal::State::Ready {
        let _ = portal::share();
    }
    access()
}

/// Ends the share of a window on Wayland.
pub fn stop_sharing() {
    portal::stop();
}

/// A window's app: the first of its names the allow list can hold.
fn app_id(client: &Client) -> Option<String> {
    let class = client.ids.get(1).or(client.ids.first());
    class.into_iter().chain(client.ids.iter()).find(|id| valid_bundle_id(id)).cloned()
}

fn refused(client: &Client) -> bool {
    client.ids.iter().any(|id| never(id))
}

/// Open apps with a window on screen, other than Runrail.
pub fn running_apps(_own: &str) -> Vec<RunningApp> {
    let Some(x11) = (session() == Session::X11).then(X11::connect).flatten() else { return Vec::new() };
    let own = std::process::id() as i32;
    let mut apps: Vec<RunningApp> = Vec::new();
    for client in x11.windows() {
        if client.window.layer != 0 || client.window.pid == own {
            continue;
        }
        let Some(bundle_id) = app_id(&client) else { continue };
        if apps.iter().any(|app| app.bundle_id.eq_ignore_ascii_case(&bundle_id)) {
            continue;
        }
        apps.push(RunningApp { never: refused(&client), name: app_name(&client.ids, &bundle_id), bundle_id });
    }
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps
}

/// The front window of the app in front, unless that app is Runrail. A window whose app holds
/// secrets is named by that name, so quick chat never pictures it.
pub fn front_window_now(own_pid: i32) -> Option<FrontWindow> {
    if session() != Session::X11 {
        return None;
    }
    let x11 = X11::connect()?;
    let active = x11.active()?;
    let clients = x11.windows();
    let client = clients.iter().find(|client| client.window.id == active && client.window.layer == 0)?;
    if client.window.pid == own_pid {
        return None;
    }
    let windows: Vec<Window> = clients.iter().map(|client| client.window.clone()).collect();
    let window = super::front_window(&windows, client.window.pid)?.clone();
    let bundle_id = client.ids.iter().find(|id| super::holds_secrets(id)).cloned().or_else(|| app_id(client)).unwrap_or_default();
    Some(FrontWindow { window, app: app_name(&client.ids, &bundle_id), bundle_id })
}

pub fn picture(window: &Window) -> Result<(String, u32, u32), String> {
    let x11 = X11::connect().ok_or_else(|| NO_X_SERVER.to_string())?;
    encode(&x11, window)
}

fn encode(x11: &X11, window: &Window) -> Result<(String, u32, u32), String> {
    encode_pixels(x11.capture(window)?, &window.bounds)
}

/// The picture as a JPEG at most `MAX_SIDE` pixels on its longer side and 900 KiB as base64.
fn encode_pixels(pixels: image::RgbImage, bounds: &Rect) -> Result<(String, u32, u32), String> {
    let scale = scale(bounds);
    let size = (((bounds.width * scale).round() as u32).max(1), ((bounds.height * scale).round() as u32).max(1));
    let pixels = if size == pixels.dimensions() { pixels } else { image::imageops::resize(&pixels, size.0, size.1, image::imageops::FilterType::Triangle) };
    let bytes = crate::preview_agent::jpeg(&pixels, MAX_IMAGE_BASE64).ok_or("the window could not be captured")?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    if data.len() > MAX_IMAGE_BASE64 {
        return Err("the window is too large to capture".into());
    }
    Ok((data, size.0, size.1))
}

pub fn run(own: &str, action: &str, params: &Value) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    let action = parse_action(action, params)?;
    let session = session();
    if action != Action::Apps {
        let apps = if session == Session::Wayland { vec![shared_window()] } else { allowed() };
        if let Some(device) = super::emulator_named(&apps, params["app"].as_str().unwrap_or_default()) {
            return super::emulator_run(&device, &action);
        }
    }
    match session {
        Session::X11 => run_x11(own, action, params),
        Session::Wayland => run_wayland(action, params),
        Session::Neither => Err(refuse("COMPUTER_OFF", NO_DISPLAY)),
    }
}

fn shared_window() -> AllowedApp {
    AllowedApp { bundle_id: portal::SHARED_ID.into(), name: portal::SHARED_NAME.into() }
}

fn run_wayland(action: Action, params: &Value) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    let shared = shared_window();
    let state = portal::state();
    if action == Action::Apps {
        let text = match state {
            portal::State::Shared => format!("On Wayland you may use one window, the one the person shared with Runrail:\n- {} ({})", shared.name, shared.bundle_id),
            portal::State::Ready => portal::NOT_SHARED.to_string(),
            portal::State::Missing => PORTAL_MISSING.to_string(),
        };
        return Ok((super::with_emulators(text), None));
    }
    let named = params["app"].as_str().unwrap_or_default();
    if find_allowed(std::slice::from_ref(&shared), named).is_none() {
        return Err(refuse("COMPUTER_DENIED", "On Wayland agents may use only the window the person shared; computer_apps names it."));
    }
    match state {
        portal::State::Missing => return Err(refuse("COMPUTER_OFF", PORTAL_MISSING)),
        portal::State::Ready => return Err(refuse("COMPUTER_PERMISSION", portal::NOT_SHARED)),
        portal::State::Shared => {}
    }
    let failed = |message: String| refuse("COMPUTER_FAILED", message);
    let picture = portal::picture().map_err(failed)?;
    let pixels = picture.dimensions();
    let bounds = Rect { x: 0.0, y: 0.0, width: f64::from(pixels.0), height: f64::from(pixels.1) };
    let point = |x: u32, y: u32| -> Result<(f64, f64), Refusal> {
        let point = to_screen(&bounds, x, y).ok_or_else(|| refuse("COMPUTER_DENIED", "that point is outside the shared window; take a new screenshot"))?;
        portal::to_portal(point, pixels).ok_or_else(|| refuse("COMPUTER_PERMISSION", portal::NOT_SHARED))
    };
    let done = match &action {
        Action::Apps | Action::Screenshot => None,
        Action::Click { x, y, right, clicks } => {
            portal::click(point(*x, *y)?, *right, *clicks).map_err(failed)?;
            Some(format!("Clicked at {x}, {y} in the shared window."))
        }
        Action::Type { text } => {
            let keysyms = type_pieces(text).into_iter().flat_map(|piece| match piece {
                Ok(run) => run.chars().map(x11::char_keysym).collect::<Vec<_>>(),
                Err(code) => vec![if code == 48 { x11::keysym("Tab").unwrap_or_default() } else { x11::keysym("Return").unwrap_or_default() }],
            });
            portal::keys(keysyms.collect(), Vec::new()).map_err(failed)?;
            Some(format!("Typed {} characters in the shared window.", text.chars().count()))
        }
        Action::Key { key, modifiers } => {
            let symbol = x11::keysym(key).ok_or_else(|| refuse("COMPUTER_FAILED", "key is invalid"))?;
            portal::keys(vec![symbol], modifiers.iter().filter_map(|name| x11::modifier_keysym(name)).collect()).map_err(failed)?;
            Some(format!("Pressed {}{key} in the shared window.", modifiers.iter().map(|name| format!("{name}+")).collect::<String>()))
        }
        Action::Scroll { x, y, dx, dy } => {
            portal::scroll(point(*x, *y)?, *dx, *dy).map_err(failed)?;
            Some(format!("Scrolled at {x}, {y} in the shared window."))
        }
    };
    let picture = if done.is_some() {
        // The app takes a moment to draw what the input did.
        std::thread::sleep(Duration::from_millis(400));
        portal::picture().map_err(failed)?
    } else {
        picture
    };
    let (width, height) = picture.dimensions();
    let window = Window { id: 0, pid: 0, layer: 0, alpha: 1.0, bounds: Rect { x: 0.0, y: 0.0, width: f64::from(width), height: f64::from(height) }, title: None };
    let encoded = encode_pixels(picture, &window.bounds).map_err(failed)?;
    let described = describe(&shared, &window, (encoded.1, encoded.2));
    Ok((done.map(|done| format!("{done} {described}")).unwrap_or(described), Some(encoded)))
}

fn run_x11(own: &str, action: Action, params: &Value) -> Result<(String, Option<(String, u32, u32)>), Refusal> {
    let apps = allowed();
    if action == Action::Apps {
        if apps.is_empty() && !crate::android::agents_on() {
            return Ok(("The person has not allowed any apps yet. They add them in Runrail's settings, under Computer use.".into(), None));
        }
        let mut text = String::new();
        if !apps.is_empty() {
            let running = running_apps(own);
            let lines: Vec<String> = apps.iter().map(|app| format!("- {} ({}){}", app.name, app.bundle_id, if running.iter().any(|entry| entry.bundle_id.eq_ignore_ascii_case(&app.bundle_id)) { "" } else { ", not running" })).collect();
            text = format!("Apps you may use, as the person allowed them:\n{}", lines.join("\n"));
        }
        return Ok((super::with_emulators(text), None));
    }
    let named = params["app"].as_str().unwrap_or_default();
    let app = find_allowed(&apps, named).ok_or_else(|| refuse("COMPUTER_DENIED", format!("{} is not an app the person allowed. computer_apps lists the ones you may use.", named.chars().filter(|char| !char.is_control()).take(80).collect::<String>())))?;
    if never(&app.bundle_id) || app.bundle_id.eq_ignore_ascii_case(own) {
        return Err(refuse("COMPUTER_DENIED", "agents may not use this app"));
    }
    let x11 = X11::connect().ok_or_else(|| refuse("COMPUTER_OFF", NO_X_SERVER))?;
    let acting = action != Action::Screenshot;
    if acting && !x11.xtest {
        return Err(refuse("COMPUTER_PERMISSION", "This X server has no XTest extension, so Runrail can see apps but not click or type in them."));
    }
    let own_pid = std::process::id() as i32;
    let find = |clients: &[Client]| clients.iter().find(|client| client.window.layer == 0 && client.window.pid != own_pid && client.ids.iter().any(|id| id.eq_ignore_ascii_case(&app.bundle_id))).cloned();
    let client = find(&x11.windows()).ok_or_else(|| refuse("COMPUTER_NOT_FOUND", format!("{} has no window on screen. The person can open it.", app.name)))?;
    if refused(&client) {
        return Err(refuse("COMPUTER_DENIED", "agents may not use this app"));
    }
    // Without a compositing manager a covered window has no pixels of its own, so it comes up
    // for a screenshot too.
    if (acting || !x11.composited()) && !x11.activate(&client) {
        return Err(refuse("COMPUTER_FAILED", format!("{} did not come to the front. Nothing was clicked or typed.", app.name)));
    }
    let clients = x11.windows();
    let client = clients.iter().find(|each| each.window.id == client.window.id).cloned().ok_or_else(|| refuse("COMPUTER_NOT_FOUND", format!("{} has no window on screen.", app.name)))?;
    let frames: Vec<Window> = clients.iter().map(|each| Window { bounds: each.frame, ..each.window.clone() }).collect();
    let window = client.window.clone();
    let pointed = |x: u32, y: u32, what: &str| -> Result<(f64, f64), Refusal> {
        let point = to_screen(&window.bounds, x, y).ok_or_else(|| refuse("COMPUTER_DENIED", "that point is outside the app's window; take a new screenshot"))?;
        if !super::reaches(&frames, window.pid, point) {
            return Err(refuse("COMPUTER_DENIED", format!("another window covers that point, so nothing was {what}")));
        }
        Ok(point)
    };
    let done = match &action {
        Action::Apps | Action::Screenshot => None,
        Action::Click { x, y, right, clicks } => {
            x11.click(pointed(*x, *y, "clicked")?, *right, *clicks);
            Some(format!("Clicked at {x}, {y} in {}.", app.name))
        }
        Action::Type { text } => {
            if !x11.type_text(&type_pieces(text)) {
                return Err(refuse("COMPUTER_FAILED", "the keyboard has no free key to type that with"));
            }
            Some(format!("Typed {} characters in {}.", text.chars().count(), app.name))
        }
        Action::Key { key, modifiers } => {
            let symbol = x11::keysym(key).ok_or_else(|| refuse("COMPUTER_FAILED", "key is invalid"))?;
            let held: Vec<u32> = modifiers.iter().filter_map(|name| x11::modifier_keysym(name)).collect();
            if !x11.key(symbol, &held) {
                return Err(refuse("COMPUTER_FAILED", "the keyboard has no key for that"));
            }
            Some(format!("Pressed {}{key} in {}.", modifiers.iter().map(|name| format!("{name}+")).collect::<String>(), app.name))
        }
        Action::Scroll { x, y, dx, dy } => {
            x11.scroll(pointed(*x, *y, "scrolled")?, *dx, *dy);
            Some(format!("Scrolled at {x}, {y} in {}.", app.name))
        }
    };
    let window = if done.is_some() {
        // The app takes a moment to draw what the input did.
        std::thread::sleep(Duration::from_millis(400));
        x11.windows().into_iter().find(|each| each.window.id == window.id).map(|each| each.window).unwrap_or(window)
    } else {
        window
    };
    let picture = encode(&x11, &window).map_err(|message| refuse("COMPUTER_FAILED", message))?;
    let described = describe(app, &window, (picture.1, picture.2));
    Ok((done.map(|done| format!("{done} {described}")).unwrap_or(described), Some(picture)))
}

/// The name an app's desktop entry gives it, or its id made readable.
fn app_name(ids: &[String], fallback: &str) -> String {
    desktop_name(ids).unwrap_or_else(|| readable(fallback))
}

fn readable(id: &str) -> String {
    let last = if id.contains('.') { id.rsplit('.').next().unwrap_or(id) } else { id };
    let words = last.replace(['-', '_'], " ");
    let mut chars = words.trim().chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_else(|| id.to_string())
}

fn application_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    let shared = std::env::var("XDG_DATA_DIRS").ok().filter(|dirs| !dirs.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    home.into_iter().chain(shared.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from)).map(|dir| dir.join("applications")).collect()
}

/// Looks for `<id>.desktop` first, then for an entry whose StartupWMClass is one of the ids.
fn desktop_name(ids: &[String]) -> Option<String> {
    let dirs = application_dirs();
    for id in ids {
        for dir in &dirs {
            if let Some(name) = std::fs::read_to_string(dir.join(format!("{id}.desktop"))).ok().and_then(|text| entry_name(&text)) {
                return Some(name);
            }
        }
    }
    for dir in &dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten().take(4_000) {
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let wm_class = text.lines().find_map(|line| line.strip_prefix("StartupWMClass=")).map(str::trim);
            if wm_class.is_some_and(|class| ids.iter().any(|id| id.eq_ignore_ascii_case(class))) {
                if let Some(name) = entry_name(&text) {
                    return Some(name);
                }
            }
        }
    }
    None
}

/// The plain Name of a desktop entry's main group.
fn entry_name(text: &str) -> Option<String> {
    let mut main = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            main = line == "[Desktop Entry]";
        } else if main {
            if let Some(name) = line.strip_prefix("Name=") {
                return Some(name.trim().to_string()).filter(|name| !name.is_empty() && name.len() <= 120);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(ids: &[&str]) -> Client {
        let window = Window { id: 1, pid: 10, layer: 0, alpha: 1.0, bounds: Rect { x: 0.0, y: 0.0, width: 10.0, height: 10.0 }, title: None };
        Client { frame: window.bounds, window, ids: ids.iter().map(|id| id.to_string()).collect() }
    }

    #[test]
    fn the_session_is_wayland_whenever_wayland_runs() {
        assert_eq!(session_from(Some("x11"), false, true), Session::X11);
        assert_eq!(session_from(Some("wayland"), true, true), Session::Wayland);
        assert_eq!(session_from(None, true, true), Session::Wayland);
        assert_eq!(session_from(Some("tty"), false, true), Session::X11);
        assert_eq!(session_from(None, false, false), Session::Neither);
        assert_eq!(session_from(Some("x11"), false, false), Session::Neither);
    }

    #[test]
    fn terminals_password_managers_and_settings_are_never_allowed_by_any_of_their_names() {
        for id in ["Gnome-terminal", "org.gnome.Console", "konsole", "XTerm", "Alacritty", "kitty", "KeePassXC", "1Password", "Bitwarden", "Seahorse", "Gnome-control-center", "systemsettings", "Gcr-prompter"] {
            assert!(never(id), "{id}");
        }
        assert!(super::super::holds_secrets("KeePassXC") && !super::super::holds_secrets("konsole"));
        assert!(refused(&client(&["foo", "Foo", "xterm"])));
        assert!(!refused(&client(&["gnome-calculator", "Gnome-calculator", "gnome-calculator"])));
        assert!(!never("Gnome-calculator") && !never("firefox"));
    }

    #[test]
    fn an_app_is_named_by_its_class_then_its_other_names() {
        assert_eq!(app_id(&client(&["gnome-calculator", "Gnome-calculator"])).as_deref(), Some("Gnome-calculator"));
        assert_eq!(app_id(&client(&["xev"])).as_deref(), Some("xev"));
        assert_eq!(app_id(&client(&["odd name", "Odd Name", "odd"])).as_deref(), Some("odd"));
        assert_eq!(app_id(&client(&[])), None);
        assert_eq!(readable("org.gnome.Nautilus"), "Nautilus");
        assert_eq!(readable("gnome-calculator"), "Gnome calculator");
        assert_eq!(readable("xev"), "Xev");
    }

    #[test]
    fn a_desktop_entry_gives_its_plain_name() {
        let text = "[Desktop Entry]\nName[de]=Rechner\nName=Calculator\nExec=gnome-calculator\n[Desktop Action new]\nName=New\n";
        assert_eq!(entry_name(text).as_deref(), Some("Calculator"));
        assert_eq!(entry_name("[Desktop Action x]\nName=Not this\n"), None);
    }
}
