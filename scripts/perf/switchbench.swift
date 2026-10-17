// Thread switches in WebKit (the engine Runrail's window uses), in a visible window: opens three
// 2,000-item preview threads, then switches between them, timing each from the click to the first
// painted frame that shows the thread's rows. A covered or hidden page gets no animation frames,
// so this cannot be measured in a background browser tab.
// Usage: swiftc -O switchbench.swift -o switchbench && ./switchbench "<preview url>" switch-state.json
import AppKit
import WebKit

let probe = """
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));
const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
// A sample taken while the window was hidden (another app came to the front) is dropped: a hidden
// page gets no frames, so it would time the hiding instead of the switch.
let hides = 0;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hides += 1; });
const stats = (raw) => {
  const values = raw.filter((value) => Number.isFinite(value));
  if (values.length === 0) return { n: 0, dropped: raw.length };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, dropped: raw.length - values.length, p50: Math.round(at(0.5)), max: Math.round(sorted[sorted.length - 1]), all: values.map(Math.round) };
};
const titles = ['Switch one', 'Switch two', 'Switch three'];
const row = (title) => [...document.querySelectorAll('.thread-row')].find((el) => el.textContent.includes(title));
for (let i = 0; i < 100 && titles.some((t) => !row(t)); i++) await sleep(100);
await sleep(1000);
const open = async (title) => {
  const target = row(title);
  if (!target) throw new Error('no row for ' + title);
  while (document.visibilityState === 'hidden') await sleep(100);
  const hidden = hides;
  const started = performance.now();
  (target.querySelector('button') ?? target).click();
  for (let i = 0; i < 600; i++) {
    if (document.title.startsWith(title) && document.querySelector('.thread-view [data-index]')) break;
    await frame();
  }
  shown.push(Math.round(performance.now() - started));
  await painted();
  return hides === hidden ? performance.now() - started : Number.NaN;
};
const shown = [];
const first = [];
const revisit = [];
let step = 'starting';
const work = (async () => {
  for (const title of titles) { step = 'first ' + title; first.push(await open(title)); await sleep(1500); }
  for (let round = 0; round < 4; round++) for (const title of titles) { step = 'revisit ' + title; revisit.push(await open(title)); await sleep(500); }
  return true;
})();
const finished = await Promise.race([work, sleep(75000).then(() => false)]);
if (!finished) {
  const ticks = await Promise.race([frame().then(() => 'frames'), sleep(2000).then(() => 'no frames')]);
  return JSON.stringify({ stuck: step, ticks, title: document.title, rows: document.querySelectorAll('.thread-view [data-index]').length, visibility: document.visibilityState, first: first.map(Math.round), revisit: revisit.map(Math.round), hides, rowsShownMs: shown });
}
const idle = [];
let last = await frame();
for (let i = 0; i < 60; i++) { const t = await frame(); idle.push(t - last); last = t; }
return JSON.stringify({ frameIntervalMs: stats(idle).p50, rows: document.querySelectorAll('.thread-view [data-index]').length, firstOpen: stats(first), revisit: stats(revisit), rowsShownMs: shown });
"""

final class Bench: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 1280, height: 820), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    let web: WKWebView
    let url: URL

    init(url: URL, seed: String?) {
        self.url = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if let seed, let data = try? JSONSerialization.data(withJSONObject: [seed], options: []), let literal = String(data: data, encoding: .utf8) {
            let script = "localStorage.setItem('runrail.preview.state', \(literal)[0]);"
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: configuration)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Runrail switch timing (closes by itself)"
        window.contentView = web
        web.navigationDelegate = self
        window.level = .floating
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        web.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { print("{\"error\":\"timed out\"}"); exit(1) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript(probe, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): print(value as? String ?? "\(value)")
            case .failure(let error): print("{\"error\":\"\(error.localizedDescription)\"}")
            }
            exit(0)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let seed = CommandLine.arguments.count > 2 ? try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) : nil
let bench = Bench(url: URL(string: CommandLine.arguments[1])!, seed: seed)
app.delegate = bench
app.run()
