//! Permission for the microphone and for speech recognition, asked only when macOS can ask
//! without tripping its privacy guard (see `crate::responsibility`).

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::{AnyClass, Bool};
use objc2::msg_send;
use objc2_foundation::NSString;

use crate::error::{BridgeError, BridgeResult};

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVMediaTypeAudio: &'static NSString;
}

/// `AVAuthorizationStatus`.
const NOT_DETERMINED: isize = 0;
const AUTHORIZED: isize = 3;

const ANSWER_WAIT: Duration = Duration::from_secs(120);

/// Whether macOS may show its permission prompt for `key` without killing the process.
pub fn can_ask(key: &str) -> bool {
    crate::responsibility::may_ask(key)
}

pub fn not_askable(what: &str) -> BridgeError {
    BridgeError::new(
        "VOICE_ASK_UNAVAILABLE",
        format!("macOS cannot ask for {what} on behalf of the app that started Runrail. Open Runrail from Applications, or allow that app in System Settings > Privacy & Security."),
    )
}

fn microphone_status() -> isize {
    let Some(class) = AnyClass::get(c"AVCaptureDevice") else { return NOT_DETERMINED };
    unsafe { msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio] }
}

/// Microphone access, asked the first time when this process may ask.
pub fn microphone() -> BridgeResult<()> {
    let denied = || BridgeError::new("VOICE_MIC_DENIED", "Runrail may not use the microphone. Allow it in System Settings > Privacy & Security > Microphone.");
    match microphone_status() {
        AUTHORIZED => Ok(()),
        NOT_DETERMINED if can_ask("NSMicrophoneUsageDescription") => {
            let Some(class) = AnyClass::get(c"AVCaptureDevice") else { return Err(denied()) };
            let (sender, receiver) = mpsc::channel();
            let block = RcBlock::new(move |granted: Bool| {
                let _ = sender.send(granted.as_bool());
            });
            let () = unsafe { msg_send![class, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*block] };
            if receiver.recv_timeout(ANSWER_WAIT).unwrap_or(false) { Ok(()) } else { Err(denied()) }
        }
        NOT_DETERMINED => Err(not_askable("the microphone")),
        _ => Err(denied()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_prompt_names_where_to_allow_it() {
        let error = not_askable("the microphone");
        assert_eq!(error.code, "VOICE_ASK_UNAVAILABLE");
        assert!(error.message.contains("System Settings"));
    }
}
