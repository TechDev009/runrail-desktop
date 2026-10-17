//! Published pages: a copy of a folder the person picked, served read-only to their
//! tailnet. The copy is taken once, so later edits and anything outside the folder never show: no
//! hidden files or folders, no `node_modules`, no links, and bounded in count and size.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{BridgeError, BridgeResult};

pub const MAX_FILES: usize = 2_000;
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DEPTH: usize = 16;

/// What a copy would hold, counted before anything is copied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub files: Vec<PathBuf>,
    pub bytes: u64,
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

fn too_large() -> BridgeError {
    BridgeError::new("PAGE_TOO_LARGE", format!("A page can hold up to {MAX_FILES} files and {} MB.", MAX_BYTES / (1024 * 1024)))
}

/// The files a page made from `root` holds, relative to it. Needs an `index.html` at its top.
pub fn plan(root: &Path) -> BridgeResult<Plan> {
    let mut files = Vec::new();
    let mut bytes = 0_u64;
    walk(root, Path::new(""), 0, &mut files, &mut bytes)?;
    if !files.iter().any(|file| file == Path::new("index.html")) {
        return Err(BridgeError::new("PAGE_NO_INDEX", "Pick a folder with an index.html at its top, such as a site's build output."));
    }
    files.sort();
    Ok(Plan { files, bytes })
}

fn walk(root: &Path, relative: &Path, depth: usize, files: &mut Vec<PathBuf>, bytes: &mut u64) -> BridgeResult<()> {
    if depth > MAX_DEPTH {
        return Err(BridgeError::new("PAGE_TOO_DEEP", "The folder is nested too deeply to publish."));
    }
    let entries = fs::read_dir(root.join(relative)).map_err(|_| BridgeError::new("PAGE_UNREADABLE", "The folder could not be read."))?;
    for entry in entries {
        let entry = entry.map_err(|_| BridgeError::new("PAGE_UNREADABLE", "The folder could not be read."))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if skipped(name) {
            continue;
        }
        // `file_type` does not follow links, so a link is neither a file nor a folder here.
        let Ok(kind) = entry.file_type() else { continue };
        let path = relative.join(name);
        if kind.is_dir() {
            walk(root, &path, depth + 1, files, bytes)?;
        } else if kind.is_file() {
            *bytes += entry.metadata().map_or(0, |meta| meta.len());
            files.push(path);
            if files.len() > MAX_FILES || *bytes > MAX_BYTES {
                return Err(too_large());
            }
        }
    }
    Ok(())
}

/// Copies the planned files from `root` into `into`, which must not exist yet.
pub fn copy(root: &Path, plan: &Plan, into: &Path) -> BridgeResult<()> {
    let failed = || BridgeError::new("PAGE_COPY_FAILED", "The page could not be copied.");
    fs::create_dir_all(into.parent().ok_or_else(failed)?).map_err(|_| failed())?;
    fs::create_dir(into).map_err(|_| failed())?;
    let result = (|| -> BridgeResult<()> {
        let mut copied = 0_u64;
        for file in &plan.files {
            let from = root.join(file);
            // The folder may have changed since it was counted: a link that appeared is refused.
            if fs::symlink_metadata(&from).map_or(true, |meta| !meta.is_file()) {
                return Err(failed());
            }
            let to = into.join(file);
            fs::create_dir_all(to.parent().ok_or_else(failed)?).map_err(|_| failed())?;
            copied += fs::copy(&from, &to).map_err(|_| failed())?;
            if copied > MAX_BYTES {
                return Err(too_large());
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(into);
    }
    result
}

/// The file a request path names inside a page's copy, or none. `rest` is what follows `/p/<token>/`.
pub fn resolve(dir: &Path, rest: &str) -> Option<PathBuf> {
    let rest = if rest.is_empty() || rest.ends_with('/') { format!("{rest}index.html") } else { rest.to_string() };
    let decoded = percent_decode(&rest)?;
    let mut path = dir.to_path_buf();
    for part in Path::new(&decoded).components() {
        match part {
            Component::Normal(name) if !name.to_str().is_some_and(skipped) => path.push(name),
            _ => return None,
        }
    }
    fs::symlink_metadata(&path).ok().filter(|meta| meta.is_file()).map(|_| path)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(out).ok()?;
    (!decoded.contains(['\0', '\\'])).then_some(decoded)
}

/// A media type by extension, for the files sites are made of.
pub fn media_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("rr-pages-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("assets")).expect("dir");
        fs::create_dir_all(root.join(".git")).expect("dir");
        fs::create_dir_all(root.join("node_modules/x")).expect("dir");
        fs::write(root.join("index.html"), "<h1>hi</h1>").expect("write");
        fs::write(root.join("assets/app.js"), "1").expect("write");
        fs::write(root.join(".env"), "SECRET=1").expect("write");
        fs::write(root.join(".git/config"), "x").expect("write");
        fs::write(root.join("node_modules/x/a.js"), "x").expect("write");
        root
    }

    #[test]
    fn a_page_holds_the_site_and_nothing_hidden_or_linked() {
        let root = site("plan");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", root.join("assets/hosts")).expect("link");
        let plan = plan(&root).expect("plan");
        assert_eq!(plan.files, vec![PathBuf::from("assets/app.js"), PathBuf::from("index.html")]);
        let into = root.with_extension("copy");
        let _ = fs::remove_dir_all(&into);
        copy(&root, &plan, &into).expect("copy");
        assert!(into.join("index.html").is_file() && !into.join(".env").exists() && !into.join("assets/hosts").exists());

        assert_eq!(resolve(&into, ""), Some(into.join("index.html")));
        assert_eq!(resolve(&into, "assets/app%2Ejs"), Some(into.join("assets/app.js")));
        for rest in ["../plan/.env", "assets/../../x", "%2e%2e/x", ".env", "assets/", "/etc/hosts", "a\\b", "%zz"] {
            assert_eq!(resolve(&into, rest), None, "{rest}");
        }
        assert_eq!(media_type(Path::new("a/B.JS")), "text/javascript; charset=utf-8");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&into);
    }

    #[test]
    fn a_page_needs_an_index() {
        let root = site("index");
        fs::remove_file(root.join("index.html")).expect("remove");
        assert_eq!(plan(&root).expect_err("no index").code, "PAGE_NO_INDEX");
        let _ = fs::remove_dir_all(&root);
    }
}
