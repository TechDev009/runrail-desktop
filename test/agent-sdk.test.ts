import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentSdkInstaller, agentSdkLoader, agentSdkPin, installAgentSdk, untar, type AgentSdkPin } from "../sidecar/agentSdk"

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "runrail-agent-sdk-"))
  folders.push(folder)
  return folder
}

function entry(name: string, data = "", type = "0"): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(data)
  const header = new Uint8Array(512)
  const put = (offset: number, text: string): void => header.set(new TextEncoder().encode(text), offset)
  put(0, name.slice(0, 100))
  put(100, "0000644\0")
  put(124, `${body.length.toString(8).padStart(11, "0")}\0`)
  put(156, type)
  put(257, "ustar\0")
  const block = new Uint8Array(512 + Math.ceil(body.length / 512) * 512)
  block.set(header)
  block.set(body, 512)
  return block
}

function tar(...entries: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(entries.reduce((sum, item) => sum + item.length, 0) + 1024)
  let offset = 0
  for (const item of entries) {
    out.set(item, offset)
    offset += item.length
  }
  return out
}

const PACKAGE = tar(
  entry("package/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", exports: { ".": { default: "./sdk.mjs" } } })),
  entry("package/sdk.mjs", 'export function query() { return "from npm" }\n'),
)

function served(archive: Uint8Array<ArrayBuffer>): { readonly pin: AgentSdkPin; readonly tgz: Uint8Array<ArrayBuffer> } {
  const tgz = Bun.gzipSync(archive)
  return { pin: { version: "0.3.288", integrity: `sha512-${new Bun.CryptoHasher("sha512").update(tgz).digest("base64")}` }, tgz }
}

function registry(tgz: Uint8Array<ArrayBuffer>, status = 200): { readonly fetch: (url: string) => Promise<Response>; readonly urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: async (url) => {
      urls.push(url)
      return new Response(status === 200 ? tgz : "not found", { status })
    },
  }
}

test("loading never downloads; the SDK comes from npm once, when the installer is run, and from disk after", async () => {
  const folder = await scratch()
  const { pin, tgz } = served(PACKAGE)
  const npm = registry(tgz)
  const load = agentSdkLoader(pin, folder)
  const installer = agentSdkInstaller(pin, folder, npm.fetch)
  expect(await load()).toBeUndefined()
  expect([installer.version, installer.installed(), npm.urls]).toEqual(["0.3.288", false, []])
  await installer.install()
  expect(npm.urls).toEqual(["https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.288.tgz"])
  expect(installer.installed()).toBe(true)
  const sdk = (await load()) as { query: () => string }
  expect(sdk.query()).toBe("from npm")
  expect(npm.urls).toHaveLength(1)
  expect(await readdir(folder)).toEqual(["0.3.288"])
})

test("a download that does not match the pinned SHA-512 is refused before anything is written", async () => {
  const folder = await scratch()
  const { pin } = served(PACKAGE)
  const tampered = served(tar(entry("package/package.json", "{}"), entry("package/sdk.mjs", "export const query = () => 'evil'"))).tgz
  await expect(agentSdkInstaller(pin, folder, registry(tampered).fetch).install()).rejects.toThrow("does not match its pinned SHA-512")
  await expect(agentSdkInstaller(pin, folder, registry(tampered, 404).fetch).install()).rejects.toThrow("HTTP 404")
  expect(await readdir(folder)).toEqual([])
  await expect(installAgentSdk({ ...pin, integrity: "sha1-abc" }, join(folder, "x"), registry(tampered).fetch)).rejects.toThrow("integrity is invalid")
  await expect(installAgentSdk({ ...pin, version: "../../evil" }, join(folder, "x"), registry(tampered).fetch)).rejects.toThrow("version is invalid")
})

test("engines that install at once end with one copy", async () => {
  const folder = await scratch()
  const { pin, tgz } = served(PACKAGE)
  await Promise.all([1, 2, 3].map(() => installAgentSdk(pin, join(folder, pin.version), registry(tgz).fetch)))
  expect(await readdir(folder)).toEqual(["0.3.288"])
  expect(existsSync(join(folder, "0.3.288", "sdk.mjs"))).toBe(true)
})

test("the tarball reader takes plain files under package/ and refuses links and escapes", () => {
  const long = `package/${"deep/".repeat(30)}file.js`
  const pax = new TextEncoder().encode(`${String(long.length + 9)} path=${long}\n`)
  const paxEntry = entry("PaxHeader", new TextDecoder().decode(pax), "x")
  const files = untar(tar(entry("package/", "", "5"), entry("package/a/b.js", "b"), paxEntry, entry("package/ignored-name", "long")))
  expect(files.map((file) => [file.path, new TextDecoder().decode(file.data)])).toEqual([["a/b.js", "b"], [long.slice("package/".length), "long"]])
  expect(() => untar(tar(entry("package/link", "", "2")))).toThrow("not a regular file")
  expect(() => untar(tar(entry("package/../../etc/x", "x")))).toThrow("not a plain relative path")
  expect(() => untar(tar(entry("other/x.js", "x")))).toThrow("outside package/")
  expect(() => untar(entry("package/cut.js", "x".repeat(600)).subarray(0, 700))).toThrow("truncated")
})

test("the pin is the SDK version bun.lock locks, with its npm integrity", () => {
  const pin = agentSdkPin(readFileSync(join(import.meta.dir, "..", "bun.lock"), "utf8"))
  const installed = JSON.parse(readFileSync(join(import.meta.dir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { version: string }
  expect(pin.version).toBe(installed.version)
  expect(pin.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
  expect(() => agentSdkPin("{}")).toThrow("no pinned")
})
