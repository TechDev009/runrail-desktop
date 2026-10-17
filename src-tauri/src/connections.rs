//! Host rules for connections, stored secrets, and sign-in.
//!
//! The web view is not trusted with credentials. It may name a connection and hand over a secret
//! once, but it cannot read one back, point a stored one at another address, or choose the page a
//! sign-in opens. Everything here is a pure check or a bounded encoder, so each rule has a test.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::Url;
use zeroize::Zeroizing;

use crate::error::{BridgeError, BridgeResult};

/// The engine that owns accounts and sign-ins. Only the host starts it; it has no project.
pub const SYSTEM_ENGINE_ID: &str = "system";

/// Same bound as the engine's vault.
pub const MAX_SECRET_BYTES: usize = 16 * 1024;
const MAX_SIGN_IN_INPUT_BYTES: usize = 16 * 1024;
const MAX_URL_BYTES: usize = 4096;
const MAX_PARAM_NODES: usize = 20_000;

/// Whether the host can read a secret from the clipboard itself, so it never enters the web view.
pub const CLIPBOARD_SECRETS: bool = cfg!(any(target_os = "macos", target_os = "linux"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vault {
    Keychain,
    File,
}

impl Vault {
    pub fn flag(self) -> &'static str {
        match self {
            Vault::Keychain => "keychain",
            Vault::File => "file",
        }
    }
}

/// Where engines keep accounts and their secrets. The engine is the only reader and writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialStorage {
    pub accounts_dir: PathBuf,
    pub vault: Vault,
}

impl CredentialStorage {
    /// Signed release builds use the OS keychain and the account list the `runrail` CLI uses.
    /// Development builds are re-signed on every build, which makes the keychain ask again each
    /// time, so they keep a private file vault under the app data folder. `requested` is the
    /// explicit override (`file` or `keychain`); anything else is ignored.
    /// `keychain` says whether the OS keychain can answer at all (see `os_keychain_available`).
    pub fn select(app_data: &Path, home: Option<&Path>, requested: Option<&str>, debug: bool, keychain: bool) -> Self {
        let vault = match requested {
            Some("file") => Vault::File,
            Some("keychain") => Vault::Keychain,
            _ if debug || !keychain => Vault::File,
            _ => Vault::Keychain,
        };
        let accounts_dir = match (vault, home) {
            (Vault::Keychain, Some(home)) => home.join(".runrail").join("accounts"),
            _ => app_data.join("accounts"),
        };
        Self { accounts_dir, vault }
    }
}

/// Whether a Secret Service (GNOME Keyring, KWallet, KeePassXC) runs or can be started on the
/// session bus. Without one every keychain call fails, so engines keep keys in the file vault.
#[cfg(target_os = "linux")]
pub fn os_keychain_available() -> bool {
    const SECRETS: &str = "org.freedesktop.secrets";
    let Ok(connection) = zbus::blocking::Connection::session() else { return false };
    let Ok(bus) = zbus::blocking::fdo::DBusProxy::new(&connection) else { return false };
    let Ok(name) = zbus::names::BusName::try_from(SECRETS) else { return false };
    bus.name_has_owner(name).unwrap_or(false) || bus.list_activatable_names().is_ok_and(|names| names.iter().any(|listed| listed.as_str() == SECRETS))
}

#[cfg(not(target_os = "linux"))]
pub fn os_keychain_available() -> bool {
    true
}

fn refused(message: &str) -> BridgeError {
    BridgeError::new("HOST_RPC_REFUSED", message).with_status(403)
}

/// `^[A-Za-z][A-Za-z0-9._:-]{0,255}$`, the engine's own connection id pattern.
pub fn valid_connection_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 256
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// `^login-[0-9a-f-]{36}$`, the engine's own sign-in id pattern.
pub fn valid_login_id(value: &str) -> bool {
    value.strip_prefix("login-").is_some_and(|rest| {
        rest.len() == 36 && rest.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'))
    })
}

/// Parameter names that carry a raw credential. None of them is ever valid from the web view.
const RAW_CREDENTIAL_KEYS: &[&str] = &["secret", "token", "apikey", "key", "password", "accesstoken", "refreshtoken", "credential"];
/// Methods that touch accounts, stored secrets, a connector's settings, or a provider address.
const CREDENTIAL_NAMESPACES: &[&str] = &["account.", "connection.", "auth.", "provider.", "model.", "connector.setup."];
/// All the system engine answers for the web view.
const SYSTEM_NAMESPACES: &[&str] = &["account.", "connection.", "auth."];
/// Read-only questions it also answers: which coding tools are installed, so they can be offered
/// before any project is open. The answer names no account. And the person's git host answers,
/// which hold no secret: `codehost.status` returns only the GitHub CLI's login, and
/// `codehost.remotes` a project folder's remotes with user info removed from their URLs. And
/// `conversation.peek`: a thread's history, read from its transcript without changing it, which
/// the web view is shown in that thread anyway. And `usage.read`: a coding tool's plan limits,
/// percentages and reset times only, read one account at a time. And the Reviews inbox's reads,
/// `git.pr.search`, `git.pr.teams`, `git.pr.view`, and `git.pr.diff`, through the person's own
/// `gh` once they connected the host, and its two writes, `git.pr.review.post` and `git.pr.merge`,
/// which the person confirms in a native dialog (`control_rpc`) before they reach the engine. And `workflow.due`:
/// which saved workflows should start now, noted as fired so each fires once; it starts nothing.
/// And `workflow.upcoming`: how many start by themselves, and the next scheduled one, for the menu
/// bar item.
/// And the built-in connectors' settings, `connector.setup.*`, which hold no key: a key has its own
/// command. And `claude.sdk.status` and `claude.sdk.install`: whether the Claude Agent SDK is
/// downloaded, and its download, pinned and checked against its SHA-512, which the person asks
/// for in the app.
const SYSTEM_METHODS: &[&str] = &["harness.status", "claude.sdk.status", "claude.sdk.install", "codehost.list", "codehost.set", "codehost.connect", "codehost.disconnect", "codehost.status", "codehost.remotes", "conversation.peek", "usage.read", "thread.copy", "git.pr.search", "git.pr.teams", "git.pr.view", "git.pr.diff", "git.pr.review.post", "git.pr.merge", "workflow.due", "workflow.upcoming", "connector.setup.list", "connector.setup.save", "connector.setup.remove", "push.vapid", "push.send"];
/// Answered only by the system engine, so one reader keeps tool starts to one at a time, and one
/// engine downloads the SDK.
const SYSTEM_ONLY_METHODS: &[&str] = &["conversation.peek", "usage.read", "claude.sdk.status", "claude.sdk.install", "thread.copy", "push.vapid", "push.send"];
/// The older provider methods let the caller name an address and the shell variable to send
/// there. The web view gets neither: a connection fixes both.
const CALLER_ADDRESS_METHODS: &[&str] = &["provider.select", "provider.discover", "model.discover"];
const CALLER_ADDRESS_KEYS: &[&str] = &["endpoint", "credentialEnvironment", "allowInsecureRemote", "headers", "accountId"];

fn in_namespace(method: &str, namespaces: &[&str]) -> bool {
    namespaces.iter().any(|namespace| method.starts_with(namespace))
}

/// True when any object in `value`, at any depth, has a key that names a raw credential.
fn names_raw_credential(value: &Value) -> bool {
    let mut stack = vec![value];
    let mut seen = 0_usize;
    while let Some(node) = stack.pop() {
        seen += 1;
        if seen > MAX_PARAM_NODES {
            return true;
        }
        match node {
            Value::Object(object) => {
                for (key, child) in object {
                    if RAW_CREDENTIAL_KEYS.iter().any(|raw| key.eq_ignore_ascii_case(raw)) {
                        return true;
                    }
                    stack.push(child);
                }
            }
            Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    false
}

/// Decides whether a control request from the web view may reach an engine.
pub fn guard_renderer_rpc(engine_id: &str, method: &str, params: &Value) -> BridgeResult<()> {
    // Secrets have one door: the dedicated commands, which never return what they were given.
    if method == "auth.secret" || method.starts_with("auth.secret.") {
        return Err(refused("secrets are set through the connection commands"));
    }
    let system = engine_id == SYSTEM_ENGINE_ID;
    if system && !in_namespace(method, SYSTEM_NAMESPACES) && !SYSTEM_METHODS.contains(&method) {
        return Err(refused("the system engine only manages connections"));
    }
    // Sign-ins run on the system engine so `auth_open` can check the page against the flow.
    if !system && method.starts_with("auth.") {
        return Err(refused("sign-in runs on the system engine"));
    }
    if !system && SYSTEM_ONLY_METHODS.contains(&method) {
        return Err(refused("this is answered by the system engine"));
    }
    if !in_namespace(method, CREDENTIAL_NAMESPACES) {
        return Ok(());
    }
    if names_raw_credential(params) {
        return Err(refused("raw credentials are not accepted in control requests"));
    }
    // The address a user pastes back during sign-in carries a one-time code; it has its own command.
    if method.starts_with("auth.") && params.get("input").is_some() {
        return Err(refused("sign-in input is sent through its own command"));
    }
    if CALLER_ADDRESS_METHODS.contains(&method) && CALLER_ADDRESS_KEYS.iter().any(|key| params.get(*key).is_some()) {
        return Err(refused("a provider address is chosen by its connection"));
    }
    if matches!(method, "account.create" | "account.upsert") {
        // A shell variable no preset owns could otherwise be sent to any address the caller names.
        let reads_shell = matches!(params.get("authMode").and_then(Value::as_str), Some("environment" | "api-key-reference"))
            || params.get("environmentName").is_some();
        if reads_shell && params.get("baseUrl").is_some() {
            return Err(refused("a custom address takes a pasted key, not a shell variable"));
        }
    }
    Ok(())
}

fn url_refused(message: &str) -> BridgeError {
    BridgeError::new("AUTH_URL_REFUSED", message)
}

/// The only sign-in pages the host opens: `https`, no user info, the default port, and a host
/// that is exactly one of the hosts the flow declares.
pub fn allowed_sign_in_url(candidate: &str, hosts: &[String]) -> BridgeResult<Url> {
    if candidate.is_empty() || candidate.len() > MAX_URL_BYTES || candidate.chars().any(|char| char.is_control() || char.is_whitespace()) {
        return Err(url_refused("sign-in address is invalid"));
    }
    let url = Url::parse(candidate).map_err(|_| url_refused("sign-in address is invalid"))?;
    if url.scheme() != "https" {
        return Err(url_refused("sign-in address must use https"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err(url_refused("sign-in address is invalid"));
    }
    // `domain` is `None` for an IP address: sign-in pages are named hosts.
    let Some(host) = url.domain() else {
        return Err(url_refused("sign-in address is invalid"));
    };
    if !hosts.iter().any(|allowed| !allowed.is_empty() && allowed.eq_ignore_ascii_case(host)) {
        return Err(url_refused("sign-in address is not on this provider's list"));
    }
    Ok(url)
}

/// Picks the page for a running sign-in from the engine's own answers: the newest `open-url` or
/// `device-code` step in `status`, checked against the hosts `flows` lists for that flow.
pub fn sign_in_target(status: &Value, flows: &Value) -> BridgeResult<Url> {
    let unavailable = || BridgeError::new("AUTH_URL_UNAVAILABLE", "this sign-in has no page to open");
    let flow_id = status.get("flow").and_then(Value::as_str).ok_or_else(unavailable)?;
    let candidate = status
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|event| match event.get("type").and_then(Value::as_str) {
            Some("open-url") => event.get("url").and_then(Value::as_str),
            Some("device-code") => event.get("verificationUrl").and_then(Value::as_str),
            _ => None,
        })
        .last()
        .ok_or_else(unavailable)?;
    let hosts: Vec<String> = flows
        .as_array()
        .into_iter()
        .flatten()
        .find(|flow| flow.get("id").and_then(Value::as_str) == Some(flow_id))
        .and_then(|flow| flow.get("browserHosts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|host| host.as_str().map(str::to_string))
        .collect();
    allowed_sign_in_url(candidate, &hosts)
}

/// Trims and bounds a typed or pasted value. Returns a slice of the input: no copy is made.
fn bounded_input<'a>(value: &'a str, max_bytes: usize, code: &str, message: &str) -> BridgeResult<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes || trimmed.chars().any(char::is_control) {
        return Err(BridgeError::new(code, message));
    }
    Ok(trimmed)
}

fn push_json_string(output: &mut Vec<u8>, value: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.push(b'"');
    for byte in value.bytes() {
        match byte {
            b'"' | b'\\' => output.extend_from_slice(&[b'\\', byte]),
            0..=0x1f => output.extend_from_slice(&[b'\\', b'u', b'0', b'0', HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 0x0f)]]),
            _ => output.push(byte),
        }
    }
    output.push(b'"');
}

/// `{"<id_key>":"<id>","<value_key>":"<value>"}` in one allocation that is sized up front, so the
/// value is never left behind in a buffer the vector outgrew. The result wipes itself on drop.
fn private_body(id_key: &str, id: &str, value_key: &str, value: &str) -> Zeroizing<Vec<u8>> {
    let capacity = 16 + id_key.len() + id.len() * 6 + value_key.len() + value.len() * 6;
    let mut body = Zeroizing::new(Vec::with_capacity(capacity));
    let start = body.as_ptr();
    body.push(b'{');
    push_json_string(&mut body, id_key);
    body.push(b':');
    push_json_string(&mut body, id);
    body.push(b',');
    push_json_string(&mut body, value_key);
    body.push(b':');
    push_json_string(&mut body, value);
    body.push(b'}');
    debug_assert_eq!(body.as_ptr(), start, "the body must stay in its first allocation");
    body
}

/// Request body for the engine's write-only secret endpoint.
#[cfg(test)]
pub fn secret_body(connection_id: &str, secret: &str) -> BridgeResult<Zeroizing<Vec<u8>>> {
    secret_body_for(SecretOwner::Account, connection_id, secret)
}

/// Whose key a secret is. A coding-tool connection's key is stored under the connection's own id,
/// which the engine reads as `connectionId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretOwner {
    Account,
    ToolConnection,
    /// A built-in connector's key (Linear, Slack, Jira), named by its kind.
    Connector,
}

pub fn secret_body_for(owner: SecretOwner, connection_id: &str, secret: &str) -> BridgeResult<Zeroizing<Vec<u8>>> {
    if !valid_connection_id(connection_id) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "connection id is invalid"));
    }
    let secret = bounded_input(secret, MAX_SECRET_BYTES, "CONNECTION_SECRET_INVALID", "the key is empty, too long, or not plain text")?;
    let id_key = match owner {
        SecretOwner::Account => "accountId",
        SecretOwner::ToolConnection => "connectionId",
        SecretOwner::Connector => "connectorId",
    };
    Ok(private_body(id_key, connection_id, "secret", secret))
}

/// Request body for the address a user pastes back during a sign-in.
pub fn sign_in_input_body(login_id: &str, input: &str) -> BridgeResult<Zeroizing<Vec<u8>>> {
    if !valid_login_id(login_id) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "sign-in id is invalid"));
    }
    let input = bounded_input(input, MAX_SIGN_IN_INPUT_BYTES, "AUTH_INPUT_INVALID", "the pasted address is empty, too long, or not plain text")?;
    Ok(private_body("loginId", login_id, "input", input))
}

/// Reads the clipboard in the host, so a pasted key never passes through the web view.
#[cfg(target_os = "macos")]
pub fn read_clipboard_secret() -> BridgeResult<Zeroizing<String>> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let unavailable = || BridgeError::new("CLIPBOARD_UNAVAILABLE", "the clipboard could not be read");
    let mut child = Command::new("/usr/bin/pbpaste")
        .args(["-Prefer", "txt"])
        .env_clear()
        .env("LC_CTYPE", "UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| unavailable())?;
    // One fixed buffer: nothing is reallocated, and it is wiped when this function returns.
    let mut buffer = Zeroizing::new(vec![0_u8; MAX_SECRET_BYTES + 1]);
    let mut filled = 0;
    let mut failed = false;
    if let Some(mut stdout) = child.stdout.take() {
        while filled < buffer.len() {
            match stdout.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(count) => filled += count,
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
    } else {
        failed = true;
    }
    let _ = child.kill();
    let _ = child.wait();
    if failed {
        return Err(unavailable());
    }
    let invalid = || BridgeError::new("CONNECTION_SECRET_INVALID", "the clipboard does not hold a key");
    if filled > MAX_SECRET_BYTES {
        return Err(invalid());
    }
    let text = std::str::from_utf8(&buffer[..filled]).map_err(|_| invalid())?;
    let mut secret = Zeroizing::new(String::with_capacity(text.len()));
    secret.push_str(text);
    Ok(secret)
}

/// Reads the clipboard in the host: on Wayland through the compositor's data-control protocol
/// where it has one, otherwise through X11 (XWayland on GNOME). arboard's own buffers are not
/// wiped; the copy handed on is.
#[cfg(target_os = "linux")]
pub fn read_clipboard_secret() -> BridgeResult<Zeroizing<String>> {
    let unavailable = || BridgeError::new("CLIPBOARD_UNAVAILABLE", "the clipboard could not be read");
    let invalid = || BridgeError::new("CONNECTION_SECRET_INVALID", "the clipboard does not hold a key");
    let mut clipboard = arboard::Clipboard::new().map_err(|_| unavailable())?;
    let text = Zeroizing::new(clipboard.get_text().map_err(|error| if matches!(error, arboard::Error::ContentNotAvailable) { invalid() } else { unavailable() })?);
    if text.len() > MAX_SECRET_BYTES {
        return Err(invalid());
    }
    Ok(text)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn read_clipboard_secret() -> BridgeResult<Zeroizing<String>> {
    Err(BridgeError::new("CLIPBOARD_UNSUPPORTED", "reading the clipboard is not supported on this system"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zeroize::Zeroize;

    use super::*;

    fn refusal(engine: &str, method: &str, params: Value) -> Option<(String, Option<u16>)> {
        guard_renderer_rpc(engine, method, &params).err().map(|error| (error.code, error.status))
    }

    fn is_refused(engine: &str, method: &str, params: Value) -> bool {
        refusal(engine, method, params) == Some(("HOST_RPC_REFUSED".to_string(), Some(403)))
    }

    #[test]
    fn secret_methods_never_pass_the_generic_channel() {
        for engine in [SYSTEM_ENGINE_ID, "thread-1"] {
            assert!(is_refused(engine, "auth.secret.set", json!({ "accountId": "a" })));
            assert!(is_refused(engine, "auth.secret.get", json!({})));
            assert!(is_refused(engine, "auth.secret", json!({})));
        }
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "auth.flows", &json!({})).is_ok());
    }

    #[test]
    fn the_system_engine_answers_which_tools_are_installed_and_nothing_else_outside_connections() {
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "harness.status", &json!({ "refresh": true })).is_ok());
        for method in ["codehost.list", "codehost.set", "codehost.connect", "codehost.disconnect", "codehost.status"] {
            assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, method, &json!({ "host": "github.com" })).is_ok(), "{method}");
        }
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "codehost.remotes", &json!({ "path": "/Users/me/code/web" })).is_ok());
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "conversation.peek", &json!({ "threadId": "t1", "workspace": "/Users/me/code/web" })).is_ok());
        assert!(is_refused("thread-1", "conversation.peek", json!({ "threadId": "t2", "workspace": "/Users/me/code/web" })));
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "usage.read", &json!({ "tool": "claude-code", "connectionId": "c1" })).is_ok());
        assert!(is_refused("thread-1", "usage.read", json!({ "tool": "codex" })));
        for method in ["claude.sdk.status", "claude.sdk.install"] {
            assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, method, &json!({ "confirm": true })).is_ok(), "{method}");
            assert!(is_refused("thread-1", method, json!({ "confirm": true })), "{method}");
        }
        for method in ["git.pr.search", "git.pr.teams", "git.pr.view", "git.pr.diff", "git.pr.review.post", "git.pr.merge"] {
            assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, method, &json!({ "owner": "example-org", "repo": "web", "number": 1 })).is_ok(), "{method}");
        }
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "workflow.due", &json!({})).is_ok());
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "workflow.upcoming", &json!({})).is_ok());
        for method in ["connector.setup.list", "connector.setup.save", "connector.setup.remove"] {
            assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, method, &json!({ "id": "jira", "on": true, "site": "your-team.atlassian.net", "email": "me@example.com" })).is_ok(), "{method}");
        }
        for method in ["connector.invoke", "connector.setup.", "connector.setup.listx", "workflow.run.start", "workflow.save", "workflow.duex", "workflow.", "harness.list", "harness.statusx", "terminal.create", "turn.enqueue", "background.list", "codehost.listx", "codehost.", "codehost.remotesx", "git.remote.list", "conversation.peekx", "session.conversation.read", "usage.readx", "usage.", "claude.sdk", "claude.sdk.", "claude.sdk.statusx", "plan.limits", "git.pr.create", "git.pr.mergex", "git.pr.review", "git.pr.searchx", "git.pr."] {
            assert!(is_refused(SYSTEM_ENGINE_ID, method, json!({})), "{method}");
        }
    }

    #[test]
    fn a_connector_key_never_rides_in_its_settings() {
        assert!(is_refused(SYSTEM_ENGINE_ID, "connector.setup.save", json!({ "id": "linear", "on": true, "key": "lin_api_secret" })));
        assert!(is_refused(SYSTEM_ENGINE_ID, "connector.setup.save", json!({ "id": "jira", "on": true, "nested": { "apiKey": "x" } })));
        assert!(!is_refused(SYSTEM_ENGINE_ID, "connector.setup.save", json!({ "id": "jira", "on": true, "site": "your-team.atlassian.net", "email": "me@example.test" })));
    }

    #[test]
    fn raw_credentials_are_refused_at_any_depth() {
        for key in ["secret", "token", "apiKey", "password", "accessToken", "refreshToken", "credential", "APIKEY"] {
            assert!(is_refused(SYSTEM_ENGINE_ID, "account.create", json!({ "accountId": "a", key: "x" })), "{key}");
            assert!(is_refused("thread-1", "provider.select", json!({ "connectionId": "a", "options": [{ "deep": { key: "x" } }] })), "{key}");
            assert!(is_refused("thread-1", "model.discover", json!({ key: "x" })), "{key}");
        }
        // Outside the credential methods a field with such a name is ordinary tool or task data.
        assert!(guard_renderer_rpc("thread-1", "connector.invoke", &json!({ "input": { "token": "page-2" } })).is_ok());
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "account.create", &json!({ "accountId": "a", "provider": "openai", "label": "Key", "authMode": "api-key" })).is_ok());
    }

    #[test]
    fn the_system_engine_only_manages_connections() {
        for method in ["task.start", "turn.enqueue", "terminal.open", "git.push", "provider.discover", "model.discover", "control.describe", "background.list", "background.output", "background.stop"] {
            assert!(is_refused(SYSTEM_ENGINE_ID, method, json!({})), "{method}");
        }
        for method in ["account.list", "connection.presets", "connection.models", "auth.login.start", "auth.login.status", "auth.logout"] {
            assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, method, &json!({})).is_ok(), "{method}");
        }
        // A tool's own sign-in runs in a terminal in the dialog: the engine picks the command, the person types.
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "connection.loginStart", &json!({ "connectionId": "claude-code-2", "cols": 80, "rows": 16 })).is_ok());
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "connection.loginWrite", &json!({ "loginId": "login-1", "data": "code\r" })).is_ok());
        // A project engine runs turns, and leaves sign-in to the system engine.
        assert!(guard_renderer_rpc("thread-1", "task.start", &json!({ "message": "hi" })).is_ok());
        assert!(guard_renderer_rpc("thread-1", "background.stop", &json!({ "id": "native:cmd-1" })).is_ok());
        assert!(is_refused("thread-1", "auth.login.start", json!({ "flow": "chatgpt" })));
        assert!(is_refused("thread-1", "auth.flows", json!({})));
    }

    #[test]
    fn sign_in_input_has_its_own_command() {
        assert!(is_refused(SYSTEM_ENGINE_ID, "auth.login.status", json!({ "loginId": "login-x", "input": "https://127.0.0.1/cb?code=1" })));
        assert!(is_refused(SYSTEM_ENGINE_ID, "auth.login.input", json!({ "input": "x" })));
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "auth.login.status", &json!({ "loginId": "login-x", "afterSeq": 2, "waitMs": 500 })).is_ok());
    }

    #[test]
    fn the_web_view_cannot_name_a_provider_address() {
        for method in ["provider.select", "provider.discover", "model.discover"] {
            for key in ["endpoint", "credentialEnvironment", "allowInsecureRemote", "headers", "accountId"] {
                assert!(is_refused("thread-1", method, json!({ "provider": "openai", key: "x" })), "{method} {key}");
            }
        }
        assert!(guard_renderer_rpc("thread-1", "provider.discover", &json!({ "provider": "openai", "allowRemote": true, "timeoutMs": 8000, "maxRetries": 0 })).is_ok());
        assert!(guard_renderer_rpc("thread-1", "provider.select", &json!({ "connectionId": "openai-1", "model": "gpt-5" })).is_ok());
    }

    #[test]
    fn a_shell_variable_never_goes_to_a_custom_address() {
        let custom = |extra: Value| {
            let mut params = json!({ "accountId": "a", "provider": "custom-openai-chat", "label": "Relay", "baseUrl": "https://relay.example/v1" });
            params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            params
        };
        for method in ["account.create", "account.upsert"] {
            assert!(is_refused(SYSTEM_ENGINE_ID, method, custom(json!({ "authMode": "environment", "environmentName": "GITHUB_TOKEN" }))));
            assert!(is_refused(SYSTEM_ENGINE_ID, method, custom(json!({ "authMode": "api-key-reference" }))));
            assert!(is_refused(SYSTEM_ENGINE_ID, method, custom(json!({ "authMode": "api-key", "environmentName": "GITHUB_TOKEN" }))));
            assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, method, &custom(json!({ "authMode": "api-key" }))).is_ok());
        }
        let preset = json!({ "accountId": "a", "provider": "openai", "label": "Shell", "authMode": "environment", "environmentName": "OPENAI_API_KEY" });
        assert!(guard_renderer_rpc(SYSTEM_ENGINE_ID, "account.create", &preset).is_ok());
    }

    #[test]
    fn sign_in_pages_are_allowlisted() {
        let hosts = vec!["auth.openai.com".to_string(), "openrouter.ai".to_string()];
        let ok = allowed_sign_in_url("https://auth.openai.com/oauth/authorize?state=abc&code_challenge=xyz", &hosts).unwrap();
        assert_eq!(ok.host_str(), Some("auth.openai.com"));
        assert!(allowed_sign_in_url("https://AUTH.OpenAI.com/oauth/authorize", &hosts).is_ok());
        assert!(allowed_sign_in_url("https://openrouter.ai:443/auth", &hosts).is_ok());
        for refused in [
            "http://auth.openai.com/oauth/authorize",
            "https://evil.example/oauth/authorize",
            "https://auth.openai.com@evil.example/",
            "https://user:pass@auth.openai.com/",
            "https://user@auth.openai.com/",
            "https://evil.auth.openai.com/",
            "https://auth.openai.com.evil.example/",
            "https://xauth.openai.com/",
            "https://auth.openai.com./",
            "https://auth.openai.com:8443/",
            "https://evil.example\\@auth.openai.com/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "auth.openai.com/oauth",
            "https://auth.openai.com/ path",
            "https://auth.openai.com/\n",
            "",
        ] {
            let error = allowed_sign_in_url(refused, &hosts).expect_err(refused);
            assert_eq!(error.code, "AUTH_URL_REFUSED", "{refused}");
        }
        assert!(allowed_sign_in_url("https://auth.openai.com/", &[]).is_err());
        assert!(allowed_sign_in_url("https://auth.openai.com/", &[String::new()]).is_err());
        assert!(allowed_sign_in_url(&format!("https://auth.openai.com/{}", "a".repeat(MAX_URL_BYTES)), &hosts).is_err());
    }

    #[test]
    fn the_sign_in_page_comes_from_the_engine_and_its_flow() {
        let flows = json!([
            { "id": "chatgpt", "browserHosts": ["auth.openai.com"] },
            { "id": "device", "browserHosts": ["login.example"] },
        ]);
        let status = |flow: &str, events: Value| json!({ "loginId": "login-1", "flow": flow, "state": "waiting", "events": events });
        let first = json!({ "seq": 1, "type": "open-url", "url": "https://auth.openai.com/a", "redirect": "loopback" });
        let second = json!({ "seq": 2, "type": "open-url", "url": "https://auth.openai.com/b", "redirect": "manual" });
        assert_eq!(sign_in_target(&status("chatgpt", json!([first, second])), &flows).unwrap().path(), "/b");
        let device = json!({ "seq": 1, "type": "device-code", "userCode": "ABCD", "verificationUrl": "https://login.example/device" });
        assert_eq!(sign_in_target(&status("device", json!([device])), &flows).unwrap().host_str(), Some("login.example"));
        // A page for another flow's host, an unknown flow, and a sign-in with no page are refused.
        let crossed = json!({ "seq": 1, "type": "open-url", "url": "https://login.example/device" });
        assert_eq!(sign_in_target(&status("chatgpt", json!([crossed.clone()])), &flows).unwrap_err().code, "AUTH_URL_REFUSED");
        assert_eq!(sign_in_target(&status("missing", json!([crossed])), &flows).unwrap_err().code, "AUTH_URL_REFUSED");
        assert_eq!(sign_in_target(&status("chatgpt", json!([{ "seq": 1, "type": "finishing" }])), &flows).unwrap_err().code, "AUTH_URL_UNAVAILABLE");
        assert_eq!(sign_in_target(&json!({}), &flows).unwrap_err().code, "AUTH_URL_UNAVAILABLE");
    }

    #[test]
    fn ids_follow_the_engine_patterns() {
        assert!(valid_connection_id("openai-1") && valid_connection_id("signin-chatgpt") && valid_connection_id("a:b.c_d"));
        assert!(!valid_connection_id("") && !valid_connection_id("1abc") && !valid_connection_id("a b") && !valid_connection_id("a/b"));
        assert!(!valid_connection_id(&format!("a{}", "b".repeat(256))));
        assert!(valid_login_id("login-0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!valid_login_id("login-short") && !valid_login_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!valid_login_id("login-0F8FAD5B-D9CB-469F-A165-70867728950E"));
    }

    #[test]
    fn private_bodies_are_exact_json() {
        let body = secret_body("conn-1", "  sk-\"quoted\"\\key  ").unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed, json!({ "accountId": "conn-1", "secret": "sk-\"quoted\"\\key" }));
        let connector = secret_body_for(SecretOwner::Connector, "slack", "xoxb-1").unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&connector).unwrap(), json!({ "connectorId": "slack", "secret": "xoxb-1" }));
        let body = secret_body_for(SecretOwner::ToolConnection, "claude-code-2", " sk-tool ").unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({ "connectionId": "claude-code-2", "secret": "sk-tool" }));
        assert_eq!(secret_body_for(SecretOwner::ToolConnection, "bad id", "sk-x").unwrap_err().code, "CONTROL_INVALID_INPUT");
        let body = sign_in_input_body("login-0f8fad5b-d9cb-469f-a165-70867728950e", "https://127.0.0.1:1455/auth/callback?code=abc&state=é").unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["input"], "https://127.0.0.1:1455/auth/callback?code=abc&state=é");
        assert_eq!(parsed.as_object().unwrap().len(), 2);

        assert_eq!(secret_body("bad id", "sk-x").unwrap_err().code, "CONTROL_INVALID_INPUT");
        for secret in ["", "   ", "line\nbreak", "nul\0"] {
            assert_eq!(secret_body("conn-1", secret).unwrap_err().code, "CONNECTION_SECRET_INVALID");
        }
        assert_eq!(secret_body("conn-1", &"k".repeat(MAX_SECRET_BYTES + 1)).unwrap_err().code, "CONNECTION_SECRET_INVALID");
        assert!(secret_body("conn-1", &"k".repeat(MAX_SECRET_BYTES)).is_ok());
        assert_eq!(sign_in_input_body("login-x", "https://a").unwrap_err().code, "CONTROL_INVALID_INPUT");
        assert_eq!(sign_in_input_body("login-0f8fad5b-d9cb-469f-a165-70867728950e", " ").unwrap_err().code, "AUTH_INPUT_INVALID");
    }

    #[test]
    fn secrets_are_wiped_after_use() {
        const CANARY: &str = "sk-canary-0123456789abcdef";
        let contains = |bytes: &[u8]| bytes.windows(CANARY.len()).any(|window| window == CANARY.as_bytes());

        let mut body = secret_body("conn-1", CANARY).unwrap();
        assert!(contains(&body));
        let (pointer, capacity) = (body.as_ptr(), body.capacity());
        // Sized for the worst case up front, so the body never moved and left a copy behind.
        assert!(capacity >= 16 + "accountId".len() + "conn-1".len() * 6 + "secret".len() + CANARY.len() * 6);
        body.zeroize();
        assert!(body.is_empty());
        assert_eq!((body.as_ptr(), body.capacity()), (pointer, capacity));
        // SAFETY: the allocation is still owned by `body`, and `zeroize` wrote every byte of it.
        let memory = unsafe { std::slice::from_raw_parts(pointer, capacity) };
        assert!(memory.iter().all(|byte| *byte == 0));

        let mut secret = Zeroizing::new(String::from(CANARY));
        let (pointer, capacity) = (secret.as_ptr(), secret.capacity());
        secret.zeroize();
        assert!(secret.is_empty());
        // SAFETY: as above; the string still owns the allocation.
        let memory = unsafe { std::slice::from_raw_parts(pointer, capacity) };
        assert!(memory.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn credential_storage_follows_the_build() {
        let app_data = Path::new("/data/app");
        let home = Path::new("/home/user");
        let pick = |requested: Option<&str>, debug: bool| CredentialStorage::select(app_data, Some(home), requested, debug, true);
        assert_eq!(pick(None, true), CredentialStorage { accounts_dir: app_data.join("accounts"), vault: Vault::File });
        assert_eq!(pick(None, false), CredentialStorage { accounts_dir: home.join(".runrail/accounts"), vault: Vault::Keychain });
        assert_eq!(pick(Some("keychain"), true).vault, Vault::Keychain);
        assert_eq!(pick(Some("file"), false), CredentialStorage { accounts_dir: app_data.join("accounts"), vault: Vault::File });
        assert_eq!(pick(Some("memory"), false).vault, Vault::Keychain);
        assert_eq!(CredentialStorage::select(app_data, None, None, false, true).accounts_dir, app_data.join("accounts"));
        // A Linux with no Secret Service keeps keys in the file vault, unless the keychain was asked for.
        assert_eq!(CredentialStorage::select(app_data, Some(home), None, false, false), CredentialStorage { accounts_dir: app_data.join("accounts"), vault: Vault::File });
        assert_eq!(CredentialStorage::select(app_data, Some(home), Some("keychain"), false, false).vault, Vault::Keychain);
        assert_eq!((Vault::Keychain.flag(), Vault::File.flag()), ("keychain", "file"));
    }
}
