/**
 * Drives the real desktop app end to end: a debug build started with RUNRAIL_AUTOMATION=1 under
 * an identifier of its own, checked through the automation socket (scripts/automation.ts), then
 * stopped. Exits 1 when a check fails, keeping its temp folder and the app's log.
 *
 *   bun scripts/e2e-native.ts                 no model, and none of your accounts
 *   bun scripts/e2e-native.ts --model-runs    also a Best of 2 on Claude Code's Haiku: uses your
 *                                             Claude Code login and spends two small turns
 *   bun scripts/e2e-native.ts --setup-run     also a plan, execute, review setup run on Haiku in a
 *                                             scratch repo, with its plan approved here: uses your
 *                                             Claude Code login and up to 12 turns
 *
 * Without a model flag the app runs with a home folder of its own, whose login shell finds bun
 * and git but no coding tool, and with no keys in its environment: it reads no plan usage and
 * fetches no Agent SDK. With one, the app needs your Claude Code, so it keeps your home folder and
 * starts from an empty com.runrail.desktop.e2e data folder; the engine's own files in ~/.runrail
 * are then yours (the setup run uses the scratch repo's own setup, so your setups.json is only
 * read). Your com.runrail.desktop is never used.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { automation, type Automation, type AutomationAnswer } from "./automation"
import { linuxChecks, prepareLinux } from "./e2e-linux"

const IDENTIFIER = "com.runrail.desktop.e2e"
const FILES = 300
const START_TIMEOUT_MS = 15 * 60_000
const MODEL_RUN_TIMEOUT_MS = 8 * 60_000
const SETUP_RUN_TIMEOUT_MS = 25 * 60_000
const SETUP_NAME = "E2E plan, execute, review"

const modelRuns = process.argv.includes("--model-runs")
const setupRun = process.argv.includes("--setup-run")
const ownAccounts = modelRuns || setupRun
const root = join(import.meta.dir, "..")
const realHome = homedir()
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "runrail-e2e-")))
const home = ownAccounts ? realHome : join(tmp, "home")
// Where Tauri keeps an identifier's data: ~/Library/Application Support on macOS, the XDG data folder on Linux.
const dataRoot = (base: string): string => (process.platform === "darwin" ? join(base, "Library", "Application Support") : join(base, ".local", "share"))
const appData = join(home === realHome && process.platform !== "darwin" && process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : dataRoot(home), IDENTIFIER)
const project = join(tmp, "e2e-project")
const sibling = join(tmp, "e2e-project-sibling")
const setupProject = join(tmp, "e2e-setup")
const appsParent = join(tmp, "apps")
const newApp = join(appsParent, "e2e-shop")
const log = join(tmp, "app.log")

interface Result {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}
const results: Result[] = []

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(name: string, run: () => Promise<string>): Promise<boolean> {
  process.stdout.write(`- ${name} ... `)
  try {
    const detail = await run()
    results.push({ name, ok: true, detail })
    console.log("ok")
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail })
    console.log(`FAILED: ${detail}`)
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The page browser previews load: one colour, a button, a field, a request, a console line, a click count in its title, and the keys it saw. */
const PREVIEW_PAGE = `<!doctype html><html><head><title>e2e page</title><style>html,body{margin:0;height:100%;background:rgb(200,30,30)}</style></head>
<body><button id="go" onclick="document.title='went'">Go</button> <input id="name" placeholder="Name">
<script>
let clicks = 0
addEventListener("mousedown", () => { document.title = "clicked " + String(++clicks) })
const keys = []
addEventListener("keydown", (event) => { keys.push((event.metaKey ? "mod+" : "") + event.key.toLowerCase()); document.documentElement.dataset.keys = keys.join(",") })
console.error("e2e console line")
fetch("/api/ping").then(() => fetch("/missing"))
</script></body></html>`

function servePreviewPage(): { readonly url: string; readonly stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/") return new Response(PREVIEW_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })
      if (path === "/api/ping") return Response.json({ pong: true })
      return new Response("missing", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${String(server.port)}/`, stop: () => void server.stop(true) }
}

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
interface PreviewFrame extends Box {
  /** Null where the platform does not say (macOS). */
  readonly visible: boolean | null
}

const near = (a: Box, b: Box): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1
const boxText = (box: Box): string => `${String(box.x)},${String(box.y)} ${String(box.width)}x${String(box.height)}`
/** X11 under Xvfb: input can be sent to the real window, so the click and key checks run. */
const x11Input = process.platform === "linux" && process.env.DISPLAY !== undefined && process.env.WAYLAND_DISPLAY === undefined && Bun.which("xdotool") !== null

function xdotool(...args: string[]): string {
  const run = spawnSync("xdotool", args, { encoding: "utf8" })
  if (run.status !== 0) throw new Error(`xdotool ${args.join(" ")} failed: ${run.stderr.trim()}`)
  return run.stdout
}

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`)
  return run.stdout
}

/** A repository with FILES committed files, every one of them changed and not yet staged. */
function makeProject(): void {
  mkdirSync(join(project, "src"), { recursive: true })
  mkdirSync(sibling)
  git(project, "init", "-q", "-b", "main")
  git(project, "config", "user.email", "e2e@example.invalid")
  git(project, "config", "user.name", "e2e")
  for (let index = 1; index <= FILES; index += 1) writeFileSync(join(project, "src", `file${String(index)}.ts`), `export const v${String(index)} = ${String(index)}\n`)
  writeFileSync(join(project, "README.md"), "# e2e\n")
  git(project, "add", "-A")
  git(project, "commit", "-qm", "init")
  for (let index = 1; index <= FILES; index += 1) writeFileSync(join(project, "src", `file${String(index)}.ts`), `export const v${String(index)} = ${String(index * 2)}\nexport const w${String(index)} = "changed"\n`)
}

/** A small bun project with one tested function, and a setup of its own for the run to use. */
function makeSetupProject(): void {
  mkdirSync(join(setupProject, "src"), { recursive: true })
  mkdirSync(join(setupProject, ".runrail"))
  git(setupProject, "init", "-q", "-b", "main")
  git(setupProject, "config", "user.email", "e2e@example.invalid")
  git(setupProject, "config", "user.name", "e2e")
  writeFileSync(join(setupProject, "package.json"), `${JSON.stringify({ name: "e2e-setup", private: true, scripts: { test: "bun test" } }, null, 2)}\n`)
  writeFileSync(join(setupProject, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b\n}\n")
  writeFileSync(join(setupProject, "src", "math.test.ts"), 'import { expect, test } from "bun:test"\nimport { add } from "./math"\n\ntest("add", () => {\n  expect(add(2, 3)).toBe(5)\n})\n')
  const haiku = { route: "claude-code", model: "haiku" }
  const setup = { id: "e2e-p4", name: SETUP_NAME, roles: { planner: haiku, executor: { ...haiku, access: "auto-edit" }, reviewer: haiku }, rules: { approvePlan: true, reviewRounds: 1, check: "bun test", budget: { maxTurns: 12, maxMinutes: 20 } } }
  writeFileSync(join(setupProject, ".runrail", "setups.json"), `${JSON.stringify({ version: 1, setups: [setup] }, null, 2)}\n`)
  git(setupProject, "add", "-A")
  git(setupProject, "commit", "-qm", "init")
}

/** The environment `tauri dev` and the app get: the variables a build needs, nothing that signs in. */
function appEnvironment(): Record<string, string> {
  const base: Record<string, string> = { RUNRAIL_AUTOMATION: "1" }
  if (ownAccounts) return { ...(process.env as Record<string, string>), ...base }
  // The display and session bus variables let the window open on Linux; the rest come from
  // scripts/linux.ts (WebKitGTK without its sandbox in Docker, the shared Cargo build cache).
  const keep = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GDK_BACKEND", "GTK_THEME", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "CARGO_TARGET_DIR", "RUSTFLAGS"]
  const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash"
  const env: Record<string, string> = { ...base, HOME: home, SHELL: shell, CARGO_HOME: process.env.CARGO_HOME ?? join(realHome, ".cargo") }
  if (process.env.RUSTUP_HOME !== undefined || existsSync(join(realHome, ".rustup"))) env.RUSTUP_HOME = process.env.RUSTUP_HOME ?? join(realHome, ".rustup")
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name]
  // Engines take the login shell's PATH: this home's shell finds bun and git, and no coding tool.
  // Set again in .zshrc and .bash_profile, after /etc/zprofile or /etc/profile has added the system's folders.
  const bin = join(tmp, "bin")
  mkdirSync(dataRoot(home), { recursive: true })
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, "bun"))
  const gitPath = Bun.which("git")
  if (gitPath !== null) symlinkSync(gitPath, join(bin, "git"))
  // A starter's first commit needs an author, as on any machine that commits; Nifra's own CLI, when
  // this machine has one, is what the engine finds for Nifra's tools and check.
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = e2e\n\temail = e2e@example.invalid\n[commit]\n\tgpgsign = false\n")
  const nifraPath = Bun.which("nifra")
  if (nifraPath !== null) symlinkSync(realpathSync(nifraPath), join(bin, "nifra"))
  const path = `export PATH="${bin}:/usr/bin:/bin:/usr/sbin:/sbin"\n`
  writeFileSync(join(home, ".zshenv"), path)
  writeFileSync(join(home, ".zshrc"), path)
  writeFileSync(join(home, ".bash_profile"), path)
  return env
}

function resetModelProfile(): void {
  const expected = join(process.platform === "darwin" ? dataRoot(realHome) : (process.env.XDG_DATA_HOME ?? dataRoot(realHome)), "com.runrail.desktop.e2e")
  expect(appData === expected, "refusing to reset anything but the e2e data folder")
  rmSync(appData, { recursive: true, force: true })
}

function startApp(): { readonly pid: number; readonly exited: () => boolean } {
  const out = openSync(log, "w")
  const child = spawn("bun", ["run", "tauri", "dev", "--config", JSON.stringify({ identifier: IDENTIFIER })], { cwd: root, env: appEnvironment(), detached: true, stdio: ["ignore", out, out] })
  let exited = false
  child.on("exit", () => {
    exited = true
  })
  expect(child.pid !== undefined, "tauri dev did not start")
  return { pid: child.pid, exited: () => exited }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopApp(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    return
  }
  for (let waited = 0; waited < 15_000 && groupAlive(pid); waited += 250) await sleep(250)
  if (groupAlive(pid)) process.kill(-pid, "SIGKILL")
}

/** Processes still naming this run's data or temp folder: engines the app should have stopped. */
function leftovers(): string[] {
  const listed = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).stdout
  return listed.split("\n").filter((line) => line.includes(appData) || line.includes(tmp))
}

async function waitForAutomation(app: { readonly exited: () => boolean }): Promise<Automation> {
  const info = join(appData, "automation.json")
  const deadline = Date.now() + START_TIMEOUT_MS
  while (!existsSync(info)) {
    expect(!app.exited(), `tauri dev exited before the app started; see ${log}`)
    expect(Date.now() < deadline, `the app did not open its automation socket in time; see ${log}`)
    await sleep(500)
  }
  await sleep(500)
  return automation(info)
}

type Page = <T>(source: string, timeoutMs?: number) => Promise<T>

/** Adds `folder` the way a person does: Add project, the folder dialog (answered by the socket), Create. */
async function addThroughDialog(page: Page, client: Automation, folder: string): Promise<readonly string[]> {
  expect((await client.pick(folder)).ok, "the pick was not queued")
  return page<readonly string[]>(`
    button("Add project").click()
    const dialog = await until(() => document.querySelector(".create-project"), 10000, "the create project dialog")
    button("Add", dialog).click()
    await until(() => dialog.innerText.includes(${JSON.stringify(basename(folder))}) && !button("Create project", dialog).disabled, 10000, "the picked folder")
    button("Create project", dialog).click()
    const { useApp } = await import("/src/app/store.ts")
    await until(() => useApp.getState().projects.some((item) => item.path === ${JSON.stringify(folder)}), 10000, "the new project")
    return useApp.getState().projects.map((item) => item.path)`)
}

interface SetupSnapshot {
  readonly state: string
  readonly turns: number
  readonly steps: readonly { readonly kind: string; readonly title: string; readonly status: string; readonly note?: string }[]
  readonly approvedPlan?: readonly string[]
  readonly toolAnswers: readonly string[]
  readonly worktree?: string
}

/**
 * A real setup run: the project's own setup started from the Agents view on a small task, its
 * plan approved on the approval card, then watched until it ends. A command the executor asks for
 * is allowed only when it is the tests. The socket answers within two minutes, so the run is
 * polled in short steps.
 */
async function runSetup(page: Page, client: Automation): Promise<string> {
  const projects = await addThroughDialog(page, client, setupProject)
  expect(projects.includes(setupProject), "the setup project was not added")
  const task = "Add a subtract(a, b) function to src/math.ts next to add, and a test for it in src/math.test.ts. Keep the change small. The setup runs the tests after each step, so do not run commands yourself."
  const runId = await page<string>(`
    const { useApp } = await import("/src/app/store.ts")
    const { useSetups } = await import("/src/app/setups.ts")
    const project = useApp.getState().projects.find((item) => item.path === ${JSON.stringify(setupProject)})
    ;[...document.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.innerText.trim()).startsWith("Agents")).click()
    const list = await until(() => document.querySelector("main.agents .agents-list"), 15000, "the Agents view")
    const select = list.querySelector(".agents-project-select")
    if (select) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, project.id)
      select.dispatchEvent(new Event("change", { bubbles: true }))
    }
    const item = await until(() => [...list.querySelectorAll(".agents-item")].find((node) => node.innerText.includes(${JSON.stringify(SETUP_NAME)})), 30000, "the project's setup")
    item.click()
    const launch = await until(() => document.querySelector(".agents-launch"), 10000, "the run launcher")
    const input = launch.querySelector("textarea")
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(task)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
    ;[...launch.querySelectorAll("button")].find((node) => node.innerText.includes("New worktree")).click()
    const start = await until(() => [...launch.querySelectorAll("button")].find((node) => node.innerText.trim().startsWith("Start in") && !node.disabled), 10000, "the start button")
    const before = new Set(Object.keys(useSetups.getState().runs))
    start.click()
    return await until(() => Object.keys(useSetups.getState().runs).find((id) => !before.has(id)), 30000, "the new run")`)
  const deadline = Date.now() + SETUP_RUN_TIMEOUT_MS
  let snapshot: SetupSnapshot | undefined
  for (;;) {
    snapshot = await page<SetupSnapshot>(`
      const { useApp, runtimeOf } = await import("/src/app/store.ts")
      const { useSetups } = await import("/src/app/setups.ts")
      const { resolveApproval } = await import("/src/app/engines.ts")
      window.__e2eSetup ??= { toolAnswers: [] }
      const memo = window.__e2eSetup
      const run = useSetups.getState().runs[${JSON.stringify(runId)}]?.run
      if (!run) throw new Error("the run is gone")
      const card = document.querySelector(".agents-approval")
      if (card && memo.approvedPlan === undefined) {
        memo.approvedPlan = [...card.querySelectorAll(".agents-approval-steps input")].map((node) => node.value)
        const approve = [...card.querySelectorAll("button")].find((node) => node.innerText.trim() === "Approve")
        await until(() => !approve.disabled, 10000, "the Approve button")
        approve.click()
      }
      const threads = useApp.getState().threads.filter((thread) => thread.projectId === useApp.getState().projects.find((item) => item.path === ${JSON.stringify(setupProject)})?.id)
      for (const thread of threads) {
        for (const item of runtimeOf(thread.id)?.timeline.items ?? []) {
          if (item.kind !== "approval" || item.status !== "pending" || memo[item.approvalId]) continue
          memo[item.approvalId] = true
          const what = JSON.stringify(item).slice(0, 400)
          const allowed = /bun test/.test(what)
          memo.toolAnswers.push((allowed ? "allowed: " : "denied: ") + (item.action || "").slice(0, 80))
          await resolveApproval(thread.id, item.approvalId, allowed, allowed ? undefined : "The setup runs the tests; do not run other commands.")
        }
      }
      const worktree = threads.find((thread) => thread.worktree)?.worktree?.path
      return { state: run.state, turns: run.turns, steps: run.steps.map((step) => ({ kind: step.kind, title: step.title, status: step.status, ...(step.note ? { note: step.note } : {}) })), approvedPlan: memo.approvedPlan, toolAnswers: memo.toolAnswers, worktree }`)
    if (["succeeded", "failed", "stopped"].includes(snapshot.state)) break
    expect(Date.now() < deadline, `the run did not end in time; it is ${snapshot.state} after ${String(snapshot.turns)} turns`)
    await sleep(3000)
  }
  const steps = snapshot.steps.map((step) => `${step.kind}:${step.status}`).join(", ")
  expect(snapshot.state === "succeeded", `the run ended ${snapshot.state} (${steps}; ${snapshot.steps.map((step) => step.note ?? "").filter(Boolean).join(" | ")})`)
  expect(snapshot.approvedPlan !== undefined && snapshot.approvedPlan.length > 0, "the plan never reached the approval card")
  for (const kind of ["plan", "approve", "step", "check", "review"]) expect(snapshot.steps.some((step) => step.kind === kind && step.status === "done"), `no ${kind} step finished (${steps})`)
  expect(snapshot.worktree !== undefined, "the run's worktree is unknown")
  const worktree = snapshot.worktree
  expect(/export function subtract/.test(readFileSync(join(worktree, "src", "math.ts"), "utf8")), "src/math.ts has no subtract")
  expect(/subtract/.test(readFileSync(join(worktree, "src", "math.test.ts"), "utf8")), "src/math.test.ts does not test subtract")
  const tests = spawnSync(process.execPath, ["test"], { cwd: worktree, encoding: "utf8" })
  expect(tests.status === 0, `bun test fails in the worktree: ${(tests.stderr || tests.stdout).slice(-300)}`)
  const checkout = readFileSync(join(setupProject, "src", "math.ts"), "utf8")
  expect(!checkout.includes("subtract"), "the run changed the project checkout instead of its worktree")
  return `plan (${snapshot.approvedPlan.join(" / ")}) approved; ${String(snapshot.turns)} turns; steps ${steps}; ${snapshot.toolAnswers.length === 0 ? "no command asked for" : snapshot.toolAnswers.join(" | ")}; bun test passes in the worktree; checkout untouched`
}

const HELPERS = `
window.__e2e ??= (() => {
  const errors = []
  const original = console.error
  console.error = (...args) => { errors.push(args.map(String).join(" ").slice(0, 300)); original(...args) }
  window.addEventListener("error", (event) => errors.push("error: " + String(event.message).slice(0, 300)))
  window.addEventListener("unhandledrejection", (event) => errors.push("rejection: " + String(event.reason && (event.reason.message || event.reason)).slice(0, 300)))
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  return {
    errors,
    wait,
    frame: (ms) => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, ms))),
    button: (label, scope = document) => [...scope.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.innerText.trim()) === label),
    until: async (test, ms = 15000, what = "condition") => {
      const end = Date.now() + ms
      for (;;) {
        const value = await test()
        if (value) return value
        if (Date.now() > end) throw new Error("timed out waiting for " + what)
        await wait(200)
      }
    },
    invoke: async (command, args) => { try { return { ok: await window.__TAURI_INTERNALS__.invoke(command, args) } } catch (error) { return { code: error && error.code, message: String((error && error.message) || error) } } },
  }
})()
const { errors, wait, frame, button, until, invoke } = window.__e2e
`

async function main(): Promise<number> {
  console.log(`Runrail native e2e (${ownAccounts ? "with model runs, your Claude Code login" : "no model, isolated home"})\n  temp: ${tmp}`)
  makeProject()
  if (setupRun) makeSetupProject()
  if (ownAccounts) resetModelProfile()
  // On Linux, the desktop around the app, in the isolated home only.
  const desktop = process.platform === "linux" && !ownAccounts ? prepareLinux(home) : undefined
  const app = startApp()
  let client: Automation | undefined
  try {
    client = await waitForAutomation(app)
    const automationClient = client
    const page: Page = async <T>(source: string, timeoutMs = 130_000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<AutomationAnswer>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: "no answer from the page" }), timeoutMs)
      })
      const answer = await Promise.race([automationClient.eval(HELPERS + source), late]).finally(() => clearTimeout(timer))
      if (!answer.ok) throw new Error(answer.error ?? "the page script failed")
      return answer.value as T
    }

    const loaded = async (): Promise<void> => {
      const deadline = Date.now() + 120_000
      let title = ""
      while (title !== "Runrail") {
        expect(Date.now() < deadline, "the page did not load")
        title = await page<string>(`await until(() => document.querySelector("button"), 30000, "the page"); return document.title`, 40_000).catch(() => "")
      }
    }

    await check("the app opens, and its socket takes only the exact token", async () => {
      await loaded()
      // WebKit keeps an identifier's storage in the real ~/Library/WebKit whatever HOME is, so an
      // earlier run's plan readings would come back; the run starts from none.
      await page(`localStorage.clear(); sessionStorage.clear(); setTimeout(() => location.reload(), 100); return true`)
      await sleep(1000)
      await loaded()
      for (const header of ["Bearer wrong", ""]) {
        const response = await fetch(`http://127.0.0.1:${String(automationClient.port)}/eval`, { method: "POST", headers: header === "" ? {} : { authorization: header }, body: "return 1" })
        expect(response.status === 401, `a request with ${header === "" ? "no token" : "a wrong token"} got ${String(response.status)}`)
      }
      return "page loaded; wrong and missing tokens get 401"
    })

    await check("first run walks onboarding, reads no plan without a yes, and ends in the app", async () => {
      const seen = await page<readonly string[]>(`
        await until(() => document.querySelector(".onboarding"), 15000, "onboarding")
        const titles = []
        for (let step = 0; step < 8 && document.querySelector(".onboarding"); step += 1) {
          const title = document.querySelector(".onboarding h1")?.textContent ?? ""
          titles.push(title)
          const foot = document.querySelector(".onboarding-foot")
          // Plan limits are declined and nothing found in other tools is brought over.
          const target = title.startsWith("Show your plan limits") ? button("Not now", foot) : title === "Bring your setup" ? button("Skip", foot) : [...foot.querySelectorAll("button")].at(-1)
          await until(() => target && !target.disabled, 30000, "the button on " + title)
          target.click()
          await until(() => !document.querySelector(".onboarding") || document.querySelector(".onboarding h1")?.textContent !== title, 15000, "the step after " + title)
        }
        await until(() => !document.querySelector(".onboarding") && document.querySelector(".sidebar"), 15000, "the app after onboarding")
        const { useApp } = await import("/src/app/store.ts")
        const prefs = useApp.getState().prefs
        return [...titles, "onboarded " + String(prefs.onboarded), "plan limits " + prefs.planLimits]
      `, 120_000)
      expect(seen[0] === "Welcome to Runrail" && seen.includes("Your coding tools"), `the steps were ${seen.join(", ")}`)
      expect(seen.includes("onboarded true") && !seen.includes("plan limits on"), `onboarding ended with ${seen.slice(-2).join(", ")}`)
      return seen.join(" > ")
    })

    await check("folders nobody picked are refused", async () => {
      const refused = await page<Record<string, string>>(`
        const codes = {}
        for (const [name, path] of Object.entries(${JSON.stringify({ project, sibling, etc: "/etc", home: realHome })})) codes[name] = (await invoke("workspace_inspect", { path })).code
        codes.engine = (await invoke("engine_start", { input: { engineId: "e2e-probe", sessionId: "e2e-probe", workspace: ${JSON.stringify(sibling)}, backend: "native" } })).code
        codes.system = (await invoke("workspace_inspect", { path: ${JSON.stringify(join(appData, "system", "workspace"))} })).ok?.path ? "allowed" : "refused"
        return codes`)
      const { system, ...rest } = refused
      for (const [name, code] of Object.entries(rest)) expect(code === "WORKSPACE_NOT_APPROVED", `${name} gave ${String(code)}`)
      expect(system === "allowed", "the host's own system folder was refused")
      return "project, sibling, /etc, home and an engine start refused; the system folder allowed"
    })

    const created = await check("a folder picked in the dialog becomes a project", async () => {
      const projects = await addThroughDialog(page, automationClient, project)
      expect(projects.includes(project), `the project list is ${JSON.stringify(projects)}`)
      const approved = JSON.parse(readFileSync(join(appData, "approved-folders.json"), "utf8")) as { readonly folders: readonly string[] }
      expect(approved.folders.includes(project), "the picked folder is not in approved-folders.json")
      return "created through the real dialog flow; recorded in approved-folders.json"
    })

    if (created) {
      await check("folders inside a project are allowed, look-alikes are not", async () => {
        const codes = await page<Record<string, string>>(`
          const inside = await invoke("workspace_inspect", { path: ${JSON.stringify(join(project, "src"))} })
          const sibling = await invoke("workspace_inspect", { path: ${JSON.stringify(sibling)} })
          return { inside: inside.ok ? "allowed" : inside.code, sibling: sibling.ok ? "allowed" : sibling.code }`)
        expect(codes.inside === "allowed", `src gave ${String(codes.inside)}`)
        expect(codes.sibling === "WORKSPACE_NOT_APPROVED", `the sibling gave ${String(codes.sibling)}`)
        return "src allowed; project-sibling refused"
      })

      await check(`the review list mounts only what is in view of ${String(FILES)} files`, async () => {
        const list = await page<{ readonly summary: string; readonly mounted: number; readonly middle: readonly number[]; readonly end: readonly number[]; readonly headOffset: number; readonly fileOffset: number }>(`
          const { useApp, createThread } = await import("/src/app/store.ts")
          const { openPanel } = await import("/src/app/panels.ts")
          const thread = createThread({ projectId: useApp.getState().projects[0].id, backend: "native", title: "e2e review" })
          await wait(1000)
          openPanel(thread.id, "review")
          const scroller = await until(() => document.querySelector(".review-files"), 30000, "the review pane")
          await until(() => document.querySelector(".review-summary")?.innerText.includes("${String(FILES)} files"), 60000, "the change summary")
          const summary = document.querySelector(".review-summary").innerText.replace(/\\s+/g, " ")
          const rows = () => [...scroller.querySelectorAll(".virtual-row")].map((row) => Number(row.dataset.index))
          const mounted = rows().length
          scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2
          await frame(300)
          const middle = rows()
          scroller.scrollTop = scroller.scrollHeight
          await frame(300)
          const end = rows()
          scroller.scrollTop = 0
          await frame(300)
          const head = scroller.querySelector(".review-file-head")
          const toggle = head.querySelector(".review-file-toggle")
          if (toggle.getAttribute("aria-expanded") !== "true") toggle.click()
          const file = head.closest(".review-file")
          await until(() => file.querySelector(".review-file-body"), 15000, "the first file's diff")
          await frame(300)
          scroller.scrollTop += 20
          await frame(300)
          const top = scroller.getBoundingClientRect().top
          return { summary, mounted, middle, end, headOffset: Math.round(head.getBoundingClientRect().top - top), fileOffset: Math.round(file.getBoundingClientRect().top - top) }`)
        expect(list.mounted > 0 && list.mounted < 60, `${String(list.mounted)} rows mounted at the top`)
        expect(list.middle.length > 0 && list.middle.every((index) => index > 60 && index < FILES - 60), `mid-list rows were ${JSON.stringify(list.middle)}`)
        expect(list.end.includes(FILES - 1), `the last row was not mounted at the end: ${JSON.stringify(list.end)}`)
        expect(Math.abs(list.headOffset) <= 8 && list.fileOffset < list.headOffset, `the file header did not stick (header ${String(list.headOffset)}, file ${String(list.fileOffset)})`)
        return `${list.summary.trim()}; ${String(list.mounted)} rows mounted; middle ${String(list.middle[0])}-${String(list.middle.at(-1))}; end ${String(list.end[0])}-${String(list.end.at(-1))}; header pinned while its file scrolls`
      })

      await check("GitHub writes wait for the native confirmation", async () => {
        for (const answer of ["decline", "accept", "decline", "accept"] as const) expect((await automationClient.dialog(answer)).ok, "an answer was not queued")
        const codes = await page<Record<string, string | undefined>>(`
          const engineId = (await invoke("engine_list")).ok.find((engine) => engine.engineId.startsWith("e-th-")).engineId
          const target = { host: "github.invalid", owner: "runrail-e2e", repo: "nothing", number: 7 }
          const merge = { ...target, method: "squash", headCommit: "0123456789abcdef0123456789abcdef01234567", subject: "Ship it", deleteBranch: true }
          const call = async (method, params) => (await invoke("control_rpc", { engineId, method, params })).code
          return {
            invalid: await call("git.pr.merge", { ...target, method: "fast-forward", headCommit: "0123456" }),
            declined: await call("git.pr.merge", merge),
            unconfirmed: await call("git.pr.merge", merge),
            review: await call("git.pr.review.post", { ...target, event: "COMMENT", body: "Looks good\\u202e hidden", comments: [{ path: "a.ts", line: 1, body: "x" }, { path: "b.ts", line: 2, body: "y" }] }),
            confirmed: await call("git.pr.merge", { ...merge, confirm: true }),
          }`)
        expect(codes.invalid === "CONTROL_INVALID_INPUT", `an invalid merge gave ${String(codes.invalid)}`)
        expect(codes.declined === "PR_WRITE_DECLINED", `a declined merge gave ${String(codes.declined)}`)
        expect(codes.unconfirmed === "CONTROL_CONFIRMATION_REQUIRED", `an accepted merge without the page's confirm gave ${String(codes.unconfirmed)}`)
        expect(codes.review === "PR_WRITE_DECLINED", `a declined review gave ${String(codes.review)}`)
        expect(codes.confirmed === "CONTROL_PR_NOT_CONNECTED", `a confirmed merge gave ${String(codes.confirmed)}`)
        const answered = (await automationClient.dialogs()).value as readonly { readonly title: string; readonly message: string; readonly accepted: boolean }[]
        expect(answered.length === 4, `${String(answered.length)} confirmations were shown, not 4: the invalid write must not ask`)
        expect(answered[0]?.message.includes("Merge pull request runrail-e2e/nothing #7 on github.invalid?") === true && answered[0].message.includes("The branch is deleted after merging."), "the merge confirmation text is wrong")
        expect(answered[2]?.message.includes("2 comments on lines.") === true && answered[2].message.includes("\\u{202E}"), "the review confirmation does not show its hidden character")
        return "declined writes stop in the host; accepted ones still need the page's confirm and end at 'not connected'; text names target, method and hidden characters"
      })

      await check("file links in an answer open in the Files pane at their line, and their menu lists this Mac's editors", async () => {
        const seen = await page<{ readonly name: string; readonly line: string; readonly marked: number; readonly second: string; readonly external: number; readonly menu: readonly string[]; readonly editors: readonly string[] }>(`
          const { useApp, createThread, runtimeOf, patchRuntime, set } = await import("/src/app/store.ts")
          const { applyFrames } = await import("/src/thread/reducer.ts")
          const { getHost } = await import("/src/host/index.ts")
          const { fileMenuItems } = await import("/src/app/fileMenu.ts")
          set({ view: { kind: "thread" }, settings: false })
          const project = useApp.getState().projects.find((item) => item.path === ${JSON.stringify(project)})
          const thread = createThread({ projectId: project.id, backend: "native", title: "e2e links" })
          await until(() => runtimeOf(thread.id).engine === "ready", 60000, "the thread's engine")
          // An answer naming a file and line in code, and one as a markdown link, as models write them.
          const at = Date.now()
          const text = "The second file is \`src/file2.ts:2\`, and the readme is [here](README.md)."
          const frames = ["turn.started", "assistant.message", "turn.completed"].map((type, index) => ({ kind: "event", data: { version: 1, sessionId: "e2e-links", seq: 900000 + index, at, type, turnId: "e2e-links", ...(type === "assistant.message" ? { text } : {}) } }))
          patchRuntime(thread.id, { timeline: applyFrames(runtimeOf(thread.id).timeline, frames) })
          const host = getHost()
          const saved = { open: host.workspaceOpenIn, reveal: host.workspaceReveal }
          let external = 0
          host.workspaceOpenIn = async () => { external += 1 }
          host.workspaceReveal = async () => { external += 1 }
          try {
            const link = await until(() => document.querySelector(".inline-path"), 10000, "the file link")
            link.click()
            const name = await until(() => document.querySelector(".file-preview-name")?.innerText, 20000, "the Files pane")
            const line = await until(() => document.querySelector(".file-preview-line")?.innerText, 5000, "the line")
            const marked = await until(() => document.querySelector(".file-line-target")?.getBoundingClientRect().height, 5000, "the line mark")
            document.querySelector(".file-link").click()
            const second = await until(() => document.querySelector(".file-preview-name")?.innerText === "README.md" && "README.md", 20000, "the readme")
            const menu = fileMenuItems(project.path, "src/file2.ts").map((item) => ("separator" in item ? "-" : item.label))
            return { name, line, marked, second, external, menu, editors: useApp.getState().openIn ?? [] }
          } finally {
            host.workspaceOpenIn = saved.open
            host.workspaceReveal = saved.reveal
          }`)
        expect(seen.name === "file2.ts" && seen.line === "Line 2" && seen.marked > 0, `the link opened ${seen.name} at ${seen.line}`)
        expect(seen.second === "README.md", "the markdown link did not open the readme")
        expect(seen.external === 0, `${String(seen.external)} clicks went to another app`)
        expect(seen.menu[0] === "Open in Runrail" && seen.menu.includes("Reveal in Finder") && seen.menu.at(-1) === "Copy relative path", `the menu is ${JSON.stringify(seen.menu)}`)
        expect(!seen.menu.some((label) => /Open in (Terminal|Finder|iTerm|Ghostty)$/.test(label)), `the file menu offers a folder app: ${JSON.stringify(seen.menu)}`)
        return `file2.ts at line 2 and README.md opened in the Files pane, none in another app; menu: ${seen.menu.filter((label) => label !== "-").join(", ")} (this Mac has ${seen.editors.join(", ")})`
      })
    }

    await check("side panels resize by drag and by keys, within their limits", async () => {
      const handles = await page<readonly { readonly side: string; readonly before: number; readonly dragged: number; readonly keyed: number; readonly clamped: number; readonly min: number; readonly max: number; readonly stuck: boolean }[]>(`
        const out = []
        for (const handle of document.querySelectorAll(".resizer")) {
          const side = handle.classList.contains("resizer-left") ? "left" : "right"
          const value = () => Number(handle.getAttribute("aria-valuenow"))
          const before = value()
          const box = handle.getBoundingClientRect()
          const x = box.left + box.width / 2
          const pointer = (type, clientX) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX, clientY: box.top + box.height / 2, button: 0, buttons: type === "pointerup" ? 0 : 1 }))
          pointer("pointerdown", x); pointer("pointermove", x - 60); pointer("pointerup", x - 60)
          await frame(100)
          const dragged = value()
          handle.focus()
          handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }))
          await frame(100)
          const keyed = value()
          pointer("pointerdown", x); pointer("pointermove", x + 5000)
          await frame(100)
          const clamped = value()
          pointer("pointercancel", x + 5000)
          await frame(50)
          out.push({ side, before, dragged, keyed, clamped, min: Number(handle.getAttribute("aria-valuemin")), max: Number(handle.getAttribute("aria-valuemax")), stuck: document.body.classList.contains("is-resizing") })
          handle.dispatchEvent(new KeyboardEvent("keydown", { key: side === "left" ? "ArrowRight" : "ArrowLeft", shiftKey: true, bubbles: true }))
        }
        return out`)
      expect(handles.length > 0, "no resizer is on screen")
      for (const handle of handles) {
        const grow = handle.side === "right" ? -60 : 60
        expect(handle.dragged === Math.max(handle.min, Math.min(handle.max, handle.before + grow)), `the ${handle.side} panel went ${String(handle.before)} to ${String(handle.dragged)} on a 60px drag`)
        expect(handle.keyed === Math.max(handle.min, Math.min(handle.max, handle.dragged + (handle.side === "right" ? 48 : -48))), `the ${handle.side} panel went ${String(handle.dragged)} to ${String(handle.keyed)} on shift+ArrowRight`)
        expect(handle.clamped === (handle.side === "right" ? handle.max : handle.min), `the ${handle.side} panel did not stop at its limit (${String(handle.clamped)})`)
        expect(!handle.stuck, "a cancelled drag left the app in resize mode")
      }
      return handles.map((handle) => `${handle.side}: ${String(handle.before)} drag ${String(handle.dragged)} key ${String(handle.keyed)} limit ${String(handle.clamped)}`).join("; ")
    })

    await check("every main view renders", async () => {
      const views = await page<Record<string, number | string>>(`
        const out = {}
        for (const name of ["Reviews", "Agents", "Workflows", "Evals", "Integrations", "Memory", "Settings"]) {
          const target = [...document.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.innerText.trim()).startsWith(name))
          if (!target) { out[name] = "no button"; continue }
          target.click()
          await wait(1200)
          const text = (document.querySelector("main") || document.body).innerText
          out[name] = /something went wrong/i.test(text) ? "crashed" : text.trim().length
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
          await wait(200)
        }
        const { set } = await import("/src/app/store.ts")
        set({ view: { kind: "thread" } })
        return out`)
      for (const [name, value] of Object.entries(views)) expect(typeof value === "number" && value > 50, `${name}: ${String(value)}`)
      return Object.entries(views)
        .map(([name, value]) => `${name} ${String(value)}`)
        .join(", ")
    })

    const made = await check("a new app from the Nifra starter: the dialog, the folder dialog, npm, the first commit", async () => {
      mkdirSync(appsParent, { recursive: true })
      expect((await automationClient.pick(appsParent)).ok, "the pick was not queued")
      const shown = await page<{ readonly cards: readonly string[]; readonly chosen: string; readonly slug: string; readonly note: string }>(`
        const { set } = await import("/src/app/store.ts")
        set({ view: { kind: "thread" }, settings: false })
        await frame(200)
        button("Add project").click()
        const dialog = await until(() => document.querySelector(".create-project"), 10000, "the create project dialog")
        ;[...dialog.querySelectorAll("button")].find((node) => node.innerText.trim() === "New app").click()
        await until(() => dialog.querySelectorAll(".starter-card:not(.is-loading)").length === 4, 30000, "the starters")
        const input = dialog.querySelector("input[aria-label='App name']")
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "E2E Shop")
        input.dispatchEvent(new Event("input", { bubbles: true }))
        const slug = (await until(() => dialog.querySelector(".create-project-slug"), 5000, "the folder name")).innerText.trim()
        const text = (node) => node.innerText.replace(/\\s+/g, " ").trim()
        const cards = [...dialog.querySelectorAll(".starter-card")].map(text)
        const chosen = text(dialog.querySelector(".starter-card.is-chosen"))
        const note = text(dialog.querySelector(".starter-note"))
        button("Choose where and create", dialog).click()
        await until(() => dialog.querySelector(".starter-making"), 10000, "the making status")
        return { cards, chosen, slug, note }`)
      expect(shown.cards.length === 4 && ["Nifra", "Vite + React", "Next.js", "Empty"].every((label, index) => shown.cards[index]?.includes(label) === true), `the starters are ${JSON.stringify(shown.cards)}`)
      expect(shown.chosen.includes("Nifra") && shown.chosen.includes("Recommended") && shown.chosen.includes("By the authors of Runrail"), `the default is ${shown.chosen}`)
      expect(shown.slug === "e2e-shop", `the folder name shown is ${shown.slug}`)
      expect(shown.note.includes("create-nifra@5.3.0 from npm"), `the dialog says ${shown.note}`)
      const started = Date.now()
      for (;;) {
        const state = await page<{ readonly added: boolean; readonly failure?: string }>(`
          const { useApp } = await import("/src/app/store.ts")
          return { added: useApp.getState().projects.some((item) => item.path === ${JSON.stringify(newApp)}), failure: document.querySelector(".create-project .form-error")?.innerText }`)
        if (state.added) break
        expect(state.failure === undefined, `the starter failed: ${String(state.failure)}`)
        expect(Date.now() - started < 12 * 60_000, "the app was not made within 12 minutes")
        await sleep(3000)
      }
      const seconds = Math.round((Date.now() - started) / 1000)
      const manifest = JSON.parse(readFileSync(join(newApp, "package.json"), "utf8")) as { readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string> }
      const nifra = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name === "nifra" || name.startsWith("@nifrajs/"))
      expect(nifra.length > 0, "the app names no Nifra package")
      expect(existsSync(join(newApp, "node_modules")), "the packages were not installed")
      const history = git(newApp, "log", "--format=%s").trim().split("\n")
      expect(history.length === 1 && history[0] === "Start from create-nifra@5.3.0", `the history is ${JSON.stringify(history)}`)
      expect(git(newApp, "status", "--porcelain").trim() === "", "the new app has files left out of its first commit")
      const approved = JSON.parse(readFileSync(join(appData, "approved-folders.json"), "utf8")) as { readonly folders: readonly string[] }
      expect(approved.folders.includes(newApp) && !approved.folders.includes(appsParent), "only the folder the starter made may be approved")
      return `${shown.slug} made in ${String(seconds)}s: create-nifra@5.3.0, packages installed, one commit, nothing left over; ${nifra.join(", ")}; only the app's folder approved`
    })

    if (made)
      await check("a thread in the Nifra app says what Nifra adds, and the setting turns it off and on", async () => {
        if (Bun.which("nifra") === null) return "skipped: this machine has no nifra on PATH"
        // Each step leaves Settings closed, so a failure here leaves the thread view to the checks after it.
        const flip = (want: "off" | "on") => `
          const { runtimeOf, set } = await import("/src/app/store.ts")
          set({ settings: "general" })
          try {
            const toggle = await until(() => document.querySelector('[data-setting="nifra"] [role=switch]'), 10000, "the Nifra switch")
            if (toggle.getAttribute("aria-checked") !== ${JSON.stringify(want === "off" ? "true" : "false")}) throw new Error("the switch was not ${want === "off" ? "on" : "off"}")
            toggle.click()
          } finally {
            set({ settings: false })
          }
          const id = window.__e2eNifraThread
          await until(() => { const use = runtimeOf(id).nifra; return use !== undefined && ${want === "off" ? "!use.mcp && !use.pi && !use.check" : "use.mcp"} }, 100000, "Nifra ${want} in the restarted engine")
          await frame(300)
          return { use: runtimeOf(id).nifra, chip: document.querySelector(".header-nifra") !== null }`
        try {
          const shown = await page<{ readonly use: unknown; readonly summary: string; readonly found: boolean; readonly on: string }>(`
            const { useApp, createThread, runtimeOf, set } = await import("/src/app/store.ts")
            set({ view: { kind: "thread" }, settings: false })
            const project = useApp.getState().projects.find((item) => item.path === ${JSON.stringify(newApp)})
            const thread = createThread({ projectId: project.id, backend: "native", title: "e2e nifra" })
            window.__e2eNifraThread = thread.id
            const chip = await until(() => document.querySelector(".header-nifra"), 100000, "the Nifra chip")
            const summary = chip.getAttribute("title")
            chip.click()
            const row = await until(() => document.querySelector('[data-setting="nifra"]'), 10000, "the Nifra setting")
            const found = await until(() => row.classList.contains("is-found"), 3000, "the setting marked").then(() => true, () => false)
            const on = row.querySelector("[role=switch]").getAttribute("aria-checked")
            set({ settings: false })
            return { use: runtimeOf(thread.id).nifra, summary, found, on }`)
          const use = shown.use as { readonly mcp: boolean; readonly pi: boolean; readonly check: boolean }
          // The desktop's engines run the after-turn check only when asked, so Nifra adds its MCP tools here.
          expect(use.mcp, `a Nifra app with nifra installed has no Nifra MCP: ${JSON.stringify(use)}`)
          expect(shown.summary.includes("Nifra is made by the authors of Runrail") && shown.summary.includes("turn this off in Settings"), `the chip says ${shown.summary}`)
          expect(shown.found && shown.on === "true", "the chip did not open Settings at the Nifra switch, on")
          const off = await page<{ readonly use: unknown; readonly chip: boolean }>(flip("off"))
          expect(!off.chip, "the chip still shows with Nifra off")
          const back = await page<{ readonly use: unknown; readonly chip: boolean }>(flip("on"))
          expect(back.chip, "the chip did not come back")
          return `chip: "${shown.summary}"; in use ${JSON.stringify(use)}; off ${JSON.stringify(off.use)} with no chip; back on ${JSON.stringify(back.use)}`
        } finally {
          await page(`const { set } = await import("/src/app/store.ts"); set({ settings: false }); return true`).catch(() => undefined)
        }
      })

    if (created) {
      const pages = servePreviewPage()
      try {
        await previewChecks(automationClient, page, pages.url)
      } finally {
        pages.stop()
      }
    }

    await computerChecks(automationClient, page)

    if (desktop !== undefined) await linuxChecks(page, check, { home, project, identifier: IDENTIFIER, created })

    if (modelRuns && created) {
      await check("Best of 2 on Claude Code: approve in the comparison, check, apply", async () => {
        // The app answers one page script for at most two minutes, so the runs start here and are watched in short calls.
        const watch = async <T>(source: string, timeoutMs: number, what: string): Promise<T> => {
          const deadline = Date.now() + timeoutMs
          for (;;) {
            const value = await page<T | null>(source)
            if (value !== null) return value
            if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}; the runs show ${await page<string>(describe).catch(() => "nothing")}`)
            await sleep(2000)
          }
        }
        const describe = `const grid = document.querySelector(".compare-grid")
          if (!grid) return "no comparison"
          const { useApp, runtimeOf } = await import("/src/app/store.ts")
          const cards = [...grid.querySelectorAll(".candidate")].map((card) => [".candidate-status", ".candidate-check", ".candidate-files"].map((selector) => (card.querySelector(selector)?.innerText ?? "-").replace(/\\s+/g, " ").trim().slice(0, 140)).join(" / "))
          const ends = useApp.getState().threads.filter((thread) => thread.group !== undefined).map((thread) => (runtimeOf(thread.id)?.timeline.items ?? []).filter((item) => item.kind === "notice" || item.kind === "turn-end" || item.kind === "tool").map((item) => item.kind === "notice" ? "notice " + item.code + ": " + (item.message ?? "").slice(0, 300) : item.kind === "tool" ? "tool " + item.name + " " + item.status : "end " + item.status).join("; "))
          return cards.join(" | ") + " || " + ends.join(" | ") + " || " + (window.__e2eBest?.approvals ?? []).join("; ")`
        await page(`
          const { useApp } = await import("/src/app/store.ts")
          const { startBestOf } = await import("/src/app/workflows.ts")
          window.__e2eBest = { approvals: [] }
          await startBestOf({
            projectId: useApp.getState().projects[0].id,
            prompt: "Use your file writing tool to create NOTE.md in the current folder containing exactly one line: hello from a run. Do not run commands or read other files.",
            runs: [{ backend: "claude-code", model: "haiku" }, { backend: "claude-code", model: "haiku" }],
            check: "test -f NOTE.md",
          })
          await until(() => document.querySelector(".compare-grid"), 30000, "the comparison")
          return true`)
        const grid = `const grid = document.querySelector(".compare-grid"); if (!grid) throw new Error("the comparison closed")`
        const statuses = await watch<readonly string[]>(
          `${grid}
          for (const card of grid.querySelectorAll(".candidate-approval")) {
            const what = card.querySelector(".candidate-approval-action")?.innerText ?? ""
            const answer = button(what.includes("NOTE.md") ? "Approve" : "Deny", card)
            if (answer && !answer.disabled) { window.__e2eBest.approvals.push((what.includes("NOTE.md") ? "approved: " : "denied: ") + what.slice(0, 80)); answer.click() }
          }
          const statuses = [...grid.querySelectorAll(".candidate-status")].map((node) => node.innerText.trim())
          return statuses.length === 2 && statuses.every((status) => ["Done", "Failed", "Stopped"].includes(status)) ? statuses : null`,
          MODEL_RUN_TIMEOUT_MS,
          "both runs to finish",
        )
        if (!statuses.every((status) => status === "Done")) throw new Error(`the runs ended ${JSON.stringify(statuses)}; ${await page<string>(describe).catch(() => "")}`)
        await watch<boolean>(`${grid}
          const checked = [...grid.querySelectorAll(".candidate-check")].every((node) => /Passed|Failed|Could not/.test(node.innerText))
          return checked && [...grid.querySelectorAll(".candidate")].every((card) => card.querySelector(".candidate-file-list, .pane-note")) ? true : null`, 180_000, "both checks and change sets")
        const result = await page<{ readonly files: readonly string[]; readonly checks: readonly string[] }>(`${grid}
          const files = [...grid.querySelectorAll(".candidate")].map((card) => [...card.querySelectorAll(".candidate-file-path")].map((node) => node.innerText).join(",") || "none")
          const checks = [...grid.querySelectorAll(".candidate-check")].map((node) => node.innerText.replace(/\\s+/g, " ").trim())
          const cards = [...grid.querySelectorAll(".candidate")]
          const winner = cards.find((card) => card.querySelector(".candidate-check .pill")) ?? cards[0]
          button("Apply", winner).click()
          const confirm = await until(() => [...document.querySelectorAll("[role=dialog]")].find((node) => node.innerText.includes("Apply this run")), 10000, "the apply confirmation")
          button("Apply", confirm).click()
          return { files, checks }`)
        const applied = await watch<string>(`const banner = document.querySelector(".apply-banner"); return banner ? banner.innerText.replace(/\\s+/g, " ").trim() : null`, 60_000, "the apply result")
        const approvals = await page<readonly string[]>(`return window.__e2eBest.approvals`)
        const seen = { approvals, statuses, files: result.files, checks: result.checks, applied }
        expect(seen.statuses.every((status) => status === "Done"), `the runs ended ${JSON.stringify(seen.statuses)}`)
        // Your own Claude Code may bring tools that write into any folder it opens (Serena's .serena/), so NOTE.md must be there, not alone.
        expect(seen.files.every((files) => files.split(",").includes("NOTE.md")), `the runs changed ${JSON.stringify(seen.files)}`)
        expect(seen.checks.every((line) => line.includes("Passed")), `the checks said ${JSON.stringify(seen.checks)}`)
        const staged = git(project, "status", "--porcelain", "--", "NOTE.md").trim()
        expect(staged.startsWith("A"), `NOTE.md in the project is '${staged}', not staged as new`)
        expect(readFileSync(join(project, "NOTE.md"), "utf8").includes("hello from a run"), "NOTE.md does not hold the run's line")
        const extra = [...new Set(seen.files.flatMap((files) => files.split(",")).filter((file) => file !== "NOTE.md"))]
        return `${String(seen.approvals.length)} approvals (${seen.approvals.join(" | ")}); checks ${seen.checks.join(" / ")}; ${seen.applied}${extra.length === 0 ? "" : `; also written by your tools: ${extra.join(", ")}`}`
      })
    }

    if (setupRun && created) {
      await check("a setup run plans, waits for approval, executes, checks and reviews", async () => runSetup(page, automationClient))
    }

    if (!ownAccounts) {
      await check("the run touched none of your accounts", async () => {
        const usage = await page<number>(`return document.querySelectorAll("[aria-label^='Plan usage']").length`)
        expect(usage === 0, "plan usage from a real account is on screen")
        expect(!existsSync(join(appData, "agent-sdk")), "the Agent SDK was fetched")
        return "no plan usage read, no Agent SDK fetched"
      })
    }

    await check("no page errors", async () => {
      const errors = await page<readonly string[]>(`return errors`)
      expect(errors.length === 0, errors.join(" | "))
      return "none"
    })
  } finally {
    await stopApp(app.pid)
    desktop?.stop()
  }
  return app.pid
}

type PageRunner = <T>(source: string, timeoutMs?: number) => Promise<T>

/** Browser previews: placed over their panel, following it, several at once, hidden and shown, pictured, used by the agent. */
async function previewChecks(client: Automation, page: PageRunner, url: string): Promise<void> {
  const frames = async (): Promise<Readonly<Record<string, PreviewFrame>>> => {
    const answer = await client.previews()
    expect(answer.ok, answer.error ?? "the previews could not be read")
    return Object.fromEntries((answer.value as readonly { readonly tab: string; readonly frame: PreviewFrame }[]).map((entry) => [entry.tab, entry.frame]))
  }
  /** Waits until every named preview sits at its box and shows, or for `hidden` ones, does not. */
  const settle = async (boxes: Readonly<Record<string, Box>>, hidden: readonly string[] = []): Promise<Readonly<Record<string, PreviewFrame>>> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const seen = await frames()
      const placed = Object.entries(boxes).every(([tab, box]) => seen[tab] !== undefined && near(seen[tab], box) && seen[tab].visible !== false)
      const gone = hidden.every((tab) => seen[tab] === undefined || seen[tab].visible !== true)
      if (placed && gone) return seen
      if (Date.now() > deadline) throw new Error(`previews did not settle: wanted ${Object.entries(boxes).map(([tab, box]) => `${tab} ${boxText(box)}`).join("; ")}${hidden.length > 0 ? ` and ${hidden.join(", ")} hidden` : ""}; have ${Object.entries(seen).map(([tab, frame]) => `${tab} ${boxText(frame)} ${String(frame.visible)}`).join("; ")}`)
      await sleep(250)
    }
  }
  const frameBox = (selector: string) => `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, Math.round(box.left)), y: Math.max(0, Math.round(box.top)), width: Math.round(box.width), height: Math.round(box.height) } })()`

  let tab = ""
  let threadId = ""
  await check("a browser preview sits over its panel, and follows it and the window", async () => {
    // A covered window, or one on another Space, draws no frames, so placement never settles.
    const shown = await page<string>(`return document.visibilityState`)
    expect(shown === "visible", "the window is covered or on another Space; previews are placed only while it shows")
    const opened = await page<{ readonly tab: string; readonly threadId: string; readonly box: Box }>(`
      const { useApp, createThread } = await import("/src/app/store.ts")
      const { newPanelTab } = await import("/src/app/panels.ts")
      const { usePreviews } = await import("/src/app/previews.ts")
      const thread = createThread({ projectId: useApp.getState().projects[0].id, backend: "native", title: "e2e browser" })
      await wait(800)
      const tab = newPanelTab(thread.id, "browser", ${JSON.stringify(url)}, { show: true })
      await until(() => usePreviews.getState()[tab]?.title === "e2e page", 30000, "the page to load")
      await frame(300)
      return { tab, threadId: thread.id, box: ${frameBox(".browser-frame")} }`)
    tab = opened.tab
    threadId = opened.threadId
    await settle({ [tab]: opened.box })
    const handle = await page<Box>(`
      const handle = [...document.querySelectorAll(".resizer-left")].find((node) => node.parentElement.contains(document.querySelector(".browser-frame")))
      const box = handle.getBoundingClientRect()
      const x = box.left + box.width / 2
      const pointer = (type, clientX) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX, clientY: box.top + box.height / 2, button: 0, buttons: type === "pointerup" ? 0 : 1 }))
      pointer("pointerdown", x); pointer("pointermove", x - 120); pointer("pointerup", x - 120)
      await frame(400)
      return ${frameBox(".browser-frame")}`)
    expect(handle.width >= opened.box.width + 100, `the panel did not widen: ${boxText(handle)}`)
    const widened = await settle({ [tab]: handle })
    const before = await page<{ readonly width: number; readonly height: number }>(`return { width: innerWidth, height: innerHeight }`)
    expect((await client.windowSize(before.width - 160, before.height - 100)).ok, "the window was not resized")
    const smaller = await page<Box>(`await until(() => innerWidth <= ${String(before.width - 150)}, 10000, "the smaller window"); await frame(400); return ${frameBox(".browser-frame")}`)
    await settle({ [tab]: smaller })
    expect((await client.windowSize(before.width, before.height)).ok, "the window was not resized back")
    const back = await page<Box>(`await until(() => innerWidth >= ${String(before.width - 1)}, 10000, "the window back"); await frame(400); return ${frameBox(".browser-frame")}`)
    await settle({ [tab]: back })
    return `${boxText(opened.box)}; panel dragged ${boxText(widened[tab] ?? handle)}; window -160x-100 ${boxText(smaller)}; back ${boxText(back)}`
  })
  if (tab === "") return

  await check("previews hide with their tab, show again, and three artboards sit side by side at their own widths", async () => {
    const box = await page<Box>(`return ${frameBox(".browser-frame")}`)
    await page(`
      const { newPanelTab } = await import("/src/app/panels.ts")
      newPanelTab(${JSON.stringify(threadId)}, "files", undefined, { show: true })
      await frame(300)
      return true`)
    await settle({}, [tab])
    await page(`const { selectPanelTab } = await import("/src/app/panels.ts"); selectPanelTab(${JSON.stringify(threadId)}, ${JSON.stringify(tab)}); await frame(300); return true`)
    await settle({ [tab]: box })
    const boards = await page<Readonly<Record<string, Box>>>(`
      const { setArtboards, artboardTab, ARTBOARDS } = await import("/src/app/artboards.ts")
      const { usePreviews } = await import("/src/app/previews.ts")
      setArtboards(${JSON.stringify(tab)}, true)
      const ids = ARTBOARDS.map((board) => artboardTab(${JSON.stringify(tab)}, board.id))
      await until(() => ids.every((id) => usePreviews.getState()[id]?.title === "e2e page") && document.querySelectorAll(".artboard").length === ids.length, 30000, "the artboards to load")
      await frame(400)
      const boxes = {}
      ;[...document.querySelectorAll(".artboard")].forEach((node, index) => {
        const box = node.getBoundingClientRect()
        boxes[ids[index]] = { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
      })
      return boxes`)
    await settle(boards, [tab])
    const ids = Object.keys(boards)
    const widths: number[] = []
    for (const id of ids) {
      expect((await client.dialog("accept")).ok, "an answer was not queued")
      const answer = await page<{ readonly ok?: { readonly text: string }; readonly code?: string }>(`return await invoke("preview_eval", { tab: ${JSON.stringify(id)}, expression: "innerWidth", anySite: false })`)
      expect(answer.ok !== undefined, `${id}: the script did not run (${String(answer.code)})`)
      widths.push(Number(answer.ok.text))
    }
    // Phone, tablet, and desktop lay out at 390, 820, and 1280 CSS pixels, zoomed to fit.
    expect(widths.every((width, index) => Math.abs(width - [390, 820, 1280][index]) <= 2), `the artboards lay out at ${widths.join(", ")}`)
    await page(`const { setArtboards } = await import("/src/app/artboards.ts"); setArtboards(${JSON.stringify(tab)}, false); await frame(300); return true`)
    await settle({ [tab]: box }, ids)
    return `hidden and shown at ${boxText(box)}; artboards ${ids.map((id) => boxText(boards[id] ?? box)).join(" | ")} laid out at ${widths.join(", ")}`
  })

  await check("a preview's screenshot is the page as shown", async () => {
    const shot = await page<{ readonly width: number; readonly height: number; readonly expected: number; readonly pixel: readonly number[]; readonly code?: string }>(`
      const answer = await invoke("preview_screenshot", { tab: ${JSON.stringify(tab)}, anySite: false })
      if (!answer.ok) return { width: 0, height: 0, expected: 0, pixel: [], code: answer.code + ": " + answer.message }
      const bytes = Uint8Array.from(atob(answer.ok.dataBase64), (char) => char.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: answer.ok.mediaType }))
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext("2d")
      context.drawImage(bitmap, 0, 0)
      const pixel = [...context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height * 3 / 4), 1, 1).data].slice(0, 3)
      const box = document.querySelector(".browser-frame").getBoundingClientRect()
      return { width: bitmap.width, height: bitmap.height, expected: Math.round(Math.min(box.width * devicePixelRatio, 1600)), pixel }`)
    expect(shot.code === undefined, `the screenshot failed: ${String(shot.code)}`)
    expect(Math.abs(shot.width - shot.expected) <= 2, `the picture is ${String(shot.width)} wide, not ${String(shot.expected)}`)
    const [red = 0, green = 0, blue = 0] = shot.pixel
    expect(Math.abs(red - 200) <= 24 && Math.abs(green - 30) <= 24 && Math.abs(blue - 30) <= 24, `the picture shows rgb(${shot.pixel.join(",")}), not the page's rgb(200,30,30)`)
    return `${String(shot.width)}x${String(shot.height)} JPEG, page colour rgb(${shot.pixel.join(",")})`
  })

  await check("the agent reads, clicks, and types in a preview, and runs a script only when allowed", async () => {
    const run = (script: Record<string, unknown>) => `(await invoke("preview_script", { tab: ${JSON.stringify(tab)}, script: ${JSON.stringify(script)}, anySite: false }))`
    const seen = await page<Record<string, string>>(`
      const text = (answer) => answer.ok ? answer.ok.text : "error " + answer.code + ": " + answer.message
      const snapshot = text(${run({ action: "snapshot" })})
      const ref = (snapshot.match(/(e[0-9]+) button "Go"/) || [])[1]
      const field = (snapshot.match(/(e[0-9]+) textbox "Name"/) || [])[1]
      const clicked = ref ? text(await invoke("preview_script", { tab: ${JSON.stringify(tab)}, script: { action: "click", ref }, anySite: false })) : "no ref"
      const typed = field ? text(await invoke("preview_script", { tab: ${JSON.stringify(tab)}, script: { action: "type", ref: field, text: "hello e2e" }, anySite: false })) : "no field"
      const after = text(${run({ action: "snapshot" })})
      const network = text(${run({ action: "network" })})
      const console = text(${run({ action: "console" })})
      const pickStart = text(${run({ action: "pickStart" })})
      const pickRead = text(${run({ action: "pickRead" })})
      const pickStop = text(${run({ action: "pickStop" })})
      return { snapshot, clicked, typed, after, network, console, pickStart, pickRead, pickStop }`)
    expect(/e\d+ button "Go"/.test(seen.snapshot ?? ""), `the snapshot lists no Go button: ${(seen.snapshot ?? "").slice(0, 300)}`)
    expect((seen.clicked ?? "").startsWith("Clicked") && (seen.after ?? "").includes("Title: went"), `the click did not land: ${String(seen.clicked)}`)
    expect((seen.typed ?? "").startsWith("Typed") && (seen.after ?? "").includes('value="hello e2e"'), `typing did not land: ${String(seen.typed)}`)
    expect(/GET 200 http:\/\/127\.0\.0\.1:\d+\/api\/ping/.test(seen.network ?? "") && /GET 404 http:\/\/127\.0\.0\.1:\d+\/missing/.test(seen.network ?? ""), `the network log is ${String(seen.network)}`)
    expect((seen.console ?? "").includes("e2e console line"), `the console log is ${String(seen.console)}`)
    expect(seen.pickStart === "picking" && (seen.pickRead ?? "").includes('"picking"') && seen.pickStop === "stopped", `picking an element went ${String(seen.pickStart)} / ${String(seen.pickRead)} / ${String(seen.pickStop)}`)
    expect((await client.dialog("decline")).ok && (await client.dialog("accept")).ok, "answers were not queued")
    const scripts = await page<{ readonly declined?: string; readonly ran?: string }>(`
      const declined = await invoke("preview_eval", { tab: ${JSON.stringify(tab)}, expression: "document.title", anySite: false })
      const ran = await invoke("preview_eval", { tab: ${JSON.stringify(tab)}, expression: "document.title", anySite: false })
      return { declined: declined.code, ran: ran.ok ? ran.ok.text : ran.code }`)
    expect(scripts.declined === "PREVIEW_DENIED", `a declined script gave ${String(scripts.declined)}`)
    expect(scripts.ran === "went", `an allowed script gave ${String(scripts.ran)}`)
    const asked = ((await client.dialogs()).value as readonly { readonly title: string; readonly message: string }[]).filter((entry) => entry.title === "Run the agent's script?")
    expect(asked.length >= 2 && asked.every((entry) => entry.message.includes("127.0.0.1")), "the script confirmation does not name the site")
    return "snapshot, click, type, network log (ping 200, missing 404), console, element picking; a declined script stopped, an allowed one ran"
  })

  if (x11Input) {
    await check("on X11 a click lands in the preview where it shows and in the app elsewhere, and app shortcuts work from it", async () => {
      const box = await page<Box>(`
        window.__e2eDown = 0
        window.addEventListener("mousedown", () => { window.__e2eDown += 1 }, true)
        return ${frameBox(".browser-frame")}`)
      const window = xdotool("search", "--onlyvisible", "--name", "^Runrail$").trim().split("\n")[0] ?? ""
      expect(window !== "", "the app's window was not found")
      const geometry = Object.fromEntries(xdotool("getwindowgeometry", "--shell", window).trim().split("\n").map((line) => line.split("=")))
      const left = Number(geometry.X)
      const top = Number(geometry.Y)
      xdotool("mousemove", "--sync", String(left + box.x + Math.round(box.width / 2)), String(top + box.y + Math.round(box.height * 0.75)), "click", "1")
      const inside = await page<{ readonly title?: string; readonly down: number }>(`
        const { usePreviews } = await import("/src/app/previews.ts")
        await until(() => usePreviews.getState()[${JSON.stringify(tab)}]?.title?.startsWith("clicked"), 8000, "the preview's click").catch(() => undefined)
        return { title: usePreviews.getState()[${JSON.stringify(tab)}]?.title, down: window.__e2eDown }`)
      expect(inside.title === "clicked 1" && inside.down === 0, `a click in the preview gave its title ${String(inside.title)} and the app ${String(inside.down)} presses`)
      xdotool("key", "ctrl+k")
      const palette = await page<boolean>(`
        const { useApp, set } = await import("/src/app/store.ts")
        const open = await until(() => useApp.getState().palette, 8000, "the palette").then(() => true, () => false)
        set({ palette: false })
        return open`)
      expect(palette, "Ctrl+K in the preview did not open the palette")
      xdotool("mousemove", "--sync", String(left + Math.max(10, box.x - 200)), String(top + box.y + Math.round(box.height / 2)), "click", "1")
      const outside = await page<{ readonly title?: string; readonly down: number }>(`
        const { usePreviews } = await import("/src/app/previews.ts")
        await until(() => window.__e2eDown > 0, 8000, "the app's click").catch(() => undefined)
        return { title: usePreviews.getState()[${JSON.stringify(tab)}]?.title, down: window.__e2eDown }`)
      expect(outside.down === 1 && outside.title === "clicked 1", `a click beside the preview gave the app ${String(outside.down)} presses and the preview the title ${String(outside.title)}`)
      return "click inside reached the preview only, Ctrl+K from the preview opened the palette, click beside it reached the app only"
    })
  } else {
    console.log(`- clicks and shortcuts through the window: skipped (${process.platform === "linux" ? "needs X11 and xdotool" : "Linux only"})`)
  }

  if (process.platform === "darwin") {
    await check("app shortcuts work from the menu while a browser preview has the keyboard, once each", async () => {
      const seenKeys = async (): Promise<string> => {
        expect((await client.dialog("accept")).ok, "an answer was not queued")
        const answer = await page<{ readonly ok?: { readonly text: string }; readonly code?: string }>(`return await invoke("preview_eval", { tab: ${JSON.stringify(tab)}, expression: "document.documentElement.dataset.keys || 'none'", anySite: false })`)
        return answer.ok?.text ?? `unreadable (${String(answer.code)})`
      }
      const press = async (keys: string): Promise<void> => {
        const answer = await client.previewKey(tab, keys)
        expect(answer.ok, answer.error ?? `${keys} was not pressed`)
        const seen = answer.value as { readonly sent: boolean; readonly active: boolean; readonly keyWindow: boolean; readonly previewFocused: boolean; readonly menus: readonly string[] }
        expect(seen.active, `${keys}: macOS kept another app in front, so the preview could not take the keyboard; rerun with nothing else in use`)
        expect(seen.sent && seen.keyWindow && seen.previewFocused, `${keys} was not pressed in the preview: ${JSON.stringify(seen)}`)
        expect(seen.menus.includes("Thread") && seen.menus.includes("Help"), `the app menu is not installed: the menus are ${seen.menus.join(", ")}`)
      }
      // Every change to the palette and the threads list, so a key that ran twice shows.
      const changes = async (count: number): Promise<readonly string[]> =>
        await page<readonly string[]>(`await until(() => window.__e2eChanges.length >= ${String(count)}, 8000, "the change").catch(() => undefined); await wait(400); return window.__e2eChanges`)
      const sidebar = await page<boolean>(`
        const { useApp } = await import("/src/app/store.ts")
        window.__e2eChanges = []
        window.__e2eUnsubscribe = useApp.subscribe((state, previous) => {
          if (state.palette !== previous.palette) window.__e2eChanges.push("palette " + String(state.palette))
          if (state.layout.sidebarOpen !== previous.layout.sidebarOpen) window.__e2eChanges.push("list " + String(state.layout.sidebarOpen))
        })
        return useApp.getState().layout.sidebarOpen`)
      try {
        // A plain key goes to the preview's page; wry hands a preview's Command keys to the app menu.
        await press("a")
        await sleep(800)
        const typed = await seenKeys()
        expect(typed === "a", `A in the preview reached its page as ${typed}`)
        await press("mod+k")
        const opened = await changes(1)
        expect(opened.length === 1 && opened[0] === "palette true", `Cmd+K in the preview gave ${JSON.stringify(opened)}`)
        // The palette covers the preview, which hides until it closes.
        await page(`const { set } = await import("/src/app/store.ts"); set({ palette: false }); await frame(300); return true`)
        await settle({ [tab]: await page<Box>(`return ${frameBox(".browser-frame")}`) })
        await press("mod+b")
        await changes(3)
        await press("mod+b")
        const toggled = (await changes(4)).slice(2)
        expect(toggled.length === 2 && toggled[0] === `list ${String(!sidebar)}` && toggled[1] === `list ${String(sidebar)}`, `Cmd+B twice in the preview gave ${JSON.stringify(toggled)}`)
      } finally {
        await page(`window.__e2eUnsubscribe(); return true`)
      }
      return "A reached the preview's page; from the preview Cmd+K opened the palette once, Cmd+B hid and showed the threads list"
    })
  }

  await check("closing the tab closes its preview", async () => {
    await page(`const { closePanelTab } = await import("/src/app/panels.ts"); closePanelTab(${JSON.stringify(threadId)}, ${JSON.stringify(tab)}); return true`)
    const deadline = Date.now() + 10_000
    while ((await frames())[tab] !== undefined) {
      expect(Date.now() < deadline, "the preview is still open")
      await sleep(250)
    }
    return "gone"
  })
}

/** Settings > Permissions > Computer use as the running Linux session has it. */
const computerSettingsText = `
  const { openComputerSettings } = await import("/src/ui/shell/revealSetting.ts")
  const { set } = await import("/src/app/store.ts")
  openComputerSettings()
  const text = await until(() => document.querySelector('[data-setting="computer-use"]')?.innerText, 15000, "the computer use settings")
  set({ settings: false })
  return text`

/** Computer use on Wayland: agents get only the window the person shared, and the reason when they cannot. */
async function waylandComputerChecks(page: PageRunner): Promise<void> {
  await check("on Wayland agents may use only a shared window, and are told why when there is none", async () => {
    const seen = await page<Record<string, unknown>>(`
      const act = async (action, params) => (await invoke("computer_act", { action, params })).ok ?? {}
      const access = (await invoke("computer_access", {})).ok
      const apps = await act("apps", {})
      const shot = await act("screenshot", { app: "Shared window" })
      const other = await act("screenshot", { app: "Runrail" })
      const settings = await (async () => { ${computerSettingsText} })()
      return { access, apps: apps.result?.text, shot: shot.code, said: shot.message, other: other.code, settings }`, 60_000)
    const access = seen.access as { readonly supported?: boolean; readonly session?: string; readonly portal?: string; readonly reason?: string } | undefined
    expect(access?.session === "wayland", `the session is ${JSON.stringify(seen.access)}`)
    expect(seen.other === "COMPUTER_DENIED", `Runrail itself gave ${String(seen.other)}`)
    if (access?.portal === "missing") {
      const reason = access.reason ?? ""
      expect(!access.supported && reason.includes("portal"), `no reason given: ${JSON.stringify(access)}`)
      expect(seen.shot === "COMPUTER_OFF" && seen.said === reason && seen.apps === reason, `the tools gave ${String(seen.shot)}: ${String(seen.said)}; apps: ${String(seen.apps)}`)
      expect(String(seen.settings).includes(reason), `Settings shows ${String(seen.settings)}`)
      return "no portal here: computer_access, the tools (COMPUTER_OFF), and Settings give the same reason; Runrail itself refused"
    }
    expect(access?.portal === "ready" && seen.shot === "COMPUTER_PERMISSION", `with a portal and no window shared the tools gave ${String(seen.shot)}`)
    expect(String(seen.settings).includes("Share a window"), `Settings shows ${String(seen.settings)}`)
    return "a portal and no window shared: the tools ask for one (COMPUTER_PERMISSION), Settings offers to share; Runrail itself refused"
  })
}

/** Computer use on X11: xev stands in for an allowed app and prints every event it gets. */
async function computerChecks(client: Automation, page: PageRunner): Promise<void> {
  if (process.platform === "linux" && process.env.WAYLAND_DISPLAY !== undefined) {
    await waylandComputerChecks(page)
    return
  }
  if (!x11Input || Bun.which("openbox") === null || Bun.which("xev") === null) {
    console.log(`- computer use through X11: skipped (${process.platform === "linux" ? "needs X11, openbox, and xev" : "Linux only"})`)
    return
  }
  // A window manager raises and focuses windows as a desktop does.
  const manager = spawn("openbox", [], { stdio: "ignore" })
  const xev = spawn("xev", ["-geometry", "360x240+600+300"], { stdio: ["ignore", "pipe", "ignore"] })
  let events = ""
  xev.stdout.on("data", (chunk: Buffer) => {
    events += chunk.toString("utf8")
  })
  try {
    await check("on X11 an agent sees, clicks, types, and scrolls in an allowed app, and in no other", async () => {
      expect((await client.dialog("accept")).ok, "an answer was not queued")
      const seen = await page<Record<string, unknown>>(`
        const act = async (action, params) => { const answer = await invoke("computer_act", { action, params }); return answer.ok ?? { ok: false, code: answer.code } }
        const running = await until(async () => ((await invoke("computer_running_apps", {})).ok ?? []).find((app) => app.bundleId === "xev"), 15000, "xev to open")
        const access = (await invoke("computer_access", {})).ok
        const refused = (await invoke("computer_allow", { bundleId: "xterm" })).code
        const allowed = ((await invoke("computer_allow", { bundleId: "xev" })).ok ?? []).map((app) => app.bundleId)
        const apps = await act("apps", {})
        const shot = await act("screenshot", { app: "xev" })
        let pixels = []
        if (shot.result?.image) {
          const bytes = Uint8Array.from(atob(shot.result.image.dataBase64), (char) => char.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: shot.result.image.mediaType }))
          const canvas = document.createElement("canvas")
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext("2d")
          context.drawImage(bitmap, 0, 0)
          // xev's window is white, with a black-edged box at 10,10.
          pixels = [[5, 5], [11, 35]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3))
        }
        const click = await act("click", { app: "xev", x: 200, y: 150 })
        const typed = await act("type", { app: "xev", text: "hé" })
        const key = await act("key", { app: "xev", key: "Return", modifiers: ["control"] })
        const scrolled = await act("scroll", { app: "xev", x: 200, y: 150, direction: "down", amount: 2 })
        const outside = await act("click", { app: "xev", x: 500, y: 150 })
        const other = await act("screenshot", { app: "Runrail" })
        await invoke("computer_disallow", { bundleId: "xev" })
        const removed = await act("screenshot", { app: "xev" })
        const settings = await (async () => { ${computerSettingsText} })()
        return { running, access, refused, allowed, apps: apps.result?.text, shot: shot.result?.text ?? shot.code, pixels, click: click.result?.text ?? click.code, typed: typed.result?.text ?? typed.code, key: key.result?.text ?? key.code, scrolled: scrolled.result?.text ?? scrolled.code, outside: outside.code, other: other.code, removed: removed.code, settings }`, 120_000)
      const access = seen.access as { readonly supported?: boolean; readonly session?: string } | undefined
      expect(access?.supported === true && access.session === "x11", `computer use is off: ${JSON.stringify(seen.access)}`)
      expect((seen.running as { readonly never?: boolean } | undefined)?.never === false, "xev is not an app agents may be given")
      expect(seen.refused === "COMPUTER_APP_REFUSED", `a terminal could be allowed: ${String(seen.refused)}`)
      expect((seen.allowed as readonly string[]).includes("xev") && String(seen.apps).includes("(xev)"), `xev was not allowed: ${String(seen.apps)}`)
      expect(String(seen.shot).includes("360 by 240 pixels"), `the screenshot is ${String(seen.shot)}`)
      const [white = [], black = []] = seen.pixels as number[][]
      expect(white.every((value) => value > 220) && black.every((value) => value < 60), `the screenshot shows ${JSON.stringify(seen.pixels)}, not xev's window`)
      const asked = ((await client.dialogs()).value as readonly { readonly title: string }[]).some((entry) => entry.title === "Let agents use Xev?")
      expect(asked, "the app was allowed without the person's dialog")
      for (const done of ["click", "typed", "key", "scrolled"]) expect(String(seen[done]).includes("in Xev."), `${done} gave ${String(seen[done])}`)
      await sleep(500)
      expect(/ButtonPress event[^]*?\(200,150\)[^]*?button 1,/.test(events), "xev saw no click at 200,150")
      expect(events.includes("keysym 0x68, h") && events.includes("keysym 0xe9, eacute"), "xev did not get the typed h and é")
      expect(/state 0x4, keycode \d+ \(keysym 0xff0d, Return\)/.test(events), "xev did not get Control+Return")
      expect((events.match(/button 5,/g) ?? []).length >= 2, "xev did not get two steps of scrolling down")
      expect(seen.outside === "COMPUTER_DENIED" && seen.other === "COMPUTER_DENIED" && seen.removed === "COMPUTER_DENIED", `outside the window ${String(seen.outside)}, Runrail ${String(seen.other)}, after removal ${String(seen.removed)}`)
      const settings = String(seen.settings)
      expect(settings.includes("X11 session") && !settings.includes("System Settings"), `Settings shows ${settings}`)
      return "allowed through the dialog (a terminal refused); screenshot 360x240 shows xev; click, typing (h, é), Control+Return, and scrolling reached xev; a point outside it, Runrail, and xev once removed were refused; Settings shows the X11 session"
    })
  } finally {
    xev.kill()
    manager.kill()
  }
}

let crashed: unknown
const started = await main().catch((error: unknown) => {
  crashed = error
  return undefined
})
await sleep(2000)
await check("nothing is left running", async () => {
  const left = leftovers()
  expect(started === undefined || !groupAlive(started), "tauri dev or the app is still running")
  expect(left.length === 0, left.join(" | "))
  return "app and engines stopped"
})
const failed = results.filter((result) => !result.ok)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}: ${result.detail}`)
if (crashed !== undefined) console.log(`\nThe run stopped early: ${crashed instanceof Error ? crashed.message : String(crashed)}`)
if (failed.length > 0 || crashed !== undefined) {
  console.log(`\nKept for a look: ${tmp} (app log: ${log})`)
  process.exit(1)
}
rmSync(tmp, { recursive: true, force: true })
