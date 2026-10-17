//! New apps from a starter, made by the engine's `runrail new` (the README's Nifra in Runrail): the
//! host runs it so the page never names a folder to write, and approves only the folder it made.

use serde_json::{json, Value};

use crate::error::{BridgeError, BridgeResult};

pub const STARTERS: [&str; 4] = ["nifra", "vite", "next", "empty"];

/// How long a starter may take: the creator, then the install, on a slow connection.
pub const CREATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(16 * 60);

/// npm's rule for a package name, which every creator applies to the folder name.
pub fn valid_app_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 214
        && bytes.next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn check_request(name: &str, starter: &str) -> BridgeResult<()> {
    if !valid_app_name(name) {
        return Err(BridgeError::new("STARTER_NAME_INVALID", "an app name uses lowercase letters, digits, \".\", \"_\", and \"-\", starting with a letter or digit"));
    }
    if !STARTERS.contains(&starter) {
        return Err(BridgeError::new("STARTER_UNKNOWN", "unknown starter"));
    }
    Ok(())
}

/// The engine's one JSON result: the last line of its output that parses as an object.
pub fn result_of(stdout: &[u8]) -> BridgeResult<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok().filter(Value::is_object))
        .ok_or_else(|| BridgeError::new("STARTER_FAILED", "the engine gave no result"))
}

/// A failure as the page shows it, with only the fields the engine is known to send.
pub fn failure_of(result: &Value) -> Value {
    let text = |key: &str, max: usize| result.get(key).and_then(Value::as_str).map(|value| value.chars().take(max).collect::<String>());
    json!({
        "ok": false,
        "code": text("code", 64).unwrap_or_else(|| "STARTER_FAILED".into()),
        "message": text("message", 500).unwrap_or_else(|| "the app could not be created".into()),
        "output": text("output", 16 * 1024),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_package_name_rule() {
        for name in ["shop", "my-app", "app.v2", "a_b", "9lives"] {
            assert!(valid_app_name(name), "{name}");
        }
        for name in ["", "My-App", "-app", ".app", "my app", "app/x", "../x"] {
            assert!(!valid_app_name(name), "{name}");
        }
        assert!(!valid_app_name(&"a".repeat(215)));
    }

    #[test]
    fn only_known_starters_are_run() {
        assert!(check_request("shop", "nifra").is_ok());
        assert_eq!(check_request("shop", "rails").unwrap_err().code, "STARTER_UNKNOWN");
        assert_eq!(check_request("Shop", "vite").unwrap_err().code, "STARTER_NAME_INVALID");
    }

    #[test]
    fn reads_the_last_json_line_and_keeps_known_failure_fields() {
        let result = result_of(b"Installing\n{\"ok\":false,\"code\":\"STARTER_TARGET_EXISTS\",\"message\":\"shop already exists\",\"extra\":1}\n").unwrap();
        let failure = failure_of(&result);
        assert_eq!(failure["code"], "STARTER_TARGET_EXISTS");
        assert_eq!(failure["message"], "shop already exists");
        assert!(failure.get("extra").is_none());
        assert!(result_of(b"no json here").is_err());
    }
}
