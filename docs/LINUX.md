# Runrail on Linux

Runrail Desktop runs on Linux with X11 or Wayland, on x86_64 and aarch64. This page covers
installing it, what the desktop needs to provide, how each feature behaves there, and how to
build and test it.

## Install

Each release has three packages per architecture:

| Package | For | Updates |
|---|---|---|
| `Runrail_<version>_amd64.deb`, `_arm64.deb` | Debian, Ubuntu, Mint, Pop!_OS | in the app, through `pkexec dpkg -i` (asks for your password) |
| `Runrail-<version>-1.x86_64.rpm`, `.aarch64.rpm` | Fedora, openSUSE, RHEL and derivatives | in the app, through `pkexec rpm -U` |
| `Runrail_<version>_amd64.AppImage`, `_aarch64.AppImage` | any distribution with glibc 2.35 or later | in the app, replacing the file |

```bash
sudo apt install ./Runrail_0.1.1_amd64.deb
```

```bash
sudo dnf install ./Runrail-0.1.1-1.x86_64.rpm
```

```bash
chmod +x Runrail_0.1.1_amd64.AppImage && ./Runrail_0.1.1_amd64.AppImage
```

The deb and rpm declare their dependencies (WebKitGTK 4.1, GTK 3, the Ayatana app indicator
library), so the package manager installs them. They also put the engine on your PATH as
`runrail`. The AppImage carries its own GTK and WebKitGTK; like every AppImage it uses the
system's graphics, font, text-layout and sound libraries (Mesa's OpenGL and OpenGL ES, fontconfig,
HarfBuzz, FriBiDi, ALSA's libasound), which any desktop has. It needs FUSE 2 to mount itself; where that is
missing (`libfuse2` on Ubuntu 24.04 is `libfuse2t64`), run it with `--appimage-extract-and-run`.

The packages are built on Ubuntu 22.04, so the oldest glibc they run on is 2.35. The install
check (below) installs and starts them on Ubuntu 22.04 and 24.04, Debian 12 and 13, Fedora 41
and 42, openSUSE Tumbleweed, and Arch (AppImage).

## What the desktop provides

| Need | Where it comes from | Without it |
|---|---|---|
| A keyring for provider keys | a Secret Service on the session bus: GNOME Keyring, KeePassXC, or KWallet 5.97+ | keys are kept in Runrail's file vault, readable only by you, and Settings says so |
| A tray icon | a StatusNotifierItem host: KDE, Cinnamon, XFCE, and GNOME with the AppIndicator extension | closing the window hides it while work runs; launching Runrail again shows it |
| System notifications | a freedesktop notification server (every desktop has one) | notes stay in the window |
| git | your distribution's `git` (the deb and rpm recommend it) | threads cannot use worktrees |

A locked keyring is an error that asks you to unlock it, never a silent switch to the file
vault.

## Features on Linux

| Feature | On Linux |
|---|---|
| Threads, engines, terminals, review, files | as on macOS |
| Browser previews | WebKitGTK, over their panel as on macOS: page reading, the agent's clicks and typing, screenshots, network and console logs, element picking, artboards and saved sign-ins; Runrail's shortcuts work while a preview has the keyboard |
| Computer use | on X11, the apps you allow, as on macOS; on Wayland, the one window you share through the desktop's dialog (below) |
| Shortcuts | Ctrl in place of Cmd, from the window without an app menu; in a terminal a plain Ctrl+letter stays with the shell, and Ctrl+Shift shortcuts reach Runrail |
| Notifications | freedesktop notifications; a click opens the thread |
| Start at login | an XDG autostart entry (`~/.config/autostart/`) that starts Runrail hidden |
| Run after Quit | a systemd user unit that runs `runrail service` and opens Runrail hidden when work is due |
| Keep awake | the logind idle inhibitor while a turn runs |
| Quick chat | Ctrl+Alt+Space; on Wayland through the desktop's GlobalShortcuts portal, which asks you once |
| Open in | the file manager (`xdg-open`), and the terminals and editors that are installed |
| Paste a key | the host reads the clipboard (X11 and Wayland), so the page never sees the key |
| Saved browser sign-ins | sealed with a key kept in the keyring; off, with the reason, without one |
| Import from other tools | their Linux (XDG) config folders |
| Phone access | Tailscale from your PATH; `tailscale serve` needs `sudo tailscale set --operator=$USER` once, which Settings says |
| Dictation | Whisper on the CPU; the model downloads through `curl` or `wget` and is checked against its pinned checksum |
| Dev servers a thread starts | found from `/proc`, no `lsof` needed |
| Android emulators | the Android tab; needs KVM (below) |
| iOS simulators | macOS only |

### Computer use

Agents see and use only what you allow in Settings > Permissions > Computer use, and the
composer's "Let the agent use apps" turns them on for a thread.

- **X11**: the same allow list as on macOS. Runrail captures the allowed app's window, raises it,
  and sends clicks, typing, keys and scrolling through the X server's XTest extension, which
  every X server has. Password managers, keyrings, settings apps, terminals and Runrail itself
  are refused whatever you allow.
- **Wayland**: an app cannot see or drive other windows, so you share one window through the
  desktop's own dialog (the remote desktop and screen cast portals), once while Runrail runs.
  That window is the only one agents may use, and stopping the share in Settings ends it.
  Wayland does not say which app a window belongs to, so never share a password manager,
  settings or a terminal. This needs `xdg-desktop-portal` with your desktop's backend (GNOME or
  KDE) and PipeWire; the deb and rpm recommend both, and Settings says which one is missing.

### Android emulators

The Android tab uses the SDK that Android Studio installs. Runrail looks in `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, then `~/Android/Sdk`, then `adb` on your PATH. The emulator needs KVM:
`/dev/kvm` must exist and you must be able to open it, which usually means being in the `kvm`
group:

```bash
sudo usermod -aG kvm "$USER"
```

Log out and in again afterwards. Typing into an emulator from Runrail takes ASCII only; paste
other text in the emulator's own window.

Agents can use running emulators too: turn on Android emulators in Settings > Permissions >
Computer use. They see the screen and tap, swipe, type and press keys through `adb`, on X11 and
Wayland alike, without sharing a window.

## Troubleshooting

- **A blank or flickering window**: Runrail already turns off WebKitGTK's DMA-BUF renderer with
  NVIDIA's own driver and in VMware and VirtualBox guests. On another GPU that shows it, start
  Runrail with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- **Computer use says the portal or PipeWire is missing** (Wayland): install
  `xdg-desktop-portal` and your desktop's backend (`xdg-desktop-portal-gnome` or
  `xdg-desktop-portal-kde`) and PipeWire, then log out and in again.
- **Keys are in the file vault although a keyring runs**: check that the keyring answers on the
  session bus (`busctl --user status org.freedesktop.secrets`), then restart Runrail.
- **The AppImage does not start**: run it from a terminal to see why; without FUSE 2 use
  `--appimage-extract-and-run`.

## Build and test

Everything runs in Docker from a Mac or a Linux machine, with both checkouts side by side:

```bash
bun scripts/linux.ts check
```

```bash
bun scripts/linux.ts e2e
```

```bash
bun scripts/linux.ts bundle
```

```bash
bun scripts/linux-matrix.ts
```

`check` runs the engine and desktop tests, the typecheck, the build and `cargo check` (where a
warning fails it) and `cargo test` on Ubuntu 22.04. `e2e` drives the real app under Xvfb (X11)
and headless Weston (Wayland). `bundle` builds the deb, rpm and AppImage for this machine's
architecture into `release/linux/<arch>/`; `RUNRAIL_LINUX_PLATFORM=linux/amd64` builds x86_64 on
an arm64 machine, under emulation and slowly. `linux-matrix.ts` installs those packages on clean
containers of each distribution above and checks that the engine answers, the window opens, and
the app stays up.

A signed release with the updater: write the release config as in [RELEASE.md](./RELEASE.md),
export the signing key, then build:

```bash
bun scripts/release.ts config
```

```bash
bun scripts/linux.ts release
```

The signing key reaches the container through the environment by name, never as an argument.
`bun scripts/release.ts manifest` then adds `linux-<arch>-appimage`, `-deb` and `-rpm` entries to
`latest.json`, so each installed package updates from its own kind.

To build on a Linux machine directly, install the build dependencies (Ubuntu or Debian):

```bash
sudo apt install build-essential clang cmake curl file git pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev
```

then Rust, Bun, and `bun install`, `bun run sidecar` and `bun run tauri dev` as in the README.

## Not verified without a Linux desktop

The checks above run in containers with Xvfb, headless Weston, a session bus, GNOME Keyring and
a notification server. These need a real desktop session and were not checked there:

- the tray icon in a real panel, and the GNOME extension;
- GPU rendering, and the DMA-BUF fallback on real NVIDIA, VMware and VirtualBox;
- computer use on Wayland: the portal dialogs, the shared window's picture over PipeWire, and
  input through the portal, on GNOME and KDE (the containers have no portal backend);
- the microphone through PipeWire or PulseAudio;
- start at login and run after Quit across a real log-out;
- an installed package updating itself.
