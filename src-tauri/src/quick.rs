//! Quick chat: a global shortcut, Option+Space unless the person picks another,
//! opens a small window over whatever they are doing. What they type there starts a thread in the
//! main window, with a picture of the window they were in when they tick the box for one. The window
//! in front is only noted when the shortcut is pressed; it is captured only on that send.
//!
//! On Linux the default is Ctrl+Alt+Space, since GNOME and KDE keep Alt+Space for the window menu.
//! The shortcut plugin grabs keys on X11 only; in a Wayland session the desktop's GlobalShortcuts
//! portal binds it instead, the person confirms it in the desktop's own dialog, and the desktop
//! decides the keys.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::computer::{self, FrontWindow};
use crate::error::{BridgeError, BridgeResult};
use crate::store::write_atomic;

pub const LABEL: &str = "quick";
#[cfg(not(target_os = "linux"))]
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
#[cfg(target_os = "linux")]
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";
#[cfg(not(target_os = "linux"))]
const MODIFIERS: &str = "Option, Command, Control or Shift";
#[cfg(target_os = "linux")]
const MODIFIERS: &str = "Ctrl, Alt, Super or Shift";
const MAX_TEXT: usize = 20_000;

fn on() -> bool {
    true
}

fn default_shortcut() -> String {
    DEFAULT_SHORTCUT.into()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default = "on")]
    enabled: bool,
    #[serde(default = "default_shortcut")]
    shortcut: String,
    /// The last choice of the box, so a person who always sends the window keeps it ticked.
    #[serde(default)]
    include_window: bool,
}

impl Default for Saved {
    fn default() -> Self {
        Self { enabled: true, shortcut: default_shortcut(), include_window: false }
    }
}

struct State {
    saved: Saved,
    /// The shortcut registered now, if any.
    registered: Option<Shortcut>,
    problem: Option<String>,
    front: Option<FrontWindow>,
    /// The portal's binding while it runs, and the keys the desktop gave it.
    #[cfg(target_os = "linux")]
    portal: Option<tauri::async_runtime::JoinHandle<()>>,
    #[cfg(target_os = "linux")]
    trigger: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuickStatus {
    pub enabled: bool,
    pub shortcut: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    pub default_shortcut: &'static str,
    /// The desktop holds the shortcut (a Wayland session's portal), and these are its keys once it said.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub desktop: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

/// What the quick window says about the window in front, without its picture.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuickContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A window was in front and its app does not hold passwords.
    pub capturable: bool,
    pub include_window: bool,
    pub screen_access: bool,
}

pub struct Quick {
    path: PathBuf,
    state: Mutex<State>,
}

fn lock(mutex: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A shortcut as the person typed it, in the plugin's words: `Alt+Space`, `CmdOrCtrl+Shift+K`.
pub fn parse(text: &str) -> BridgeResult<Shortcut> {
    let shortcut: Shortcut = text.parse().map_err(|_| BridgeError::new("QUICK_SHORTCUT_INVALID", "That is not a shortcut Runrail can use."))?;
    // A plain key would fire on every press of it, anywhere.
    if shortcut.mods.is_empty() {
        return Err(BridgeError::new("QUICK_SHORTCUT_INVALID", format!("A shortcut needs {MODIFIERS} with its key.")));
    }
    Ok(shortcut)
}

impl Quick {
    pub fn new(app_data: &Path) -> Arc<Self> {
        let path = app_data.join("quick.json");
        let saved = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok()).unwrap_or_default();
        Arc::new(Self {
            path,
            state: Mutex::new(State {
                saved,
                registered: None,
                problem: None,
                front: None,
                #[cfg(target_os = "linux")]
                portal: None,
                #[cfg(target_os = "linux")]
                trigger: None,
            }),
        })
    }

    fn status_of(state: &State) -> QuickStatus {
        #[cfg(target_os = "linux")]
        let (desktop, trigger) = (portal::wayland(), state.trigger.clone());
        #[cfg(not(target_os = "linux"))]
        let (desktop, trigger) = (false, None);
        QuickStatus { enabled: state.saved.enabled, shortcut: state.saved.shortcut.clone(), problem: state.problem.clone(), default_shortcut: DEFAULT_SHORTCUT, desktop, trigger }
    }

    pub fn status(&self) -> QuickStatus {
        Self::status_of(&lock(&self.state))
    }

    fn save(&self, saved: &Saved) -> BridgeResult<()> {
        let bytes = serde_json::to_vec_pretty(saved).map_err(|_| BridgeError::new("QUICK_SAVE_FAILED", "quick chat settings could not be written"))?;
        write_atomic(&self.path, &bytes)
    }

    /// Registers the saved shortcut at launch; a shortcut another app holds is a problem to show.
    pub fn start(&self, app: &AppHandle) {
        let mut state = lock(&self.state);
        if !state.saved.enabled {
            return;
        }
        #[cfg(target_os = "linux")]
        if portal::wayland() {
            let preferred = state.saved.shortcut.clone();
            state.portal = Some(portal::bind(app.clone(), preferred));
            return;
        }
        match parse(&state.saved.shortcut).and_then(|shortcut| register(app, shortcut)) {
            Ok(shortcut) => state.registered = Some(shortcut),
            Err(error) => state.problem = Some(error.message),
        }
    }

    /// Turns the shortcut on or off, or changes it; a new one that cannot be had keeps the old.
    pub fn set(&self, app: &AppHandle, enabled: bool, shortcut: &str) -> BridgeResult<QuickStatus> {
        let wanted = parse(shortcut)?;
        let mut state = lock(&self.state);
        #[cfg(target_os = "linux")]
        if portal::wayland() {
            if let Some(binding) = state.portal.take() {
                binding.abort();
            }
            (state.problem, state.trigger) = (None, None);
            if enabled {
                state.portal = Some(portal::bind(app.clone(), shortcut.trim().to_string()));
            }
            let saved = Saved { enabled, shortcut: shortcut.trim().to_string(), include_window: state.saved.include_window };
            self.save(&saved)?;
            state.saved = saved;
            return Ok(Self::status_of(&state));
        }
        let previous = state.registered.take();
        if let Some(previous) = previous {
            let _ = app.global_shortcut().unregister(previous);
        }
        if enabled {
            match register(app, wanted) {
                Ok(shortcut) => state.registered = Some(shortcut),
                Err(error) => {
                    if let Some(previous) = previous {
                        state.registered = register(app, previous).ok();
                    }
                    return Err(error);
                }
            }
        }
        state.problem = None;
        let saved = Saved { enabled, shortcut: shortcut.trim().to_string(), include_window: state.saved.include_window };
        self.save(&saved)?;
        state.saved = saved;
        Ok(Self::status_of(&state))
    }

    /// The shortcut: shows the quick window over the window in front, or hides it again.
    pub fn pressed(&self, app: &AppHandle) {
        if let Some(window) = app.get_webview_window(LABEL) {
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
                return;
            }
        }
        // No picture of the window in front on Linux until computer use is there.
        lock(&self.state).front = if cfg!(target_os = "linux") { None } else { computer::front_window_now(std::process::id() as i32) };
        let Some(window) = quick_window(app) else { return };
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
    }

    pub fn context(&self) -> QuickContext {
        let state = lock(&self.state);
        let front = state.front.as_ref();
        QuickContext {
            app: front.map(|front| front.app.clone()),
            title: front.and_then(|front| front.window.title.clone()).filter(|title| !title.trim().is_empty()),
            capturable: front.is_some_and(|front| !computer::holds_secrets(&front.bundle_id)),
            include_window: state.saved.include_window,
            screen_access: computer::access().screen,
        }
    }

    /// Hands the message, and the window's picture when asked for, to the main window, and brings it up.
    pub fn submit(&self, app: &AppHandle, text: &str, include_window: bool) -> BridgeResult<()> {
        let text = text.trim();
        if text.chars().count() > MAX_TEXT {
            return Err(BridgeError::new("QUICK_TOO_LONG", "Write up to 20,000 characters."));
        }
        let front = {
            let mut state = lock(&self.state);
            if state.saved.include_window != include_window {
                state.saved.include_window = include_window;
                let _ = self.save(&state.saved);
            }
            state.front.clone()
        };
        let image = if include_window {
            let Some(front) = front.filter(|front| !computer::holds_secrets(&front.bundle_id)) else {
                return Err(BridgeError::new("QUICK_NO_WINDOW", "No window of another app was in front to include."));
            };
            if !computer::access().screen {
                // The system's own prompt, for the person to answer; Runrail lists itself there.
                computer::request_access("screen");
                return Err(BridgeError::new("QUICK_SCREEN_ACCESS", "Allow Runrail under Screen & System Audio Recording in System Settings, Privacy & Security, then try again."));
            }
            let (data, width, height) = computer::picture(&front.window).map_err(|message| BridgeError::new("QUICK_CAPTURE_FAILED", format!("The {} window could not be captured: {message}.", front.app)))?;
            Some(json!({ "dataBase64": data, "mediaType": "image/jpeg", "width": width, "height": height, "name": format!("{} window", front.app) }))
        } else {
            None
        };
        if text.is_empty() && image.is_none() {
            return Err(BridgeError::new("QUICK_EMPTY", "Write a message first."));
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
        crate::background::show(app);
        app.emit_to("main", "quick:submit", json!({ "text": text, "image": image })).map_err(|_| BridgeError::new("QUICK_FAILED", "Runrail's window did not take the message."))
    }
}

/// The binding answered: the desktop's keys, or why there are none.
#[cfg(target_os = "linux")]
fn portal_answered(app: &AppHandle, answer: Result<Option<String>, String>) {
    let Some(quick) = app.try_state::<Arc<Quick>>() else { return };
    let mut state = lock(&quick.state);
    match answer {
        Ok(trigger) => (state.problem, state.trigger) = (None, trigger),
        Err(problem) => (state.problem, state.trigger) = (Some(problem), None),
    }
}

#[cfg(target_os = "linux")]
mod portal {
    use std::sync::Arc;

    use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
    use futures_util::StreamExt;
    use tauri::{AppHandle, Manager};

    use super::Quick;

    const ID: &str = "quick-chat";

    /// A Wayland session, where an app cannot grab keys for itself, even through XWayland.
    pub fn wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
    }

    /// `Ctrl+Alt+Space` in the words of the XDG shortcuts spec: `CTRL+ALT+space`.
    pub fn trigger(shortcut: &str) -> String {
        shortcut
            .split('+')
            .map(|part| match part.trim() {
                "Ctrl" | "Control" | "CmdOrCtrl" | "CommandOrControl" => "CTRL".to_string(),
                "Alt" | "Option" => "ALT".to_string(),
                "Shift" => "SHIFT".to_string(),
                "Super" | "Command" | "Cmd" | "Meta" => "LOGO".to_string(),
                "Space" => "space".to_string(),
                "Enter" => "Return".to_string(),
                "Esc" => "Escape".to_string(),
                key => {
                    let key = key.strip_prefix("Key").filter(|rest| rest.len() == 1).or_else(|| key.strip_prefix("Digit").filter(|rest| rest.len() == 1)).unwrap_or(key);
                    // Letters are lower-case keysyms; F1, Tab and the other names stay as they are.
                    if key.len() == 1 { key.to_ascii_lowercase() } else { key.to_string() }
                }
            })
            .collect::<Vec<_>>()
            .join("+")
    }

    async fn session(app: &AppHandle, preferred: &str) -> Result<(GlobalShortcuts, ashpd::desktop::Session<GlobalShortcuts>, Option<String>), ashpd::Error> {
        if let Ok(id) = app.config().identifier.parse() {
            let _ = ashpd::register_host_app(id).await;
        }
        let portal = GlobalShortcuts::new().await?;
        let session = portal.create_session(Default::default()).await?;
        let shortcut = NewShortcut::new(ID, "Open Runrail's quick chat").preferred_trigger(trigger(preferred).as_str());
        let bound = portal.bind_shortcuts(&session, &[shortcut], None, Default::default()).await?.response()?;
        let keys = bound.shortcuts().iter().find(|shortcut| shortcut.id() == ID).map(|shortcut| shortcut.trigger_description().to_string()).filter(|keys| !keys.is_empty());
        Ok((portal, session, keys))
    }

    /// Binds the shortcut, asking the desktop, then opens quick chat on each press until aborted.
    pub fn bind(app: AppHandle, preferred: String) -> tauri::async_runtime::JoinHandle<()> {
        tauri::async_runtime::spawn(async move {
            let (portal, _session, keys) = match session(&app, &preferred).await {
                Ok(bound) => bound,
                Err(ashpd::Error::Response(_)) => return super::portal_answered(&app, Err("The shortcut was not allowed in the desktop's dialog. Turn quick chat off and on to be asked again.".into())),
                Err(_) => return super::portal_answered(&app, Err("This Wayland desktop does not let apps have global shortcuts (it has no GlobalShortcuts portal), so quick chat has no shortcut here.".into())),
            };
            super::portal_answered(&app, Ok(keys));
            let Ok(mut presses) = portal.receive_activated().await else { return };
            while let Some(press) = presses.next().await {
                if press.shortcut_id() == ID {
                    if let Some(quick) = app.try_state::<Arc<Quick>>() {
                        quick.pressed(&app);
                    }
                }
            }
        })
    }
}

fn register(app: &AppHandle, shortcut: Shortcut) -> BridgeResult<Shortcut> {
    app.global_shortcut().register(shortcut).map_err(|_| BridgeError::new("QUICK_SHORTCUT_TAKEN", "That shortcut could not be set. Another app may already use it."))?;
    Ok(shortcut)
}

/// The quick window, made the first time: small, on top, on every Space, and gone when it loses focus.
fn quick_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Some(window);
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("quick.html".into()))
        .title("Quick chat")
        .inner_size(640.0, 188.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build()
        .ok()?;
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = hide.hide();
        }
    });
    Some(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_need_a_modifier_and_default_to_option_space() {
        assert!(parse(DEFAULT_SHORTCUT).is_ok());
        assert!(parse("CmdOrCtrl+Shift+K").is_ok());
        assert_eq!(parse("Space").expect_err("plain").code, "QUICK_SHORTCUT_INVALID");
        assert_eq!(parse("Alt+Nope").expect_err("unknown").code, "QUICK_SHORTCUT_INVALID");
        let saved: Saved = serde_json::from_str("{}").expect("empty");
        assert!(saved.enabled && saved.shortcut == DEFAULT_SHORTCUT && !saved.include_window);
        #[cfg(target_os = "macos")]
        assert_eq!(DEFAULT_SHORTCUT, "Alt+Space");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_keeps_alt_space_for_the_window_menu_and_asks_the_portal_in_its_words() {
        assert_eq!(DEFAULT_SHORTCUT, "Ctrl+Alt+Space");
        assert_eq!(portal::trigger(DEFAULT_SHORTCUT), "CTRL+ALT+space");
        assert_eq!(portal::trigger("Command+Shift+KeyK"), "LOGO+SHIFT+k");
        assert_eq!(portal::trigger("Control+Alt+Digit1"), "CTRL+ALT+1");
        assert_eq!(portal::trigger("Alt+F2"), "ALT+F2");
    }
}
