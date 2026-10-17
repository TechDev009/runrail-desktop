/**
 * Release helpers for signed, auto-updating builds. See docs/RELEASE.md.
 *
 *   bun scripts/release.ts config     writes src-tauri/tauri.release.conf.json from the environment
 *                                     (the Linux release build reads it)
 *   bun scripts/release.ts mac        builds the macOS app, signs the engine and the app each with
 *                                     their own entitlements, and makes the DMG and, with an updater
 *                                     key, the signed update archive. A Developer ID identity also
 *                                     notarizes and staples both.
 *                                       --identity <"Developer ID Application: ..." | ->  (- is ad hoc)
 *                                       --target <aarch64-apple-darwin | x86_64-apple-darwin>
 *   bun scripts/release.ts manifest   writes release/latest.json from the built bundles: macOS from
 *                                     src-tauri/target, Linux from release/linux/<arch>/
 *   bun scripts/release.ts feed       writes <dir>/latest.json for a GitHub release from the signed
 *                                     bundles collected in <dir> (the CI release job):
 *                                       --dir <dir> --repository <owner/name> --tag <v1.2.3>
 *
 * Signing keys and Apple credentials stay in the environment or the keychain, where codesign,
 * notarytool, and the Tauri CLI read them. This script passes on only names: the signing identity,
 * the App Store Connect key's id, issuer, and file path, or a notarytool keychain profile. It never
 * reads, prints, or writes a secret.
 */

import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

export interface ReleaseConfigInput {
  /** The updater public key printed by `tauri signer generate` (base64 minisign key). */
  readonly pubkey: string
  /** The update feed. Tauri substitutes `{{target}}`, `{{arch}}`, and `{{current_version}}`. */
  readonly endpoint: string
}

/** The Tauri config overlay merged into release builds with `tauri build --config`. */
export function releaseConfig(input: ReleaseConfigInput): Record<string, unknown> {
  const pubkey = input.pubkey.trim()
  let decoded = ""
  try {
    decoded = Buffer.from(pubkey, "base64").toString("utf8")
  } catch {
    decoded = ""
  }
  if (!/^untrusted comment: /.test(decoded) || pubkey.length > 1_024) {
    throw new Error("RUNRAIL_UPDATER_PUBKEY must be the base64 public key printed by `tauri signer generate`")
  }
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint.trim())
  } catch {
    throw new Error("RUNRAIL_UPDATE_URL must be an absolute https URL")
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("RUNRAIL_UPDATE_URL must be an https URL without credentials")
  }
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      // Every update archive is signed with its version, so a feed cannot pair a new version
      // number with an older, validly signed archive to force a downgrade.
      updater: { pubkey, endpoints: [decodeURI(endpoint.toString())], requireSignedVersion: true },
    },
  }
}

export interface ManifestPlatform {
  /**
   * Tauri's `<os>-<arch>` key, for example `darwin-aarch64`, or `<os>-<arch>-<bundle>`: an
   * installed deb, rpm, or AppImage looks for its own bundle type first.
   */
  readonly key: string
  readonly url: string
  readonly signature: string
}

export interface ManifestInput {
  readonly version: string
  readonly notes?: string
  readonly pubDate: Date
  readonly platforms: readonly ManifestPlatform[]
}

/** The static update feed (`latest.json`) that the updater reads. */
export function updateManifest(input: ManifestInput): Record<string, unknown> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error("version must be semver")
  if (input.platforms.length === 0) throw new Error("no signed bundles were found")
  const platforms: Record<string, { url: string; signature: string }> = {}
  for (const platform of input.platforms) {
    if (!/^(darwin|linux|windows)-(aarch64|x86_64|i686|armv7)(?:-(app|appimage|deb|rpm|msi|nsis))?$/.test(platform.key)) throw new Error(`unknown platform ${platform.key}`)
    if (!platform.url.startsWith("https://")) throw new Error("bundle URLs must be https")
    if (platform.signature.trim().length === 0) throw new Error(`missing signature for ${platform.key}`)
    platforms[platform.key] = { url: platform.url, signature: platform.signature.trim() }
  }
  return {
    version: input.version,
    ...(input.notes === undefined || input.notes.trim() === "" ? {} : { notes: input.notes.trim().slice(0, 4_000) }),
    pub_date: input.pubDate.toISOString(),
    platforms,
  }
}

const LINUX_BUNDLES = [[".AppImage", "appimage"], [".deb", "deb"], [".rpm", "rpm"]] as const

/** The signed Linux bundles in `<dir>/<arch>/`, as `scripts/linux.ts release` leaves them. */
export function linuxPlatforms(dir: string, base: string, version: string): ManifestPlatform[] {
  const platforms: ManifestPlatform[] = []
  for (const arch of ["aarch64", "x86_64"]) {
    const archDir = join(dir, arch)
    if (!existsSync(archDir)) continue
    const files = readdirSync(archDir)
    for (const [suffix, bundle] of LINUX_BUNDLES) {
      const file = files.find((name) => name.endsWith(suffix))
      if (file === undefined || !files.includes(`${file}.sig`)) continue
      const key = `linux-${arch}-${bundle}`
      platforms.push({ key, url: `${base}/${version}/${key}/${encodeURIComponent(file)}`, signature: readFileSync(join(archDir, `${file}.sig`), "utf8") })
    }
  }
  return platforms
}

/** Bundle file names as the CI builds name them, and the update platform each one serves. */
const RELEASE_PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/_aarch64\.app\.tar\.gz$/, "darwin-aarch64"],
  [/_x64\.app\.tar\.gz$/, "darwin-x86_64"],
  [/_aarch64\.AppImage$/, "linux-aarch64-appimage"],
  [/_amd64\.AppImage$/, "linux-x86_64-appimage"],
  [/_arm64\.deb$/, "linux-aarch64-deb"],
  [/_amd64\.deb$/, "linux-x86_64-deb"],
  [/\.aarch64\.rpm$/, "linux-aarch64-rpm"],
  [/\.x86_64\.rpm$/, "linux-x86_64-rpm"],
  [/_x64-setup\.exe$/, "windows-x86_64-nsis"],
  [/_x64_[A-Za-z-]+\.msi$/, "windows-x86_64-msi"],
]

/**
 * The update platforms among a GitHub release's files: each bundle with a `.sig` beside it, at
 * the release's download URL. A file that matches no platform, or has no signature, is not offered.
 */
export function githubReleasePlatforms(files: readonly string[], signatureOf: (file: string) => string, repository: string, tag: string): ManifestPlatform[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name")
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("tag must be v<semver>")
  const names = new Set(files)
  const platforms: ManifestPlatform[] = []
  for (const file of [...files].sort()) {
    const key = RELEASE_PLATFORMS.find(([pattern]) => pattern.test(file))?.[1]
    if (key === undefined || !names.has(`${file}.sig`)) continue
    if (platforms.some((platform) => platform.key === key)) throw new Error(`two bundles for ${key}`)
    platforms.push({ key, url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(file)}`, signature: signatureOf(file) })
  }
  return platforms
}

export interface MacOptions {
  /** A Developer ID Application identity, or `-` to sign ad hoc: that runs where it was built, and Gatekeeper stops a downloaded copy. */
  readonly identity: string
  readonly target?: "aarch64-apple-darwin" | "x86_64-apple-darwin"
  /** The architecture in Tauri's bundle file names. */
  readonly arch: "aarch64" | "x64"
}

/** Reads `mac`'s flags; the identity falls back to `APPLE_SIGNING_IDENTITY`. */
export function macOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, hostArch: string): MacOptions {
  let identity = env.APPLE_SIGNING_IDENTITY
  let target: string | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]]
    if (flag !== "--identity" && flag !== "--target") throw new Error(`unknown option ${String(flag)}`)
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`)
    if (flag === "--identity") identity = value
    else target = value
  }
  if (identity === undefined || !(identity === "-" || /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity) || /^[0-9A-F]{40}$/i.test(identity))) {
    throw new Error("--identity must be - (ad hoc) or a Developer ID Application identity")
  }
  if (target !== undefined && target !== "aarch64-apple-darwin" && target !== "x86_64-apple-darwin") throw new Error(`unknown macOS target ${target}`)
  const arch = (target ?? (hostArch === "arm64" ? "aarch64" : "x86_64")).startsWith("aarch64") ? "aarch64" : "x64"
  return { identity, ...(target === undefined ? {} : { target }), arch }
}

/** What `tauri build` may not see on macOS: signing and notarizing happen after it, here. */
const SIGNING_ENVIRONMENT = [
  "APPLE_SIGNING_IDENTITY", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH",
  "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PATH", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
] as const

export function macBuildEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const kept = { ...env }
  for (const name of SIGNING_ENVIRONMENT) delete kept[name]
  return kept
}

/**
 * The config overlay for the macOS build. Tauri would make the update archive from the app before
 * it is re-signed, so `mac` makes it afterwards instead.
 */
export function macReleaseConfig(updater: ReleaseConfigInput | undefined): Record<string, unknown> {
  return { ...(updater === undefined ? {} : releaseConfig(updater)), bundle: { createUpdaterArtifacts: false } }
}

/** notarytool's credential flags: a keychain profile, or an App Store Connect API key. */
export function notaryCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  const set = (name: string) => (env[name]?.trim() ?? "") !== ""
  if (set("RUNRAIL_NOTARY_PROFILE")) return ["--keychain-profile", String(env.RUNRAIL_NOTARY_PROFILE)]
  if (set("APPLE_API_KEY") && set("APPLE_API_ISSUER") && set("APPLE_API_KEY_PATH")) {
    return ["--key", String(env.APPLE_API_KEY_PATH), "--key-id", String(env.APPLE_API_KEY), "--issuer", String(env.APPLE_API_ISSUER)]
  }
  throw new Error("a Developer ID build is notarized: set RUNRAIL_NOTARY_PROFILE, or APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH")
}

export const macEngine = (app: string): string => join(app, "Contents", "MacOS", "runrail")

export interface MacSigning {
  readonly app: string
  readonly identity: string
  /** The app's bundle identifier; the engine is signed as `<identifier>.engine`. */
  readonly identifier: string
  readonly appEntitlements: string
  readonly engineEntitlements: string
}

/**
 * The codesign runs, inside out: the engine with its own entitlements, then the bundle, which signs
 * the app binary and seals the engine's signature. Tauri's bundler signs every binary with one
 * entitlements file, and only the engine should get JIT.
 */
export function macSignCommands(signing: MacSigning): string[][] {
  const base = ["codesign", "--force", "--options", "runtime", "--sign", signing.identity, ...(signing.identity === "-" ? [] : ["--timestamp"])]
  return [
    [...base, "--identifier", `${signing.identifier}.engine`, "--entitlements", signing.engineEntitlements, macEngine(signing.app)],
    [...base, "--entitlements", signing.appEntitlements, signing.app],
  ]
}

/** The entitlements a plist grants, as in an entitlements file or `codesign -d --entitlements - --xml`. */
export function grantedEntitlements(plist: string): string[] {
  return [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)].map((match) => String(match[1])).sort()
}

const TRIPLES: Record<string, string> = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") throw new Error(`${name} is not set`)
  return value
}

function writeConfig(root: string): void {
  const config = releaseConfig({ pubkey: required("RUNRAIL_UPDATER_PUBKEY"), endpoint: required("RUNRAIL_UPDATE_URL") })
  const path = join(root, "src-tauri", "tauri.release.conf.json")
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`wrote ${path}`)
}

/** Collects `<name>.app.tar.gz` + `.sig` pairs from each target's bundle directory, then Linux's. */
function writeManifest(root: string): void {
  const base = required("RUNRAIL_DOWNLOAD_BASE").replace(/\/+$/, "")
  const version = String((JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as { version?: unknown }).version)
  const platforms: ManifestPlatform[] = []
  for (const [triple, key] of Object.entries(TRIPLES)) {
    for (const dir of [join(root, "src-tauri", "target", triple, "release", "bundle", "macos"), join(root, "src-tauri", "target", "release", "bundle", "macos")]) {
      if (!existsSync(dir)) continue
      const archive = readdirSync(dir).find((name) => name.endsWith(".app.tar.gz"))
      if (archive === undefined || !existsSync(join(dir, `${archive}.sig`))) continue
      if (dir.includes(join("target", "release")) && triple !== hostTriple()) continue
      platforms.push({ key, url: `${base}/${version}/${key}/${encodeURIComponent(archive)}`, signature: readFileSync(join(dir, `${archive}.sig`), "utf8") })
      break
    }
  }
  platforms.push(...linuxPlatforms(join(root, "release", "linux"), base, version))
  const notes = process.env.RUNRAIL_RELEASE_NOTES
  const manifest = updateManifest({ version, pubDate: new Date(), platforms, ...(notes === undefined ? {} : { notes }) })
  mkdirSync(join(root, "release"), { recursive: true })
  const path = join(root, "release", "latest.json")
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${path} for ${platforms.map((platform) => platform.key).join(", ")}`)
}

/** Writes `<dir>/latest.json` for the GitHub release of `--tag`, from the signed bundles in `<dir>`. */
function writeFeed(argv: readonly string[]): void {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]]
    if (flag !== "--dir" && flag !== "--repository" && flag !== "--tag") throw new Error(`unknown option ${String(flag)}`)
    if (value === undefined) throw new Error(`${flag} needs a value`)
    flags.set(flag, value)
  }
  const [dir, repository, tag] = ["--dir", "--repository", "--tag"].map((flag) => {
    const value = flags.get(flag)
    if (value === undefined) throw new Error("usage: bun scripts/release.ts feed --dir <bundles> --repository <owner/name> --tag <v1.2.3>")
    return value
  }) as [string, string, string]
  const platforms = githubReleasePlatforms(readdirSync(dir), (file) => readFileSync(join(dir, `${file}.sig`), "utf8"), repository, tag)
  const manifest = updateManifest({ version: tag.slice(1), notes: `Release notes: https://github.com/${repository}/releases/tag/${tag}`, pubDate: new Date(), platforms })
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${join(dir, "latest.json")} for ${platforms.map((platform) => platform.key).join(", ")}`)
}

function hostTriple(): string {
  return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
}

function run(command: readonly string[], options: { cwd?: string; env?: Record<string, string | undefined>; capture?: boolean } = {}): { stdout: string; stderr: string } {
  const [file = "", ...args] = command
  const result = spawnSync(file, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8", stdio: options.capture === true ? "pipe" : "inherit", maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = options.capture === true ? `: ${`${result.stderr}${result.stdout}`.trim().slice(-2_000)}` : ""
    throw new Error(`${command.slice(0, 2).join(" ")} failed (exit ${String(result.status)})${detail}`)
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** Every Mach-O file in the bundle, so code the signing plan does not cover is caught before notarization is. */
function machOFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...machOFiles(path))
    else if (entry.isFile()) {
      const head = Buffer.alloc(4)
      const fd = openSync(path, "r")
      try {
        readSync(fd, head, 0, 4, 0)
      } finally {
        closeSync(fd)
      }
      if ([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0))) found.push(path)
    }
  }
  return found
}

function checkSignature(path: string, entitlementsFile: string): void {
  const shown = run(["codesign", "-dv", "--entitlements", "-", "--xml", path], { capture: true })
  const granted = grantedEntitlements(shown.stdout)
  const expected = grantedEntitlements(readFileSync(entitlementsFile, "utf8"))
  if (granted.join() !== expected.join()) throw new Error(`${basename(path)} is signed with [${granted.join(", ")}], expected [${expected.join(", ")}]`)
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(shown.stderr)?.[1]?.split(",") ?? []
  if (!flags.includes("runtime")) throw new Error(`${basename(path)} is not signed with the hardened runtime`)
}

function notarize(path: string, credentials: readonly string[]): void {
  const answer = JSON.parse(run(["xcrun", "notarytool", "submit", path, ...credentials, "--wait", "--output-format", "json"], { capture: true }).stdout) as { id?: string; status?: string }
  if (answer.status !== "Accepted") throw new Error(`notarizing ${basename(path)} ended ${answer.status ?? "without a status"}; see xcrun notarytool log ${answer.id ?? "<id>"}`)
}

function createDmg(app: string, out: string, scratch: string): void {
  const stage = join(scratch, "dmg")
  mkdirSync(stage)
  run(["ditto", app, join(stage, basename(app))])
  symlinkSync("/Applications", join(stage, "Applications"))
  mkdirSync(dirname(out), { recursive: true })
  rmSync(out, { force: true })
  // hdiutil now and then fails with "Resource busy" on CI runners; a retry gets past it.
  for (let attempt = 1; ; attempt += 1) {
    try {
      run(["hdiutil", "create", "-volname", basename(app, ".app"), "-srcfolder", stage, "-ov", "-format", "UDZO", out])
      return
    } catch (error) {
      if (attempt === 3) throw error
      Bun.sleepSync(5_000)
    }
  }
}

function buildMac(root: string, argv: readonly string[]): void {
  if (process.platform !== "darwin") throw new Error("the mac command runs on macOS")
  const options = macOptions(argv, process.env, process.arch)
  const developerId = options.identity !== "-"
  const notary = developerId ? notaryCredentials(process.env) : undefined
  const updater = (process.env.RUNRAIL_UPDATER_PUBKEY?.trim() ?? "") === "" ? undefined : { pubkey: required("RUNRAIL_UPDATER_PUBKEY"), endpoint: required("RUNRAIL_UPDATE_URL") }
  if (updater !== undefined && !process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY is not set, and the update archive is signed with it")
  }
  const app = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as { productName: string; version: string; identifier: string }
  const bundle = join(root, "src-tauri", "target", ...(options.target === undefined ? [] : [options.target]), "release", "bundle")
  const appPath = join(bundle, "macos", `${app.productName}.app`)
  const entitlements = { appEntitlements: join(root, "src-tauri", "Entitlements.plist"), engineEntitlements: join(root, "src-tauri", "Engine.entitlements.plist") }
  const scratch = mkdtempSync(join(tmpdir(), "runrail-release-"))
  try {
    const overlay = join(scratch, "mac.conf.json")
    writeFileSync(overlay, JSON.stringify(macReleaseConfig(updater)))
    const target = options.target === undefined ? [] : ["--target", options.target]
    run(["bun", "run", "tauri", "build", "--bundles", "app", ...target, ...(updater === undefined ? [] : ["--features", "updater"]), "--config", overlay], { cwd: root, env: macBuildEnvironment(process.env) })
    const archive = join(bundle, "macos", `${app.productName}_${app.version}_${options.arch}.app.tar.gz`)
    rmSync(archive, { force: true })
    rmSync(`${archive}.sig`, { force: true })

    const main = join(appPath, "Contents", "MacOS", run(["plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")], { capture: true }).stdout.trim())
    const unexpected = machOFiles(appPath).filter((path) => path !== main && path !== macEngine(appPath))
    if (unexpected.length > 0) throw new Error(`the signing plan does not cover ${unexpected.join(", ")}`)
    for (const command of macSignCommands({ app: appPath, identity: options.identity, identifier: app.identifier, ...entitlements })) run(command)
    run(["codesign", "--verify", "--strict", "--deep", "--verbose=2", appPath])
    checkSignature(macEngine(appPath), entitlements.engineEntitlements)
    checkSignature(main, entitlements.appEntitlements)
    if (options.arch === (process.arch === "arm64" ? "aarch64" : "x64")) run([macEngine(appPath), "--version"], { capture: true })

    if (notary !== undefined) {
      const zip = join(scratch, `${app.productName}.zip`)
      run(["ditto", "-c", "-k", "--keepParent", appPath, zip])
      notarize(zip, notary)
      run(["xcrun", "stapler", "staple", appPath])
      run(["spctl", "--assess", "--type", "execute", "--verbose=2", appPath])
    }

    const dmg = join(bundle, "dmg", `${app.productName}_${app.version}_${options.arch}.dmg`)
    createDmg(appPath, dmg, scratch)
    if (notary !== undefined) {
      run(["codesign", "--force", "--timestamp", "--sign", options.identity, dmg])
      notarize(dmg, notary)
      run(["xcrun", "stapler", "staple", dmg])
      run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg])
    }

    const built = [appPath, dmg]
    if (updater !== undefined) {
      // COPYFILE_DISABLE keeps macOS tar from adding ._ files, which would break the sealed signature.
      run(["tar", "-czf", archive, "-C", dirname(appPath), basename(appPath)], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
      run(["bun", "run", "tauri", "signer", "sign", "--app-version", app.version, archive], { cwd: root })
      if (!existsSync(`${archive}.sig`)) throw new Error(`tauri signer did not write ${archive}.sig`)
      built.push(archive, `${archive}.sig`)
    }
    console.log(`signed ${developerId ? "with a Developer ID, notarized" : "ad hoc, not notarized"}${updater === undefined ? ", no updater" : ""}:\n  ${built.join("\n  ")}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const command = process.argv[2]
  try {
    if (command === "config") writeConfig(root)
    else if (command === "mac") buildMac(root, process.argv.slice(3))
    else if (command === "manifest") writeManifest(root)
    else if (command === "feed") writeFeed(process.argv.slice(3))
    else throw new Error("usage: bun scripts/release.ts config|mac|manifest|feed")
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
