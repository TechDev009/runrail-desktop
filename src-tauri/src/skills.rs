//! Copies a skill folder the person picked in the system's own folder dialog into the project's
//! `.agents/skills`, where the engine finds project skills. The renderer never names the source:
//! the host opens the dialog. Links, oversized folders, and folders without a `SKILL.md` are
//! refused, and nothing in the project changes unless the whole copy succeeds.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{BridgeError, BridgeResult};
use crate::workspace::{create_dir_inside, resolve_workspace};

const SKILLS_DIR: &str = ".agents/skills";
const MAX_FILES: usize = 64;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SKILL_FILE: u64 = 256 * 1024;
const MAX_DEPTH: usize = 4;
/// Left behind by Finder or version control; never part of a skill.
const SKIPPED: [&str; 2] = [".DS_Store", ".git"];

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSkill {
    pub name: String,
    /// Where it now lives, relative to the project.
    pub path: String,
    pub files: usize,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("SKILL_INVALID", message)
}

fn unavailable() -> BridgeError {
    BridgeError::new("SKILL_UNAVAILABLE", "the skill could not be copied")
}

/// A folder name a person would recognise, in the letters a skill id uses.
fn skill_name(source: &Path) -> String {
    let raw = source.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let mut name = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    let name = name.trim_end_matches('-').chars().take(64).collect::<String>();
    if name.is_empty() { "skill".into() } else { name }
}

/// Every file to copy, relative to `root`, after checking the folder's shape and size.
fn plan(root: &Path) -> BridgeResult<Vec<PathBuf>> {
    let skill = root.join("SKILL.md");
    match fs::symlink_metadata(&skill) {
        Ok(meta) if meta.file_type().is_file() && meta.len() <= MAX_SKILL_FILE => {}
        Ok(meta) if meta.file_type().is_file() => return Err(invalid("SKILL.md is larger than the agent reads")),
        _ => return Err(invalid("the folder has no SKILL.md")),
    }
    if fs::read_to_string(&skill).is_err() {
        return Err(invalid("SKILL.md is not text"));
    }
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut pending = vec![(PathBuf::new(), 0usize)];
    while let Some((relative, depth)) = pending.pop() {
        let entries = fs::read_dir(root.join(&relative)).map_err(|_| unavailable())?;
        for entry in entries {
            let entry = entry.map_err(|_| unavailable())?;
            let name = entry.file_name();
            if SKIPPED.iter().any(|skipped| name == *skipped) {
                continue;
            }
            let path = relative.join(&name);
            let kind = entry.file_type().map_err(|_| unavailable())?;
            if kind.is_symlink() {
                return Err(invalid("the folder contains a link; copy the files themselves"));
            }
            if kind.is_dir() {
                if depth + 1 >= MAX_DEPTH {
                    return Err(invalid("the folder nests too deeply"));
                }
                pending.push((path, depth + 1));
            } else if kind.is_file() {
                total += entry.metadata().map_err(|_| unavailable())?.len();
                files.push(path);
                if files.len() > MAX_FILES || total > MAX_BYTES {
                    return Err(invalid("the folder is larger than a skill should be (64 files, 2 MB)"));
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

pub fn import(workspace: &str, source: &Path) -> BridgeResult<ImportedSkill> {
    let project = resolve_workspace(workspace)?;
    let source = source.canonicalize().map_err(|_| invalid("the folder could not be read"))?;
    if !source.is_dir() {
        return Err(invalid("choose a folder"));
    }
    let skills = project.join(SKILLS_DIR);
    if source.starts_with(&skills) {
        return Err(BridgeError::new("SKILL_EXISTS", "this skill is already in the project"));
    }
    let files = plan(&source)?;
    let name = skill_name(&source);
    let target = skills.join(&name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(BridgeError::new("SKILL_EXISTS", "the project already has a skill with this name"));
    }
    let skills = create_dir_inside(&project, Path::new(SKILLS_DIR)).ok_or_else(unavailable)?;
    let target = skills.join(&name);
    let staging = skills.join(format!(".{name}.import-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let copied = (|| -> std::io::Result<()> {
        for file in &files {
            let destination = staging.join(file);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source.join(file), &destination)?;
        }
        fs::rename(&staging, &target)
    })();
    if copied.is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err(unavailable());
    }
    Ok(ImportedSkill { name: name.clone(), path: format!("{SKILLS_DIR}/{name}"), files: files.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-skills-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_a_skill_folder_into_the_project() {
        let dir = temp("copy");
        let project = dir.join("project");
        let source = dir.join("Release Notes!");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(source.join("templates")).unwrap();
        fs::write(source.join("SKILL.md"), "---\nname: release-notes\n---\nWrite notes.").unwrap();
        fs::write(source.join("templates/notes.md"), "# Notes").unwrap();
        fs::write(source.join(".DS_Store"), "x").unwrap();
        let imported = import(project.to_str().unwrap(), &source).unwrap();
        assert_eq!(imported, ImportedSkill { name: "release-notes".into(), path: ".agents/skills/release-notes".into(), files: 2 });
        let target = project.join(".agents/skills/release-notes");
        assert_eq!(fs::read_to_string(target.join("templates/notes.md")).unwrap(), "# Notes");
        assert!(!target.join(".DS_Store").exists());
        assert_eq!(import(project.to_str().unwrap(), &source).unwrap_err().code, "SKILL_EXISTS");
        assert_eq!(import(project.to_str().unwrap(), &target).unwrap_err().code, "SKILL_EXISTS");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_skills_folder_linked_out_of_the_project_is_not_written() {
        let dir = temp("linked-out");
        let project = dir.join("project");
        let outside = dir.join("outside");
        let source = dir.join("notes");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "skill").unwrap();
        std::os::unix::fs::symlink(&outside, project.join(".agents")).unwrap();
        assert!(import(project.to_str().unwrap(), &source).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_folders_that_are_not_skills() {
        let dir = temp("refuse");
        let project = dir.join("project");
        fs::create_dir_all(&project).unwrap();
        let empty = dir.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(import(project.to_str().unwrap(), &empty).unwrap_err().code, "SKILL_INVALID");

        let linked = dir.join("linked");
        fs::create_dir_all(&linked).unwrap();
        fs::write(linked.join("SKILL.md"), "skill").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", linked.join("hosts")).unwrap();
            assert_eq!(import(project.to_str().unwrap(), &linked).unwrap_err().code, "SKILL_INVALID");
        }

        let large = dir.join("large");
        fs::create_dir_all(&large).unwrap();
        fs::write(large.join("SKILL.md"), "skill").unwrap();
        for index in 0..=MAX_FILES {
            fs::write(large.join(format!("file-{index}.txt")), "x").unwrap();
        }
        assert_eq!(import(project.to_str().unwrap(), &large).unwrap_err().code, "SKILL_INVALID");
        assert!(!project.join(".agents/skills/large").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
