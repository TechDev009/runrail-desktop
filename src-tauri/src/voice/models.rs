//! Whisper models for transcription on this computer. The list, addresses, sizes, and SHA-256 sums
//! are fixed here, pinned to one revision of ggerganov/whisper.cpp on Hugging Face; the renderer
//! names a model by id only. A download lands in a `.part` file and is renamed into place only
//! once its size and SHA-256 match, so a model on disk is always a checked one.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::{BridgeError, BridgeResult};

pub type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

pub struct Model {
    pub id: &'static str,
    pub file: &'static str,
    pub label: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub english_only: bool,
}

pub const MODELS: [Model; 7] = [
    Model { id: "tiny.en", file: "ggml-tiny.en-q5_1.bin", label: "Tiny (English)", size: 32_166_155, sha256: "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b", english_only: true },
    Model { id: "tiny", file: "ggml-tiny-q5_1.bin", label: "Tiny", size: 32_152_673, sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7", english_only: false },
    Model { id: "base.en", file: "ggml-base.en-q5_1.bin", label: "Base (English)", size: 59_721_011, sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f", english_only: true },
    Model { id: "base", file: "ggml-base-q5_1.bin", label: "Base", size: 59_707_625, sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898", english_only: false },
    Model { id: "small.en", file: "ggml-small.en-q5_1.bin", label: "Small (English)", size: 190_098_681, sha256: "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30", english_only: true },
    Model { id: "small", file: "ggml-small-q5_1.bin", label: "Small", size: 190_085_487, sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", english_only: false },
    Model { id: "large-v3-turbo", file: "ggml-large-v3-turbo-q5_0.bin", label: "Large v3 Turbo", size: 574_041_195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", english_only: false },
];

pub fn find(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.id == id)
}

fn url(model: &Model) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/{}", model.file)
}

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("voice").join("models")
}

pub fn path(app_data: &Path, model: &Model) -> PathBuf {
    dir(app_data).join(model.file)
}

/// Present at its full size. Only a checked download is ever renamed to this name.
pub fn installed(app_data: &Path, model: &Model) -> bool {
    fs::symlink_metadata(path(app_data, model)).is_ok_and(|meta| meta.is_file() && meta.len() == model.size)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub id: &'static str,
    pub label: &'static str,
    pub size: u64,
    pub english_only: bool,
    pub installed: bool,
    pub downloading: bool,
}

struct Download {
    id: &'static str,
    child: Child,
}

static ACTIVE: Mutex<Option<Download>> = Mutex::new(None);

fn downloading() -> Option<&'static str> {
    ACTIVE.lock().ok().and_then(|active| active.as_ref().map(|download| download.id))
}

pub fn list(app_data: &Path) -> Vec<ModelState> {
    let active = downloading();
    MODELS
        .iter()
        .map(|model| ModelState { id: model.id, label: model.label, size: model.size, english_only: model.english_only, installed: installed(app_data, model), downloading: active == Some(model.id) })
        .collect()
}

fn sha256(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Checks a finished `.part` file and moves it into place, or removes it.
fn settle(part: &Path, target: &Path, model: &Model) -> BridgeResult<()> {
    let size = fs::metadata(part).map(|meta| meta.len()).unwrap_or(0);
    let digest = if size == model.size { sha256(part).ok() } else { None };
    if digest.as_deref() != Some(model.sha256) {
        let _ = fs::remove_file(part);
        return Err(BridgeError::new("VOICE_MODEL_CHECK", "the downloaded model did not match its checksum and was removed"));
    }
    fs::rename(part, target).map_err(|_| BridgeError::new("VOICE_MODEL_WRITE", "could not save the model"))
}

/// https only, at most `size` bytes, into `part`: macOS's own curl. On Linux, curl wherever it
/// is, or wget, which a desktop may ship instead.
fn downloader(part: &Path, address: &str, size: u64) -> BridgeResult<Command> {
    let curl = |program: &Path| {
        let mut command = Command::new(program);
        command
            .args(["--fail", "--silent", "--location", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--retry", "2", "--max-time", "7200"])
            .arg("--max-filesize")
            .arg(size.to_string())
            .arg("--output")
            .arg(part)
            .arg(address);
        command
    };
    #[cfg(target_os = "macos")]
    return Ok(curl(Path::new("/usr/bin/curl")));
    #[cfg(not(target_os = "macos"))]
    {
        let find = |name: &str| crate::engine::find_on_path(name).or_else(|| ["/usr/bin", "/bin", "/usr/local/bin"].iter().map(|dir| Path::new(dir).join(name)).find(|path| path.is_file()));
        if let Some(program) = find("curl") {
            return Ok(curl(&program));
        }
        let program = find("wget").ok_or_else(|| BridgeError::new("VOICE_MODEL_DOWNLOAD", "downloading a model needs curl or wget; install one, then try again"))?;
        let mut command = Command::new(program);
        command.args(["--quiet", "--https-only", "--secure-protocol=TLSv1_2", "--max-redirect=5", "--tries=3", "--timeout=60", "--output-document"]).arg(part).arg(address);
        Ok(command)
    }
}

/// Starts one download at a time, https only, into a `.part` file. Progress, the check, and the
/// outcome arrive as `voice:model` events.
pub fn download(app_data: &Path, id: &str, emit: Emit) -> BridgeResult<()> {
    let model = find(id).ok_or_else(|| BridgeError::new("VOICE_MODEL_UNKNOWN", "no such model"))?;
    // Held from the check to the start: a download stays active until its file is checked and in
    // place, so a second one never deletes the first one's file mid-check.
    let mut active = ACTIVE.lock().map_err(|_| BridgeError::new("VOICE_MODEL_BUSY", "a download is running"))?;
    if installed(app_data, model) {
        return Ok(());
    }
    if active.is_some() {
        return Err(BridgeError::new("VOICE_MODEL_BUSY", "another model is downloading"));
    }
    let folder = dir(app_data);
    fs::create_dir_all(&folder).map_err(|_| BridgeError::new("VOICE_MODEL_WRITE", "could not create the models folder"))?;
    let part = folder.join(format!("{}.part", model.file));
    let target = path(app_data, model);
    let _ = fs::remove_file(&part);
    let child = downloader(&part, &url(model), model.size)?
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| BridgeError::new("VOICE_MODEL_DOWNLOAD", "could not start the download"))?;
    let pid = child.id();
    *active = Some(Download { id: model.id, child });
    drop(active);
    let id = model.id;
    thread::spawn(move || {
        let outcome = loop {
            thread::sleep(Duration::from_millis(250));
            let received = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
            let mut active = match ACTIVE.lock() {
                Ok(active) => active,
                Err(_) => break Err(None),
            };
            let Some(download) = active.as_mut().filter(|download| download.child.id() == pid) else {
                break Err(Some("cancelled"));
            };
            // wget has no size limit of its own.
            if received > model.size {
                let _ = download.child.kill();
            }
            match download.child.try_wait() {
                Ok(None) => {
                    drop(active);
                    emit("voice:model", json!({ "id": id, "state": "downloading", "received": received, "total": model.size }));
                }
                Ok(Some(exit)) => break if exit.success() { Ok(()) } else { Err(None) },
                Err(_) => {
                    *active = None;
                    break Err(None);
                }
            }
        };
        let settled = match outcome {
            Ok(()) => {
                emit("voice:model", json!({ "id": id, "state": "verifying" }));
                Some(settle(&part, &target, model))
            }
            Err(Some(_)) => {
                let _ = fs::remove_file(&part);
                None
            }
            Err(None) => {
                let _ = fs::remove_file(&part);
                Some(Err(BridgeError::new("VOICE_MODEL_DOWNLOAD", "the download did not finish")))
            }
        };
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().is_some_and(|download| download.child.id() == pid) {
                *active = None;
            }
        }
        match settled {
            Some(Ok(())) => emit("voice:model", json!({ "id": id, "state": "done" })),
            Some(Err(error)) => emit("voice:model", json!({ "id": id, "state": "failed", "code": error.code, "message": error.message })),
            None => emit("voice:model", json!({ "id": id, "state": "cancelled" })),
        }
    });
    Ok(())
}

pub fn cancel(id: &str) {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(mut download) = active.take_if(|download| download.id == id) {
            let _ = download.child.kill();
            let _ = download.child.wait();
        }
    }
}

pub fn remove(app_data: &Path, id: &str) -> BridgeResult<()> {
    let model = find(id).ok_or_else(|| BridgeError::new("VOICE_MODEL_UNKNOWN", "no such model"))?;
    cancel(id);
    super::whisper::forget(model.id);
    match fs::remove_file(path(app_data, model)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(BridgeError::new("VOICE_MODEL_WRITE", "could not remove the model")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_pinned_with_a_size_and_checksum() {
        for model in &MODELS {
            assert!(url(model).starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c"));
            assert_eq!(model.sha256.len(), 64);
            assert!(model.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(model.size > 30_000_000);
            assert_eq!(model.english_only, model.id.ends_with(".en"));
        }
        assert!(find("../../etc/passwd").is_none());
    }

    #[test]
    fn a_download_is_kept_only_when_size_and_checksum_match() {
        let root = std::env::temp_dir().join(format!("runrail-voice-models-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let model = Model { id: "t", file: "t.bin", label: "t", size: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", english_only: false };
        let part = root.join("t.bin.part");
        let target = root.join("t.bin");
        fs::write(&part, "hellp").unwrap();
        assert_eq!(settle(&part, &target, &model).unwrap_err().code, "VOICE_MODEL_CHECK");
        assert!(!part.exists() && !target.exists());
        fs::write(&part, "hello").unwrap();
        settle(&part, &target, &model).unwrap();
        assert!(target.exists() && !part.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
