//! The X11 side of computer use: the X server lists the windows, captures one, raises it, and
//! takes the input (XTest). Every call opens its own connection and closes it when done.

use std::time::{Duration, Instant};

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::res::{ClientIdMask, ClientIdSpec, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, ImageFormat, ImageOrder, InputFocus, MapState, StackMode, WindowClass};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::CURRENT_TIME;

use super::super::{Rect, Window};

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        WM_STATE,
        UTF8_STRING,
        _NET_SUPPORTED,
        _NET_SUPPORTING_WM_CHECK,
        _NET_ACTIVE_WINDOW,
        _NET_WM_PID,
        _NET_WM_NAME,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_NORMAL,
        _NET_WM_WINDOW_TYPE_DIALOG,
        _NET_WM_WINDOW_TYPE_UTILITY,
        _NET_WM_WINDOW_TYPE_TOOLBAR,
        _NET_WM_WINDOW_TYPE_MENU,
        _GTK_APPLICATION_ID,
    }
}

/// One window on screen, front to back, with what names its app.
#[derive(Clone, Debug, PartialEq)]
pub struct Client {
    /// The app's own window: its id, the part of it on screen, and its process.
    pub window: Window,
    /// The window manager's frame around it, which is what a click there would hit.
    pub frame: Rect,
    /// Its WM_CLASS instance and class, its GTK application id, and its program's file name.
    pub ids: Vec<String>,
}

pub struct X11 {
    conn: RustConnection,
    root: xproto::Window,
    screen: usize,
    size: (u16, u16),
    atoms: Atoms,
    /// The input extension, without which nothing can be clicked or typed.
    pub xtest: bool,
}

const SHIFT_L: u32 = 0xffe1;
const CONTROL_L: u32 = 0xffe3;
const ALT_L: u32 = 0xffe9;
const RETURN: u32 = 0xff0d;
const TAB: u32 = 0xff09;

impl X11 {
    pub fn connect() -> Option<Self> {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let (root, size) = {
            let screen = conn.setup().roots.get(screen)?;
            (screen.root, (screen.width_in_pixels, screen.height_in_pixels))
        };
        let atoms = Atoms::new(&conn).ok()?.reply().ok()?;
        let xtest = conn.extension_information(xtest::X11_EXTENSION_NAME).ok().flatten().is_some();
        Some(Self { conn, root, screen, size, atoms, xtest })
    }

    fn property(&self, window: xproto::Window, property: xproto::Atom, kind: impl Into<xproto::Atom>) -> Option<xproto::GetPropertyReply> {
        self.conn.get_property(false, window, property, kind, 0, 4096).ok()?.reply().ok().filter(|reply| reply.type_ != x11rb::NONE)
    }

    fn cardinal(&self, window: xproto::Window, property: xproto::Atom) -> Option<u32> {
        self.property(window, property, xproto::AtomEnum::ANY).and_then(|reply| reply.value32().and_then(|mut values| values.next()))
    }

    fn text(&self, window: xproto::Window, property: impl Into<xproto::Atom>) -> Option<String> {
        let reply = self.property(window, property.into(), xproto::AtomEnum::ANY)?;
        Some(String::from_utf8_lossy(&reply.value).trim_end_matches('\0').to_string()).filter(|text| !text.is_empty())
    }

    /// Windows on screen, front to back: an app's own windows, and the menus, panels, and other
    /// windows that could sit over them.
    pub fn windows(&self) -> Vec<Client> {
        let Some(tree) = self.conn.query_tree(self.root).ok().and_then(|cookie| cookie.reply().ok()) else { return Vec::new() };
        let screen = Rect { x: 0.0, y: 0.0, width: f64::from(self.size.0), height: f64::from(self.size.1) };
        let mut clients = Vec::new();
        for top in tree.children.into_iter().rev() {
            let Some(attributes) = self.conn.get_window_attributes(top).ok().and_then(|cookie| cookie.reply().ok()) else { continue };
            if attributes.map_state != MapState::VIEWABLE || attributes.class == WindowClass::INPUT_ONLY {
                continue;
            }
            let Some(frame) = self.rect(top) else { continue };
            let Some(frame) = intersect(&frame, &screen) else { continue };
            // A managed window sits in its frame and carries WM_STATE; without a window manager the
            // top-level window is the app's own.
            let client = self.client_in(top, 2);
            let own = client.or((!attributes.override_redirect).then_some(top));
            let Some(id) = own else {
                clients.push(Client { window: Window { id: top, pid: -(top as i32), layer: 1, alpha: 1.0, bounds: frame, title: None }, frame, ids: Vec::new() });
                continue;
            };
            let Some(bounds) = self.rect(id).and_then(|rect| intersect(&rect, &screen)) else { continue };
            let pid = self.pid_of(id).map(|pid| pid as i32).unwrap_or(-(id as i32));
            let layer = if attributes.override_redirect || !self.normal_type(id) { 1 } else { 0 };
            let title = self.text(id, self.atoms._NET_WM_NAME).or_else(|| self.text(id, xproto::AtomEnum::WM_NAME));
            let mut ids: Vec<String> = Vec::new();
            if let Some(class) = self.property(id, xproto::AtomEnum::WM_CLASS.into(), xproto::AtomEnum::STRING) {
                ids.extend(class_names(&class.value));
            }
            ids.extend(self.text(id, self.atoms._GTK_APPLICATION_ID));
            if pid > 0 {
                ids.extend(program_name(pid as u32));
            }
            clients.push(Client { window: Window { id, pid, layer, alpha: 1.0, bounds, title }, frame, ids });
        }
        clients
    }

    fn rect(&self, window: xproto::Window) -> Option<Rect> {
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        let at = self.conn.translate_coordinates(window, self.root, 0, 0).ok()?.reply().ok()?;
        Some(Rect { x: f64::from(at.dst_x), y: f64::from(at.dst_y), width: f64::from(geometry.width), height: f64::from(geometry.height) })
    }

    fn client_in(&self, window: xproto::Window, depth: u8) -> Option<xproto::Window> {
        if self.property(window, self.atoms.WM_STATE, self.atoms.WM_STATE).is_some() {
            return Some(window);
        }
        if depth == 0 {
            return None;
        }
        let children = self.conn.query_tree(window).ok()?.reply().ok()?.children;
        children.into_iter().rev().find_map(|child| self.client_in(child, depth - 1))
    }

    /// The process behind a window: the X server knows it for local apps, also sandboxed ones,
    /// whose own _NET_WM_PID is a number inside their sandbox.
    fn pid_of(&self, window: xproto::Window) -> Option<u32> {
        let spec = ClientIdSpec { client: window, mask: ClientIdMask::LOCAL_CLIENT_PID };
        let from_server = self.conn.res_query_client_ids(&[spec]).ok().and_then(|cookie| cookie.reply().ok()).and_then(|reply| reply.ids.into_iter().find_map(|id| id.value.first().copied()));
        from_server.filter(|pid| *pid > 0).or_else(|| self.cardinal(window, self.atoms._NET_WM_PID).filter(|pid| *pid > 0))
    }

    fn normal_type(&self, window: xproto::Window) -> bool {
        let Some(reply) = self.property(window, self.atoms._NET_WM_WINDOW_TYPE, xproto::AtomEnum::ATOM) else { return true };
        let normal = [self.atoms._NET_WM_WINDOW_TYPE_NORMAL, self.atoms._NET_WM_WINDOW_TYPE_DIALOG, self.atoms._NET_WM_WINDOW_TYPE_UTILITY, self.atoms._NET_WM_WINDOW_TYPE_TOOLBAR, self.atoms._NET_WM_WINDOW_TYPE_MENU];
        reply.value32().and_then(|mut kinds| kinds.next()).is_none_or(|kind| normal.contains(&kind))
    }

    fn wm_does(&self, atom: xproto::Atom) -> bool {
        self.cardinal(self.root, self.atoms._NET_SUPPORTING_WM_CHECK).is_some() && self.property(self.root, self.atoms._NET_SUPPORTED, xproto::AtomEnum::ATOM).and_then(|reply| reply.value32().map(|mut atoms| atoms.any(|each| each == atom))).unwrap_or(false)
    }

    /// The window that has the keyboard, as the window manager says, or as the server does.
    pub fn active(&self) -> Option<xproto::Window> {
        if self.wm_does(self.atoms._NET_ACTIVE_WINDOW) {
            return self.cardinal(self.root, self.atoms._NET_ACTIVE_WINDOW).filter(|window| *window != x11rb::NONE);
        }
        self.conn.get_input_focus().ok()?.reply().ok().map(|reply| reply.focus).filter(|window| *window > 1)
    }

    /// Whether a compositing manager draws the screen; then a covered window still has its pixels.
    pub fn composited(&self) -> bool {
        let name = format!("_NET_WM_CM_S{}", self.screen);
        let Some(atom) = self.conn.intern_atom(true, name.as_bytes()).ok().and_then(|cookie| cookie.reply().ok()).map(|reply| reply.atom).filter(|atom| *atom != x11rb::NONE) else { return false };
        self.conn.get_selection_owner(atom).ok().and_then(|cookie| cookie.reply().ok()).is_some_and(|reply| reply.owner != x11rb::NONE)
    }

    /// Raises the window and gives it the keyboard, through the window manager when there is one.
    pub fn activate(&self, client: &Client) -> bool {
        let id = client.window.id;
        if self.in_front(client) {
            return true;
        }
        if self.wm_does(self.atoms._NET_ACTIVE_WINDOW) {
            // Source 2 is a pager acting for the person, which window managers do not hold back.
            let event = ClientMessageEvent::new(32, id, self.atoms._NET_ACTIVE_WINDOW, [2, CURRENT_TIME, 0, 0, 0]);
            if self.conn.send_event(false, self.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).is_err() || self.conn.flush().is_err() {
                return false;
            }
        } else {
            let top = self.top_level(id).unwrap_or(id);
            let _ = self.conn.configure_window(top, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
            let _ = self.conn.set_input_focus(InputFocus::PARENT, id, CURRENT_TIME);
            let _ = self.conn.flush();
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(1_000) {
            if self.in_front(client) {
                // Its window draws a moment after it comes up.
                std::thread::sleep(Duration::from_millis(150));
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn top_level(&self, window: xproto::Window) -> Option<xproto::Window> {
        let mut current = window;
        loop {
            let parent = self.conn.query_tree(current).ok()?.reply().ok()?.parent;
            if parent == self.root || parent == x11rb::NONE {
                return Some(current);
            }
            current = parent;
        }
    }

    /// Whether the app has the keyboard and no other app's window sits over its own; menus,
    /// panels, and the app's own dialogs may.
    fn in_front(&self, client: &Client) -> bool {
        let Some(active) = self.active() else { return false };
        let same_app = |window: xproto::Window| window == client.window.id || (client.window.pid > 0 && self.pid_of(window) == Some(client.window.pid as u32));
        same_app(active) && self.windows().iter().find(|each| each.window.layer == 0).is_some_and(|each| each.window.id == client.window.id || each.window.pid == client.window.pid)
    }

    /// The part of a window on screen as RGB pixels, one per screen pixel.
    pub fn capture(&self, window: &Window) -> Result<image::RgbImage, String> {
        let failed = || "the window could not be captured".to_string();
        let origin = self.conn.translate_coordinates(window.id, self.root, 0, 0).map_err(|_| failed())?.reply().map_err(|_| failed())?;
        let (x, y) = ((window.bounds.x - f64::from(origin.dst_x)) as i16, (window.bounds.y - f64::from(origin.dst_y)) as i16);
        let (width, height) = (window.bounds.width as u16, window.bounds.height as u16);
        let image = self.conn.get_image(ImageFormat::Z_PIXMAP, window.id, x, y, width, height, !0).map_err(|_| failed())?.reply().map_err(|_| failed())?;
        let setup = self.conn.setup();
        let format = setup.pixmap_formats.iter().find(|format| format.depth == image.depth).ok_or_else(failed)?;
        let visual = setup.roots.iter().flat_map(|screen| screen.allowed_depths.iter()).flat_map(|depth| depth.visuals.iter()).find(|visual| visual.visual_id == image.visual).ok_or_else(failed)?;
        let layout = Layout { bits_per_pixel: format.bits_per_pixel, scanline_pad: format.scanline_pad, msb_first: setup.image_byte_order == ImageOrder::MSB_FIRST, masks: (visual.red_mask, visual.green_mask, visual.blue_mask) };
        to_rgb(&image.data, usize::from(width), usize::from(height), &layout).ok_or_else(|| "the screen's pixel format is not one Runrail reads".to_string())
    }

    fn keyboard(&self) -> Option<Keyboard> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = self.conn.get_keyboard_mapping(min, max - min + 1).ok()?.reply().ok()?;
        Some(Keyboard { min, per: reply.keysyms_per_keycode, syms: reply.keysyms, borrowed: None })
    }

    fn fake(&self, kind: u8, detail: u8, at: (i16, i16)) {
        let _ = self.conn.xtest_fake_input(kind, detail, CURRENT_TIME, if kind == xproto::MOTION_NOTIFY_EVENT { self.root } else { x11rb::NONE }, at.0, at.1, 0);
    }

    fn settle(&self) {
        let _ = self.conn.sync();
    }

    pub fn click(&self, point: (f64, f64), right: bool, clicks: i64) {
        let at = (point.0.round() as i16, point.1.round() as i16);
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, at);
        self.settle();
        std::thread::sleep(Duration::from_millis(30));
        let button = if right { 3 } else { 1 };
        for _ in 0..clicks {
            self.fake(xproto::BUTTON_PRESS_EVENT, button, (0, 0));
            self.fake(xproto::BUTTON_RELEASE_EVENT, button, (0, 0));
        }
        self.settle();
    }

    pub fn scroll(&self, point: (f64, f64), dx: i32, dy: i32) {
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, (point.0.round() as i16, point.1.round() as i16));
        self.settle();
        std::thread::sleep(Duration::from_millis(30));
        for (button, steps) in scroll_buttons(dx, dy) {
            for _ in 0..steps {
                self.fake(xproto::BUTTON_PRESS_EVENT, button, (0, 0));
                self.fake(xproto::BUTTON_RELEASE_EVENT, button, (0, 0));
            }
        }
        self.settle();
    }

    /// Presses a key by its keysym with modifiers held, borrowing a free keycode for a symbol the
    /// keyboard has no key for.
    pub fn key(&self, keysym: u32, modifiers: &[u32]) -> bool {
        let Some(mut keyboard) = self.keyboard() else { return false };
        let ok = self.press(&mut keyboard, keysym, modifiers);
        keyboard.restore(self);
        ok
    }

    pub fn type_text(&self, pieces: &[Result<String, u16>]) -> bool {
        let Some(mut keyboard) = self.keyboard() else { return false };
        let mut ok = true;
        'pieces: for piece in pieces {
            match piece {
                Err(code) => ok &= self.press(&mut keyboard, if *code == 48 { TAB } else { RETURN }, &[]),
                Ok(run) => {
                    for char in run.chars() {
                        if !self.press(&mut keyboard, char_keysym(char), &[]) {
                            ok = false;
                            break 'pieces;
                        }
                        std::thread::sleep(Duration::from_millis(3));
                    }
                }
            }
        }
        keyboard.restore(self);
        ok
    }

    fn press(&self, keyboard: &mut Keyboard, keysym: u32, modifiers: &[u32]) -> bool {
        let Some((code, shift)) = keyboard.find(keysym).or_else(|| keyboard.borrow(self, keysym)) else { return false };
        let mut held: Vec<u8> = modifiers.iter().filter_map(|modifier| keyboard.find(*modifier).map(|(code, _)| code)).collect();
        if shift && !modifiers.contains(&SHIFT_L) {
            held.extend(keyboard.find(SHIFT_L).map(|(code, _)| code));
        }
        for code in &held {
            self.fake(xproto::KEY_PRESS_EVENT, *code, (0, 0));
        }
        self.fake(xproto::KEY_PRESS_EVENT, code, (0, 0));
        self.fake(xproto::KEY_RELEASE_EVENT, code, (0, 0));
        for code in held.iter().rev() {
            self.fake(xproto::KEY_RELEASE_EVENT, *code, (0, 0));
        }
        self.settle();
        true
    }
}

/// The keyboard's keycode to keysym table, and the free keycode borrowed for other symbols.
struct Keyboard {
    min: u8,
    per: u8,
    syms: Vec<u32>,
    borrowed: Option<u8>,
}

impl Keyboard {
    fn row(&self, code: u8) -> &[u32] {
        let start = usize::from(code - self.min) * usize::from(self.per);
        self.syms.get(start..start + usize::from(self.per)).unwrap_or_default()
    }

    fn codes(&self) -> impl Iterator<Item = u8> + '_ {
        let count = self.syms.len() / usize::from(self.per.max(1));
        (0..count).map(move |index| self.min + index as u8)
    }

    /// The key that types the symbol, and whether it takes Shift; a capital letter can be the
    /// shifted half of a key listed by its small letter only.
    fn find(&self, keysym: u32) -> Option<(u8, bool)> {
        for column in 0..usize::from(self.per.min(2)) {
            if let Some(code) = self.codes().find(|code| self.row(*code).get(column) == Some(&keysym)) {
                return Some((code, column == 1));
            }
        }
        if (0x41..=0x5a).contains(&keysym) {
            return self.codes().find(|code| self.row(*code).first() == Some(&(keysym + 0x20)) && self.row(*code).get(1).is_none_or(|upper| *upper == 0)).map(|code| (code, true));
        }
        None
    }

    fn spare(&self) -> Option<u8> {
        self.codes().filter(|code| self.row(*code).iter().all(|sym| *sym == 0)).last()
    }

    fn borrow(&mut self, x11: &X11, keysym: u32) -> Option<(u8, bool)> {
        let code = self.borrowed.or_else(|| self.spare())?;
        let syms = vec![keysym; usize::from(self.per)];
        x11.conn.change_keyboard_mapping(1, code, self.per, &syms).ok()?;
        x11.settle();
        // Apps read the new mapping when its notice reaches them, just before the key itself.
        std::thread::sleep(Duration::from_millis(20));
        let start = usize::from(code - self.min) * usize::from(self.per);
        self.syms[start..start + usize::from(self.per)].copy_from_slice(&syms);
        self.borrowed = Some(code);
        Some((code, false))
    }

    fn restore(&mut self, x11: &X11) {
        if let Some(code) = self.borrowed.take() {
            std::thread::sleep(Duration::from_millis(20));
            let _ = x11.conn.change_keyboard_mapping(1, code, self.per, &vec![0; usize::from(self.per)]);
            x11.settle();
        }
    }
}

/// The keysym for an agent's key name, as `key_code` accepts them, and for a modifier.
pub fn keysym(key: &str) -> Option<u32> {
    let named = match key {
        "Return" => RETURN,
        "Tab" => TAB,
        "Space" => 0x20,
        "Backspace" => 0xff08,
        "Escape" => 0xff1b,
        "Delete" => 0xffff,
        "Home" => 0xff50,
        "PageUp" => 0xff55,
        "End" => 0xff57,
        "PageDown" => 0xff56,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        _ => match key.strip_prefix('F').and_then(|number| number.parse::<u32>().ok()) {
            Some(number @ 1..=12) => 0xffbe + number - 1,
            _ => {
                let mut chars = key.chars();
                let char = chars.next()?;
                return (chars.next().is_none() && char.is_ascii_graphic()).then(|| char_keysym(char));
            }
        },
    };
    Some(named)
}

/// Command is Control here: Linux apps copy, paste, and save with Control, and Super belongs to
/// the desktop itself.
pub fn modifier_keysym(name: &str) -> Option<u32> {
    match name {
        "shift" => Some(SHIFT_L),
        "control" | "command" => Some(CONTROL_L),
        "option" => Some(ALT_L),
        _ => None,
    }
}

pub fn char_keysym(char: char) -> u32 {
    let code = u32::from(char);
    if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
        code
    } else {
        0x0100_0000 | code
    }
}

/// Wheel buttons: 4 up, 5 down, 6 left, 7 right, one press a line.
fn scroll_buttons(dx: i32, dy: i32) -> Vec<(u8, u32)> {
    let mut buttons = Vec::new();
    if dy != 0 {
        buttons.push((if dy > 0 { 4 } else { 5 }, dy.unsigned_abs()));
    }
    if dx != 0 {
        buttons.push((if dx > 0 { 6 } else { 7 }, dx.unsigned_abs()));
    }
    buttons
}

fn intersect(a: &Rect, b: &Rect) -> Option<Rect> {
    let (left, top) = (a.x.max(b.x), a.y.max(b.y));
    let (right, bottom) = ((a.x + a.width).min(b.x + b.width), (a.y + a.height).min(b.y + b.height));
    (right - left >= 1.0 && bottom - top >= 1.0).then_some(Rect { x: left, y: top, width: right - left, height: bottom - top })
}

/// WM_CLASS holds the instance and the class, each ending in a zero byte.
fn class_names(value: &[u8]) -> Vec<String> {
    value.split(|byte| *byte == 0).map(|part| String::from_utf8_lossy(part).trim().to_string()).filter(|part| !part.is_empty()).take(2).collect()
}

fn program_name(pid: u32) -> Option<String> {
    let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    path.file_name().map(|name| name.to_string_lossy().trim_end_matches(" (deleted)").to_string()).filter(|name| !name.is_empty())
}

struct Layout {
    bits_per_pixel: u8,
    scanline_pad: u8,
    msb_first: bool,
    masks: (u32, u32, u32),
}

/// A ZPixmap of 24 or 32 bits a pixel, each channel where the visual's mask puts it.
fn to_rgb(data: &[u8], width: usize, height: usize, layout: &Layout) -> Option<image::RgbImage> {
    let bytes = usize::from(layout.bits_per_pixel / 8);
    if !(bytes == 3 || bytes == 4) || width == 0 || height == 0 || layout.scanline_pad < 8 {
        return None;
    }
    let pad = usize::from(layout.scanline_pad);
    let stride = (width * usize::from(layout.bits_per_pixel)).div_ceil(pad) * pad / 8;
    if data.len() < stride * (height - 1) + width * bytes {
        return None;
    }
    let channel = |pixel: u32, mask: u32| -> u8 {
        if mask == 0 {
            return 0;
        }
        let value = (pixel & mask) >> mask.trailing_zeros();
        let top = mask >> mask.trailing_zeros();
        (u64::from(value) * 255 / u64::from(top)) as u8
    };
    let mut pixels = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        for column in 0..width {
            let at = row * stride + column * bytes;
            let raw = &data[at..at + bytes];
            let pixel = if layout.msb_first { raw.iter().fold(0u32, |all, byte| (all << 8) | u32::from(*byte)) } else { raw.iter().rev().fold(0u32, |all, byte| (all << 8) | u32::from(*byte)) };
            pixels.extend([channel(pixel, layout.masks.0), channel(pixel, layout.masks.1), channel(pixel, layout.masks.2)]);
        }
    }
    image::RgbImage::from_raw(width as u32, height as u32, pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixels_are_read_where_the_visual_puts_them() {
        let layout = Layout { bits_per_pixel: 32, scanline_pad: 32, msb_first: false, masks: (0xff0000, 0xff00, 0xff) };
        // Two pixels a row, little-endian 0x00RRGGBB words.
        let data = [0x30, 0x20, 0x10, 0x00, 0xff, 0xff, 0xff, 0x00, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
        let image = to_rgb(&data, 2, 2, &layout).unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [0x10, 0x20, 0x30]);
        assert_eq!(image.get_pixel(1, 0).0, [0xff, 0xff, 0xff]);
        assert_eq!(image.get_pixel(0, 1).0, [0x01, 0x02, 0x03]);
        let big_endian = Layout { msb_first: true, ..layout };
        assert_eq!(to_rgb(&[0x00, 0x10, 0x20, 0x30], 1, 1, &big_endian).unwrap().get_pixel(0, 0).0, [0x10, 0x20, 0x30]);
        let sixteen = Layout { bits_per_pixel: 16, scanline_pad: 32, msb_first: false, masks: (0xf800, 0x7e0, 0x1f) };
        assert!(to_rgb(&[0; 4], 1, 1, &sixteen).is_none());
        assert!(to_rgb(&[0; 7], 2, 1, &layout).is_none());
    }

    #[test]
    fn keys_become_keysyms() {
        assert_eq!(keysym("Return"), Some(0xff0d));
        assert_eq!(keysym("F1"), Some(0xffbe));
        assert_eq!(keysym("F12"), Some(0xffc9));
        assert_eq!(keysym("a"), Some(0x61));
        assert_eq!(keysym("?"), Some(0x3f));
        assert_eq!(keysym("F13"), None);
        assert_eq!(keysym("ab"), None);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('€'), 0x0100_20ac);
        assert_eq!(modifier_keysym("command"), Some(CONTROL_L));
        assert_eq!(modifier_keysym("option"), Some(ALT_L));
        assert_eq!(modifier_keysym("hyper"), None);
        // Every key the agent may name has a keysym here.
        for key in ["Space", "Backspace", "Escape", "Delete", "Home", "PageUp", "End", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab", "~", "Z", "0"] {
            assert!(super::super::super::key_code(key).is_some() && keysym(key).is_some(), "{key}");
        }
    }

    #[test]
    fn a_symbol_is_found_on_its_key_or_on_a_borrowed_one() {
        // Keycodes 10 to 13: "a"/"A", "1"/"!", nothing, nothing.
        let keyboard = Keyboard { min: 10, per: 2, syms: vec![0x61, 0x41, 0x31, 0x21, 0, 0, 0, 0], borrowed: None };
        assert_eq!(keyboard.find(0x61), Some((10, false)));
        assert_eq!(keyboard.find(0x41), Some((10, true)));
        assert_eq!(keyboard.find(0x21), Some((11, true)));
        assert_eq!(keyboard.find(0xe9), None);
        assert_eq!(keyboard.spare(), Some(13));
        let lower_only = Keyboard { min: 8, per: 2, syms: vec![0x62, 0], borrowed: None };
        assert_eq!(lower_only.find(0x42), Some((8, true)));
    }

    #[test]
    fn wheel_steps_go_to_their_buttons() {
        assert_eq!(scroll_buttons(0, 3), vec![(4, 3)]);
        assert_eq!(scroll_buttons(0, -2), vec![(5, 2)]);
        assert_eq!(scroll_buttons(4, 0), vec![(6, 4)]);
        assert_eq!(scroll_buttons(-1, 0), vec![(7, 1)]);
    }

    #[test]
    fn windows_are_cut_to_the_screen_and_named_by_class() {
        let screen = Rect { x: 0.0, y: 0.0, width: 1280.0, height: 800.0 };
        assert_eq!(intersect(&Rect { x: -20.0, y: 700.0, width: 300.0, height: 300.0 }, &screen), Some(Rect { x: 0.0, y: 700.0, width: 280.0, height: 100.0 }));
        assert_eq!(intersect(&Rect { x: 1300.0, y: 0.0, width: 10.0, height: 10.0 }, &screen), None);
        assert_eq!(class_names(b"gnome-calculator\0Gnome-calculator\0"), vec!["gnome-calculator".to_string(), "Gnome-calculator".to_string()]);
        assert_eq!(class_names(b"\0"), Vec::<String>::new());
    }
}
