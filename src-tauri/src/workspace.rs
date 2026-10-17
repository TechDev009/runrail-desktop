use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub git: bool,
}

/// Canonicalizes a workspace the renderer names. It must be a folder the person chose as a project
/// (`approvals`), or one inside it.
pub fn resolve_workspace(value: &str) -> BridgeResult<PathBuf> {
    let canonical = canonical_workspace(value)?;
    crate::approvals::check(&canonical)?;
    Ok(canonical)
}

/// Canonicalizes a folder. Must be an existing absolute directory other than `/`.
pub fn canonical_workspace(value: &str) -> BridgeResult<PathBuf> {
    let invalid = |message: &str| BridgeError::new("WORKSPACE_INVALID", message);
    if value.trim().is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(invalid("workspace path is invalid"));
    }
    let candidate = PathBuf::from(value);
    if !candidate.is_absolute() {
        return Err(invalid("workspace must be an absolute path"));
    }
    // Its own code: a thread whose folder was deleted (a removed worktree) is told so and offered Archive.
    let canonical = candidate
        .canonicalize()
        .map_err(|_| BridgeError::new("WORKSPACE_MISSING", "workspace does not exist"))?;
    if !canonical.is_dir() {
        return Err(invalid("workspace is not a directory"));
    }
    if canonical.parent().is_none() {
        return Err(invalid("workspace root is not allowed"));
    }
    Ok(canonical)
}

/// Creates `relative` under the canonical `root` and returns its real path; `None` when it cannot be
/// made or a link on the way leads out of the root.
pub fn create_dir_inside(root: &Path, relative: &Path) -> Option<PathBuf> {
    let mut dir = root.to_path_buf();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else { return None };
        dir.push(name);
        match std::fs::create_dir(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        // Checked before the next part is made, so nothing is created through a link out.
        dir = dir.canonicalize().ok().filter(|real| real.starts_with(root) && real.is_dir())?;
    }
    Some(dir)
}

pub fn inspect(path: &Path) -> WorkspaceInfo {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    WorkspaceInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        git: inside_git(path),
    }
}

fn inside_git(path: &Path) -> bool {
    path.ancestors().any(|dir| dir.join(".git").exists())
}

/// Identifiers for engines, sessions, and threads: short, portable, and safe as a directory name.
pub fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !value.contains("..")
}

pub fn require_id(value: &str, what: &str) -> BridgeResult<()> {
    if valid_id(value) {
        Ok(())
    } else {
        Err(BridgeError::new("CONTROL_INVALID_INPUT", format!("{what} is invalid")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_strict() {
        assert!(valid_id("thread-01H.abc_x"));
        assert!(!valid_id(""));
        assert!(!valid_id("-lead"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a..b"));
        assert!(!valid_id(&"a".repeat(65)));
    }

    #[test]
    fn workspace_rules() {
        assert!(canonical_workspace("relative").is_err());
        assert!(canonical_workspace("/").is_err());
        assert_eq!(canonical_workspace("/definitely/missing/path").unwrap_err().code, "WORKSPACE_MISSING");
        let dir = std::env::temp_dir();
        let resolved = canonical_workspace(dir.to_str().unwrap()).unwrap();
        assert!(resolved.is_absolute());
        assert_eq!(inspect(&resolved).path, resolved.to_string_lossy());
    }
}
