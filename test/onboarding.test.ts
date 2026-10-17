import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { listConnectionSettings, type ToolConnection } from "../src/app/connectionSettings"
import { applyTools, bringOver, hasSetup, initialPicks, missingTools, offersLimits, setupFound, toolChoices } from "../src/app/onboarding"
import { defaultState } from "../src/app/persist"
import type { CodingTool } from "../src/app/picker"
import { get, set, setPrefs } from "../src/app/store"
import { getHost, setHost, type McpServer, type OtherTools } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

const tool = (id: string, fields: Partial<CodingTool> = {}): CodingTool => ({ id, available: true, ...fields }) as CodingTool
const connection = (id: string, tool: ToolConnection["tool"], enabled: boolean): ToolConnection => ({ id, tool, label: tool, authMode: "subscription", separateAccount: false, enabled })
const server = (name: string): McpServer => ({ name, command: "npx", args: [name], env: [] }) as unknown as McpServer

beforeEach(() => {
  setHost(createFakeHost())
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
})

describe("onboarding: coding tools", () => {
  test("lists installed tools in Runrail's order; a tool starts on as its connection is, else when signed in", () => {
    const found = [tool("codex", { signedIn: false, version: "0.48.0" }), tool("claude-code", { signedIn: true }), tool("pi"), tool("goose", { available: false })]
    const choices = toolChoices(found, [connection("c1", "pi", true)])
    expect(choices.map((choice) => [choice.tool, choice.on])).toEqual([
      ["claude-code", true],
      ["codex", false],
      ["pi", true],
    ])
    expect(choices[1]).toMatchObject({ version: "0.48.0", signedIn: false })
    expect(missingTools(found)).toEqual(["copilot", "opencode", "gemini", "goose"])
  })

  test("a second account of a tool is not the one onboarding turns on or off", () => {
    const separate = { ...connection("c2", "codex", true), separateAccount: true }
    expect(toolChoices([tool("codex", { signedIn: true })], [separate])[0]?.connection).toBeUndefined()
  })

  test("plan limits are offered only while Claude Code or Codex is on", () => {
    const choices = toolChoices([tool("claude-code"), tool("pi")], [])
    expect(offersLimits(choices, new Set(["pi"]))).toBe(false)
    expect(offersLimits(choices, new Set(["claude-code"]))).toBe(true)
  })

  test("applying adds a connection for a tool turned on, turns one off, and starts new threads on the first", async () => {
    const before = (await listConnectionSettings())?.tools ?? []
    const choices = toolChoices([tool("claude-code", { signedIn: true }), tool("codex", { signedIn: true })], before)
    await applyTools(choices, new Set(["claude-code"]))
    const listing = await listConnectionSettings()
    const claude = listing?.tools.find((item) => item.tool === "claude-code" && !item.separateAccount)
    expect(claude?.enabled).toBe(true)
    expect(listing?.tools.some((item) => item.tool === "codex" && item.enabled)).toBe(false)
    expect(get().prefs.defaultToolConnectionId === claude?.id || get().prefs.defaultBackend === "claude-code").toBe(true)

    const again = toolChoices([tool("claude-code", { signedIn: true })], listing?.tools ?? [])
    await applyTools(again, new Set())
    expect((await listConnectionSettings())?.tools.find((item) => item.id === claude?.id)?.enabled).toBe(false)
  })
})

describe("onboarding: bring your setup", () => {
  const scan = (fields: Partial<OtherTools>): OtherTools => ({ instructions: [], skills: [], servers: [], agents: [], ...fields })

  test("offers global servers and instructions; a taken or project server cannot be picked; skills only count", () => {
    const found = setupFound(
      scan({
        servers: [
          { tool: "claude-code", scope: "global", place: "~/.claude.json", server: server("github"), original: "github", leftOut: [] },
          { tool: "codex", scope: "global", place: "~/.codex/config.toml", server: server("linear"), original: "linear", leftOut: [] },
          { tool: "codex", scope: "project", place: "app/.mcp.json", server: server("db"), original: "db", leftOut: [] },
          { tool: "claude-code", scope: "global", place: "~/.claude.json", original: "broken", leftOut: ["it needs a Windows path"] },
        ],
        instructions: [
          { tool: "claude-code", scope: "global", place: "~/.claude/CLAUDE.md", text: "Use bun." },
          { tool: "codex", scope: "project", place: "app/AGENTS.md", text: "Project only." },
        ],
        skills: [{ tool: "claude-code", name: "release", path: "/s", place: "~" }],
      }),
      [server("linear")],
    )
    expect(found.servers.map((item) => [item.name, item.server !== undefined, item.blocked])).toEqual([
      ["github", true, undefined],
      ["linear", false, "Already in Runrail"],
      ["db", false, "it belongs to a project; open that project first"],
      ["broken", false, "it needs a Windows path"],
    ])
    expect(found.instructions.map((item) => item.place)).toEqual(["~/.claude/CLAUDE.md"])
    expect(found).toMatchObject({ skills: 1, agents: 0 })
    expect([...initialPicks(found)]).toEqual([found.servers[0]!.key])
    expect(hasSetup(found)).toBe(true)
    expect(hasSetup(setupFound(scan({ skills: [{ tool: "pi", name: "x", path: "/x", place: "~" }] }), []))).toBe(false)
  })

  test("bringing over adds the picked servers and puts picked instructions under the person's own", async () => {
    setPrefs({ instructions: "Mine first." })
    const found = setupFound(
      scan({
        servers: [{ tool: "claude-code", scope: "global", place: "~/.claude.json", server: server("onboarding-test"), original: "onboarding-test", leftOut: [] }],
        instructions: [{ tool: "claude-code", scope: "global", place: "~/.claude/CLAUDE.md", text: "Use bun." }],
      }),
      [],
    )
    const done = await bringOver(found, new Set([found.servers[0]!.key, found.instructions[0]!.key]))
    expect(done).toEqual({ servers: 1, instructions: 1 })
    expect((await getHost().mcpList()).some((item) => item.name === "onboarding-test")).toBe(true)
    expect(get().prefs.instructions).toContain("Mine first.")
    expect(get().prefs.instructions).toContain("Use bun.")
  })
})
