//! The login shells this system lists in `/etc/shells`, for the terminal shell setting. A shell
//! the renderer names is used only if it is one of them, so the setting cannot start any program.

use std::fs;
use std::path::Path;

const SHELLS_FILE: &str = "/etc/shells";

pub fn list() -> Vec<String> {
    list_from(Path::new(SHELLS_FILE))
}

fn list_from(file: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(file) else {
        return Vec::new();
    };
    let mut shells: Vec<String> = Vec::new();
    for line in text.lines().take(256).map(str::trim) {
        if line.starts_with('/') && line.len() <= 256 && !line.contains('\0') && Path::new(line).is_file() && !shells.iter().any(|shell| shell == line) {
            shells.push(line.to_string());
        }
    }
    shells
}

pub fn is_login_shell(path: &str) -> bool {
    list().iter().any(|shell| shell == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_existing_absolute_paths_once() {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-shells-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shells");
        let zsh = dir.join("zsh");
        fs::write(&zsh, "").unwrap();
        let zsh = zsh.to_string_lossy().into_owned();
        fs::write(&file, format!("# comment\n/bin/sh\n/bin/sh\n  {zsh} \nrelative\n/no/such/shell\n")).unwrap();
        assert_eq!(list_from(&file), vec!["/bin/sh".to_string(), zsh]);
        assert!(list_from(&dir.join("missing")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
