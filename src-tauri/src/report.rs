//! What "Report a problem" asks the host: this machine's system and architecture, and the engine's
//! `runrail doctor --json` cut down to each check's name and level, since a check's detail can name
//! folders on this machine. The page shows all of it before anything leaves.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::engine::Supervisor;
use crate::process;

const DOCTOR_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CHECKS: usize = 64;
const MAX_TEXT: usize = 80;
const LEVELS: [&str; 4] = ["ok", "warn", "fail", "off"];

pub fn facts(supervisor: &Supervisor) -> Value {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).filter(|path| path.is_absolute());
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "engine": doctor(supervisor).and_then(|stdout| doctor_summary(&stdout, home.as_deref())),
    })
}

fn doctor(supervisor: &Supervisor) -> Option<Vec<u8>> {
    let mut command = supervisor.job_command(&std::env::temp_dir()).ok()?;
    command.args(["doctor", "--json"]);
    // A failing check makes it exit 1; the checks are on stdout all the same.
    process::run(command, None, DOCTOR_TIMEOUT).ok().map(|ran| ran.stdout)
}

/// The engine's version and its checks' names and levels; every detail is dropped.
pub fn doctor_summary(stdout: &[u8], home: Option<&Path>) -> Option<Value> {
    let start = stdout.iter().position(|byte| *byte == b'{')?;
    let parsed = serde_json::Deserializer::from_slice(&stdout[start..]).into_iter::<Value>().next()?.ok()?;
    let version = parsed.get("version")?.as_str()?;
    let checks: Vec<Value> = parsed
        .get("checks")?
        .as_array()?
        .iter()
        .take(MAX_CHECKS)
        .filter_map(|check| {
            let name = check.get("name")?.as_str()?;
            let level = check.get("level")?.as_str().filter(|level| LEVELS.contains(level))?;
            Some(json!({ "name": bounded(&tilde(name, home)), "level": level }))
        })
        .collect();
    Some(json!({ "version": bounded(version), "checks": checks }))
}

fn tilde(text: &str, home: Option<&Path>) -> String {
    match home.and_then(Path::to_str).filter(|home| home.len() > 1) {
        Some(home) => text.replace(home, "~"),
        None => text.to_string(),
    }
}

fn bounded(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let mut command = std::process::Command::new("/usr/bin/sw_vers");
    command.arg("-productVersion");
    let ran = process::run(command, None, Duration::from_secs(5)).ok().filter(|ran| ran.ok)?;
    version_text(&String::from_utf8_lossy(&ran.stdout))
}

#[cfg(target_os = "linux")]
fn os_version() -> Option<String> {
    let release = std::fs::read_to_string("/etc/os-release").ok()?;
    let line = release.lines().find_map(|line| line.strip_prefix("PRETTY_NAME="))?;
    version_text(line.trim_matches('"'))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn os_version() -> Option<String> {
    None
}

/// A system name such as "15.6.1" or "Ubuntu 24.04.1 LTS", or nothing if it holds anything else.
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn version_text(text: &str) -> Option<String> {
    let text = text.trim();
    let plain = !text.is_empty() && text.len() <= 64 && text.chars().all(|char| char.is_ascii_alphanumeric() || " ._()+-".contains(char));
    plain.then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_names_and_levels_and_drops_every_detail() {
        let stdout = br#"{
  "version": "0.1.1",
  "checks": [
    { "name": "Runrail", "level": "ok", "detail": "0.1.1" },
    { "name": "Sign-ins folder", "level": "fail", "detail": "/Users/alice/.runrail/accounts cannot be written" },
    { "name": "Project /Users/alice/secret-app", "level": "warn", "detail": "~/secret-app is not a git repository" },
    { "name": "Odd", "level": "panic", "detail": "x" }
  ]
}
"#;
        let summary = doctor_summary(stdout, Some(Path::new("/Users/alice"))).unwrap();
        assert_eq!(
            summary,
            json!({ "version": "0.1.1", "checks": [
                { "name": "Runrail", "level": "ok" },
                { "name": "Sign-ins folder", "level": "fail" },
                { "name": "Project ~/secret-app", "level": "warn" },
            ] })
        );
        assert!(!summary.to_string().contains("detail"));
    }

    #[test]
    fn reads_past_anything_printed_before_the_json_and_refuses_what_is_not_it() {
        assert!(doctor_summary(b"note: warming up\n{\"version\":\"1\",\"checks\":[]}\n", None).is_some());
        assert!(doctor_summary(b"usage: runrail doctor", None).is_none());
        assert!(doctor_summary(b"{\"checks\":[]}", None).is_none());
    }

    #[test]
    fn a_system_version_is_plain_text_or_nothing() {
        assert_eq!(version_text("15.6.1\n"), Some("15.6.1".into()));
        assert_eq!(version_text("Ubuntu 24.04.1 LTS"), Some("Ubuntu 24.04.1 LTS".into()));
        assert_eq!(version_text("/home/alice"), None);
        assert_eq!(version_text(""), None);
    }
}
