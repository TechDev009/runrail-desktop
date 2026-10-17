//! The folders the person chose as projects. Every folder the renderer names is checked against
//! them (`workspace::resolve_workspace`), so a page that runs someone else's script still cannot
//! point an engine, an editor, or a file write at a folder the person never picked.
//!
//! A folder is approved when the person picks it in the system's folder dialog. The folders the
//! host makes itself (thread worktrees, the system engine's folder) and the engines' eval
//! checkouts (`~/.runrail/evals`, whose turns this app runs) need no approval. The first
//! start with this list approves the projects already saved, once; after that the saved projects
//! are the renderer's to edit and grant nothing.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::error::{BridgeError, BridgeResult};
use crate::store;

const FILE: &str = "approved-folders.json";
const MAX_FOLDERS: usize = 1000;

static APPROVALS: OnceLock<Approvals> = OnceLock::new();

pub struct Approvals {
    file: PathBuf,
    own: Vec<PathBuf>,
    folders: Mutex<Vec<PathBuf>>,
}

impl Approvals {
    pub fn open(app_data: &Path) -> Approvals {
        Approvals::open_for(app_data, std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute()).as_deref())
    }

    /// `home` is the engines' home folder, where an eval checks out each case (engine `evals/run.ts`).
    fn open_for(app_data: &Path, home: Option<&Path>) -> Approvals {
        let app_data = app_data.canonicalize().unwrap_or_else(|_| app_data.to_path_buf());
        let file = app_data.join(FILE);
        let folders = match std::fs::read(&file) {
            Ok(bytes) => parse(&bytes).unwrap_or_else(|| {
                let _ = std::fs::rename(&file, app_data.join(format!("{FILE}.corrupt")));
                let _ = write(&file, &[]);
                Vec::new()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let saved = saved_projects(&app_data);
                let _ = write(&file, &saved);
                saved
            }
            Err(_) => Vec::new(),
        };
        let mut own = vec![app_data.join("worktrees"), app_data.join("system").join("workspace")];
        if let Some(home) = home {
            own.push(home.canonicalize().unwrap_or_else(|_| home.to_path_buf()).join(".runrail").join("evals"));
        }
        Approvals { file, own, folders: Mutex::new(folders) }
    }

    /// Whether `canonical` is an approved folder, a folder inside one, or a folder the host made.
    pub fn allows(&self, canonical: &Path) -> bool {
        self.own.iter().any(|own| canonical.starts_with(own))
            || self.folders.lock().is_ok_and(|folders| folders.iter().any(|folder| canonical.starts_with(folder)))
    }

    pub fn approve(&self, canonical: &Path) -> BridgeResult<()> {
        let mut folders = self.folders.lock().map_err(|_| unavailable())?;
        if folders.iter().any(|folder| folder == canonical) {
            return Ok(());
        }
        if folders.len() >= MAX_FOLDERS {
            folders.remove(0);
        }
        folders.push(canonical.to_path_buf());
        write(&self.file, &folders)
    }
}

/// Opens the list for this app's data folder. Called once, before the page loads.
pub fn init(app_data: &Path) {
    let _ = APPROVALS.set(Approvals::open(app_data));
}

pub fn approve(canonical: &Path) -> BridgeResult<()> {
    APPROVALS.get().ok_or_else(unavailable)?.approve(canonical)
}

pub fn check(canonical: &Path) -> BridgeResult<()> {
    let allowed = match APPROVALS.get() {
        Some(approvals) => approvals.allows(canonical),
        // Unit tests drive commands without starting the app.
        None => cfg!(test),
    };
    if allowed {
        Ok(())
    } else {
        Err(BridgeError::new("WORKSPACE_NOT_APPROVED", "this folder was not chosen as a project; open it with Add project").with_status(403))
    }
}

fn unavailable() -> BridgeError {
    BridgeError::new("WORKSPACE_NOT_APPROVED", "approved folders are unavailable")
}

fn parse(bytes: &[u8]) -> Option<Vec<PathBuf>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    value["folders"].as_array()?.iter().map(|folder| folder.as_str().map(PathBuf::from).filter(|path| path.is_absolute())).collect()
}

fn write(file: &Path, folders: &[PathBuf]) -> BridgeResult<()> {
    let list: Vec<String> = folders.iter().map(|folder| folder.to_string_lossy().into_owned()).collect();
    store::write_atomic(file, json!({ "version": 1, "folders": list }).to_string().as_bytes())
}

fn saved_projects(app_data: &Path) -> Vec<PathBuf> {
    let Ok(Some(state)) = store::load(app_data) else {
        return Vec::new();
    };
    let mut folders: Vec<PathBuf> = Vec::new();
    for project in state["projects"].as_array().into_iter().flatten() {
        let Some(path) = project["path"].as_str().map(PathBuf::from).filter(|path| path.is_absolute()) else {
            continue;
        };
        let Some(real) = path.canonicalize().ok().filter(|real| real.is_dir() && real.parent().is_some()) else {
            continue;
        };
        if !folders.contains(&real) && folders.len() < MAX_FOLDERS {
            folders.push(real);
        }
    }
    folders
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-approvals-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn saved_projects_are_approved_once_and_later_edits_grant_nothing() {
        let root = scratch("grandfather");
        let (data, project, later) = (root.join("data"), root.join("project"), root.join("later"));
        for dir in [&data, &project, &later] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let state = |paths: &[&Path]| json!({ "projects": paths.iter().map(|path| json!({ "path": path })).collect::<Vec<_>>() });
        store::save(&data, &state(&[&project, Path::new("/"), Path::new("relative"), &root.join("missing")])).unwrap();
        let approvals = Approvals::open(&data);
        assert!(approvals.allows(&project));
        assert!(approvals.allows(&project.join("src")), "folders inside a project are part of it");
        assert!(!approvals.allows(Path::new("/")));
        assert!(!approvals.allows(&root));

        store::save(&data, &state(&[&project, &later])).unwrap();
        let reopened = Approvals::open(&data);
        assert!(reopened.allows(&project));
        assert!(!reopened.allows(&later), "a project the page saves afterwards is not approved");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_picked_folder_stays_approved_and_the_hosts_own_folders_need_none() {
        let root = scratch("pick");
        let (data, picked, sibling) = (root.join("data"), root.join("picked"), root.join("picked-not"));
        for dir in [&data, &picked, &sibling] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let approvals = Approvals::open(&data);
        assert!(!approvals.allows(&picked));
        approvals.approve(&picked).unwrap();
        approvals.approve(&picked).unwrap();
        assert!(approvals.allows(&picked));
        assert!(!approvals.allows(&sibling), "a name that only starts the same is another folder");
        assert!(approvals.allows(&data.join("worktrees").join("thread-1")));
        assert!(approvals.allows(&data.join("system").join("workspace")));
        assert!(!approvals.allows(&data), "the data folder itself holds the vault");
        assert!(!approvals.allows(&data.join("threads")));

        let reopened = Approvals::open(&data);
        assert!(reopened.allows(&picked));
        assert_eq!(parse(&std::fs::read(data.join(FILE)).unwrap()).unwrap(), vec![picked.clone()]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_eval_checkout_in_the_engines_home_needs_no_approval() {
        let root = scratch("evals");
        let (data, home) = (root.join("data"), root.join("home"));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let approvals = Approvals::open_for(&data, Some(&home));
        assert!(approvals.allows(&home.join(".runrail").join("evals").join("0123abcd").join("eval-1").join("work").join("ev-1-0")));
        assert!(!approvals.allows(&home.join(".runrail")), "the rest of the engines' folder still needs a pick");
        assert!(!approvals.allows(&home.join(".runrail").join("evals-other")));
        assert!(!approvals.allows(&home));
        assert!(!Approvals::open_for(&data, None).allows(&home.join(".runrail").join("evals").join("x")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_corrupt_list_is_moved_aside_and_approves_nothing() {
        let root = scratch("corrupt");
        let (data, project) = (root.join("data"), root.join("project"));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        store::save(&data, &json!({ "projects": [{ "path": project }] })).unwrap();
        std::fs::write(data.join(FILE), b"{ not json").unwrap();
        let approvals = Approvals::open(&data);
        assert!(!approvals.allows(&project), "a broken list does not fall back to the saved projects");
        assert!(data.join(format!("{FILE}.corrupt")).exists());
        assert!(!Approvals::open(&data).allows(&project), "nor on the start after");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
