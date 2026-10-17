import { describe, expect, test } from "bun:test"
import { grantOf, integrationsFor, roleOfThread, roleRestricted } from "../src/app/integrations"
import { parseState } from "../src/app/persist"

describe("who may use what", () => {
  test("planners and reviewers read, executors and the person's own threads write, until the person changes it", () => {
    expect(grantOf({}, "planner", "github")).toBe("read")
    expect(grantOf({}, "reviewer", "mcp:docs")).toBe("read")
    expect(grantOf({}, "executor", "slack")).toBe("write")
    expect(grantOf({}, "threads", "jira")).toBe("write")
    expect(grantOf({ reviewer: { github: "ask" } }, "reviewer", "github")).toBe("ask")
  })

  test("a thread's engine is told every grant that is not Write, MCP servers included; nothing when all are Write", () => {
    expect(integrationsFor({}, "threads", ["docs"])).toBeUndefined()
    expect(integrationsFor({ threads: { slack: "off" } }, "threads", ["docs"])).toEqual({ slack: "off" })
    expect(integrationsFor({ planner: { linear: "off", "mcp:docs": "write" } }, "planner", ["docs", "db"])).toEqual({ github: "read", linear: "off", slack: "read", jira: "read", "mcp:db": "read" })
  })

  test("which role a thread plays, and whether its launch needs the MCP list at all", () => {
    expect(roleOfThread({})).toBe("threads")
    expect(roleOfThread({ setup: { runId: "r", role: "executor" } })).toBe("executor")
    expect(roleOfThread({ review: { owner: "o", repo: "r", number: 1 } as never })).toBe("reviewer")
    expect(roleRestricted({}, "threads")).toBe(false)
    expect(roleRestricted({ threads: { slack: "ask" } }, "threads")).toBe(true)
    expect(roleRestricted({}, "planner")).toBe(true)
  })

  test("saved grants read back; a role, key or level the app does not know drops the whole map, not the prefs", () => {
    const prefsOf = (prefs: Record<string, unknown>) => parseState({ version: 1, projects: [], threads: [], prefs, layout: {} }).prefs
    expect(prefsOf({ integrationGrants: { planner: { github: "ask", "mcp:docs": "off" } } }).integrationGrants).toEqual({ planner: { github: "ask", "mcp:docs": "off" } })
    expect(prefsOf({ integrationGrants: { planner: { github: "admin" } } }).integrationGrants).toEqual({})
    expect(prefsOf({}).integrationGrants).toEqual({})
  })
})
