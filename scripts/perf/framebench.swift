// Real frame times in WebKit (the engine Runrail's window uses), in a visible window: scrolls a
// 2,000-item preview thread and types into the composer, timing frames with requestAnimationFrame.
// Usage: swiftc -O framebench.swift -o framebench && ./framebench "<preview url>" seed-state.json
import AppKit
import WebKit

let probe = """
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), p99: +at(0.99).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) };
};
for (let i = 0; i < 100 && !document.querySelector('.composer textarea'); i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 1000));
const longest = () => [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 2000 && getComputedStyle(el).overflowY !== 'visible').sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
if (!longest()) {
  const row = document.querySelector('.thread-row:not(.group-row) button, .thread-row:not(.group-row)');
  row?.click();
  for (let i = 0; i < 100 && !longest(); i++) await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 1500));
const scrollers = [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 2000 && getComputedStyle(el).overflowY !== 'visible');
const scroller = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
if (!scroller) return JSON.stringify({ error: 'no long scroller', title: document.title, rows: document.querySelectorAll('.thread-row').length, items: document.querySelectorAll('[data-index]').length, tallest: Math.max(...[...document.querySelectorAll('*')].map((el) => el.scrollHeight)), text: document.body.innerText.slice(0, 200) });
// Idle refresh: the display's own frame interval.
const idle = [];
let last = await frame();
for (let i = 0; i < 120; i++) { const t = await frame(); idle.push(t - last); last = t; }
const interval = stats(idle).p50;
// The list opens at the newest message; first pass scrolls up into rows never shown yet, the
// second scrolls back down over rows that were.
scroller.scrollTop = scroller.scrollHeight;
await new Promise((r) => setTimeout(r, 800));
const scroll = [];
const back = [];
last = await frame();
for (let i = 0; i < 300; i++) {
  scroller.scrollTop -= 60;
  const t = await frame();
  scroll.push(t - last);
  last = t;
}
for (let i = 0; i < 300; i++) {
  scroller.scrollTop += 60;
  const t = await frame();
  back.push(t - last);
  last = t;
}
const ta = document.querySelector('.composer textarea');
ta.focus();
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
const keys = [];
for (let i = 0; i < 150; i++) {
  await frame();
  const start = performance.now();
  setter.call(ta, ta.value + 'a');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  keys.push(performance.now() - start);
}
setter.call(ta, '');
ta.dispatchEvent(new Event('input', { bubbles: true }));
const dropped = (list) => list.filter((d) => d > interval * 1.5).length;
return JSON.stringify({ frameIntervalMs: +interval.toFixed(2), rows: scroller.querySelectorAll('[data-index]').length, firstPass: { ...stats(scroll), dropped: dropped(scroll) }, scrollBack: { ...stats(back), dropped: dropped(back) }, keystrokeToFrame: stats(keys), heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null });
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
            // A saved preview state, so the page opens on a thread instead of the first-run screen.
            let script = "localStorage.setItem('runrail.preview.state', \(literal)[0]);"
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: configuration)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Runrail frame timing (closes by itself)"
        window.contentView = web
        web.navigationDelegate = self
        // A covered window gets no animation frames, so it floats above others while it measures.
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
