/**
 * Builds the engine sidecar from a Runrail checkout. The Claude Agent SDK is not bundled: its
 * licence reserves all rights, so the sidecar fetches the version pinned here from npm the first
 * time the engine needs it (sidecar/agentSdk.ts), into the folder the host names in
 * RUNRAIL_AGENT_SDK_DIR.
 *
 *   bun scripts/sidecar.ts                                builds for this machine from ../runrail
 *   bun scripts/sidecar.ts --target x86_64-apple-darwin   builds for another target (any key of BUN_TARGETS)
 *   RUNRAIL_DIR=/path/to/runrail bun scripts/sidecar.ts
 *
 * Only Runrail's package entry points are used (`runrail` and `runrail/cli`), never its internals.
 * The SDK's per-platform Claude Code binary is not bundled: the engine runs the user's own `claude`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { agentSdkPin } from "../sidecar/agentSdk"

// x86_64 Linux takes Bun's baseline build, which runs on CPUs without AVX2.
const BUN_TARGETS: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64-baseline",
  "x86_64-pc-windows-msvc": "bun-windows-x64-baseline",
}
const HOST_TRIPLES: Readonly<Record<string, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
}

const root = resolve(import.meta.dir, "..")
const runrail = resolve(process.env.RUNRAIL_DIR ?? join(root, "..", "runrail"))
const flag = process.argv.indexOf("--target")
const triple = flag === -1 ? HOST_TRIPLES[`${process.platform}-${process.arch}`] : process.argv[flag + 1]
const bunTarget = triple === undefined ? undefined : BUN_TARGETS[triple]
if (triple === undefined || bunTarget === undefined) throw new Error(`no sidecar target for ${triple ?? `${process.platform}-${process.arch}`}; use ${Object.keys(BUN_TARGETS).join(" or ")}`)

const manifest: unknown = JSON.parse(readFileSync(join(runrail, "package.json"), "utf8"))
const entryPoint = (name: string): string => {
  const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {}
  const target = exports[name]
  if (typeof target !== "string") throw new Error(`${runrail} has no "${name}" package entry; update the Runrail checkout`)
  return join(runrail, target)
}
if (!isRecord(manifest) || manifest.name !== "runrail") throw new Error(`${runrail} is not a Runrail checkout; set RUNRAIL_DIR`)
const library = entryPoint(".")
const cli = entryPoint("./cli")
const pin = agentSdkPin(readFileSync(join(root, "bun.lock"), "utf8"))

// The entry sits under node_modules so git ignores it.
const work = join(root, "node_modules", ".cache", "runrail-sidecar")
mkdirSync(work, { recursive: true })
const entry = join(work, "entry.ts")
writeFileSync(
  entry,
  [
    `import { registerClaudeAgentSdkLoader } from ${JSON.stringify(library)}`,
    `import { runCliMain } from ${JSON.stringify(cli)}`,
    `import { agentSdkLoader } from ${JSON.stringify(join(root, "sidecar", "agentSdk.ts"))}`,
    "const directory = process.env.RUNRAIL_AGENT_SDK_DIR",
    `if (directory !== undefined && directory.length > 0) registerClaudeAgentSdkLoader(agentSdkLoader(${JSON.stringify(pin)}, directory))`,
    "await runCliMain()",
    "",
  ].join("\n"),
)

// Tauri looks for the sidecar under its target triple, with Windows' extension.
const outfile = join(root, "src-tauri", "binaries", `runrail-${triple}${triple.includes("windows") ? ".exe" : ""}`)
const build = Bun.spawn([process.execPath, "build", entry, "--compile", `--target=${bunTarget}`, "--outfile", outfile], { cwd: root, stdout: "inherit", stderr: "inherit" })
const status = await build.exited
if (status !== 0) process.exit(status)
console.log(`sidecar built from ${runrail}: ${outfile} (fetches @anthropic-ai/claude-agent-sdk@${pin.version} on first use)`)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
