//! Transcription on this computer with whisper.cpp: through Metal on macOS, on the CPU on Linux.
//! The last model used stays loaded for a while, so the next dictation starts at once.
//! whisper.cpp's own logging is switched off: it could echo what was said.

use std::path::Path;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::{BridgeError, BridgeResult};

pub const RATE: u32 = 16_000;
/// Words to listen for, passed as the first words the model expects.
const MAX_PROMPT: usize = 800;

/// A model unused this long is unloaded; the large one holds over half a gigabyte.
const IDLE: Duration = Duration::from_secs(10 * 60);

struct Loaded {
    id: &'static str,
    context: Arc<WhisperContext>,
    used: Instant,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);
/// Held through a model load, so two never run at once; `LOADED` is taken only to read or swap the
/// slot, so the idle reaper and a dictation on the model already loaded never wait on a load.
/// Always taken before `LOADED`.
static LOADING: Mutex<()> = Mutex::new(());
static QUIET: Once = Once::new();
static REAPER: Once = Once::new();

/// Drops a loaded model, so its file can be removed. A load of it under way finishes first.
pub fn forget(id: &str) {
    let _loading = LOADING.lock();
    if let Ok(mut loaded) = LOADED.lock() {
        if loaded.as_ref().is_some_and(|loaded| loaded.id == id) {
            *loaded = None;
        }
    }
}

/// Frees the loaded model. Must run before the process exits: whisper.cpp's Metal backend aborts
/// in its exit-time cleanup while a model still holds GPU buffers.
pub fn unload() {
    let _loading = LOADING.lock();
    if let Ok(mut loaded) = LOADED.lock() {
        *loaded = None;
    }
}

fn reap_when_idle() {
    REAPER.call_once(|| {
        let _ = std::thread::Builder::new().name("runrail-whisper-idle".into()).spawn(|| loop {
            std::thread::sleep(Duration::from_secs(60));
            if let Ok(mut loaded) = LOADED.lock() {
                if loaded.as_ref().is_some_and(|loaded| loaded.used.elapsed() >= IDLE) {
                    *loaded = None;
                }
            }
        });
    });
}

fn load_error() -> BridgeError {
    BridgeError::new("VOICE_MODEL_LOAD", "could not load the model")
}

/// The model `id` when it is the one loaded, marked as just used.
fn loaded(id: &str) -> BridgeResult<Option<Arc<WhisperContext>>> {
    let mut loaded = LOADED.lock().map_err(|_| load_error())?;
    Ok(loaded.as_mut().filter(|current| current.id == id).map(|current| {
        current.used = Instant::now();
        current.context.clone()
    }))
}

fn context(id: &'static str, path: &Path) -> BridgeResult<Arc<WhisperContext>> {
    QUIET.call_once(whisper_rs::install_logging_hooks);
    if let Some(context) = loaded(id)? {
        return Ok(context);
    }
    let _loading = LOADING.lock().map_err(|_| load_error())?;
    // Another dictation may have loaded it while this one waited.
    if let Some(context) = loaded(id)? {
        return Ok(context);
    }
    // The model in memory goes before the next one is read, so the two are never held together.
    *LOADED.lock().map_err(|_| load_error())? = None;
    let parameters = WhisperContextParameters { use_gpu: true, ..WhisperContextParameters::default() };
    let context = Arc::new(WhisperContext::new_with_params(path, parameters).map_err(|_| load_error())?);
    *LOADED.lock().map_err(|_| load_error())? = Some(Loaded { id, context: context.clone(), used: Instant::now() });
    reap_when_idle();
    Ok(context)
}

/// Whisper's code for a BCP 47 tag: the language part, as whisper.cpp spells it.
pub fn language_code(tag: &str) -> Option<String> {
    let base = tag.split(['-', '_']).next()?.to_ascii_lowercase();
    match base.as_str() {
        "" => None,
        "nb" | "nn" => Some("no".into()),
        "he" | "iw" => Some("he".into()),
        other if other.len() <= 3 && other.bytes().all(|byte| byte.is_ascii_lowercase()) => Some(other.into()),
        _ => None,
    }
}

/// Markers whisper writes for sound that is not speech, such as `[BLANK_AUDIO]` or `(music)`.
fn without_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct Request<'a> {
    pub model_id: &'static str,
    pub path: &'a Path,
    pub language: Option<&'a str>,
    pub english_only: bool,
    pub words: &'a [String],
}

/// Whisper invents words ("Thank you.") for silence, so audio with no loud tenth of a second is
/// taken as nothing said.
fn has_sound(audio: &[f32]) -> bool {
    audio.chunks(RATE as usize / 10).any(|window| (window.iter().map(|sample| sample * sample).sum::<f32>() / window.len() as f32).sqrt() > 0.01)
}

/// Turns 16 kHz mono samples into text. Under a third of a second, or no sound, is nothing.
pub fn transcribe(request: &Request<'_>, audio: &[f32]) -> BridgeResult<String> {
    if audio.len() < RATE as usize / 3 || !has_sound(audio) {
        return Ok(String::new());
    }
    let context = context(request.model_id, request.path)?;
    let mut state = context.create_state().map_err(|_| BridgeError::new("VOICE_MODEL_LOAD", "could not load the model"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism().map(|count| count.get().min(8)).unwrap_or(4);
    params.set_n_threads(threads as i32);
    let language = if request.english_only { Some("en".to_string()) } else { request.language.and_then(language_code) };
    params.set_language(Some(language.as_deref().unwrap_or("auto")));
    params.set_translate(false);
    params.set_no_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    let prompt: String = request.words.join(", ").chars().take(MAX_PROMPT).collect();
    if !prompt.is_empty() {
        params.set_initial_prompt(&prompt);
    }
    // whisper.cpp reads at least a second; shorter speech is padded with silence.
    let mut padded;
    let samples = if audio.len() < RATE as usize {
        padded = audio.to_vec();
        padded.resize(RATE as usize + RATE as usize / 10, 0.0);
        &padded[..]
    } else {
        audio
    };
    state.full(params, samples).map_err(|_| BridgeError::new("VOICE_TRANSCRIBE", "could not transcribe what was said"))?;
    let text: Vec<String> = state.as_iter().filter_map(|segment| segment.to_str_lossy().ok().map(|text| text.into_owned())).collect();
    Ok(without_markers(&text.join(" ")))
}

/// Linear resampling to 16 kHz. Speech sits well under the new Nyquist limit, so this is enough
/// for recognition.
pub struct Resampler {
    step: f64,
    position: f64,
    last: f32,
}

impl Resampler {
    pub fn new(rate: u32) -> Self {
        Self { step: f64::from(rate) / f64::from(RATE), position: 0.0, last: 0.0 }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        // `position` counts from the sample before this chunk, which is `last`.
        while self.position < input.len() as f64 {
            let index = self.position.floor() as usize;
            let fraction = (self.position - index as f64) as f32;
            let before = if index == 0 { self.last } else { input[index - 1] };
            let after = input[index];
            out.push(before + (after - before) * fraction);
            self.position += self.step;
        }
        self.position -= input.len() as f64;
        self.last = input[input.len() - 1];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tags_become_whisper_codes() {
        assert_eq!(language_code("en-US").as_deref(), Some("en"));
        assert_eq!(language_code("zh-TW").as_deref(), Some("zh"));
        assert_eq!(language_code("yue-CN").as_deref(), Some("yue"));
        assert_eq!(language_code("nb-NO").as_deref(), Some("no"));
        assert_eq!(language_code("x1-bad"), None);
    }

    #[test]
    fn quiet_audio_is_not_sent_to_the_model() {
        assert!(!has_sound(&vec![0.001; RATE as usize]));
        let mut speech = vec![0.0; RATE as usize];
        speech[8_000..9_600].iter_mut().enumerate().for_each(|(index, sample)| *sample = if index % 2 == 0 { 0.2 } else { -0.2 });
        assert!(has_sound(&speech));
        let request = Request { model_id: "tiny.en", path: Path::new("/no/model"), language: None, english_only: true, words: &[] };
        assert_eq!(transcribe(&request, &vec![0.0; RATE as usize * 2]).unwrap(), "", "never loads a model for silence");
    }

    #[test]
    fn markers_for_sound_that_is_not_speech_are_dropped() {
        assert_eq!(without_markers(" [BLANK_AUDIO] "), "");
        assert_eq!(without_markers("Fix the (coughs) build [music] now"), "Fix the build now");
    }

    /// Needs a downloaded model and a 32-bit float WAV at 16 kHz:
    /// `RUNRAIL_WHISPER_MODEL=… RUNRAIL_WHISPER_WAV=… cargo test -- --ignored transcribes`.
    #[test]
    #[ignore]
    fn transcribes_speech_with_a_downloaded_model() {
        let model = std::env::var("RUNRAIL_WHISPER_MODEL").expect("RUNRAIL_WHISPER_MODEL");
        let wav = std::fs::read(std::env::var("RUNRAIL_WHISPER_WAV").expect("RUNRAIL_WHISPER_WAV")).unwrap();
        let data = wav.windows(4).position(|window| window == b"data").expect("data chunk") + 8;
        let audio: Vec<f32> = wav[data..].as_chunks::<4>().0.iter().map(|bytes| f32::from_le_bytes(*bytes)).collect();
        let request = Request { model_id: "tiny.en", path: Path::new(&model), language: Some("en-US"), english_only: true, words: &["payments".to_string()] };
        let started = std::time::Instant::now();
        let text = transcribe(&request, &audio).unwrap().to_lowercase();
        eprintln!("{:.1} s of audio in {} ms", audio.len() as f32 / RATE as f32, started.elapsed().as_millis());
        for word in ["fix", "failing build", "payment", "tests"] {
            assert!(text.contains(word), "{text}");
        }
        assert_eq!(transcribe(&request, &vec![0.0; RATE as usize * 2]).unwrap(), "", "silence is no words");
        unload();
    }

    #[test]
    fn resampling_keeps_duration_across_chunks() {
        let mut resampler = Resampler::new(48_000);
        let mut out = Vec::new();
        for _ in 0..10 {
            resampler.push(&[0.25; 4_800], &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
        assert!(out.iter().skip(1).all(|&sample| (sample - 0.25).abs() < 1e-6));
    }
}
