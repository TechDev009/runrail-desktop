/**
 * Installs the Linux packages `bun scripts/linux.ts bundle` left in release/linux/<arch>/ on clean
 * distribution containers and starts them: the package installs with its declared dependencies,
 * the engine answers, and the app opens its window under Xvfb, starts its engine and stays up.
 *
 *   bun scripts/linux-matrix.ts                 every distribution below
 *   bun scripts/linux-matrix.ts fedora:42 ...   only those images
 *   RUNRAIL_LINUX_PLATFORM=linux/amd64 bun scripts/linux-matrix.ts   the x86_64 packages, emulated
 */

import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

type Kind = "deb" | "rpm" | "appimage"

interface Distro {
  readonly image: string
  readonly kind: Kind
  /** Installs the package at /pkg/<file> and what the check needs (Xvfb, xwininfo). */
  readonly install: string
  readonly amd64?: true
}

const APT = "export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq"
const DISTROS: readonly Distro[] = [
  { image: "ubuntu:22.04", kind: "deb", install: `${APT} /pkg/$PKG xvfb xauth x11-utils >/dev/null` },
  { image: "ubuntu:24.04", kind: "deb", install: `${APT} /pkg/$PKG xvfb xauth x11-utils >/dev/null` },
  { image: "debian:12", kind: "deb", install: `${APT} /pkg/$PKG xvfb xauth x11-utils >/dev/null` },
  { image: "debian:13", kind: "deb", install: `${APT} /pkg/$PKG xvfb xauth x11-utils >/dev/null` },
  { image: "fedora:41", kind: "rpm", install: "dnf install -y -q /pkg/$PKG xorg-x11-server-Xvfb xauth xwininfo procps-ng >/dev/null" },
  { image: "fedora:42", kind: "rpm", install: "dnf install -y -q /pkg/$PKG xorg-x11-server-Xvfb xauth xwininfo procps-ng >/dev/null" },
  { image: "opensuse/tumbleweed", kind: "rpm", install: "zypper --non-interactive -q install --allow-unsigned-rpm /pkg/$PKG xvfb-run xwininfo procps >/dev/null" },
  // The AppImage carries its own GTK and WebKitGTK but, like every AppImage, takes the graphics,
  // font, text-layout and sound (ALSA) libraries from the system (AppImage's exclude list), which any desktop has.
  { image: "ubuntu:24.04", kind: "appimage", install: `${APT} xvfb xauth x11-utils libgtk-3-0t64 libegl1 libgl1 libgles2 libgbm1 libasound2t64 >/dev/null` },
  // Arch publishes x86_64 images only; under qemu pacman's download sandbox cannot set up its seccomp filter.
  { image: "archlinux:latest", kind: "appimage", install: "pacman -Sy --disable-sandbox --noconfirm --quiet xorg-server-xvfb xorg-xauth xorg-xwininfo procps-ng gtk3 mesa alsa-lib >/dev/null", amd64: true },
]

const PLATFORM = process.env.RUNRAIL_LINUX_PLATFORM ?? `linux/${process.arch === "x64" ? "amd64" : "arm64"}`
if (PLATFORM !== "linux/arm64" && PLATFORM !== "linux/amd64") throw new Error("RUNRAIL_LINUX_PLATFORM must be linux/arm64 or linux/amd64")
const root = resolve(import.meta.dir, "..")
const dir = join(root, "release", "linux", PLATFORM === "linux/amd64" ? "x86_64" : "aarch64")
const files = existsSync(dir) ? readdirSync(dir) : []
const packageFor = (kind: Kind): string | undefined => files.find((file) => file.endsWith(kind === "appimage" ? ".AppImage" : `.${kind}`))
const wanted = process.argv.slice(2)
const distros = DISTROS.filter((distro) => (wanted.length === 0 || wanted.includes(distro.image)) && (distro.amd64 !== true || PLATFORM === "linux/amd64"))

// The engine prints its usage (the AppImage's from inside it); the app runs as a user with its own
// home, and after 15 seconds it is still running with its window mapped.
const EMULATED = PLATFORM !== `linux/${process.arch === "x64" ? "amd64" : "arm64"}`
// Under qemu the kernel's binfmt handler reads the AppImage's magic bytes at offset 8 as its own and
// refuses the file, so the emulated run starts a copy with them cleared; a real x86_64 host is unaffected.
const APPIMAGE = EMULATED ? "/tmp/Runrail.AppImage" : "/pkg/$PKG"
const smoke = (kind: Kind): string => {
  const app = kind === "appimage" ? `${APPIMAGE} --appimage-extract-and-run` : "runrail-desktop-web"
  const engine = kind === "appimage" ? `(cd /tmp && ${APPIMAGE} --appimage-extract usr/libexec/runrail/runrail >/dev/null && ./squashfs-root/usr/libexec/runrail/runrail)` : "runrail"
  return [
    kind === "appimage" && EMULATED ? `cp /pkg/$PKG ${APPIMAGE} && printf '\\0\\0\\0' | dd of=${APPIMAGE} bs=1 seek=8 conv=notrunc 2>/dev/null && chmod 755 ${APPIMAGE}` : "true",
    "useradd -m tester >/dev/null 2>&1",
    `${engine} 2>&1 | head -1 | grep -q '^usage: runrail' && echo 'engine: answers'`,
    `su tester -c "cd ~ && (xvfb-run -a -s '-screen 0 1440x900x24' sh -c '${app} > /tmp/app.log 2>&1 & sleep 15; xwininfo -root -tree | grep -q \\"Runrail\\" && echo window: shown; pgrep -x runrail-desktop >/dev/null && echo app: running; pgrep -x runrail >/dev/null && echo engine: started by the app')"`,
    "tail -5 /tmp/app.log 2>/dev/null | sed 's/^/  log: /'",
  ].join("; ")
}

let failed = 0
for (const distro of distros) {
  const file = packageFor(distro.kind)
  if (file === undefined) {
    console.log(`${distro.image} ${distro.kind}: no package in ${dir}`)
    failed += 1
    continue
  }
  const script = `set -e; export PKG=${JSON.stringify(file)}; ${distro.install}; set +e; ${smoke(distro.kind)}`
  const run = Bun.spawnSync(["docker", "run", "--rm", "--platform", PLATFORM, "-v", `${dir}:/pkg:ro`, distro.image, "bash", "-c", script], { stdout: "pipe", stderr: "pipe" })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`.trim()
  const ok = run.exitCode === 0 && out.includes("window: shown") && out.includes("app: running") && out.includes("engine: answers") && out.includes("engine: started by the app")
  if (!ok) failed += 1
  console.log(`${ok ? "ok  " : "FAIL"} ${distro.image} ${distro.kind} ${file}`)
  for (const line of out.split("\n").filter((entry) => entry.startsWith("engine") || entry.startsWith("window:") || entry.startsWith("app:"))) console.log(`     ${line}`)
  if (!ok) console.log(out.split("\n").slice(-15).map((line) => `     ${line}`).join("\n"))
}
console.log(`\n${String(distros.length - failed)}/${String(distros.length)} distributions passed`)
process.exit(failed === 0 ? 0 : 1)
