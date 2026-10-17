//! Saved browser sign-ins: for a project the person opted in, the cookies its
//! browser previews collect are kept in one file per project, sealed with AES-256-GCM under a key
//! that lives in the macOS Keychain, or on Linux in the Secret Service (GNOME Keyring, KWallet,
//! KeePassXC), and handed to the next preview of that project before its first page loads.
//! Previews stay private otherwise. Settings forgets a project's file. With no Secret Service the
//! key would have to sit beside the cookies, so saved sign-ins stay off.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::webview::cookie::{time::OffsetDateTime, Cookie, Expiration, SameSite};

use crate::error::{BridgeError, BridgeResult};
use crate::store;
use crate::workspace::valid_id;

const FOLDER: &str = "browser-sign-ins";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const MAX_COOKIES: usize = 2_000;
const MAX_FILE: usize = 4 * 1024 * 1024;
const MAX_FIELD: usize = 8 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    /// Seconds since 1970; none for a cookie that lasts the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
}

/// What makes two cookies the same cookie.
pub type Key = (String, String, String);

impl Saved {
    pub fn key(&self) -> Key {
        (self.name.clone(), self.domain.to_ascii_lowercase(), self.path.clone())
    }

    fn expired(&self, now: i64) -> bool {
        self.expires.is_some_and(|expires| expires <= now)
    }

    /// WebKit refuses (and wry then panics on) a cookie without a name, domain, or path.
    fn usable(&self) -> bool {
        !self.name.is_empty()
            && !self.domain.is_empty()
            && !self.path.is_empty()
            && [&self.name, &self.value, &self.domain, &self.path].iter().all(|field| field.len() <= MAX_FIELD && !field.chars().any(char::is_control))
    }

    pub fn from_cookie(cookie: &Cookie<'_>) -> Option<Self> {
        let saved = Saved {
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
            domain: cookie.domain()?.to_string(),
            path: cookie.path().unwrap_or("/").to_string(),
            secure: cookie.secure().unwrap_or(false),
            http_only: cookie.http_only().unwrap_or(false),
            same_site: cookie.same_site().map(|same| match same {
                SameSite::Strict => "strict".to_string(),
                SameSite::Lax => "lax".to_string(),
                SameSite::None => "none".to_string(),
            }),
            expires: cookie.expires_datetime().map(OffsetDateTime::unix_timestamp),
        };
        saved.usable().then_some(saved)
    }

    pub fn to_cookie(&self) -> Option<Cookie<'static>> {
        if !self.usable() {
            return None;
        }
        let mut builder = Cookie::build((self.name.clone(), self.value.clone())).domain(self.domain.clone()).path(self.path.clone()).secure(self.secure).http_only(self.http_only);
        builder = match self.same_site.as_deref() {
            Some("strict") => builder.same_site(SameSite::Strict),
            Some("lax") => builder.same_site(SameSite::Lax),
            _ => builder,
        };
        if let Some(expires) = self.expires {
            builder = builder.expires(Expiration::DateTime(OffsetDateTime::from_unix_timestamp(expires).ok()?));
        }
        Some(builder.build())
    }
}

/// What a preview saves: what it has now, and what the file has that it never knew (another
/// preview of the project signed in there). A cookie it started with and has lost was signed out.
pub fn merge(file: &[Saved], seeded: &HashSet<Key>, current: &[Saved], now: i64) -> Vec<Saved> {
    let mut merged: Vec<Saved> = current.iter().filter(|cookie| !cookie.expired(now)).cloned().collect();
    let have: HashSet<Key> = merged.iter().map(Saved::key).collect();
    merged.extend(file.iter().filter(|cookie| !cookie.expired(now) && !have.contains(&cookie.key()) && !seeded.contains(&cookie.key())).cloned());
    merged.truncate(MAX_COOKIES);
    merged
}

// ---------------------------------------------------------------------------------------------
// Sealing

fn aad(project: &str) -> Vec<u8> {
    format!("runrail-browser-sign-ins:{project}").into_bytes()
}

fn crypto_failed() -> BridgeError {
    BridgeError::new("SIGN_INS_FAILED", "the saved sign-ins could not be sealed")
}

pub fn seal(key: &[u8; 32], project: &str, plain: &[u8]) -> BridgeResult<Vec<u8>> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use ring::rand::{SecureRandom, SystemRandom};
    let sealing = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| crypto_failed())?);
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| crypto_failed())?;
    let mut data = plain.to_vec();
    sealing.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad(project)), &mut data).map_err(|_| crypto_failed())?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + data.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&data);
    Ok(out)
}

/// None for a file that is not ours, was sealed for another project, or was changed.
pub fn unseal(key: &[u8; 32], project: &str, sealed: &[u8]) -> Option<Vec<u8>> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    if sealed.len() < 1 + NONCE_LEN + 16 || sealed[0] != VERSION {
        return None;
    }
    let opening = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).ok()?);
    let nonce = Nonce::try_assume_unique_for_key(&sealed[1..1 + NONCE_LEN]).ok()?;
    let mut data = sealed[1 + NONCE_LEN..].to_vec();
    let plain = opening.open_in_place(nonce, Aad::from(aad(project)), &mut data).ok()?;
    Some(plain.to_vec())
}

// ---------------------------------------------------------------------------------------------
// The key and the files

static FOLDER_PATH: OnceLock<PathBuf> = OnceLock::new();
#[cfg(any(target_os = "macos", target_os = "linux"))]
static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);
/// One reader or writer of the files at a time.
static FILES: Mutex<()> = Mutex::new(());

pub fn init(app_data: &Path) {
    let _ = FOLDER_PATH.set(app_data.join(FOLDER));
}

fn file_of(project: &str) -> BridgeResult<PathBuf> {
    if !valid_id(project) {
        return Err(BridgeError::new("CONTROL_INVALID_INPUT", "the project is invalid"));
    }
    let folder = FOLDER_PATH.get().ok_or_else(|| BridgeError::new("SIGN_INS_FAILED", "the saved sign-ins are not available"))?;
    Ok(folder.join(format!("{project}.bin")))
}

#[cfg(target_os = "macos")]
fn key(identifier: &str) -> BridgeResult<[u8; 32]> {
    use ring::rand::{SecureRandom, SystemRandom};
    use security_framework::passwords::{get_generic_password, set_generic_password};
    let mut cached = KEY.lock().map_err(|_| crypto_failed())?;
    if let Some(key) = *cached {
        return Ok(key);
    }
    let service = format!("{identifier}.browser-sign-ins");
    let key = match get_generic_password(&service, "key").ok().and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok()) {
        Some(key) => key,
        None => {
            let mut key = [0u8; 32];
            SystemRandom::new().fill(&mut key).map_err(|_| crypto_failed())?;
            set_generic_password(&service, "key", &key).map_err(|_| BridgeError::new("SIGN_INS_FAILED", "the key for saved sign-ins could not be kept in the Keychain"))?;
            key
        }
    };
    *cached = Some(key);
    Ok(key)
}

/// A key that cannot be read (a locked keyring the person did not unlock) is never replaced: a new
/// one would leave every saved file unreadable.
#[cfg(target_os = "linux")]
fn key(identifier: &str) -> BridgeResult<[u8; 32]> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut cached = KEY.lock().map_err(|_| crypto_failed())?;
    if let Some(key) = *cached {
        return Ok(key);
    }
    let unreadable = || BridgeError::new("SIGN_INS_FAILED", "the key for saved sign-ins could not be read from the keyring");
    support().map_err(|reason| BridgeError::new("SIGN_INS_UNSUPPORTED", reason).with_status(501))?;
    let entry = keyring::Entry::new(&format!("{identifier}.browser-sign-ins"), "key").map_err(|_| unreadable())?;
    let key = match entry.get_secret() {
        Ok(bytes) => <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| unreadable())?,
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            SystemRandom::new().fill(&mut key).map_err(|_| crypto_failed())?;
            entry.set_secret(&key).map_err(|_| BridgeError::new("SIGN_INS_FAILED", "the key for saved sign-ins could not be kept in the keyring"))?;
            key
        }
        Err(_) => return Err(unreadable()),
    };
    *cached = Some(key);
    Ok(key)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn key(_identifier: &str) -> BridgeResult<[u8; 32]> {
    Err(BridgeError::new("SIGN_INS_UNSUPPORTED", "saved sign-ins work on macOS and Linux only").with_status(501))
}

/// Whether sign-ins can be saved here, or why not. The Secret Service is looked for once per
/// launch, the first time a key is needed or this is asked.
pub fn support() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if keyring::Entry::store_status().is_err() {
        return Err("Saved sign-ins need a keyring that offers the Secret Service, such as GNOME Keyring, KWallet or KeePassXC. Start one, then reopen Runrail.".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err("Saved sign-ins work on macOS and Linux only.".into());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Ok(())
}

/// The project's saved cookies; none when there is no file or it cannot be opened.
pub fn load(identifier: &str, project: &str) -> Vec<Saved> {
    let Ok(file) = file_of(project) else { return Vec::new() };
    let _files = FILES.lock();
    let Ok(sealed) = std::fs::read(&file) else { return Vec::new() };
    if sealed.len() > MAX_FILE {
        return Vec::new();
    }
    let Ok(key) = key(identifier) else { return Vec::new() };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    unseal(&key, project, &sealed)
        .and_then(|plain| serde_json::from_slice::<Vec<Saved>>(&plain).ok())
        .map(|cookies| cookies.into_iter().filter(|cookie| cookie.usable() && !cookie.expired(now)).take(MAX_COOKIES).collect())
        .unwrap_or_default()
}

/// Saves what a preview has, merged with what other previews of the project saved meanwhile.
pub fn save(identifier: &str, project: &str, seeded: &HashSet<Key>, current: &[Saved]) -> BridgeResult<()> {
    let file = file_of(project)?;
    let existing = load(identifier, project);
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let merged = merge(&existing, seeded, current, now);
    let key = key(identifier)?;
    let plain = serde_json::to_vec(&merged).map_err(|_| crypto_failed())?;
    let sealed = seal(&key, project, &plain)?;
    let _files = FILES.lock();
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder).map_err(|_| BridgeError::new("SIGN_INS_FAILED", "the saved sign-ins could not be written"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700));
        }
    }
    store::write_atomic(&file, &sealed)
}

/// Forgets a project's saved sign-ins. Pages open now keep theirs until they close.
pub fn forget(project: &str) -> BridgeResult<()> {
    let file = file_of(project)?;
    let _files = FILES.lock();
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(BridgeError::new("SIGN_INS_FAILED", "the saved sign-ins could not be removed")),
    }
}

pub fn saved(project: &str) -> BridgeResult<bool> {
    Ok(file_of(project)?.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, domain: &str, expires: Option<i64>) -> Saved {
        Saved { name: name.into(), value: "v".into(), domain: domain.into(), path: "/".into(), secure: true, http_only: true, same_site: Some("lax".into()), expires }
    }

    #[test]
    fn a_sealed_file_opens_only_for_its_project_and_key() {
        let key = [7u8; 32];
        let sealed = seal(&key, "p1", b"[]").unwrap();
        assert_eq!(sealed[0], VERSION);
        assert_eq!(unseal(&key, "p1", &sealed).as_deref(), Some(&b"[]"[..]));
        assert_eq!(unseal(&key, "p2", &sealed), None);
        assert_eq!(unseal(&[8u8; 32], "p1", &sealed), None);
        let mut changed = sealed.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert_eq!(unseal(&key, "p1", &changed), None);
        // Two seals of the same text differ: each has its own nonce.
        assert_ne!(seal(&key, "p1", b"[]").unwrap(), sealed);
        assert!(!String::from_utf8_lossy(&seal(&key, "p1", b"session=secret-token").unwrap()).contains("secret-token"));
    }

    #[test]
    fn saving_keeps_new_sign_ins_and_drops_sign_outs() {
        let now = 1_000;
        let file = vec![cookie("a", "app.test", None), cookie("b", "other.test", None), cookie("old", "app.test", Some(10))];
        // This preview started with a and b, signed out of b, and signed in to c.
        let seeded: HashSet<Key> = [cookie("a", "app.test", None).key(), cookie("b", "other.test", None).key()].into_iter().collect();
        let current = vec![cookie("a", "app.test", None), cookie("c", "new.test", Some(2_000))];
        let names: Vec<String> = merge(&file, &seeded, &current, now).into_iter().map(|cookie| cookie.name).collect();
        assert_eq!(names, vec!["a", "c"]);
        // Another preview's sign-in, which this one never knew, is kept.
        let file = vec![cookie("d", "elsewhere.test", None)];
        let names: Vec<String> = merge(&file, &seeded, &current, now).into_iter().map(|cookie| cookie.name).collect();
        assert_eq!(names, vec!["a", "c", "d"]);
    }

    #[test]
    fn cookies_round_trip_and_unusable_ones_are_left_out() {
        let saved = cookie("session", "localhost", Some(4_102_444_800));
        let back = Saved::from_cookie(&saved.to_cookie().unwrap()).unwrap();
        assert_eq!(back, saved);
        assert!(cookie("", "localhost", None).to_cookie().is_none());
        assert!(cookie("a", "", None).to_cookie().is_none());
        assert!(Saved { path: String::new(), ..cookie("a", "x", None) }.to_cookie().is_none());
        assert!(Saved { value: "a\nb".into(), ..cookie("a", "x", None) }.to_cookie().is_none());
        // A cookie WebKit returns without a domain is not kept.
        assert!(Saved::from_cookie(&Cookie::new("a", "b")).is_none());
    }
}
