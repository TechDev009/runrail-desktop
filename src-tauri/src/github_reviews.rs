//! Read bounded GitHub review-thread snapshots through the locally authenticated `gh` CLI.

use crate::error::{BridgeError, BridgeResult};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const GH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_THREADS: usize = 100;
const MAX_COMMENTS: usize = 100;
const MAX_TEXT_BYTES: usize = 20_000;
const MAX_PATH_BYTES: usize = 1_024;
const MAX_ID_BYTES: usize = 256;
const MAX_AUTHOR_BYTES: usize = 64;
const MAX_PR_NUMBER: u64 = i32::MAX as u64;

const GRAPHQL_QUERY: &str = r#"query ReviewThreads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100) {
        nodes {
          id
          path
          line
          originalLine
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              body
              author { login }
              commit { oid }
              originalCommit { oid }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}"#;

/// Reads review threads for a GitHub.com pull request. The CLI uses its existing local auth.
pub(crate) fn review_threads(owner: &str, repo: &str, number: u64) -> BridgeResult<Value> {
    review_threads_with(
        owner,
        repo,
        number,
        || crate::engine::find_on_path("gh"),
        run_gh,
    )
}

fn review_threads_with(
    owner: &str,
    repo: &str,
    number: u64,
    find_gh: impl FnOnce() -> Option<PathBuf>,
    runner: impl FnOnce(Command) -> BridgeResult<Vec<u8>>,
) -> BridgeResult<Value> {
    validate_reference(owner, repo, number)?;
    let gh = find_gh()
        .ok_or_else(|| BridgeError::new("GITHUB_CLI_MISSING", "GitHub CLI is unavailable"))?;
    request_with_runner(&gh, owner, repo, number, runner)
}

fn request_with_runner(
    gh: &Path,
    owner: &str,
    repo: &str,
    number: u64,
    runner: impl FnOnce(Command) -> BridgeResult<Vec<u8>>,
) -> BridgeResult<Value> {
    let mut command = Command::new(gh);
    command
        // Do not allow a configured enterprise host (or GH_HOST) to redirect this adapter.
        .env("GH_HOST", "github.com")
        .args(["api", "graphql", "-f"])
        .arg(format!("query={GRAPHQL_QUERY}"))
        .arg("-F")
        .arg(format!("owner={owner}"))
        .arg("-F")
        .arg(format!("repo={repo}"))
        .arg("-F")
        .arg(format!("number={number}"));

    let stdout = runner(command)?;
    if stdout.len() > MAX_STDOUT_BYTES {
        return Err(invalid_response());
    }
    map_response(&stdout, owner, repo, number)
}

fn run_gh(command: Command) -> BridgeResult<Vec<u8>> {
    let ran = crate::process::run(command, None, GH_TIMEOUT).map_err(|_| {
        BridgeError::new(
            "GITHUB_UNAVAILABLE",
            "GitHub CLI could not complete the request",
        )
    })?;
    if !ran.ok {
        // Never expose stderr: gh output can contain private repository details or credentials.
        return Err(BridgeError::new(
            "GITHUB_REQUEST_FAILED",
            "GitHub could not return review feedback",
        ));
    }
    Ok(ran.stdout)
}

fn validate_reference(owner: &str, repo: &str, number: u64) -> BridgeResult<()> {
    let owner_valid = !owner.is_empty()
        && owner.len() <= 100
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let repo_valid = !repo.is_empty()
        && repo.len() <= 100
        && repo != "."
        && repo != ".."
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if !owner_valid || !repo_valid || number == 0 || number > MAX_PR_NUMBER {
        return Err(BridgeError::new(
            "CONTROL_INVALID_INPUT",
            "GitHub pull request reference is invalid",
        ));
    }
    Ok(())
}

fn map_response(bytes: &[u8], owner: &str, repo: &str, number: u64) -> BridgeResult<Value> {
    let response: Value = serde_json::from_slice(bytes).map_err(|_| invalid_response())?;
    match response.get("errors") {
        None => {}
        Some(Value::Array(errors)) if errors.is_empty() => {}
        Some(Value::Array(_)) => {
            return Err(BridgeError::new(
                "GITHUB_REQUEST_FAILED",
                "GitHub could not return review feedback",
            ));
        }
        Some(_) => return Err(invalid_response()),
    }

    let data = object_field(&response, "data")?;
    let repository = object_field(data, "repository")?;
    if repository.is_null() {
        return Err(pull_request_unavailable());
    }
    let pull_request = object_field(repository, "pullRequest")?;
    if pull_request.is_null() {
        return Err(pull_request_unavailable());
    }

    let head_commit = required_string(pull_request, "headRefOid", 40, false)?;
    if !valid_sha(head_commit) {
        return Err(invalid_response());
    }
    let review_threads = required_field(pull_request, "reviewThreads")?;
    let thread_nodes = connection_nodes(review_threads, MAX_THREADS)?;
    reject_unfetched_page(review_threads)?;

    let mut threads = Vec::with_capacity(thread_nodes.len());
    for thread in thread_nodes {
        threads.push(map_thread(thread)?);
    }

    Ok(json!({
        "owner": owner,
        "repo": repo,
        "number": number,
        "headCommit": head_commit,
        "threads": threads,
    }))
}

fn map_thread(thread: &Value) -> BridgeResult<Value> {
    let id = required_string(thread, "id", MAX_ID_BYTES, false)?;
    let path = required_string(thread, "path", MAX_PATH_BYTES, false)?;
    let line = optional_line(thread, "line")?;
    let original_line = optional_line(thread, "originalLine")?;
    let is_resolved = required_bool(thread, "isResolved")?;
    let is_outdated = required_bool(thread, "isOutdated")?;

    let comments_connection = required_field(thread, "comments")?;
    let comment_nodes = connection_nodes(comments_connection, MAX_COMMENTS)?;
    reject_unfetched_page(comments_connection)?;
    let comments = comment_nodes
        .iter()
        .map(map_comment)
        .collect::<BridgeResult<Vec<_>>>()?;

    let mut mapped = Map::new();
    mapped.insert("id".into(), json!(id));
    mapped.insert("path".into(), json!(path));
    if let Some(line) = line {
        mapped.insert("line".into(), json!(line));
    }
    if let Some(line) = original_line {
        mapped.insert("originalLine".into(), json!(line));
    }
    mapped.insert("isResolved".into(), json!(is_resolved));
    mapped.insert("isOutdated".into(), json!(is_outdated));
    mapped.insert("comments".into(), json!(comments));
    Ok(Value::Object(mapped))
}

fn map_comment(comment: &Value) -> BridgeResult<Value> {
    let id = required_string(comment, "id", MAX_ID_BYTES, false)?;
    let body = required_string(comment, "body", MAX_TEXT_BYTES, true)?;
    let author = match comment.get("author") {
        None | Some(Value::Null) => None,
        Some(value) => Some(required_string(value, "login", MAX_AUTHOR_BYTES, true)?),
    };
    let commit = optional_commit(comment, "commit")?;
    let original_commit = optional_commit(comment, "originalCommit")?;

    let mut mapped = Map::new();
    mapped.insert("id".into(), json!(id));
    mapped.insert("body".into(), json!(body));
    if let Some(author) = author {
        mapped.insert("author".into(), json!(author));
    }
    if let Some(commit) = commit {
        mapped.insert("commit".into(), json!(commit));
    }
    if let Some(original_commit) = original_commit {
        mapped.insert("originalCommit".into(), json!(original_commit));
    }
    Ok(Value::Object(mapped))
}

fn optional_commit<'a>(value: &'a Value, key: &str) -> BridgeResult<Option<&'a str>> {
    let commit = match value.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(commit) => commit,
    };
    let oid = required_string(commit, "oid", 40, false)?;
    if !valid_sha(oid) {
        return Err(invalid_response());
    }
    Ok(Some(oid))
}

fn valid_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn optional_line(value: &Value, key: &str) -> BridgeResult<Option<u64>> {
    match required_field(value, key)? {
        Value::Null => Ok(None),
        line => match line.as_u64() {
            Some(line) if (1..=MAX_PR_NUMBER).contains(&line) => Ok(Some(line)),
            _ => Err(invalid_response()),
        },
    }
}

fn required_bool(value: &Value, key: &str) -> BridgeResult<bool> {
    required_field(value, key)?
        .as_bool()
        .ok_or_else(invalid_response)
}

fn connection_nodes(connection: &Value, max: usize) -> BridgeResult<&[Value]> {
    let nodes = required_field(connection, "nodes")?
        .as_array()
        .ok_or_else(invalid_response)?;
    if nodes.len() > max {
        return Err(review_limit_exceeded());
    }
    Ok(nodes)
}

fn reject_unfetched_page(connection: &Value) -> BridgeResult<()> {
    let page_info = object_field(connection, "pageInfo")?;
    match page_info.get("hasNextPage").and_then(Value::as_bool) {
        Some(false) => Ok(()),
        Some(true) => Err(review_limit_exceeded()),
        None => Err(invalid_response()),
    }
}

fn object_field<'a>(value: &'a Value, key: &str) -> BridgeResult<&'a Value> {
    let field = required_field(value, key)?;
    if !field.is_object() && !field.is_null() {
        return Err(invalid_response());
    }
    Ok(field)
}

fn required_field<'a>(value: &'a Value, key: &str) -> BridgeResult<&'a Value> {
    value.get(key).ok_or_else(invalid_response)
}

fn required_string<'a>(
    value: &'a Value,
    key: &str,
    max: usize,
    allow_empty: bool,
) -> BridgeResult<&'a str> {
    let text = required_field(value, key)?
        .as_str()
        .ok_or_else(invalid_response)?;
    if (!allow_empty && text.is_empty()) || text.len() > max {
        return Err(invalid_response());
    }
    Ok(text)
}

fn invalid_response() -> BridgeError {
    BridgeError::new(
        "GITHUB_INVALID_RESPONSE",
        "GitHub returned invalid review feedback",
    )
}

fn pull_request_unavailable() -> BridgeError {
    BridgeError::new(
        "GITHUB_PULL_REQUEST_UNAVAILABLE",
        "GitHub pull request could not be found",
    )
}

fn review_limit_exceeded() -> BridgeError {
    BridgeError::new(
        "GITHUB_REVIEW_LIMIT",
        "Review feedback exceeds the supported limit",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMMENT_COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn payload() -> Vec<u8> {
        json!({
            "data": {
                "repository": {
                    "pullRequest": {
                        "headRefOid": HEAD,
                        "reviewThreads": {
                            "nodes": [{
                                "id": "thread-1",
                                "path": "src/lib.rs",
                                "line": 12,
                                "originalLine": 10,
                                "isResolved": false,
                                "isOutdated": false,
                                "comments": {
                                    "nodes": [{
                                        "id": "comment-1",
                                        "body": "Please adjust this.",
                                        "author": { "login": "reviewer" },
                                        "commit": { "oid": COMMENT_COMMIT },
                                        "originalCommit": null
                                    }],
                                    "pageInfo": { "hasNextPage": false }
                                }
                            }],
                            "pageInfo": { "hasNextPage": false }
                        }
                    }
                }
            }
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn builds_github_com_request_and_maps_threads_without_spawning_a_process() {
        let mut called = false;
        let result = review_threads_with(
            "octo-org",
            "web_app",
            42,
            || Some(PathBuf::from("test-gh")),
            |command| {
                called = true;
                assert_eq!(command.get_program(), "test-gh");
                let args = command
                    .get_args()
                    .map(|arg| arg.to_str().expect("UTF-8 argument"))
                    .collect::<Vec<_>>();
                assert_eq!(&args[..3], &["api", "graphql", "-f"]);
                assert!(args[3].starts_with("query=query ReviewThreads"));
                assert!(args.windows(2).any(|pair| pair == ["-F", "owner=octo-org"]));
                assert!(args.windows(2).any(|pair| pair == ["-F", "repo=web_app"]));
                assert!(args.windows(2).any(|pair| pair == ["-F", "number=42"]));
                assert!(command
                    .get_envs()
                    .any(|(key, value)| key == "GH_HOST" && value == Some("github.com".as_ref())));
                Ok(payload())
            },
        )
        .expect("review snapshot");

        assert!(called);
        assert_eq!(result["owner"], "octo-org");
        assert_eq!(result["repo"], "web_app");
        assert_eq!(result["number"], 42);
        assert_eq!(result["headCommit"], HEAD);
        assert_eq!(result["threads"][0]["line"], 12);
        assert_eq!(result["threads"][0]["comments"][0]["author"], "reviewer");
        assert_eq!(
            result["threads"][0]["comments"][0]["commit"],
            COMMENT_COMMIT
        );
        assert!(result["threads"][0]["comments"][0]
            .get("originalCommit")
            .is_none());
    }

    #[test]
    fn invalid_reference_never_looks_up_or_runs_gh() {
        let result = review_threads_with(
            "octo/org",
            "web",
            42,
            || panic!("invalid input must be rejected before looking up gh"),
            |_| panic!("invalid input must not run gh"),
        );
        assert_eq!(result.unwrap_err().code, "CONTROL_INVALID_INPUT");
    }

    #[test]
    fn malformed_output_and_unfetched_pages_are_safe_errors() {
        let malformed = map_response(b"not json", "octo", "web", 1).unwrap_err();
        assert_eq!(malformed.code, "GITHUB_INVALID_RESPONSE");
        assert!(!malformed.message.contains("not json"));

        let mut response: Value = serde_json::from_slice(&payload()).unwrap();
        response["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"]["hasNextPage"] =
            json!(true);
        let truncated =
            map_response(&serde_json::to_vec(&response).unwrap(), "octo", "web", 1).unwrap_err();
        assert_eq!(truncated.code, "GITHUB_REVIEW_LIMIT");
    }

    #[test]
    fn stdout_and_sha_are_bounded_and_validated() {
        let oversized = vec![b' '; MAX_STDOUT_BYTES + 1];
        let err = request_with_runner(Path::new("test-gh"), "octo", "web", 1, |_| Ok(oversized))
            .unwrap_err();
        assert_eq!(err.code, "GITHUB_INVALID_RESPONSE");

        let mut response: Value = serde_json::from_slice(&payload()).unwrap();
        response["data"]["repository"]["pullRequest"]["headRefOid"] = json!("short");
        let err =
            map_response(&serde_json::to_vec(&response).unwrap(), "octo", "web", 1).unwrap_err();
        assert_eq!(err.code, "GITHUB_INVALID_RESPONSE");
    }
}
