//! Browser previews: web pages in the side panel, each in its own webview inside the main window.
//! A preview holds no app permission (build.rs grants every command to the main webview only),
//! keeps nothing on disk, asks for no device, downloads nothing, and never shows the app's own
//! pages. The renderer places, hides, and closes them. Script runs in one only when the person lets
//! the agent use the browser (preview_agent.rs).

use std::collections::{HashMap, HashSet};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, Url, Webview, WebviewBuilder, WebviewUrl};
#[cfg(not(target_os = "linux"))]
use tauri::{LogicalPosition, LogicalSize, Rect};

use crate::error::{BridgeError, BridgeResult};
use crate::sign_ins::{self, Saved};
use crate::workspace::valid_id;

pub const MAX_URL: usize = 2048;
/// Live previews across the app; the least recently used one is unloaded past this.
pub const MAX_LIVE: usize = 6;
/// The widths an artboard lays a page out at, and how far one may be scaled down.
const MIN_ARTBOARD_WIDTH: f64 = 200.0;
const MAX_ARTBOARD_WIDTH: f64 = 2_000.0;
const MIN_ZOOM: f64 = 0.1;
const MAX_EDGE: f64 = 20_000.0;
const MAX_TITLE: usize = 200;
const STATE_EVENT: &str = "preview:state";

/// Hosts the app itself is served from, under any scheme.
const APP_HOSTS: &[&str] = &["tauri.localhost", "ipc.localhost", "asset.localhost"];
/// What a page may navigate to or frame. Other schemes (`file:`, `tauri:`, `ipc:`, `asset:`, app
/// links such as `vscode:`) are cancelled.
const FRAME_SCHEMES: &[&str] = &["http", "https", "about", "data", "blob"];

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Back,
    Forward,
    Reload,
    Stop,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// False when nothing answers at a loopback address; the page is not loaded then.
    pub reachable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    /// The webview was closed to make room; showing the tab loads it again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    unloaded: bool,
}

impl State {
    fn new(tab: &str) -> Self {
        Self { tab: tab.to_string(), url: None, title: None, loading: None, unloaded: false }
    }
}

#[derive(Default)]
pub struct Previews {
    /// Tab id to webview label, least recently used first.
    live: Mutex<Vec<(String, String)>>,
    next: std::sync::atomic::AtomicU64,
    /// One open at a time, so two quick opens of a tab cannot both create a webview.
    opening: Mutex<()>,
    /// One agent script waits for the person's answer at a time.
    pub asking: Mutex<()>,
    /// Previews whose project keeps its browser sign-ins, by tab.
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    project: String,
    /// The cookies this preview last knew, so one it has lost since reads as a sign-out.
    known: HashSet<sign_ins::Key>,
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("PREVIEW_INVALID_INPUT", message).with_status(400)
}

fn refused(message: &str) -> BridgeError {
    BridgeError::new("PREVIEW_URL_REFUSED", message).with_status(400)
}

fn failed() -> BridgeError {
    BridgeError::new("PREVIEW_FAILED", "the preview could not be shown")
}

fn require_tab(tab: &str) -> BridgeResult<()> {
    if valid_id(tab) {
        Ok(())
    } else {
        Err(invalid("preview tab is invalid"))
    }
}

fn check_bounds(bounds: &Bounds) -> BridgeResult<()> {
    let fine = |value: f64, min: f64| value.is_finite() && (min..=MAX_EDGE).contains(&value);
    if fine(bounds.x, 0.0) && fine(bounds.y, 0.0) && fine(bounds.width, 1.0) && fine(bounds.height, 1.0) {
        Ok(())
    } else {
        Err(invalid("preview bounds are invalid"))
    }
}

fn is_app_page(url: &Url, dev_origin: Option<&Url>) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    APP_HOSTS.contains(&host.as_str()) || dev_origin.is_some_and(|dev| dev.origin() == url.origin())
}

/// An address the person typed or a tab restored: http or https, no user info, not the app.
pub fn address(value: &str, dev_origin: Option<&Url>) -> BridgeResult<Url> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_URL || value.chars().any(char::is_control) {
        return Err(refused("the address is not valid"));
    }
    let url = Url::parse(value).map_err(|_| refused("the address is not valid"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(refused("Runrail opens web addresses only"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refused("addresses with a user name or password are not opened"));
    }
    if is_app_page(&url, dev_origin) {
        return Err(refused("Runrail's own pages are not opened in a preview"));
    }
    Ok(url)
}

/// Where a page in a preview may go, top frame or inner frame.
pub fn may_navigate(url: &Url, dev_origin: Option<&Url>) -> bool {
    FRAME_SCHEMES.contains(&url.scheme()) && !is_app_page(url, dev_origin)
}

fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

/// A page on this computer, for an agent kept to local pages: a loopback address, `localhost`, or a
/// `*.localhost` name every address of which is loopback (WebKit asks DNS for those, which may answer
/// with anything).
pub fn on_this_computer(url: &Url, resolve: impl Fn(&str, u16) -> Vec<std::net::IpAddr>) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    if host == "localhost" {
        return true;
    }
    if !host.ends_with(".localhost") {
        return false;
    }
    let addresses = resolve(&host, url.port_or_known_default().unwrap_or(80));
    !addresses.is_empty() && addresses.iter().all(std::net::IpAddr::is_loopback)
}

pub fn resolve(host: &str, port: u16) -> Vec<std::net::IpAddr> {
    (host, port).to_socket_addrs().map(|addresses| addresses.map(|address| address.ip()).collect()).unwrap_or_default()
}

/// Only a loopback address is checked, and only "refused on every address" counts as nothing
/// there; a name that does not resolve is left to the page to report.
fn answers(url: &Url) -> bool {
    if !is_loopback(url) {
        return true;
    }
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else { return true };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(addresses) = (host, port).to_socket_addrs() else { return true };
    let addresses: Vec<_> = addresses.collect();
    addresses.is_empty() || addresses.iter().any(|address| TcpStream::connect_timeout(address, Duration::from_millis(400)).is_ok())
}

/// The dev server the app's own pages come from in a debug build. A release build serves them from
/// `tauri://`, so a person's own server on that port is an ordinary page there.
fn dev_origin(app: &AppHandle) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

fn emit(app: &AppHandle, state: State) {
    let _ = app.emit(STATE_EVENT, state);
}

fn title_of(title: &str) -> String {
    title.chars().filter(|char| !char.is_control()).take(MAX_TITLE).collect()
}

impl Previews {
    fn label_of(&self, tab: &str) -> Option<String> {
        self.live.lock().unwrap().iter().find(|(id, _)| id == tab).map(|(_, label)| label.clone())
    }

    fn touch(&self, tab: &str) {
        let mut live = self.live.lock().unwrap();
        if let Some(index) = live.iter().position(|(id, _)| id == tab) {
            let entry = live.remove(index);
            live.push(entry);
        }
    }

    fn webview(&self, app: &AppHandle, tab: &str) -> Option<Webview> {
        self.label_of(tab).and_then(|label| app.get_webview(&label))
    }

    /// Unloads the least recently used previews past the limit, never `keep`.
    fn evict(&self, app: &AppHandle, keep: &str) {
        let extra: Vec<(String, String)> = {
            let mut live = self.live.lock().unwrap();
            let mut extra = Vec::new();
            while live.len() > MAX_LIVE {
                let Some(index) = live.iter().position(|(id, _)| id != keep) else { break };
                extra.push(live.remove(index));
            }
            extra
        };
        for (tab, label) in extra {
            if let Some(webview) = app.get_webview(&label) {
                self.save_from(app, &tab, &webview);
                let _ = webview.close();
            }
            self.sessions.lock().unwrap().remove(&tab);
            emit(app, State { unloaded: true, ..State::new(&tab) });
        }
    }

    fn create(&self, app: &AppHandle, tab: &str, url: Url, bounds: Bounds, project: Option<&str>) -> BridgeResult<()> {
        let window = app.get_window("main").ok_or_else(failed)?;
        let number = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let label = format!("preview-{number}");
        let dev = dev_origin(app);
        let (on_load, on_title, popup_app, popup_label) = (app.clone(), app.clone(), app.clone(), label.clone());
        let (load_tab, title_tab, popup_dev) = (tab.to_string(), tab.to_string(), dev.clone());
        // A project's saved sign-ins go in before the first page asks for them.
        let first = if project.is_some() { Url::parse("about:blank").map_err(|_| failed())? } else { url.clone() };
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(first))
            .incognito(true)
            .devtools(cfg!(debug_assertions))
            .initialization_script(crate::preview_agent::CONSOLE_RECORDER)
            .initialization_script(crate::preview_agent::NETWORK_RECORDER)
            .on_navigation(move |url| may_navigate(url, dev.as_ref()))
            .on_new_window(move |url, _features| {
                // A link meant for a new window opens in the same preview.
                if address(url.as_str(), popup_dev.as_ref()).is_ok() {
                    if let Some(webview) = popup_app.get_webview(&popup_label) {
                        tauri::async_runtime::spawn(async move {
                            let _ = webview.navigate(url);
                        });
                    }
                }
                NewWindowResponse::Deny
            })
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }))
            .on_permission_request(|_, _| PermissionResponse::Deny)
            .on_page_load(move |_, payload| {
                if payload.url().as_str() == "about:blank" {
                    return;
                }
                let loading = payload.event() == PageLoadEvent::Started;
                emit(&on_load, State { url: Some(payload.url().to_string()), loading: Some(loading), ..State::new(&load_tab) });
                if !loading {
                    // Reading cookies waits on the main thread, which this runs on.
                    let (app, tab) = (on_load.clone(), load_tab.clone());
                    std::thread::spawn(move || app.state::<Previews>().save_sign_ins(&app, &tab));
                }
            })
            .on_document_title_changed(move |_, title| {
                emit(&on_title, State { title: Some(title_of(&title)), ..State::new(&title_tab) });
            });
        #[cfg(not(target_os = "linux"))]
        let webview = window
            .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
            .map_err(|_| failed())?;
        #[cfg(target_os = "linux")]
        let webview = crate::preview_gtk::add_child(&window, app, builder, bounds).ok_or_else(failed)?;
        self.live.lock().unwrap().push((tab.to_string(), label));
        if let Some(project) = project {
            let saved = sign_ins::load(&app.config().identifier, project);
            let mut known = HashSet::new();
            for cookie in &saved {
                if let Some(value) = cookie.to_cookie() {
                    if webview.set_cookie(value).is_ok() {
                        known.insert(cookie.key());
                    }
                }
            }
            self.sessions.lock().unwrap().insert(tab.to_string(), Session { project: project.to_string(), known });
            webview.navigate(url).map_err(|_| failed())?;
        }
        self.evict(app, tab);
        Ok(())
    }

    /// Saves a preview's cookies for its project, when the project keeps its sign-ins.
    pub fn save_sign_ins(&self, app: &AppHandle, tab: &str) {
        if let Some(webview) = self.webview(app, tab) {
            self.save_from(app, tab, &webview);
        }
    }

    fn save_from(&self, app: &AppHandle, tab: &str, webview: &Webview) {
        let Some((project, known)) = self.sessions.lock().ok().and_then(|sessions| sessions.get(tab).map(|session| (session.project.clone(), session.known.clone()))) else { return };
        let Ok(cookies) = webview.cookies() else { return };
        let current: Vec<Saved> = cookies.iter().filter_map(Saved::from_cookie).collect();
        if sign_ins::save(&app.config().identifier, &project, &known, &current).is_ok() {
            if let Some(session) = self.sessions.lock().unwrap().get_mut(tab) {
                session.known = current.iter().map(Saved::key).collect();
            }
        }
    }

    /// Stops saving for a project and removes what was saved. Open pages keep theirs until closed.
    pub fn forget_sign_ins(&self, project: &str) -> BridgeResult<()> {
        self.sessions.lock().unwrap().retain(|_, session| session.project != project);
        sign_ins::forget(project)
    }

    /// Saves before a preview goes, then lets the tab go.
    fn closing(&self, app: &AppHandle, tab: &str) {
        self.save_sign_ins(app, tab);
        self.sessions.lock().unwrap().remove(tab);
    }

    /// `hidden` loads the page without showing it: the agent opened it in a tab not on screen.
    pub fn open(&self, app: &AppHandle, tab: &str, url: &str, bounds: Bounds, hidden: bool, project: Option<&str>) -> BridgeResult<Opened> {
        require_tab(tab)?;
        check_bounds(&bounds)?;
        let url = address(url, dev_origin(app).as_ref())?;
        let _opening = self.opening.lock().unwrap();
        if !answers(&url) {
            self.hide(app, tab);
            return Ok(Opened { reachable: false });
        }
        match self.webview(app, tab) {
            Some(webview) => {
                webview.navigate(url).map_err(|_| failed())?;
                if !hidden {
                    self.place(&webview, bounds)?;
                }
                self.touch(tab);
            }
            None => {
                self.create(app, tab, url, bounds, project)?;
                if hidden {
                    self.hide(app, tab);
                }
            }
        }
        Ok(Opened { reachable: true })
    }

    /// The tab's loaded preview, for the agent's scripts and screenshots. Unless the person let the
    /// agent use any site, the page it is on now must be on this computer: the renderer's address
    /// may be stale after a redirect.
    pub fn loaded(&self, app: &AppHandle, tab: &str, any_site: bool) -> BridgeResult<Webview> {
        require_tab(tab)?;
        let webview = self.webview(app, tab).ok_or_else(not_found)?;
        if !any_site {
            let url = webview.url().map_err(|_| failed())?;
            if !on_this_computer(&url, resolve) {
                return Err(BridgeError::new("BROWSER_SITE_REFUSED", "This thread lets the agent use pages on this computer only (localhost). The person can allow other sites in the browser tab.").with_status(403));
            }
        }
        Ok(webview)
    }

    #[cfg(not(target_os = "linux"))]
    fn place(&self, webview: &Webview, bounds: Bounds) -> BridgeResult<()> {
        let rect = Rect { position: LogicalPosition::new(bounds.x, bounds.y).into(), size: LogicalSize::new(bounds.width, bounds.height).into() };
        webview.set_bounds(rect).map_err(|_| failed())?;
        webview.show().map_err(|_| failed())
    }

    #[cfg(target_os = "linux")]
    fn place(&self, webview: &Webview, bounds: Bounds) -> BridgeResult<()> {
        if crate::preview_gtk::place(webview, bounds) {
            Ok(())
        } else {
            Err(failed())
        }
    }

    fn hide(&self, app: &AppHandle, tab: &str) {
        if let Some(webview) = self.webview(app, tab) {
            let _ = webview.hide();
        }
    }

    /// Places a preview, or hides it when `bounds` is `None`. An unloaded preview reports
    /// `PREVIEW_NOT_FOUND`, and the renderer opens it again.
    pub fn bounds(&self, app: &AppHandle, tab: &str, bounds: Option<Bounds>) -> BridgeResult<()> {
        require_tab(tab)?;
        let Some(bounds) = bounds else {
            self.hide(app, tab);
            return Ok(());
        };
        check_bounds(&bounds)?;
        let webview = self.webview(app, tab).ok_or_else(not_found)?;
        self.place(&webview, bounds)?;
        self.touch(tab);
        Ok(())
    }

    /// Scales a preview's page: at 0.5 a view 195 points wide lays the page out 390 CSS pixels wide.
    pub fn zoom(&self, app: &AppHandle, tab: &str, scale: f64) -> BridgeResult<()> {
        require_tab(tab)?;
        if !valid_zoom(scale) {
            return Err(invalid("preview zoom is invalid"));
        }
        let webview = self.webview(app, tab).ok_or_else(not_found)?;
        webview.set_zoom(scale).map_err(|_| failed())
    }

    pub fn action(&self, app: &AppHandle, tab: &str, action: Action) -> BridgeResult<()> {
        require_tab(tab)?;
        let webview = self.webview(app, tab).ok_or_else(not_found)?;
        let done = match action {
            Action::Back => webview.eval("history.back()"),
            Action::Forward => webview.eval("history.forward()"),
            Action::Reload => webview.reload(),
            Action::Stop => webview.eval("window.stop()"),
        };
        done.map_err(|_| failed())
    }

    /// The page's current address, checked again, for opening in the default browser.
    pub fn current(&self, app: &AppHandle, tab: &str) -> BridgeResult<Url> {
        require_tab(tab)?;
        let webview = self.webview(app, tab).ok_or_else(not_found)?;
        let url = webview.url().map_err(|_| failed())?;
        address(url.as_str(), dev_origin(app).as_ref())
    }

    pub fn close(&self, app: &AppHandle, tab: &str) -> BridgeResult<()> {
        require_tab(tab)?;
        self.closing(app, tab);
        let label = {
            let mut live = self.live.lock().unwrap();
            let index = live.iter().position(|(id, _)| id == tab);
            index.map(|index| live.remove(index).1)
        };
        if let Some(webview) = label.and_then(|label| app.get_webview(&label)) {
            webview.close().map_err(|_| failed())?;
        }
        Ok(())
    }

    /// Each live preview's place relative to the main page, for the automation socket. `visible` is
    /// null where the platform does not say.
    #[cfg(debug_assertions)]
    pub fn frames(&self, app: &AppHandle) -> Vec<serde_json::Value> {
        let live = self.live.lock().unwrap().clone();
        live.into_iter()
            .filter_map(|(tab, label)| {
                let webview = app.get_webview(&label)?;
                #[cfg(target_os = "linux")]
                let frame = crate::preview_gtk::frame(&webview)?;
                #[cfg(not(target_os = "linux"))]
                let frame = {
                    let scale = webview.window().scale_factor().ok()?;
                    let (at, size) = (webview.position().ok()?.to_logical::<f64>(scale), webview.size().ok()?.to_logical::<f64>(scale));
                    serde_json::json!({ "x": at.x, "y": at.y, "width": size.width, "height": size.height, "visible": null })
                };
                Some(serde_json::json!({ "tab": tab, "frame": frame }))
            })
            .collect()
    }

    /// Closes every preview whose tab the renderer no longer has.
    pub fn retain(&self, app: &AppHandle, tabs: &[String]) {
        let gone: Vec<String> = self.live.lock().unwrap().iter().filter(|(id, _)| !tabs.contains(id)).map(|(id, _)| id.clone()).collect();
        for tab in gone {
            let _ = self.close(app, &tab);
        }
    }
}

fn not_found() -> BridgeError {
    BridgeError::new("PREVIEW_NOT_FOUND", "the preview is not open").with_status(404)
}

pub fn valid_artboard_width(width: f64) -> bool {
    (MIN_ARTBOARD_WIDTH..=MAX_ARTBOARD_WIDTH).contains(&width)
}

fn valid_zoom(scale: f64) -> bool {
    (MIN_ZOOM..=1.0).contains(&scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_artboard_is_a_page_width_and_scales_down_only() {
        for width in [390.0, 820.0, 1280.0] {
            assert!(valid_artboard_width(width));
        }
        for width in [0.0, 199.0, 2_001.0, f64::NAN, f64::INFINITY] {
            assert!(!valid_artboard_width(width));
        }
        for scale in [0.1, 0.35, 1.0] {
            assert!(valid_zoom(scale));
        }
        for scale in [0.0, 0.09, 1.01, f64::NAN, f64::INFINITY, -0.5] {
            assert!(!valid_zoom(scale));
        }
    }

    #[test]
    fn only_a_page_on_this_computer_counts_as_local() {
        let none = |_: &str, _: u16| Vec::new();
        let local = |_: &str, _: u16| vec!["127.0.0.1".parse().unwrap(), "::1".parse().unwrap()];
        let remote = |_: &str, _: u16| vec!["127.0.0.1".parse().unwrap(), "93.184.216.34".parse().unwrap()];
        for page in ["http://localhost:3000/", "http://127.0.0.1/", "http://127.9.9.9:8080/x", "http://[::1]:5173/", "https://LOCALHOST/"] {
            assert!(on_this_computer(&Url::parse(page).unwrap(), none), "{page}");
        }
        for page in ["https://example.com/", "http://localhost.example.com/", "http://10.0.0.1/", "http://[::ffff:127.0.0.1]/", "file:///etc/hosts", "http://0.0.0.0/"] {
            assert!(!on_this_computer(&Url::parse(page).unwrap(), local), "{page}");
        }
        let named = Url::parse("http://app.localhost:3000/").unwrap();
        assert!(on_this_computer(&named, local));
        assert!(!on_this_computer(&named, remote));
        assert!(!on_this_computer(&named, none));
    }

    fn dev() -> Option<Url> {
        Some(Url::parse("http://localhost:1420").unwrap())
    }

    #[test]
    fn typed_addresses_are_web_pages_only() {
        for good in ["http://localhost:5173/", "https://example.com/a?b=1#c", "http://127.0.0.1:3000", "http://[::1]:8080/x", "http://app.localhost:3000"] {
            assert!(address(good, dev().as_ref()).is_ok(), "{good}");
        }
        for bad in [
            "",
            "file:///etc/hosts",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://ipc.localhost/plugin",
            "http://asset.localhost/x",
            "http://localhost:1420/",
            "javascript:alert(1)",
            "data:text/html,hi",
            "blob:https://example.com/1",
            "about:blank",
            "https://user:pass@example.com/",
            "https://user@example.com/",
            "vscode://file/x",
            "http://exa\nmple.com",
            "not a url",
        ] {
            assert!(address(bad, dev().as_ref()).is_err(), "{bad}");
        }
        assert!(address(&format!("https://example.com/{}", "a".repeat(MAX_URL)), None).is_err());
        assert_eq!(address("http://localhost:1420/", None).map(|url| url.port()), Ok(Some(1420)));
    }

    #[test]
    fn pages_may_frame_web_content_but_not_the_app() {
        let check = |url: &str| may_navigate(&Url::parse(url).unwrap(), dev().as_ref());
        for good in ["https://example.com/", "about:blank", "about:srcdoc", "data:text/html,x", "blob:https://example.com/1", "http://localhost:5173"] {
            assert!(check(good), "{good}");
        }
        for bad in ["file:///etc/hosts", "tauri://localhost/", "http://tauri.localhost/", "ipc://localhost/x", "asset://localhost/x", "http://localhost:1420/x", "vscode://file/x", "mailto:a@b.c"] {
            assert!(!check(bad), "{bad}");
        }
    }

    #[test]
    fn bounds_and_tabs_are_bounded() {
        assert!(check_bounds(&Bounds { x: 0.0, y: 40.0, width: 600.0, height: 800.0 }).is_ok());
        for bad in [
            Bounds { x: -1.0, y: 0.0, width: 10.0, height: 10.0 },
            Bounds { x: 0.0, y: 0.0, width: 0.0, height: 10.0 },
            Bounds { x: f64::NAN, y: 0.0, width: 10.0, height: 10.0 },
            Bounds { x: 0.0, y: 0.0, width: f64::INFINITY, height: 10.0 },
            Bounds { x: 0.0, y: 0.0, width: 10.0, height: 30_000.0 },
        ] {
            assert!(check_bounds(&bad).is_err(), "{bad:?}");
        }
        assert!(require_tab("tab-1").is_ok());
        assert!(require_tab("../x").is_err());
        assert_eq!(title_of("a\u{7}b").len(), 2);
        assert_eq!(title_of(&"t".repeat(500)).len(), MAX_TITLE);
    }

    #[test]
    fn only_loopback_addresses_are_checked() {
        assert!(answers(&Url::parse("https://example.invalid/").unwrap()));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(answers(&Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()));
        drop(listener);
        assert!(!answers(&Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()));
    }
}
