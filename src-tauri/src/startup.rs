//! How long the last launch took, from the moment the process started to the renderer saying its
//! saved state is on screen. Kept in `startup.json` so Settings → Developer and the startup budget
//! in docs/PERFORMANCE.md can read it. Holds two numbers and nothing else.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::store::write_atomic;

const FILE: &str = "startup.json";
/// A launch slower than this is a hang or a debugger, not a number worth keeping.
const MAX_READY: Duration = Duration::from_secs(600);

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupTiming {
    /// Process start to ready, in milliseconds.
    pub ready_ms: u64,
    /// When the launch finished, in Unix milliseconds.
    pub at: u64,
}

pub struct Startup {
    started: SystemTime,
    app_data: PathBuf,
    timing: Mutex<Option<StartupTiming>>,
}

impl Startup {
    pub fn new(app_data: &Path) -> Self {
        Self { started: process_start().unwrap_or_else(SystemTime::now), app_data: app_data.to_path_buf(), timing: Mutex::new(None) }
    }

    /// Records the first call only; a reload of the window does not count as a launch.
    pub fn ready(&self) -> Option<StartupTiming> {
        let mut timing = self.timing.lock().ok()?;
        if timing.is_none() {
            let now = SystemTime::now();
            let elapsed = now.duration_since(self.started).ok().filter(|elapsed| *elapsed <= MAX_READY)?;
            let measured = StartupTiming { ready_ms: elapsed.as_millis() as u64, at: now.duration_since(UNIX_EPOCH).map(|at| at.as_millis() as u64).unwrap_or(0) };
            if let Ok(bytes) = serde_json::to_vec(&measured) {
                let _ = write_atomic(&self.app_data.join(FILE), &bytes);
            }
            *timing = Some(measured);
        }
        *timing
    }
}

/// When the kernel started this process, so the time the system spends loading the binary counts.
#[cfg(target_os = "macos")]
fn process_start() -> Option<SystemTime> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is a zeroed `proc_bsdinfo` of exactly the size passed.
    let read = unsafe { libc::proc_pidinfo(std::process::id() as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    if read != size {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(info.pbi_start_tvsec) + Duration::from_micros(info.pbi_start_tvusec))
}

#[cfg(target_os = "linux")]
fn process_start() -> Option<SystemTime> {
    // SAFETY: sysconf has no preconditions.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let boot = std::fs::read_to_string("/proc/stat").ok()?;
    started_at(&stat, &boot, u64::try_from(ticks).ok()?)
}

/// Field 22 of `/proc/<pid>/stat` is the start in clock ticks after boot, and `btime` in
/// `/proc/stat` is the boot in Unix seconds. The name in field 2 may hold spaces and parentheses.
#[cfg(any(target_os = "linux", test))]
fn started_at(stat: &str, boot: &str, ticks_per_second: u64) -> Option<SystemTime> {
    let after_name = &stat[stat.rfind(')')? + 1..];
    let ticks: u64 = after_name.split_whitespace().nth(19)?.parse().ok()?;
    let booted: u64 = boot.lines().find_map(|line| line.strip_prefix("btime "))?.trim().parse().ok()?;
    if ticks_per_second == 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(booted) + Duration::from_millis(ticks * 1_000 / ticks_per_second))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_start() -> Option<SystemTime> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_the_first_launch_only_and_writes_it() {
        let dir = std::env::temp_dir().join(format!("runrail-desktop-startup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let startup = Startup::new(&dir);
        let first = startup.ready().expect("a launch under ten minutes is recorded");
        assert!(first.ready_ms < MAX_READY.as_millis() as u64);
        assert_eq!(startup.ready(), Some(first));
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(saved["readyMs"], first.ready_ms);
        assert_eq!(saved.as_object().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn reads_the_process_start_from_the_kernel() {
        let started = process_start().expect("the kernel answers for this process");
        assert!(started <= SystemTime::now());
        assert!(SystemTime::now().duration_since(started).unwrap() < Duration::from_secs(3_600));
    }

    #[test]
    fn a_proc_stat_line_gives_the_start_after_boot() {
        let stat = "4242 (my (odd) app) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 9 0 12345 104857600 2000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        let boot = "cpu  1 2 3\nbtime 1700000000\nprocesses 99\n";
        assert_eq!(started_at(stat, boot, 100), Some(UNIX_EPOCH + Duration::from_secs(1_700_000_000) + Duration::from_millis(123_450)));
        assert_eq!(started_at("4242 (x) S 1", boot, 100), None);
        assert_eq!(started_at(stat, "cpu 1\n", 100), None);
    }
}
