/**
 * The engine as debug builds run it: the Runrail checkout's current source, with this repository's
 * Claude Agent SDK registered first, as the release sidecar does (scripts/sidecar.ts). Without it
 * the source engine cannot import the SDK, an optional peer it does not install, and Claude Code
 * threads would run in print mode in `tauri dev` only.
 *
 * Only Runrail's package entry points are used (`runrail` and `runrail/cli`), never its internals.
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const runrail = resolve(process.env.RUNRAIL_DIR ?? join(import.meta.dir, "..", "..", "runrail"))
const manifest = JSON.parse(readFileSync(join(runrail, "package.json"), "utf8")) as { readonly exports?: Readonly<Record<string, unknown>> }
const entryPoint = (name: string): string => {
  const target = manifest.exports?.[name]
  if (typeof target !== "string") throw new Error(`${runrail} has no "${name}" package entry; update the Runrail checkout`)
  return join(runrail, target)
}
const library = (await import(entryPoint("."))) as { readonly registerClaudeAgentSdk: (module: unknown) => void }
const cli = (await import(entryPoint("./cli"))) as { readonly runCliMain: () => Promise<void> }
library.registerClaudeAgentSdk(sdk)
await cli.runCliMain()
