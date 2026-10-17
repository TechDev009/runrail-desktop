import { beforeEach, describe, expect, test } from "bun:test"
import { loadCatalog } from "../src/app/catalog"
import { connectionsChanged } from "../src/app/connections"
import { defaultState } from "../src/app/persist"
import { toolState } from "../src/app/picker"
import { addProject, set } from "../src/app/store"
import { HostError, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/**
 * Coding tools in the catalog. The engine lists them at once and, a moment later, says what each
 * tool answered when asked about itself. The catalog never waits for the second answer.
 */

let calls: { method: string; params: Record<string, unknown> }[]
let project = 0

function use(status: (params: Record<string, unknown>) => unknown): string {
  const host = createFakeHost()
  const seen: { method: string; params: Record<string, unknown> }[] = []
  calls = seen
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (!method.startsWith("harness.")) return host.rpc(engineId, method, params)
      seen.push({ method, params: params ?? {} })
      return method === "harness.status" ? status(params ?? {}) : host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  // The catalog is kept per project for the whole session, so each test reads a project of its own.
  project += 1
  const id = `tools-${String(project)}`
  addProject({ id, path: `/code/${id}`, name: id, git: false, addedAt: 1 })
  return id
}

async function until(done: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("the catalog never changed")
}

const READY = [
  { descriptor: { id: "claude-code", name: "Claude Code", kind: "command", note: "not for the menu" }, available: true, signedIn: true, version: "2.1.227", models: [{ id: "opus", name: "Opus", efforts: ["max", "persistent", 7, "low"], reasoning: true }, { id: "two words" }, "not a model", { id: "opus[1m]", reasoning: false }], efforts: ["low", "high", "persistent"], freeTextModel: true, email: "never-shown@example.invalid" },
  { descriptor: { id: "codex", name: "Codex" }, available: true, reason: "signed-out", signedIn: false },
  { descriptor: { id: "pi", name: "Pi" }, available: false, reason: "not-installed" },
  { descriptor: { id: "" }, available: true },
  "not a tool",
]

beforeEach(() => {
  calls = []
})

describe("coding tools in the catalog", () => {
  test("are listed at once, and what each one said about itself fills in after", async () => {
    let answer: (value: unknown) => void = () => undefined
    const id = use(() => new Promise((resolve) => (answer = resolve)))
    const first = await loadCatalog(id)
    // Before the tools have answered, nothing is known about any of them, and nothing is refused.
    expect(first.harnesses.map((tool) => tool.id)).toEqual(["native", "claude-code", "codex", "copilot", "opencode", "gemini", "goose", "pi"])
    expect(first.harnesses.every((tool) => tool.available === undefined)).toBe(true)
    expect(toolState(first.harnesses, "codex")).toBe("unknown")
    await until(async () => calls.length === 2)
    expect(calls.map((call) => call.method).sort()).toEqual(["harness.list", "harness.status"])

    answer(READY)
    await until(async () => (await loadCatalog(id)).harnesses.some((tool) => tool.available !== undefined))
    const tools = (await loadCatalog(id)).harnesses
    expect(tools).toEqual([
      { id: "claude-code", name: "Claude Code", kind: "command", available: true, version: "2.1.227", signedIn: true, models: [{ id: "opus", name: "Opus", efforts: ["low", "max"], reasoning: true }, { id: "opus[1m]", reasoning: false }], efforts: ["low", "high"], freeTextModel: true },
      { id: "codex", name: "Codex", available: true, signedIn: false },
      { id: "pi", name: "Pi", available: false },
    ])
    expect(toolState(tools, "claude-code")).toBe("ready")
    expect(toolState(tools, "codex")).toBe("signed-out")
    expect(toolState(tools, "pi")).toBe("missing")
    // Only what the menu uses is kept: no stray field of the answer rides along.
    expect(JSON.stringify(tools)).not.toContain("never-shown")
    expect(JSON.stringify(tools)).not.toContain("not for the menu")
    // The answer is kept: reading the catalog again asks nothing more of the tools.
    expect(calls.filter((call) => call.method === "harness.status")).toHaveLength(1)
  })

  test("a refresh asks the tools again, and says so", async () => {
    let round = 0
    const id = use((params) => {
      round += 1
      return round === 1 ? [{ descriptor: { id: "codex" }, available: true, signedIn: false }] : params.refresh === true ? [{ descriptor: { id: "codex" }, available: true, signedIn: true }] : []
    })
    await loadCatalog(id)
    await until(async () => toolState((await loadCatalog(id)).harnesses, "codex") === "signed-out")
    await loadCatalog(id, true)
    await until(async () => toolState((await loadCatalog(id)).harnesses, "codex") === "ready")
    expect(calls.filter((call) => call.method === "harness.status").map((call) => call.params)).toEqual([{}, { refresh: true }])
  })

  test("an engine that cannot answer keeps the plain list", async () => {
    const id = use(() => {
      throw new HostError("CONTROL_METHOD_NOT_FOUND", "unknown method")
    })
    const first = await loadCatalog(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const again = await loadCatalog(id)
    expect(again.harnesses).toEqual(first.harnesses)
    expect(toolState(again.harnesses, "claude-code")).toBe("unknown")
    // An answer with nothing usable in it changes nothing either.
    const empty = use(() => ["nothing", { available: true }])
    await loadCatalog(empty)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(toolState((await loadCatalog(empty)).harnesses, "pi")).toBe("unknown")
  })

  test("an engine from before the question is not asked it", async () => {
    const id = use(() => READY)
    const host = createFakeHost()
    const asked: string[] = []
    setHost({
      ...host,
      // The same preview engine, minus the capability a newer engine reports.
      engineStart: async (input) => {
        const info = await host.engineStart(input)
        const contract = info.contract as { capabilities: string[]; capabilityStatus: Record<string, string> }
        const { "harness.status": _gone, ...capabilityStatus } = contract.capabilityStatus
        return { ...info, contract: { ...contract, capabilities: contract.capabilities.filter((name) => name !== "harness.status"), capabilityStatus } }
      },
      rpc: async (engineId, method, params) => {
        asked.push(method)
        return host.rpc(engineId, method, params)
      },
    })
    const tools = (await loadCatalog(id)).harnesses
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toContain("harness.list")
    expect(asked).not.toContain("harness.status")
    expect(tools.map((tool) => tool.id)).toEqual(["native", "claude-code", "codex", "copilot", "opencode", "gemini", "goose", "pi"])
    expect(toolState((await loadCatalog(id)).harnesses, "codex")).toBe("unknown")
  })

  test("with no project open there are no tools to ask", async () => {
    use(() => READY)
    expect((await loadCatalog(undefined)).harnesses).toEqual([])
    expect(calls).toEqual([])
  })
})
