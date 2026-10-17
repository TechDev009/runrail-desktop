//! Remote machines over SSH: a project can live on another machine the person
//! reaches with `ssh`, using their own ~/.ssh config and keys, which this side never reads. Each
//! thread's engine is started there in its login shell and reached through a port forward on the
//! thread's own SSH connection. The host owns the list of machines: the renderer names one by id,
//! and a machine or engine command is saved only after the person confirms it in a native dialog.
//! Provider keys never leave this Mac, so a remote thread runs on what is signed in over there.

use std::fs;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{BridgeError, BridgeResult};
use crate::store::write_atomic;

const FILE: &str = "remotes.json";
pub const MAX_REMOTES: usize = 16;
pub const DEFAULT_ENGINE: &str = "runrail";
const MAX_SSH_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_CONFIG_HOSTS: usize = 100;
const CHECK_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_CHECK_OUTPUT: usize = 4 * 1024;

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Remote {
    pub id: String,
    /// An alias from ~/.ssh/config, a host name, or `user@host`, as `ssh` takes it.
    pub host: String,
    /// How the remote's login shell starts Runrail's engine; `runrail` unless set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

impl Remote {
    pub fn engine(&self) -> &str {
        self.engine.as_deref().unwrap_or(DEFAULT_ENGINE)
    }
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("REMOTE_INVALID", message)
}

fn unavailable() -> BridgeError {
    BridgeError::new("REMOTE_UNAVAILABLE", "remote machines could not be read or saved")
}

/// What `ssh` takes as a destination, and nothing it could read as an option.
pub fn valid_host(host: &str) -> bool {
    let bytes = host.as_bytes();
    !bytes.is_empty() && bytes.len() <= 253 && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@'))
}

/// A program and its plain arguments, such as `~/.bun/bin/runrail`; no shell syntax.
pub fn valid_engine(engine: &str) -> bool {
    let bytes = engine.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 300
        && bytes[0] != b'-'
        && engine.trim() == engine
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'.' | b'_' | b'/' | b'~' | b'+' | b'=' | b':' | b'@' | b',' | b'-'))
}

/// An absolute path on the remote machine.
pub fn valid_remote_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= 4096 && !path.chars().any(char::is_control)
}

fn valid_id(id: &str) -> bool {
    id.len() <= 40 && id.starts_with("rm-") && id[3..].bytes().all(|byte| byte.is_ascii_alphanumeric()) && id.len() > 3
}

/// One word for a POSIX shell.
pub fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub struct RemoteStore {
    path: PathBuf,
}

impl RemoteStore {
    pub fn new(app_data: &Path) -> Self {
        Self { path: app_data.join(FILE) }
    }

    pub fn list(&self) -> Vec<Remote> {
        let Ok(bytes) = fs::read(&self.path) else { return Vec::new() };
        let Ok(list) = serde_json::from_slice::<Vec<Remote>>(&bytes) else { return Vec::new() };
        list.into_iter().filter(|remote| valid_id(&remote.id) && valid_host(&remote.host) && remote.engine.as_deref().is_none_or(valid_engine)).take(MAX_REMOTES).collect()
    }

    pub fn get(&self, id: &str) -> BridgeResult<Remote> {
        self.list().into_iter().find(|remote| remote.id == id).ok_or_else(|| BridgeError::new("REMOTE_NOT_FOUND", "that remote machine is not set up"))
    }

    /// Adds a machine, or changes one; anything new is shown to the person first.
    pub fn save(&self, id: Option<&str>, host: &str, engine: Option<&str>, confirm: impl FnOnce(&Remote) -> bool) -> BridgeResult<Vec<Remote>> {
        if !valid_host(host) {
            return Err(invalid("use an SSH host alias, a host name, or user@host"));
        }
        let engine = engine.map(str::trim).filter(|engine| !engine.is_empty() && *engine != DEFAULT_ENGINE);
        if engine.is_some_and(|engine| !valid_engine(engine)) {
            return Err(invalid("the engine command takes a program and plain arguments only"));
        }
        let mut list = self.list();
        let id = match id {
            Some(id) if list.iter().any(|remote| remote.id == id) => id.to_string(),
            Some(_) => return Err(BridgeError::new("REMOTE_NOT_FOUND", "that remote machine is not set up")),
            None if list.len() >= MAX_REMOTES => return Err(invalid("Runrail keeps at most 16 remote machines")),
            None => new_id(),
        };
        let remote = Remote { id: id.clone(), host: host.to_string(), engine: engine.map(str::to_string) };
        if list.iter().any(|existing| *existing == remote) {
            return Ok(list);
        }
        if !confirm(&remote) {
            return Err(BridgeError::new("REMOTE_DECLINED", "the remote machine was not saved"));
        }
        match list.iter_mut().find(|existing| existing.id == id) {
            Some(existing) => *existing = remote,
            None => list.push(remote),
        }
        self.write(&list)?;
        Ok(list)
    }

    pub fn remove(&self, id: &str) -> BridgeResult<Vec<Remote>> {
        let list: Vec<Remote> = self.list().into_iter().filter(|remote| remote.id != id).collect();
        self.write(&list)?;
        Ok(list)
    }

    fn write(&self, list: &[Remote]) -> BridgeResult<()> {
        let bytes = serde_json::to_vec_pretty(list).map_err(|_| unavailable())?;
        write_atomic(&self.path, &bytes).map_err(|_| unavailable())
    }
}

fn new_id() -> String {
    let mut bytes = [0_u8; 6];
    getrandom(&mut bytes);
    format!("rm-{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

fn getrandom(bytes: &mut [u8]) {
    use std::io::Read;
    if fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(bytes)).is_err() {
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (seed >> (index * 8)) as u8;
        }
    }
}

/// The `Host` aliases in ~/.ssh/config, without patterns; the file holds settings, not keys.
pub fn ssh_config_hosts(home: &Path) -> Vec<String> {
    let path = home.join(".ssh").join("config");
    let Ok(file) = fs::File::open(&path) else { return Vec::new() };
    let mut text = String::new();
    {
        use std::io::Read;
        if file.take(MAX_SSH_CONFIG_BYTES).read_to_string(&mut text).is_err() {
            return Vec::new();
        }
    }
    config_hosts(&text)
}

fn config_hosts(text: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let (key, rest) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((key, rest)) => (key, rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
            None => continue,
        };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for alias in rest.split_whitespace() {
            if alias.contains(['*', '?', '!']) || !valid_host(alias) || hosts.iter().any(|known| known == alias) {
                continue;
            }
            hosts.push(alias.to_string());
            if hosts.len() >= MAX_CONFIG_HOSTS {
                return hosts;
            }
        }
    }
    hosts
}

/// Options for every connection: never a password prompt, and a dead link noticed in 90 seconds.
pub fn ssh_options() -> Vec<String> {
    #[allow(unused_mut)]
    let mut options = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"].map(String::from).to_vec();
    // The live test reaches a throwaway server through its own config, never the person's.
    #[cfg(test)]
    if let Ok(config) = std::env::var("RUNRAIL_R2_SSH_CONFIG") {
        options.splice(0..0, ["-F".to_string(), config]);
    }
    options
}

/// The thread's connection: it runs the engine and carries the forward to it.
pub fn engine_command(remote: &Remote, control: &Path, script: &str) -> Command {
    let mut command = Command::new("ssh");
    command
        .args(ssh_options())
        .args(["-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-S"])
        .arg(control)
        .args(["--", &remote.host, &format!("sh -lc {}", quote(script))]);
    command
}

/// The script the remote login shell runs: the behavior file, then the engine in place of the shell.
pub fn engine_script(remote: &Remote, session_id: &str, workspace: &str, config: &str, args: &[String]) -> String {
    let dir = format!("\"$HOME/.runrail/remote/{session_id}\"");
    let args: Vec<String> = args.iter().map(|arg| quote(arg)).collect();
    format!(
        "umask 077 && mkdir -p {dir} && printf '%s' {config} > {dir}/config.json && cd {workspace} && exec {engine} control {args} --cwd {workspace} --session-dir {dir} --config {dir}/config.json --transcript-dir {dir}/transcript",
        config = quote(config),
        workspace = quote(workspace),
        engine = remote.engine(),
        args = args.join(" "),
    )
}

/// A free port on this Mac's loopback for the forward.
fn free_port() -> BridgeResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| BridgeError::new("REMOTE_FORWARD_FAILED", "no local port is free for the remote engine"))?;
    listener.local_addr().map(|address| address.port()).map_err(|_| BridgeError::new("REMOTE_FORWARD_FAILED", "no local port is free for the remote engine"))
}

/// Forwards a local port to the engine's port on the remote loopback, over the thread's connection.
pub fn forward(remote: &Remote, control: &Path, remote_address: SocketAddr) -> BridgeResult<SocketAddr> {
    let port = free_port()?;
    let status = Command::new("ssh")
        .args(["-S"])
        .arg(control)
        .args(["-O", "forward", "-L", &format!("127.0.0.1:{port}:127.0.0.1:{}", remote_address.port()), "--", &remote.host])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| BridgeError::new("REMOTE_FORWARD_FAILED", "ssh could not forward to the remote engine"))?;
    if !status.success() {
        return Err(BridgeError::new("REMOTE_FORWARD_FAILED", "ssh could not forward to the remote engine"));
    }
    Ok(SocketAddr::from(([127, 0, 0, 1], port)))
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCheck {
    /// The engine's version on the remote, when it answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Whether the folder asked about is there, and is a git repository.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<bool>,
}

/// Reaches the machine, asks its engine for its version, and looks at a folder when one is given.
pub fn check(remote: &Remote, folder: Option<&str>) -> BridgeResult<RemoteCheck> {
    if folder.is_some_and(|folder| !valid_remote_path(folder)) {
        return Err(invalid("the folder must be an absolute path on that machine"));
    }
    let look = folder.map_or(String::new(), |folder| {
        let folder = quote(folder);
        format!(" && if [ -d {folder} ]; then echo folder=yes; if git -C {folder} rev-parse --git-dir >/dev/null 2>&1; then echo git=yes; fi; fi")
    });
    let script = format!("printf 'version=%s\\n' \"$({} --version 2>/dev/null | head -n 1)\"{look}", remote.engine());
    let mut command = Command::new("ssh");
    command.args(ssh_options()).args(["--", &remote.host, &format!("sh -lc {}", quote(&script))]);
    let output = run_bounded(command)?;
    let text = String::from_utf8_lossy(&output);
    let version = text.lines().find_map(|line| line.strip_prefix("version=")).map(str::trim).filter(|version| !version.is_empty()).map(|version| version.chars().filter(|c| !c.is_control()).take(80).collect());
    if version.is_none() {
        return Err(BridgeError::new("REMOTE_ENGINE_MISSING", "Runrail's engine did not answer on that machine; install it there, or set the engine command to its full path"));
    }
    Ok(RemoteCheck {
        version,
        folder: folder.map(|_| text.lines().any(|line| line == "folder=yes")),
        git: folder.map(|_| text.lines().any(|line| line == "git=yes")),
    })
}

fn run_bounded(mut command: Command) -> BridgeResult<Vec<u8>> {
    use std::io::Read;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| BridgeError::new("REMOTE_SSH_MISSING", if cfg!(target_os = "macos") { "ssh is not available on this Mac" } else { "ssh is not available on this computer" }))?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(MAX_CHECK_OUTPUT as u64).read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = std::time::Instant::now() + CHECK_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BridgeError::new("REMOTE_UNREACHABLE", "that machine did not answer over SSH in time"));
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    // 255 is ssh's own failure: the machine, the network, or the keys.
    if status.code() == Some(255) {
        return Err(BridgeError::new("REMOTE_UNREACHABLE", "ssh could not connect; check that `ssh <host>` works in Terminal without a password prompt"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_commands_are_plain_words() {
        for host in ["dev-box", "me@build.example.com", "10.0.0.5", "a_b"] {
            assert!(valid_host(host), "{host}");
        }
        for host in ["", "-oProxyCommand=x", "a b", "a;b", "host:22", "[::1]", "é"] {
            assert!(!valid_host(host), "{host}");
        }
        for engine in ["runrail", "~/.bun/bin/runrail", "bun /home/me/runrail/src/cli.ts", "node /opt/r,1/cli.js"] {
            assert!(valid_engine(engine), "{engine}");
        }
        for engine in ["", "-x", "runrail; rm -rf ~", "$(whoami)", "a|b", "a`b`", " runrail", "a\nb", "a>b"] {
            assert!(!valid_engine(engine), "{engine}");
        }
        assert!(valid_remote_path("/home/me/app"));
        assert!(!valid_remote_path("home/me"));
        assert!(!valid_remote_path("/a\nb"));
        assert_eq!(quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn the_script_writes_the_behavior_file_and_starts_the_engine_in_the_folder() {
        let remote = Remote { id: "rm-1".into(), host: "dev".into(), engine: Some("~/.bun/bin/runrail".into()) };
        let script = engine_script(&remote, "th-1", "/home/me/my app", "{\"a\":\"it's\"}", &["--backend".into(), "claude-code".into(), "--exit-on-stdin-close".into()]);
        assert_eq!(
            script,
            "umask 077 && mkdir -p \"$HOME/.runrail/remote/th-1\" && printf '%s' '{\"a\":\"it'\\''s\"}' > \"$HOME/.runrail/remote/th-1\"/config.json && cd '/home/me/my app' && exec ~/.bun/bin/runrail control '--backend' 'claude-code' '--exit-on-stdin-close' --cwd '/home/me/my app' --session-dir \"$HOME/.runrail/remote/th-1\" --config \"$HOME/.runrail/remote/th-1\"/config.json --transcript-dir \"$HOME/.runrail/remote/th-1\"/transcript"
        );
        let command = engine_command(&remote, Path::new("/tmp/c.sock"), &script);
        let args: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(&args[..2], ["-T", "-o"]);
        assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|pair| pair == ["-o", "ControlMaster=yes"]));
        let at = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(args[at + 1], "dev");
        assert!(args[at + 2].starts_with("sh -lc 'umask 077"));
        assert_eq!(args.len(), at + 3);
    }

    #[test]
    fn only_plain_aliases_come_from_the_ssh_config() {
        let text = "Host dev build-box\n  HostName 10.0.0.5\n  IdentityFile ~/.ssh/id_dev\nHost *.example.com !bad ?x\nhost=lower\nMatch host foo\nHost dev\nHost -oProxyCommand=evil\n";
        assert_eq!(config_hosts(text), vec!["dev", "build-box", "lower"]);
    }

    #[test]
    fn the_store_saves_only_what_the_person_confirmed() {
        let dir = std::env::temp_dir().join(format!("runrail-remote-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let store = RemoteStore::new(&dir);
        assert!(store.save(None, "dev", None, |_| false).is_err());
        assert!(store.list().is_empty());
        let saved = store.save(None, "dev", Some("runrail"), |_| true).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].engine, None);
        let id = saved[0].id.clone();
        assert!(valid_id(&id));
        // Unchanged: no question.
        assert_eq!(store.save(Some(&id), "dev", None, |_| panic!("asked again")).unwrap().len(), 1);
        let changed = store.save(Some(&id), "dev", Some("~/.bun/bin/runrail"), |remote| remote.engine() == "~/.bun/bin/runrail").unwrap();
        assert_eq!(changed[0].engine.as_deref(), Some("~/.bun/bin/runrail"));
        assert!(store.save(Some("rm-gone"), "dev", None, |_| true).is_err());
        assert!(store.save(None, "a;b", None, |_| true).is_err());
        assert!(store.remove(&id).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
