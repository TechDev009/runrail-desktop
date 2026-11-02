//! Optional GitHub event relay client. The relay token never crosses the renderer boundary and is
//! stored only in the operating system credential store. Local GitHub credentials and CI logs stay
//! on this machine.

use std::io::Read;
use std::time::{Duration, Instant};

use keyring::Entry;
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::redirect::Policy;
use reqwest::Url;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{BridgeError, BridgeResult};

const SERVICE: &str = "com.runrail.desktop.github-relay";
const ACCOUNT: &str = "installation-client";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const PAIR_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PAIR_POLL_INTERVAL: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Runrail-Desktop-GitHub-Relay";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayEvent {
    pub delivery_id: String,
    pub event: String,
    pub repository: String,
    pub pr_number: u64,
    pub head_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
    pub occurred_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'static str>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRelay {
    base_url: String,
    installation_id: String,
    token: String,
}

impl Drop for StoredRelay {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

fn invalid(message: &'static str) -> BridgeError {
    BridgeError::new("GITHUB_RELAY_INVALID", message)
}

fn unavailable(message: &'static str) -> BridgeError {
    BridgeError::new("GITHUB_RELAY_UNAVAILABLE", message)
}

fn credential_entry() -> BridgeResult<Entry> {
    Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| unavailable("the operating system credential store is unavailable"))
}

fn read_saved() -> BridgeResult<Option<StoredRelay>> {
    let entry = credential_entry()?;
    let value = match entry.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => {
            return Err(unavailable(
                "the GitHub relay credential could not be read from the operating system",
            ))
        }
    };
    let saved: StoredRelay = serde_json::from_str(&value)
        .map_err(|_| invalid("saved GitHub relay credentials are invalid"))?;
    validate_base_url(&saved.base_url)?;
    if !valid_installation_id(&saved.installation_id) || !valid_token(&saved.token) {
        return Err(invalid("saved GitHub relay credentials are invalid"));
    }
    Ok(Some(saved))
}

fn store_saved(saved: &StoredRelay) -> BridgeResult<()> {
    let entry = credential_entry()?;
    let serialized = Zeroizing::new(
        serde_json::to_string(saved)
            .map_err(|_| invalid("relay credentials could not be serialized"))?,
    );
    entry.set_password(&serialized).map_err(|_| {
        unavailable("the GitHub relay credential could not be saved to the operating system")
    })
}

fn delete_saved() -> BridgeResult<()> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(unavailable(
            "the GitHub relay credential could not be removed from the operating system",
        )),
    }
}

pub fn status() -> RelayStatus {
    match read_saved() {
        Ok(Some(saved)) => RelayStatus {
            state: "paired",
            installation_id: Some(saved.installation_id.clone()),
            message: None,
        },
        Ok(None) if configured_base_url().is_ok() && configured_app_slug().is_ok() => RelayStatus {
            state: "unpaired",
            installation_id: None,
            message: None,
        },
        Ok(None) => RelayStatus {
            state: "not-configured",
            installation_id: None,
            message: Some(
                "The relay endpoint and GitHub App slug must be configured in this build.",
            ),
        },
        Err(_) => RelayStatus {
            state: "unavailable",
            installation_id: None,
            message: Some("The operating system credential store is unavailable."),
        },
    }
}

pub fn pair(open_url: impl FnOnce(&str) -> BridgeResult<()>) -> BridgeResult<RelayStatus> {
    let base_url = configured_base_url()?;
    let app_slug = configured_app_slug()?;
    if read_saved()?.is_some() {
        return Ok(status());
    }
    let state = random_hex(32)?;
    let token = Zeroizing::new(random_hex(32)?);
    let client = http_client()?;
    let start_url = endpoint(&base_url, "v1/pair/start")?;
    let start = send_json(client.post(start_url).json(&json!({ "state": state })))?;
    let install_url = validate_install_url(
        start
            .get("installationUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("the relay returned an invalid GitHub installation URL"))?,
        &state,
        app_slug,
    )?;
    open_url(install_url.as_str())?;

    let deadline = Instant::now() + PAIR_TIMEOUT;
    let complete_url = endpoint(&base_url, "v1/pair/complete")?;
    let mut installation_id = None;
    while Instant::now() < deadline {
        let response = client
            .post(complete_url.clone())
            .header(AUTHORIZATION, sensitive_bearer(token.as_str())?)
            .json(&json!({ "state": state }))
            .send()
            .map_err(|_| unavailable("the GitHub relay could not be reached"))?;
        if response.status().as_u16() == 202 {
            std::thread::sleep(PAIR_POLL_INTERVAL);
            continue;
        }
        let answer = read_json_response(response)?;
        let id = answer
            .get("installationId")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("the relay returned an invalid installation id"))?;
        if id == 0 {
            return Err(invalid("the relay returned an invalid installation id"));
        }
        installation_id = Some(id.to_string());
        break;
    }
    let installation_id = installation_id.ok_or_else(|| {
        BridgeError::new(
            "GITHUB_RELAY_PAIR_TIMEOUT",
            "GitHub installation was not completed before the pairing link expired",
        )
    })?;
    let saved = StoredRelay {
        base_url: base_url.to_string(),
        installation_id: installation_id.clone(),
        token: token.to_string(),
    };
    if let Err(error) = store_saved(&saved) {
        let _ = unpair_remote(&client, &saved);
        return Err(error);
    }
    Ok(RelayStatus {
        state: "paired",
        installation_id: Some(installation_id),
        message: None,
    })
}

pub fn unpair() -> BridgeResult<RelayStatus> {
    let saved = read_saved()?;
    let remote_error = saved
        .as_ref()
        .and_then(|saved| unpair_remote(&http_client().ok()?, saved).err());
    // Always erase the local bearer token, even if the service is temporarily offline.
    delete_saved()?;
    if remote_error.is_some() {
        return Ok(RelayStatus { state: "unpaired", installation_id: None, message: Some("Local pairing was removed. The server-side token may remain until it expires or is revoked in the GitHub App.") });
    }
    Ok(RelayStatus {
        state: "unpaired",
        installation_id: None,
        message: None,
    })
}

pub fn fetch_events() -> BridgeResult<Vec<RelayEvent>> {
    let saved = read_saved()?.ok_or_else(|| {
        BridgeError::new("GITHUB_RELAY_UNPAIRED", "the GitHub relay is not paired")
    })?;
    let url = endpoint(
        &validate_base_url(&saved.base_url)?,
        &format!("v1/installations/{}/events", saved.installation_id),
    )?;
    let response = authenticated(http_client()?, &saved, url)?
        .send()
        .map_err(|_| unavailable("the GitHub relay could not be reached"))?;
    if matches!(response.status().as_u16(), 401 | 410) {
        let _ = delete_saved();
        return Err(BridgeError::new(
            "GITHUB_RELAY_REVOKED",
            "the GitHub App installation was removed or this desktop was unpaired",
        ));
    }
    let value = read_json_response(response)?;
    let items = value
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("the relay event response is invalid"))?;
    if items.len() > 100 {
        return Err(invalid("the relay returned too many events"));
    }
    items
        .iter()
        .cloned()
        .map(|item| {
            let event: RelayEvent =
                serde_json::from_value(item).map_err(|_| invalid("the relay event is invalid"))?;
            validate_event(&event)?;
            Ok(event)
        })
        .collect()
}

pub fn acknowledge(delivery_ids: Vec<String>) -> BridgeResult<()> {
    if delivery_ids.is_empty()
        || delivery_ids.len() > 100
        || delivery_ids.iter().any(|id| !valid_delivery_id(id))
    {
        return Err(invalid("the relay acknowledgement is invalid"));
    }
    let saved = read_saved()?.ok_or_else(|| {
        BridgeError::new("GITHUB_RELAY_UNPAIRED", "the GitHub relay is not paired")
    })?;
    let url = endpoint(
        &validate_base_url(&saved.base_url)?,
        &format!("v1/installations/{}/events/ack", saved.installation_id),
    )?;
    let header = sensitive_bearer(&saved.token)?;
    let response = http_client()?
        .post(url)
        .header(AUTHORIZATION, header)
        .json(&json!({ "deliveryIds": delivery_ids }))
        .send()
        .map_err(|_| unavailable("the GitHub relay could not be reached"))?;
    ensure_success(response)
}

fn unpair_remote(client: &Client, saved: &StoredRelay) -> BridgeResult<()> {
    let url = endpoint(
        &validate_base_url(&saved.base_url)?,
        &format!("v1/installations/{}/unpair", saved.installation_id),
    )?;
    let header = sensitive_bearer(&saved.token)?;
    let response = client
        .clone()
        .post(url)
        .header(AUTHORIZATION, header)
        .json(&json!({}))
        .send()
        .map_err(|_| unavailable("the GitHub relay could not be reached"))?;
    ensure_success(response)
}

fn authenticated(
    client: Client,
    saved: &StoredRelay,
    url: Url,
) -> BridgeResult<reqwest::blocking::RequestBuilder> {
    let header = sensitive_bearer(&saved.token)?;
    Ok(client.get(url).header(AUTHORIZATION, header))
}

fn http_client() -> BridgeResult<Client> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| unavailable("the HTTPS client could not be initialized"))
}

fn send_json(request: reqwest::blocking::RequestBuilder) -> BridgeResult<Value> {
    let response = request
        .header(CONTENT_TYPE, "application/json")
        .send()
        .map_err(|_| unavailable("the GitHub relay could not be reached"))?;
    read_json_response(response)
}

fn ensure_success(response: Response) -> BridgeResult<()> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => BridgeError::new(
                "GITHUB_RELAY_AUTH",
                "the GitHub relay pairing is no longer authorized",
            ),
            404 => BridgeError::new(
                "GITHUB_RELAY_NOT_FOUND",
                "the GitHub relay pairing was not found",
            ),
            429 => BridgeError::new(
                "GITHUB_RELAY_RATE_LIMITED",
                "the GitHub relay asked Runrail to retry later",
            ),
            _ => unavailable("the GitHub relay returned an unsuccessful response"),
        });
    }
    Ok(())
}

fn read_json_response(mut response: Response) -> BridgeResult<Value> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => BridgeError::new(
                "GITHUB_RELAY_AUTH",
                "the GitHub relay pairing is no longer authorized",
            ),
            404 => BridgeError::new(
                "GITHUB_RELAY_NOT_FOUND",
                "the GitHub relay pairing was not found",
            ),
            429 => BridgeError::new(
                "GITHUB_RELAY_RATE_LIMITED",
                "the GitHub relay asked Runrail to retry later",
            ),
            _ => unavailable("the GitHub relay returned an unsuccessful response"),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(invalid("the relay response is too large"));
    }
    let mut body = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| invalid("the relay response could not be read"))?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(invalid("the relay response is too large"));
    }
    serde_json::from_slice(&body).map_err(|_| invalid("the relay returned invalid JSON"))
}

fn configured_base_url() -> BridgeResult<Url> {
    let value = option_env!("RUNRAIL_GITHUB_RELAY_URL").ok_or_else(|| {
        BridgeError::new(
            "GITHUB_RELAY_NOT_CONFIGURED",
            "this build has no GitHub relay endpoint configured",
        )
    })?;
    validate_base_url(value)
}

fn configured_app_slug() -> BridgeResult<&'static str> {
    let slug = option_env!("RUNRAIL_GITHUB_APP_SLUG").ok_or_else(|| {
        BridgeError::new(
            "GITHUB_RELAY_NOT_CONFIGURED",
            "this build has no GitHub App slug configured",
        )
    })?;
    if slug.is_empty()
        || slug.len() > 100
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(invalid("the configured GitHub App slug is invalid"));
    }
    Ok(slug)
}

fn validate_base_url(value: &str) -> BridgeResult<Url> {
    let mut url = Url::parse(value).map_err(|_| invalid("the GitHub relay endpoint is invalid"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "the GitHub relay endpoint must be a fixed HTTPS URL",
        ));
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    }
    Ok(url)
}

fn endpoint(base: &Url, path: &str) -> BridgeResult<Url> {
    base.join(path)
        .map_err(|_| invalid("the GitHub relay endpoint is invalid"))
}

fn validate_install_url(value: &str, state: &str, app_slug: &str) -> BridgeResult<Url> {
    let url = Url::parse(value)
        .map_err(|_| invalid("the relay returned an invalid GitHub installation URL"))?;
    let expected_path = format!("/apps/{app_slug}/installations/new");
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != expected_path
        || url.fragment().is_some()
        || url
            .query_pairs()
            .filter(|(name, value)| name == "state" && value == state)
            .count()
            != 1
        || url.query_pairs().any(|(name, _)| name != "state")
    {
        return Err(invalid(
            "the relay returned an unsafe GitHub installation URL",
        ));
    }
    Ok(url)
}

fn sensitive_bearer(token: &str) -> BridgeResult<HeaderValue> {
    let value = Zeroizing::new(format!("Bearer {token}"));
    let mut header = HeaderValue::from_str(&value)
        .map_err(|_| invalid("the relay authorization token is invalid"))?;
    header.set_sensitive(true);
    Ok(header)
}
fn validate_event(event: &RelayEvent) -> BridgeResult<()> {
    let event_kind = matches!(
        event.event.as_str(),
        "check_run.completed"
            | "workflow_run.completed"
            | "pull_request.closed"
            | "pull_request.synchronize"
    );
    let mut repository = event.repository.split('/');
    let owner = repository.next().unwrap_or("");
    let repo = repository.next().unwrap_or("");
    let valid_repository = repository.next().is_none()
        && !owner.is_empty()
        && owner.len() <= 100
        && !repo.is_empty()
        && repo.len() <= 100
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    let sha = event.head_sha.as_bytes();
    let valid_sha = (sha.len() == 40 || sha.len() == 64) && sha.iter().all(u8::is_ascii_hexdigit);
    let time = event.occurred_at.as_bytes();
    let valid_time = time.len() == 24
        && time.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 | 16 => *byte == b':',
            19 => *byte == b'.',
            23 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        });
    let valid_conclusion = event.conclusion.as_deref().is_none_or(|value| {
        value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    });
    let valid_ids =
        event.run_id.is_none_or(|run| run > 0) && event.attempt.is_none_or(|attempt| attempt > 0);
    if !event_kind
        || !valid_delivery_id(&event.delivery_id)
        || !valid_repository
        || event.pr_number == 0
        || !valid_sha
        || !valid_time
        || !valid_conclusion
        || !valid_ids
    {
        return Err(invalid("the relay event metadata is invalid"));
    }
    Ok(())
}

fn random_hex(bytes: usize) -> BridgeResult<String> {
    let mut random = vec![0_u8; bytes];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| unavailable("secure random values are unavailable"))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_installation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value != "0"
}

fn valid_delivery_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_url_is_https_and_has_no_userinfo_query_or_fragment() {
        assert!(validate_base_url("https://relay.example/").is_ok());
        for bad in [
            "http://relay.example",
            "https://user@relay.example",
            "https://relay.example:8443",
            "https://relay.example/path/",
            "https://relay.example/?token=x",
            "https://relay.example/#frag",
        ] {
            assert!(validate_base_url(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn install_url_must_be_the_exact_github_app_flow_and_carry_state_once() {
        assert!(validate_install_url(
            "https://github.com/apps/runrail/installations/new?state=abc",
            "abc",
            "runrail"
        )
        .is_ok());
        for bad in [
            "http://github.com/apps/runrail/installations/new?state=abc",
            "https://github.com.evil.example/apps/runrail/installations/new?state=abc",
            "https://evil.example/apps/runrail/installations/new?state=abc",
            "https://github.com:8443/apps/runrail/installations/new?state=abc",
            "https://github.com/apps/runrail/installations/new?state=abc#fragment",
            "https://github.com/apps/runrail/installations/new?state=other",
            "https://github.com/apps/other/installations/new?state=abc",
            "https://github.com/apps/runrail/installations/new?state=abc&next=https://evil.example",
        ] {
            assert!(
                validate_install_url(bad, "abc", "runrail").is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn relay_events_are_allowlisted_and_bound_before_renderer_delivery() {
        let event = RelayEvent {
            delivery_id: "123e4567-e89b-12d3-a456-426614174000".into(),
            event: "workflow_run.completed".into(),
            repository: "octo/project".into(),
            pr_number: 12,
            head_sha: "a".repeat(40),
            run_id: Some(42),
            attempt: Some(1),
            conclusion: Some("failure".into()),
            occurred_at: "2026-11-01T12:00:00.000Z".into(),
        };
        assert!(validate_event(&event).is_ok());
        assert!(validate_event(&RelayEvent {
            head_sha: "bad".into(),
            ..event.clone()
        })
        .is_err());
        assert!(validate_event(&RelayEvent {
            event: "installation.deleted".into(),
            ..event.clone()
        })
        .is_err());
        assert!(validate_event(&RelayEvent {
            repository: "https://evil.test/o/r".into(),
            ..event
        })
        .is_err());
    }

    #[test]
    fn bearer_material_is_never_part_of_status_or_errors() {
        let token = "a".repeat(64);
        let status = RelayStatus {
            state: "paired",
            installation_id: Some("1234".into()),
            message: None,
        };
        assert!(!serde_json::to_string(&status).unwrap().contains(&token));
        assert!(valid_token(&token));
        assert!(!valid_token("secret"));
        assert!(sensitive_bearer(&token).unwrap().is_sensitive());
    }
}
