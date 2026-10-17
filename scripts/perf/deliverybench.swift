// Native -> JS payload delivery in a real WKWebView: inline evaluateJavaScript ("emit", Tauri emit /
// small Channel messages) vs custom-scheme fetch ("channel fetch", Tauri Channel for >= 8 KB).
// Usage: swiftc -O deliverybench.swift -o deliverybench && ./deliverybench [--scheme-page] [--same-source]
// Each iteration rewrites frame 0's `at` with a fresh 13-digit nonce so no two emit scripts are identical
// (JSC caches compiled code by exact source); --same-source disables that to show the cache effect.
import AppKit
import WebKit

let sizes = [1, 4, 8, 32, 128, 512, 1024, 4096].map { $0 * 1024 }
let lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip."
let schemePage = CommandLine.arguments.contains("--scheme-page")
let sameSource = CommandLine.arguments.contains("--same-source")
let atBase = 1790963373296

func frame(_ n: Int, _ text: String) -> String {
    "{\"kind\":\"event\",\"data\":{\"seq\":\(n),\"type\":\"assistant.delta\",\"threadId\":\"t1\",\"text\":\"\(text)\",\"at\":\(atBase + n)}}"
}

// Whole lorem frames, then one filler frame sized so the JSON is exactly `target` bytes.
// Returned split around frame 0's `at` digits so callers can splice in a nonce.
func makePayload(_ target: Int) -> (head: String, tail: String, frames: Int) {
    let head = "{\"engineId\":\"t1\",\"frames\":[", tail = "]}", filler = lorem + " " + lorem
    var parts: [String] = []
    var bytes = head.utf8.count + tail.utf8.count
    while true {
        let sep = parts.isEmpty ? 0 : 1
        let full = frame(parts.count, lorem)
        if bytes + sep + full.utf8.count + 1 + frame(parts.count + 1, "").utf8.count <= target { parts.append(full); bytes += sep + full.utf8.count; continue }
        let room = target - bytes - sep - frame(parts.count, "").utf8.count
        parts.append(frame(parts.count, String(filler.prefix(max(0, room)))))
        break
    }
    let json = head + parts.joined(separator: ",") + tail
    let at = json.range(of: "\"at\":\(atBase)")!
    return (String(json[..<at.upperBound].dropLast(13)), String(json[at.upperBound...]), parts.count)
}

let html = """
<!doctype html><meta charset="utf-8"><title>deliverybench</title><script>
window.__bench = (msg, ids) => {
  const f = msg.payload.frames;
  window.webkit.messageHandlers.done.postMessage([f.length, f[f.length - 1].data.seq, f[0].data.at]);
};
</script>
"""

final class Scheme: NSObject, WKURLSchemeHandler {
    var store: [String: Data] = [:]
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!
        let isData = url.path.hasPrefix("/data/")
        // Tauri's channel store also hands each buffer out once.
        let body = isData ? (store.removeValue(forKey: url.lastPathComponent) ?? Data()) : Data(html.utf8)
        let headers = ["Content-Type": isData ? "application/json" : "text/html", "Content-Length": "\(body.count)", "Access-Control-Allow-Origin": "*"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

struct Job { let size: Int; let mech: Int; let measured: Bool }

func uptime() -> String {
    let p = Process(), pipe = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/uptime")
    p.standardOutput = pipe
    try? p.run(); p.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
}

final class Bench: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 320, height: 240), styleMask: [.borderless], backing: .buffered, defer: false)
    let scheme = Scheme()
    var web: WKWebView!
    var payloads: [(head: String, tail: String, frames: Int)] = []
    var jobs: [Job] = []
    var results: [[[Double]]] = []
    var idx = 0, nextId = 0
    var t0: UInt64 = 0
    var lastProgress = Date()
    let startLoad = uptime()

    func applicationDidFinishLaunching(_ notification: Notification) {
        payloads = sizes.map(makePayload)
        results = sizes.map { _ in [[], []] }
        for (s, size) in sizes.enumerated() {
            let n = size >= 1024 * 1024 ? 20 : 100
            for _ in 0..<20 { for m in 0..<2 { jobs.append(Job(size: s, mech: m, measured: false)) } }
            for _ in 0..<n { for m in 0..<2 { jobs.append(Job(size: s, mech: m, measured: true)) } }
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(scheme, forURLScheme: "bench")
        config.userContentController.add(self, name: "done")
        web = WKWebView(frame: window.contentLayoutRect, configuration: config)
        web.navigationDelegate = self
        window.contentView = web
        window.level = .floating
        window.orderFrontRegardless()
        if schemePage { web.load(URLRequest(url: URL(string: "bench://localhost/index.html")!)) }
        else { web.loadHTMLString(html, baseURL: URL(string: "bench://localhost/")!) }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            if Date().timeIntervalSince(self.lastProgress) > 20 { print("TIMEOUT at job \(self.idx) \(self.jobs[min(self.idx, self.jobs.count - 1)])"); exit(1) }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("page loaded: \(webView.url?.absoluteString ?? "nil") (\(schemePage ? "scheme page" : "loadHTMLString"), \(sameSource ? "identical" : "unique") sources)")
        lastProgress = Date()
        next()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { print("nav failed: \(error)"); exit(1) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print("nav failed: \(error)"); exit(1) }

    func next() {
        guard idx < jobs.count else { return finish() }
        let job = jobs[idx], p = payloads[job.size]
        let nonce = String(atBase + (sameSource ? 0 : idx))
        let bytes = p.head.utf8.count + 13 + p.tail.utf8.count
        // Built before t0: in Tauri the payload is serialized before either path runs.
        let data = job.mech == 1 ? Data((p.head + nonce + p.tail).utf8) : Data()
        let onEval: (Any?, Error?) -> Void = { _, e in if let e { print("evaluateJavaScript error (mech \(job.mech)): \(e)"); exit(1) } }
        t0 = DispatchTime.now().uptimeNanoseconds
        if job.mech == 0 {
            let pre = "(function () { const fn = window['__bench']; fn && fn({event: 'control:batch', payload: ", post = "}, [1]) })()"
            var js = String()
            js.reserveCapacity(pre.utf8.count + bytes + post.utf8.count)
            js += pre; js += p.head; js += nonce; js += p.tail; js += post
            web.evaluateJavaScript(js, completionHandler: onEval)
        } else {
            nextId += 1
            scheme.store["\(nextId)"] = data
            let js = "fetch('bench://localhost/data/\(nextId)').then(r => r.json()).then(v => window.__bench({event: 'control:batch', payload: v}, [1])).catch(e => window.webkit.messageHandlers.done.postMessage(['error', String(e)])); void 0"
            web.evaluateJavaScript(js, completionHandler: onEval)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
        let job = jobs[idx], expected = payloads[job.size].frames
        guard let a = message.body as? [Any], a.count == 3, let n = a[0] as? Int, let seq = a[1] as? Int, let at = a[2] as? Int,
              n == expected, seq == expected - 1, at == atBase + (sameSource ? 0 : idx) else {
            print("bad done message for \(job): \(message.body)"); exit(1)
        }
        if job.measured { results[job.size][job.mech].append(ms) }
        idx += 1
        lastProgress = Date()
        DispatchQueue.main.async { self.next() }
    }

    func finish() {
        func q(_ v: [Double], _ p: Double) -> String { let s = v.sorted(); return String(format: "%.2f", s[min(s.count - 1, Int(p * Double(s.count)))]) }
        print("\nload at start: \(startLoad)\nload at end:   \(uptime())\n")
        print("| Size | Bytes | Frames | n | emit p50 | emit p95 | emit max | fetch p50 | fetch p95 | fetch max |")
        print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for (s, size) in sizes.enumerated() {
            let a = results[s][0], b = results[s][1]
            let label = size >= 1024 * 1024 ? "\(size / 1024 / 1024) MB" : "\(size / 1024) KB"
            print("| \(label) | \(payloads[s].head.utf8.count + 13 + payloads[s].tail.utf8.count) | \(payloads[s].frames) | \(a.count) | \(q(a, 0.5)) | \(q(a, 0.95)) | \(q(a, 1)) | \(q(b, 0.5)) | \(q(b, 0.95)) | \(q(b, 1)) |")
        }
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "benchmark")
let bench = Bench()
app.delegate = bench
app.run()
