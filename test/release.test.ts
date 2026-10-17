import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { githubReleasePlatforms, grantedEntitlements, linuxPlatforms, macBuildEnvironment, macOptions, macReleaseConfig, macSignCommands, notaryCredentials, releaseConfig, updateManifest } from "../scripts/release"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const pubkey = Buffer.from("untrusted comment: minisign public key: 0123456789ABCDEF\nRWQBI0VniavN7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n").toString("base64") // gitleaks:allow

test("release config carries only the public key and an https feed", () => {
  const config = releaseConfig({ pubkey, endpoint: "https://updates.example.com/runrail/{{target}}-{{arch}}/{{current_version}}/latest.json" })
  expect(config).toEqual({
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey, endpoints: ["https://updates.example.com/runrail/{{target}}-{{arch}}/{{current_version}}/latest.json"], requireSignedVersion: true } },
  })
  expect(() => releaseConfig({ pubkey, endpoint: "http://updates.example.com/latest.json" })).toThrow("https")
  expect(() => releaseConfig({ pubkey, endpoint: "https://user:secret@updates.example.com/latest.json" })).toThrow("without credentials")
  expect(() => releaseConfig({ pubkey: "not-a-key", endpoint: "https://updates.example.com/latest.json" })).toThrow("tauri signer generate")
})

test("update manifest lists signed bundles per platform", () => {
  const manifest = updateManifest({
    version: "0.2.0",
    notes: "  Faster imports.  ",
    pubDate: new Date("2026-09-30T09:00:00Z"),
    platforms: [{ key: "darwin-aarch64", url: "https://dl.example.com/0.2.0/darwin-aarch64/Runrail.app.tar.gz", signature: "sig\n" }],
  })
  expect(manifest).toEqual({
    version: "0.2.0",
    notes: "Faster imports.",
    pub_date: "2026-09-30T09:00:00.000Z",
    platforms: { "darwin-aarch64": { url: "https://dl.example.com/0.2.0/darwin-aarch64/Runrail.app.tar.gz", signature: "sig" } },
  })
  expect(() => updateManifest({ version: "0.2", pubDate: new Date(), platforms: [] })).toThrow("semver")
  expect(() => updateManifest({ version: "0.2.0", pubDate: new Date(), platforms: [] })).toThrow("no signed bundles")
  expect(() => updateManifest({ version: "0.2.0", pubDate: new Date(), platforms: [{ key: "darwin-aarch64", url: "http://x", signature: "s" }] })).toThrow("https")
})

test("Linux bundles are listed per architecture and bundle type, signed ones only", () => {
  const dir = mkdtempSync(join(tmpdir(), "runrail-release-"))
  dirs.push(dir)
  mkdirSync(join(dir, "aarch64"))
  mkdirSync(join(dir, "x86_64"))
  for (const [arch, name] of [["aarch64", "Runrail_0.2.0_aarch64.AppImage"], ["aarch64", "Runrail_0.2.0_arm64.deb"], ["aarch64", "Runrail-0.2.0-1.aarch64.rpm"], ["x86_64", "Runrail_0.2.0_amd64.deb"]] as const) {
    writeFileSync(join(dir, arch, name), "bundle")
    writeFileSync(join(dir, arch, `${name}.sig`), `sig ${name}\n`)
  }
  writeFileSync(join(dir, "x86_64", "Runrail_0.2.0_amd64.AppImage"), "unsigned")
  const platforms = linuxPlatforms(dir, "https://dl.example.com", "0.2.0")
  expect(platforms.map((platform) => [platform.key, platform.url])).toEqual([
    ["linux-aarch64-appimage", "https://dl.example.com/0.2.0/linux-aarch64-appimage/Runrail_0.2.0_aarch64.AppImage"],
    ["linux-aarch64-deb", "https://dl.example.com/0.2.0/linux-aarch64-deb/Runrail_0.2.0_arm64.deb"],
    ["linux-aarch64-rpm", "https://dl.example.com/0.2.0/linux-aarch64-rpm/Runrail-0.2.0-1.aarch64.rpm"],
    ["linux-x86_64-deb", "https://dl.example.com/0.2.0/linux-x86_64-deb/Runrail_0.2.0_amd64.deb"],
  ])
  const manifest = updateManifest({ version: "0.2.0", pubDate: new Date("2026-09-30T09:00:00Z"), platforms }) as { platforms: Record<string, { signature: string }> }
  expect(manifest.platforms["linux-aarch64-rpm"]?.signature).toBe("sig Runrail-0.2.0-1.aarch64.rpm")
  expect(() => updateManifest({ version: "0.2.0", pubDate: new Date(), platforms: [{ key: "linux-aarch64-snap", url: "https://x", signature: "s" }] })).toThrow("unknown platform")
})

const app = "/build/Runrail.app"
const signing = { app, identifier: "com.runrail.desktop", appEntitlements: "/src/Entitlements.plist", engineEntitlements: "/src/Engine.entitlements.plist" }

test("the engine is signed with its own entitlements first, then the bundle with the app's", () => {
  expect(macSignCommands({ ...signing, identity: "-" })).toEqual([
    ["codesign", "--force", "--options", "runtime", "--sign", "-", "--identifier", "com.runrail.desktop.engine", "--entitlements", "/src/Engine.entitlements.plist", `${app}/Contents/MacOS/runrail`],
    ["codesign", "--force", "--options", "runtime", "--sign", "-", "--entitlements", "/src/Entitlements.plist", app],
  ])
  const identity = "Developer ID Application: Runrail (ABCDE12345)"
  for (const command of macSignCommands({ ...signing, identity })) {
    expect(command.slice(0, 7)).toEqual(["codesign", "--force", "--options", "runtime", "--sign", identity, "--timestamp"])
    expect(command).not.toContain("--deep")
  }
})

test("only the engine may JIT; the app binary keeps the microphone alone", () => {
  const root = join(import.meta.dir, "..", "src-tauri")
  expect(grantedEntitlements(readFileSync(join(root, "Entitlements.plist"), "utf8"))).toEqual(["com.apple.security.device.audio-input"])
  expect(grantedEntitlements(readFileSync(join(root, "Engine.entitlements.plist"), "utf8"))).toEqual(["com.apple.security.cs.allow-jit"])
  const dumped = `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.get-task-allow</key><false/></dict></plist>`
  expect(grantedEntitlements(dumped)).toEqual(["com.apple.security.cs.allow-jit"])
})

test("mac options take an ad-hoc or Developer ID identity and a macOS target", () => {
  expect(macOptions(["--identity", "-"], {}, "arm64")).toEqual({ identity: "-", arch: "aarch64" })
  expect(macOptions(["--target", "x86_64-apple-darwin"], { APPLE_SIGNING_IDENTITY: "Developer ID Application: Runrail (ABCDE12345)" }, "arm64")).toEqual({
    identity: "Developer ID Application: Runrail (ABCDE12345)",
    target: "x86_64-apple-darwin",
    arch: "x64",
  })
  expect(macOptions(["--identity", "-"], {}, "x64").arch).toBe("x64")
  expect(() => macOptions([], {}, "arm64")).toThrow("--identity must be")
  expect(() => macOptions(["--identity", "Apple Development: someone@example.com (ABCDE12345)"], {}, "arm64")).toThrow("Developer ID Application")
  expect(() => macOptions(["--identity"], {}, "arm64")).toThrow("needs a value")
  expect(() => macOptions(["--identity", "-", "--target", "x86_64-pc-windows-msvc"], {}, "arm64")).toThrow("unknown macOS target")
  expect(() => macOptions(["--deep"], {}, "arm64")).toThrow("unknown option")
})

test("tauri build sees no signing or notarizing credentials, and makes no update archive", () => {
  const env = macBuildEnvironment({ PATH: "/usr/bin", APPLE_SIGNING_IDENTITY: "x", APPLE_API_KEY: "x", APPLE_API_KEY_PATH: "x", APPLE_PASSWORD: "x", APPLE_CERTIFICATE: "x", TAURI_SIGNING_PRIVATE_KEY: "x", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "x" })
  expect(env).toEqual({ PATH: "/usr/bin" })
  expect(macReleaseConfig(undefined)).toEqual({ bundle: { createUpdaterArtifacts: false } })
  const config = macReleaseConfig({ pubkey, endpoint: "https://updates.example.com/latest.json" }) as { bundle: unknown; plugins: { updater: { pubkey: string } } }
  expect(config.bundle).toEqual({ createUpdaterArtifacts: false })
  expect(config.plugins.updater.pubkey).toBe(pubkey)
})

test("notarizing uses a keychain profile or an API key, never a password", () => {
  expect(notaryCredentials({ RUNRAIL_NOTARY_PROFILE: "runrail" })).toEqual(["--keychain-profile", "runrail"])
  expect(notaryCredentials({ APPLE_API_KEY: "KEY123", APPLE_API_ISSUER: "issuer-uuid", APPLE_API_KEY_PATH: "/keys/AuthKey_KEY123.p8" })).toEqual([
    "--key", "/keys/AuthKey_KEY123.p8", "--key-id", "KEY123", "--issuer", "issuer-uuid",
  ])
  expect(() => notaryCredentials({ APPLE_ID: "someone@example.com", APPLE_PASSWORD: "app-password", APPLE_TEAM_ID: "ABCDE12345" })).toThrow("RUNRAIL_NOTARY_PROFILE")
  expect(() => notaryCredentials({ APPLE_API_KEY: "KEY123" })).toThrow("APPLE_API_KEY_PATH")
})

test("a GitHub release offers each signed bundle to the platform it updates", () => {
  const bundles = [
    "Runrail_0.1.0_aarch64.app.tar.gz", "Runrail_0.1.0_x64.app.tar.gz",
    "Runrail_0.1.0_amd64.AppImage", "Runrail_0.1.0_aarch64.AppImage", "Runrail_0.1.0_amd64.deb", "Runrail_0.1.0_arm64.deb",
    "Runrail-0.1.0-1.x86_64.rpm", "Runrail-0.1.0-1.aarch64.rpm", "Runrail_0.1.0_x64-setup.exe", "Runrail_0.1.0_x64_en-US.msi",
  ]
  const files = [...bundles, ...bundles.map((file) => `${file}.sig`), "Runrail_0.1.0_aarch64.dmg", "Runrail_0.1.0_x64.dmg", "SHA256SUMS.txt"]
  const platforms = githubReleasePlatforms(files, (file) => `sig ${file}`, "TechDev009/runrail-desktop", "v0.1.0")
  expect(Object.fromEntries(platforms.map((platform) => [platform.key, platform.url.replace("https://github.com/TechDev009/runrail-desktop/releases/download/v0.1.0/", "")]))).toEqual({
    "darwin-aarch64": "Runrail_0.1.0_aarch64.app.tar.gz",
    "darwin-x86_64": "Runrail_0.1.0_x64.app.tar.gz",
    "linux-x86_64-appimage": "Runrail_0.1.0_amd64.AppImage",
    "linux-aarch64-appimage": "Runrail_0.1.0_aarch64.AppImage",
    "linux-x86_64-deb": "Runrail_0.1.0_amd64.deb",
    "linux-aarch64-deb": "Runrail_0.1.0_arm64.deb",
    "linux-x86_64-rpm": "Runrail-0.1.0-1.x86_64.rpm",
    "linux-aarch64-rpm": "Runrail-0.1.0-1.aarch64.rpm",
    "windows-x86_64-nsis": "Runrail_0.1.0_x64-setup.exe",
    "windows-x86_64-msi": "Runrail_0.1.0_x64_en-US.msi",
  })
  expect(platforms.find((platform) => platform.key === "darwin-aarch64")?.signature).toBe("sig Runrail_0.1.0_aarch64.app.tar.gz")
  expect(updateManifest({ version: "0.1.0", pubDate: new Date("2026-10-13T00:00:00Z"), platforms })).toMatchObject({ version: "0.1.0" })
})

test("an unsigned bundle is not offered, and a release feed needs a real repository and version tag", () => {
  expect(githubReleasePlatforms(["Runrail_0.1.0_amd64.deb", "Runrail_0.1.0_arm64.deb", "Runrail_0.1.0_arm64.deb.sig"], () => "s", "o/r", "v0.1.0").map((platform) => platform.key)).toEqual(["linux-aarch64-deb"])
  expect(githubReleasePlatforms(["Runrail_0.1.0_aarch64.app.tar.gz", "Runrail_0.1.0_aarch64.app.tar.gz.sig"], () => "s", "o/r", "v0.2.0-beta.1")[0]?.url).toBe("https://github.com/o/r/releases/download/v0.2.0-beta.1/Runrail_0.1.0_aarch64.app.tar.gz")
  expect(() => githubReleasePlatforms(["A_0.1.0_amd64.deb", "A_0.1.0_amd64.deb.sig", "B_0.1.0_amd64.deb", "B_0.1.0_amd64.deb.sig"], () => "s", "o/r", "v0.1.0")).toThrow("two bundles for linux-x86_64-deb")
  expect(() => githubReleasePlatforms([], () => "s", "https://github.com/o/r", "v0.1.0")).toThrow("owner/name")
  expect(() => githubReleasePlatforms([], () => "s", "o/r", "0.1.0")).toThrow("v<semver>")
})
