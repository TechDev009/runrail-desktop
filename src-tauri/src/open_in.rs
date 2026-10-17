//! "Open in" on Linux: the file manager, terminals and editors found on this
//! computer, each started with the folder or file only. The renderer names one of the fixed ids
//! below, never a program or arguments, and only the ones installed are offered.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{BridgeError, BridgeResult};

/// Each id with the commands that start it, the first one found winning. JetBrains IDEs come as
/// Toolbox launcher scripts or as snaps.
const APPS: [(&str, &[&str]); 23] = [
    ("vscode", &["code"]),
    ("cursor", &["cursor"]),
    ("zed", &["zed", "zeditor"]),
    ("idea", &["idea", "intellij-idea-ultimate", "intellij-idea-community"]),
    ("pycharm", &["pycharm", "pycharm-professional", "pycharm-community"]),
    ("webstorm", &["webstorm"]),
    ("goland", &["goland"]),
    ("clion", &["clion"]),
    ("rustrover", &["rustrover"]),
    ("phpstorm", &["phpstorm"]),
    ("rider", &["rider"]),
    ("rubymine", &["rubymine"]),
    ("files", &["xdg-open"]),
    ("terminal", &["x-terminal-emulator"]),
    ("gnome-terminal", &["gnome-terminal"]),
    ("gnome-console", &["kgx"]),
    ("ptyxis", &["ptyxis"]),
    ("konsole", &["konsole"]),
    ("xfce4-terminal", &["xfce4-terminal"]),
    ("ghostty", &["ghostty"]),
    ("kitty", &["kitty"]),
    ("wezterm", &["wezterm"]),
    ("alacritty", &["alacritty"]),
];

/// Folders a launcher may be in without being on the login shell's PATH.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/snap/bin")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute()) {
        dirs.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
        dirs.push(home.join(".local/bin"));
    }
    dirs
}

fn find(name: &str) -> Option<PathBuf> {
    crate::engine::find_on_path(name).or_else(|| extra_dirs().into_iter().map(|dir| dir.join(name)).find(|path| path.is_file()))
}

fn program(id: &str) -> Option<PathBuf> {
    let (_, commands) = APPS.iter().find(|(known, _)| *known == id)?;
    commands.iter().find_map(|command| find(command))
}

/// The ids installed here, in menu order.
pub fn available() -> Vec<&'static str> {
    APPS.iter().filter(|(id, _)| program(id).is_some()).map(|(id, _)| *id).collect()
}

/// What each program is given: terminals a working folder in their own flag, the rest the path.
pub fn args(id: &str, target: &Path) -> Vec<OsString> {
    let flag = |prefix: &str| {
        let mut joined = OsString::from(prefix);
        joined.push(target);
        joined
    };
    match id {
        "gnome-terminal" | "gnome-console" | "xfce4-terminal" | "ghostty" => vec![flag("--working-directory=")],
        "ptyxis" => vec!["--new-window".into(), flag("--working-directory=")],
        "konsole" => vec!["--workdir".into(), target.into()],
        "kitty" => vec!["--directory".into(), target.into()],
        "wezterm" => vec!["start".into(), "--cwd".into(), target.into()],
        "alacritty" => vec!["--working-directory".into(), target.into()],
        "terminal" => Vec::new(),
        _ => vec![target.into()],
    }
}

pub fn open(id: &str, target: &Path) -> BridgeResult<()> {
    if !APPS.iter().any(|(known, _)| *known == id) {
        return Err(BridgeError::new("EDITOR_UNSUPPORTED", "editor is not supported"));
    }
    let program = program(id).ok_or_else(|| BridgeError::new("EDITOR_UNAVAILABLE", "editor is not installed"))?;
    let mut command = Command::new(program);
    command.args(args(id, target)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // A terminal opened without a flag (x-terminal-emulator) starts where it is started.
    if target.is_dir() {
        command.current_dir(target);
    }
    let mut child = command.spawn().map_err(|_| BridgeError::new("OPEN_FAILED", "could not open the editor"))?;
    let _ = std::thread::Builder::new().name("runrail-open-in".into()).spawn(move || child.wait());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminals_get_the_folder_in_their_own_flag_and_editors_the_path() {
        let target = Path::new("/home/a/my project");
        let strings = |id: &str| args(id, target).into_iter().map(|arg| arg.into_string().unwrap()).collect::<Vec<_>>();
        assert_eq!(strings("gnome-terminal"), ["--working-directory=/home/a/my project"]);
        assert_eq!(strings("konsole"), ["--workdir", "/home/a/my project"]);
        assert_eq!(strings("wezterm"), ["start", "--cwd", "/home/a/my project"]);
        assert_eq!(strings("kitty"), ["--directory", "/home/a/my project"]);
        assert!(strings("terminal").is_empty());
        assert_eq!(strings("vscode"), ["/home/a/my project"]);
        assert_eq!(strings("idea"), ["/home/a/my project"]);
        assert_eq!(open("rm", target).unwrap_err().code, "EDITOR_UNSUPPORTED");
    }
}
