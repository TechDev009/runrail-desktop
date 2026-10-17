//! Desktop UI state (workspaces, thread index, titles, preferences). Holds local metadata the
//! user controls; never prompts, tool payloads, credentials, or model output.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::error::{BridgeError, BridgeResult};

pub const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const STATE_FILE: &str = "desktop-state.json";

fn storage_error() -> BridgeError {
    BridgeError::new("STATE_UNAVAILABLE", "desktop state could not be saved")
}

pub fn state_path(app_data: &Path) -> PathBuf {
    app_data.join(STATE_FILE)
}

/// Loads the state file. A missing or corrupt file yields `None` so the UI starts fresh; a
/// corrupt file is moved aside instead of being silently overwritten.
pub fn load(app_data: &Path) -> BridgeResult<Option<Value>> {
    let path = state_path(app_data);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(BridgeError::new("STATE_UNAVAILABLE", "desktop state could not be read")),
    };
    let parsed = (bytes.len() <= MAX_STATE_BYTES)
        .then(|| serde_json::from_slice::<Value>(&bytes).ok())
        .flatten()
        .filter(Value::is_object);
    if parsed.is_none() {
        let _ = fs::rename(&path, app_data.join(format!("{STATE_FILE}.corrupt")));
    }
    Ok(parsed)
}

pub fn save(app_data: &Path, value: &Value) -> BridgeResult<()> {
    if !value.is_object() {
        return Err(BridgeError::new("STATE_INVALID", "desktop state must be an object"));
    }
    let bytes = serde_json::to_vec(value).map_err(|_| BridgeError::new("STATE_INVALID", "desktop state cannot be encoded"))?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(BridgeError::new("STATE_LIMIT", "desktop state is too large"));
    }
    write_atomic(&state_path(app_data), &bytes)
}

/// Writes through a sibling temp file and rename so readers never see a partial file. Writes are
/// one at a time, so two saves of one file cannot interleave.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> BridgeResult<()> {
    static WRITING: Mutex<()> = Mutex::new(());
    let _writing = WRITING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let parent = path.parent().ok_or_else(storage_error)?;
    fs::create_dir_all(parent).map_err(|_| storage_error())?;
    let name = path.file_name().ok_or_else(storage_error)?.to_string_lossy();
    let (temp, mut file) = create_temp(parent, &name).map_err(|_| storage_error())?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(storage_error());
    }
    Ok(())
}

/// A new, owner-only temp file beside `name` in `parent`, under a name no other writer can guess or
/// have planted: it is created exclusively and never through a symlink.
pub fn create_temp(parent: &Path, name: &str) -> std::io::Result<(PathBuf, fs::File)> {
    let mut last = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
    for _ in 0..8 {
        let temp = parent.join(format!(".{name}.{}.tmp", random_suffix()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

fn random_suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos()));
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_and_bounds() {
        let dir = temp_dir("round");
        assert_eq!(load(&dir).unwrap(), None);
        save(&dir, &json!({ "version": 1, "threads": [] })).unwrap();
        assert_eq!(load(&dir).unwrap(), Some(json!({ "version": 1, "threads": [] })));
        assert!(save(&dir, &json!([1, 2])).is_err());
        let big = "x".repeat(MAX_STATE_BYTES);
        assert!(save(&dir, &json!({ "big": big })).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saves_from_many_threads_all_land_whole() {
        let dir = temp_dir("concurrent");
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let dir = dir.clone();
                std::thread::spawn(move || (0..20).all(|round| save(&dir, &json!({ "writer": writer, "round": round })).is_ok()))
            })
            .collect();
        assert!(writers.into_iter().all(|writer| writer.join().unwrap()));
        assert!(load(&dir).unwrap().is_some());
        assert!(!fs::read_dir(&dir).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_temp_file_is_new_private_and_never_a_planted_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("temp");
        let (first, _) = create_temp(&dir, "state.json").unwrap();
        let (second, _) = create_temp(&dir, "state.json").unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = temp_dir("corrupt");
        fs::write(state_path(&dir), b"{not json").unwrap();
        assert_eq!(load(&dir).unwrap(), None);
        assert!(dir.join("desktop-state.json.corrupt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
