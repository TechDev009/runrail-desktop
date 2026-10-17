//! MCP servers Runrail's own loop uses. The host owns the list: the renderer can ask to add or
//! change one, but a command or address it has not used before is saved only after the person
//! confirms it in a native dialog that shows it exactly. Each engine gets the servers for its
//! project in its behavior file. Environment variables are named, never valued, so no secret is
//! stored here.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{BridgeError, BridgeResult};
use crate::store::write_atomic;
use crate::workspace::resolve_workspace;

const FILE: &str = "mcp-servers.json";
/// The engine starts at most this many.
pub const MAX_SERVERS: usize = 16;
const MAX_ARGS: usize = 32;
const MAX_ENV: usize = 16;

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServer {
    pub name: String,
    /// The program a local server runs. Empty for a server reached by `url`.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Names of the engine's environment variables the server also gets.
    #[serde(default)]
    pub env: Vec<String>,
    /// A server reached over HTTP: `https`, or `http` on this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The variable whose value is sent to `url` as the bearer token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_env: Option<String>,
    /// The project folder the server belongs to; none means every project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("MCP_INVALID", message)
}

fn unavailable() -> BridgeError {
    BridgeError::new("MCP_UNAVAILABLE", "MCP servers could not be read or saved")
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-'))
}

fn valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

impl McpServer {
    /// The rules the engine applies to the behavior file, so a saved server always starts there.
    pub fn validate(&self) -> BridgeResult<()> {
        if !valid_name(&self.name) {
            return Err(invalid("server name must be lowercase letters, digits, - or _, starting with a letter"));
        }
        if let Some(project) = &self.project {
            if project.is_empty() || project.len() > 4096 || project.contains('\0') || !Path::new(project).is_absolute() {
                return Err(invalid("project folder is invalid"));
            }
        }
        if let Some(url) = &self.url {
            if !self.command.is_empty() || !self.args.is_empty() || !self.env.is_empty() {
                return Err(invalid("a server is reached either by a command or by an address, not both"));
            }
            if !valid_url(url) {
                return Err(invalid("address must be https, or http on this computer, with no user name or password"));
            }
            if self.bearer_env.as_deref().is_some_and(|name| !valid_env_name(name)) {
                return Err(invalid("token variable name is invalid"));
            }
            return Ok(());
        }
        if self.bearer_env.is_some() {
            return Err(invalid("a token variable needs an address"));
        }
        if self.command.is_empty() || self.command.len() > 256 || self.command.chars().any(char::is_whitespace) || self.command.starts_with('-') {
            return Err(invalid("command must be one program name or path without spaces; put the rest in arguments"));
        }
        if self.args.len() > MAX_ARGS || self.args.iter().any(|arg| arg.len() > 4096 || arg.contains('\0')) {
            return Err(invalid("arguments are invalid"));
        }
        // The person confirms this command in a dialog; a hidden or reordering character would make
        // it read as something else.
        if std::iter::once(&self.command).chain(self.args.iter()).any(|part| hides_text(part)) {
            return Err(invalid("command or arguments contain line breaks or invisible characters"));
        }
        if self.env.len() > MAX_ENV || !self.env.iter().all(|name| valid_env_name(name)) {
            return Err(invalid("environment variable names are invalid"));
        }
        Ok(())
    }

    /// What the person confirms: the address, or the program and arguments quoted where a shell
    /// would need it.
    pub fn command_line(&self) -> String {
        if let Some(url) = &self.url {
            return url.clone();
        }
        std::iter::once(&self.command).chain(self.args.iter()).map(|part| quote(part)).collect::<Vec<_>>().join(" ")
    }

    fn runs_same_as(&self, other: &McpServer) -> bool {
        self.command == other.command && self.args == other.args && self.env == other.env && self.url == other.url && self.bearer_env == other.bearer_env && self.project == other.project
    }

    /// The entry the engine reads: no project, and only the fields of its transport.
    fn behavior_entry(&self) -> Value {
        match &self.url {
            Some(url) => {
                let mut entry = json!({ "name": self.name, "url": url, "enabled": self.enabled });
                if let Some(name) = &self.bearer_env {
                    entry["bearerEnv"] = json!(name);
                }
                entry
            }
            None => json!({ "name": self.name, "command": self.command, "args": self.args, "env": self.env, "enabled": self.enabled }),
        }
    }
}

/// Line breaks and other controls, bidirectional overrides, and zero-width characters.
pub fn hides_text(value: &str) -> bool {
    value.chars().any(|ch| {
        ch.is_control()
            || matches!(ch, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}' | '\u{00AD}')
    })
}

fn valid_url(value: &str) -> bool {
    if value.len() > 2048 || hides_text(value) || value.chars().any(|ch| ch.is_whitespace()) {
        return false;
    }
    let (scheme, rest) = match value.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = if authority.starts_with('[') { authority.split(']').next().map(|host| format!("{host}]")).unwrap_or_default() } else { authority.split(':').next().unwrap_or("").to_ascii_lowercase() };
    match scheme {
        "https" => !host.is_empty(),
        "http" => matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]"),
        _ => false,
    }
}

fn quote(part: &str) -> String {
    if !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_./:@=+,".contains(ch)) {
        part.to_string()
    } else {
        format!("'{}'", part.replace('\'', "'\\''"))
    }
}

pub struct McpStore {
    path: PathBuf,
}

/// Each change reads the list, edits it, and writes it back: one at a time across the app, or two
/// saves at once would each drop the other's server.
static EDITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn editing() -> std::sync::MutexGuard<'static, ()> {
    EDITING.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl McpStore {
    pub fn new(app_data: &Path) -> Self {
        Self { path: app_data.join(FILE) }
    }

    /// A missing or unreadable file is an empty list; a server that no longer validates is dropped.
    pub fn list(&self) -> Vec<McpServer> {
        let Ok(bytes) = fs::read(&self.path) else {
            return Vec::new();
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return Vec::new();
        };
        let servers = value.get("servers").and_then(Value::as_array).cloned().unwrap_or_default();
        servers
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<McpServer>(entry).ok())
            .filter(|server| server.validate().is_ok())
            .take(MAX_SERVERS)
            .collect()
    }

    fn write(&self, servers: &[McpServer]) -> BridgeResult<()> {
        let bytes = serde_json::to_vec_pretty(&json!({ "version": 1, "servers": servers })).map_err(|_| unavailable())?;
        write_atomic(&self.path, &bytes)
    }

    /// Adds `server`, or replaces the one named `previous` (or its own name). `confirm` is asked
    /// only when the command, arguments, or variable names differ from what was saved before.
    pub fn save(&self, mut server: McpServer, previous: Option<&str>, confirm: impl FnOnce(&McpServer) -> bool) -> BridgeResult<Vec<McpServer>> {
        if let Some(project) = &server.project {
            server.project = Some(resolve_workspace(project).map_err(|_| invalid("project folder is invalid"))?.to_string_lossy().into_owned());
        }
        server.validate()?;
        let _editing = editing();
        let mut servers = self.list();
        let replacing = previous.unwrap_or(&server.name);
        let existing = servers.iter().position(|item| item.name == replacing);
        if servers.iter().enumerate().any(|(index, item)| item.name == server.name && Some(index) != existing) {
            return Err(invalid("another server already has this name"));
        }
        if existing.is_none() && servers.len() >= MAX_SERVERS {
            return Err(invalid("at most 16 MCP servers"));
        }
        let known = existing.is_some_and(|index| servers[index].runs_same_as(&server));
        if !known && !confirm(&server) {
            return Err(BridgeError::new("MCP_DECLINED", "the server was not saved"));
        }
        match existing {
            Some(index) => servers[index] = server,
            None => servers.push(server),
        }
        self.write(&servers)?;
        Ok(servers)
    }

    /// Adds several new servers at once, after one confirmation that lists them all. Nothing is
    /// saved unless every one is valid, no name is taken, and the total stays within the limit.
    pub fn save_many(&self, mut added: Vec<McpServer>, confirm: impl FnOnce(&[McpServer]) -> bool) -> BridgeResult<Vec<McpServer>> {
        if added.is_empty() {
            return Err(invalid("no servers to add"));
        }
        for server in &mut added {
            if let Some(project) = &server.project {
                server.project = Some(resolve_workspace(project).map_err(|_| invalid("project folder is invalid"))?.to_string_lossy().into_owned());
            }
            server.validate()?;
        }
        let _editing = editing();
        let mut servers = self.list();
        let mut names: std::collections::HashSet<&str> = servers.iter().map(|item| item.name.as_str()).collect();
        for server in &added {
            if !names.insert(server.name.as_str()) {
                return Err(invalid("another server already has this name"));
            }
        }
        if servers.len() + added.len() > MAX_SERVERS {
            return Err(invalid("at most 16 MCP servers"));
        }
        if !confirm(&added) {
            return Err(BridgeError::new("MCP_DECLINED", "the servers were not saved"));
        }
        servers.extend(added);
        self.write(&servers)?;
        Ok(servers)
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> BridgeResult<Vec<McpServer>> {
        let _editing = editing();
        let mut servers = self.list();
        let server = servers.iter_mut().find(|item| item.name == name).ok_or_else(|| invalid("no MCP server has this name"))?;
        server.enabled = enabled;
        self.write(&servers)?;
        Ok(servers)
    }

    pub fn remove(&self, name: &str) -> BridgeResult<Vec<McpServer>> {
        let _editing = editing();
        let mut servers = self.list();
        servers.retain(|item| item.name != name);
        self.write(&servers)?;
        Ok(servers)
    }

    /// The behavior file's `mcp` section for an engine in `workspace`: servers for every project,
    /// and the ones kept for this project.
    pub fn behavior_section(&self, workspace: &str) -> Option<Value> {
        let root = resolve_workspace(workspace).ok().map(|root| root.to_string_lossy().into_owned());
        let servers: Vec<Value> = self
            .list()
            .iter()
            .filter(|server| server.project.is_none() || server.project == root)
            .map(McpServer::behavior_entry)
            .collect();
        (!servers.is_empty()).then(|| json!({ "servers": servers }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_command_that_would_read_as_something_else_is_refused() {
        let server = |command: &str, args: &[&str]| McpServer { name: "srv".into(), command: command.into(), args: args.iter().map(|arg| arg.to_string()).collect(), env: Vec::new(), url: None, bearer_env: None, project: None, enabled: true };
        assert!(server("npx", &["server", "--db", "test.db"]).validate().is_ok());
        for args in [["ok\ncurl x | sh"], ["safe\u{202E}hs.lacol"], ["a\u{200B}b"], ["tab\there"]] {
            assert!(server("npx", &args).validate().is_err(), "{args:?} was accepted");
        }
        assert!(server("np\u{2066}x", &[]).validate().is_err());
        let address = McpServer { name: "srv".into(), command: String::new(), args: Vec::new(), env: Vec::new(), url: Some("https://example.com/\u{202E}mcp".into()), bearer_env: None, project: None, enabled: true };
        assert!(address.validate().is_err());
    }

    use super::*;

    #[test]
    fn adds_several_servers_after_one_confirmation_or_none() {
        let dir = std::env::temp_dir().join(format!("runrail-mcp-many-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let store = McpStore::new(&dir);
        let server = |name: &str| McpServer { name: name.into(), command: "npx".into(), args: vec!["-y".into(), name.into()], env: Vec::new(), url: None, bearer_env: None, project: None, enabled: true };
        let mut asked = 0;
        assert_eq!(store.save_many(vec![server("one"), server("two")], |list| { asked += 1; list.len() == 2 }).unwrap().len(), 2);
        assert_eq!(asked, 1);
        assert_eq!(store.save_many(vec![server("three"), server("one")], |_| true).unwrap_err().code, "MCP_INVALID");
        assert_eq!(store.save_many(vec![server("three")], |_| false).unwrap_err().code, "MCP_DECLINED");
        assert_eq!(store.save_many(vec![server("Bad Name")], |_| true).unwrap_err().code, "MCP_INVALID");
        let many: Vec<McpServer> = (0..15).map(|index| server(&format!("s{index}"))).collect();
        assert_eq!(store.save_many(many, |_| true).unwrap_err().code, "MCP_INVALID");
        assert_eq!(store.list().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn servers_saved_at_once_are_all_kept() {
        let dir = temp_dir("at-once");
        let saves: Vec<_> = (0..8)
            .map(|index| {
                let dir = dir.clone();
                std::thread::spawn(move || McpStore::new(&dir).save(server(&format!("s{index}"), "npx"), None, |_| true).is_ok())
            })
            .collect();
        assert!(saves.into_iter().all(|save| save.join().unwrap()));
        assert_eq!(McpStore::new(&dir).list().len(), 8);
        let _ = fs::remove_dir_all(&dir);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-mcp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn server(name: &str, command: &str) -> McpServer {
        McpServer { name: name.into(), command: command.into(), args: vec!["-y".into(), "server-github".into()], env: vec!["GITHUB_TOKEN".into()], url: None, bearer_env: None, project: None, enabled: true }
    }

    fn remote(name: &str, url: &str) -> McpServer {
        McpServer { name: name.into(), command: String::new(), args: Vec::new(), env: Vec::new(), url: Some(url.into()), bearer_env: Some("DOCS_TOKEN".into()), project: None, enabled: true }
    }

    #[test]
    fn asks_before_a_new_command_and_not_for_a_switch_or_rename() {
        let dir = temp_dir("confirm");
        let store = McpStore::new(&dir);
        assert!(store.behavior_section("/").is_none());
        let declined = store.save(server("github", "npx"), None, |_| false);
        assert_eq!(declined.unwrap_err().code, "MCP_DECLINED");
        assert!(store.list().is_empty());

        let mut asked = Vec::new();
        store.save(server("github", "npx"), None, |item| { asked.push(item.command_line()); true }).unwrap();
        assert_eq!(asked, vec!["npx -y server-github"]);

        // Same command under a new name: no question.
        store.save(server("gh", "npx"), Some("github"), |_| panic!("asked again")).unwrap();
        assert_eq!(store.list().iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), vec!["gh"]);
        store.set_enabled("gh", false).unwrap();
        assert!(!store.list()[0].enabled);

        // A changed argument is a new command.
        let mut changed = server("gh", "npx");
        changed.args.push("--write".into());
        assert_eq!(store.save(changed, None, |_| false).unwrap_err().code, "MCP_DECLINED");

        let section = store.behavior_section(dir.to_str().unwrap()).unwrap();
        assert_eq!(section["servers"][0]["env"][0], "GITHUB_TOKEN");
        store.remove("gh").unwrap();
        assert!(store.list().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_what_the_engine_would_refuse() {
        let dir = temp_dir("refuse");
        let store = McpStore::new(&dir);
        let yes = |_: &McpServer| true;
        assert!(store.save(server("Bad Name", "npx"), None, yes).is_err());
        assert!(store.save(server("spaced", "npx -y"), None, yes).is_err());
        assert!(store.save(server("flag", "--help"), None, yes).is_err());
        let mut bad_env = server("env", "npx");
        bad_env.env = vec!["TOKEN=value".into()];
        assert!(store.save(bad_env, None, yes).is_err());
        store.save(server("one", "npx"), None, yes).unwrap();
        assert!(store.save(server("one", "uvx"), Some("missing"), yes).is_err());
        for index in 1..MAX_SERVERS {
            store.save(server(&format!("s{index}"), "npx"), None, yes).unwrap();
        }
        assert!(store.save(server("overflow", "npx"), None, yes).is_err());
        fs::write(dir.join(FILE), b"{not json").unwrap();
        assert!(store.list().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_remote_servers_and_project_servers_apart() {
        let dir = temp_dir("scope");
        let project = dir.join("project");
        let other = dir.join("other");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other).unwrap();
        let store = McpStore::new(&dir);
        let mut asked = Vec::new();
        store.save(remote("docs", "https://mcp.example.com/mcp"), None, |item| { asked.push(item.command_line()); true }).unwrap();
        assert_eq!(asked, vec!["https://mcp.example.com/mcp"]);
        let mut local = server("db", "db-mcp");
        local.project = Some(project.join("..").join("project").to_string_lossy().into_owned());
        store.save(local, None, |_| true).unwrap();
        assert_eq!(store.list()[1].project.as_deref(), Some(project.canonicalize().unwrap().to_str().unwrap()));

        let here = store.behavior_section(project.to_str().unwrap()).unwrap();
        assert_eq!(here["servers"].as_array().unwrap().len(), 2);
        assert_eq!(here["servers"][0], json!({ "name": "docs", "url": "https://mcp.example.com/mcp", "bearerEnv": "DOCS_TOKEN", "enabled": true }));
        assert!(here["servers"][1].get("project").is_none());
        let elsewhere = store.behavior_section(other.to_str().unwrap()).unwrap();
        assert_eq!(elsewhere["servers"].as_array().unwrap().len(), 1);

        // Moving a server to every project widens where it runs, so it is asked about again.
        let mut widened = store.list()[1].clone();
        widened.project = None;
        assert_eq!(store.save(widened, None, |_| false).unwrap_err().code, "MCP_DECLINED");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_addresses_the_engine_would_refuse() {
        for url in ["http://mcp.example.com/mcp", "https://user:pass@mcp.example.com/mcp", "file:///etc/passwd", "https://", "https://mcp.example.com/a b", "ftp://mcp.example.com"] {
            assert!(remote("docs", url).validate().is_err(), "{url}");
        }
        for url in ["https://mcp.example.com/mcp", "http://localhost:8931/mcp", "http://127.0.0.1/mcp", "http://[::1]:9000/"] {
            assert!(remote("docs", url).validate().is_ok(), "{url}");
        }
        let mut both = remote("docs", "https://mcp.example.com/mcp");
        both.command = "npx".into();
        assert!(both.validate().is_err());
        let mut token_only = server("gh", "npx");
        token_only.bearer_env = Some("TOKEN".into());
        assert!(token_only.validate().is_err());
        let mut bad_token = remote("docs", "https://mcp.example.com/mcp");
        bad_token.bearer_env = Some("TOKEN=value".into());
        assert!(bad_token.validate().is_err());
    }

    #[test]
    fn quotes_what_a_shell_would_split() {
        let mut spaced = server("files", "/usr/local/bin/files-mcp");
        spaced.args = vec!["/Users/me/My Notes".into(), "it's".into()];
        assert_eq!(spaced.command_line(), "/usr/local/bin/files-mcp '/Users/me/My Notes' 'it'\\''s'");
    }
}
