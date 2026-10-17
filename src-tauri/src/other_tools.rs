//! What other coding tools on this computer are set up with, offered for import: instruction
//! files, skills, MCP servers, and subagents of Claude Code, Claude Desktop, Codex, Cursor, Gemini
//! CLI, opencode, and Pi. Only fixed, well-known paths are read, each bounded. A value that can hold a
//! secret (an MCP server's environment values, request headers, a token in a URL) is never
//! returned: environment entries come back as names, and anything else is listed as left out.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::BridgeResult;
use crate::mcp::McpServer;
use crate::workspace::resolve_workspace;

const MAX_CONFIG: u64 = 4 * 1024 * 1024;
const MAX_TEXT: u64 = 256 * 1024;
const MAX_SKILLS: usize = 512;
const MAX_SERVERS: usize = 128;
const MAX_AGENTS: usize = 128;

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Global,
    Project,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundInstructions {
    pub tool: &'static str,
    pub scope: Scope,
    /// Where it is, with the home folder shown as `~`.
    pub place: String,
    pub text: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundSkill {
    pub tool: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The folder, as the import asks for it.
    pub path: String,
    pub place: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundServer {
    pub tool: &'static str,
    pub scope: Scope,
    pub place: String,
    /// Ready to save, or absent when the server cannot run here as it is written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<McpServer>,
    /// The name it has in the other tool.
    pub original: String,
    /// What was not brought over, worded for the list.
    pub left_out: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundAgent {
    pub tool: &'static str,
    pub name: String,
    pub description: String,
    pub path: String,
    pub place: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OtherTools {
    pub instructions: Vec<FoundInstructions>,
    pub skills: Vec<FoundSkill>,
    pub servers: Vec<FoundServer>,
    pub agents: Vec<FoundAgent>,
}

/// Paths to look at, relative to the home folder or the project.
struct Places {
    home: PathBuf,
    /// Where `.config/` paths are: `$XDG_CONFIG_HOME` on Linux when it is set.
    config: PathBuf,
    project: Option<PathBuf>,
    /// The folder as the renderer named it; Claude Code keys projects by the path it was opened at.
    named: Option<String>,
}

impl Places {
    fn new(home: &Path, project: Option<PathBuf>, named: Option<String>) -> Self {
        Self { home: home.to_path_buf(), config: config_home(home), project, named }
    }

    fn home(&self, relative: &str) -> PathBuf {
        match relative.strip_prefix(".config/") {
            Some(rest) => self.config.join(rest),
            None => self.home.join(relative),
        }
    }

    fn shown(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => path.display().to_string(),
        }
    }
}

fn config_home(home: &Path) -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute()) {
        return config;
    }
    home.join(".config")
}

#[cfg(target_os = "macos")]
const CLAUDE_DESKTOP: &str = "Library/Application Support/Claude/claude_desktop_config.json";
#[cfg(not(target_os = "macos"))]
const CLAUDE_DESKTOP: &str = ".config/Claude/claude_desktop_config.json";

const GLOBAL_INSTRUCTIONS: [(&str, &str); 5] = [
    ("claude-code", ".claude/CLAUDE.md"),
    ("codex", ".codex/AGENTS.md"),
    ("gemini", ".gemini/GEMINI.md"),
    ("opencode", ".config/opencode/AGENTS.md"),
    ("pi", ".pi/agent/AGENTS.md"),
];

/// Files the engine does not read itself; a project's own `CLAUDE.md` it already does.
const PROJECT_INSTRUCTIONS: [(&str, &str); 3] = [("gemini", "GEMINI.md"), ("copilot", ".github/copilot-instructions.md"), ("cursor", ".cursorrules")];

const SKILL_ROOTS: [(&str, &str); 6] = [
    ("claude-code", ".claude/skills"),
    ("codex", ".codex/skills"),
    ("pi", ".pi/agent/skills"),
    ("opencode", ".config/opencode/skills"),
    ("opencode", ".config/opencode/skill"),
    ("shared", ".agents/skills"),
];

const AGENT_ROOTS: [(&str, &str); 3] = [("claude-code", ".claude/agents"), ("opencode", ".config/opencode/agent"), ("opencode", ".config/opencode/agents")];

/// A plain file's text, if it is small enough and UTF-8. Links are followed: these are the
/// person's own settings, often kept in a dotfiles repository.
fn read_text(path: &Path, limit: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    String::from_utf8(fs::read(path).ok()?).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_text(path, MAX_CONFIG)?).ok()
}

/// The `name:` and `description:` lines of a Markdown file's front matter.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines.take(64) {
        if line.trim() == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().trim_matches(|ch| ch == '"' || ch == '\'').trim();
            if value.is_empty() || value.len() > 1_024 {
                continue;
            }
            match key.trim() {
                "name" => name = Some(value.to_string()),
                "description" => description = Some(value.chars().take(300).collect()),
                _ => {}
            }
        }
    }
    (name, description)
}

pub fn scan(home: &Path, workspace: Option<&str>) -> BridgeResult<OtherTools> {
    let project = match workspace {
        Some(workspace) => Some(resolve_workspace(workspace)?),
        None => None,
    };
    let places = Places::new(home, project, workspace.map(str::to_string));
    Ok(OtherTools { instructions: instructions(&places), skills: skills(&places), servers: servers(&places), agents: agents(&places) })
}

fn instructions(places: &Places) -> Vec<FoundInstructions> {
    let mut found = Vec::new();
    for (tool, relative) in GLOBAL_INSTRUCTIONS {
        let path = places.home(relative);
        if let Some(text) = read_text(&path, MAX_TEXT).filter(|text| !text.trim().is_empty() && !text.contains('\0')) {
            found.push(FoundInstructions { tool, scope: Scope::Global, place: places.shown(&path), text });
        }
    }
    if let Some(project) = &places.project {
        for (tool, relative) in PROJECT_INSTRUCTIONS {
            let path = project.join(relative);
            if let Some(text) = read_text(&path, MAX_TEXT).filter(|text| !text.trim().is_empty() && !text.contains('\0')) {
                found.push(FoundInstructions { tool, scope: Scope::Project, place: relative.to_string(), text });
            }
        }
    }
    found
}

/// Skill folders under the known roots. The same folder reached through two tools (one linking
/// to the other) is listed once, under the first.
fn skills(places: &Places) -> Vec<FoundSkill> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for (tool, relative) in SKILL_ROOTS {
        let root = places.home(relative);
        let Ok(entries) = fs::read_dir(&root) else { continue };
        let mut folders: Vec<PathBuf> = entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.file_name().is_some_and(|name| !name.to_string_lossy().starts_with('.'))).collect();
        folders.sort();
        for folder in folders {
            if found.len() >= MAX_SKILLS {
                return found;
            }
            let Some(text) = read_text(&folder.join("SKILL.md"), MAX_TEXT) else { continue };
            let Ok(canonical) = fs::canonicalize(&folder) else { continue };
            if !seen.insert(canonical.clone()) {
                continue;
            }
            let (name, description) = front_matter(&text);
            let name = name.unwrap_or_else(|| folder.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
            found.push(FoundSkill { tool, name, description, path: canonical.to_string_lossy().into_owned(), place: places.shown(&folder) });
        }
    }
    found
}

/// The folders `skills` lists, for checking an import asks for one of them and nothing else.
pub fn known_skill(home: &Path, path: &str) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    let places = Places::new(home, None, None);
    skills(&places).into_iter().any(|skill| Path::new(&skill.path) == canonical).then_some(canonical)
}

fn agents(places: &Places) -> Vec<FoundAgent> {
    let mut found = Vec::new();
    for (tool, relative) in AGENT_ROOTS {
        let root = places.home(relative);
        let Ok(entries) = fs::read_dir(&root) else { continue };
        let mut files: Vec<PathBuf> = entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "md")).collect();
        files.sort();
        for file in files {
            if found.len() >= MAX_AGENTS {
                return found;
            }
            let Some(text) = read_text(&file, 96 * 1024) else { continue };
            let (name, description) = front_matter(&text);
            let name = name.or_else(|| file.file_stem().map(|stem| stem.to_string_lossy().into_owned())).unwrap_or_default();
            found.push(FoundAgent { tool, name, description: description.unwrap_or_default(), path: file.to_string_lossy().into_owned(), place: places.shown(&file) });
        }
    }
    found
}

/// The files `agents` lists, for checking an import asks for one of them and nothing else.
pub fn known_agent(home: &Path, path: &str) -> Option<PathBuf> {
    let places = Places::new(home, None, None);
    agents(&places).into_iter().find(|agent| agent.path == path).map(|agent| PathBuf::from(agent.path))
}

fn servers(places: &Places) -> Vec<FoundServer> {
    let mut found = Vec::new();
    let mut add = |tool: &'static str, scope: Scope, path: &Path, entries: Vec<(String, RawServer)>| {
        for (name, raw) in entries {
            if found.len() >= MAX_SERVERS {
                return;
            }
            let (server, left_out) = convert(&name, raw);
            found.push(FoundServer { tool, scope, place: places.shown(path), server, original: name, left_out });
        }
    };
    let claude = places.home(".claude.json");
    if let Some(config) = read_json(&claude) {
        add("claude-code", Scope::Global, &claude, json_servers(config.get("mcpServers")));
        if let Some(project) = &places.project {
            let keys = [Some(project.to_string_lossy().into_owned()), places.named.clone()];
            let local = keys.iter().flatten().find_map(|key| config.get("projects").and_then(|projects| projects.get(key.as_str())).and_then(|entry| entry.get("mcpServers")));
            add("claude-code", Scope::Project, &claude, json_servers(local));
        }
    }
    let desktop = places.home(CLAUDE_DESKTOP);
    if let Some(config) = read_json(&desktop) {
        add("claude-desktop", Scope::Global, &desktop, json_servers(config.get("mcpServers")));
    }
    let cursor = places.home(".cursor/mcp.json");
    if let Some(config) = read_json(&cursor) {
        add("cursor", Scope::Global, &cursor, json_servers(config.get("mcpServers")));
    }
    let gemini = places.home(".gemini/settings.json");
    if let Some(config) = read_json(&gemini) {
        add("gemini", Scope::Global, &gemini, json_servers(config.get("mcpServers")));
    }
    let codex = places.home(".codex/config.toml");
    if let Some(config) = read_text(&codex, MAX_CONFIG).and_then(|text| text.parse::<toml::Table>().ok()) {
        add("codex", Scope::Global, &codex, toml_servers(config.get("mcp_servers")));
    }
    let opencode = places.home(".config/opencode/opencode.json");
    if let Some(config) = read_json(&opencode) {
        add("opencode", Scope::Global, &opencode, opencode_servers(config.get("mcp")));
    }
    if let Some(project) = places.project.clone() {
        for (tool, relative, key) in [("claude-code", ".mcp.json", "mcpServers"), ("cursor", ".cursor/mcp.json", "mcpServers"), ("gemini", ".gemini/settings.json", "mcpServers")] {
            let path = project.join(relative);
            if let Some(config) = read_json(&path) {
                add(tool, Scope::Project, &path, json_servers(config.get(key)));
            }
        }
        let path = project.join("opencode.json");
        if let Some(config) = read_json(&path) {
            add("opencode", Scope::Project, &path, opencode_servers(config.get("mcp")));
        }
    }
    found
}

/// One server as another tool writes it, before Runrail's rules apply.
#[derive(Default)]
struct RawServer {
    command: Option<String>,
    args: Vec<String>,
    env: Vec<(String, bool)>,
    url: Option<String>,
    /// Header names and whether each looks like `Bearer ${NAME}`, with the name.
    headers: Vec<(String, Option<String>)>,
    bearer_env: Option<String>,
    sse: bool,
    disabled: bool,
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// Environment entries as names, each noting whether the other tool wrote a value for it.
fn env_names(value: Option<&Value>) -> Vec<(String, bool)> {
    value.and_then(Value::as_object).map(|map| map.iter().map(|(name, value)| (name.clone(), value.as_str().is_some_and(|text| !text.is_empty()))).collect()).unwrap_or_default()
}

/// `Bearer ${NAME}`, `Bearer $NAME`, or `Bearer {env:NAME}`: the variable named, never a value.
fn bearer_variable(value: &str) -> Option<String> {
    let rest = value.trim().strip_prefix("Bearer ")?.trim();
    let name = rest.strip_prefix("${").and_then(|inner| inner.strip_suffix('}')).or_else(|| rest.strip_prefix("{env:").and_then(|inner| inner.strip_suffix('}'))).or_else(|| rest.strip_prefix('$'))?;
    (!name.is_empty() && name.len() <= 64 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')).then(|| name.to_string())
}

fn headers(value: Option<&Value>) -> Vec<(String, Option<String>)> {
    value.and_then(Value::as_object).map(|map| map.iter().map(|(name, value)| (name.clone(), if name.eq_ignore_ascii_case("authorization") { value.as_str().and_then(bearer_variable) } else { None })).collect()).unwrap_or_default()
}

fn json_servers(value: Option<&Value>) -> Vec<(String, RawServer)> {
    let Some(map) = value.and_then(Value::as_object) else { return Vec::new() };
    map.iter()
        .map(|(name, entry)| {
            let kind = entry.get("type").and_then(Value::as_str).unwrap_or_default();
            let url = entry.get("url").or_else(|| entry.get("httpUrl")).or_else(|| entry.get("serverUrl")).and_then(Value::as_str).map(str::to_string);
            let raw = RawServer {
                command: entry.get("command").and_then(Value::as_str).map(str::to_string),
                args: strings(entry.get("args")),
                env: env_names(entry.get("env")),
                url,
                headers: headers(entry.get("headers")),
                bearer_env: None,
                sse: kind == "sse",
                disabled: entry.get("disabled").and_then(Value::as_bool).unwrap_or(false),
            };
            (name.clone(), raw)
        })
        .collect()
}

fn toml_servers(value: Option<&toml::Value>) -> Vec<(String, RawServer)> {
    let Some(table) = value.and_then(toml::Value::as_table) else { return Vec::new() };
    table
        .iter()
        .filter_map(|(name, entry)| {
            let entry = entry.as_table()?;
            let text = |key: &str| entry.get(key).and_then(toml::Value::as_str).map(str::to_string);
            let raw = RawServer {
                command: text("command"),
                args: entry.get("args").and_then(toml::Value::as_array).map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                env: entry.get("env").and_then(toml::Value::as_table).map(|map| map.iter().map(|(name, value)| (name.clone(), value.as_str().is_some_and(|text| !text.is_empty()))).collect()).unwrap_or_default(),
                url: text("url"),
                headers: entry.get("http_headers").and_then(toml::Value::as_table).map(|map| map.keys().map(|name| (name.clone(), None)).collect()).unwrap_or_default(),
                bearer_env: text("bearer_token_env_var"),
                sse: false,
                disabled: entry.get("enabled").and_then(toml::Value::as_bool) == Some(false),
            };
            Some((name.clone(), raw))
        })
        .collect()
}

fn opencode_servers(value: Option<&Value>) -> Vec<(String, RawServer)> {
    let Some(map) = value.and_then(Value::as_object) else { return Vec::new() };
    map.iter()
        .map(|(name, entry)| {
            let command = strings(entry.get("command"));
            let raw = RawServer {
                command: command.first().cloned(),
                args: command.iter().skip(1).cloned().collect(),
                env: env_names(entry.get("environment")),
                url: entry.get("url").and_then(Value::as_str).map(str::to_string),
                headers: headers(entry.get("headers")),
                bearer_env: None,
                sse: false,
                disabled: entry.get("enabled").and_then(Value::as_bool) == Some(false),
            };
            (name.clone(), raw)
        })
        .collect()
}

/// The other tool's name in the letters Runrail's server names use.
fn server_name(original: &str) -> String {
    let mut name = String::new();
    for ch in original.chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            name.push(ch);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    let name = name.trim_matches('-').trim_start_matches(|ch: char| !ch.is_ascii_lowercase());
    let name: String = name.chars().take(32).collect();
    let name = name.trim_end_matches('-').to_string();
    if name.is_empty() { "server".into() } else { name }
}

fn convert(original: &str, raw: RawServer) -> (Option<McpServer>, Vec<String>) {
    let mut left_out = Vec::new();
    let valued: Vec<&str> = raw.env.iter().filter(|(_, valued)| *valued).map(|(name, _)| name.as_str()).collect();
    if !valued.is_empty() {
        left_out.push(format!("the values of {}; set them in your shell", valued.join(", ")));
    }
    let mut server = McpServer { name: server_name(original), command: String::new(), args: Vec::new(), env: Vec::new(), url: None, bearer_env: None, project: None, enabled: !raw.disabled };
    if let Some(url) = raw.url {
        let (url, dropped) = without_secret_query(&url);
        if !dropped.is_empty() {
            left_out.push(format!("the {} part{} of its address; set {} in the server's own settings", dropped.join(", "), if dropped.len() == 1 { "" } else { "s" }, if dropped.len() == 1 { "it" } else { "them" }));
        }
        server.url = Some(url);
        server.bearer_env = raw.bearer_env.or_else(|| raw.headers.iter().find_map(|(_, variable)| variable.clone()));
        let other: Vec<&str> = raw.headers.iter().filter(|(name, variable)| !(name.eq_ignore_ascii_case("authorization") && variable.is_some())).map(|(name, _)| name.as_str()).collect();
        if !other.is_empty() {
            left_out.push(format!("its {} header{}", other.join(", "), if other.len() == 1 { "" } else { "s" }));
        }
        if raw.sse {
            left_out.push("it uses the older SSE transport, which may not connect".into());
        }
    } else if let Some(command) = raw.command {
        let mut parts = command.split_whitespace().map(str::to_string).collect::<Vec<_>>();
        // A whole command line written as the command, as some tools allow.
        let args = if parts.len() > 1 && raw.args.is_empty() {
            server.command = parts.remove(0);
            parts
        } else {
            server.command = command;
            raw.args
        };
        let (args, dropped) = without_secret_args(args);
        if !dropped.is_empty() {
            left_out.push(format!("its {} argument{}; pass {} through an environment variable", dropped.join(", "), if dropped.len() == 1 { "" } else { "s" }, if dropped.len() == 1 { "it" } else { "them" }));
        }
        server.args = args;
        server.env = raw.env.into_iter().map(|(name, _)| name).collect();
    } else {
        return (None, vec!["it has neither a command nor an address".into()]);
    }
    match server.validate() {
        Ok(()) => (Some(server), left_out),
        Err(error) => (None, vec![error.message]),
    }
}

/// Whether a flag or query name says it carries a secret: `--api-key`, `token`, `client_secret`.
fn secret_name(name: &str) -> bool {
    const WORDS: [&str; 10] = ["key", "apikey", "token", "secret", "password", "passwd", "pass", "credential", "credentials", "auth"];
    name.trim_start_matches('-').to_ascii_lowercase().split(['-', '_', '.']).any(|part| WORDS.contains(&part))
}

/// A value in one of the common credential shapes, whatever flag it follows.
fn looks_secret(value: &str) -> bool {
    const PREFIXES: [&str; 12] = ["sk-", "sk_live_", "sk_test_", "ghp_", "gho_", "ghs_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "AKIA", "AIza"];
    PREFIXES.iter().any(|prefix| value.starts_with(prefix) && value.len() >= prefix.len() + 8)
        || (value.starts_with("eyJ") && value.matches('.').count() == 2 && value.len() > 40)
}

/// The address without query parameters that carry a secret, and the names of those dropped.
fn without_secret_query(url: &str) -> (String, Vec<String>) {
    let Some((base, rest)) = url.split_once('?') else { return (url.to_string(), Vec::new()) };
    let (query, fragment) = rest.split_once('#').map_or((rest, None), |(query, fragment)| (query, Some(fragment)));
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if secret_name(name) || looks_secret(value) { dropped.push(name.to_string()) } else { kept.push(pair) }
    }
    let mut result = base.to_string();
    if !kept.is_empty() {
        result.push('?');
        result.push_str(&kept.join("&"));
    }
    if let Some(fragment) = fragment.filter(|fragment| !looks_secret(fragment) && !fragment.contains('=')) {
        result.push('#');
        result.push_str(fragment);
    }
    (result, dropped)
}

/// The arguments without a secret flag's value (`--api-key sk-...`, `--token=...`) or a bare key.
fn without_secret_args(args: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    let mut args = args.into_iter().peekable();
    while let Some(arg) = args.next() {
        if let Some((flag, _)) = arg.split_once('=').filter(|(flag, _)| flag.starts_with('-') && secret_name(flag)) {
            dropped.push(flag.to_string());
        } else if arg.starts_with('-') && secret_name(&arg) {
            if args.peek().is_some_and(|next| !next.starts_with('-')) {
                args.next();
            }
            dropped.push(arg);
        } else if looks_secret(&arg) {
            dropped.push("key-like".into());
        } else {
            kept.push(arg);
        }
    }
    (kept, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_in_an_address_or_arguments_are_left_behind() {
        let (url, dropped) = without_secret_query("https://mcp.example.com/mcp?team=web&api_key=abc123&token=xyz#frag");
        assert_eq!((url.as_str(), dropped), ("https://mcp.example.com/mcp?team=web#frag", vec!["api_key".to_string(), "token".to_string()]));
        assert_eq!(without_secret_query("https://mcp.example.com/mcp?q=sk-abcdefghijklmnop").0, "https://mcp.example.com/mcp");
        assert_eq!(without_secret_query("https://mcp.example.com/mcp").0, "https://mcp.example.com/mcp");
        let args = |list: &[&str]| list.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        let (kept, dropped) = without_secret_args(args(&["-y", "server", "--api-key", "sk-abcdefghijklmnop", "--token=abc", "--db", "test.db", "ghp_abcdefghijklmnopqrstuvwxyz", "--keyboard"]));
        assert_eq!(kept, args(&["-y", "server", "--db", "test.db", "--keyboard"]));
        assert_eq!(dropped, args(&["--api-key", "--token", "key-like"]));
        let (server, notes) = convert("Leaky", RawServer { command: Some("npx".into()), args: args(&["srv", "--auth-token", "abc"]), env: Vec::new(), url: None, headers: Vec::new(), bearer_env: None, sse: false, disabled: false });
        assert_eq!(server.unwrap().args, args(&["srv"]));
        assert!(notes.iter().any(|note| note.contains("--auth-token")));
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-other-tools-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn finds_instructions_skills_agents_and_servers_without_secret_values() {
        let home = temp("home");
        let project = temp("project");
        write(&home.join(".claude/CLAUDE.md"), "Prefer small diffs.");
        write(&home.join(".codex/AGENTS.md"), "   ");
        write(&project.join("GEMINI.md"), "Use pnpm.");
        write(&home.join(".claude/skills/review/SKILL.md"), "---\nname: review\ndescription: \"Reviews a diff\"\n---\nBody");
        write(&home.join(".agents/skills/plain/SKILL.md"), "No front matter");
        write(&home.join(".agents/skills/empty/notes.md"), "not a skill");
        #[cfg(unix)]
        std::os::unix::fs::symlink(home.join(".claude/skills/review"), home.join(".agents/skills/review-link")).unwrap();
        write(&home.join(".claude/agents/tester.md"), "---\nname: tester\ndescription: Writes tests\n---\nYou write tests.");
        write(
            &home.join(".claude.json"),
            &serde_json::json!({
                "mcpServers": {
                    "GitHub": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "ghp_secret_value_never_returned" } },
                    "Docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}", "X-Team": "secret-team" } },
                    "Leaky": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer sk-literal-secret" } },
                    "Plain": { "type": "http", "url": "http://example.com/mcp" }
                },
                "projects": { project.to_string_lossy(): { "mcpServers": { "local-db": { "command": "uvx mcp-server-sqlite --db test.db" } } } }
            })
            .to_string(),
        );
        write(&home.join(".codex/config.toml"), "[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\nbearer_token_env_var = \"LINEAR_TOKEN\"\n\n[mcp_servers.fs]\ncommand = \"npx\"\nargs = [\"-y\", \"fs-server\"]\nenabled = false\n");
        let places = Places::new(&home, None, None);
        write(&places.home(".config/opencode/opencode.json"), r#"{"mcp":{"browser":{"type":"local","command":["bunx","browser-mcp"],"environment":{"DEBUG":"1"}}}}"#);
        write(&places.home(CLAUDE_DESKTOP), r#"{"mcpServers":{"desk":{"command":"desk-mcp"}}}"#);

        let found = scan(&home, Some(&project.to_string_lossy())).unwrap();
        let json = serde_json::to_string(&found).unwrap();
        for secret in ["ghp_secret_value_never_returned", "sk-literal-secret", "secret-team"] {
            assert!(!json.contains(secret), "{secret} leaked");
        }

        assert_eq!(found.instructions.iter().map(|item| (item.tool, item.scope)).collect::<Vec<_>>(), vec![("claude-code", Scope::Global), ("gemini", Scope::Project)]);
        assert_eq!(found.instructions[0].place, "~/.claude/CLAUDE.md");

        let skills: Vec<_> = found.skills.iter().map(|skill| (skill.tool, skill.name.as_str(), skill.description.as_deref())).collect();
        assert_eq!(skills, vec![("claude-code", "review", Some("Reviews a diff")), ("shared", "plain", None)]);
        assert!(known_skill(&home, &found.skills[0].path).is_some());
        assert!(known_skill(&home, &home.join(".agents/skills/empty").to_string_lossy()).is_none());
        assert!(known_skill(&home, "/etc").is_none());

        assert_eq!(found.agents.len(), 1);
        assert_eq!(found.agents[0].description, "Writes tests");
        assert!(known_agent(&home, &found.agents[0].path).is_some());
        assert!(known_agent(&home, "/etc/hosts").is_none());

        let by_name = |name: &str| found.servers.iter().find(|item| item.original == name).unwrap_or_else(|| panic!("{name} missing from {:?}", found.servers.iter().map(|item| (&item.original, item.tool)).collect::<Vec<_>>()));
        let github = by_name("GitHub");
        let saved = github.server.as_ref().unwrap();
        assert_eq!((saved.name.as_str(), saved.env.clone()), ("github", vec!["GITHUB_TOKEN".to_string()]));
        assert!(github.left_out[0].contains("GITHUB_TOKEN"));
        let docs = by_name("Docs").server.as_ref().unwrap();
        assert_eq!(docs.bearer_env.as_deref(), Some("DOCS_TOKEN"));
        assert!(by_name("Docs").left_out.iter().any(|note| note.contains("X-Team")));
        assert_eq!(by_name("Leaky").server.as_ref().unwrap().bearer_env, None);
        assert!(by_name("Plain").server.is_none());
        let local = by_name("local-db");
        assert_eq!(local.scope, Scope::Project);
        assert_eq!(local.server.as_ref().unwrap().command, "uvx");
        assert_eq!(local.server.as_ref().unwrap().args, vec!["mcp-server-sqlite", "--db", "test.db"]);
        assert_eq!(by_name("linear").server.as_ref().unwrap().bearer_env.as_deref(), Some("LINEAR_TOKEN"));
        assert!(!by_name("fs").server.as_ref().unwrap().enabled);
        assert_eq!(by_name("desk").tool, "claude-desktop");
        let browser = by_name("browser").server.as_ref().unwrap();
        assert_eq!((browser.command.as_str(), browser.args.clone(), browser.env.clone()), ("bunx", vec!["browser-mcp".to_string()], vec!["DEBUG".to_string()]));

        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn names_follow_runrail_rules() {
        assert_eq!(server_name("GitHub Server"), "github-server");
        assert_eq!(server_name("123abc"), "abc");
        assert_eq!(server_name("!!!"), "server");
        assert_eq!(server_name(&"x".repeat(40)).len(), 32);
        assert_eq!(bearer_variable("Bearer ${TOKEN_1}").as_deref(), Some("TOKEN_1"));
        assert_eq!(bearer_variable("Bearer {env:TOKEN}").as_deref(), Some("TOKEN"));
        assert_eq!(bearer_variable("Bearer $TOKEN").as_deref(), Some("TOKEN"));
        assert_eq!(bearer_variable("Bearer abc.def"), None);
        assert_eq!(front_matter("---\nname: a\ndescription: 'b'\n---\n"), (Some("a".into()), Some("b".into())));
    }
}
