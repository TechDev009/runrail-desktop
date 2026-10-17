//! Computer use on Wayland, through the desktop's remote desktop portal. The
//! person picks one window in the desktop's own dialog and lets Runrail control it, once while
//! Runrail runs; agents then see that window over PipeWire and send it input through the portal.
//! Wayland says neither which app a window belongs to nor what covers it, so the window the person
//! picked is the one app agents may use, and the allow list and its refusals do not apply here.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ashpd::desktop::remote_desktop::{Axis, DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions, StartOptions};
use ashpd::desktop::screencast::{OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::{CreateSessionOptions, PersistMode, Session};
use futures_lite::future::block_on;

use super::frames::{Frames, Remote};

/// The window the person shared, as agents name it.
pub const SHARED_ID: &str = "wayland.shared-window";
pub const SHARED_NAME: &str = "Shared window";

const BUTTON_LEFT: i32 = 0x110;
const BUTTON_RIGHT: i32 = 0x111;
const WAIT: Duration = Duration::from_secs(5);

struct Shared {
    remote: RemoteDesktop,
    session: Session<RemoteDesktop>,
    node: u32,
    /// The window's size in the portal's own units, which pointer positions are given in.
    size: (f64, f64),
    frames: Frames,
}

static SHARED: Mutex<Option<Arc<Shared>>> = Mutex::new(None);
static AVAILABLE: OnceLock<bool> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    /// No portal that can both share a window and take input.
    Missing,
    Ready,
    Shared,
}

pub fn state() -> State {
    if current().is_some() {
        State::Shared
    } else if available() {
        State::Ready
    } else {
        State::Missing
    }
}

/// The share, unless the person or the desktop ended it.
fn current() -> Option<Arc<Shared>> {
    let mut shared = SHARED.lock().ok()?;
    if shared.as_ref().is_some_and(|each| each.frames.closed.load(Ordering::Relaxed)) {
        shared.take();
    }
    shared.clone()
}

/// Whether PipeWire is installed and the desktop's portal shares single windows and takes
/// keyboard and pointer input. A portal that starts later is found then; one that answered yes is
/// not asked again.
fn available() -> bool {
    if let Some(known) = AVAILABLE.get() {
        return *known;
    }
    if !super::frames::installed() {
        return false;
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let found = block_on(async {
            let (Ok(remote), Ok(cast)) = (RemoteDesktop::new().await, Screencast::new().await) else { return false };
            let devices = remote.available_device_types().await.unwrap_or_default();
            let sources = cast.available_source_types().await.unwrap_or_default();
            devices.contains(DeviceType::Keyboard | DeviceType::Pointer) && sources.contains(SourceType::Window)
        });
        let _ = sender.send(found);
    });
    let found = receiver.recv_timeout(WAIT).unwrap_or(false);
    if found {
        let _ = AVAILABLE.set(true);
    }
    found
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Asks the person, in the desktop's own dialog, for one window and for control of it. Returns
/// once they answer.
pub fn share() -> Result<(), String> {
    if current().is_some() {
        return Ok(());
    }
    let shared = block_on(start())?;
    if let Ok(mut slot) = SHARED.lock() {
        *slot = Some(Arc::new(shared));
    }
    Ok(())
}

async fn start() -> Result<Shared, String> {
    let remote = RemoteDesktop::new().await.map_err(text)?;
    let cast = Screencast::new().await.map_err(text)?;
    let session = remote.create_session(CreateSessionOptions::default()).await.map_err(text)?;
    remote.select_devices(&session, SelectDevicesOptions::default().set_devices(DeviceType::Keyboard | DeviceType::Pointer).set_persist_mode(PersistMode::DoNot)).await.map_err(text)?.response().map_err(text)?;
    cast.select_sources(&session, SelectSourcesOptions::default().set_sources(ashpd::enumflags2::BitFlags::from(SourceType::Window)).set_multiple(false)).await.map_err(text)?.response().map_err(text)?;
    let started = remote.start(&session, None, StartOptions::default()).await.map_err(text)?.response().map_err(|_| "The person did not share a window.".to_string())?;
    let stream = started.streams().first().ok_or("The desktop shared no window.")?;
    if !started.devices().contains(DeviceType::Keyboard | DeviceType::Pointer) {
        let _ = session.close().await;
        return Err("The person shared a window without letting Runrail use it.".into());
    }
    let size = stream.size().map(|(width, height)| (f64::from(width), f64::from(height))).unwrap_or_default();
    let node = stream.pipe_wire_node_id();
    let fd = cast.open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default()).await.map_err(text)?;
    let frames = Frames::start(Remote::Portal(fd), node)?;
    Ok(Shared { remote, session, node, size, frames })
}

/// Ends the share; the desktop's dialog asks again next time.
pub fn stop() {
    let gone = SHARED.lock().ok().and_then(|mut slot| slot.take());
    if let Some(gone) = gone {
        let _ = block_on(gone.session.close());
    }
}

/// The shared window's latest picture, waiting a moment for the first one.
pub fn picture() -> Result<image::RgbImage, String> {
    let shared = current().ok_or(NOT_SHARED)?;
    let started = Instant::now();
    loop {
        if let Some(image) = shared.frames.latest.lock().ok().and_then(|latest| latest.clone()) {
            return Ok(image);
        }
        if started.elapsed() > WAIT || shared.frames.closed.load(Ordering::Relaxed) {
            return Err("The shared window sent no picture.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub const NOT_SHARED: &str = "No window is shared with Runrail. The person shares one in Runrail's settings, under Computer use, and picks it in the desktop's dialog.";

/// A point in a picture `pixels` big, in the portal's units for the window.
pub fn to_portal(point: (f64, f64), pixels: (u32, u32)) -> Option<(f64, f64)> {
    let shared = current()?;
    Some(scale_point(point, pixels, shared.size))
}

fn scale_point(point: (f64, f64), pixels: (u32, u32), size: (f64, f64)) -> (f64, f64) {
    if size.0 < 1.0 || size.1 < 1.0 || pixels.0 == 0 || pixels.1 == 0 {
        return point;
    }
    (point.0 * size.0 / f64::from(pixels.0), point.1 * size.1 / f64::from(pixels.1))
}

/// Runs input calls on the share; a failed call means the desktop ended it.
fn send<F>(input: impl FnOnce(Arc<Shared>) -> F) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), ashpd::Error>>,
{
    let shared = current().ok_or(NOT_SHARED)?;
    let closed = shared.frames.closed.clone();
    block_on(input(shared)).map_err(|error| {
        closed.store(true, Ordering::Relaxed);
        format!("The desktop refused the input ({error}); the window may no longer be shared.")
    })
}

pub fn click(at: (f64, f64), right: bool, clicks: i64) -> Result<(), String> {
    let button = if right { BUTTON_RIGHT } else { BUTTON_LEFT };
    send(|shared| async move {
        shared.remote.notify_pointer_motion_absolute(&shared.session, shared.node, at.0, at.1, Default::default()).await?;
        std::thread::sleep(Duration::from_millis(30));
        for _ in 0..clicks {
            shared.remote.notify_pointer_button(&shared.session, button, KeyState::Pressed, Default::default()).await?;
            shared.remote.notify_pointer_button(&shared.session, button, KeyState::Released, Default::default()).await?;
        }
        Ok(())
    })
}

/// Wheel steps go down and right for positive counts, the other way from the agent's.
pub fn scroll(at: (f64, f64), dx: i32, dy: i32) -> Result<(), String> {
    send(|shared| async move {
        shared.remote.notify_pointer_motion_absolute(&shared.session, shared.node, at.0, at.1, Default::default()).await?;
        std::thread::sleep(Duration::from_millis(30));
        if dy != 0 {
            shared.remote.notify_pointer_axis_discrete(&shared.session, Axis::Vertical, -dy, Default::default()).await?;
        }
        if dx != 0 {
            shared.remote.notify_pointer_axis_discrete(&shared.session, Axis::Horizontal, -dx, Default::default()).await?;
        }
        Ok(())
    })
}

/// Presses keysyms in turn, each with the modifiers held; the desktop finds the keys for them.
pub fn keys(keysyms: Vec<u32>, modifiers: Vec<u32>) -> Result<(), String> {
    send(|shared| async move {
        for keysym in keysyms {
            for modifier in &modifiers {
                shared.remote.notify_keyboard_keysym(&shared.session, *modifier as i32, KeyState::Pressed, Default::default()).await?;
            }
            shared.remote.notify_keyboard_keysym(&shared.session, keysym as i32, KeyState::Pressed, Default::default()).await?;
            shared.remote.notify_keyboard_keysym(&shared.session, keysym as i32, KeyState::Released, Default::default()).await?;
            for modifier in modifiers.iter().rev() {
                shared.remote.notify_keyboard_keysym(&shared.session, *modifier as i32, KeyState::Released, Default::default()).await?;
            }
            std::thread::sleep(Duration::from_millis(3));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picture_points_become_the_portals_units() {
        // A HiDPI window: 2 pixels a unit.
        assert_eq!(scale_point((200.0, 100.0), (1600, 1000), (800.0, 500.0)), (100.0, 50.0));
        assert_eq!(scale_point((10.0, 20.0), (400, 300), (0.0, 0.0)), (10.0, 20.0));
    }
}
