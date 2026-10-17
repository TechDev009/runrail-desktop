/**
 * The Linux desktop checks of scripts/e2e-native.ts: what the image can prove
 * about the desktop around the app. Runs only on Linux; macOS never loads the desktop parts.
 *
 * Before the app starts, `prepareLinux` puts stand-in launchers for VS Code and kitty in the app's
 * ~/.local/bin, starts dunst for notifications (X11 only) and an unlocked gnome-keyring with a test
 * password. After it is up, `linuxChecks` checks the words, Open in, the autostart entry, a
 * notification click, the keyring, the clipboard, the window's own keys and a second launch.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Page = <T>(source: string, timeoutMs?: number) => Promise<T>
type Check = (name: string, run: () => Promise<string>) => Promise<boolean>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const x11 = (): boolean => process.env.DISPLAY !== undefined && process.env.DISPLAY !== ""

export interface LinuxDesktop {
  readonly stop: () => void
}

/** Launchers that write what they were given into the home folder, so a check can read it. */
function standIns(home: string): void {
  const bin = join(home, ".local", "bin")
  mkdirSync(bin, { recursive: true })
  for (const name of ["code", "kitty"]) {
    const script = join(bin, name)
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/opened-${name}"\n`)
    chmodSync(script, 0o755)
  }
}

export function prepareLinux(home: string): LinuxDesktop {
  standIns(home)
  const started: ChildProcess[] = []
  if (x11()) started.push(spawn("dunst", [], { detached: true, stdio: "ignore" }))
  // A test keyring for this run's session bus only; the password is not a secret.
  spawnSync("gnome-keyring-daemon", ["--replace", "--unlock", "--components=secrets"], { input: "e2e\n", encoding: "utf8" })
  return {
    stop: () => {
      for (const child of started) child.kill()
      spawnSync("pkill", ["-u", String(process.getuid?.() ?? 0), "gnome-keyring-d"])
    },
  }
}

export async function linuxChecks(page: Page, check: Check, context: { readonly home: string; readonly project: string; readonly identifier: string; readonly created: boolean }): Promise<void> {
  const { home, project, identifier, created } = context

  await check("Linux words: Settings names the computer, its files and its notifications plainly", async () => {
    const text = await page<string>(`
      const { set } = await import("/src/app/store.ts")
      set({ settings: "general" })
      await until(() => document.querySelector("[data-setting='system-notifications']"), 10000, "the notifications row")
      const text = document.querySelector(".settings-page").innerText
      set({ settings: false })
      return text`)
    for (const word of ["System notifications", "Keep the computer awake while working", "Start in the background at login"]) expect(text.includes(word), `Settings does not say "${word}"`)
    for (const word of ["macOS", "this Mac", "menu bar", "Finder"]) expect(!text.includes(word), `Settings says "${word}"`)
    return "System notifications; Keep the computer awake; Start in the background; no macOS words"
  })

  if (created) {
    await check("Open in lists what is installed and opens the project there", async () => {
      const shown = await page<{ readonly apps: readonly string[]; readonly code?: string; readonly kitty?: string }>(`
        const apps = (await invoke("open_in_apps")).ok
        const { useApp } = await import("/src/app/store.ts")
        const workspace = useApp.getState().projects[0].path
        const code = (await invoke("workspace_open_in", { workspace, editor: "vscode" })).code
        const kitty = (await invoke("workspace_open_in", { workspace, editor: "kitty" })).code
        return { apps, code, kitty }`)
      expect(shown.apps.includes("vscode") && shown.apps.includes("kitty"), `the list is ${JSON.stringify(shown.apps)}`)
      expect(!shown.apps.includes("cursor") && !shown.apps.includes("xcode"), `the list offers what is not installed: ${JSON.stringify(shown.apps)}`)
      expect(shown.code === undefined && shown.kitty === undefined, `opening failed: ${String(shown.code)} ${String(shown.kitty)}`)
      const opened = async (name: string): Promise<string> => {
        const file = join(home, `opened-${name}`)
        for (let waited = 0; !existsSync(file) && waited < 5_000; waited += 100) await sleep(100)
        expect(existsSync(file), `${name} was not started`)
        return readFileSync(file, "utf8").trim()
      }
      const code = await opened("code")
      const kitty = await opened("kitty")
      expect(code === project, `VS Code got ${JSON.stringify(code)}`)
      expect(kitty === `--directory\n${project}`, `kitty got ${JSON.stringify(kitty)}`)
      return `listed ${shown.apps.join(", ")}; VS Code got the folder, kitty --directory`
    })
  }

  await check("Start at login writes an XDG autostart entry that starts hidden, and removes it", async () => {
    const entry = join(home, ".config", "autostart", `${identifier}.desktop`)
    const on = await page<{ readonly set?: string; readonly status?: string }>(`return { set: (await invoke("login_item_set", { on: true })).ok, status: (await invoke("login_item_status")).ok }`)
    expect(on.set === "on" && on.status === "on", `turning it on gave ${JSON.stringify(on)}`)
    expect(existsSync(entry), `no ${entry}`)
    const text = readFileSync(entry, "utf8")
    expect(/^Exec=.+ --at-login$/m.test(text) && text.includes("Type=Application"), `the entry is ${JSON.stringify(text)}`)
    const off = await page<{ readonly set?: string }>(`return { set: (await invoke("login_item_set", { on: false })).ok }`)
    expect(off.set === "off" && !existsSync(entry), `turning it off gave ${JSON.stringify(off)}`)
    return `${entry.replace(home, "~")} written with --at-login, then removed`
  })

  await check("saved sign-ins find the Secret Service", async () => {
    const support = await page<{ readonly available: boolean; readonly reason?: string }>(`return (await invoke("sign_ins_support")).ok`)
    expect(support.available, `unavailable: ${String(support.reason)}`)
    return "available with gnome-keyring on the session bus"
  })

  await check("WebKitGTK has what the layout leans on; the traffic-light room is gone", async () => {
    const seen = await page<{ readonly has: boolean; readonly backdrop: boolean; readonly highlight: boolean; readonly inset: string }>(`
      return {
        has: CSS.supports("selector(:has(*))"),
        backdrop: CSS.supports("backdrop-filter", "blur(4px)") || CSS.supports("-webkit-backdrop-filter", "blur(4px)"),
        highlight: typeof Highlight !== "undefined" && CSS.highlights !== undefined,
        inset: getComputedStyle(document.documentElement).getPropertyValue("--traffic-lights").trim(),
      }`)
    expect(seen.has, ":has() is not supported, and the layout uses it")
    expect(seen.inset === "0px", `--traffic-lights is ${seen.inset}`)
    // Without the Highlight API, find scrolls to the match and outlines its row instead.
    return `:has() yes; backdrop-filter ${seen.backdrop ? "yes" : "no"}; find ${seen.highlight ? "highlights matches" : "outlines the row"}; traffic-light room 0px`
  })

  if (!x11()) return

  const shots = process.env.RUNRAIL_E2E_SHOTS
  if (shots !== undefined && Bun.which("import") !== null) {
    await check("screenshots under Xvfb in light and dark, and the system theme follows GTK's", async () => {
      // Run with GTK_THEME=Adwaita:dark to see the system theme turn dark.
      const systemDark = await page<boolean>(`return matchMedia("(prefers-color-scheme: dark)").matches`)
      const taken: string[] = []
      for (const theme of ["system", "light", "dark"]) {
        for (const view of ["thread", "settings"]) {
          await page(`
            const { set, setPrefs } = await import("/src/app/store.ts")
            setPrefs({ theme: ${JSON.stringify(theme)} })
            set({ settings: ${JSON.stringify(view)} === "settings" ? "general" : false })
            await frame(800)
            return true`)
          const file = join(shots, `${theme}-${view}.png`)
          const shot = spawnSync("import", ["-window", "root", file])
          expect(shot.status === 0, `import failed for ${file}`)
          taken.push(file)
        }
      }
      await page(`const { set, setPrefs } = await import("/src/app/store.ts"); setPrefs({ theme: "system" }); set({ settings: false }); return true`)
      return `GTK theme ${process.env.GTK_THEME ?? "default"}, the page sees ${systemDark ? "dark" : "light"}; ${taken.join(", ")}`
    })
  }

  await check("a notification posts to the desktop, and its click opens the thread", async () => {
    const threadId = await page<string>(`
      const { useApp, createThread } = await import("/src/app/store.ts")
      const thread = createThread({ projectId: useApp.getState().projects[0]?.id, backend: "native", title: "e2e notified", select: false })
      const status = (await invoke("notify_status")).ok
      if (!status.available) throw new Error("no notification server")
      const sent = await invoke("notify_send", { note: { threadId: thread.id, title: "Runrail", body: "e2e finished", sound: true } })
      if (sent.code) throw new Error(sent.message)
      return thread.id`)
    let shown = ""
    for (let waited = 0; waited < 5_000 && !shown.includes("e2e finished"); waited += 200) {
      await sleep(200)
      shown = spawnSync("dunstctl", ["count", "displayed"], { encoding: "utf8" }).stdout.trim() === "0" ? "" : "e2e finished"
    }
    expect(shown !== "", "dunst shows no notification")
    const clicked = spawnSync("dunstctl", ["action", "0"], { encoding: "utf8" })
    expect(clicked.status === 0, `dunstctl action failed: ${clicked.stderr}`)
    const opened = await page<string | undefined>(`
      const { useApp } = await import("/src/app/store.ts")
      await until(() => useApp.getState().layout.activeThreadId === ${JSON.stringify(threadId)}, 10000, "the thread to open")
      return useApp.getState().layout.activeThreadId`)
    expect(opened === threadId, `the click opened ${String(opened)}`)
    return "dunst showed it; its default action opened the thread"
  })

  await check("a key on the clipboard is read by the host, never the page", async () => {
    const before = await page<string | undefined>(`return (await invoke("connection_secret_from_clipboard", { connectionId: "e2e-clipboard" })).code`)
    expect(before === "CONNECTION_SECRET_INVALID", `an empty clipboard gave ${String(before)}`)
    const copied = spawn("xclip", ["-selection", "clipboard", "-loops", "1"], { stdio: ["pipe", "ignore", "ignore"] })
    copied.stdin?.end("e2e-not-a-real-key-0123456789")
    await sleep(500)
    const after = await page<string | undefined>(`return (await invoke("connection_secret_from_clipboard", { connectionId: "e2e-clipboard" })).code`)
    copied.kill()
    expect(after !== "CONNECTION_SECRET_INVALID" && after !== "CLIPBOARD_UNAVAILABLE", `a copied key gave ${String(after)}`)
    return `empty: CONNECTION_SECRET_INVALID; copied: ${after ?? "stored"}`
  })

  await check("the window's keys: Ctrl shortcuts from the composer, the shell keeps Ctrl+letter in the terminal", async () => {
    const seen = await page<{ readonly palette: boolean; readonly terminalPalette: boolean; readonly review: boolean }>(`
      const { useApp, get, set, createThread } = await import("/src/app/store.ts")
      const { openPanel, shownKind } = await import("/src/app/panels.ts")
      const press = (target, key, code, keyCode, mods) => {
        const event = new KeyboardEvent("keydown", { key, code, ctrlKey: true, shiftKey: mods === "shift", bubbles: true, cancelable: true })
        Object.defineProperty(event, "keyCode", { get: () => keyCode })
        target.dispatchEvent(event)
      }
      const thread = createThread({ projectId: useApp.getState().projects[0]?.id, backend: "native", title: "e2e keys" })
      set({ view: { kind: "thread" } })
      const composer = await until(() => document.querySelector(".composer-input"), 15000, "the composer")
      composer.focus()
      press(composer, "k", "KeyK", 75)
      await frame(100)
      const palette = get().palette
      set({ palette: false })
      openPanel(thread.id, "terminal")
      const textarea = await until(() => document.querySelector(".xterm-helper-textarea"), 30000, "the terminal")
      textarea.focus()
      press(textarea, "k", "KeyK", 75)
      await frame(100)
      const terminalPalette = get().palette
      set({ palette: false })
      press(textarea, "D", "KeyD", 68, "shift")
      await frame(200)
      return { palette, terminalPalette, review: shownKind(get().layout, thread.id) === "review" }`)
    expect(seen.palette, "Ctrl+K in the composer did not open the palette")
    expect(!seen.terminalPalette, "Ctrl+K in the terminal went to the app, not the shell")
    expect(seen.review, "Ctrl+Shift+D in the terminal did not open the review")
    return "Ctrl+K opens the palette from the composer; in the terminal the shell keeps it and Ctrl+Shift+D reaches the app"
  })

  await check("with no tray and a browser preview open, a closed window keeps work going hidden and a second launch shows it", async () => {
    // A child webview makes Tauri's webview-window lookup miss the main window, so the preview is part of the check.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>e2e hide</title>", { headers: { "content-type": "text/html" } }) })
    try {
      const preview = await page<{ readonly tab: string; readonly threadId: string }>(`
        const { getHost } = await import("/src/host/index.ts")
        const { useApp, createThread } = await import("/src/app/store.ts")
        const { newPanelTab } = await import("/src/app/panels.ts")
        const { usePreviews } = await import("/src/app/previews.ts")
        const thread = createThread({ projectId: useApp.getState().projects[0].id, backend: "native", title: "e2e hide" })
        await wait(800)
        const tab = newPanelTab(thread.id, "browser", "http://127.0.0.1:${String(server.port)}/", { show: true })
        await until(() => usePreviews.getState()[tab]?.title === "e2e hide", 30000, "the preview to load")
        window.__e2eHidden = []
        getHost().onBackground((hidden, tray) => window.__e2eHidden.push({ hidden, tray }))
        await invoke("background_hold", { reasons: ["e2e"], lines: [] })
        return { tab, threadId: thread.id }`)
      const visible = (): Promise<boolean> => page<boolean>(`return await window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" })`)
      // Closing goes through the window manager's close, as the title bar's button does.
      await page(`void window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }); return true`)
      await sleep(1500)
      const hidden = await page<readonly { readonly hidden: boolean; readonly tray: boolean }[]>(`return window.__e2eHidden`)
      expect(hidden[0]?.hidden === true && hidden[0].tray === false, `closing gave ${JSON.stringify(hidden)}`)
      expect(!(await visible()), "the window still shows after closing")
      const exe = spawnSync("ps", ["-Ao", "args="], { encoding: "utf8" })
        .stdout.split("\n")
        .map((line) => line.trim().split(" ")[0] ?? "")
        .find((path) => path.endsWith("/debug/runrail-desktop-web"))
      expect(exe !== undefined, "the app's binary was not found")
      const again = spawnSync(exe, [], { env: process.env, timeout: 30_000, encoding: "utf8" })
      expect(again.status === 0, `the second launch exited ${String(again.status)}`)
      const shown = await page<readonly { readonly hidden: boolean }[]>(`await until(() => window.__e2eHidden.some((item) => !item.hidden), 10000, "the window"); await invoke("background_hold", { reasons: [] }); return window.__e2eHidden`)
      expect(await visible(), "the second launch did not show the window")
      await page(`const { closePanelTab } = await import("/src/app/panels.ts"); closePanelTab(${JSON.stringify(preview.threadId)}, ${JSON.stringify(preview.tab)}); return true`)
      return `hidden with tray false and a preview open; the second launch exited ${String(again.status)} and showed the window (${String(shown.length)} events)`
    } finally {
      void server.stop(true)
    }
  })
}
