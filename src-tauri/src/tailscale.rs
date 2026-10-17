//! The person's own Tailscale: where its command line is, this computer's name on
//! the tailnet, whether the tailnet has HTTPS certificates, and whether `tailscale serve` brings
//! phone access there. Only those facts are read from its status; peers and addresses stay here.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::{BridgeError, BridgeResult};
use crate::process::run;

/// The standalone app's and Homebrew's command, then the App Store app's own binary.
#[cfg(target_os = "macos")]
const CANDIDATES: [&str; 3] = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
/// The distribution packages' command, a hand install, and the snap.
#[cfg(not(target_os = "macos"))]
const CANDIDATES: [&str; 3] = ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale"];
/// The tailnet port phone access is served on; 443 is left for whatever else the person serves.
pub const HTTPS_PORT: u16 = 8443;
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tailscale {
    pub installed: bool,
    /// Connected to a tailnet.
    pub running: bool,
    /// This Mac's name on the tailnet, such as `mac.tail1234.ts.net`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The tailnet gives out HTTPS certificates, which `tailscale serve --https` needs.
    pub https: bool,
    /// The tailnet's port 8443 on this Mac goes to phone access.
    pub served: bool,
}

fn cli() -> Option<PathBuf> {
    let fixed = CANDIDATES.iter().map(PathBuf::from).find(|path| path.is_file());
    #[cfg(not(target_os = "macos"))]
    let fixed = fixed.or_else(|| crate::engine::find_on_path("tailscale"));
    fixed
}

/// Linux lets only root change `tailscale serve` until root names an operator; Tailscale says so.
fn needs_operator(stderr: &str) -> bool {
    stderr.contains("--operator")
}

fn target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The command `serve` runs, as the person can run it themselves.
pub fn serve_args(port: u16, on: bool) -> Vec<String> {
    if on {
        vec!["serve".into(), "--bg".into(), format!("--https={HTTPS_PORT}"), target(port)]
    } else {
        vec!["serve".into(), format!("--https={HTTPS_PORT}"), "off".into()]
    }
}

/// Connected, this Mac's name, and HTTPS, from `tailscale status --json`.
pub fn read_status(status: &Value) -> (bool, Option<String>, bool) {
    let running = status["BackendState"].as_str() == Some("Running");
    let name = status["Self"]["DNSName"]
        .as_str()
        .map(|name| name.trim_end_matches('.').to_ascii_lowercase())
        .filter(|name| !name.is_empty() && name.len() <= 253 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
    let https = status["CertDomains"].as_array().is_some_and(|domains| !domains.is_empty());
    (running, name, https)
}

/// Whether `tailscale serve status --json` sends the tailnet's port 8443 to phone access.
pub fn read_served(config: &Value, port: u16) -> bool {
    let suffix = format!(":{HTTPS_PORT}");
    let wanted = target(port);
    config["Web"].as_object().is_some_and(|sites| sites.iter().any(|(host, site)| host.ends_with(&suffix) && site["Handlers"]["/"]["Proxy"].as_str().map(|proxy| proxy.trim_end_matches('/')) == Some(wanted.as_str())))
}

fn json_of(cli: &PathBuf, args: &[&str]) -> Option<Value> {
    let mut command = Command::new(cli);
    command.args(args);
    let ran = run(command, None, TIMEOUT).ok().filter(|ran| ran.ok)?;
    serde_json::from_slice(&ran.stdout).ok()
}

pub fn status(port: u16) -> Tailscale {
    let Some(cli) = cli() else { return Tailscale::default() };
    let Some(status) = json_of(&cli, &["status", "--json"]) else {
        return Tailscale { installed: true, ..Tailscale::default() };
    };
    let (running, name, https) = read_status(&status);
    let served = running && json_of(&cli, &["serve", "status", "--json"]).is_some_and(|config| read_served(&config, port));
    Tailscale { installed: true, running, name, https, served }
}

/// Turns the tailnet's port 8443 to phone access on or off. The caller has asked the person first.
pub fn serve(port: u16, on: bool) -> BridgeResult<Tailscale> {
    let (here, terminal) = if cfg!(target_os = "macos") { ("this Mac", "Terminal") } else { ("this computer", "a terminal") };
    let Some(cli) = cli() else {
        return Err(BridgeError::new("TAILSCALE_MISSING", format!("Tailscale is not installed on {here}.")));
    };
    let before = status(port);
    if !before.running {
        return Err(BridgeError::new("TAILSCALE_STOPPED", format!("Tailscale is not connected on {here}.")));
    }
    if on && !before.https {
        return Err(BridgeError::new("TAILSCALE_HTTPS_OFF", "Turn on HTTPS certificates for your tailnet in the Tailscale admin console, then try again."));
    }
    let mut command = Command::new(&cli);
    command.args(serve_args(port, on));
    // Its own words may name the tailnet or this Mac's addresses, so they are not passed on.
    let ran = run(command, None, TIMEOUT).map_err(|_| BridgeError::new("TAILSCALE_SERVE_FAILED", format!("tailscale serve did not finish. Run the command in {terminal} to see why.")))?;
    if !ran.ok && needs_operator(&ran.stderr) {
        return Err(BridgeError::new("TAILSCALE_OPERATOR", "Tailscale lets only root change what it serves. Run sudo tailscale set --operator=$USER in a terminal once, then try again."));
    }
    if !ran.ok {
        return Err(BridgeError::new("TAILSCALE_SERVE_FAILED", format!("tailscale serve did not work. Run the command in {terminal} to see why.")));
    }
    Ok(status(port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_only_the_name_https_and_whether_it_is_connected() {
        let status = json!({ "BackendState": "Running", "Self": { "DNSName": "My-Mac.tail1234.ts.net.", "TailscaleIPs": ["100.64.0.1"] }, "CertDomains": ["my-mac.tail1234.ts.net"], "Peer": { "x": {} } });
        assert_eq!(read_status(&status), (true, Some("my-mac.tail1234.ts.net".into()), true));
        assert_eq!(read_status(&json!({ "BackendState": "Stopped", "Self": { "DNSName": "" } })), (false, None, false));
        assert_eq!(read_status(&json!({ "BackendState": "Running", "Self": { "DNSName": "bad name;rm" }, "CertDomains": [] })), (true, None, false));
    }

    #[test]
    fn knows_when_8443_goes_to_phone_access() {
        let config = json!({ "TCP": { "8443": { "HTTPS": true } }, "Web": { "my-mac.tail1234.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:47615" } } } } });
        assert!(read_served(&config, 47615));
        assert!(!read_served(&config, 47616));
        assert!(!read_served(&json!({ "Web": { "my-mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:47615" } } } } }), 47615));
        assert!(!read_served(&json!({}), 47615));
    }

    #[test]
    fn a_refusal_for_want_of_an_operator_is_told_apart() {
        assert!(needs_operator("Access denied: serve config denied\n\nUse 'sudo tailscale serve ...' or 'sudo tailscale set --operator=$USER' to allow."));
        assert!(!needs_operator("serve: HTTPS is not enabled"));
    }

    #[test]
    fn serves_8443_and_turns_only_that_off() {
        assert_eq!(serve_args(47615, true), ["serve", "--bg", "--https=8443", "http://127.0.0.1:47615"]);
        assert_eq!(serve_args(47615, false), ["serve", "--https=8443", "off"]);
    }
}
