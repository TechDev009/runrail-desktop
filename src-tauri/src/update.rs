//! Signed in-app updates.
//!
//! The updater exists only in builds made with the `updater` feature, which release builds turn
//! on together with a release config carrying the update public key and feed URL (see
//! `docs/RELEASE.md`). Every downloaded bundle is verified against that key before it is
//! installed, and nothing is downloaded until the user asks to install. Other builds report
//! `unavailable` so the renderer can explain why there is nothing to check.

use serde::Serialize;

use crate::error::{BridgeError, BridgeResult};

/// Release notes are shown in a small panel; longer text is cut rather than rendered.
#[cfg(feature = "updater")]
const MAX_NOTES_CHARS: usize = 4_000;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state")]
#[cfg_attr(not(feature = "updater"), allow(dead_code))]
pub enum UpdateStatus {
    #[cfg_attr(feature = "updater", allow(dead_code))]
    Unavailable,
    Current {
        version: String,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        current: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
}

pub const fn enabled() -> bool {
    cfg!(feature = "updater")
}

#[cfg(feature = "updater")]
fn failed(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}

#[cfg(feature = "updater")]
fn clip(text: &str) -> String {
    match text.char_indices().nth(MAX_NOTES_CHARS) {
        Some((end, _)) => format!("{}\n[...]", &text[..end]),
        None => text.to_string(),
    }
}

#[cfg(feature = "updater")]
pub async fn check(app: &tauri::AppHandle) -> BridgeResult<UpdateStatus> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|_| failed("UPDATE_UNCONFIGURED", "this build has no update feed configured"))?;
    let current = app.package_info().version.to_string();
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus::Available {
            version: update.version.clone(),
            current,
            date: update
                .raw_json
                .get("pub_date")
                .and_then(|value| value.as_str())
                .filter(|value| value.len() <= 64)
                .map(str::to_string),
            notes: update.body.as_deref().map(clip).filter(|notes| !notes.trim().is_empty()),
        }),
        Ok(None) => Ok(UpdateStatus::Current { version: current }),
        Err(_) => Err(failed("UPDATE_CHECK_FAILED", "could not reach the update feed").with_status(502)),
    }
}

#[cfg(not(feature = "updater"))]
pub async fn check(_app: &tauri::AppHandle) -> BridgeResult<UpdateStatus> {
    Ok(UpdateStatus::Unavailable)
}

/// Downloads, verifies, and installs the newest update, then restarts into it. The engines are
/// stopped by the exit handler on restart, like on a normal quit.
#[cfg(feature = "updater")]
pub async fn install(app: &tauri::AppHandle) -> BridgeResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|_| failed("UPDATE_UNCONFIGURED", "this build has no update feed configured"))?;
    let update = updater
        .check()
        .await
        .map_err(|_| failed("UPDATE_CHECK_FAILED", "could not reach the update feed").with_status(502))?
        .ok_or_else(|| failed("UPDATE_NONE", "no update is available").with_status(404))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| failed("UPDATE_INSTALL_FAILED", "the update could not be downloaded or verified").with_status(502))?;
    app.restart()
}

#[cfg(not(feature = "updater"))]
pub async fn install(_app: &tauri::AppHandle) -> BridgeResult<()> {
    Err(BridgeError::new("UPDATE_UNAVAILABLE", "this build does not update itself").with_status(501))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_with_a_state_tag() {
        let available = UpdateStatus::Available {
            version: "0.2.0".into(),
            current: "0.1.0".into(),
            date: None,
            notes: Some("Fixes".into()),
        };
        assert_eq!(
            serde_json::to_value(&available).unwrap(),
            serde_json::json!({ "state": "available", "version": "0.2.0", "current": "0.1.0", "notes": "Fixes" })
        );
        assert_eq!(serde_json::to_value(&UpdateStatus::Unavailable).unwrap(), serde_json::json!({ "state": "unavailable" }));
    }

    #[cfg(feature = "updater")]
    #[test]
    fn notes_are_clipped_on_a_char_boundary() {
        let long = "é".repeat(MAX_NOTES_CHARS + 10);
        let clipped = clip(&long);
        assert!(clipped.ends_with("\n[...]"));
        assert_eq!(clipped.chars().count(), MAX_NOTES_CHARS + 6);
    }
}
