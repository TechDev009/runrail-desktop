//! System notifications: Apple's UserNotifications on macOS, the freedesktop notification server
//! on Linux. macOS lets only an app bundle use them: a development build run from `target/` has no
//! bundle, so it reports them unavailable and the window keeps showing its own notes. Linux needs
//! a notification server on the session bus. A click on a notification opens its thread.
#![cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{BridgeError, BridgeResult};

const MAX_TITLE: usize = 256;
const MAX_BODY: usize = 512;
/// Notifications posted this launch, per thread, so opening the thread clears them.
const MAX_TRACKED: usize = 256;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// A thread opened from a notification before the window could hear about it.
static OPENED: Mutex<Option<String>> = Mutex::new(None);
static POSTED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Unknown,
    Granted,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Denied,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Status {
    pub available: bool,
    pub permission: Permission,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub thread_id: String,
    pub title: String,
    pub body: String,
    pub sound: bool,
}

pub fn valid_thread(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// One line, control characters dropped, cut at `limit` characters.
fn clean(text: &str, limit: usize) -> String {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= limit {
        return trimmed;
    }
    let mut cut: String = trimmed.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

pub fn check(note: &Note) -> BridgeResult<(String, String)> {
    if !valid_thread(&note.thread_id) {
        return Err(BridgeError::new("NOTIFY_INVALID", "thread id is invalid"));
    }
    let title = clean(&note.title, MAX_TITLE);
    let body = clean(&note.body, MAX_BODY);
    if title.is_empty() {
        return Err(BridgeError::new("NOTIFY_INVALID", "a notification needs a title"));
    }
    Ok((title, body))
}

/// The thread a click opened, once.
pub fn take_opened() -> Option<String> {
    OPENED.lock().ok().and_then(|mut opened| opened.take())
}

fn opened(thread: String) {
    if !valid_thread(&thread) {
        return;
    }
    let Some(app) = APP.get() else {
        return;
    };
    // Shown from the menu bar too, with its Dock icon back.
    crate::background::show(app);
    if let Ok(mut slot) = OPENED.lock() {
        *slot = Some(thread.clone());
    }
    let _ = app.emit("notification:open", serde_json::json!({ "threadId": thread }));
}

fn remember(thread: &str, id: &str) {
    if let Ok(mut posted) = POSTED.lock() {
        if posted.len() >= MAX_TRACKED {
            posted.remove(0);
        }
        posted.push((thread.to_string(), id.to_string()));
    }
}

fn forget(thread: &str) -> Vec<String> {
    let Ok(mut posted) = POSTED.lock() else {
        return Vec::new();
    };
    let (gone, kept): (Vec<_>, Vec<_>) = posted.drain(..).partition(|(owner, _)| owner == thread);
    *posted = kept;
    gone.into_iter().map(|(_, id)| id).collect()
}

#[cfg(target_os = "macos")]
mod apple {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    use super::{opened, Permission};

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "RunrailNotificationDelegate"]
        #[ivars = ()]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // Shown even while Runrail is in front; the window decides when to post.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, handler: &block2::DynBlock<dyn Fn()>) {
                opened(response.notification().request().content().threadIdentifier().to_string());
                handler.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    /// UserNotifications raises an Objective-C exception, not an error, outside an app bundle.
    pub fn available() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundlePath().to_string().ends_with(".app") && bundle.bundleIdentifier().is_some()
    }

    pub fn install() {
        if !available() {
            return;
        }
        let delegate = Delegate::new();
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center keeps a weak reference; the delegate lives as long as the app.
        std::mem::forget(delegate);
    }

    pub fn permission() -> Permission {
        let (sender, receiver) = mpsc::channel();
        let block = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = sender.send(status);
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(status) if status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional => Permission::Granted,
            Ok(status) if status == UNAuthorizationStatus::Denied => Permission::Denied,
            _ => Permission::Unknown,
        }
    }

    /// Asks the person once; macOS remembers the answer and later calls return it at once.
    pub fn request() -> Permission {
        let (sender, receiver) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = sender.send(granted.as_bool());
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        match receiver.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => Permission::Granted,
            Ok(false) => Permission::Denied,
            Err(_) => Permission::Unknown,
        }
    }

    pub fn post(id: &str, thread: &str, title: &str, body: &str, sound: bool) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setThreadIdentifier(&NSString::from_str(thread));
        if sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
    }

    pub fn remove(ids: &[String]) {
        let ids: Vec<Retained<NSString>> = ids.iter().map(|id| NSString::from_str(id)).collect();
        let list = NSArray::from_retained_slice(&ids);
        UNUserNotificationCenter::currentNotificationCenter().removeDeliveredNotificationsWithIdentifiers(&list);
    }
}

#[cfg(target_os = "linux")]
mod freedesktop {
    use std::sync::Mutex;
    use std::time::Duration;

    use notify_rust::{Hint, Notification, Timeout};
    use zbus::blocking::Connection;

    use super::opened;

    const SERVER: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    /// Each notification keeps a thread and a bus connection to hear its click; past this many the
    /// oldest is closed.
    const MAX_LIVE: usize = 64;

    static LIVE: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    /// A notification server answers on the session bus.
    pub fn available() -> bool {
        notify_rust::get_server_information().is_ok()
    }

    pub fn note(title: &str, body: &str, sound: bool) -> Notification {
        let mut note = Notification::new();
        note.appname("Runrail").summary(title).body(body).action("default", "Open").timeout(Timeout::Default).hint(Hint::Category("im.received".into()));
        if sound {
            note.sound_name("message-new-instant");
        } else {
            note.hint(Hint::SuppressSound(true));
        }
        note
    }

    /// Shows the note and waits, on its own thread, for a click or for it to close.
    pub fn post(thread: String, title: &str, body: &str, sound: bool, posted: impl FnOnce(u32) + Send + 'static) {
        let note = note(title, body, sound);
        let _ = std::thread::Builder::new().name("runrail-notification".into()).spawn(move || {
            let Ok(handle) = note.show() else { return };
            let id = handle.id();
            posted(id);
            let oldest = LIVE.lock().ok().and_then(|mut live| {
                live.push(id);
                (live.len() > MAX_LIVE).then(|| live.remove(0))
            });
            if let Some(oldest) = oldest {
                close(&[oldest.to_string()]);
            }
            handle.wait_for_action(|action| {
                if action == "default" {
                    opened(thread);
                }
            });
            if let Ok(mut live) = LIVE.lock() {
                live.retain(|other| *other != id);
            }
        });
    }

    /// Closing a note also ends the thread waiting on it.
    pub fn close(ids: &[String]) {
        let ids: Vec<u32> = ids.iter().filter_map(|id| id.parse().ok()).collect();
        if ids.is_empty() {
            return;
        }
        let _ = std::thread::Builder::new().name("runrail-notification-close".into()).spawn(move || {
            let Ok(connection) = Connection::session() else { return };
            for id in ids {
                let _ = connection.call_method(Some(SERVER), PATH, Some(SERVER), "CloseNotification", &(id,));
            }
            std::thread::sleep(Duration::from_millis(50));
        });
    }
}

/// Sets the click handler; called once at startup so a click that launches the app is heard.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    apple::install();
}

pub fn status() -> Status {
    #[cfg(target_os = "macos")]
    if apple::available() {
        return Status { available: true, permission: apple::permission() };
    }
    // Linux asks no one: a running notification server shows what it is sent.
    #[cfg(target_os = "linux")]
    if freedesktop::available() {
        return Status { available: true, permission: Permission::Granted };
    }
    Status { available: false, permission: Permission::Unknown }
}

pub fn request() -> Status {
    #[cfg(target_os = "macos")]
    if apple::available() {
        return Status { available: true, permission: apple::request() };
    }
    status()
}

pub fn send(note: &Note) -> BridgeResult<()> {
    let (title, body) = check(note)?;
    #[cfg(target_os = "macos")]
    if apple::available() {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis()).unwrap_or(0);
        let id = format!("runrail.{}.{at}", note.thread_id);
        apple::post(&id, &note.thread_id, &title, &body, note.sound);
        remember(&note.thread_id, &id);
        return Ok(());
    }
    // Sent off the calling thread: the page asked for the status first, and a server that stopped
    // since only loses this one note.
    #[cfg(target_os = "linux")]
    {
        let thread = note.thread_id.clone();
        freedesktop::post(note.thread_id.clone(), &title, &body, note.sound, move |id| remember(&thread, &id.to_string()));
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (title, body);
        Err(BridgeError::new("NOTIFY_UNAVAILABLE", "system notifications need the installed app"))
    }
}

/// Clears this launch's delivered notifications for a thread the person opened.
pub fn clear(thread: &str) -> BridgeResult<()> {
    if !valid_thread(thread) {
        return Err(BridgeError::new("NOTIFY_INVALID", "thread id is invalid"));
    }
    let ids = forget(thread);
    #[cfg(target_os = "macos")]
    if !ids.is_empty() && apple::available() {
        apple::remove(&ids);
    }
    #[cfg(target_os = "linux")]
    freedesktop::close(&ids);
    let _ = ids;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(thread: &str, title: &str, body: &str) -> Note {
        Note { thread_id: thread.into(), title: title.into(), body: body.into(), sound: false }
    }

    #[test]
    fn a_note_is_one_bounded_line_for_a_real_thread_id() {
        let (title, body) = check(&note("th-abc_1.2", "Fix the\nbuild\t now", &"x".repeat(900))).unwrap();
        assert_eq!(title, "Fix the build now");
        assert_eq!(body.chars().count(), MAX_BODY);
        assert!(body.ends_with('…'));
        assert_eq!(check(&note("../etc", "t", "b")).unwrap_err().code, "NOTIFY_INVALID");
        assert_eq!(check(&note("th-1", " \n ", "b")).unwrap_err().code, "NOTIFY_INVALID");
        assert_eq!(check(&note(&"a".repeat(129), "t", "b")).unwrap_err().code, "NOTIFY_INVALID");
    }

    #[test]
    fn opening_a_thread_forgets_only_its_notifications() {
        remember("th-a", "runrail.th-a.1");
        remember("th-b", "runrail.th-b.1");
        remember("th-a", "runrail.th-a.2");
        assert_eq!(forget("th-a"), vec!["runrail.th-a.1", "runrail.th-a.2"]);
        assert_eq!(forget("th-a"), Vec::<String>::new());
        assert_eq!(forget("th-b"), vec!["runrail.th-b.1"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_build_outside_an_app_bundle_reports_notifications_unavailable() {
        let status = status();
        assert!(!status.available);
        assert_eq!(send(&note("th-1", "t", "b")).unwrap_err().code, "NOTIFY_UNAVAILABLE");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_linux_note_opens_on_click_and_plays_the_message_sound_when_asked() {
        use notify_rust::Hint;
        let loud = freedesktop::note("Fix the build", "Finished", true);
        assert_eq!((loud.appname.as_str(), loud.summary.as_str(), loud.body.as_str()), ("Runrail", "Fix the build", "Finished"));
        assert_eq!(loud.actions, vec!["default".to_string(), "Open".to_string()]);
        assert!(loud.hints.contains(&Hint::SoundName("message-new-instant".into())));
        let quiet = freedesktop::note("t", "b", false);
        assert!(quiet.hints.contains(&Hint::SuppressSound(true)));
        assert!(!quiet.hints.iter().any(|hint| matches!(hint, Hint::SoundName(_))));
    }
}
