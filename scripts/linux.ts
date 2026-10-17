/**
 * Builds and tests Runrail on Linux in Docker (scripts/linux/Dockerfile, Ubuntu 22.04). Both
 * checkouts are mounted read-only and copied into the container, so no Linux build output lands in
 * them; Cargo, Bun and build caches live in Docker volumes named runrail-linux-* (another prefix
 * through RUNRAIL_LINUX_VOLUMES, which also names the image, so two checkouts can build at once).
 *
 *   bun scripts/linux.ts check    engine tests; desktop typecheck, tests and build; the engine
 *                                 sidecar; cargo check (a warning fails it) and cargo test
 *   bun scripts/linux.ts e2e      scripts/e2e-native.ts against the real app, under Xvfb (X11)
 *                                 and then headless Weston (Wayland)
 *   bun scripts/linux.ts bundle   AppImage, deb and rpm, copied to release/linux/<arch>/
 *   bun scripts/linux.ts release  the same, signed and with the updater (docs/RELEASE.md)
 *   bun scripts/linux.ts shell    a shell in the container with both checkouts copied to /w
 *   RUNRAIL_DIR=/path/to/runrail bun scripts/linux.ts check
 *   RUNRAIL_LINUX_PLATFORM=linux/amd64 bun scripts/linux.ts bundle   x86_64 on an arm64 machine
 *
 * Every step runs even after one fails; the exit code is 1 when any failed. WebKitGTK's own
 * sandbox needs user namespaces Docker does not give, so the e2e runs it with the sandbox off.
 */

import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

const PLATFORM = process.env.RUNRAIL_LINUX_PLATFORM
if (PLATFORM !== undefined && PLATFORM !== "linux/arm64" && PLATFORM !== "linux/amd64") throw new Error("RUNRAIL_LINUX_PLATFORM must be linux/arm64 or linux/amd64")
const ARCH = (PLATFORM === undefined ? process.arch === "x64" : PLATFORM === "linux/amd64") ? "x86_64" : "aarch64"
// Another architecture gets its own image and caches.
const VOLUMES = `${process.env.RUNRAIL_LINUX_VOLUMES ?? "runrail-linux"}${PLATFORM === undefined ? "" : `-${ARCH}`}`
if (!/^[a-z0-9][a-z0-9_.-]{0,40}$/.test(VOLUMES)) throw new Error("RUNRAIL_LINUX_VOLUMES must be a short lowercase name")
const IMAGE = `${VOLUMES}-dev`
const root = resolve(import.meta.dir, "..")
const runrail = resolve(process.env.RUNRAIL_DIR ?? join(root, "..", "runrail"))
const command = process.argv[2]
if (command !== "check" && command !== "e2e" && command !== "bundle" && command !== "release" && command !== "shell") throw new Error("usage: bun scripts/linux.ts check|e2e|bundle|release|shell")
const RELEASE_CONFIG = join(root, "src-tauri", "tauri.release.conf.json")
if (command === "release" && !existsSync(RELEASE_CONFIG)) throw new Error("run `bun scripts/release.ts config` first (docs/RELEASE.md)")

// Build output, installed dependencies and local state are left out; the container makes its own.
const EXCLUDES = ["./node_modules", "./dist", "./src-tauri/target", "./src-tauri/binaries", "./.code-review-graph", "./.serena", "./.runrail"]
const copy = (from: string, to: string): string =>
  `mkdir -p ${to} && tar -C ${from} ${EXCLUDES.map((path) => `--exclude=${path}`).join(" ")} -cf - . | tar -xf - -C ${to}`

const WESTON = "export XDG_RUNTIME_DIR=$(mktemp -d) && (weston --backend=headless-backend.so --socket=wayland-e2e --width=1920 --height=1080 &) && sleep 2"
const BUNDLE = "/cache/target/release/bundle"
// linuxdeploy sets a RUNPATH on every program in usr/bin and usr/lib, which corrupts the
// Bun-compiled engine, so the AppImage carries it in usr/libexec instead (engine.rs looks there).
// Under emulation binfmt refuses an AppImage for the magic bytes in its ELF header. Tauri clears
// them in the linuxdeploy it downloads but not in linuxdeploy's AppImage plugin, so an emulated
// build fetches the plugin (the same file Tauri would) and clears them first.
const EMULATED = ARCH !== (process.arch === "x64" ? "x86_64" : "aarch64")
const PLUGIN = "~/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"
const PREFETCH = EMULATED
  ? `mkdir -p ~/.cache/tauri && curl -fsSL -o ${PLUGIN} https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-${ARCH}.AppImage && chmod +x ${PLUGIN} && printf '\\0\\0\\0' | dd of=${PLUGIN} bs=1 seek=8 conv=notrunc 2>/dev/null && `
  : ""
const APPIMAGE = Buffer.from(JSON.stringify({ bundle: { externalBin: [], linux: { appimage: { files: { "/usr/libexec/runrail/runrail": `binaries/runrail-${ARCH}-unknown-linux-gnu` } } } } })).toString("base64")
const bundle = (args: string): readonly (readonly [string, string])[] => [
  ["engine install", "cd /w/runrail && bun install --frozen-lockfile"],
  ["desktop install", "cd /w/runrail-desktop-web && bun install --frozen-lockfile"],
  ["engine sidecar", "cd /w/runrail-desktop-web && RUNRAIL_DIR=/w/runrail bun scripts/sidecar.ts"],
  ["tauri build", `rm -rf ${BUNDLE} && cd /w/runrail-desktop-web && bun run tauri build --bundles deb,rpm ${args}`],
  // linuxdeploy is itself an AppImage, and Docker has no FUSE to mount it.
  ["tauri appimage", `${PREFETCH}cd /w/runrail-desktop-web && echo ${APPIMAGE} | base64 -d > /tmp/appimage.json && APPIMAGE_EXTRACT_AND_RUN=1 bun run tauri build --bundles appimage ${args} --config /tmp/appimage.json`],
  ["copy out", `rm -rf /out/* && cp ${BUNDLE}/deb/*.deb* ${BUNDLE}/rpm/*.rpm* ${BUNDLE}/appimage/*.AppImage* /out/ && ls -la /out`],
]
const STEPS: Readonly<Record<"check" | "e2e" | "bundle" | "release", readonly (readonly [string, string])[]>> = {
  check: [
    ["engine install", "cd /w/runrail && bun install --frozen-lockfile"],
    ["engine tests", "cd /w/runrail && bun test"],
    ["desktop install", "cd /w/runrail-desktop-web && bun install --frozen-lockfile"],
    ["desktop typecheck", "cd /w/runrail-desktop-web && bun run typecheck"],
    ["desktop tests", "cd /w/runrail-desktop-web && bun test"],
    ["desktop build", "cd /w/runrail-desktop-web && bun run build"],
    ["engine sidecar", "cd /w/runrail-desktop-web && RUNRAIL_DIR=/w/runrail bun scripts/sidecar.ts"],
    ["cargo check", "cd /w/runrail-desktop-web/src-tauri && cargo check --all-targets"],
    ["cargo test", "cd /w/runrail-desktop-web/src-tauri && cargo test"],
  ],
  e2e: [
    ["engine install", "cd /w/runrail && bun install --frozen-lockfile"],
    ["desktop install", "cd /w/runrail-desktop-web && bun install --frozen-lockfile"],
    ["engine sidecar", "cd /w/runrail-desktop-web && RUNRAIL_DIR=/w/runrail bun scripts/sidecar.ts"],
    ["e2e x11", "cd /w/runrail-desktop-web && dbus-run-session -- xvfb-run -a -s '-screen 0 1920x1080x24' bun scripts/e2e-native.ts"],
    ["e2e wayland", `cd /w/runrail-desktop-web && ${WESTON} && env -u DISPLAY WAYLAND_DISPLAY=wayland-e2e GDK_BACKEND=wayland dbus-run-session -- bun scripts/e2e-native.ts`],
  ],
  bundle: bundle(""),
  release: bundle("--features updater --config src-tauri/tauri.release.conf.json"),
}

const prepare = [copy("/src/runrail", "/w/runrail"), copy("/src/desktop", "/w/runrail-desktop-web")].join(" && ")
const check = [
  "failed=()",
  `step() { echo "== $1"; if bash -c "$2"; then echo "== $1: ok"; else echo "== $1: FAILED"; failed+=("$1"); fi; }`,
  ...STEPS[command === "shell" ? "check" : command].map(([name, script]) => `step ${JSON.stringify(name)} ${JSON.stringify(script)}`),
  `if [ \${#failed[@]} -gt 0 ]; then printf '== failed: %s\\n' "\${failed[@]}"; exit 1; fi`,
  `echo "== all steps passed"`,
].join("\n")

const platform = PLATFORM === undefined ? [] : ["--platform", PLATFORM]
const built = Bun.spawnSync(["docker", "build", ...platform, "-t", IMAGE, join(root, "scripts", "linux")], { stdio: ["ignore", "inherit", "inherit"] })
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1)

const shell = command === "shell"
const packages = command === "bundle" || command === "release"
const out = join(root, "release", "linux", ARCH)
if (packages) mkdirSync(out, { recursive: true })
const run = Bun.spawnSync(
  [
    "docker", "run", "--rm", ...platform, ...(shell ? ["-it"] : []),
    "-v", `${root}:/src/desktop:ro`,
    "-v", `${runrail}:/src/runrail:ro`,
    "-v", `${VOLUMES}-cargo:/usr/local/cargo/registry`,
    "-v", `${VOLUMES}-target:/cache/target`,
    "-v", `${VOLUMES}-bun:/root/.bun/install/cache`,
    ...(packages ? ["-v", `${out}:/out`] : []),
    // Passed by name, so the signing key's value never appears in this process's arguments.
    ...(command === "release" ? ["-e", "TAURI_SIGNING_PRIVATE_KEY", "-e", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] : []),
    "-e", "CARGO_TARGET_DIR=/cache/target",
    "-e", "RUSTFLAGS=-D warnings",
    "-e", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1",
    IMAGE, "bash", "-c", `set -e; ${prepare}; set +e\n${shell ? "cd /w && exec bash" : check}`,
  ],
  { stdio: [shell ? "inherit" : "ignore", "inherit", "inherit"] },
)
process.exit(run.exitCode ?? 1)
