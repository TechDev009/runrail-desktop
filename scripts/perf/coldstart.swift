// Times app launches: from the open request to the app's first on-screen window, and (for
// Runrail) to the ready time its host writes to startup.json. Usage:
//   swiftc -O coldstart.swift -o coldstart && ./coldstart <app path> <runs> [readyFile] [ENV=VALUE ...]
import AppKit
import CoreGraphics
import Foundation

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

func wallMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func spin(_ seconds: Double) { RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds)) }

func running(_ bundleId: String) -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
}

func quit(_ bundleId: String) -> Bool {
    for app in running(bundleId) { app.terminate() }
    var asked = false
    let deadline = now() + 30_000
    while now() < deadline {
        if running(bundleId).isEmpty { return true }
        // Some Electron apps ignore terminate() but honor a scripted Quit, the same as the menu item.
        if !asked && now() > deadline - 20_000 {
            asked = true
            NSAppleScript(source: "with timeout of 15 seconds\ntell application id \"\(bundleId)\" to quit\nend timeout")?.executeAndReturnError(nil)
        }
        spin(0.05)
    }
    return false
}

func hasWindow(pid: pid_t) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    for window in list {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int32, owner == pid else { continue }
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let width = bounds["Width"] as? Double ?? 0
        let height = bounds["Height"] as? Double ?? 0
        if layer == 0 && width >= 400 && height >= 300 { return true }
    }
    return false
}

let args = CommandLine.arguments
guard args.count >= 3, let runs = Int(args[2]) else {
    print("usage: coldstart <app> <runs> [readyFile] [ENV=VALUE ...]")
    exit(2)
}
let url = URL(fileURLWithPath: args[1])
guard let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier else {
    print("not an app bundle")
    exit(2)
}
let readyFile = args.count >= 4 && !args[3].contains("=") ? args[3] : nil
var environment: [String: String] = [:]
for pair in args.dropFirst(readyFile == nil ? 3 : 4) {
    let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
    if parts.count == 2 { environment[parts[0]] = parts[1] }
}

if !running(bundleId).isEmpty && !quit(bundleId) {
    print("{\"error\":\"could not quit the running copy\"}")
    exit(1)
}
spin(2)

for run in 1...runs {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.environment = environment
    let start = now()
    let startWall = wallMs()
    var launched: NSRunningApplication?
    var failure: Error?
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        launched = app
        failure = error
    }
    var pid: pid_t = 0
    var windowMs = -1.0
    let deadline = start + 60_000
    while now() < deadline {
        if pid == 0, let app = running(bundleId).first { pid = app.processIdentifier }
        if pid != 0 && hasWindow(pid: pid) {
            windowMs = now() - start
            break
        }
        usleep(2_000)
    }
    var readyMs = -1.0
    var readyFromProcessMs = -1.0
    if let path = readyFile {
        while now() < deadline {
            if let data = FileManager.default.contents(atPath: path),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let at = json["at"] as? Double, at >= startWall,
               let fromProcess = json["readyMs"] as? Double {
                readyMs = at - startWall
                readyFromProcessMs = fromProcess
                break
            }
            usleep(5_000)
        }
    }
    _ = launched
    if let failure { print("{\"run\":\(run),\"error\":\"\(failure.localizedDescription)\"}") }
    print("{\"run\":\(run),\"windowMs\":\(Int(windowMs)),\"readyMs\":\(Int(readyMs)),\"readyFromProcessMs\":\(Int(readyFromProcessMs))}")
    // Let it settle as a person would before closing it, then quit it normally.
    spin(4)
    if !quit(bundleId) {
        print("{\"run\":\(run),\"error\":\"did not quit\"}")
        exit(1)
    }
    spin(3)
}
