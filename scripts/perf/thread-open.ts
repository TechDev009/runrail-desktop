/**
 * How long a thread takes to open, engine side. The engine is started the way the
 * host starts it for a thread (`launch_command` in src-tauri/src/engine.rs, through
 * scripts/dev-engine.ts as debug builds do), then sent the control requests `startEngine` makes, in
 * order, against a seeded transcript. With `RUNRAIL_TIMINGS=1` the engine reports its own startup
 * phases on stderr, and they are listed too. Last, a system engine reads each thread's transcript
 * with `conversation.peek`, as the app does before a thread's own engine is ready.
 *
 *   bun run scripts/perf/thread-open.ts [--runs 3] [--items 2048] [--backends native,claude-code,codex]
 *
 * Everything lives in a temporary folder with the file credential store. No turn runs: opening a
 * coding-tool thread starts no vendor process, and each run lists the engine's child processes to
 * show it.
 */

import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { createInterface } from "node:readline"

const desktop = resolve(import.meta.dir, "..", "..")
const runrail = resolve(process.env.RUNRAIL_DIR ?? join(desktop, "..", "runrail"))

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const runs = Number(option("runs", "3"))
const wantedItems = Number(option("items", "2048"))
const backends = option("backends", "native,claude-code,codex").split(",")

interface Rpc {
  readonly url: string
  readonly token: string
}

async function call(engine: Rpc, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`${engine.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${engine.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
  const body = (await response.json()) as { ok?: boolean; result?: unknown; error?: { code?: string } }
  if (body.ok !== true) throw new Error(`${method}: ${body.error?.code ?? String(response.status)}`)
  return body.result
}

/**
 * One real turn's records, written by the engine's own loop with a scripted model: a question, a
 * file read, a markdown answer with a code block, and the check after it.
 */
async function recordOneTurn(root: string): Promise<{ readonly records: readonly Record<string, unknown>[]; readonly itemsPerTurn: number }> {
  const manifest = JSON.parse(await readFile(join(runrail, "package.json"), "utf8")) as { readonly exports: Readonly<Record<string, string>> }
  const library = (await import(join(runrail, manifest.exports["."] ?? "src/index.ts"))) as {
    readonly FileTranscriptStore: new (options: { readonly root: string }) => unknown
    readonly startRunrailControlRpcServer: (options: Record<string, unknown>) => Promise<{ readonly handle: { readonly url: string; readonly token: string; readonly stop: () => Promise<void> } }>
  }
  const cwd = join(root, "seed")
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, "notes.md"), "A line of project notes that the turn reads back.\n".repeat(40))
  const verifier = join(root, "verifier")
  await writeFile(verifier, '#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ ok: true, diagnostics: [] }))\n', { mode: 0o755 })
  const answer = `Here is what the change does.\n\n${"- One point about the change, in a sentence of ordinary length.\n".repeat(6)}\n\`\`\`ts\n${"export function double(value: number): number {\n  return value * 2\n}\n".repeat(4)}\`\`\`\n\nThat is all.`
  const model = {
    complete: (request: { readonly messages: readonly { readonly role: string }[] }) =>
      request.messages.at(-1)?.role === "tool" ? { type: "text", text: answer } : { type: "tool", name: "read_file", input: { path: "notes.md" } },
  }
  const transcripts = join(root, "seed-transcript")
  const server = await library.startRunrailControlRpcServer({ cwd, backend: "native", sessionId: "seed", loadExtensions: false, model, verificationCommand: verifier, transcriptStore: new library.FileTranscriptStore({ root: transcripts }) })
  try {
    await call(server.handle, "turn.enqueue", { message: "What does the change in notes.md do?" })
    for (let tries = 0; ; tries++) {
      const state = (await call(server.handle, "session.snapshot")) as { readonly active?: boolean; readonly queued?: number }
      if (state.active !== true && (state.queued ?? 0) === 0) break
      if (tries > 500) throw new Error("the seed turn did not finish")
      await Bun.sleep(10)
    }
    const read = (await call(server.handle, "session.conversation.read", { source: "auto", maxItems: 2048 })) as { readonly items: readonly unknown[] }
    const lines = (await readFile(join(transcripts, "seed.jsonl"), "utf8")).trim().split("\n")
    return { records: lines.map((line) => JSON.parse(line) as Record<string, unknown>), itemsPerTurn: read.items.length }
  } finally {
    await server.handle.stop()
  }
}

/** The recorded turn repeated with fresh ids and sequence numbers, as one long thread. */
function longThread(sessionId: string, turn: readonly Record<string, unknown>[], turns: number): string {
  const events = turn.filter((record) => typeof (record.payload as { seq?: unknown }).seq === "number").length
  const firstEventSeq = Math.min(...turn.map((record) => (record.payload as { seq?: unknown }).seq).filter((seq): seq is number => typeof seq === "number"))
  const ids = new Set<string>()
  for (const record of turn) {
    const payload = record.payload as { turnId?: unknown; callId?: unknown }
    if (typeof payload.turnId === "string") ids.add(payload.turnId)
    if (typeof payload.callId === "string") ids.add(payload.callId)
  }
  const lines: string[] = []
  const start = Date.now() - turns * 60_000
  for (let index = 0; index < turns; index++) {
    let text = JSON.stringify(turn).replaceAll('"seed"', JSON.stringify(sessionId))
    for (const id of ids) text = text.replaceAll(id, randomUUID())
    const copy = JSON.parse(text) as Record<string, unknown>[]
    copy.forEach((record, offset) => {
      const seq = index * turn.length + offset
      const payload = record.payload as { seq?: unknown; at?: unknown }
      const at = start + index * 60_000 + offset * 100
      if (typeof payload.seq === "number") payload.seq = index * events + (payload.seq - firstEventSeq)
      if (typeof payload.at === "number") payload.at = at
      lines.push(JSON.stringify({ ...record, sessionId, seq, id: `${sessionId}:${String(seq)}`, at }))
    })
  }
  return `${lines.join("\n")}\n`
}

interface Run {
  readonly backend: string
  readonly run: number
  readonly steps: Readonly<Record<string, number>>
  readonly engine: Readonly<Record<string, number>>
  readonly items: number
  readonly children: readonly string[]
}

interface Started {
  readonly rpc: Rpc
  readonly pid: number | undefined
  /** The engine's own startup phases, from `RUNRAIL_TIMINGS=1`. */
  readonly phases: Readonly<Record<string, number>>
  readonly stop: () => Promise<void>
}

/** An engine started as the host starts one, ready once it wrote its `control.ready` line. */
async function startEngine(label: string, args: readonly string[]): Promise<Started> {
  const phases: Record<string, number> = {}
  const child = spawn(process.execPath, ["run", join(desktop, "scripts", "dev-engine.ts"), "control", ...args], { cwd: runrail, env: { ...process.env, RUNRAIL_TIMINGS: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  createInterface({ input: child.stderr }).on("line", (line) => {
    const timing = /^\[runrail-timing\] (\S+) ([\d.]+)ms$/.exec(line)
    if (timing !== null) phases[timing[1] as string] = Number(timing[2])
  })
  const stop = async (): Promise<void> => {
    child.stdin.end()
    await new Promise((done) => {
      if (child.exitCode !== null) done(undefined)
      else child.once("exit", done)
    })
  }
  try {
    const rpc = await new Promise<Rpc>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${label}: no control.ready within 90 s`)), 90_000)
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line) as { type?: string; url?: string; token?: string }
          if (message.type === "control.ready" && message.url !== undefined && message.token !== undefined) {
            clearTimeout(timer)
            done({ url: message.url, token: message.token })
          }
        } catch {
          // Not the handshake.
        }
      })
      child.once("exit", (code) => fail(new Error(`${label}: engine exited with ${String(code)} before control.ready`)))
    })
    return { rpc, pid: child.pid, phases, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

const shared = (root: string): string[] => ["--accounts-dir", join(root, "accounts"), "--credential-vault", "file", "--port", "0", "--json", "--exit-on-stdin-close"]

async function openOnce(root: string, backend: string, threadId: string, run: number): Promise<Run> {
  const threadDir = join(root, "threads", threadId)
  const config = join(threadDir, "config.json")
  await writeFile(config, JSON.stringify({ version: 1, mode: "ask", effort: "medium", permissions: { default: "ask", rules: [] } }, null, 2))
  const steps: Record<string, number> = {}
  let last = performance.now()
  const mark = (name: string): void => {
    const now = performance.now()
    steps[name] = Math.round((now - last) * 10) / 10
    last = now
  }
  const engine = await startEngine(backend, [
    "--backend", backend, "--cwd", join(root, "workspace"), "--session-dir", threadDir, "--session-id", threadId, "--config", config, ...shared(root),
    "--transcript-dir", join(threadDir, "transcript"), "--worktree-root", join(root, "worktrees"), "--terminal",
  ])
  try {
    mark("launch")
    await call(engine.rpc, "session.conversation.read", { source: "live", maxItems: 1 })
    mark("live")
    const history = (await call(engine.rpc, "session.conversation.read", { source: "auto", maxItems: 2048 })) as { readonly items: readonly unknown[] }
    await call(engine.rpc, "session.snapshot")
    mark("history")
    await call(engine.rpc, "live.frames", { afterLiveSeq: Number.MAX_SAFE_INTEGER, maxFrames: 1 })
    mark("frames")
    const listed = spawnSync("pgrep", ["-lP", String(engine.pid)], { encoding: "utf8" }).stdout.trim()
    const children = listed === "" ? [] : listed.split("\n").map((row) => basename(row.split(" ").slice(1).join(" ")))
    return { backend, run, steps, engine: engine.phases, items: history.items.length, children }
  } finally {
    await engine.stop()
  }
}

/** History first: the system engine, started as the host starts it, reads each thread's transcript. */
async function peekRuns(root: string, threadIds: readonly string[]): Promise<readonly { readonly threadId: string; readonly ms: readonly number[]; readonly items: number }[]> {
  const sessionDir = join(root, "system", "session")
  await mkdir(join(root, "system", "workspace"), { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  const config = join(sessionDir, "config.json")
  await writeFile(config, JSON.stringify({ version: 1, mode: "ask", effort: "medium", permissions: { default: "deny", rules: [] } }, null, 2))
  const system = await startEngine("system", ["--backend", "native", "--cwd", join(root, "system", "workspace"), "--session-dir", sessionDir, "--session-id", "system", "--config", config, ...shared(root), "--threads-dir", join(root, "threads")])
  try {
    const results = []
    for (const threadId of threadIds) {
      const ms: number[] = []
      let items = 0
      for (let run = 0; run < runs; run++) {
        const started = performance.now()
        const answer = (await call(system.rpc, "conversation.peek", { threadId, workspace: join(root, "workspace"), maxItems: 2048 })) as { readonly items: readonly unknown[] }
        ms.push(Math.round((performance.now() - started) * 10) / 10)
        items = answer.items.length
      }
      results.push({ threadId, ms, items })
    }
    return results
  } finally {
    await system.stop()
  }
}

const root = await mkdtemp(join(tmpdir(), "runrail-thread-open-"))
try {
  await mkdir(join(root, "workspace"), { recursive: true })
  await mkdir(join(root, "accounts"), { recursive: true })
  spawnSync("git", ["init", "-q", join(root, "workspace")])
  const seeded = await recordOneTurn(root)
  const turns = Math.ceil(wantedItems / Math.max(1, seeded.itemsPerTurn))
  const results: Run[] = []
  let transcriptBytes = 0
  for (const backend of backends) {
    const threadId = `perf-${backend}`
    const transcript = longThread(threadId, seeded.records, turns)
    transcriptBytes = Buffer.byteLength(transcript)
    await mkdir(join(root, "threads", threadId, "transcript"), { recursive: true })
    await writeFile(join(root, "threads", threadId, "transcript", `${threadId}.jsonl`), transcript)
    for (let run = 1; run <= runs; run++) results.push(await openOnce(root, backend, threadId, run))
  }
  const peeks = await peekRuns(root, backends.map((backend) => `perf-${backend}`))
  console.log(JSON.stringify({ itemsPerTurn: seeded.itemsPerTurn, turns, records: turns * seeded.records.length, transcriptBytes, results, peeks }, null, 2))
  for (const result of results) {
    const steps = Object.entries(result.steps).map(([step, ms]) => `${step} ${String(ms)}`).join(", ")
    const phases = Object.entries(result.engine).map(([phase, ms]) => `${phase} ${String(ms)}`).join(", ")
    console.error(`${result.backend} #${String(result.run)}: ${String(result.items)} items | ${steps} | engine: ${phases} | children: ${result.children.join(" ") || "none"}`)
  }
  for (const peek of peeks) console.error(`peek ${peek.threadId}: ${String(peek.items)} items | ${peek.ms.map(String).join(", ")} ms`)
} finally {
  await rm(root, { recursive: true, force: true })
}
