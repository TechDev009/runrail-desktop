import { expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine } from "../src/app/engines"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, set, setLayout } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { forgetInlineRunsForThread, forgetInlineRun, rememberInlineRun } from "../src/ui/inspector/inlineRuns"
import { commandWithExitStatus, createTerminalAndSubmit, describeSupport, runInThreadTerminal, terminalSupport } from "../src/ui/inspector/TerminalPane"
import { PANEL_LIMITS } from "../src/app/persist"

test("an engine that cannot answer yet is asked again instead of showing Connecting for good", async () => {
  const host = createFakeHost({})
  let asked = 0
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method !== "terminal.describe") return host.rpc(engineId, method, params)
      asked += 1
      if (asked < 2) throw Object.assign(new Error("timed out"), { code: "CONTROL_TIMEOUT" })
      return { shells: [] }
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  await ensureEngine(thread.id)
  describeSupport(thread.id)
  for (let tries = 0; tries < 60 && terminalSupport(thread.id) !== "yes"; tries += 1) await Bun.sleep(50)
  expect(terminalSupport(thread.id)).toBe("yes")
  expect(asked).toBe(2)
})

test("a Run action stays on its originating thread and submits once after terminal.create", async () => {
  const host = createFakeHost({})
  setHost(host)
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "run-project", path: "/code/run", name: "run", git: true, addedAt: 1 })
  const source = createThread({ projectId: "run-project", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  const active = createThread({ projectId: "run-project", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  setLayout({ activeThreadId: active.id })
  const block = ["printf 'hello'", "false"].join("\n")
  const runKey = "test:assistant:block"
  const launch = runInThreadTerminal(source.id, block, runKey)
  expect(launch.threadId).toBe(source.id)
  expect(runInThreadTerminal(source.id, block, runKey).terminalId).toBe(launch.terminalId)
  expect(launch.terminalId).toBeDefined()

  const calls: { readonly threadId: string; readonly method: string; readonly params: Record<string, unknown> }[] = []
  let releaseCreate!: () => void
  const shellReady = new Promise<void>((resolve) => { releaseCreate = resolve })
  const rpc = async (threadId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ threadId, method, params })
    if (method === "terminal.create") await shellReady
    return {}
  }
  const command = commandWithExitStatus(block)
  const started = createTerminalAndSubmit(source.id, launch.terminalId!, 90, 24, command, rpc)
  expect(calls.map((call) => call.method)).toEqual(["terminal.create"])
  releaseCreate()
  await started
  expect(calls.map((call) => call.method)).toEqual(["terminal.create", "terminal.write"])
  expect(calls.every((call) => call.threadId === source.id)).toBe(true)
  expect(calls[1]?.params.data).toBe(`${command}\r`)
  expect(command).toContain("[Runrail exit status: %s]")
  forgetInlineRun(runKey)
})

test("Run reports a visible error when its thread no longer exists", () => {
  expect(runInThreadTerminal("missing-thread", "echo nope").error).toBe("This thread is no longer available.")
})

test("in-thread Run shares the per-thread terminal limit", () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "terminal-limit-project", path: "/code/terminal-limit", name: "terminal-limit", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "terminal-limit-project", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  for (let index = 0; index < PANEL_LIMITS.terminal; index += 1) {
    rememberInlineRun(`terminal-limit:${String(index)}`, { threadId: thread.id, terminalId: `terminal:${String(index)}` })
  }
  expect(runInThreadTerminal(thread.id, "echo too many").error).toBe("Close a terminal in this thread before running another code block.")
  forgetInlineRunsForThread(thread.id)
})
test("a multiline shell block is evaluated intact and its exit status is printed", () => {
  const block = ["printf 'hello'", "false"].join("\n")
  const result = Bun.spawnSync(["sh", "-c", commandWithExitStatus(block)], { stdout: "pipe", stderr: "pipe" })
  const output = new TextDecoder().decode(result.stdout)
  expect(output).toContain("hello")
  expect(output).toContain("[Runrail exit status: 1]")
  expect(result.exitCode).toBe(0)
})

test("an engine without terminal support reports a clear Run error", async () => {
  const host = createFakeHost({})
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "terminal.describe") throw Object.assign(new Error("terminal unavailable"), { code: "CONTROL_CAPABILITY_UNAVAILABLE" })
      return host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "no-terminal-project", path: "/code/no-terminal", name: "no-terminal", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "no-terminal-project", backend: "native", model: "gpt-5.5", connectionId: "openai" })
  await ensureEngine(thread.id)
  describeSupport(thread.id)
  for (let tries = 0; tries < 60 && terminalSupport(thread.id) !== "no"; tries += 1) await Bun.sleep(50)
  expect(terminalSupport(thread.id)).toBe("no")
  expect(runInThreadTerminal(thread.id, "echo ready").error).toBe("This engine does not support an in-thread terminal.")
})
