//! Keeps the computer from going to sleep while a turn runs, when the person asks for that. On
//! macOS it holds one `caffeinate -i` process (with `-d`, the display stays on too) tied to this
//! app's own process id, so it ends with the app even if the app is killed. On Linux it holds
//! logind's idle and sleep inhibitors (`systemd-inhibit --list` shows them) and, for the display,
//! the session's screensaver inhibitor; the system drops each when the app's connection closes.

#[cfg(not(target_os = "linux"))]
use std::process::Child;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::Mutex;

#[cfg(not(target_os = "linux"))]
type Hold = Child;
#[cfg(target_os = "linux")]
type Hold = linux::Hold;

#[derive(Default)]
pub struct KeepAwake {
    /// The running hold, and whether it keeps the display on.
    child: Mutex<Option<(Hold, bool)>>,
}

impl KeepAwake {
    /// Returns whether the system is being kept awake after the call.
    pub fn set(&self, on: bool, display: bool) -> bool {
        let Ok(mut child) = self.child.lock() else {
            return false;
        };
        if let Some((running, _)) = child.as_mut() {
            if !alive(running) {
                *child = None;
            }
        }
        if child.as_ref().is_some_and(|(_, held)| !on || *held != display) {
            stop(child.take().map(|(running, _)| running));
        }
        if on && child.is_none() {
            *child = start(display).map(|running| (running, display));
        }
        child.is_some()
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            stop(child.take().map(|(running, _)| running));
        }
    }
}

#[cfg(target_os = "macos")]
fn start(display: bool) -> Option<Child> {
    let pid = std::process::id().to_string();
    let flags: &[&str] = if display { &["-i", "-d"] } else { &["-i"] };
    Command::new("/usr/bin/caffeinate")
        .args(flags)
        .args(["-w", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(target_os = "linux")]
fn start(display: bool) -> Option<Hold> {
    linux::Hold::new(display)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn start(_display: bool) -> Option<Child> {
    None
}

#[cfg(not(target_os = "linux"))]
fn alive(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

#[cfg(target_os = "linux")]
fn alive(_hold: &mut Hold) -> bool {
    true
}

#[cfg(not(target_os = "linux"))]
fn stop(child: Option<Child>) {
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(target_os = "linux")]
fn stop(hold: Option<Hold>) {
    drop(hold);
}

#[cfg(target_os = "linux")]
mod linux {
    use zbus::blocking::Connection;

    const NAME: &str = "Runrail";
    const REASON: &str = "A thread is running";
    const SCREENSAVER: &str = "org.freedesktop.ScreenSaver";

    pub struct Hold {
        _system: keepawake::KeepAwake,
        _display: Option<Display>,
    }

    impl Hold {
        /// Without logind (no system bus, or no systemd) nothing is held.
        pub fn new(display: bool) -> Option<Self> {
            let system = keepawake::Builder::default().idle(true).sleep(true).reason(REASON).app_name(NAME).app_reverse_domain("com.runrail.desktop").create().ok()?;
            let display = if display { Some(Display::new()?) } else { None };
            Some(Self { _system: system, _display: display })
        }
    }

    /// The screensaver inhibitor, held here rather than through keepawake: its release unwraps
    /// the D-Bus answer, and a release build aborts on that panic.
    struct Display {
        connection: Connection,
        cookie: u32,
    }

    impl Display {
        fn new() -> Option<Self> {
            let connection = Connection::session().ok()?;
            let reply = connection.call_method(Some(SCREENSAVER), "/org/freedesktop/ScreenSaver", Some(SCREENSAVER), "Inhibit", &(NAME, REASON)).ok()?;
            let cookie = reply.body().deserialize::<u32>().ok()?;
            Some(Self { connection, cookie })
        }
    }

    impl Drop for Display {
        fn drop(&mut self) {
            let _ = self.connection.call_method(Some(SCREENSAVER), "/org/freedesktop/ScreenSaver", Some(SCREENSAVER), "UnInhibit", &(self.cookie,));
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn holds_one_assertion_and_lets_it_go() {
        let keep = KeepAwake::default();
        let pid = || keep.child.lock().unwrap().as_ref().unwrap().0.id();
        assert!(keep.set(true, false));
        let first = pid();
        assert!(keep.set(true, false));
        assert_eq!(pid(), first, "a second request reuses the first");
        assert!(keep.set(true, true));
        assert_ne!(pid(), first, "keeping the display on too starts a new hold");
        assert!(!keep.set(false, true));
        assert!(!keep.set(false, false));
    }
}
