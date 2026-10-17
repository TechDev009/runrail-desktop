//! A project's `AGENTS.md`: the instructions every engine started in the project reads. The
//! renderer names the project folder; the host fixes the file name, refuses links and anything
//! but a plain file, and bounds the text to what the engine will read.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;

use crate::error::{BridgeError, BridgeResult};
use crate::workspace::resolve_workspace;

pub const INSTRUCTIONS_FILE: &str = "AGENTS.md";
/// The engine reads at most this much of a context file.
pub const MAX_INSTRUCTIONS_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructions {
    pub exists: bool,
    pub text: String,
    /// The project also has a `CLAUDE.md`, which the engine reads as well.
    pub claude_file: bool,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("INSTRUCTIONS_INVALID", message)
}

fn unavailable() -> BridgeError {
    BridgeError::new("INSTRUCTIONS_UNAVAILABLE", "project instructions could not be read or saved")
}

/// A path that exists must be a plain file; a link could point the write outside the project.
fn plain_file(path: &Path) -> BridgeResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(true),
        Ok(_) => Err(invalid("AGENTS.md is a link or a folder; edit it in your editor")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unavailable()),
    }
}

pub fn read(workspace: &str) -> BridgeResult<ProjectInstructions> {
    let root = resolve_workspace(workspace)?;
    let path = root.join(INSTRUCTIONS_FILE);
    let claude_file = root.join("CLAUDE.md").is_file();
    if !plain_file(&path)? {
        return Ok(ProjectInstructions { exists: false, text: String::new(), claude_file });
    }
    let bytes = fs::read(&path).map_err(|_| unavailable())?;
    if bytes.len() > MAX_INSTRUCTIONS_BYTES {
        return Err(invalid("AGENTS.md is larger than the agent reads; edit it in your editor"));
    }
    let text = String::from_utf8(bytes).map_err(|_| invalid("AGENTS.md is not text"))?;
    Ok(ProjectInstructions { exists: true, text, claude_file })
}

pub fn write(workspace: &str, text: &str) -> BridgeResult<ProjectInstructions> {
    if text.len() > MAX_INSTRUCTIONS_BYTES {
        return Err(invalid("instructions are longer than the agent reads"));
    }
    if text.contains('\0') {
        return Err(invalid("instructions are not text"));
    }
    let root = resolve_workspace(workspace)?;
    let path = root.join(INSTRUCTIONS_FILE);
    let existed = plain_file(&path)?;
    let (temp, mut file) = crate::store::create_temp(&root, INSTRUCTIONS_FILE).map_err(|_| unavailable())?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        // An existing file keeps its mode; a new one is readable like any file in a repository.
        let permissions = if existed { fs::metadata(&path)?.permissions() } else { default_permissions(&file)? };
        fs::set_permissions(&temp, permissions)?;
        fs::rename(&temp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(unavailable());
    }
    read(workspace)
}

#[cfg(unix)]
fn default_permissions(_file: &fs::File) -> std::io::Result<fs::Permissions> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::Permissions::from_mode(0o644))
}

#[cfg(not(unix))]
fn default_permissions(file: &fs::File) -> std::io::Result<fs::Permissions> {
    Ok(file.metadata()?.permissions())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-instructions-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn reads_writes_and_keeps_the_mode() {
        let dir = temp_dir("round");
        let workspace = dir.to_str().unwrap();
        assert_eq!(read(workspace).unwrap(), ProjectInstructions { exists: false, text: String::new(), claude_file: false });
        let saved = write(workspace, "Use pnpm.\n").unwrap();
        assert!(saved.exists);
        assert_eq!(fs::read_to_string(dir.join("AGENTS.md")).unwrap(), "Use pnpm.\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join("AGENTS.md")).unwrap().permissions().mode() & 0o777, 0o644);
            fs::set_permissions(dir.join("AGENTS.md"), fs::Permissions::from_mode(0o640)).unwrap();
            write(workspace, "Use bun.\n").unwrap();
            assert_eq!(fs::metadata(dir.join("AGENTS.md")).unwrap().permissions().mode() & 0o777, 0o640);
        }
        fs::write(dir.join("CLAUDE.md"), "x").unwrap();
        assert!(read(workspace).unwrap().claude_file);
        assert!(!fs::read_dir(&dir).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_links_large_text_and_bad_folders() {
        let dir = temp_dir("refuse");
        let workspace = dir.to_str().unwrap();
        assert!(write(workspace, &"x".repeat(MAX_INSTRUCTIONS_BYTES + 1)).is_err());
        assert!(write(workspace, "a\0b").is_err());
        assert!(write("relative/path", "x").is_err());
        assert!(read("/").is_err());
        #[cfg(unix)]
        {
            let outside = temp_dir("outside");
            fs::write(outside.join("target.md"), "secret").unwrap();
            std::os::unix::fs::symlink(outside.join("target.md"), dir.join("AGENTS.md")).unwrap();
            assert!(read(workspace).is_err());
            assert!(write(workspace, "overwrite").is_err());
            assert_eq!(fs::read_to_string(outside.join("target.md")).unwrap(), "secret");
            let _ = fs::remove_dir_all(&outside);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
