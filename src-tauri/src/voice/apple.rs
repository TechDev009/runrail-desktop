//! Apple's speech recognizer (the Speech framework), fed the microphone stream as audio buffers.
//! With `on_device`, macOS must recognize on this Mac and refuses to send audio to Apple.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_avf_audio::{AVAudioFormat, AVAudioPCMBuffer};
use objc2_foundation::{NSArray, NSError, NSLocale, NSOperationQueue, NSString};
use objc2_speech::{SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};

use crate::error::{BridgeError, BridgeResult};

/// The recognizer's codes for "no speech" and for a request that was ended or cancelled.
const QUIET_ERRORS: [isize; 4] = [203, 216, 301, 1110];

#[derive(Default)]
struct Heard {
    text: String,
    finished: bool,
    failed: bool,
}

pub struct Apple {
    _recognizer: Retained<SFSpeechRecognizer>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    format: Retained<AVAudioFormat>,
    heard: Arc<Mutex<Heard>>,
}

fn denied() -> BridgeError {
    BridgeError::new("VOICE_SPEECH_DENIED", "Runrail may not use speech recognition. Allow it in System Settings > Privacy & Security > Speech Recognition.")
}

/// Asks the person the first time; macOS remembers the answer.
fn authorize() -> BridgeResult<()> {
    let mut status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined {
        if !super::access::can_ask("NSSpeechRecognitionUsageDescription") {
            return Err(super::access::not_askable("speech recognition"));
        }
        let (sender, receiver) = mpsc::channel();
        let block = RcBlock::new(move |answer: SFSpeechRecognizerAuthorizationStatus| {
            let _ = sender.send(answer);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
        status = receiver.recv_timeout(Duration::from_secs(120)).unwrap_or(SFSpeechRecognizerAuthorizationStatus::NotDetermined);
    }
    if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        Ok(())
    } else {
        Err(denied())
    }
}

impl Apple {
    pub fn start(language: &str, on_device: bool, words: &[String], rate: u32, partial: impl Fn(&str) + 'static) -> BridgeResult<Self> {
        authorize()?;
        let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str(language));
        let recognizer = unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }
            .ok_or_else(|| BridgeError::new("VOICE_LANGUAGE", "macOS cannot recognize speech in this language"))?;
        if !unsafe { recognizer.isAvailable() } {
            return Err(BridgeError::new("VOICE_RECOGNIZER_UNAVAILABLE", "macOS speech recognition is not available right now"));
        }
        if on_device && !unsafe { recognizer.supportsOnDeviceRecognition() } {
            return Err(BridgeError::new(
                "VOICE_ON_DEVICE_MISSING",
                "this Mac has no on-device recognizer for this language. Add it under System Settings > Keyboard > Dictation, use Whisper, or let Apple's servers recognize it.",
            ));
        }
        unsafe { recognizer.setQueue(&NSOperationQueue::new()) };
        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(on_device);
            request.setAddsPunctuation(true);
        }
        if !words.is_empty() {
            let list: Vec<Retained<NSString>> = words.iter().map(|word| NSString::from_str(word)).collect();
            unsafe { request.setContextualStrings(&NSArray::from_retained_slice(&list)) };
        }
        let heard = Arc::new(Mutex::new(Heard::default()));
        let sink = heard.clone();
        let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            let Ok(mut heard) = sink.lock() else {
                return;
            };
            if let Some(result) = unsafe { result.as_ref() } {
                heard.text = unsafe { result.bestTranscription().formattedString() }.to_string();
                heard.finished |= unsafe { result.isFinal() };
                let text = heard.text.clone();
                drop(heard);
                partial(&text);
                return;
            }
            if let Some(error) = unsafe { error.as_ref() } {
                heard.finished = true;
                heard.failed |= heard.text.is_empty() && !QUIET_ERRORS.contains(&error.code());
            }
        });
        let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
        let format = unsafe { AVAudioFormat::initStandardFormatWithSampleRate_channels(AVAudioFormat::alloc(), f64::from(rate), 1) }
            .ok_or_else(|| BridgeError::new("VOICE_DEVICE_FAILED", "the microphone's format is not one macOS can recognize"))?;
        Ok(Self { _recognizer: recognizer, request, task, format, heard })
    }

    pub fn feed(&self, samples: &[f32]) {
        let Ok(frames) = u32::try_from(samples.len()) else {
            return;
        };
        let Some(buffer) = (unsafe { AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(AVAudioPCMBuffer::alloc(), &self.format, frames) }) else {
            return;
        };
        unsafe {
            let channels = buffer.floatChannelData();
            if channels.is_null() {
                return;
            }
            std::ptr::copy_nonoverlapping(samples.as_ptr(), (*channels).as_ptr(), samples.len());
            buffer.setFrameLength(frames);
            self.request.appendAudioPCMBuffer(&buffer);
        }
    }

    /// The recognizer ended the request itself, as Apple's servers do after about a minute.
    pub fn ended(&self) -> bool {
        self.heard.lock().is_ok_and(|heard| heard.finished)
    }

    /// Ends the audio and waits briefly for the last words.
    pub fn finish(self) -> BridgeResult<String> {
        unsafe { self.request.endAudio() };
        let deadline = Instant::now() + Duration::from_secs(4);
        while !self.ended() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(40));
        }
        if !self.ended() {
            unsafe { self.task.finish() };
        }
        let heard = self.heard.lock().map_err(|_| BridgeError::new("VOICE_TRANSCRIBE", "speech recognition failed"))?;
        if heard.failed {
            return Err(BridgeError::new("VOICE_TRANSCRIBE", "macOS speech recognition stopped with an error"));
        }
        Ok(heard.text.clone())
    }

    pub fn cancel(self) {
        unsafe { self.task.cancel() };
    }
}
