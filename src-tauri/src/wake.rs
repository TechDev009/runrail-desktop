//! Run after Quit: the engine's `runrail service`, kept running by a launchd
//! agent the person turns on, opens the app hidden with `--background` when work is due and the
//! app is not running. This side writes the agent's plist, starts and stops it with launchctl, and
//! keeps the note the service reads to tell whether the app runs: `~/.runrail/service/app.json`,
//! `{ "pid": number | null, "at": ms }`, rewritten every 30 seconds and with a null pid on quit.
//! On Linux a systemd user unit takes the agent's place; it starts the app with
//! `--wake-service`, and the app hands over to its own engine's service.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const NOTE_EVERY: Duration = Duration::from_secs(30);
/// The flag the service opens the app with.
const WOKEN_FLAG: &str = "--background";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WakeService {
    On,
    Off,
    /// A development build runs from no app bundle, and the service opens a bundle.
    Unavailable,
    /// Linux without systemd's user services, which keep the service running.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    NoSystemd,
}

/// Whether the wake service opened this launch.
pub fn woken() -> bool {
    std::env::args().skip(1).any(|arg| is_woken_flag(&arg))
}

pub fn is_woken_flag(arg: &str) -> bool {
    arg == WOKEN_FLAG
}

/// The installed app's bundle and the engine inside it.
fn bundle() -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    let app = macos.parent()?.parent()?;
    if app.extension()? != "app" {
        return None;
    }
    let engine = macos.join("runrail");
    engine.is_file().then(|| (app.to_path_buf(), engine))
}

pub fn label(identifier: &str) -> String {
    format!("{identifier}.wake")
}

pub fn plist_path(home: &Path, label: &str) -> PathBuf {
    home.join("Library").join("LaunchAgents").join(format!("{label}.plist"))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// The agent: started at login and after a crash, never logging (paths and names stay private).
pub fn plist(label: &str, engine: &Path, app: &Path, path_env: &str) -> String {
    let [label, engine, app, path_env] = [label, &engine.to_string_lossy(), &app.to_string_lossy(), path_env].map(escape);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{engine}</string>
		<string>service</string>
		<string>--app</string>
		<string>{app}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>{path_env}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>/dev/null</string>
</dict>
</plist>
"#
    )
}

fn domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    // Only launchd reads it; elsewhere `status` answers Unavailable, so nothing is set.
    #[cfg(not(unix))]
    let uid = 0;
    format!("gui/{uid}")
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let status = Command::new("/bin/launchctl").args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "launchctl could not run".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("launchctl refused the helper".into())
    }
}

fn expected(identifier: &str) -> Option<String> {
    let (app, engine) = bundle()?;
    let path_env = crate::engine::login_path().unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    Some(plist(&label(identifier), &engine, &app, &path_env))
}

#[cfg(target_os = "linux")]
pub use systemd::{refresh, set, status};

#[cfg(not(target_os = "linux"))]
pub fn status(identifier: &str, home: &Path) -> WakeService {
    if bundle().is_none() {
        return WakeService::Unavailable;
    }
    if plist_path(home, &label(identifier)).is_file() {
        WakeService::On
    } else {
        WakeService::Off
    }
}

#[cfg(not(target_os = "linux"))]
pub fn set(identifier: &str, home: &Path, on: bool) -> Result<WakeService, String> {
    let label = label(identifier);
    let path = plist_path(home, &label);
    let _ = launchctl(&["bootout", &format!("{}/{label}", domain())]);
    if !on {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("the helper's file could not be removed".into()),
        }
        return Ok(WakeService::Off);
    }
    let text = expected(identifier).ok_or("only the installed app can run after Quit")?;
    write_atomic(&path, text.as_bytes(), 0o644).map_err(|_| "the helper's file could not be written".to_string())?;
    if let Err(error) = launchctl(&["bootstrap", &domain(), &path.to_string_lossy()]) {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(WakeService::On)
}

/// An agent written for another copy of the app (moved, or a new PATH) is written again for this one.
#[cfg(not(target_os = "linux"))]
pub fn refresh(identifier: &str, home: &Path) {
    let Some(text) = expected(identifier) else { return };
    let path = plist_path(home, &label(identifier));
    match std::fs::read_to_string(&path) {
        Ok(current) if current != text => {
            let _ = set(identifier, home, true);
        }
        _ => {}
    }
}

#[cfg(target_os = "linux")]
const SERVICE_FLAG: &str = "--wake-service";

/// Started by the unit with `--wake-service`: becomes the engine's service, for this app. The
/// engine sits beside the binary in both the packages and the AppImage, whose mount point changes
/// on every launch, so the unit names only the app. Returns only when the engine could not start.
#[cfg(target_os = "linux")]
pub fn service_passthrough() -> Option<std::io::Error> {
    use std::os::unix::process::CommandExt;
    if std::env::args().nth(1).as_deref() != Some(SERVICE_FLAG) {
        return None;
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => return Some(error),
    };
    let engine = exe.parent().map(|dir| dir.join("runrail")).unwrap_or_default();
    let app = systemd::program(&exe);
    Some(Command::new(engine).arg("service").arg("--app").arg(app).stdin(Stdio::null()).exec())
}

#[cfg(target_os = "linux")]
mod systemd {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use super::{label, WakeService, SERVICE_FLAG};

    pub fn unit_path(config: &Path, identifier: &str) -> PathBuf {
        config.join("systemd").join("user").join(format!("{}.service", label(identifier)))
    }

    fn config_home(home: &Path) -> PathBuf {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or_else(|| home.join(".config"))
    }

    /// The AppImage file, or the installed binary.
    pub fn program(exe: &Path) -> PathBuf {
        std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|path| path.is_absolute() && path.is_file()).unwrap_or_else(|| exe.to_path_buf())
    }

    /// The installed app, with its engine beside it; a development build has none to keep running.
    fn installed() -> Option<PathBuf> {
        if cfg!(debug_assertions) {
            return None;
        }
        let exe = std::env::current_exe().ok()?;
        exe.parent()?.join("runrail").is_file().then(|| program(&exe))
    }

    /// One word of a unit's command line or environment: quoted, with `%` and `$` doubled so
    /// systemd expands neither.
    pub fn quote(text: &str) -> String {
        let mut out = String::from("\"");
        for ch in text.chars() {
            match ch {
                '"' | '\\' => {
                    out.push('\\');
                    out.push(ch);
                }
                '%' => out.push_str("%%"),
                '$' => out.push_str("$$"),
                _ => out.push(ch),
            }
        }
        out.push('"');
        out
    }

    /// Started at login and after a crash, at low priority, never logging (paths and names stay
    /// private).
    pub fn unit(app: &Path, path_env: &str) -> Option<String> {
        let app = app.to_str().filter(|app| !app.chars().any(char::is_control))?;
        if path_env.chars().any(char::is_control) {
            return None;
        }
        Some(format!(
            "[Unit]\nDescription=Runrail: opens Runrail when scheduled work is due after Quit\n\n[Service]\nExecStart={} {SERVICE_FLAG}\nEnvironment={}\nRestart=on-failure\nRestartSec=60\nNice=10\nIOSchedulingClass=idle\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n",
            quote(app),
            quote(&format!("PATH={path_env}"))
        ))
    }

    /// systemd's user manager runs for this login: its private socket is there.
    fn user_manager() -> bool {
        // SAFETY: getuid has no preconditions and cannot fail.
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));
        runtime.join("systemd").join("private").exists()
    }

    fn systemctl(args: &[&str]) -> Result<(), String> {
        let program = ["/usr/bin/systemctl", "/bin/systemctl"].into_iter().find(|path| Path::new(path).is_file()).ok_or("systemctl is missing")?;
        let status = Command::new(program).arg("--user").args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "systemctl could not run".to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("systemd refused the helper".into())
        }
    }

    fn expected() -> Option<String> {
        let path_env = crate::engine::login_path().unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into());
        unit(&installed()?, &path_env)
    }

    pub fn status(identifier: &str, home: &Path) -> WakeService {
        if installed().is_none() {
            WakeService::Unavailable
        } else if !user_manager() {
            WakeService::NoSystemd
        } else if unit_path(&config_home(home), identifier).is_file() {
            WakeService::On
        } else {
            WakeService::Off
        }
    }

    pub fn set(identifier: &str, home: &Path, on: bool) -> Result<WakeService, String> {
        let path = unit_path(&config_home(home), identifier);
        let name = format!("{}.service", label(identifier));
        if !on {
            let _ = systemctl(&["disable", "--now", &name]);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("the helper's file could not be removed".into()),
            }
            let _ = systemctl(&["daemon-reload"]);
            return Ok(WakeService::Off);
        }
        let text = expected().ok_or("only the installed app can run after Quit")?;
        if !user_manager() {
            return Err("this system does not run systemd's user services".into());
        }
        super::write_atomic(&path, text.as_bytes(), 0o644).map_err(|_| "the helper's file could not be written".to_string())?;
        if let Err(error) = systemctl(&["daemon-reload"]).and_then(|()| systemctl(&["enable", "--now", &name])) {
            let _ = std::fs::remove_file(&path);
            let _ = systemctl(&["daemon-reload"]);
            return Err(error);
        }
        Ok(WakeService::On)
    }

    /// A unit written for another copy of the app (moved, or a new PATH) is written again for this one.
    pub fn refresh(identifier: &str, home: &Path) {
        let Some(text) = expected() else { return };
        match std::fs::read_to_string(unit_path(&config_home(home), identifier)) {
            Ok(current) if current != text => {
                let _ = set(identifier, home, true);
            }
            _ => {}
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!(".{}.{}.tmp", path.file_name().and_then(|name| name.to_str()).unwrap_or("file"), std::process::id()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
        #[cfg(not(unix))]
        let _ = mode;
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn note_path(home: &Path) -> PathBuf {
    home.join(".runrail").join("service").join("app.json")
}

pub fn note(pid: Option<u32>, at: u128) -> String {
    match pid {
        Some(pid) => format!("{{\"pid\":{pid},\"at\":{at}}}\n"),
        None => format!("{{\"pid\":null,\"at\":{at}}}\n"),
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis())
}

fn write_note(home: &Path, pid: Option<u32>) {
    let path = note_path(home);
    if let Some(dir) = path.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        let _ = builder.create(dir);
    }
    let _ = write_atomic(&path, note(pid, now_ms()).as_bytes(), 0o600);
}

/// Says the app runs, now and every 30 seconds, from its own thread so a busy page cannot stop it.
pub fn start_notes(home: PathBuf) {
    let pid = std::process::id();
    write_note(&home, Some(pid));
    let _ = std::thread::Builder::new().name("runrail-wake-note".into()).spawn(move || loop {
        std::thread::sleep(NOTE_EVERY);
        write_note(&home, Some(pid));
    });
}

/// Says the app quit, so the service need not wait for the note to go stale.
pub fn note_quit(home: &Path) {
    write_note(home, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_runs_the_engines_service_for_this_app_and_logs_nothing() {
        let text = plist("com.runrail.desktop.wake", Path::new("/Applications/Run & Rail.app/Contents/MacOS/runrail"), Path::new("/Applications/Run & Rail.app"), "/opt/homebrew/bin:/usr/bin");
        assert!(text.contains("<string>com.runrail.desktop.wake</string>"));
        assert!(text.contains("<string>/Applications/Run &amp; Rail.app/Contents/MacOS/runrail</string>\n\t\t<string>service</string>\n\t\t<string>--app</string>\n\t\t<string>/Applications/Run &amp; Rail.app</string>"));
        assert!(text.contains("<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>"));
        assert_eq!(text.matches("<string>/dev/null</string>").count(), 2);
        assert!(!text.contains("& "));
        assert_eq!(plist_path(Path::new("/Users/a"), &label("com.runrail.desktop")), PathBuf::from("/Users/a/Library/LaunchAgents/com.runrail.desktop.wake.plist"));
    }

    #[test]
    fn the_note_says_who_runs_and_when() {
        assert_eq!(note(Some(42), 1_700_000_000_000), "{\"pid\":42,\"at\":1700000000000}\n");
        assert_eq!(note(None, 5), "{\"pid\":null,\"at\":5}\n");
        let home = std::env::temp_dir().join(format!("runrail-wake-test-{}", std::process::id()));
        write_note(&home, Some(7));
        let written = std::fs::read_to_string(note_path(&home)).unwrap();
        assert!(written.starts_with("{\"pid\":7,\"at\":"));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(note_path(&home)).unwrap().permissions().mode() & 0o777, 0o600);
        note_quit(&home);
        assert!(std::fs::read_to_string(note_path(&home)).unwrap().starts_with("{\"pid\":null,"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_unit_starts_the_app_as_the_service_quoted_and_logs_nothing() {
        let text = systemd::unit(Path::new("/home/a/Apps/Run Rail 100%.AppImage"), "/home/a/.local/bin:/usr/bin").unwrap();
        assert!(text.contains("\nExecStart=\"/home/a/Apps/Run Rail 100%%.AppImage\" --wake-service\n"));
        assert!(text.contains("\nEnvironment=\"PATH=/home/a/.local/bin:/usr/bin\"\n"));
        assert!(text.contains("\nRestart=on-failure\n") && text.contains("\nStandardOutput=null\nStandardError=null\n"));
        assert!(text.ends_with("[Install]\nWantedBy=default.target\n"));
        assert_eq!(systemd::quote("a\"b\\c$HOME%i"), "\"a\\\"b\\\\c$$HOME%%i\"");
        assert!(systemd::unit(Path::new("/opt/a\nb"), "/usr/bin").is_none());
        assert_eq!(systemd::unit_path(Path::new("/h/.config"), "com.runrail.desktop"), PathBuf::from("/h/.config/systemd/user/com.runrail.desktop.wake.service"));
        assert_eq!(serde_json::to_value(WakeService::NoSystemd).unwrap(), "no-systemd");
    }

    #[test]
    fn a_development_build_has_no_bundle_to_open() {
        assert!(bundle().is_none());
        assert_eq!(status("com.runrail.desktop", Path::new("/nowhere")), WakeService::Unavailable);
    }
}
