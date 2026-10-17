//! Runrail keeps working after its window closes while something is pending: the window and the
//! Dock icon hide, a menu bar item takes their place, and the page keeps its timers, since the
//! scheduler, the runs and memory sync all live there. What is pending is the page's answer; this
//! side holds it and acts on a close. On Linux the item is a tray icon (StatusNotifierItem); a
//! desktop with no tray host shows none, and launching Runrail again brings the window back.

#[cfg(target_os = "macos")]
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

const MAX_REASONS: usize = 16;
const MAX_REASON_CHARS: usize = 64;
const MAX_LINES: usize = 3;
const MAX_LINE_CHARS: usize = 80;
/// Hidden with nothing pending this long, the app quits by itself.
const IDLE_QUIT: Duration = Duration::from_secs(60);

#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray@2x.png");
/// Linux panels are light or dark, so the black template icon is not used there.
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/128x128.png");

#[derive(Default)]
pub struct Background {
    /// Why the app stays when its window closes; empty when nothing is pending.
    reasons: Mutex<Vec<String>>,
    /// What the menu bar item says: counts and the next scheduled run, written by the page.
    lines: Mutex<Vec<String>>,
    hidden: AtomicBool,
    /// Bumped by every change, so an idle quit waits for the latest one.
    generation: AtomicU64,
    tray: Mutex<Option<Tray>>,
}

#[derive(Clone)]
struct Tray {
    icon: TrayIcon<Wry>,
    lines: Vec<MenuItem<Wry>>,
}

impl Background {
    pub fn pending(&self) -> bool {
        self.reasons.lock().is_ok_and(|reasons| !reasons.is_empty())
    }

    pub fn hidden(&self) -> bool {
        self.hidden.load(Ordering::SeqCst)
    }
}

fn bounded(items: Vec<String>, count: usize, chars: usize) -> Vec<String> {
    items.into_iter().take(count).map(|item| item.chars().filter(|c| !c.is_control()).take(chars).collect()).collect()
}

/// The page's latest answer; hidden with nothing pending, the app quits a minute later.
pub fn hold(app: &AppHandle, background: &Background, reasons: Vec<String>, lines: Option<Vec<String>>) {
    let reasons = bounded(reasons, MAX_REASONS, MAX_REASON_CHARS);
    let idle = reasons.is_empty();
    if let Ok(mut held) = background.reasons.lock() {
        *held = reasons;
    }
    if let Some(lines) = lines {
        let lines = bounded(lines, MAX_LINES, MAX_LINE_CHARS);
        if let Ok(mut held) = background.lines.lock() {
            *held = lines;
        }
        refresh_tray(background);
    }
    let generation = background.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if idle && background.hidden() {
        quit_when_idle(app.clone(), generation);
    }
}

/// Whether a close of the main window should hide it rather than quit.
pub fn stays(app: &AppHandle) -> bool {
    app.try_state::<crate::HostState>().is_some_and(|state| state.background.pending())
}

/// The window and the Dock icon go; the app, every engine it holds, and the menu bar item stay.
pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let _ = window.hide();
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    show_tray(app, true);
    set_hidden(app, true);
}

/// Back where it was, in front.
pub fn show(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    show_tray(app, false);
    set_hidden(app, false);
}

fn set_hidden(app: &AppHandle, hidden: bool) {
    let Some(state) = app.try_state::<crate::HostState>() else { return };
    if state.background.hidden.swap(hidden, Ordering::SeqCst) == hidden {
        return;
    }
    state.background.generation.fetch_add(1, Ordering::SeqCst);
    hold_off_app_nap(app, hidden);
    let tray = state.background.tray.lock().is_ok_and(|tray| tray.is_some());
    let _ = app.emit("background:hidden", json!({ "hidden": hidden, "tray": tray }));
}

/// Quits a minute after the page last said nothing is pending, if nothing changed since.
fn quit_when_idle(app: AppHandle, generation: u64) {
    let _ = std::thread::Builder::new().name("runrail-idle-quit".into()).spawn(move || {
        std::thread::sleep(IDLE_QUIT);
        let Some(state) = app.try_state::<crate::HostState>() else { return };
        let background = &state.background;
        if background.hidden() && !background.pending() && background.generation.load(Ordering::SeqCst) == generation {
            app.exit(0);
        }
    });
}

fn show_tray(app: &AppHandle, visible: bool) {
    let Some(state) = app.try_state::<crate::HostState>() else { return };
    let tray = {
        let Ok(mut tray) = state.background.tray.lock() else { return };
        if tray.is_none() && visible && can_show_tray() {
            *tray = build_tray(app);
        }
        tray.clone()
    };
    if let Some(tray) = tray {
        let _ = tray.icon.set_visible(visible);
    }
    refresh_tray(&state.background);
}

fn build_tray(app: &AppHandle) -> Option<Tray> {
    let lines: Vec<MenuItem<Wry>> = (0..MAX_LINES).filter_map(|index| MenuItem::with_id(app, format!("line-{index}"), "", false, None::<&str>).ok()).collect();
    let open = MenuItem::with_id(app, "open", "Open Runrail", true, None::<&str>).ok()?;
    let quit = MenuItem::with_id(app, "quit", "Quit Runrail", true, None::<&str>).ok()?;
    let separator = PredefinedMenuItem::separator(app).ok()?;
    let menu = Menu::new(app).ok()?;
    for line in &lines {
        let _ = menu.append(line);
    }
    let _ = menu.append(&separator);
    let _ = menu.append(&open);
    let _ = menu.append(&quit);
    let icon = TrayIconBuilder::with_id("runrail")
        .icon(Image::from_bytes(TRAY_ICON).ok()?)
        .icon_as_template(true)
        .tooltip("Runrail")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| menu_action(app, event.id().as_ref()))
        .build(app)
        .ok()?;
    Some(Tray { icon, lines })
}

/// Open Runrail or Quit Runrail, from the menu bar item; a debug build's automation calls it too.
pub fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "open" => show(app),
        "quit" => {
            // As the person's own Quit: asked first while turns run.
            if crate::quit_guarded(app) {
                crate::confirm_quit(app.clone());
            } else {
                app.exit(0);
            }
        }
        _ => {}
    }
}

fn refresh_tray(background: &Background) {
    let lines = background.lines.lock().map(|lines| lines.clone()).unwrap_or_default();
    // Cloned out, so no lock is held while a menu change waits on the main thread.
    let Some(tray) = background.tray.lock().ok().and_then(|tray| tray.clone()) else { return };
    for (index, item) in tray.lines.iter().enumerate() {
        let text = lines.get(index).cloned().unwrap_or_default();
        let _ = item.set_text(if text.is_empty() { " " } else { &text });
    }
    let _ = tray.icon.set_tooltip(Some(lines.first().map_or("Runrail", String::as_str)));
}

#[cfg(target_os = "macos")]
thread_local! {
    /// The activity that keeps App Nap from slowing a hidden app's timers; main thread only.
    static ACTIVITY: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
}

/// A hidden app with no window on screen is a candidate for App Nap, which would stretch the
/// page's 30-second scheduler to minutes. The Mac may still sleep when idle.
#[cfg(target_os = "macos")]
fn hold_off_app_nap(app: &AppHandle, on: bool) {
    let _ = app.run_on_main_thread(move || {
        ACTIVITY.with(|slot| {
            let mut slot = slot.borrow_mut();
            let info = NSProcessInfo::processInfo();
            if let Some(activity) = slot.take() {
                unsafe { info.endActivity(&activity) };
            }
            if on {
                let reason = NSString::from_str("Runrail runs schedules and runs while its window is closed");
                *slot = Some(info.beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason));
            }
        });
    });
}

#[cfg(not(target_os = "macos"))]
fn hold_off_app_nap(_app: &AppHandle, _on: bool) {}

/// Whether the desktop shows tray icons: a StatusNotifierWatcher owns its name on the session
/// bus (stock GNOME has none without the AppIndicator extension), and the indicator library the
/// tray loads is installed, since a tray built without it panics.
#[cfg(target_os = "linux")]
fn can_show_tray() -> bool {
    tray_host() && indicator_library()
}

#[cfg(not(target_os = "linux"))]
fn can_show_tray() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn tray_host() -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else { return false };
    let Ok(bus) = zbus::blocking::fdo::DBusProxy::new(&connection) else { return false };
    zbus::names::BusName::try_from("org.kde.StatusNotifierWatcher").is_ok_and(|name| bus.name_has_owner(name).unwrap_or(false))
}

/// The names libappindicator-sys loads, in its order.
#[cfg(target_os = "linux")]
fn indicator_library() -> bool {
    [c"libayatana-appindicator3.so.1", c"libappindicator3.so.1", c"libayatana-appindicator3.so", c"libappindicator3.so"].iter().any(|name| {
        // SAFETY: a valid C string; the handle is closed again at once.
        let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return false;
        }
        unsafe { libc::dlclose(handle) };
        true
    })
}

/// Another launch of Runrail while it runs: the window comes back, unless that
/// launch was a login or wake start, which would have opened none.
#[cfg(target_os = "linux")]
pub fn launched_again(app: &AppHandle, args: &[String]) {
    if args.iter().skip(1).any(|arg| crate::wake::is_woken_flag(arg) || crate::login::is_login_flag(arg)) {
        return;
    }
    show(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_cannot_hold_more_than_the_bounds() {
        let reasons = bounded((0..40).map(|index| format!("reason-{index}-{}", "x".repeat(100))).collect(), MAX_REASONS, MAX_REASON_CHARS);
        assert_eq!(reasons.len(), MAX_REASONS);
        assert!(reasons.iter().all(|reason| reason.chars().count() == MAX_REASON_CHARS));
        let lines = bounded(vec!["2 running\n\u{1b}[31m, 1 waiting".into(), "Next: Nightly, at 02:00".into(), "c".into(), "d".into()], MAX_LINES, MAX_LINE_CHARS);
        assert_eq!(lines, vec!["2 running[31m, 1 waiting", "Next: Nightly, at 02:00", "c"]);
    }

    #[test]
    fn a_close_hides_only_while_something_is_pending() {
        let background = Background::default();
        assert!(!background.pending());
        *background.reasons.lock().unwrap() = vec!["schedule".into()];
        assert!(background.pending());
        background.reasons.lock().unwrap().clear();
        assert!(!background.pending());
    }
}
