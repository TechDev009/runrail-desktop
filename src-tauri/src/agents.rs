//! Subagent definitions in a project's `.claude/agents`, the folder Claude Code reads: one Markdown
//! file per agent, with `name`, `description`, and optional `tools` and `model` in front matter and
//! the agent's instructions as the body. Front matter keys this editor does not show are kept.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{BridgeError, BridgeResult};
use crate::store::write_atomic;
use crate::workspace::resolve_workspace;

const AGENTS_DIR: &str = ".claude/agents";
const MAX_AGENTS: usize = 128;
const MAX_FILE: u64 = 96 * 1024;
const MAX_PROMPT: usize = 64 * 1024;
const MAX_DESCRIPTION: usize = 1024;
const MAX_TOOLS: usize = 64;
const KNOWN_KEYS: [&str; 4] = ["name", "description", "tools", "model"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// Empty means every tool the main agent has.
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub prompt: String,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("AGENT_INVALID", message)
}

fn unavailable() -> BridgeError {
    BridgeError::new("AGENT_UNAVAILABLE", "subagents could not be read or saved")
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty() && bytes.len() <= 64 && bytes[0].is_ascii_lowercase() && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_tool(tool: &str) -> bool {
    !tool.is_empty() && tool.len() <= 128 && tool.as_bytes()[0].is_ascii_alphabetic() && tool.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_:*().-".contains(&byte))
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 64 && model.as_bytes()[0].is_ascii_alphanumeric() && model.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-'))
}

impl AgentDefinition {
    pub fn validate(&self) -> BridgeResult<()> {
        if !valid_name(&self.name) {
            return Err(invalid("name must be lowercase letters, digits, or -, starting with a letter"));
        }
        if self.description.trim().is_empty() || self.description.chars().count() > MAX_DESCRIPTION || self.description.chars().any(char::is_control) {
            return Err(invalid("description must be one line of up to 1,024 characters"));
        }
        if self.tools.len() > MAX_TOOLS || !self.tools.iter().all(|tool| valid_tool(tool)) {
            return Err(invalid("tools must be tool names, such as Read or Bash"));
        }
        if self.model.as_deref().is_some_and(|model| !valid_model(model)) {
            return Err(invalid("model must be a model name such as sonnet, or inherit"));
        }
        if self.prompt.len() > MAX_PROMPT || self.prompt.contains('\0') {
            return Err(invalid("instructions are longer than 64 KB"));
        }
        Ok(())
    }

    fn render(&self, extra: &[String]) -> String {
        let mut text = format!("---\nname: {}\ndescription: {}\n", self.name, quoted(&self.description));
        if !self.tools.is_empty() {
            text.push_str(&format!("tools: {}\n", self.tools.join(", ")));
        }
        if let Some(model) = &self.model {
            text.push_str(&format!("model: {model}\n"));
        }
        for line in extra {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("---\n\n");
        text.push_str(self.prompt.trim_end());
        text.push('\n');
        text
    }
}

/// A YAML double-quoted scalar, so a colon or `#` in a description cannot break the front matter.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn unquoted(text: &str) -> String {
    let text = text.trim();
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        return text[1..text.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\");
    }
    if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') {
        return text[1..text.len() - 1].replace("''", "'");
    }
    text.to_string()
}

/// The definition and the front matter lines this editor leaves alone.
fn parse(text: &str) -> Option<(AgentDefinition, Vec<String>)> {
    let rest = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    let (front, body) = (&rest[..end], &rest[end + 4..]);
    let body = body.strip_prefix('\r').unwrap_or(body);
    let body = body.strip_prefix('\n').unwrap_or(body);
    let (mut name, mut description, mut tools, mut model) = (None, None, Vec::new(), None);
    let mut extra = Vec::new();
    for line in front.lines() {
        let key = line.split(':').next().unwrap_or("").trim();
        let value = line.split_once(':').map(|(_, value)| value.trim()).unwrap_or("");
        match key {
            "name" => name = Some(unquoted(value)),
            "description" => description = Some(unquoted(value)),
            "tools" => tools = unquoted(value).split(',').map(|tool| tool.trim().to_string()).filter(|tool| !tool.is_empty()).collect(),
            "model" => model = Some(unquoted(value)).filter(|model| !model.is_empty()),
            _ if !line.trim().is_empty() && !KNOWN_KEYS.contains(&key) => extra.push(line.to_string()),
            _ => {}
        }
    }
    Some((AgentDefinition { name: name?, description: description.unwrap_or_default(), tools, model, prompt: body.trim_start_matches('\n').to_string() }, extra))
}

fn directory(workspace: &str) -> BridgeResult<PathBuf> {
    let dir = resolve_workspace(workspace)?.join(AGENTS_DIR);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => Err(invalid(".claude/agents is a link; edit it in your editor")),
        _ => Ok(dir),
    }
}

/// Reads one agent file, if it is a plain file of a sensible size.
fn read(path: &Path) -> Option<(AgentDefinition, Vec<String>)> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_FILE {
        return None;
    }
    parse(&fs::read_to_string(path).ok()?)
}

pub fn list(workspace: &str) -> BridgeResult<Vec<AgentDefinition>> {
    let dir = directory(workspace)?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut agents: Vec<AgentDefinition> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        .take(MAX_AGENTS)
        .filter_map(|entry| read(&entry.path()).map(|(agent, _)| agent))
        .filter(|agent| valid_name(&agent.name))
        .collect();
    agents.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(agents)
}

/// Writes `<name>.md`, replacing the agent named `previous` when it is renamed.
pub fn save(workspace: &str, agent: AgentDefinition, previous: Option<&str>) -> BridgeResult<Vec<AgentDefinition>> {
    agent.validate()?;
    let dir = directory(workspace)?;
    let path = dir.join(format!("{}.md", agent.name));
    let replacing = previous.unwrap_or(&agent.name);
    if !valid_name(replacing) {
        return Err(invalid("no subagent has this name"));
    }
    let old = dir.join(format!("{replacing}.md"));
    if replacing != agent.name && fs::symlink_metadata(&path).is_ok() {
        return Err(invalid("another subagent already has this name"));
    }
    if let Ok(meta) = fs::symlink_metadata(&old) {
        if !meta.file_type().is_file() {
            return Err(invalid("that subagent's file is a link; edit it in your editor"));
        }
    }
    let extra = read(&old).map(|(_, extra)| extra).unwrap_or_default();
    write_atomic(&path, agent.render(&extra).as_bytes()).map_err(|_| unavailable())?;
    if replacing != agent.name {
        let _ = fs::remove_file(&old);
    }
    list(workspace)
}

/// Copies another tool's subagent file into the project, keeping front-matter lines Runrail does
/// not edit. An agent of the same name in the project is never replaced.
pub fn import(workspace: &str, source: &Path) -> BridgeResult<Vec<AgentDefinition>> {
    let (agent, extra) = read(source).ok_or_else(|| invalid("that file is not a subagent Runrail can read"))?;
    agent.validate()?;
    let dir = directory(workspace)?;
    let path = dir.join(format!("{}.md", agent.name));
    if fs::symlink_metadata(&path).is_ok() {
        return Err(BridgeError::new("AGENT_EXISTS", "the project already has a subagent with this name"));
    }
    write_atomic(&path, agent.render(&extra).as_bytes()).map_err(|_| unavailable())?;
    list(workspace)
}

pub fn remove(workspace: &str, name: &str) -> BridgeResult<Vec<AgentDefinition>> {
    if !valid_name(name) {
        return Err(invalid("no subagent has this name"));
    }
    let path = directory(workspace)?.join(format!("{name}.md"));
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_file() => fs::remove_file(&path).map_err(|_| unavailable())?,
        Ok(_) => return Err(invalid("that subagent's file is a link; edit it in your editor")),
        Err(_) => {}
    }
    list(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-agents-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn reviewer() -> AgentDefinition {
        AgentDefinition { name: "reviewer".into(), description: "Reviews diffs: finds \"real\" bugs".into(), tools: vec!["Read".into(), "Grep".into()], model: Some("sonnet".into()), prompt: "Review the diff.\n".into() }
    }

    #[test]
    fn writes_what_claude_code_reads_and_reads_it_back() {
        let dir = project("round");
        let workspace = dir.to_str().unwrap();
        assert!(list(workspace).unwrap().is_empty());
        save(workspace, reviewer(), None).unwrap();
        let text = fs::read_to_string(dir.join(".claude/agents/reviewer.md")).unwrap();
        assert_eq!(text, "---\nname: reviewer\ndescription: \"Reviews diffs: finds \\\"real\\\" bugs\"\ntools: Read, Grep\nmodel: sonnet\n---\n\nReview the diff.\n");
        assert_eq!(list(workspace).unwrap(), vec![AgentDefinition { prompt: "Review the diff.\n".into(), ..reviewer() }]);

        // A key this editor does not show survives an edit and a rename.
        fs::write(dir.join(".claude/agents/reviewer.md"), text.replace("model: sonnet\n", "model: sonnet\ncolor: blue\n")).unwrap();
        let renamed = AgentDefinition { name: "critic".into(), ..reviewer() };
        assert_eq!(save(workspace, renamed, Some("reviewer")).unwrap().iter().map(|agent| agent.name.as_str()).collect::<Vec<_>>(), vec!["critic"]);
        assert!(fs::read_to_string(dir.join(".claude/agents/critic.md")).unwrap().contains("color: blue\n"));
        assert!(!dir.join(".claude/agents/reviewer.md").exists());
        assert!(remove(workspace, "critic").unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_what_claude_code_would_not_load() {
        let dir = project("refuse");
        let workspace = dir.to_str().unwrap();
        let cases = [
            AgentDefinition { name: "Bad Name".into(), ..reviewer() },
            AgentDefinition { description: " ".into(), ..reviewer() },
            AgentDefinition { description: "two\nlines".into(), ..reviewer() },
            AgentDefinition { tools: vec!["rm -rf".into()], ..reviewer() },
            AgentDefinition { model: Some("Opus 4".into()), ..reviewer() },
            AgentDefinition { prompt: "x".repeat(MAX_PROMPT + 1), ..reviewer() },
        ];
        for agent in cases {
            assert_eq!(save(workspace, agent, None).unwrap_err().code, "AGENT_INVALID");
        }
        save(workspace, reviewer(), None).unwrap();
        save(workspace, AgentDefinition { name: "other".into(), ..reviewer() }, None).unwrap();
        assert_eq!(save(workspace, AgentDefinition { name: "other".into(), ..reviewer() }, Some("reviewer")).unwrap_err().code, "AGENT_INVALID");
        assert_eq!(remove(workspace, "../escape").unwrap_err().code, "AGENT_INVALID");
        let _ = fs::remove_dir_all(&dir);
    }
}
