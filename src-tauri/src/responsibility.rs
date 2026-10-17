//! Which app macOS holds answerable for this process. Privacy prompts (microphone, speech
//! recognition) are asked in that app's name, and macOS kills the process when that app's
//! Info.plist lacks the matching usage description. Runrail opened from Finder answers for
//! itself; a build started from a terminal, an editor, or Claude Code does not.

use std::ffi::{c_void, CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use objc2_foundation::{NSBundle, NSString};

fn symbol(name: &CStr) -> Option<*mut c_void> {
    let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!found.is_null()).then_some(found)
}

/// Private API, so looked up at run time; without it nothing is known.
fn responsible_for(pid: libc::pid_t) -> Option<libc::pid_t> {
    let found = symbol(c"responsibility_get_pid_responsible_for_pid")?;
    let call: unsafe extern "C" fn(libc::pid_t) -> libc::pid_t = unsafe { std::mem::transmute(found) };
    let responsible = unsafe { call(pid) };
    (responsible > 0).then_some(responsible)
}

fn own_pid() -> libc::pid_t {
    std::process::id() as libc::pid_t
}

fn executable(pid: libc::pid_t) -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer)))
}

/// The `.app` an executable at `X.app/Contents/MacOS/name` belongs to.
fn bundle_of(executable: &Path) -> Option<&Path> {
    let contents = executable.parent()?.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = executable.parent()?.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app";
    is_bundle.then_some(bundle)
}

/// Whether the app macOS would ask on behalf of declares `key`, so asking cannot crash.
pub fn may_ask(key: &str) -> bool {
    let key = NSString::from_str(key);
    let Some(responsible) = responsible_for(own_pid()) else { return false };
    if responsible == own_pid() {
        // A development build carries its Info.plist inside the executable; the main bundle reads it.
        return NSBundle::mainBundle().objectForInfoDictionaryKey(&key).is_some();
    }
    let Some(path) = executable(responsible) else { return false };
    let Some(bundle) = bundle_of(&path).and_then(|bundle| NSBundle::bundleWithPath(&NSString::from_str(&bundle.to_string_lossy()))) else { return false };
    bundle.objectForInfoDictionaryKey(&key).is_some()
}

const STAND_IN: &str = "RUNRAIL_OWN_RESPONSIBILITY";

/// A development build starts again as its own responsible process, so macOS asks for the
/// microphone and speech in Runrail's name, as for the installed app. This process stays as a
/// stand-in: it passes signals on and exits with the build's status.
#[cfg(debug_assertions)]
pub fn claim() {
    if std::env::var_os(STAND_IN).is_some() {
        std::env::remove_var(STAND_IN);
        exit_with_stand_in();
        return;
    }
    // A build answering for itself needs its own access to the folder it sits in (Desktop,
    // Documents), and its start waits on that prompt; an automated run needs no microphone.
    if std::env::var("RUNRAIL_AUTOMATION").as_deref() == Ok("1") {
        return;
    }
    if responsible_for(own_pid()).is_none_or(|responsible| responsible == own_pid()) {
        return;
    }
    let Some(disclaim) = symbol(c"responsibility_spawnattrs_setdisclaim") else { return };
    let Ok(program) = std::env::current_exe() else { return };
    let Ok(program) = CString::new(program.as_os_str().as_bytes()) else { return };
    let Ok(args) = std::env::args_os().map(|arg| CString::new(arg.as_bytes())).collect::<Result<Vec<_>, _>>() else { return };
    let mut argv: Vec<*mut libc::c_char> = args.iter().map(|arg| arg.as_ptr().cast_mut()).collect();
    argv.push(std::ptr::null_mut());
    std::env::set_var(STAND_IN, "1");
    let mut child: libc::pid_t = 0;
    let spawned = unsafe {
        let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
        libc::posix_spawnattr_init(&mut attributes);
        let disclaim: unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int = std::mem::transmute(disclaim);
        disclaim(&mut attributes, 1);
        let result = libc::posix_spawn(&mut child, program.as_ptr(), std::ptr::null(), &attributes, argv.as_ptr(), *libc::_NSGetEnviron());
        libc::posix_spawnattr_destroy(&mut attributes);
        result
    };
    std::env::remove_var(STAND_IN);
    if spawned != 0 {
        return;
    }
    std::process::exit(stand_in(child));
}

#[cfg(debug_assertions)]
static CHILD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(debug_assertions)]
extern "C" fn pass_on(signal: libc::c_int) {
    let child = CHILD.load(std::sync::atomic::Ordering::Relaxed);
    if child > 0 {
        unsafe { libc::kill(child, signal) };
    }
}

#[cfg(debug_assertions)]
fn stand_in(child: libc::pid_t) -> i32 {
    CHILD.store(child, std::sync::atomic::Ordering::Relaxed);
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        unsafe { libc::signal(signal, pass_on as extern "C" fn(libc::c_int) as libc::sighandler_t) };
    }
    let mut status = 0;
    loop {
        if unsafe { libc::waitpid(child, &mut status, 0) } != -1 {
            break;
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return 1;
        }
    }
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        128 + libc::WTERMSIG(status)
    }
}

/// `tauri dev` stops the stand-in on a rebuild, sometimes with SIGKILL; the build follows it.
#[cfg(debug_assertions)]
fn exit_with_stand_in() {
    let stand_in = std::os::unix::process::parent_id();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if std::os::unix::process::parent_id() != stand_in {
            std::process::exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_executable_inside_an_app_names_its_bundle() {
        assert_eq!(bundle_of(Path::new("/Applications/Terminal.app/Contents/MacOS/Terminal")), Some(Path::new("/Applications/Terminal.app")));
        assert_eq!(bundle_of(Path::new("/usr/local/bin/claude")), None);
        assert_eq!(bundle_of(Path::new("/tmp/Thing.app/Contents/Resources/tool")), None);
    }
}
