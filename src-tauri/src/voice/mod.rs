//! Voice input on the host: one listening session at a time, from the chosen microphone, to
//! Apple's recognizer (macOS only) or to Whisper on this computer. Text goes to the window as
//! `voice:event` events; audio is held in memory only for the session and never written or logged.

#[cfg(target_os = "macos")]
mod access;
#[cfg(target_os = "macos")]
mod apple;
mod capture;
pub mod models;
mod whisper;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;

use crate::error::{BridgeError, BridgeResult};

pub use capture::devices;

pub type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

const MAX_WORDS: usize = 100;
const MAX_WORD: usize = 64;
const MAX_LISTEN: Duration = Duration::from_secs(120);
/// Quiet after speech that ends a session started to stop by itself.
const SILENCE: Duration = Duration::from_millis(1_600);
/// A denied microphone delivers exact zeros; this long of them is taken as no permission.
const NO_AUDIO: Duration = Duration::from_secs(2);
const LEVEL_EVERY: Duration = Duration::from_millis(80);
#[cfg(target_os = "macos")]
const NO_AUDIO_MESSAGE: &str = "The microphone sends no sound. Allow Runrail in System Settings > Privacy & Security > Microphone, or pick another microphone.";
#[cfg(not(target_os = "macos"))]
const NO_AUDIO_MESSAGE: &str = "The microphone sends no sound. Check that it is not muted in your desktop's sound settings, or pick another microphone.";
/// Waiting for the person to answer macOS's permission prompts.
const START_WAIT: Duration = Duration::from_secs(150);

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Apple,
    Whisper,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListenInput {
    pub engine: Engine,
    pub device: Option<String>,
    pub language: String,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub on_device: bool,
    pub model: Option<String>,
    #[serde(default)]
    pub words: Vec<String>,
    #[serde(default)]
    pub until_silence: bool,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("VOICE_INVALID", message)
}

fn language_tag(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let base = parts.next().unwrap_or("");
    tag.len() <= 35 && (2..=3).contains(&base.len()) && base.bytes().all(|byte| byte.is_ascii_alphabetic()) && parts.all(|part| (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

pub fn check(input: &ListenInput) -> BridgeResult<()> {
    if !language_tag(&input.language) {
        return Err(invalid("language is invalid"));
    }
    if input.device.as_deref().is_some_and(|device| device.is_empty() || device.len() > 512 || device.chars().any(char::is_control)) {
        return Err(invalid("microphone id is invalid"));
    }
    if input.words.len() > MAX_WORDS || input.words.iter().any(|word| word.trim().is_empty() || word.chars().count() > MAX_WORD || word.chars().any(char::is_control)) {
        return Err(invalid("at most 100 words, each one line of at most 64 characters"));
    }
    if cfg!(not(target_os = "macos")) && input.engine == Engine::Apple {
        return Err(invalid("Apple's recognizer is on macOS only"));
    }
    if input.engine == Engine::Whisper && input.model.as_deref().and_then(models::find).is_none() {
        return Err(BridgeError::new("VOICE_MODEL_UNKNOWN", "pick a Whisper model"));
    }
    Ok(())
}

enum Control {
    Stop,
    Cancel,
}

static CURRENT: Mutex<Option<(u64, mpsc::Sender<Control>)>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(0);

/// Notices the end of speech: a level well above the room's quiet, then quiet again.
struct Speech {
    floor: Option<f32>,
    heard: bool,
    quiet_since: Option<Instant>,
}

impl Speech {
    fn new() -> Self {
        Self { floor: None, heard: false, quiet_since: None }
    }

    fn update(&mut self, level: f32, now: Instant) {
        let floor = match self.floor {
            None => level,
            Some(floor) if level < floor => level,
            // The floor rises slowly, so speech itself does not become the new quiet.
            Some(floor) => floor * 0.995 + level * 0.005,
        };
        self.floor = Some(floor);
        if level > (floor * 3.0).max(0.01) {
            self.heard = true;
            self.quiet_since = None;
        } else if self.heard && self.quiet_since.is_none() {
            self.quiet_since = Some(now);
        }
    }

    fn done(&self, now: Instant) -> bool {
        self.quiet_since.is_some_and(|since| now.duration_since(since) >= SILENCE)
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

enum Recognizer {
    #[cfg(target_os = "macos")]
    Apple(apple::Apple),
    Whisper { resampler: whisper::Resampler, audio: Vec<f32>, model: &'static models::Model, path: PathBuf },
}

/// Starts listening. Returns once the microphone and recognizer run, or with why they could not.
pub fn start(app_data: &Path, input: ListenInput, emit: Emit) -> BridgeResult<u64> {
    check(&input)?;
    // One start at a time: two at once would each open the microphone, and only one could be stopped.
    static STARTING: Mutex<()> = Mutex::new(());
    let _starting = STARTING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let whisper_model = match input.engine {
        Engine::Whisper => {
            let model = input.model.as_deref().and_then(models::find).ok_or_else(|| BridgeError::new("VOICE_MODEL_UNKNOWN", "pick a Whisper model"))?;
            if !models::installed(app_data, model) {
                return Err(BridgeError::new("VOICE_MODEL_MISSING", "download the Whisper model first, in Settings > Voice"));
            }
            Some((model, models::path(app_data, model)))
        }
        Engine::Apple => None,
    };
    if let Ok(mut current) = CURRENT.lock() {
        if let Some((_, control)) = current.take() {
            let _ = control.send(Control::Cancel);
        }
    }
    let id = NEXT.fetch_add(1, Ordering::SeqCst) + 1;
    let (control, controls) = mpsc::channel();
    let (ready, started) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("runrail-voice".into())
        .spawn(move || run(id, input, whisper_model, controls, ready, emit))
        .map_err(|_| BridgeError::new("VOICE_FAILED", "could not start listening"))?;
    match started.recv_timeout(START_WAIT) {
        Ok(Ok(())) => {
            if let Ok(mut current) = CURRENT.lock() {
                if let Some((_, earlier)) = current.replace((id, control)) {
                    let _ = earlier.send(Control::Cancel);
                }
            }
            Ok(id)
        }
        Ok(Err(error)) => Err(error),
        Err(_) => {
            let _ = control.send(Control::Cancel);
            Err(BridgeError::new("VOICE_FAILED", "listening did not start"))
        }
    }
}

fn send(id: u64, message: Control) {
    if let Ok(mut current) = CURRENT.lock() {
        if current.as_ref().is_some_and(|(current_id, _)| *current_id == id) {
            if let Some((_, control)) = current.take() {
                let _ = control.send(message);
            }
        }
    }
}

/// Stops listening and turns what was heard into text.
pub fn stop(id: u64) {
    send(id, Control::Stop);
}

/// Stops listening and drops what was heard.
pub fn cancel(id: u64) {
    send(id, Control::Cancel);
}

/// Before the app exits: ends any session and frees the Whisper model (see `whisper::unload`).
pub fn shutdown() {
    if let Ok(mut current) = CURRENT.lock() {
        if let Some((_, control)) = current.take() {
            let _ = control.send(Control::Cancel);
        }
    }
    whisper::unload();
}

fn run(id: u64, input: ListenInput, whisper_model: Option<(&'static models::Model, PathBuf)>, controls: Receiver<Control>, ready: SyncSender<BridgeResult<()>>, emit: Emit) {
    let event = |kind: &str, extra: serde_json::Value| {
        let mut payload = json!({ "session": id, "kind": kind });
        if let (Some(target), Some(fields)) = (payload.as_object_mut(), extra.as_object()) {
            target.extend(fields.clone());
        }
        emit("voice:event", payload);
    };
    #[cfg(target_os = "macos")]
    if let Err(error) = access::microphone() {
        let _ = ready.send(Err(error));
        return;
    }
    let (sink, chunks) = mpsc::sync_channel::<Vec<f32>>(64);
    let (stream, rate) = match capture::open(input.device.as_deref(), sink) {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let recognizer = match whisper_model {
        Some((model, path)) => Ok(Recognizer::Whisper { resampler: whisper::Resampler::new(rate), audio: Vec::with_capacity(whisper::RATE as usize * 30), model, path }),
        #[cfg(target_os = "macos")]
        None => {
            let partial = emit.clone();
            apple::Apple::start(&input.language, input.on_device, &input.words, rate, move |text| partial("voice:event", json!({ "session": id, "kind": "partial", "text": text }))).map(Recognizer::Apple)
        }
        #[cfg(not(target_os = "macos"))]
        None => Err(invalid("Apple's recognizer is on macOS only")),
    };
    let mut recognizer = match recognizer {
        Ok(recognizer) => recognizer,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    let started = Instant::now();
    let mut speech = Speech::new();
    let mut sounded = false;
    let mut last_level = started;
    let mut peak = 0.0f32;
    let stopped = loop {
        match controls.try_recv() {
            Ok(Control::Stop) => break true,
            Ok(Control::Cancel) | Err(TryRecvError::Disconnected) => break false,
            Err(TryRecvError::Empty) => {}
        }
        let now = Instant::now();
        match chunks.recv_timeout(Duration::from_millis(40)) {
            Ok(chunk) => {
                sounded |= chunk.iter().any(|&sample| sample != 0.0);
                let level = rms(&chunk);
                peak = peak.max(level);
                speech.update(level, now);
                match &mut recognizer {
                    #[cfg(target_os = "macos")]
                    Recognizer::Apple(apple) => apple.feed(&chunk),
                    Recognizer::Whisper { resampler, audio, .. } => resampler.push(&chunk, audio),
                }
                if now.duration_since(last_level) >= LEVEL_EVERY {
                    event("level", json!({ "level": (peak.sqrt() * 2.5).min(1.0) }));
                    peak = 0.0;
                    last_level = now;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                event("error", json!({ "code": "VOICE_DEVICE_FAILED", "message": "the microphone stopped" }));
                break false;
            }
        }
        if !sounded && now.duration_since(started) >= NO_AUDIO {
            event("error", json!({ "code": "VOICE_NO_AUDIO", "message": NO_AUDIO_MESSAGE }));
            break false;
        }
        #[cfg(target_os = "macos")]
        let apple_ended = matches!(&recognizer, Recognizer::Apple(apple) if apple.ended());
        #[cfg(not(target_os = "macos"))]
        let apple_ended = false;
        if apple_ended || now.duration_since(started) >= MAX_LISTEN || (input.until_silence && speech.done(now)) {
            break true;
        }
    };
    drop(stream);
    if stopped {
        event("transcribing", json!({}));
        let text = match recognizer {
            #[cfg(target_os = "macos")]
            Recognizer::Apple(apple) => apple.finish(),
            Recognizer::Whisper { audio, model, path, .. } => {
                let request = whisper::Request { model_id: model.id, path: &path, language: Some(&input.language), english_only: model.english_only, words: &input.words };
                whisper::transcribe(&request, &audio)
            }
        };
        match text {
            Ok(text) => event("final", json!({ "text": text })),
            Err(error) => event("error", json!({ "code": error.code, "message": error.message })),
        }
    } else {
        #[cfg(target_os = "macos")]
        if let Recognizer::Apple(apple) = recognizer {
            apple.cancel();
        }
    }
    if let Ok(mut current) = CURRENT.lock() {
        if current.as_ref().is_some_and(|(current_id, _)| *current_id == id) {
            *current = None;
        }
    }
    event("ended", json!({}));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ListenInput {
        ListenInput { engine: Engine::Whisper, device: None, language: "en-US".into(), on_device: false, model: Some("base.en".into()), words: Vec::new(), until_silence: false }
    }

    #[test]
    fn listening_input_is_bounded() {
        assert!(check(&input()).is_ok());
        assert!(check(&ListenInput { language: "zh-Hant-TW".into(), ..input() }).is_ok());
        assert!(check(&ListenInput { language: "yue-CN".into(), ..input() }).is_ok());
        for language in ["", "e", "english", "en_US", "en-US;rm", "../x"] {
            assert_eq!(check(&ListenInput { language: language.into(), ..input() }).unwrap_err().code, "VOICE_INVALID", "{language}");
        }
        assert_eq!(check(&ListenInput { words: vec!["ok".into(); 101], ..input() }).unwrap_err().code, "VOICE_INVALID");
        assert_eq!(check(&ListenInput { words: vec!["two\nlines".into()], ..input() }).unwrap_err().code, "VOICE_INVALID");
        assert_eq!(check(&ListenInput { device: Some(String::new()), ..input() }).unwrap_err().code, "VOICE_INVALID");
        assert_eq!(check(&ListenInput { engine: Engine::Whisper, model: Some("huge".into()), ..input() }).unwrap_err().code, "VOICE_MODEL_UNKNOWN");
        assert!(check(&ListenInput { engine: Engine::Whisper, model: Some("base.en".into()), ..input() }).is_ok());
        assert_eq!(check(&ListenInput { engine: Engine::Apple, model: None, ..input() }).is_ok(), cfg!(target_os = "macos"));
    }

    #[test]
    fn whisper_needs_a_downloaded_model() {
        let root = std::env::temp_dir().join(format!("runrail-voice-{}", std::process::id()));
        let emit: Emit = Arc::new(|_, _| {});
        let error = start(&root, ListenInput { engine: Engine::Whisper, model: Some("tiny.en".into()), ..input() }, emit).unwrap_err();
        assert_eq!(error.code, "VOICE_MODEL_MISSING");
    }

    #[test]
    fn speech_ends_after_quiet_that_follows_it() {
        let start = Instant::now();
        let mut speech = Speech::new();
        let at = |ms: u64| start + Duration::from_millis(ms);
        for ms in (0..1_000).step_by(40) {
            speech.update(0.002, at(ms));
        }
        assert!(!speech.done(at(3_000)), "room noise alone is not speech");
        speech.update(0.2, at(1_000));
        speech.update(0.003, at(1_040));
        assert!(!speech.done(at(2_000)));
        assert!(speech.done(at(2_700)));
        speech.update(0.2, at(2_800));
        assert!(!speech.done(at(3_000)), "speaking again resets the quiet");
    }
}
