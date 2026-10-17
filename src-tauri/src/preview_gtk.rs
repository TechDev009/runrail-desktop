//! Browser previews on Linux. Tauri 2.12 packs a child webview into the window's
//! GtkBox next to the main page, where it cannot be placed (tauri#10420). Here the main page sits
//! in a GtkOverlay whose top layer is a GtkFixed; each preview moves into that layer and is placed
//! there as a native view is on macOS. The layer takes pointer input only where a preview shows,
//! so the page under it keeps the rest. GTK work runs on the main thread only.

use std::cell::RefCell;
use std::sync::mpsc;
use std::time::Duration;

use gtk::gdk::ModifierType;
use gtk::glib;
use gtk::prelude::*;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Webview, WebviewBuilder, WebviewWindow, Window, Wry};
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

use crate::preview::Bounds;

/// The page takes a shortcut pressed in a preview as if from the app menu it has on macOS.
pub const SHORTCUT_EVENT: &str = "preview:shortcut";
const WAIT: Duration = Duration::from_secs(10);

/// Every shortcut in `src/ui/shell/shortcuts.ts`, which a test keeps in step.
const SHORTCUT_KEYS: &[&str] = &[
    "mod+k", "mod+shift+f", "mod+n", "mod+o", "mod+,", "mod+/", "mod+1", "mod+2", "mod+3", "mod+4", "mod+5", "mod+7", "mod+6", "mod+8", "mod+b", "mod+alt+b", "mod+shift+d", "mod+p", "mod+j", "mod+shift+a", "mod+shift+b", "mod+t", "mod+w", "ctrl+tab", "ctrl+shift+tab", "mod+shift+[", "mod+shift+]",
    "mod+l", "mod+f", "mod+.", "mod+shift+m", "mod+i",
];

thread_local! {
    static LAYER: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) };
}

/// Puts the main page under the preview layer. Called once at start, before the window shows,
/// since moving a live page drops its keyboard focus.
pub fn install(window: &WebviewWindow) {
    let _ = window.with_webview(|platform| {
        if let Some(layer) = layer_over(&platform.inner()) {
            LAYER.with(|cell| *cell.borrow_mut() = Some(layer));
        }
    });
}

fn layer_over(page: &webkit2gtk::WebView) -> Option<gtk::Fixed> {
    let parent = page.parent()?.downcast::<gtk::Box>().ok()?;
    let position = parent.child_position(page);
    let overlay = gtk::Overlay::new();
    let layer = gtk::Fixed::new();
    // The window shows itself with show_all, which would also show every hidden preview.
    layer.set_no_show_all(true);
    layer.connect_realize(reshape);
    layer.connect_size_allocate(|layer, _| reshape(layer));
    layer.connect_remove(|layer, _| reshape(layer));
    layer.connect_map(reshape);
    let above = layer.clone();
    page.connect_map(move |_| reshape(&above));
    parent.remove(page);
    overlay.add(page);
    overlay.add_overlay(&layer);
    parent.pack_start(&overlay, true, true, 0);
    parent.reorder_child(&overlay, position);
    layer.show();
    overlay.show();
    Some(layer)
}

/// Lets pointer input through the layer except where a preview shows. The layer draws on a window
/// of its own, which GtkOverlay makes for it; the page's window is never shaped.
fn reshape(layer: &gtk::Fixed) {
    let Some(window) = layer.window() else { return };
    if layer.parent().and_then(|overlay| overlay.window()).as_ref() == Some(&window) {
        return;
    }
    let region = gtk::cairo::Region::create();
    for child in layer.children() {
        if child.is_visible() {
            let (width, height) = child.size_request();
            let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(layer.child_x(&child), layer.child_y(&child), width.max(0), height.max(0)));
        }
    }
    window.input_shape_combine_region(&region, 0, 0);
    // Mapping the page shows its window, which also raises it over the layer's.
    if window.parent().is_some_and(|parent| parent.children().first() != Some(&window)) {
        window.raise();
    }
}

fn reshape_around(view: &impl IsA<gtk::Widget>) {
    if let Some(layer) = view.parent().and_then(|parent| parent.downcast::<gtk::Fixed>().ok()) {
        reshape(&layer);
    }
}

fn rect(bounds: Bounds) -> (i32, i32, i32, i32) {
    let whole = |value: f64| value.round() as i32;
    (whole(bounds.x), whole(bounds.y), whole(bounds.width).max(1), whole(bounds.height).max(1))
}

/// Makes a preview and moves it into the layer in the same main-thread turn, before GTK lays the
/// window out with the preview in its box. None when there is no layer to put it in.
pub fn add_child(window: &Window, app: &AppHandle, builder: WebviewBuilder<Wry>, bounds: Bounds) -> Option<Webview> {
    let (made_sender, made) = mpsc::channel();
    let (adopted_sender, adopted) = mpsc::channel();
    let (parent, app) = (window.clone(), app.clone());
    window
        .run_on_main_thread(move || {
            let webview = parent.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height)).ok();
            if let Some(webview) = &webview {
                let _ = webview.with_webview(move |platform| {
                    let _ = adopted_sender.send(adopt(app, &platform.inner(), bounds));
                });
            }
            let _ = made_sender.send(webview);
        })
        .ok()?;
    let webview = made.recv_timeout(WAIT).ok().flatten()?;
    if adopted.recv_timeout(WAIT) == Ok(true) {
        Some(webview)
    } else {
        let _ = webview.close();
        None
    }
}

fn adopt(app: AppHandle, view: &webkit2gtk::WebView, bounds: Bounds) -> bool {
    let Some(layer) = LAYER.with(|cell| cell.borrow().clone()) else { return false };
    if let Some(parent) = view.parent().and_then(|parent| parent.downcast::<gtk::Container>().ok()) {
        parent.remove(view);
    }
    let (x, y, width, height) = rect(bounds);
    view.set_size_request(width, height);
    layer.put(view, x, y);
    view.connect_show(|view| reshape_around(view));
    view.connect_hide(|view| reshape_around(view));
    view.connect_key_press_event(move |view, event| {
        let Some(keys) = shortcut_of(event) else { return glib::Propagation::Proceed };
        // The page takes the keyboard back, so a shortcut that focuses something there works.
        if let Some(page) = view.parent().and_then(|layer| layer.parent()).and_then(|overlay| overlay.downcast::<gtk::Overlay>().ok()).and_then(|overlay| overlay.child()) {
            page.grab_focus();
        }
        let _ = app.emit(SHORTCUT_EVENT, keys);
        glib::Propagation::Stop
    });
    view.show();
    reshape(&layer);
    true
}

/// Places a preview in the layer and shows it.
pub fn place(webview: &Webview, bounds: Bounds) -> bool {
    webview
        .with_webview(move |platform| {
            let view = platform.inner();
            let Some(layer) = view.parent().and_then(|parent| parent.downcast::<gtk::Fixed>().ok()) else { return };
            let (x, y, width, height) = rect(bounds);
            view.set_size_request(width, height);
            layer.move_(&view, x, y);
            view.show();
            reshape(&layer);
        })
        .is_ok()
}

/// What a preview shows, as RGB pixels at most `points_wide` points wide; never scaled up.
pub fn snapshot(webview: &Webview, points_wide: f64) -> Option<image::RgbImage> {
    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let view = platform.inner();
            let widest = (points_wide * f64::from(view.scale_factor().max(1))).round().max(1.0) as u32;
            view.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gtk::gio::Cancellable>, move |taken| {
                let _ = sender.send(taken.ok().and_then(rgb).map(|image| (image, widest)));
            });
        })
        .ok()?;
    let (image, widest) = receiver.recv_timeout(WAIT).ok().flatten()?;
    if image.width() <= widest {
        return Some(image);
    }
    let height = (u64::from(image.height()) * u64::from(widest) / u64::from(image.width())).max(1) as u32;
    Some(image::imageops::resize(&image, widest, height, image::imageops::FilterType::Triangle))
}

/// A cairo image as RGB, transparent parts over white.
fn rgb(surface: gtk::cairo::Surface) -> Option<image::RgbImage> {
    let surface = gtk::cairo::ImageSurface::try_from(surface).ok()?;
    let opaque = match surface.format() {
        gtk::cairo::Format::Rgb24 => true,
        gtk::cairo::Format::ARgb32 => false,
        _ => return None,
    };
    let (width, height, stride) = (usize::try_from(surface.width()).ok()?, usize::try_from(surface.height()).ok()?, usize::try_from(surface.stride()).ok()?);
    if width == 0 || height == 0 {
        return None;
    }
    let mut pixels = Vec::with_capacity(width * height * 3);
    surface
        .with_data(|data| {
            for row in data.chunks(stride).take(height) {
                // Cairo keeps each pixel as a native-endian 0xAARRGGBB word, alpha premultiplied.
                for word in row[..width * 4].chunks_exact(4) {
                    let value = u32::from_ne_bytes([word[0], word[1], word[2], word[3]]);
                    let under = if opaque { 0 } else { 255 - (value >> 24) as u8 };
                    for shift in [16, 8, 0] {
                        pixels.push(((value >> shift) as u8).saturating_add(under));
                    }
                }
            }
        })
        .ok()?;
    image::RgbImage::from_raw(width as u32, height as u32, pixels)
}

/// Where a preview is, relative to the main page, and whether it shows (the automation socket).
#[cfg(debug_assertions)]
pub fn frame(webview: &Webview) -> Option<serde_json::Value> {
    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let view = platform.inner();
            let page = view.parent().and_then(|layer| layer.parent()).and_then(|overlay| overlay.downcast::<gtk::Overlay>().ok()).and_then(|overlay| overlay.child());
            let at = page.and_then(|page| view.translate_coordinates(&page, 0, 0));
            let _ = sender.send(at.map(|(x, y)| serde_json::json!({ "x": x, "y": y, "width": view.allocated_width(), "height": view.allocated_height(), "visible": view.is_visible() && view.is_mapped() })));
        })
        .ok()?;
    receiver.recv_timeout(WAIT).ok().flatten()
}

struct Pressed {
    key: Option<String>,
    code: Option<String>,
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

fn shortcut_of(event: &gtk::gdk::EventKey) -> Option<&'static str> {
    let state = event.state();
    let keyval = event.keyval();
    let tab = keyval == gtk::gdk::keys::constants::Tab || keyval == gtk::gdk::keys::constants::ISO_Left_Tab;
    let pressed = Pressed {
        key: if tab { Some("tab".into()) } else { keyval.to_lower().to_unicode().filter(|char| !char.is_control()).map(|char| char.to_lowercase().to_string()) },
        code: physical_key(event.hardware_keycode()),
        ctrl: state.contains(ModifierType::CONTROL_MASK),
        shift: state.contains(ModifierType::SHIFT_MASK),
        alt: state.contains(ModifierType::MOD1_MASK),
        meta: state.intersects(ModifierType::SUPER_MASK | ModifierType::META_MASK),
    };
    SHORTCUT_KEYS.iter().copied().find(|keys| matches(&pressed, keys))
}

/// The key's place on a US keyboard, named as the page's `KeyboardEvent.code` names it. X and
/// Wayland both number keys as evdev codes plus 8.
fn physical_key(keycode: u16) -> Option<String> {
    const ROWS: &[(u16, &str)] = &[(10, "1234567890"), (24, "qwertyuiop"), (38, "asdfghjkl"), (52, "zxcvbnm")];
    for (first, keys) in ROWS {
        if let Some(char) = keycode.checked_sub(*first).and_then(|index| keys.chars().nth(usize::from(index))) {
            return Some(if char.is_ascii_digit() { format!("Digit{char}") } else { format!("Key{}", char.to_ascii_uppercase()) });
        }
    }
    let named = match keycode {
        34 => "BracketLeft",
        35 => "BracketRight",
        59 => "Comma",
        60 => "Period",
        61 => "Slash",
        _ => return None,
    };
    Some(named.into())
}

/// `matches` in `src/lib/format.ts` off macOS, where "mod" is Control.
fn matches(pressed: &Pressed, keys: &str) -> bool {
    let parts: Vec<&str> = keys.split('+').collect();
    let key = parts.last().copied().unwrap_or_default();
    let ctrl = parts.contains(&"ctrl") || parts.contains(&"mod");
    if ctrl != pressed.ctrl || parts.contains(&"shift") != pressed.shift || parts.contains(&"alt") != pressed.alt || pressed.meta {
        return false;
    }
    let typed = pressed.key.as_deref().unwrap_or_default();
    let code = pressed.code.as_deref();
    match key {
        "[" => code == Some("BracketLeft"),
        "]" => code == Some("BracketRight"),
        "," => typed == ",",
        "." => typed == "." || code == Some("Period"),
        "/" => typed == "/" || code == Some("Slash"),
        _ if key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase() => typed == key || code == Some(format!("Key{}", key.to_ascii_uppercase()).as_str()),
        _ if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() => typed == key || code == Some(format!("Digit{key}").as_str()),
        _ => typed == key,
    }
}

/// WebKitGTK's DMA-BUF renderer shows blank or broken pages with NVIDIA's own driver and in VMware
/// and VirtualBox guests; there it falls back to its older path. A value the person set wins.
/// Call before any thread starts and before GTK does.
pub fn renderer_fallback() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() || std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some() {
        return;
    }
    let drivers: Vec<String> = std::fs::read_dir("/sys/class/drm")
        .map(|cards| cards.flatten().filter_map(|card| std::fs::read_link(card.path().join("device/driver")).ok()).filter_map(|driver| driver.file_name().map(|name| name.to_string_lossy().into_owned())).collect())
        .unwrap_or_default();
    if needs_fallback(std::path::Path::new("/proc/driver/nvidia/version").exists(), &drivers) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn needs_fallback(nvidia: bool, drivers: &[String]) -> bool {
    nvidia || drivers.iter().any(|driver| matches!(driver.as_str(), "nvidia" | "vmwgfx" | "vboxvideo"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pressed(key: &str, code: Option<&str>, modifiers: &str) -> Pressed {
        Pressed { key: Some(key.into()), code: code.map(Into::into), ctrl: modifiers.contains('c'), shift: modifiers.contains('s'), alt: modifiers.contains('a'), meta: modifiers.contains('m') }
    }

    fn found(pressed: &Pressed) -> Option<&'static str> {
        SHORTCUT_KEYS.iter().copied().find(|keys| matches(pressed, keys))
    }

    #[test]
    fn app_shortcuts_are_caught_and_page_keys_are_not() {
        assert_eq!(found(&pressed("k", Some("KeyK"), "c")), Some("mod+k"));
        assert_eq!(found(&pressed("{", Some("BracketLeft"), "cs")), Some("mod+shift+["));
        assert_eq!(found(&pressed("tab", None, "cs")), Some("ctrl+shift+tab"));
        assert_eq!(found(&pressed("b", Some("KeyB"), "ca")), Some("mod+alt+b"));
        // A layout whose B key types another letter still reaches the shortcut by its place.
        assert_eq!(found(&pressed("x", Some("KeyB"), "cs")), Some("mod+shift+b"));
        assert_eq!(found(&pressed("!", Some("Digit1"), "cs")), None);
        assert_eq!(found(&pressed("1", Some("Digit1"), "c")), Some("mod+1"));
        for (key, code, modifiers) in [("c", "KeyC", "c"), ("v", "KeyV", "c"), ("a", "KeyA", "c"), ("z", "KeyZ", "cs"), ("k", "KeyK", ""), ("k", "KeyK", "cm"), ("r", "KeyR", "c")] {
            assert_eq!(found(&pressed(key, Some(code), modifiers)), None, "{modifiers} {key}");
        }
    }

    #[test]
    fn keys_are_named_by_their_place() {
        assert_eq!(physical_key(10).as_deref(), Some("Digit1"));
        assert_eq!(physical_key(19).as_deref(), Some("Digit0"));
        assert_eq!(physical_key(24).as_deref(), Some("KeyQ"));
        assert_eq!(physical_key(46).as_deref(), Some("KeyL"));
        assert_eq!(physical_key(56).as_deref(), Some("KeyB"));
        assert_eq!(physical_key(34).as_deref(), Some("BracketLeft"));
        assert_eq!(physical_key(9), None);
        assert_eq!(physical_key(47), None);
    }

    #[test]
    fn the_list_is_the_apps_own() {
        let source = include_str!("../../src/ui/shell/shortcuts.ts");
        let table = &source[source.find("export const SHORTCUTS").unwrap()..source.find("export const COMPOSER_KEYS").unwrap()];
        let mut theirs: Vec<&str> = table.split("keys: \"").skip(1).map(|rest| &rest[..rest.find('"').unwrap()]).collect();
        let mut ours = SHORTCUT_KEYS.to_vec();
        theirs.sort_unstable();
        ours.sort_unstable();
        assert_eq!(ours, theirs);
    }

    #[test]
    fn only_drivers_known_to_fail_turn_the_renderer_off() {
        assert!(needs_fallback(true, &[]));
        assert!(needs_fallback(false, &["i915".into(), "vmwgfx".into()]));
        assert!(needs_fallback(false, &["vboxvideo".into()]));
        assert!(!needs_fallback(false, &["i915".into(), "amdgpu".into(), "virtio-pci".into(), "nouveau".into()]));
    }

    #[test]
    fn bounds_become_whole_points() {
        assert_eq!(rect(Bounds { x: 10.4, y: 0.6, width: 0.2, height: 300.5 }), (10, 1, 1, 301));
    }
}
