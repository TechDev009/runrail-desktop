//! The shared window's picture over PipeWire, for computer use on Wayland. libpipewire is loaded
//! when a window is first shared, so Runrail starts on systems without it and builds against
//! none; the Rust bindings need newer headers than Ubuntu 22.04 has. Only exported functions of
//! PipeWire's stable 0.3 API are called, and the one format object it needs is written here.

use std::ffi::{c_char, c_int, c_void};
use std::os::fd::{IntoRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const TYPE_ID: u32 = 3;
const TYPE_RECTANGLE: u32 = 10;
const TYPE_FRACTION: u32 = 11;
const TYPE_OBJECT: u32 = 15;
const TYPE_CHOICE: u32 = 19;
const OBJECT_FORMAT: u32 = 0x40003;
const PARAM_ENUM_FORMAT: u32 = 3;
const PARAM_FORMAT: u32 = 4;
const FORMAT_MEDIA_TYPE: u32 = 1;
const FORMAT_MEDIA_SUBTYPE: u32 = 2;
const FORMAT_VIDEO_FORMAT: u32 = 0x20001;
const FORMAT_VIDEO_SIZE: u32 = 0x20003;
const FORMAT_VIDEO_FRAMERATE: u32 = 0x20004;
const MEDIA_TYPE_VIDEO: u32 = 2;
const MEDIA_SUBTYPE_RAW: u32 = 1;
const CHOICE_RANGE: u32 = 1;
const CHOICE_ENUM: u32 = 3;

pub const VIDEO_RGBX: u32 = 7;
pub const VIDEO_BGRX: u32 = 8;
pub const VIDEO_XRGB: u32 = 9;
pub const VIDEO_XBGR: u32 = 10;
pub const VIDEO_RGBA: u32 = 11;
pub const VIDEO_BGRA: u32 = 12;
pub const VIDEO_ARGB: u32 = 13;
pub const VIDEO_ABGR: u32 = 14;

const STREAM_AUTOCONNECT: u32 = 1 << 0;
const STREAM_MAP_BUFFERS: u32 = 1 << 2;
const STATE_ERROR: c_int = -1;
const STATE_UNCONNECTED: c_int = 0;
const DIRECTION_INPUT: u32 = 0;
const CHUNK_CORRUPTED: i32 = 1;

#[repr(C)]
struct SpaChunk {
    offset: u32,
    size: u32,
    stride: i32,
    flags: i32,
}

#[repr(C)]
struct SpaData {
    kind: u32,
    flags: u32,
    fd: i64,
    mapoffset: u32,
    maxsize: u32,
    data: *mut c_void,
    chunk: *mut SpaChunk,
}

#[repr(C)]
struct SpaBuffer {
    n_metas: u32,
    n_datas: u32,
    metas: *mut c_void,
    datas: *mut SpaData,
}

#[repr(C)]
struct PwBuffer {
    buffer: *mut SpaBuffer,
}

/// `struct pw_stream_events`, version 0: the callbacks up to `drained`.
#[repr(C)]
struct StreamEvents {
    version: u32,
    destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    state_changed: Option<unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char)>,
    control_info: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    io_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32)>,
    param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    add_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut PwBuffer)>,
    remove_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut PwBuffer)>,
    process: Option<unsafe extern "C" fn(*mut c_void)>,
    drained: Option<unsafe extern "C" fn(*mut c_void)>,
}

static EVENTS: StreamEvents = StreamEvents { version: 0, destroy: None, state_changed: Some(on_state), control_info: None, io_changed: None, param_changed: Some(on_param), add_buffer: None, remove_buffer: None, process: Some(on_process), drained: None };

macro_rules! library {
    ($($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        #[allow(non_snake_case)]
        struct Library {
            $($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
        }

        impl Library {
            /// Safety: each symbol must have the declared C signature, as PipeWire 0.3 exports it.
            unsafe fn load() -> Option<Self> {
                let handle = libc::dlopen(c"libpipewire-0.3.so.0".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
                if handle.is_null() {
                    return None;
                }
                Some(Self {
                    $($name: {
                        let symbol = libc::dlsym(handle, concat!(stringify!($name), "\0").as_ptr().cast());
                        if symbol.is_null() {
                            return None;
                        }
                        std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($arg),*) $(-> $ret)?>(symbol)
                    },)*
                })
            }
        }
    };
}

library! {
    pw_init: fn(*mut c_int, *mut *mut *mut c_char);
    pw_thread_loop_new: fn(*const c_char, *const c_void) -> *mut c_void;
    pw_thread_loop_get_loop: fn(*mut c_void) -> *mut c_void;
    pw_thread_loop_start: fn(*mut c_void) -> c_int;
    pw_thread_loop_stop: fn(*mut c_void);
    pw_thread_loop_lock: fn(*mut c_void);
    pw_thread_loop_unlock: fn(*mut c_void);
    pw_thread_loop_destroy: fn(*mut c_void);
    pw_context_new: fn(*mut c_void, *mut c_void, usize) -> *mut c_void;
    pw_context_connect: fn(*mut c_void, *mut c_void, usize) -> *mut c_void;
    pw_context_connect_fd: fn(*mut c_void, c_int, *mut c_void, usize) -> *mut c_void;
    pw_context_destroy: fn(*mut c_void);
    pw_core_disconnect: fn(*mut c_void) -> c_int;
    pw_properties_new_string: fn(*const c_char) -> *mut c_void;
    pw_stream_new: fn(*mut c_void, *const c_char, *mut c_void) -> *mut c_void;
    pw_stream_add_listener: fn(*mut c_void, *mut c_void, *const StreamEvents, *mut c_void);
    pw_stream_connect: fn(*mut c_void, u32, u32, u32, *const *const c_void, u32) -> c_int;
    pw_stream_dequeue_buffer: fn(*mut c_void) -> *mut PwBuffer;
    pw_stream_queue_buffer: fn(*mut c_void, *mut PwBuffer) -> c_int;
    pw_stream_disconnect: fn(*mut c_void) -> c_int;
    pw_stream_destroy: fn(*mut c_void);
}

static LIBRARY: OnceLock<Option<Library>> = OnceLock::new();

fn library() -> Option<&'static Library> {
    LIBRARY
        .get_or_init(|| {
            // Safety: the declarations above match PipeWire 0.3's headers.
            let library = unsafe { Library::load() }?;
            unsafe { (library.pw_init)(std::ptr::null_mut(), std::ptr::null_mut()) };
            Some(library)
        })
        .as_ref()
}

pub fn installed() -> bool {
    library().is_some()
}

/// What the stream callbacks share with the rest, on PipeWire's own thread.
struct Inner {
    stream: AtomicPtr<c_void>,
    format: AtomicU32,
    size: Mutex<(u32, u32)>,
    latest: Arc<Mutex<Option<image::RgbImage>>>,
    closed: Arc<AtomicBool>,
}

/// One window's stream. Dropping it stops the stream and frees what PipeWire holds.
pub struct Frames {
    library: &'static Library,
    thread_loop: *mut c_void,
    context: *mut c_void,
    core: *mut c_void,
    stream: *mut c_void,
    // The hook and the shared state must outlive the stream; they go after it.
    _hook: Box<[usize; 16]>,
    inner: *mut Inner,
    pub latest: Arc<Mutex<Option<image::RgbImage>>>,
    pub closed: Arc<AtomicBool>,
}

// Safety: the pointers are used only under the thread loop's lock, or after it has stopped.
unsafe impl Send for Frames {}
unsafe impl Sync for Frames {}

/// Where the stream connects: the portal's own PipeWire connection, or the local daemon.
pub enum Remote {
    Portal(OwnedFd),
    #[cfg_attr(not(test), allow(dead_code))]
    Local,
}

impl Frames {
    pub fn start(remote: Remote, node: u32) -> Result<Self, String> {
        let library = library().ok_or("PipeWire is not installed, so a shared window cannot be seen.")?;
        let failed = |what: &str| format!("PipeWire could not {what}.");
        let latest = Arc::new(Mutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let inner = Box::into_raw(Box::new(Inner { stream: AtomicPtr::new(std::ptr::null_mut()), format: AtomicU32::new(0), size: Mutex::new((0, 0)), latest: latest.clone(), closed: closed.clone() }));
        let hook = Box::new([0usize; 16]);
        let format = format_offer();
        // Safety: PipeWire objects are made and connected before the loop thread runs, and every
        // pointer is checked; on failure what was made is freed below.
        unsafe {
            let thread_loop = (library.pw_thread_loop_new)(c"runrail-computer".as_ptr(), std::ptr::null());
            if thread_loop.is_null() {
                drop(Box::from_raw(inner));
                return Err(failed("start"));
            }
            let context = (library.pw_context_new)((library.pw_thread_loop_get_loop)(thread_loop), std::ptr::null_mut(), 0);
            let core = if context.is_null() {
                std::ptr::null_mut()
            } else {
                match remote {
                    Remote::Portal(fd) => (library.pw_context_connect_fd)(context, fd.into_raw_fd(), std::ptr::null_mut(), 0),
                    Remote::Local => (library.pw_context_connect)(context, std::ptr::null_mut(), 0),
                }
            };
            let stream = if core.is_null() {
                std::ptr::null_mut()
            } else {
                // The stream takes the properties over.
                let properties = (library.pw_properties_new_string)(c"media.type=Video media.category=Capture media.role=Screen".as_ptr());
                (library.pw_stream_new)(core, c"Runrail computer use".as_ptr(), properties)
            };
            let mut frames = Frames { library, thread_loop, context, core, stream, _hook: hook, inner, latest, closed };
            if stream.is_null() {
                return Err(failed("connect to the shared window"));
            }
            (*inner).stream.store(stream, Ordering::Release);
            (library.pw_stream_add_listener)(stream, frames._hook.as_mut_ptr().cast(), &EVENTS, inner.cast());
            let params = [format.as_ptr().cast::<c_void>()];
            if (library.pw_stream_connect)(stream, DIRECTION_INPUT, node, STREAM_AUTOCONNECT | STREAM_MAP_BUFFERS, params.as_ptr(), 1) < 0 {
                return Err(failed("open the shared window's stream"));
            }
            if (library.pw_thread_loop_start)(thread_loop) < 0 {
                frames.thread_loop = std::ptr::null_mut();
                (library.pw_thread_loop_destroy)(thread_loop);
                return Err(failed("start"));
            }
            Ok(frames)
        }
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        let library = self.library;
        // Safety: the loop thread is held off while the stream goes, then stopped before the rest.
        unsafe {
            if !self.thread_loop.is_null() {
                (library.pw_thread_loop_lock)(self.thread_loop);
            }
            if !self.stream.is_null() {
                (library.pw_stream_disconnect)(self.stream);
                (library.pw_stream_destroy)(self.stream);
            }
            if !self.core.is_null() {
                (library.pw_core_disconnect)(self.core);
            }
            if !self.thread_loop.is_null() {
                (library.pw_thread_loop_unlock)(self.thread_loop);
                (library.pw_thread_loop_stop)(self.thread_loop);
            }
            if !self.context.is_null() {
                (library.pw_context_destroy)(self.context);
            }
            if !self.thread_loop.is_null() {
                (library.pw_thread_loop_destroy)(self.thread_loop);
            }
            drop(Box::from_raw(self.inner));
        }
    }
}

unsafe extern "C" fn on_state(data: *mut c_void, _old: c_int, now: c_int, _error: *const c_char) {
    let inner = &*(data as *const Inner);
    if now == STATE_ERROR || now == STATE_UNCONNECTED {
        inner.closed.store(true, Ordering::Relaxed);
    }
}

unsafe extern "C" fn on_param(data: *mut c_void, id: u32, param: *const c_void) {
    if id != PARAM_FORMAT || param.is_null() {
        return;
    }
    let inner = &*(data as *const Inner);
    let header = std::slice::from_raw_parts(param.cast::<u8>(), 8);
    let size = u32::from_ne_bytes([header[0], header[1], header[2], header[3]]) as usize;
    let pod = std::slice::from_raw_parts(param.cast::<u8>(), 8 + size);
    if let Some((format, width, height)) = read_format(pod) {
        inner.format.store(format, Ordering::Relaxed);
        if let Ok(mut known) = inner.size.lock() {
            *known = (width, height);
        }
    }
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    let inner = &*(data as *const Inner);
    let Some(library) = library() else { return };
    let stream = inner.stream.load(Ordering::Acquire);
    let buffer = (library.pw_stream_dequeue_buffer)(stream);
    if buffer.is_null() {
        return;
    }
    let spa = (*buffer).buffer;
    if !spa.is_null() && (*spa).n_datas > 0 && !(*spa).datas.is_null() {
        let first = &*(*spa).datas;
        let (width, height) = inner.size.lock().map(|size| *size).unwrap_or_default();
        if !first.data.is_null() && !first.chunk.is_null() && width > 0 && height > 0 {
            let chunk = &*first.chunk;
            // A window stream also sends empty buffers that only move the cursor.
            if chunk.size > 0 && chunk.flags & CHUNK_CORRUPTED == 0 && chunk.offset < first.maxsize {
                let length = (chunk.size as usize).min((first.maxsize - chunk.offset) as usize);
                let bytes = std::slice::from_raw_parts(first.data.cast::<u8>().add(chunk.offset as usize), length);
                if let Some(order) = channel_order(inner.format.load(Ordering::Relaxed)) {
                    let stride = usize::try_from(chunk.stride).ok().filter(|stride| *stride > 0).unwrap_or(width as usize * 4);
                    if let Some(image) = to_rgb(bytes, width as usize, height as usize, stride, order) {
                        if let Ok(mut latest) = inner.latest.lock() {
                            *latest = Some(image);
                        }
                    }
                }
            }
        }
    }
    (library.pw_stream_queue_buffer)(stream, buffer);
}

/// Where red, green, and blue sit in a 4-byte pixel of each format offered.
pub fn channel_order(format: u32) -> Option<[usize; 3]> {
    Some(match format {
        VIDEO_BGRX | VIDEO_BGRA => [2, 1, 0],
        VIDEO_RGBX | VIDEO_RGBA => [0, 1, 2],
        VIDEO_XRGB | VIDEO_ARGB => [1, 2, 3],
        VIDEO_XBGR | VIDEO_ABGR => [3, 2, 1],
        _ => return None,
    })
}

pub fn to_rgb(bytes: &[u8], width: usize, height: usize, stride: usize, [red, green, blue]: [usize; 3]) -> Option<image::RgbImage> {
    if width == 0 || height == 0 || stride < width * 4 || bytes.len() < stride * (height - 1) + width * 4 {
        return None;
    }
    let mut pixels = Vec::with_capacity(width * height * 3);
    for row in bytes.chunks(stride).take(height) {
        for pixel in row[..width * 4].chunks_exact(4) {
            pixels.extend([pixel[red], pixel[green], pixel[blue]]);
        }
    }
    image::RgbImage::from_raw(width as u32, height as u32, pixels)
}

/// A pod: its size, its type, and its body padded to 8 bytes.
fn pod(kind: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len().next_multiple_of(8));
    out.extend((body.len() as u32).to_ne_bytes());
    out.extend(kind.to_ne_bytes());
    out.extend(body);
    out.resize(8 + body.len().next_multiple_of(8), 0);
    out
}

fn words(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_ne_bytes()).collect()
}

fn choice(kind: u32, child_type: u32, child_size: u32, values: &[u32]) -> Vec<u8> {
    let mut body = words(&[kind, 0, child_size, child_type]);
    body.extend(words(values));
    pod(TYPE_CHOICE, &body)
}

fn property(key: u32, value: Vec<u8>) -> Vec<u8> {
    let mut out = words(&[key, 0]);
    out.extend(value);
    out
}

/// The formats this side takes: raw video, 32 bits a pixel, any size and rate.
fn format_offer() -> Vec<u8> {
    let mut body = words(&[OBJECT_FORMAT, PARAM_ENUM_FORMAT]);
    body.extend(property(FORMAT_MEDIA_TYPE, pod(TYPE_ID, &words(&[MEDIA_TYPE_VIDEO]))));
    body.extend(property(FORMAT_MEDIA_SUBTYPE, pod(TYPE_ID, &words(&[MEDIA_SUBTYPE_RAW]))));
    body.extend(property(FORMAT_VIDEO_FORMAT, choice(CHOICE_ENUM, TYPE_ID, 4, &[VIDEO_BGRX, VIDEO_BGRX, VIDEO_BGRA, VIDEO_RGBX, VIDEO_RGBA, VIDEO_XRGB, VIDEO_XBGR, VIDEO_ARGB, VIDEO_ABGR])));
    body.extend(property(FORMAT_VIDEO_SIZE, choice(CHOICE_RANGE, TYPE_RECTANGLE, 8, &[1280, 800, 1, 1, 8192, 8192])));
    body.extend(property(FORMAT_VIDEO_FRAMERATE, choice(CHOICE_RANGE, TYPE_FRACTION, 8, &[10, 1, 0, 1, 60, 1])));
    pod(TYPE_OBJECT, &body)
}

fn word(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
}

/// The value a property holds, or a choice's first value.
fn value(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let (size, kind) = (word(bytes, at)? as usize, word(bytes, at + 4)?);
    if kind == TYPE_CHOICE {
        Some((word(bytes, at + 20)?, at + 24))
    } else if size > 0 {
        Some((kind, at + 8))
    } else {
        None
    }
}

/// The video format and size a negotiated Format object settled on.
fn read_format(bytes: &[u8]) -> Option<(u32, u32, u32)> {
    if word(bytes, 4)? != TYPE_OBJECT {
        return None;
    }
    let end = 8 + word(bytes, 0)? as usize;
    let (mut at, mut format, mut size) = (16, None, None);
    while at + 16 <= end.min(bytes.len()) {
        let key = word(bytes, at)?;
        let value_size = word(bytes, at + 8)? as usize;
        if let Some((kind, body)) = value(bytes, at + 8) {
            match (key, kind) {
                (FORMAT_VIDEO_FORMAT, TYPE_ID) => format = word(bytes, body),
                (FORMAT_VIDEO_SIZE, TYPE_RECTANGLE) => size = Some((word(bytes, body)?, word(bytes, body + 4)?)),
                _ => {}
            }
        }
        at += 16 + value_size.next_multiple_of(8);
    }
    let (width, height) = size?;
    Some((format?, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_offer_is_a_format_object_and_reads_back() {
        let offer = format_offer();
        assert_eq!(offer.len() % 8, 0);
        assert_eq!(word(&offer, 0).map(|size| size as usize + 8), Some(offer.len()));
        assert_eq!(word(&offer, 4), Some(TYPE_OBJECT));
        assert_eq!((word(&offer, 8), word(&offer, 12)), (Some(OBJECT_FORMAT), Some(PARAM_ENUM_FORMAT)));
        // The offer's defaults are what a fixed format would hold.
        assert_eq!(read_format(&offer), Some((VIDEO_BGRX, 1280, 800)));
    }

    #[test]
    fn a_settled_format_is_read() {
        let mut body = words(&[OBJECT_FORMAT, PARAM_FORMAT]);
        body.extend(property(FORMAT_MEDIA_TYPE, pod(TYPE_ID, &words(&[MEDIA_TYPE_VIDEO]))));
        body.extend(property(FORMAT_VIDEO_FORMAT, pod(TYPE_ID, &words(&[VIDEO_RGBA]))));
        body.extend(property(FORMAT_VIDEO_SIZE, pod(TYPE_RECTANGLE, &words(&[640, 480]))));
        assert_eq!(read_format(&pod(TYPE_OBJECT, &body)), Some((VIDEO_RGBA, 640, 480)));
        assert_eq!(read_format(&pod(TYPE_ID, &words(&[1]))), None);
    }

    #[test]
    fn frames_are_read_in_their_own_layout_and_stride() {
        // Two BGRx pixels a row, rows padded to 12 bytes.
        let bytes = [0x30, 0x20, 0x10, 0, 0xff, 0xff, 0xff, 0, 9, 9, 9, 9, 3, 2, 1, 0, 0, 0, 0, 0];
        let image = to_rgb(&bytes, 2, 2, 12, channel_order(VIDEO_BGRX).unwrap()).unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [0x10, 0x20, 0x30]);
        assert_eq!(image.get_pixel(1, 0).0, [0xff, 0xff, 0xff]);
        assert_eq!(image.get_pixel(0, 1).0, [1, 2, 3]);
        assert_eq!(to_rgb(&[0xff, 1, 2, 3], 1, 1, 4, channel_order(VIDEO_ARGB).unwrap()).unwrap().get_pixel(0, 0).0, [1, 2, 3]);
        assert!(channel_order(15).is_none());
        assert!(to_rgb(&bytes, 2, 2, 4, [0, 1, 2]).is_none());
        assert!(to_rgb(&bytes[..15], 2, 2, 12, [0, 1, 2]).is_none());
    }

    /// Run by hand where a PipeWire daemon and a session manager run, with the id of a video
    /// source node in RUNRAIL_PIPEWIRE_NODE.
    #[test]
    #[ignore]
    fn frames_arrive_from_a_running_pipewire() {
        let node: u32 = std::env::var("RUNRAIL_PIPEWIRE_NODE").expect("RUNRAIL_PIPEWIRE_NODE").parse().unwrap();
        let frames = Frames::start(Remote::Local, node).unwrap();
        let started = std::time::Instant::now();
        while frames.latest.lock().unwrap().is_none() {
            assert!(started.elapsed().as_secs() < 10, "no frame came");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let image = frames.latest.lock().unwrap().clone().unwrap();
        println!("frame {}x{} first pixel {:?}", image.width(), image.height(), image.get_pixel(0, 0).0);
        drop(frames);
    }
}
