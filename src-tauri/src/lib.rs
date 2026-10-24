//! Tauri host for the Runrail desktop app.
//!
//! The renderer never sees engine tokens, never spawns processes, and never reads arbitrary
//! paths. It talks to Runrail only through the typed commands below; the host validates every
//! input, runs blocking work off the main thread, and forwards engine events as batches.
//!
//! Credentials have their own narrow path: a typed key goes through `connection_secret_set`
//! (or is read from the clipboard by the host) straight to the engine's write-only endpoint.
//! The generic `control_rpc` channel refuses anything that names or carries a credential, and
//! no command returns one.

mod agents;
mod android;
mod approvals;
mod background;
mod computer;
mod sign_ins;
mod simulator;
#[cfg(debug_assertions)]
mod automation;
mod connections;
mod engine;
mod error;
mod http;
mod instructions;
mod login;
mod mcp;
mod notify;
#[cfg(target_os = "linux")]
mod open_in;
mod other_tools;
mod power;
mod preview;
#[cfg(target_os = "linux")]
mod preview_gtk;
mod pages;
mod phone;
mod quick;
mod preview_agent;
mod process;
mod remote;
#[cfg(target_os = "macos")]
mod responsibility;
mod shells;
mod skills;
mod starters;
mod startup;
mod tailscale;
mod store;
mod update;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod voice;
mod wake;
mod window_state;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use zeroize::Zeroizing;

use connections::CredentialStorage;
use engine::{EngineInfo, EngineStartInput, Supervisor};
use error::{BridgeError, BridgeResult};
use workspace::{canonical_workspace, inspect, resolve_workspace, WorkspaceInfo};

struct HostState {
    supervisor: Arc<Supervisor>,
    startup: startup::Startup,
    keep_awake: power::KeepAwake,
    background: background::Background,
    quit_guard: AtomicBool,
    /// The page saved its state for quitting, or the wait for it ran out.
    saved_for_exit: AtomicBool,
    asked_to_save: AtomicBool,
}

/// How long quitting waits for the page to save what changed in its last moments.
const SAVE_ON_EXIT_WAIT: std::time::Duration = std::time::Duration::from_millis(1_500);

async fn blocking<T, F>(work: F) -> BridgeResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> BridgeResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| BridgeError::new("HOST_TASK_FAILED", "host task failed"))?
}

#[tauri::command]
async fn engine_start(state: State<'_, HostState>, input: EngineStartInput) -> BridgeResult<EngineInfo> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.start(input)).await
}

#[tauri::command]
async fn engine_stop(state: State<'_, HostState>, engine_id: String) -> BridgeResult<()> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.stop(&engine_id)).await
}

#[tauri::command]
async fn engine_list(state: State<'_, HostState>) -> BridgeResult<Vec<EngineInfo>> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.list()).await
}

#[tauri::command]
async fn control_rpc(app: tauri::AppHandle, state: State<'_, HostState>, engine_id: String, method: String, params: Value) -> BridgeResult<Value> {
    let supervisor = state.supervisor.clone();
    blocking(move || {
        if method == "memory.settings.set" {
            confirm_memory_provider(&app, &params)?;
        }
        if let Some(prompt) = pull_request_write(&method, &params) {
            confirm_write(&app, &prompt?)?;
        }
        supervisor.renderer_rpc(&engine_id, &method, params)
    })
    .await
}

/// A memory provider is a program the engine starts, or an address memories are sent to. Like an
/// MCP server, the person confirms it in a dialog the page cannot draw or click.
fn confirm_memory_provider(app: &tauri::AppHandle, params: &Value) -> BridgeResult<()> {
    let Some(line) = memory_provider_line(params)? else { return Ok(()) };
    let allowed = app
        .dialog()
        .message(format!("Use this as your memory provider?\n\n{}\n\nRunrail will run it, or send it what it remembers, in every project.", visible_text(&line)))
        .title("Save memory provider?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Save".into(), "Don't save".into()))
        .blocking_show();
    if allowed { Ok(()) } else { Err(BridgeError::new("MEMORY_PROVIDER_DECLINED", "The person did not save the memory provider.").with_status(403)) }
}

/// A write to GitHub under the person's own sign-in, described for a dialog the page cannot draw or
/// click. The page's dialog chooses what to send; this one is the consent, so a page that sends
/// `confirm: true` on its own still cannot merge or post.
struct WritePrompt {
    title: &'static str,
    message: String,
    accept: &'static str,
}

fn pull_request_write(method: &str, params: &Value) -> Option<BridgeResult<WritePrompt>> {
    (method == "git.pr.merge" || method == "git.pr.review.post").then(|| describe_pull_request_write(method, params))
}

fn describe_pull_request_write(method: &str, params: &Value) -> BridgeResult<WritePrompt> {
    let text = |key: &str| params.get(key).and_then(Value::as_str);
    let invalid = || BridgeError::new("CONTROL_INVALID_INPUT", "the pull request write is incomplete").with_status(400);
    let (Some(owner), Some(repo), Some(number)) = (text("owner"), text("repo"), params.get("number").and_then(Value::as_u64)) else {
        return Err(invalid());
    };
    let host = text("host").filter(|host| *host != "github.com").map(|host| format!(" on {}", visible_text(host))).unwrap_or_default();
    let target = format!("{}/{} #{number}{host}", visible_text(owner), visible_text(repo));
    if method == "git.pr.merge" {
        let way = match text("method") {
            Some("squash") => "Squash and merge",
            Some("merge") => "Create a merge commit",
            Some("rebase") => "Rebase and merge",
            _ => return Err(invalid()),
        };
        let commit: String = text("headCommit").ok_or_else(invalid)?.chars().take(7).collect();
        let mut message = format!("Merge pull request {target}?\n\n{way}, at the commit you reviewed ({}).", visible_text(&commit));
        if let Some(subject) = text("subject") {
            message.push_str(&format!("\nCommit title: {}", visible_text(subject)));
        }
        if params.get("deleteBranch").and_then(Value::as_bool) == Some(true) {
            message.push_str("\nThe branch is deleted after merging.");
        }
        return Ok(WritePrompt { title: "Merge pull request?", message, accept: "Merge" });
    }
    let comments = params.get("comments").and_then(Value::as_array).map_or(0, Vec::len);
    let mut message = format!("Post this review to {target} under your GitHub name?");
    if comments > 0 {
        message.push_str(&format!("\n\n{comments} comment{} on lines.", if comments == 1 { "" } else { "s" }));
    }
    let body = text("body").unwrap_or("").trim();
    if !body.is_empty() {
        let shown: String = body.chars().take(800).collect();
        let more = if body.chars().count() > 800 { "\n..." } else { "" };
        message.push_str(&format!("\n\n{}{more}", visible_text(&shown)));
    }
    Ok(WritePrompt { title: "Post review?", message, accept: "Post" })
}

fn confirm_write(app: &tauri::AppHandle, prompt: &WritePrompt) -> BridgeResult<()> {
    #[cfg(debug_assertions)]
    let queued = automation::dialog_answer(prompt.title, &prompt.message);
    #[cfg(not(debug_assertions))]
    let queued = None;
    let allowed = queued.unwrap_or_else(|| {
        app.dialog()
            .message(prompt.message.clone())
            .title(prompt.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(prompt.accept.into(), "Cancel".into()))
            .blocking_show()
    });
    if allowed { Ok(()) } else { Err(BridgeError::new("PR_WRITE_DECLINED", "The person did not confirm the GitHub write.").with_status(403)) }
}

/// The program and arguments, with the variables it is handed, or the address, a memory provider
/// setting names; none for built-in memory. One that names both is refused, so the dialog never
/// shows one while the engine uses the other.
fn memory_provider_line(params: &Value) -> BridgeResult<Option<String>> {
    let Some(provider) = params.get("provider").filter(|value| value.is_object()) else { return Ok(None) };
    let command = provider.get("command").and_then(Value::as_str);
    let url = provider.get("url").and_then(Value::as_str);
    if command.is_some() && url.is_some() {
        return Err(BridgeError::new("MEMORY_PROVIDER_INVALID", "A memory provider names a program or an address, not both.").with_status(400));
    }
    if let Some(command) = command {
        let args = provider.get("args").and_then(Value::as_array).into_iter().flatten().map(|arg| arg.as_str().map_or_else(|| arg.to_string(), str::to_string));
        let mut line = std::iter::once(command.to_string()).chain(args).collect::<Vec<_>>().join(" ");
        let inherit: Vec<String> = provider.get("inherit").and_then(Value::as_array).into_iter().flatten().map(|name| name.as_str().map_or_else(|| name.to_string(), str::to_string)).collect();
        if !inherit.is_empty() {
            line.push_str(&format!("\n\nIt is given these of your environment variables: {}", inherit.join(", ")));
        }
        return Ok(Some(line));
    }
    Ok(url.map(str::to_string))
}

/// Starts (or returns) the engine that owns connections and sign-ins. It has no project: the
/// host fixes its folder, so connections work before any project is open.
#[tauri::command]
async fn system_engine(state: State<'_, HostState>) -> BridgeResult<EngineInfo> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.system()).await
}

/// Write-only: stores a key for a connection. Nothing reads it back; the answer is the
/// connection record without the key.
/// `tool` names a coding-tool connection's key rather than an account's, `connector` a built-in
/// connector's.
#[tauri::command]
async fn connection_secret_set(state: State<'_, HostState>, connection_id: String, secret: String, tool: Option<bool>, connector: Option<bool>) -> BridgeResult<Value> {
    let secret = Zeroizing::new(secret);
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.store_secret_for(secret_owner(tool, connector), &connection_id, secret)).await
}

/// Same as `connection_secret_set`, but the host reads the clipboard itself so the key never
/// enters the web view.
#[tauri::command]
async fn connection_secret_from_clipboard(state: State<'_, HostState>, connection_id: String, tool: Option<bool>, connector: Option<bool>) -> BridgeResult<Value> {
    let supervisor = state.supervisor.clone();
    blocking(move || {
        if !connections::valid_connection_id(&connection_id) {
            return Err(BridgeError::new("CONTROL_INVALID_INPUT", "connection id is invalid"));
        }
        let secret = connections::read_clipboard_secret()?;
        supervisor.store_secret_for(secret_owner(tool, connector), &connection_id, secret)
    })
    .await
}

fn secret_owner(tool: Option<bool>, connector: Option<bool>) -> connections::SecretOwner {
    if connector == Some(true) {
        connections::SecretOwner::Connector
    } else if tool == Some(true) {
        connections::SecretOwner::ToolConnection
    } else {
        connections::SecretOwner::Account
    }
}

/// Opens the sign-in page for a running sign-in. The renderer names the sign-in, never a URL:
/// the address comes from the engine and must be https on a host that flow declares.
#[tauri::command]
async fn auth_open(state: State<'_, HostState>, login_id: String) -> BridgeResult<()> {
    let supervisor = state.supervisor.clone();
    blocking(move || {
        let url = supervisor.sign_in_url(&login_id)?;
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
            .map_err(|_| BridgeError::new("OPEN_FAILED", "could not open the sign-in page"))
    })
    .await
}

/// Hands over what the user pasted to finish a sign-in (the address they landed on, or a code).
/// It can carry a one-time code, so it skips the generic channel like a key does.
#[tauri::command]
async fn auth_submit_input(state: State<'_, HostState>, login_id: String, input: String) -> BridgeResult<Value> {
    let input = Zeroizing::new(input);
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.submit_sign_in_input(&login_id, input)).await
}

#[tauri::command]
async fn control_health(state: State<'_, HostState>, engine_id: String) -> BridgeResult<Value> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.health(&engine_id)).await
}

#[tauri::command]
async fn control_stream_start(
    state: State<'_, HostState>,
    engine_id: String,
    after_seq: i64,
    after_live_seq: Option<u64>,
    on_batch: Channel,
) -> BridgeResult<()> {
    let supervisor = state.supervisor.clone();
    // A channel, not an event: past 8 KB the page fetches the batch and parses it as JSON instead
    // of parsing it as script, several times cheaper for large ones (docs/PERFORMANCE.md).
    let sink: engine::BatchSink = Arc::new(move |payload| {
        let _ = on_batch.send(InvokeResponseBody::Json(payload));
    });
    blocking(move || supervisor.stream_start(&engine_id, after_seq, after_live_seq, sink)).await
}

#[tauri::command]
async fn control_stream_stop(state: State<'_, HostState>, engine_id: String) -> BridgeResult<()> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.stream_stop(&engine_id)).await
}

#[tauri::command]
async fn thread_forget(state: State<'_, HostState>, session_id: String) -> BridgeResult<()> {
    let supervisor = state.supervisor.clone();
    blocking(move || supervisor.forget_thread(&session_id)).await
}

/// Opens the native file picker for a plugin archive (`.tar`, `.tgz`, `.tar.gz`). The engine reads
/// and checks the archive; the host only hands back the chosen file's path.
#[tauri::command]
async fn archive_pick(app: tauri::AppHandle) -> BridgeResult<Option<String>> {
    blocking(move || {
        let Some(picked) = app.dialog().file().set_title("Choose a plugin archive").add_filter("Plugin archive", &["tar", "tgz", "gz"]).blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|_| BridgeError::new("ARCHIVE_INVALID", "selected file is not a local path"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn workspace_inspect(path: String) -> BridgeResult<WorkspaceInfo> {
    blocking(move || resolve_workspace(&path).map(|path| inspect(&path))).await
}

/// Opens the native folder picker. The dialog runs in the host so the renderer needs no file
/// system or dialog permission, and the folder chosen there is approved as a project. `near` only
/// says where the dialog opens, such as where an imported session was recorded; it approves nothing.
#[tauri::command]
async fn workspace_pick(app: tauri::AppHandle, near: Option<String>, related: Option<bool>) -> BridgeResult<Option<WorkspaceInfo>> {
    blocking(move || {
        #[cfg(debug_assertions)]
        let queued = automation::picked_folder();
        #[cfg(not(debug_assertions))]
        let queued = None;
        let path = match queued {
            Some(path) => path,
            None => {
                let start = near.as_deref().and_then(|folder| canonical_workspace(folder).ok());
                let title = if related == Some(true) {
                    "Add a related folder"
                } else if start.is_some() {
                    "Add the session's folder as a project"
                } else {
                    "Open project folder"
                };
                let mut dialog = app.dialog().file().set_title(title);
                if let Some(folder) = start {
                    dialog = dialog.set_directory(folder);
                }
                let Some(picked) = dialog.blocking_pick_folder() else {
                    return Ok(None);
                };
                picked
                    .into_path()
                    .map_err(|_| BridgeError::new("WORKSPACE_INVALID", "selected folder is not a local path"))?
            }
        };
        let resolved = canonical_workspace(&path.to_string_lossy())?;
        approvals::approve(&resolved)?;
        Ok(Some(inspect(&resolved)))
    })
    .await
}

/// The starters `runrail new` offers, read from the engine so their labels and makers have one source.
#[tauri::command]
async fn app_starters(state: State<'_, HostState>) -> BridgeResult<Value> {
    let supervisor = state.supervisor.clone();
    blocking(move || {
        let mut command = supervisor.job_command(&std::env::temp_dir())?;
        command.args(["new", "--list", "--json"]);
        let ran = process::run(command, None, std::time::Duration::from_secs(30)).map_err(|message| BridgeError::new("STARTER_FAILED", message))?;
        starters::result_of(&ran.stdout)
    })
    .await
}

/// A new app from a starter: the person picks where in the system's dialog, the engine's
/// `runrail new` makes it there, and only the folder it made is approved as a project.
#[tauri::command]
async fn app_create(app: tauri::AppHandle, state: State<'_, HostState>, name: String, starter: String) -> BridgeResult<Option<Value>> {
    starters::check_request(&name, &starter)?;
    let supervisor = state.supervisor.clone();
    blocking(move || {
        #[cfg(debug_assertions)]
        let queued = automation::picked_folder();
        #[cfg(not(debug_assertions))]
        let queued = None;
        let parent = match queued {
            Some(path) => path,
            None => {
                let Some(picked) = app.dialog().file().set_title(format!("Choose where to create {name}")).blocking_pick_folder() else {
                    return Ok(None);
                };
                picked.into_path().map_err(|_| BridgeError::new("WORKSPACE_INVALID", "selected folder is not a local path"))?
            }
        };
        let parent = canonical_workspace(&parent.to_string_lossy())?;
        let target = parent.join(&name);
        let mut command = supervisor.job_command(&parent)?;
        command.arg("new").arg(&target).args(["--starter", &starter, "--json"]);
        let ran = process::run(command, None, starters::CREATE_TIMEOUT).map_err(|message| BridgeError::new("STARTER_FAILED", message))?;
        let result = starters::result_of(&ran.stdout)?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Ok(Some(starters::failure_of(&result)));
        }
        let made = canonical_workspace(&target.to_string_lossy())?;
        approvals::approve(&made)?;
        let warnings = result.get("warnings").cloned().unwrap_or(Value::Array(Vec::new()));
        Ok(Some(serde_json::json!({ "ok": true, "workspace": inspect(&made), "warnings": warnings })))
    })
    .await
}

/// Computer use: whether Runrail may see the screen and send input.
#[tauri::command]
async fn computer_access() -> BridgeResult<computer::Access> {
    blocking(|| Ok(computer::access())).await
}

/// Shows the system's own request for Screen Recording or Accessibility; the person answers it.
#[tauri::command]
async fn computer_request_access(kind: String) -> BridgeResult<computer::Access> {
    if kind != "screen" && kind != "accessibility" {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "access kind is invalid"));
    }
    blocking(move || Ok(computer::request_access(&kind))).await
}

/// Opens the Privacy & Security pane where the person turns the access on.
#[tauri::command]
async fn computer_open_settings(kind: String) -> BridgeResult<()> {
    let pane = match kind.as_str() {
        "screen" => "Privacy_ScreenCapture",
        "accessibility" => "Privacy_Accessibility",
        _ => return Err(BridgeError::new("CONTROL_INVALID_INPUT", "access kind is invalid")),
    };
    blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
            .status()
            .map_err(|_| BridgeError::new("OPEN_FAILED", "System Settings could not be opened"))
            .map(|_| ())
    })
    .await
}

#[tauri::command]
async fn computer_running_apps(app: tauri::AppHandle) -> BridgeResult<Vec<computer::RunningApp>> {
    let own = app.config().identifier.clone();
    blocking(move || Ok(computer::running_apps(&own))).await
}

#[tauri::command]
async fn computer_allowed() -> BridgeResult<Vec<computer::AllowedApp>> {
    Ok(computer::allowed())
}

/// Adds an app to the list agents may use, after the person agrees in a dialog the page cannot draw.
#[tauri::command]
async fn computer_allow(app: tauri::AppHandle, bundle_id: String) -> BridgeResult<Vec<computer::AllowedApp>> {
    blocking(move || computer::allow(&app, &bundle_id)).await
}

#[tauri::command]
async fn computer_disallow(bundle_id: String) -> BridgeResult<Vec<computer::AllowedApp>> {
    blocking(move || computer::disallow(&bundle_id)).await
}

/// One agent request, taken from its engine by the page; the answer goes back with `computer.respond`.
#[tauri::command]
async fn computer_act(app: tauri::AppHandle, action: String, params: Value) -> BridgeResult<Value> {
    let own = app.config().identifier.clone();
    blocking(move || Ok(computer::act(&own, &action, &params))).await
}

/// iOS Simulator: Xcode's tools, idb, and whether agents may use simulators.
#[tauri::command]
async fn simulator_status() -> BridgeResult<simulator::Status> {
    blocking(|| Ok(simulator::status())).await
}

#[tauri::command]
async fn simulator_devices() -> BridgeResult<Vec<simulator::Device>> {
    blocking(simulator::devices).await
}

#[tauri::command]
async fn simulator_boot(udid: String) -> BridgeResult<()> {
    blocking(move || simulator::boot(&udid)).await
}

#[tauri::command]
async fn simulator_shutdown(udid: String) -> BridgeResult<()> {
    blocking(move || simulator::shutdown(&udid)).await
}

/// Shows the device in Xcode's Simulator app.
#[tauri::command]
async fn simulator_open(udid: String) -> BridgeResult<()> {
    blocking(move || simulator::open_in_simulator(&udid)).await
}

#[tauri::command]
async fn simulator_screenshot(udid: String) -> BridgeResult<simulator::Screen> {
    blocking(move || simulator::screenshot(&udid, 1_100)).await
}

#[tauri::command]
async fn simulator_apps(udid: String) -> BridgeResult<Vec<simulator::SimApp>> {
    blocking(move || simulator::apps(&udid)).await
}

/// Installs a built app the person picks in the system's file dialog; none when they cancel.
#[tauri::command]
async fn simulator_install(app: tauri::AppHandle, udid: String) -> BridgeResult<Option<simulator::SimApp>> {
    blocking(move || simulator::install(&app, &udid)).await
}

#[tauri::command]
async fn simulator_launch(udid: String, bundle_id: String) -> BridgeResult<()> {
    blocking(move || simulator::launch(&udid, &bundle_id)).await
}

#[tauri::command]
async fn simulator_open_url(udid: String, url: String) -> BridgeResult<()> {
    blocking(move || simulator::open_url(&udid, &url)).await
}

/// A tap, swipe, text, key, or button from the panel; it needs idb.
#[tauri::command]
async fn simulator_input(udid: String, input: Value) -> BridgeResult<()> {
    let input = simulator::parse_input(&input).ok_or_else(|| BridgeError::new("CONTROL_INVALID_INPUT", "the input is invalid"))?;
    blocking(move || simulator::input(&udid, &input)).await
}

/// Lets agents use booted simulators, once the person agrees in a dialog the page cannot draw.
#[tauri::command]
async fn simulator_agents(app: tauri::AppHandle, on: bool) -> BridgeResult<simulator::Status> {
    blocking(move || simulator::set_agents(&app, on)).await
}

/// Android emulators: the SDK's tools, and the emulators they find.
#[tauri::command]
async fn android_status() -> BridgeResult<android::Status> {
    blocking(|| Ok(android::status())).await
}

#[tauri::command]
async fn android_devices() -> BridgeResult<Vec<android::Device>> {
    blocking(android::devices).await
}

/// Starts the emulator and answers once Android has booted, with its serial.
#[tauri::command]
async fn android_boot(avd: String) -> BridgeResult<String> {
    blocking(move || android::boot(&avd)).await
}

#[tauri::command]
async fn android_shutdown(serial: String) -> BridgeResult<()> {
    blocking(move || android::shutdown(&serial)).await
}

#[tauri::command]
async fn android_screenshot(serial: String) -> BridgeResult<simulator::Screen> {
    blocking(move || android::screenshot(&serial, 1_100)).await
}

#[tauri::command]
async fn android_apps(serial: String) -> BridgeResult<Vec<android::AndroidApp>> {
    blocking(move || android::apps(&serial)).await
}

/// Installs an APK the person picks in the system's file dialog.
#[tauri::command]
async fn android_install(app: tauri::AppHandle, serial: String) -> BridgeResult<Option<android::AndroidApp>> {
    blocking(move || android::install(&app, &serial)).await
}

#[tauri::command]
async fn android_launch(serial: String, package: String) -> BridgeResult<()> {
    blocking(move || android::launch(&serial, &package)).await
}

#[tauri::command]
async fn android_open_url(serial: String, url: String) -> BridgeResult<()> {
    blocking(move || android::open_url(&serial, &url)).await
}

#[tauri::command]
async fn android_input(serial: String, input: Value) -> BridgeResult<()> {
    let input = android::parse_input(&input).ok_or_else(|| BridgeError::new("CONTROL_INVALID_INPUT", "the input is invalid"))?;
    blocking(move || android::input(&serial, &input)).await
}

/// Lets agents use running emulators, once the person agrees in a dialog the page cannot draw.
#[tauri::command]
async fn android_agents(app: tauri::AppHandle, on: bool) -> BridgeResult<android::Status> {
    blocking(move || android::set_agents(&app, on)).await
}

/// Reveals a workspace (or a relative path inside it) in the system file manager.
#[tauri::command]
async fn workspace_reveal(workspace: String, relative: Option<String>) -> BridgeResult<()> {
    blocking(move || {
        let target = contained_path(&workspace, relative.as_deref())?;
        let revealed = tauri_plugin_opener::reveal_item_in_dir(&target).is_ok();
        // A file manager without org.freedesktop.FileManager1 (and no portal) still opens the folder.
        #[cfg(target_os = "linux")]
        let revealed = revealed || open_in::open("files", target.parent().unwrap_or(&target)).is_ok();
        if revealed { Ok(()) } else { Err(BridgeError::new("OPEN_FAILED", "could not reveal the item")) }
    })
    .await
}

/// The "Open in" choices this computer has: macOS's fixed list, or what is installed on Linux.
#[tauri::command]
async fn open_in_apps() -> Vec<&'static str> {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(open_in::available).await.unwrap_or_default();
    #[cfg(not(target_os = "linux"))]
    vec!["vscode", "cursor", "zed", "xcode", "finder", "terminal", "iterm", "ghostty"]
}

/// Opens a workspace path in one of a fixed set of editors. No arbitrary program or arguments.
#[tauri::command]
async fn workspace_open_in(workspace: String, relative: Option<String>, editor: String) -> BridgeResult<()> {
    blocking(move || {
        let target = contained_path(&workspace, relative.as_deref())?;
        let target = if opens_as_folder(&editor) { plain_folder(&resolve_workspace(&workspace)?, target)? } else { target };
        open_in_editor(&editor, &target)
    })
    .await
}

/// A terminal runs a file or bundle it is handed, and Finder launches it: they are only given a folder.
fn opens_as_folder(editor: &str) -> bool {
    matches!(editor, "terminal" | "iterm" | "ghostty" | "finder" | "files" | "gnome-terminal" | "gnome-console" | "ptyxis" | "konsole" | "xfce4-terminal" | "kitty" | "wezterm" | "alacritty")
}

/// The nearest plain folder at or above `target`, up to `root`. A name with an extension is how
/// macOS marks an app or other bundle, so such a folder counts as a file.
fn plain_folder(root: &std::path::Path, mut target: PathBuf) -> BridgeResult<PathBuf> {
    while target != root && (!target.is_dir() || target.extension().is_some()) {
        let Some(parent) = target.parent() else { break };
        target = parent.to_path_buf();
    }
    if !target.is_dir() || target.extension().is_some() {
        return Err(BridgeError::new("EDITOR_UNSUPPORTED", "this item opens only in an editor"));
    }
    Ok(target)
}

fn contained_path(workspace: &str, relative: Option<&str>) -> BridgeResult<PathBuf> {
    let root = resolve_workspace(workspace)?;
    let Some(relative) = relative.filter(|value| !value.is_empty()) else {
        return Ok(root);
    };
    let invalid = || BridgeError::new("WORKSPACE_PATH_INVALID", "path is outside the workspace");
    if relative.len() > 4096 || relative.contains('\0') || PathBuf::from(relative).is_absolute() {
        return Err(invalid());
    }
    let target = root.join(relative).canonicalize().map_err(|_| invalid())?;
    if !target.starts_with(&root) {
        return Err(invalid());
    }
    Ok(target)
}

#[cfg(target_os = "macos")]
fn open_in_editor(editor: &str, target: &std::path::Path) -> BridgeResult<()> {
    let application = match editor {
        "vscode" => "Visual Studio Code",
        "cursor" => "Cursor",
        "zed" => "Zed",
        "xcode" => "Xcode",
        "terminal" => "Terminal",
        "iterm" => "iTerm",
        "ghostty" => "Ghostty",
        "finder" => "Finder",
        _ => return Err(BridgeError::new("EDITOR_UNSUPPORTED", "editor is not supported")),
    };
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(application)
        .arg(target)
        .status()
        .map_err(|_| BridgeError::new("OPEN_FAILED", "could not open the editor"))?;
    if status.success() {
        Ok(())
    } else {
        Err(BridgeError::new("EDITOR_UNAVAILABLE", "editor is not installed"))
    }
}

#[cfg(target_os = "linux")]
fn open_in_editor(editor: &str, target: &std::path::Path) -> BridgeResult<()> {
    open_in::open(editor, target)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_in_editor(editor: &str, target: &std::path::Path) -> BridgeResult<()> {
    let program = match editor {
        "vscode" => "code",
        "cursor" => "cursor",
        "zed" => "zed",
        _ => return Err(BridgeError::new("EDITOR_UNSUPPORTED", "editor is not supported")),
    };
    std::process::Command::new(program)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|_| BridgeError::new("EDITOR_UNAVAILABLE", "editor is not installed"))
}

const MAX_ATTACHMENT_BYTES: usize = 256 * 1024;

/// Saves a pasted or dropped image inside the workspace so the engine can attach it. Core only
/// reads attachments from inside the workspace policy root. Bytes must match the declared type.
#[tauri::command]
async fn attachment_save(workspace: String, media_type: String, data: Vec<u8>) -> BridgeResult<String> {
    blocking(move || save_attachment(&workspace, &media_type, &data)).await
}

fn save_attachment(workspace: &str, media_type: &str, data: &[u8]) -> BridgeResult<String> {
    let invalid = |message: &str| BridgeError::new("ATTACHMENT_INVALID", message);
    if data.is_empty() || data.len() > MAX_ATTACHMENT_BYTES {
        return Err(invalid("attachment size is invalid"));
    }
    let extension = match (media_type, detect_image(data)) {
        ("image/png", Some("image/png")) => "png",
        ("image/jpeg", Some("image/jpeg")) => "jpg",
        ("image/gif", Some("image/gif")) => "gif",
        ("image/webp", Some("image/webp")) => "webp",
        _ => return Err(invalid("attachment is not a supported image")),
    };
    let root = resolve_workspace(workspace)?;
    let unavailable = || BridgeError::new("ATTACHMENT_UNAVAILABLE", "attachment could not be saved");
    let dir = workspace::create_dir_inside(&root, Path::new(".runrail/attachments")).ok_or_else(unavailable)?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        store::write_atomic(&ignore, b"*\n")?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let name = format!("{stamp:x}-{:x}.{extension}", std::process::id());
    store::write_atomic(&dir.join(&name), data).map_err(|_| unavailable())?;
    Ok(format!(".runrail/attachments/{name}"))
}

fn detect_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[tauri::command]
async fn instructions_read(workspace: String) -> BridgeResult<instructions::ProjectInstructions> {
    blocking(move || instructions::read(&workspace)).await
}

#[tauri::command]
async fn instructions_write(workspace: String, text: String) -> BridgeResult<instructions::ProjectInstructions> {
    blocking(move || instructions::write(&workspace, &text)).await
}

#[tauri::command]
async fn mcp_list(state: State<'_, HostState>) -> BridgeResult<Vec<mcp::McpServer>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || Ok(mcp::McpStore::new(&app_data).list())).await
}

/// Saves a server. A command the person has not confirmed before is shown to them in a native
/// dialog first; the renderer cannot answer it.
#[tauri::command]
async fn mcp_save(app: tauri::AppHandle, state: State<'_, HostState>, server: mcp::McpServer, previous: Option<String>) -> BridgeResult<Vec<mcp::McpServer>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || {
        mcp::McpStore::new(&app_data).save(server, previous.as_deref(), |server| {
            let threads = match &server.project {
                Some(project) => format!("each thread in {project} that runs on Runrail's own loop"),
                None => "each thread that runs on Runrail's own loop, in every project".to_string(),
            };
            let message = match &server.url {
                Some(_) => {
                    let token = server.bearer_env.as_deref().map(|name| format!("\n\nIt sends the value of {name} from your shell to this address as an access token.")).unwrap_or_default();
                    format!("Runrail will connect {threads} to this server and send it what the agent asks of its tools:\n\n{}{token}\n\nOnly add servers you trust.", server.command_line())
                }
                None => {
                    let variables = if server.env.is_empty() { String::new() } else { format!("\n\nIt also gets these variables from your shell: {}.", server.env.join(", ")) };
                    format!("Runrail will start this program for {threads}, with your user's permissions:\n\n{}{variables}\n\nOnly add servers you trust.", server.command_line())
                }
            };
            app.dialog()
                .message(message)
                .title(format!("Add MCP server \"{}\"?", server.name))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Add server".into(), "Cancel".into()))
                .blocking_show()
        })
    })
    .await
}

#[tauri::command]
async fn mcp_set_enabled(state: State<'_, HostState>, name: String, enabled: bool) -> BridgeResult<Vec<mcp::McpServer>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || mcp::McpStore::new(&app_data).set_enabled(&name, enabled)).await
}

#[tauri::command]
async fn mcp_remove(state: State<'_, HostState>, name: String) -> BridgeResult<Vec<mcp::McpServer>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || mcp::McpStore::new(&app_data).remove(&name)).await
}

/// Holds off idle sleep while the renderer says a turn is running. Returns whether it is held.
/// Starting or stopping `caffeinate` runs off the main thread, like every command below that
/// waits on a process, a lock, or the disk.
#[tauri::command]
async fn keep_awake(app: tauri::AppHandle, on: bool, display: Option<bool>) -> BridgeResult<bool> {
    blocking(move || Ok(app.state::<HostState>().keep_awake.set(on, display.unwrap_or(false)))).await
}

/// Set while a turn or a workflow, setup or eval run goes and the person asked to be asked before quitting then.
#[tauri::command]
fn quit_guard(state: State<'_, HostState>, on: bool) {
    state.quit_guard.store(on, Ordering::SeqCst);
}

/// Quits as the app menu's Quit does, for Ctrl+Q on Linux, which has no app menu.
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    background::menu_action(&app, "quit");
}

/// Whether Runrail starts in the menu bar at login, as System Settings holds it.
#[tauri::command]
fn login_item_status(app: tauri::AppHandle) -> login::LoginItem {
    login::status(&app.config().identifier)
}

#[tauri::command]
fn login_item_set(app: tauri::AppHandle, on: bool) -> BridgeResult<login::LoginItem> {
    login::set(&app.config().identifier, on).map_err(|message| BridgeError::new("LOGIN_ITEM_FAILED", message))
}

/// The machines a project can live on over SSH.
#[tauri::command]
async fn remote_list(state: State<'_, HostState>) -> BridgeResult<Vec<remote::Remote>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || Ok(remote::RemoteStore::new(&app_data).list())).await
}

/// Saves a machine. Anything new is shown to the person in a native dialog first; the renderer
/// cannot answer it.
#[tauri::command]
async fn remote_save(app: tauri::AppHandle, state: State<'_, HostState>, id: Option<String>, host: String, engine: Option<String>) -> BridgeResult<Vec<remote::Remote>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || {
        remote::RemoteStore::new(&app_data).save(id.as_deref(), &host, engine.as_deref(), |remote| {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            let message = format!(
                "Runrail will connect with ssh {host}, using your SSH settings and keys, and run this there for each thread in its projects:\n\n{engine} control\n\nThe agent then works on that machine with your user's permissions there. Only add machines you trust.",
                host = remote.host,
                engine = remote.engine()
            );
            app.dialog()
                .message(message)
                .title(format!("Add the remote machine \"{}\"?", remote.host))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Add machine".into(), "Cancel".into()))
                .blocking_show()
        })
    })
    .await
}

#[tauri::command]
async fn remote_remove(state: State<'_, HostState>, id: String) -> BridgeResult<Vec<remote::Remote>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || remote::RemoteStore::new(&app_data).remove(&id)).await
}

/// Reaches the machine, asks its engine for its version, and looks at a folder there.
#[tauri::command]
async fn remote_check(state: State<'_, HostState>, id: String, folder: Option<String>) -> BridgeResult<remote::RemoteCheck> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || {
        let remote = remote::RemoteStore::new(&app_data).get(&id)?;
        remote::check(&remote, folder.as_deref())
    })
    .await
}

/// The host aliases in ~/.ssh/config, offered when adding a machine.
#[tauri::command]
async fn ssh_hosts() -> BridgeResult<Vec<String>> {
    let Ok(home) = home_dir() else { return Ok(Vec::new()) };
    blocking(move || Ok(remote::ssh_config_hosts(&home))).await
}

/// Phone access: whether the server for paired phones runs, and which are paired.
#[tauri::command]
fn phone_status(phone: State<'_, Arc<phone::Phone>>) -> phone::PhoneStatus {
    phone.status()
}

#[tauri::command]
async fn phone_set(phone: State<'_, Arc<phone::Phone>>, on: bool) -> BridgeResult<phone::PhoneStatus> {
    let phone = Arc::clone(&phone);
    blocking(move || phone.set(on)).await
}

/// A one-time code for pairing a phone.
#[tauri::command]
fn phone_pair(phone: State<'_, Arc<phone::Phone>>) -> BridgeResult<phone::PhoneStatus> {
    phone.pair()
}

#[tauri::command]
fn phone_forget(phone: State<'_, Arc<phone::Phone>>, id: String) -> BridgeResult<phone::PhoneStatus> {
    phone.forget(&id)
}

/// The page's answer to a paired phone's call.
#[tauri::command]
fn phone_answer(phone: State<'_, Arc<phone::Phone>>, id: u64, ok: bool, body: serde_json::Value) {
    phone.answer(id, ok, body);
}

/// A thread's read-only link on the tailnet, made the first time it is asked for.
#[tauri::command]
fn phone_share_thread(phone: State<'_, Arc<phone::Phone>>, thread_id: String, title: String) -> BridgeResult<phone::Share> {
    phone.share_thread(&thread_id, &title)
}

/// Publishes a copy of a folder the person picks here as a read-only page on the tailnet, after
/// saying what it holds. None when they cancel.
#[tauri::command]
async fn phone_publish(app: tauri::AppHandle, phone: State<'_, Arc<phone::Phone>>) -> BridgeResult<Option<phone::Share>> {
    let phone = Arc::clone(&phone);
    blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        if !phone.status().running {
            return Err(BridgeError::new("PHONE_OFF", "Turn on phone access first."));
        }
        let Some(picked) = app.dialog().file().set_title("Choose a folder to publish").blocking_pick_folder() else { return Ok(None) };
        let root = picked.into_path().map_err(|_| BridgeError::new("PAGE_UNREADABLE", "That folder cannot be published."))?;
        let plan = pages::plan(&root)?;
        let name = root.file_name().and_then(|name| name.to_str()).unwrap_or("page").to_string();
        let message = format!(
            "Runrail will copy {files} files ({size:.1} MB) from \"{name}\" and serve the copy read-only on your tailnet. Anyone on your tailnet with the link can open it until you unpublish it in Settings. Hidden files and folders and node_modules are left out, and later changes to the folder are not published.",
            files = plan.files.len(),
            size = plan.bytes as f64 / (1024.0 * 1024.0)
        );
        let publish = app
            .dialog()
            .message(message)
            .title(format!("Publish \"{name}\"?"))
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Publish".into(), "Cancel".into()))
            .blocking_show();
        if !publish {
            return Ok(None);
        }
        phone.publish(&root, &plan, &name).map(Some)
    })
    .await
}

/// Revokes a thread link or unpublishes a page.
#[tauri::command]
fn phone_unshare(phone: State<'_, Arc<phone::Phone>>, id: String) -> BridgeResult<phone::PhoneStatus> {
    phone.unshare(&id)
}

/// A new webhook link for a workflow, replacing its old one; the secret is returned once.
#[tauri::command]
fn phone_hook_create(phone: State<'_, Arc<phone::Phone>>, project_id: String, workflow_id: String) -> BridgeResult<phone::NewHook> {
    phone.hook_create(&project_id, &workflow_id)
}

#[tauri::command]
fn phone_hook_remove(phone: State<'_, Arc<phone::Phone>>, id: String) -> BridgeResult<phone::PhoneStatus> {
    phone.hook_remove(&id)
}

#[tauri::command]
fn quick_status(quick: State<'_, Arc<quick::Quick>>) -> quick::QuickStatus {
    quick.status()
}

/// Turns quick chat's shortcut on or off, or changes it.
#[tauri::command]
fn quick_set(app: tauri::AppHandle, quick: State<'_, Arc<quick::Quick>>, enabled: bool, shortcut: String) -> BridgeResult<quick::QuickStatus> {
    quick.set(&app, enabled, &shortcut)
}

/// What the quick window shows about the window that was in front, without its picture.
#[tauri::command]
fn quick_context(quick: State<'_, Arc<quick::Quick>>) -> quick::QuickContext {
    quick.context()
}

#[tauri::command]
async fn quick_submit(app: tauri::AppHandle, quick: State<'_, Arc<quick::Quick>>, text: String, include_window: bool) -> BridgeResult<()> {
    let quick = Arc::clone(&quick);
    blocking(move || quick.submit(&app, &text, include_window)).await
}

#[tauri::command]
fn quick_hide(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(quick::LABEL) {
        let _ = window.hide();
    }
}

/// A paired phone's notifications: its Web Push subscription and page origin, or none.
#[tauri::command]
fn phone_set_push(phone: State<'_, Arc<phone::Phone>>, device: String, push: Option<serde_json::Value>) -> BridgeResult<()> {
    phone.set_push(&device, push)
}

/// The phones that asked for notifications, for the page to send to through the system engine.
#[tauri::command]
fn phone_push_targets(phone: State<'_, Arc<phone::Phone>>) -> Vec<phone::PushTarget> {
    phone.push_targets()
}

/// The person's own Tailscale, as phone access needs it.
#[tauri::command]
async fn tailscale_status(phone: State<'_, Arc<phone::Phone>>) -> BridgeResult<tailscale::Tailscale> {
    let port = phone.status().port;
    let phone = Arc::clone(&phone);
    blocking(move || {
        let status = tailscale::status(port);
        phone.note_tailnet(status.name.as_deref());
        Ok(status)
    })
    .await
}

/// Shares phone access on the tailnet with `tailscale serve`, after the person says yes here, or
/// stops sharing it.
#[tauri::command]
async fn tailscale_serve(app: tauri::AppHandle, phone: State<'_, Arc<phone::Phone>>, on: bool) -> BridgeResult<tailscale::Tailscale> {
    let status = phone.status();
    if on && !status.running {
        return Err(BridgeError::new("PHONE_OFF", "Turn on phone access first."));
    }
    let port = status.port;
    let phone = Arc::clone(&phone);
    blocking(move || {
        if on {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            let command = format!("tailscale {}", tailscale::serve_args(port, true).join(" "));
            let message = format!(
                "Runrail will run:\n\n{command}\n\nDevices on your tailnet can then open Runrail's phone page on this {computer}, port {https}. Only phones you pair here can see or do anything. Tailscale keeps this until you stop sharing here.",
                computer = if cfg!(target_os = "macos") { "Mac" } else { "computer" },
                https = tailscale::HTTPS_PORT
            );
            let shared = app
                .dialog()
                .message(message)
                .title("Share Runrail on your tailnet?")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Share".into(), "Cancel".into()))
                .blocking_show();
            if !shared {
                return Err(BridgeError::new("TAILSCALE_DECLINED", "Not shared."));
            }
        }
        let served = tailscale::serve(port, on)?;
        phone.note_tailnet(served.name.as_deref());
        Ok(served)
    })
    .await
}

/// Whether the helper that opens Runrail when work is due after Quit is on.
#[tauri::command]
async fn wake_service_status(app: tauri::AppHandle) -> BridgeResult<wake::WakeService> {
    let identifier = app.config().identifier.clone();
    let Ok(home) = home_dir() else { return Ok(wake::WakeService::Unavailable) };
    blocking(move || Ok(wake::status(&identifier, &home))).await
}

#[tauri::command]
async fn wake_service_set(app: tauri::AppHandle, on: bool) -> BridgeResult<wake::WakeService> {
    let identifier = app.config().identifier.clone();
    let home = home_dir().map_err(|_| BridgeError::new("WAKE_SERVICE_FAILED", "the home folder is unknown"))?;
    blocking(move || wake::set(&identifier, &home, on).map_err(|message| BridgeError::new("WAKE_SERVICE_FAILED", message))).await
}

/// Whether the wake service opened this launch, to run what is due and quit when done.
#[tauri::command]
fn launch_woken() -> bool {
    wake::woken()
}

/// Why the app stays in the menu bar when its window closes, and what its menu says.
#[tauri::command]
fn background_hold(app: tauri::AppHandle, state: State<'_, HostState>, reasons: Vec<String>, lines: Option<Vec<String>>) {
    background::hold(&app, &state.background, reasons, lines);
}

/// Asks whether to quit while turns or runs go, off the event loop. Quitting clears the guard first, so
/// the exit that follows is not stopped again.
fn confirm_quit(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let quit = app
            .dialog()
            .message("Quitting stops running threads and workflow, setup and eval runs. You can continue a stopped thread later; workflows that start by themselves wait until Runrail is open again.")
            .title("Runrail is still working")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep running".into()))
            .blocking_show();
        if quit {
            if let Some(state) = app.try_state::<HostState>() {
                state.quit_guard.store(false, Ordering::SeqCst);
            }
            app.exit(0);
        }
    });
}

#[tauri::command]
async fn notify_status() -> notify::Status {
    tauri::async_runtime::spawn_blocking(notify::status).await.unwrap_or(notify::Status { available: false, permission: notify::Permission::Unknown })
}

/// Shows macOS's own prompt the first time; later calls return the person's answer.
#[tauri::command]
async fn notify_request() -> notify::Status {
    tauri::async_runtime::spawn_blocking(notify::request).await.unwrap_or(notify::Status { available: false, permission: notify::Permission::Unknown })
}

#[tauri::command]
fn notify_send(note: notify::Note) -> BridgeResult<()> {
    notify::send(&note)
}

#[tauri::command]
fn notify_clear(thread_id: String) -> BridgeResult<()> {
    notify::clear(&thread_id)
}

#[tauri::command]
fn notify_take_opened() -> Option<String> {
    notify::take_opened()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn voice_unavailable() -> BridgeError {
    BridgeError::new("VOICE_UNAVAILABLE", "voice input on the host needs macOS or Linux")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn voice_emit(app: &tauri::AppHandle) -> voice::Emit {
    let handle = app.clone();
    Arc::new(move |name, payload| {
        let _ = handle.emit(name, payload);
    })
}

#[tauri::command]
async fn voice_devices() -> BridgeResult<Value> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return blocking(|| serde_json::to_value(voice::devices()).map_err(|_| BridgeError::new("VOICE_FAILED", "could not list microphones"))).await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err(voice_unavailable())
}

#[tauri::command]
async fn voice_models(state: State<'_, HostState>) -> BridgeResult<Value> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let app_data = state.supervisor.app_data().to_path_buf();
        return blocking(move || serde_json::to_value(voice::models::list(&app_data)).map_err(|_| BridgeError::new("VOICE_FAILED", "could not list models"))).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = state;
        Err(voice_unavailable())
    }
}

/// Starts a download of one model from the fixed list; progress comes as `voice:model` events.
#[tauri::command]
async fn voice_model_download(app: tauri::AppHandle, state: State<'_, HostState>, id: String) -> BridgeResult<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let app_data = state.supervisor.app_data().to_path_buf();
        let emit = voice_emit(&app);
        return blocking(move || voice::models::download(&app_data, &id, emit)).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (app, state, id);
        Err(voice_unavailable())
    }
}

#[tauri::command]
async fn voice_model_cancel(id: String) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let _ = tauri::async_runtime::spawn_blocking(move || voice::models::cancel(&id)).await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = id;
}

#[tauri::command]
async fn voice_model_remove(state: State<'_, HostState>, id: String) -> BridgeResult<Value> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let app_data = state.supervisor.app_data().to_path_buf();
        return blocking(move || voice::models::remove(&app_data, &id).and_then(|()| serde_json::to_value(voice::models::list(&app_data)).map_err(|_| BridgeError::new("VOICE_FAILED", "could not list models")))).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (state, id);
        Err(voice_unavailable())
    }
}

/// Starts listening; returns the session id once the microphone and recognizer run.
#[tauri::command]
async fn voice_start(app: tauri::AppHandle, state: State<'_, HostState>, input: Value) -> BridgeResult<u64> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let input: voice::ListenInput = serde_json::from_value(input).map_err(|_| BridgeError::new("VOICE_INVALID", "listening request is invalid"))?;
        let app_data = state.supervisor.app_data().to_path_buf();
        let emit = voice_emit(&app);
        return blocking(move || voice::start(&app_data, input, emit)).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (app, state, input);
        Err(voice_unavailable())
    }
}

#[tauri::command]
fn voice_stop(session: u64) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    voice::stop(session);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = session;
}

#[tauri::command]
fn voice_cancel(session: u64) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    voice::cancel(session);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = session;
}

fn quit_guarded(app: &tauri::AppHandle) -> bool {
    app.try_state::<HostState>().is_some_and(|state| state.quit_guard.load(Ordering::SeqCst))
}

#[tauri::command]
async fn shells_list() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(shells::list).await.unwrap_or_default()
}

/// Opens the system's folder dialog and copies the chosen skill into the project. `None` when the
/// person closes the dialog.
#[tauri::command]
async fn skill_import(app: tauri::AppHandle, workspace: String) -> BridgeResult<Option<skills::ImportedSkill>> {
    blocking(move || {
        resolve_workspace(&workspace)?;
        let Some(picked) = app.dialog().file().set_title("Choose a skill folder").blocking_pick_folder() else {
            return Ok(None);
        };
        let source = picked.into_path().map_err(|_| BridgeError::new("SKILL_INVALID", "choose a folder on this computer"))?;
        skills::import(&workspace, &source).map(Some)
    })
    .await
}

fn home_dir() -> BridgeResult<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from).filter(|path| path.is_absolute()).ok_or_else(|| BridgeError::new("IMPORT_UNAVAILABLE", "the home folder is unknown"))
}

/// What Claude Code, Codex, and the other tools on this Mac are set up with. Reads only.
#[tauri::command]
async fn other_tools_scan(workspace: Option<String>) -> BridgeResult<other_tools::OtherTools> {
    blocking(move || other_tools::scan(&home_dir()?, workspace.as_deref())).await
}

/// Copies a skill the scan found into the project. Any other folder is refused.
#[tauri::command]
async fn other_skill_import(workspace: String, path: String) -> BridgeResult<skills::ImportedSkill> {
    blocking(move || {
        let source = other_tools::known_skill(&home_dir()?, &path).ok_or_else(|| BridgeError::new("SKILL_INVALID", "that folder is not one of the skills found"))?;
        skills::import(&workspace, &source)
    })
    .await
}

/// Copies a subagent the scan found into the project's `.claude/agents`. Any other file is refused.
#[tauri::command]
async fn other_agent_import(workspace: String, path: String) -> BridgeResult<Vec<agents::AgentDefinition>> {
    blocking(move || {
        let source = other_tools::known_agent(&home_dir()?, &path).ok_or_else(|| BridgeError::new("AGENT_INVALID", "that file is not one of the subagents found"))?;
        agents::import(&workspace, &source)
    })
    .await
}

/// Adds servers found in other tools, after one native confirmation that spells out each one.
#[tauri::command]
async fn mcp_import(app: tauri::AppHandle, state: State<'_, HostState>, servers: Vec<mcp::McpServer>) -> BridgeResult<Vec<mcp::McpServer>> {
    if servers.len() > mcp::MAX_SERVERS {
        return Err(BridgeError::new("MCP_INVALID", "at most 16 MCP servers"));
    }
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || {
        mcp::McpStore::new(&app_data).save_many(servers, |added| {
            let lines = added
                .iter()
                .map(|server| {
                    let place = server.project.as_deref().map(|project| format!(" (only in {project})")).unwrap_or_default();
                    let extra = match (&server.url, server.bearer_env.as_deref()) {
                        (Some(_), Some(name)) => format!(", sending {name} from your shell as its access token"),
                        (None, _) if !server.env.is_empty() => format!(", with {} from your shell", server.env.join(", ")),
                        _ => String::new(),
                    };
                    format!("• {}: {}{extra}{place}", server.name, server.command_line())
                })
                .collect::<Vec<_>>()
                .join("\n");
            let message = format!("Runrail will start these programs, or connect to these addresses, for threads on its own loop, with your user's permissions:\n\n{lines}\n\nOnly add servers you trust.");
            app.dialog()
                .message(message)
                .title(if added.len() == 1 { format!("Add MCP server \"{}\"?", added[0].name) } else { format!("Add {} MCP servers?", added.len()) })
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(if added.len() == 1 { "Add server".into() } else { "Add servers".into() }, "Cancel".into()))
                .blocking_show()
        })
    })
    .await
}

#[tauri::command]
async fn agents_list(workspace: String) -> BridgeResult<Vec<agents::AgentDefinition>> {
    blocking(move || agents::list(&workspace)).await
}

#[tauri::command]
async fn agent_save(workspace: String, agent: agents::AgentDefinition, previous: Option<String>) -> BridgeResult<Vec<agents::AgentDefinition>> {
    blocking(move || agents::save(&workspace, agent, previous.as_deref())).await
}

#[tauri::command]
async fn agent_remove(workspace: String, name: String) -> BridgeResult<Vec<agents::AgentDefinition>> {
    blocking(move || agents::remove(&workspace, &name)).await
}

#[tauri::command]
async fn state_load(state: State<'_, HostState>) -> BridgeResult<Option<Value>> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || store::load(&app_data)).await
}

/// The page saved its state after `app:quitting`; the exit waiting for it goes ahead.
#[tauri::command]
fn state_flushed(state: State<'_, HostState>) {
    state.saved_for_exit.store(true, Ordering::SeqCst);
}

/// True while the page is still saving for this exit: the exit is held, and made again once the
/// page answers or the wait runs out.
fn save_before_exit(app: &tauri::AppHandle, code: i32) -> bool {
    let Some(state) = app.try_state::<HostState>() else { return false };
    if state.saved_for_exit.load(Ordering::SeqCst) || app.get_window("main").is_none() {
        return false;
    }
    if !state.asked_to_save.swap(true, Ordering::SeqCst) {
        let _ = app.emit("app:quitting", ());
        let app = app.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + SAVE_ON_EXIT_WAIT;
            while std::time::Instant::now() < deadline && !app.state::<HostState>().saved_for_exit.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            app.state::<HostState>().saved_for_exit.store(true, Ordering::SeqCst);
            app.exit(code);
        });
    }
    true
}

#[tauri::command]
async fn state_save(state: State<'_, HostState>, value: Value) -> BridgeResult<()> {
    let app_data = state.supervisor.app_data().to_path_buf();
    blocking(move || store::save(&app_data, &value)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    version: String,
    platform: &'static str,
    terminal: bool,
    updates: bool,
    /// Where keys are kept: `keychain` or `file`. The UI says so when it is a file.
    credential_store: &'static str,
    /// Whether the host can read a key from the clipboard on this system.
    clipboard_secrets: bool,
}

#[tauri::command]
fn host_info(app: tauri::AppHandle, state: State<'_, HostState>) -> HostInfo {
    HostInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        terminal: cfg!(unix),
        updates: update::enabled(),
        credential_store: state.supervisor.credentials().vault.flag(),
        clipboard_secrets: connections::CLIPBOARD_SECRETS,
    }
}

/// The renderer calls this once its saved state is loaded; the host keeps the first answer.
#[tauri::command]
fn startup_ready(state: State<'_, HostState>) -> Option<startup::StartupTiming> {
    state.startup.ready()
}

#[tauri::command]
async fn preview_open(app: tauri::AppHandle, tab: String, url: String, bounds: preview::Bounds, hidden: Option<bool>, project: Option<String>) -> BridgeResult<preview::Opened> {
    blocking(move || app.state::<preview::Previews>().open(&app, &tab, &url, bounds, hidden == Some(true), project.as_deref())).await
}

/// Whether a project has browser sign-ins saved.
#[tauri::command]
async fn sign_ins_saved(project: String) -> BridgeResult<bool> {
    blocking(move || sign_ins::saved(&project)).await
}

/// Whether browser sign-ins can be saved on this system, or why not.
#[tauri::command]
async fn sign_ins_support() -> SignInsSupport {
    tauri::async_runtime::spawn_blocking(|| match sign_ins::support() {
        Ok(()) => SignInsSupport { available: true, reason: None },
        Err(reason) => SignInsSupport { available: false, reason: Some(reason) },
    })
    .await
    .unwrap_or(SignInsSupport { available: false, reason: None })
}

#[derive(Serialize)]
struct SignInsSupport {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Forgets a project's saved browser sign-ins and stops saving them.
#[tauri::command]
async fn sign_ins_forget(app: tauri::AppHandle, project: String) -> BridgeResult<()> {
    blocking(move || app.state::<preview::Previews>().forget_sign_ins(&project)).await
}

/// One of the fixed page actions the agent may take when the person lets it use the browser.
#[tauri::command]
async fn preview_script(app: tauri::AppHandle, tab: String, script: preview_agent::Script, any_site: Option<bool>) -> BridgeResult<preview_agent::Answer> {
    blocking(move || {
        let source = preview_agent::script_source(&script)?;
        let webview = app.state::<preview::Previews>().loaded(&app, &tab, any_site == Some(true))?;
        preview_agent::run(&webview, source)
    })
    .await
}

/// The agent's own script. The person is asked every time, in a dialog the renderer cannot answer.
#[tauri::command]
async fn preview_eval(app: tauri::AppHandle, tab: String, expression: String, any_site: Option<bool>) -> BridgeResult<preview_agent::Answer> {
    blocking(move || {
        let source = preview_agent::eval_source(&expression)?;
        let previews = app.state::<preview::Previews>();
        let webview = previews.loaded(&app, &tab, any_site == Some(true))?;
        let page = previews.current(&app, &tab)?;
        let _asking = previews.asking.try_lock().map_err(|_| BridgeError::new("PREVIEW_BUSY", "another script is waiting for an answer").with_status(409))?;
        // The person approves exactly what runs: a script too long to show whole is not offered.
        if expression.chars().count() > MAX_SHOWN_SCRIPT {
            return Err(BridgeError::new("PREVIEW_SCRIPT_TOO_LONG", "The script is too long to show for approval; ask for a shorter one.").with_status(413));
        }
        let shown = visible_text(&expression);
        let host = page.host_str().unwrap_or("this page").to_string();
        let message = format!("The agent wants to run this script in {host}:\n\n{shown}\n\nA script can read and change anything on the page, including what you typed into it.");
        #[cfg(debug_assertions)]
        let queued = automation::dialog_answer("Run the agent's script?", &message);
        #[cfg(not(debug_assertions))]
        let queued = None;
        let allowed = queued.unwrap_or_else(|| {
            app.dialog()
                .message(message)
                .title("Run the agent's script?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Run script".into(), "Don't run".into()))
                .blocking_show()
        });
        if !allowed {
            return Err(BridgeError::new("PREVIEW_DENIED", "The person declined to run the script.").with_status(403));
        }
        // The page may have moved on while the dialog was open; the consent was for the site it named.
        if previews.current(&app, &tab)?.origin() != page.origin() {
            return Err(BridgeError::new("PREVIEW_NAVIGATED", "The page went to another site while you were asked; the script did not run.").with_status(409));
        }
        preview_agent::run(&webview, source)
    })
    .await
}

const MAX_SHOWN_SCRIPT: usize = 4_000;

/// Text for a confirmation dialog with every invisible or reordering character written out, so
/// what the person reads is what runs.
fn visible_text(text: &str) -> String {
    text.chars()
        .map(|ch| if ch != '\n' && ch != '\t' && mcp::hides_text(&ch.to_string()) { format!("\\u{{{:04X}}}", ch as u32) } else { ch.to_string() })
        .collect()
}

/// What the page shows, as WebKit draws it, at most 1600 pixels wide.
#[tauri::command]
async fn preview_screenshot(app: tauri::AppHandle, tab: String, any_site: Option<bool>, width: Option<f64>) -> BridgeResult<preview_agent::Picture> {
    // An artboard shows a page scaled down; its picture is taken at the width the page lays out at.
    if width.is_some_and(|width| !preview::valid_artboard_width(width)) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "screenshot width is invalid"));
    }
    blocking(move || {
        let webview = app.state::<preview::Previews>().loaded(&app, &tab, any_site == Some(true))?;
        let scale = webview.window().scale_factor().unwrap_or(1.0).max(1.0);
        let wide = webview.size().map(|size| f64::from(size.width) / scale).unwrap_or(800.0);
        preview_agent::screenshot(&webview, width.unwrap_or_else(|| wide.min(1600.0 / scale).max(1.0)))
    })
    .await
}

#[tauri::command]
async fn preview_zoom(app: tauri::AppHandle, tab: String, scale: f64) -> BridgeResult<()> {
    app.state::<preview::Previews>().zoom(&app, &tab, scale)
}

#[tauri::command]
async fn preview_bounds(app: tauri::AppHandle, tab: String, bounds: Option<preview::Bounds>) -> BridgeResult<()> {
    app.state::<preview::Previews>().bounds(&app, &tab, bounds)
}

#[tauri::command]
async fn preview_action(app: tauri::AppHandle, tab: String, action: preview::Action) -> BridgeResult<()> {
    app.state::<preview::Previews>().action(&app, &tab, action)
}

#[tauri::command]
async fn preview_external(app: tauri::AppHandle, tab: String) -> BridgeResult<()> {
    let url = app.state::<preview::Previews>().current(&app, &tab)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|_| BridgeError::new("PREVIEW_FAILED", "the default browser could not be opened"))
}

#[tauri::command]
async fn preview_close(app: tauri::AppHandle, tab: String) -> BridgeResult<()> {
    app.state::<preview::Previews>().close(&app, &tab)
}

/// The renderer's open browser tabs, after a restore or a deleted thread; others are closed.
#[tauri::command]
async fn preview_retain(app: tauri::AppHandle, tabs: Vec<String>) -> BridgeResult<()> {
    if tabs.len() > 512 {
        return Err(BridgeError::new("PREVIEW_INVALID_INPUT", "too many preview tabs").with_status(400));
    }
    app.state::<preview::Previews>().retain(&app, &tabs);
    Ok(())
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> BridgeResult<update::UpdateStatus> {
    update::check(&app).await
}

#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> BridgeResult<()> {
    update::install(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(target_os = "macos", debug_assertions))]
    responsibility::claim();
    #[cfg(target_os = "linux")]
    if wake::service_passthrough().is_some() {
        std::process::exit(1);
    }
    #[cfg(target_os = "linux")]
    preview_gtk::renderer_fallback();
    let builder = tauri::Builder::default();
    // A second launch reopens the window over the session bus; first, so it exits
    // before anything else starts. Without a session bus there is nothing to ask.
    #[cfg(target_os = "linux")]
    let builder = if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some() || std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|dir| Path::new(&dir).join("bus").exists()) {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| background::launched_again(app, &args)))
    } else {
        builder
    };
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(quick) = app.try_state::<Arc<quick::Quick>>() {
                            quick.pressed(app);
                        }
                    }
                })
                .build(),
        );
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            approvals::init(&app_data);
            computer::init(&app_data);
            simulator::init(&app_data);
            android::init(&app_data);
            sign_ins::init(&app_data);
            #[cfg(debug_assertions)]
            automation::start(app.handle(), &app_data);
            let resource_dir = app.path().resource_dir().ok();
            // Signed builds keep keys in the OS keychain. Development builds are re-signed on
            // every rebuild, which makes the keychain prompt each time, so they use a file, as
            // does a Linux with no Secret Service.
            let credentials = CredentialStorage::select(
                &app_data,
                app.path().home_dir().ok().as_deref(),
                std::env::var("RUNRAIL_DESKTOP_CREDENTIAL_VAULT").ok().as_deref(),
                cfg!(debug_assertions),
                connections::os_keychain_available(),
            );
            notify::install(app.handle());
            let handle = app.handle().clone();
            let emit: engine::Emitter = Arc::new(move |name, payload| {
                let _ = handle.emit(name, payload);
            });
            if let Some(window) = app.get_webview_window("main") {
                restore_window(&window, &app_data);
                #[cfg(target_os = "linux")]
                preview_gtk::install(&window);
            }
            app.manage(preview::Previews::default());
            let resolver = app.handle().clone();
            let assets: phone::Assets = Arc::new(move |path| resolver.asset_resolver().get(path.to_string()).map(|asset| (asset.bytes, asset.mime_type)));
            let phone = phone::Phone::new(&app_data, Arc::clone(&emit), assets);
            phone.start_if_enabled();
            app.manage(phone);
            let quick = quick::Quick::new(&app_data);
            quick.start(app.handle());
            app.manage(quick);
            app.manage(HostState {
                startup: startup::Startup::new(&app_data),
                keep_awake: power::KeepAwake::default(),
                background: background::Background::default(),
                quit_guard: AtomicBool::new(false),
                saved_for_exit: AtomicBool::new(false),
                asked_to_save: AtomicBool::new(false),
                supervisor: Supervisor::new(app_data, resource_dir, credentials, emit),
            });
            // The window starts hidden: a login launch keeps it so, in the menu bar, and the page's
            // answer about pending work decides whether the app stays.
            if let Ok(home) = home_dir() {
                wake::start_notes(home.clone());
                let identifier = app.config().identifier.clone();
                let _ = std::thread::Builder::new().name("runrail-wake-refresh".into()).spawn(move || {
                    wake::refresh(&identifier, &home);
                    #[cfg(target_os = "linux")]
                    login::refresh(&identifier);
                });
            }
            if login::launched_at_login() || wake::woken() {
                background::hide(app.handle());
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == quick::LABEL {
                // Quick chat only ever hides; the shortcut brings it back.
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Pending work keeps the app in the menu bar; only Quit stops it.
                if background::stays(window.app_handle()) {
                    api.prevent_close();
                    remember_window(window);
                    background::hide(window.app_handle());
                    return;
                }
                if quit_guarded(window.app_handle()) {
                    api.prevent_close();
                    confirm_quit(window.app_handle().clone());
                    return;
                }
                remember_window(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            computer_access,
            computer_request_access,
            computer_open_settings,
            computer_running_apps,
            computer_allowed,
            computer_allow,
            computer_disallow,
            computer_act,
            simulator_status,
            simulator_devices,
            simulator_boot,
            simulator_shutdown,
            simulator_open,
            simulator_screenshot,
            simulator_apps,
            simulator_install,
            simulator_launch,
            simulator_open_url,
            simulator_input,
            simulator_agents,
            android_status,
            android_devices,
            android_boot,
            android_shutdown,
            android_screenshot,
            android_apps,
            android_install,
            android_launch,
            android_open_url,
            android_input,
            android_agents,
            sign_ins_saved,
            sign_ins_support,
            sign_ins_forget,
            engine_start,
            engine_stop,
            engine_list,
            control_rpc,
            system_engine,
            connection_secret_set,
            connection_secret_from_clipboard,
            auth_open,
            auth_submit_input,
            control_health,
            control_stream_start,
            control_stream_stop,
            thread_forget,
            workspace_inspect,
            workspace_pick,
            app_starters,
            app_create,
            archive_pick,
            workspace_reveal,
            workspace_open_in,
            open_in_apps,
            attachment_save,
            instructions_read,
            instructions_write,
            mcp_list,
            mcp_save,
            mcp_set_enabled,
            mcp_remove,
            mcp_import,
            other_tools_scan,
            other_skill_import,
            other_agent_import,
            keep_awake,
            quit_guard,
            app_quit,
            background_hold,
            login_item_status,
            login_item_set,
            wake_service_status,
            remote_list,
            remote_save,
            remote_remove,
            remote_check,
            ssh_hosts,
            phone_status,
            phone_set,
            phone_pair,
            phone_forget,
            phone_answer,
            phone_share_thread,
            phone_publish,
            phone_unshare,
            phone_hook_create,
            phone_hook_remove,
            quick_status,
            quick_set,
            quick_context,
            quick_submit,
            quick_hide,
            phone_set_push,
            phone_push_targets,
            tailscale_status,
            tailscale_serve,
            wake_service_set,
            launch_woken,
            notify_status,
            notify_request,
            notify_send,
            notify_clear,
            notify_take_opened,
            voice_devices,
            voice_models,
            voice_model_download,
            voice_model_cancel,
            voice_model_remove,
            voice_start,
            voice_stop,
            voice_cancel,
            shells_list,
            skill_import,
            agents_list,
            agent_save,
            agent_remove,
            state_load,
            state_save,
            state_flushed,
            host_info,
            startup_ready,
            update_check,
            update_install,
            preview_open,
            preview_bounds,
            preview_action,
            preview_external,
            preview_close,
            preview_retain,
            preview_script,
            preview_eval,
            preview_screenshot,
            preview_zoom,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Runrail desktop app");
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = &event {
            // A requested exit code is the app's own exit; the person's Quit carries none.
            if code.is_none() && quit_guarded(handle) {
                api.prevent_exit();
                confirm_quit(handle.clone());
                return;
            }
            if save_before_exit(handle, code.unwrap_or(0)) {
                api.prevent_exit();
                return;
            }
            if let Some(window) = handle.get_window("main") {
                remember_window(&window);
            }
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = &event {
            if handle.try_state::<HostState>().is_some_and(|state| state.background.hidden()) {
                background::show(handle);
            }
        }
        if matches!(event, RunEvent::Exit) {
            if let Some(phone) = handle.try_state::<Arc<phone::Phone>>() {
                phone.shutdown();
            }
            if let Ok(home) = home_dir() {
                wake::note_quit(&home);
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            voice::shutdown();
            if let Some(state) = handle.try_state::<HostState>() {
                state.supervisor.stop_all();
            }
        }
    });
}

/// Puts the main window back where it was, if that place is still on a screen.
fn restore_window(window: &tauri::WebviewWindow, app_data: &std::path::Path) {
    let Some(state) = window_state::load(app_data) else {
        return;
    };
    let screens: Vec<window_state::Screen> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| window_state::Screen { x: monitor.position().x, y: monitor.position().y, width: monitor.size().width, height: monitor.size().height })
        .collect();
    if !state.on_screen(&screens) {
        return;
    }
    let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    if state.maximized {
        let _ = window.maximize();
    }
}

fn remember_window(window: &tauri::Window) {
    if window.label() != "main" || window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Ok(app_data) = window.app_handle().path().app_data_dir() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    window_state::save(&app_data, &window_state::WindowState { x: position.x, y: position.y, width: size.width, height: size.height, maximized });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memory_provider_that_runs_or_sends_is_named_for_confirmation() {
        let line = |params: Value| memory_provider_line(&params).map_err(|error| error.code);
        assert_eq!(line(serde_json::json!({ "provider": { "name": "m", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } })), Ok(Some("npx -y @modelcontextprotocol/server-memory".into())));
        assert_eq!(line(serde_json::json!({ "provider": { "name": "m", "url": "https://memory.example.com/mcp" } })), Ok(Some("https://memory.example.com/mcp".into())));
        assert_eq!(line(serde_json::json!({ "provider": "local" })), Ok(None));
        assert_eq!(line(serde_json::json!({ "provider": { "name": "m", "command": "npx", "inherit": ["MEM_KEY"] } })), Ok(Some("npx\n\nIt is given these of your environment variables: MEM_KEY".into())));
        // The dialog would show the program while the engine dialed the address.
        assert_eq!(line(serde_json::json!({ "provider": { "name": "m", "command": "npx", "url": "https://elsewhere.example.com/mcp" } })), Err("MEMORY_PROVIDER_INVALID".into()));
    }

    #[test]
    fn a_github_write_is_described_for_its_own_confirmation() {
        let merge = pull_request_write("git.pr.merge", &serde_json::json!({ "owner": "example-org", "repo": "app", "number": 12, "method": "squash", "headCommit": "0123456789abcdef0123456789abcdef01234567", "subject": "Fix it (#12)", "deleteBranch": true, "confirm": true })).unwrap().unwrap();
        assert_eq!(merge.title, "Merge pull request?");
        assert_eq!(merge.message, "Merge pull request example-org/app #12?\n\nSquash and merge, at the commit you reviewed (0123456).\nCommit title: Fix it (#12)\nThe branch is deleted after merging.");
        let post = pull_request_write("git.pr.review.post", &serde_json::json!({ "owner": "example-org", "repo": "app", "number": 12, "host": "ghe.example.com", "body": "Looks good \u{202E}", "comments": [{}, {}] })).unwrap().unwrap();
        assert_eq!(post.message, "Post this review to example-org/app #12 on ghe.example.com under your GitHub name?\n\n2 comments on lines.\n\nLooks good \\u{202E}");
        assert!(pull_request_write("git.pr.merge", &serde_json::json!({ "owner": "example-org", "repo": "app", "method": "squash" })).unwrap().is_err());
        assert!(pull_request_write("git.pr.view", &serde_json::json!({})).is_none());
    }

    #[test]
    fn a_confirmation_shows_hidden_characters_written_out() {
        assert_eq!(visible_text("ok\nrm -rf \u{202E}fdsa"), "ok\nrm -rf \\u{202E}fdsa");
        assert_eq!(visible_text("a\u{200B}b\tc"), "a\\u{200B}b\tc");
    }

    #[cfg(unix)]
    #[test]
    fn an_attachment_is_never_written_through_a_link_out_of_the_workspace() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-attachment-link-{}", std::process::id()));
        let outside = root.join("outside");
        let project = root.join("project");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::os::unix::fs::symlink(&outside, project.join(".runrail")).unwrap();
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
        assert!(save_attachment(&project.to_string_lossy(), "image/png", &png).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn contained_paths_stay_inside_the_workspace() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-contained-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), b"").unwrap();
        let workspace = root.to_string_lossy().into_owned();
        assert!(contained_path(&workspace, None).is_ok());
        assert!(contained_path(&workspace, Some("src/a.ts")).unwrap().ends_with("src/a.ts"));
        assert!(contained_path(&workspace, Some("../")).is_err());
        assert!(contained_path(&workspace, Some("/etc/hosts")).is_err());
        assert!(contained_path(&workspace, Some("missing")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn terminals_and_finder_are_only_given_a_plain_folder() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-open-in-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src/Evil.app/Contents")).unwrap();
        std::fs::write(root.join("src/run.command"), b"#!/bin/sh\n").unwrap();
        let root = root.canonicalize().unwrap();
        let workspace = root.to_string_lossy().into_owned();
        let folder = |relative: &str| plain_folder(&root, contained_path(&workspace, Some(relative)).unwrap()).unwrap();
        assert_eq!(folder("src/run.command"), root.join("src"));
        assert_eq!(folder("src/Evil.app"), root.join("src"));
        assert_eq!(folder("src/Evil.app/Contents"), root.join("src/Evil.app/Contents"));
        assert_eq!(folder("src"), root.join("src"));
        assert!(opens_as_folder("terminal") && opens_as_folder("iterm") && opens_as_folder("ghostty") && opens_as_folder("finder"));
        assert!(opens_as_folder("files") && opens_as_folder("konsole") && opens_as_folder("kitty"));
        assert!(!opens_as_folder("vscode") && !opens_as_folder("idea"));
        let bundle = root.join("src/Evil.app");
        assert!(plain_folder(&bundle, bundle.clone()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn attachments_are_typed_and_contained() {
        let root = std::env::temp_dir().join(format!("runrail-desktop-attach-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
        let relative = save_attachment(&workspace, "image/png", &png).unwrap();
        assert!(relative.starts_with(".runrail/attachments/") && relative.ends_with(".png"));
        assert!(root.join(&relative).exists());
        assert!(root.join(".runrail/attachments/.gitignore").exists());
        assert!(save_attachment(&workspace, "image/jpeg", &png).is_err());
        assert!(save_attachment(&workspace, "image/png", b"not an image").is_err());
        assert!(save_attachment(&workspace, "image/png", &vec![0x89; MAX_ATTACHMENT_BYTES + 1]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn quoted_names(text: &str) -> Vec<String> {
        text.lines().filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\",").map(str::to_string)).collect()
    }

    /// A command missing from the manifest stops working; one granted beyond the main webview
    /// reaches a previewed page.
    #[test]
    fn every_command_is_granted_to_the_main_webview_and_quick_chat_gets_its_own_three() {
        let source = include_str!("lib.rs");
        let handler = source.split("generate_handler![").nth(1).unwrap().split("])").next().unwrap();
        let mut handled: Vec<String> = handler.lines().map(|line| line.trim().trim_end_matches(',').to_string()).filter(|line| !line.is_empty()).collect();
        let build = include_str!("../build.rs");
        let mut listed = quoted_names(build.split("const COMMANDS").nth(1).unwrap().split("];").next().unwrap());
        handled.sort();
        listed.sort();
        assert_eq!(handled, listed);

        let capabilities = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap();
        let mut granted = Vec::new();
        for entry in capabilities {
            let capability: Value = serde_json::from_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap();
            assert!(capability.get("windows").is_none(), "a window capability covers every webview in it");
            assert!(capability.get("remote").is_none());
            let mut commands = Vec::new();
            for permission in capability["permissions"].as_array().unwrap() {
                if let Some(command) = permission.as_str().and_then(|name| name.strip_prefix("allow-")) {
                    commands.push(command.replace('-', "_"));
                }
            }
            if capability["webviews"] == serde_json::json!([quick::LABEL]) {
                // Quick chat's window reads what was in front, hands on, and hides.
                commands.sort();
                assert_eq!(commands, ["quick_context", "quick_hide", "quick_submit"]);
                assert_eq!(capability["permissions"].as_array().unwrap().len(), commands.len());
            } else {
                assert_eq!(capability["webviews"], serde_json::json!(["main"]));
            }
            granted.extend(commands);
        }
        granted.sort();
        assert_eq!(granted, listed);
    }
}
