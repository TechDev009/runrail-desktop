//! Running a helper program with a deadline, for the hosts that drive other tools (the
//! simulator's `simctl`, Tailscale's CLI).

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub struct Ran {
    pub ok: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Runs a program with a deadline. Output is read on its own threads, and given up on shortly
/// after the program ends, so a helper it leaves running cannot hold the call open.
pub fn run(mut command: Command, input: Option<Vec<u8>>, timeout: Duration) -> Result<Ran, String> {
    command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "the tool could not be started".to_string())?;
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.by_ref().take(16 * 1024 * 1024).read_to_end(&mut buffer);
            }
            let _ = sender.send(buffer);
        });
        receiver
    };
    let stdout = read(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = read(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let grace = Duration::from_secs(2);
    let stdout = stdout.recv_timeout(grace).unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr.recv_timeout(grace).unwrap_or_default()).into_owned();
    match status {
        Some(status) => Ok(Ran { ok: status.success(), stdout, stderr }),
        None => Err("the tool did not finish in time".into()),
    }
}

/// A tool's complaint, short and without control characters.
pub fn complaint(stderr: &str, fallback: &str) -> String {
    let line = stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(fallback);
    clean(line, 300)
}

pub fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|char| !char.is_control()).take(max).collect()
}
