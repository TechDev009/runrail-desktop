import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * The Claude Agent SDK, downloaded from npm when the person allows it instead of shipped inside
 * the app: its licence reserves all rights, so each person gets it from npm under Anthropic's own
 * terms. The version and its SHA-512 are pinned when the sidecar is built (scripts/sidecar.ts),
 * and a download that does not match them is refused before it is unpacked. The download is kept
 * beside its files, and every load checks it against the pin and the files against it, so files
 * changed on disk after the download are never loaded.
 */

export interface AgentSdkPin {
  readonly version: string
  /** npm's integrity string, `sha512-<base64>`, as bun.lock records it. */
  readonly integrity: string
}

export interface TarFile {
  readonly path: string
  readonly data: Uint8Array
}

type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>

const REGISTRY = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-"
const MAX_TARBALL_BYTES = 32 * 1024 * 1024
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000
/** Where the verified download is kept in the SDK's folder. */
const KEPT_DOWNLOAD = ".runrail-download.tgz"

/** The SDK version a bun.lock pins, with npm's integrity for it. */
export function agentSdkPin(lock: string): AgentSdkPin {
  const match = /"@anthropic-ai\/claude-agent-sdk": \["@anthropic-ai\/claude-agent-sdk@([^"]+)",.*"(sha512-[A-Za-z0-9+/]+=*)"\]/.exec(lock)
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("bun.lock has no pinned @anthropic-ai/claude-agent-sdk; run bun install")
  return { version: match[1], integrity: match[2] }
}

/** Loads the pinned SDK from `directory` once it is downloaded there; it never downloads. */
export function agentSdkLoader(pin: AgentSdkPin, directory: string): () => Promise<unknown> {
  return async () => {
    const home = join(directory, pin.version)
    const manifest = join(home, "package.json")
    if (!existsSync(manifest)) return undefined
    verifyAgentSdk(pin, home)
    const entry = resolve(home, entryOf(JSON.parse(await readFile(manifest, "utf8")) as unknown))
    if (relative(home, entry).startsWith("..")) throw new Error("agent SDK entry is outside its folder")
    return import(pathToFileURL(entry).href)
  }
}

/** Downloads the pinned SDK into `directory`, run by the engine's `claude.sdk.install` after a yes. */
export function agentSdkInstaller(pin: AgentSdkPin, directory: string, fetchImpl: Fetch = (url, init) => fetch(url, init)): { readonly version: string; readonly installed: () => boolean; readonly install: () => Promise<void> } {
  const home = join(directory, pin.version)
  return {
    version: pin.version,
    // A copy whose files changed counts as not installed, so the person is offered the download again.
    installed: () => existsSync(join(home, "package.json")) && intact(pin, home),
    install: () => installAgentSdk(pin, home, fetchImpl),
  }
}

export async function installAgentSdk(pin: AgentSdkPin, home: string, fetchImpl: Fetch): Promise<void> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(pin.version)) throw new Error("agent SDK version is invalid")
  pinnedSha512(pin)
  const response = await fetchImpl(`${REGISTRY}${pin.version}.tgz`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`agent SDK download failed: HTTP ${String(response.status)}`)
  if (Number(response.headers.get("content-length") ?? 0) > MAX_TARBALL_BYTES) throw new Error("agent SDK download is too large")
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_TARBALL_BYTES) throw new Error("agent SDK download is too large")
  const files = unpack(pin, bytes)
  if (files.some((file) => file.path === KEPT_DOWNLOAD)) throw new Error(`agent SDK has a file named ${KEPT_DOWNLOAD}, where Runrail keeps the download`)
  const staging = `${home}.${String(process.pid)}-${randomUUID()}.partial`
  try {
    for (const file of files) {
      const path = join(staging, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.data, { mode: 0o644 })
    }
    await writeFile(join(staging, KEPT_DOWNLOAD), bytes, { mode: 0o644 })
    await mkdir(dirname(home), { recursive: true })
    if (existsSync(home) && !intact(pin, home)) await setAside(pin, home)
    // Engines starting together may each download it; the first rename wins and the rest use it.
    await rename(staging, home).catch((error: unknown) => {
      if (!intact(pin, home)) throw error
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Throws unless `home` holds exactly what the pinned download unpacks to: the kept download still
 * matches the pin built into the sidecar, and every other file is one of its files, byte for byte,
 * with none missing and none added (an added folder of modules could be resolved by the SDK).
 */
export function verifyAgentSdk(pin: AgentSdkPin, home: string): void {
  const expected = new Map(unpack(pin, new Uint8Array(readFileSync(join(home, KEPT_DOWNLOAD)))).map((file) => [file.path, file.data]))
  let matched = 0
  for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue
    const path = relative(home, join(entry.parentPath, entry.name)).split(sep).join("/")
    if (path === KEPT_DOWNLOAD) continue
    const data = expected.get(path)
    if (!entry.isFile() || data === undefined || !readFileSync(join(home, path)).equals(data)) throw new Error(`agent SDK file ${path} changed after it was downloaded; install it again`)
    matched += 1
  }
  if (matched !== expected.size) throw new Error("agent SDK files went missing after it was downloaded; install it again")
}

function intact(pin: AgentSdkPin, home: string): boolean {
  try {
    verifyAgentSdk(pin, home)
    return true
  } catch {
    return false
  }
}

/** Moves a copy that no longer matches its download out of the way, then removes it. */
async function setAside(pin: AgentSdkPin, home: string): Promise<void> {
  const aside = `${home}.${String(process.pid)}-${randomUUID()}.replaced`
  // Another engine may have replaced it first; only a copy still damaged is an error.
  await rename(home, aside).catch((error: unknown) => {
    if (existsSync(home) && !intact(pin, home)) throw error
  })
  await rm(aside, { recursive: true, force: true })
}

function pinnedSha512(pin: AgentSdkPin): string {
  const expected = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(pin.integrity)?.[1]
  if (expected === undefined) throw new Error("agent SDK integrity is invalid")
  return expected
}

/** The download's files, once its SHA-512 matches the pin. */
function unpack(pin: AgentSdkPin, bytes: Uint8Array<ArrayBuffer>): readonly TarFile[] {
  if (new Bun.CryptoHasher("sha512").update(bytes).digest("base64") !== pinnedSha512(pin)) throw new Error("agent SDK download does not match its pinned SHA-512")
  return untar(Bun.gunzipSync(bytes))
}

/** The file the package's `.` export names, as `exports` or `main` gives it. */
function entryOf(manifest: unknown): string {
  const record = isRecord(manifest) ? manifest : {}
  const exported = isRecord(record.exports) ? record.exports["."] : undefined
  const target = typeof exported === "string" ? exported : isRecord(exported) && typeof exported.default === "string" ? exported.default : record.main
  if (typeof target !== "string" || target.length === 0) throw new Error("agent SDK has no entry")
  return target
}

/**
 * The regular files of an npm tarball, with its `package/` folder removed. Links, devices, and
 * paths that would leave the folder are refused rather than skipped.
 */
export function untar(archive: Uint8Array): readonly TarFile[] {
  const files: TarFile[] = []
  let unpacked = 0
  let longName: string | undefined
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = octal(header.subarray(124, 136))
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0)
    const body = archive.subarray(offset + 512, offset + 512 + size)
    if (body.length !== size) throw new Error("tarball is truncated")
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === "x") {
      longName = paxPath(body) ?? longName
      continue
    }
    if (type === "g") continue
    if (type === "L") {
      longName = cString(body)
      continue
    }
    const name = longName ?? ustarName(header)
    longName = undefined
    if (type === "5") continue
    if (type !== "0") throw new Error(`tarball entry ${name} is not a regular file`)
    unpacked += size
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error("tarball unpacks too large")
    files.push({ path: packagePath(name), data: body.slice() })
  }
  return files
}

function packagePath(name: string): string {
  if (!name.startsWith("package/")) throw new Error(`tarball entry ${name} is outside package/`)
  const parts = name.slice("package/".length).split("/")
  if (parts.length === 0 || parts.some((part) => part.length === 0 || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new Error(`tarball entry ${name} is not a plain relative path`)
  return parts.join("/")
}

function ustarName(header: Uint8Array): string {
  const name = cString(header.subarray(0, 100))
  const ustar = cString(header.subarray(257, 263)).startsWith("ustar")
  const prefix = ustar ? cString(header.subarray(345, 500)) : ""
  return prefix.length > 0 ? `${prefix}/${name}` : name
}

/** The `path` record of a pax header, which names the entry after it. */
function paxPath(body: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(body)
  for (const line of text.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

function octal(field: Uint8Array): number {
  const text = cString(field).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error("tarball size field is invalid")
  return text.length === 0 ? 0 : Number.parseInt(text, 8)
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
