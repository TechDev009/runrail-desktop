//! The main window's size and place, kept across launches. A saved place that no longer lands on
//! a screen (a display was unplugged) is dropped and the window opens where the system puts it.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::store::write_atomic;

const FILE: &str = "window-state.json";
const MIN_WIDTH: u32 = 880;
const MIN_HEIGHT: u32 = 600;
const MAX_SIDE: u32 = 16_384;
/// How much of the window's title strip has to be on a screen for the place to count.
const VISIBLE: i64 = 64;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// A screen's area, in the same physical pixels as the window.
#[derive(Debug, Clone, Copy)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl WindowState {
    fn sane(&self) -> bool {
        (MIN_WIDTH / 2..=MAX_SIDE).contains(&self.width) && (MIN_HEIGHT / 2..=MAX_SIDE).contains(&self.height)
    }

    /// Whether enough of the top edge sits on some screen to grab and move the window.
    pub fn on_screen(&self, screens: &[Screen]) -> bool {
        screens.iter().any(|screen| {
            let left = i64::from(self.x).max(i64::from(screen.x));
            let right = (i64::from(self.x) + i64::from(self.width)).min(i64::from(screen.x) + i64::from(screen.width));
            let top = i64::from(self.y);
            right - left >= VISIBLE && top >= i64::from(screen.y) - VISIBLE / 2 && top < i64::from(screen.y) + i64::from(screen.height) - VISIBLE / 2
        })
    }
}

pub fn load(app_data: &Path) -> Option<WindowState> {
    let bytes = fs::read(app_data.join(FILE)).ok()?;
    serde_json::from_slice::<WindowState>(&bytes).ok().filter(WindowState::sane)
}

pub fn save(app_data: &Path, state: &WindowState) {
    if !state.sane() {
        return;
    }
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = write_atomic(&app_data.join(FILE), &bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Screen = Screen { x: 0, y: 0, width: 3024, height: 1964 };

    #[test]
    fn keeps_a_place_on_a_screen_and_drops_one_off_every_screen() {
        let state = WindowState { x: 200, y: 120, width: 2400, height: 1500, maximized: false };
        assert!(state.on_screen(&[LAPTOP]));
        // Left on a display that was unplugged, to the right of the laptop.
        assert!(!WindowState { x: 3400, ..state }.on_screen(&[LAPTOP]));
        assert!(WindowState { x: 3400, ..state }.on_screen(&[LAPTOP, Screen { x: 3024, y: 0, width: 2560, height: 1440 }]));
        // Title bar above the top of every screen.
        assert!(!WindowState { y: -400, ..state }.on_screen(&[LAPTOP]));
    }

    #[test]
    fn round_trips_and_refuses_odd_sizes() {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-window-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).is_none());
        let state = WindowState { x: 10, y: 20, width: 1600, height: 1000, maximized: true };
        save(&dir, &state);
        assert_eq!(load(&dir), Some(state));
        save(&dir, &WindowState { width: 10, ..state });
        assert_eq!(load(&dir), Some(state));
        fs::write(dir.join(FILE), b"{\"x\":0,\"y\":0,\"width\":99999,\"height\":900}").unwrap();
        assert!(load(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
