//! "Start in the menu bar at login": Runrail as the person's login item through
//! `SMAppService`, which System Settings lists under Login Items, or on Linux an XDG autostart
//! entry. A login launch opens no window; the app stays in the menu bar (or the
//! tray) only while something is pending, as after a close.
#![cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]

use serde::Serialize;

/// What the autostart entry starts Runrail with, so the launch opens no window.
#[cfg(not(target_os = "macos"))]
const LOGIN_FLAG: &str = "--at-login";

#[cfg(not(target_os = "macos"))]
pub fn is_login_flag(arg: &str) -> bool {
    arg == LOGIN_FLAG
}

/// What System Settings holds for this app; an unbundled development build has no login item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoginItem {
    On,
    Off,
    /// Registered, but the person has to allow it in System Settings > General > Login Items.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NeedsApproval,
    Unavailable,
}

/// `SMAppServiceStatus`: not registered, enabled, requires approval, not found. macOS answers not
/// found, not not registered, for an app that was never registered (seen 2026-10-10 on an ad-hoc
/// signed bundle), so it reads as off; a register that then fails says why.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn from_status(status: isize) -> LoginItem {
    match status {
        0 | 3 => LoginItem::Off,
        1 => LoginItem::On,
        2 => LoginItem::NeedsApproval,
        _ => LoginItem::Unavailable,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager, NSError};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    /// `keyAEPropData` and `keyAELaunchedAsLogInItem`.
    const PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
    const LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");

    fn service() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"SMAppService")?;
        unsafe { msg_send![class, mainAppService] }
    }

    pub fn status() -> Option<isize> {
        let service = service()?;
        Some(unsafe { msg_send![&*service, status] })
    }

    pub fn set(on: bool) -> Result<(), String> {
        let service = service().ok_or("login items need macOS 13")?;
        let result: Result<(), Retained<NSError>> = if on { unsafe { msg_send![&*service, registerAndReturnError: _] } } else { unsafe { msg_send![&*service, unregisterAndReturnError: _] } };
        result.map_err(|error| error.localizedDescription().to_string())
    }

    /// The launch Apple event says so when loginwindow opened the app; read while it is current.
    pub fn launched_at_login() -> bool {
        let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else { return false };
        // objc2 types this method only behind its CoreServices feature, a crate for one call.
        let value: Option<Retained<NSAppleEventDescriptor>> = unsafe { msg_send![&*event, paramDescriptorForKeyword: PROP_DATA] };
        value.is_some_and(|value| value.enumCodeValue() == LAUNCHED_AS_LOGIN_ITEM)
    }
}

#[cfg(target_os = "linux")]
mod xdg {
    use std::path::{Path, PathBuf};

    use super::LOGIN_FLAG;

    /// `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart`.
    pub fn folder() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute());
        let config = config.or_else(|| std::env::var_os("HOME").map(PathBuf::from).filter(|path| path.is_absolute()).map(|home| home.join(".config")))?;
        Some(config.join("autostart"))
    }

    pub fn entry_path(folder: &Path, identifier: &str) -> PathBuf {
        folder.join(format!("{identifier}.desktop"))
    }

    /// The program a login should start: the AppImage file itself, whose mount point changes on
    /// every launch, or the installed binary.
    pub fn program() -> Option<PathBuf> {
        let image = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|path| path.is_absolute() && path.is_file());
        image.or_else(|| std::env::current_exe().ok())
    }

    /// One argument of an `Exec` key, quoted as the Desktop Entry spec asks: `%` doubled, reserved
    /// characters inside double quotes with `"`, `` ` ``, `$` and `\` escaped, then every
    /// backslash escaped again for the string value.
    pub fn exec_arg(arg: &str) -> String {
        let arg = arg.replace('%', "%%");
        let quoted = if arg.is_empty() || arg.chars().any(|ch| " \t\n\"'\\><~|&;$*?#()`".contains(ch)) {
            let mut out = String::from("\"");
            for ch in arg.chars() {
                if matches!(ch, '"' | '`' | '$' | '\\') {
                    out.push('\\');
                }
                out.push(ch);
            }
            out.push('"');
            out
        } else {
            arg
        };
        quoted.replace('\\', "\\\\")
    }

    pub fn entry(program: &Path) -> Option<String> {
        let program = program.to_str().filter(|path| !path.chars().any(char::is_control))?;
        Some(format!(
            "[Desktop Entry]\nType=Application\nName=Runrail\nComment=Keeps schedules and runs going after you log in\nExec={} {LOGIN_FLAG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
            exec_arg(program)
        ))
    }
}

/// Development builds have no login item, except one driven by the end-to-end tests with a home
/// folder of its own.
fn installed() -> bool {
    cfg!(not(debug_assertions)) || std::env::var("RUNRAIL_AUTOMATION").as_deref() == Ok("1")
}

pub fn status(identifier: &str) -> LoginItem {
    #[cfg(target_os = "macos")]
    if cfg!(not(debug_assertions)) {
        let _ = identifier;
        return mac::status().map_or(LoginItem::Unavailable, from_status);
    }
    #[cfg(target_os = "linux")]
    if installed() {
        return match xdg::folder() {
            Some(folder) if xdg::entry_path(&folder, identifier).is_file() => LoginItem::On,
            Some(_) => LoginItem::Off,
            None => LoginItem::Unavailable,
        };
    }
    let _ = (identifier, installed);
    LoginItem::Unavailable
}

pub fn set(identifier: &str, on: bool) -> Result<LoginItem, String> {
    #[cfg(target_os = "macos")]
    if cfg!(not(debug_assertions)) {
        mac::set(on)?;
        return Ok(status(identifier));
    }
    #[cfg(target_os = "linux")]
    if installed() {
        let folder = xdg::folder().ok_or("the home folder is unknown")?;
        let path = xdg::entry_path(&folder, identifier);
        if on {
            let text = xdg::program().as_deref().and_then(xdg::entry).ok_or("Runrail's own path cannot be written in an autostart entry")?;
            crate::store::write_atomic(&path, text.as_bytes()).map_err(|_| "the autostart entry could not be written")?;
        } else {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("the autostart entry could not be removed".into()),
            }
        }
        return Ok(status(identifier));
    }
    let _ = (identifier, on);
    Err("only the installed app can start at login".into())
}

/// An entry written for another copy of the app (a moved AppImage) is written again for this one.
#[cfg(target_os = "linux")]
pub fn refresh(identifier: &str) {
    let (Some(folder), Some(program)) = (xdg::folder(), xdg::program()) else { return };
    let path = xdg::entry_path(&folder, identifier);
    if let (Ok(current), Some(text)) = (std::fs::read_to_string(&path), xdg::entry(&program)) {
        if current != text && installed() {
            let _ = crate::store::write_atomic(&path, text.as_bytes());
        }
    }
}

pub fn launched_at_login() -> bool {
    #[cfg(target_os = "macos")]
    return mac::launched_at_login();
    #[cfg(not(target_os = "macos"))]
    std::env::args().skip(1).any(|arg| is_login_flag(&arg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_service_status_has_a_name() {
        assert_eq!([0, 1, 2, 3, 9].map(from_status), [LoginItem::Off, LoginItem::On, LoginItem::NeedsApproval, LoginItem::Off, LoginItem::Unavailable]);
        assert_eq!(serde_json::to_value(LoginItem::NeedsApproval).unwrap(), "needs-approval");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_autostart_entry_starts_this_program_quoted_and_hidden() {
        use std::path::Path;
        let text = xdg::entry(Path::new("/opt/Run Rail/runrail-desktop-web")).unwrap();
        assert!(text.starts_with("[Desktop Entry]\nType=Application\nName=Runrail\n"));
        assert!(text.contains("\nExec=\"/opt/Run Rail/runrail-desktop-web\" --at-login\n"));
        assert!(text.ends_with("X-GNOME-Autostart-enabled=true\n"));
        assert_eq!(xdg::exec_arg("/usr/bin/runrail-desktop-web"), "/usr/bin/runrail-desktop-web");
        assert_eq!(xdg::exec_arg("/home/a/100% $HOME`x`\"q\".AppImage"), "\"/home/a/100%% \\\\$HOME\\\\`x\\\\`\\\\\"q\\\\\".AppImage\"");
        assert_eq!(xdg::exec_arg("/a\\b"), "\"/a\\\\\\\\b\"");
        assert!(xdg::entry(Path::new("/opt/a\nb")).is_none());
        assert_eq!(xdg::entry_path(Path::new("/h/.config/autostart"), "com.runrail.desktop"), Path::new("/h/.config/autostart/com.runrail.desktop.desktop"));
        assert!(is_login_flag("--at-login") && !is_login_flag("--background"));
    }
}
