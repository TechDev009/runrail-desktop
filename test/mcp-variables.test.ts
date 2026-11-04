import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { systemRpc } from "../src/app/connections"
import { initEngines } from "../src/app/engines"
import { applyMcpVariables, listMcpVariables, mcpFailureText, removeMcpServer, saveMcpServer, variableNames } from "../src/app/mcp"
import { defaultState } from "../src/app/persist"
import { addProject, set } from "../src/app/store"
import { getHost, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Values a person keeps for the variables an MCP server names: the engine holds them, the window never reads them back. */

setDefaultTimeout(20_000)

let stop: () => void = () => undefined

beforeEach(() => {
  stop()
  setHost(createFakeHost({}))
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  stop = initEngines()
})

describe("variable names a server asks for", () => {
  test("a program names its environment, an address its token variable", () => {
    expect(variableNames({ env: ["A_KEY", "B_KEY", "A_KEY"] })).toEqual(["A_KEY", "B_KEY"])
    expect(variableNames({ url: "https://mcp.example.com/mcp", env: [], bearerEnv: "API_TOKEN" })).toEqual(["API_TOKEN"])
    expect(variableNames({ url: "https://mcp.example.com/mcp", env: [] })).toEqual([])
  })

  test("a name that is not a variable name is dropped", () => {
    expect(variableNames({ env: ["OK", "has space", "1BAD", "A=b", ""] })).toEqual(["OK"])
  })

  test("a missing token points at both ways to supply it", () => {
    expect(mcpFailureText("MCP_TOKEN_MISSING")).toContain("Edit the server")
  })
})

describe("keeping and forgetting values", () => {
  const server = { name: "db", command: "db-mcp", args: [], env: ["DB_TOKEN", "OTHER"], enabled: true }

  test("a kept value is reported by name, never by value, and can be forgotten", async () => {
    await saveMcpServer(server)
    expect([...(await listMcpVariables("db", ["DB_TOKEN", "OTHER"]))]).toEqual([])
    await applyMcpVariables("db", { DB_TOKEN: "lin_secret" })
    expect([...(await listMcpVariables("db", ["DB_TOKEN", "OTHER"]))]).toEqual(["DB_TOKEN"])
    await applyMcpVariables("db", {}, ["DB_TOKEN"])
    expect([...(await listMcpVariables("db", ["DB_TOKEN", "OTHER"]))]).toEqual([])
  })

  test("values are kept per server", async () => {
    await applyMcpVariables("db", { DB_TOKEN: "x" })
    expect([...(await listMcpVariables("other", ["DB_TOKEN"]))]).toEqual([])
  })

  test("removing a server forgets its kept values", async () => {
    await saveMcpServer(server)
    await applyMcpVariables("db", { DB_TOKEN: "x" })
    await removeMcpServer("db")
    expect([...(await listMcpVariables("db", ["DB_TOKEN"]))]).toEqual([])
  })

  test("the window cannot ask the engine for a value, or send one as a call", async () => {
    const host = getHost()
    await expect(systemRpc("auth.mcp.variable.get", { server: "db", names: ["DB_TOKEN"] })).rejects.toBeDefined()
    await expect(host.connectionSecretSet("mcp-var:Bad:NAME", "x", "mcp-variable")).rejects.toBeDefined()
  })
})
