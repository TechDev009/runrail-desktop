import { describe, expect, test } from "bun:test"
import { cleanWindows, windowKey } from "../src/app/contextWindows"
import { cleanLimits, currentLimits } from "../src/app/limits"
import { cleanReadings, forgetContext, rememberContext, rememberedContext } from "../src/app/threadContext"
import { joinArgs, mcpFailureText, splitArgs } from "../src/app/mcp"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline } from "../src/thread/reducer"
import { parseDraft } from "../src/ui/shell/McpSettings"

import { contextSentence, readContext } from "../src/ui/thread/ContextRing"
import { NoticeRow } from "../src/ui/thread/rows"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

function draft(fields: Partial<Parameters<typeof parseDraft>[0]>): Parameters<typeof parseDraft>[0] {
  return { name: "", transport: "program", commandLine: "", env: "", url: "", bearerEnv: "", scope: "all", ...fields }
}

let liveSeq = 0
function usage(fields: Record<string, unknown>): StreamFrame {
  liveSeq += 1
  return { kind: "live", data: { version: 1, sessionId: "s", liveSeq, at: liveSeq, type: "context.usage", ...fields } }
}

describe("context ring", () => {
  test("a usage frame updates the count, keeps the window it last learned, and a malformed one is dropped", () => {
    let timeline = applyFrames(emptyTimeline(), [usage({ usedTokens: 10_000, windowTokens: 200_000, estimated: false })])
    expect(timeline.context).toEqual({ usedTokens: 10_000, windowTokens: 200_000, estimated: false })
    timeline = applyFrames(timeline, [usage({ usedTokens: 50_000, estimated: true })])
    expect(timeline.context).toEqual({ usedTokens: 50_000, windowTokens: 200_000, estimated: true })
    timeline = applyFrames(timeline, [usage({ usedTokens: -5, estimated: false })])
    expect(timeline.context).toEqual({ usedTokens: 50_000, windowTokens: 200_000, estimated: true })
    expect(timeline.counters.rejected).toBe(1)
  })

  test("reads against the engine's window, else the model's listing, and never past full", () => {
    expect(readContext({ usedTokens: 50_000, windowTokens: 200_000, estimated: false }, 1_000_000)).toEqual({ used: 50_000, window: 200_000, share: 0.25, estimated: false })
    expect(readContext({ usedTokens: 50_000, estimated: true }, 100_000)?.share).toBe(0.5)
    expect(readContext({ usedTokens: 300_000, windowTokens: 200_000, estimated: false }, undefined)?.share).toBe(1)
    expect(readContext({ usedTokens: 50_000, estimated: false }, undefined)).toBeUndefined()
    expect(readContext(undefined, 200_000)).toEqual({ used: 0, window: 200_000, share: 0, estimated: false })
    expect(readContext(undefined, undefined)).toBeUndefined()
  })

  test("a model's last reported window is kept by tool and model, and junk is dropped", () => {
    expect(windowKey("claude-code", undefined)).toBe("claude-code:default")
    expect(windowKey("codex", "gpt-5.5")).toBe("codex:gpt-5.5")
    expect(cleanWindows({ "codex:gpt-5.5": 272_000, negative: -1, text: "200000", huge: 1e12 })).toEqual({ "codex:gpt-5.5": 272_000 })
    expect(cleanWindows([200_000])).toEqual({})
    expect(Object.keys(cleanWindows(Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`m${String(index)}`, 1_000]))))).toHaveLength(64)
  })

  test("always shows the share used", () => {
    const reading = { used: 84_000, window: 200_000, share: 0.42, estimated: false }
    expect(contextSentence(reading, "used")).toBe("42% used")
    expect(contextSentence(reading, "near-full")).toBe("42% used")
  })

  test("a thread's last reading outlives the live frame that brought it, and junk is dropped", () => {
    rememberContext("t1", { usedTokens: 84_000, windowTokens: 200_000, estimated: false })
    expect(rememberedContext("t1")).toEqual({ usedTokens: 84_000, windowTokens: 200_000, estimated: false })
    forgetContext("t1")
    expect(rememberedContext("t1")).toBeUndefined()
    expect(cleanReadings({ ok: { usedTokens: 10, estimated: true }, noWindow: { usedTokens: 5, windowTokens: 0 }, text: { usedTokens: "10" }, list: [1] })).toEqual({ ok: { usedTokens: 10, estimated: true } })
    expect(Object.keys(cleanReadings(Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`t${String(index)}`, { usedTokens: 1 }]))))).toHaveLength(200)
  })

  test("the auto-compact point is kept from a full read while the window stays, and dropped when it changes", () => {
    let timeline = applyFrames(emptyTimeline(), [usage({ usedTokens: 20_000, windowTokens: 200_000, autoCompactAt: 167_000, estimated: true })])
    expect(timeline.context).toEqual({ usedTokens: 20_000, windowTokens: 200_000, autoCompactAt: 167_000, estimated: true })
    // A turn's own reports name no point.
    timeline = applyFrames(timeline, [usage({ usedTokens: 30_000, estimated: false })])
    expect(timeline.context?.autoCompactAt).toBe(167_000)
    timeline = applyFrames(timeline, [usage({ usedTokens: 30_000, windowTokens: 1_000_000, estimated: false })])
    expect(timeline.context).toEqual({ usedTokens: 30_000, windowTokens: 1_000_000, estimated: false })
    expect(cleanReadings({ a: { usedTokens: 1, windowTokens: 10, autoCompactAt: 8 }, b: { usedTokens: 1, autoCompactAt: 0 } })).toEqual({ a: { usedTokens: 1, windowTokens: 10, autoCompactAt: 8, estimated: false }, b: { usedTokens: 1, estimated: false } })
  })

  test("the mark sits at the auto-compact point, and only below the window", () => {
    expect(readContext({ usedTokens: 50_000, windowTokens: 200_000, autoCompactAt: 167_000, estimated: false }, undefined)?.autoCompact).toBe(0.835)
    expect(readContext({ usedTokens: 50_000, windowTokens: 200_000, autoCompactAt: 200_000, estimated: false }, undefined)?.autoCompact).toBeUndefined()
    expect(readContext({ usedTokens: 50_000, windowTokens: 200_000, estimated: false }, undefined)?.autoCompact).toBeUndefined()
  })

  test("a compaction leaves a notice with its sizes and whether the tool did it on its own", () => {
    const compacted = (seq: number, fields: Record<string, unknown>): StreamFrame => ({ kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type: "memory.compacted", ...fields } })
    const timeline = applyFrames(emptyTimeline(), [
      compacted(1, { before: 50_000, after: 14_000, reason: "manual" }),
      compacted(2, { before: 168_000, after: 6_000, reason: "threshold" }),
      compacted(3, { before: 0, after: 0, reason: "manual" }),
    ])
    expect(timeline.items.map((item) => (item.kind === "notice" ? [item.name, item.sizes] : undefined))).toEqual([
      ["manual", { before: 50_000, after: 14_000 }],
      ["threshold", { before: 168_000, after: 6_000 }],
      ["manual", undefined],
    ])
    const copy = timeline.items.map((item) => (item.kind === "notice" ? renderToStaticMarkup(createElement(NoticeRow, { item, threadId: "t" })).replace(/<[^>]+>/g, "") : ""))
    expect(copy).toEqual(["Context compacted: 50K to 14K tokens.", "Context was nearly full, so it was compacted: 168K to 6K tokens.", "Context compacted to make room for more work."])
  })
})

describe("plan limits", () => {
  const now = 1_800_000_000_000
  const window = <Id extends string>(id: Id, usedPercent: number, resetsAt?: number) => ({ id, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) })

  test("a kept reading shows only the windows that have not reset since, and nothing once a week old", () => {
    const limits = { windows: [window("five-hour", 34, now - 1), window("weekly", 12, now + 60_000)], at: now - 60_000 } as Parameters<typeof currentLimits>[0]
    expect(currentLimits(limits, now)?.windows.map((item) => item.id)).toEqual(["weekly"])
    expect(currentLimits({ windows: [window("five-hour", 34, now - 1)], at: now } as Parameters<typeof currentLimits>[0], now)).toBeUndefined()
    expect(currentLimits({ windows: [window("weekly", 12)], at: now - 8 * 24 * 60 * 60_000 } as Parameters<typeof currentLimits>[0], now)).toBeUndefined()
  })

  test("a stored reading is checked like a live frame", () => {
    expect(cleanLimits({ "claude-code": { windows: [window("weekly", 12)], at: now }, codex: { windows: [window("bogus", 5)], at: now }, other: { windows: [], at: now } })).toEqual({ "claude-code": { windows: [window("weekly", 12)], at: now } })
    expect(cleanLimits({ codex: { windows: [window("weekly", 12)], at: "now" } })).toEqual({})
  })
})

describe("MCP server form", () => {
  test("a command line splits like a shell's plain words and quotes, and joins back", () => {
    expect(splitArgs(`npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Notes" ''`)).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/My Notes", ""])
    expect(splitArgs("  uvx   mcp-server-git  ")).toEqual(["uvx", "mcp-server-git"])
    const args = ["npx", "-y", "server", "/Users/me/My Notes"]
    expect(splitArgs(joinArgs(args))).toEqual(args)
  })

  test("a draft becomes a server, or says what is wrong with it", () => {
    expect(parseDraft(draft({ name: "github", commandLine: "npx -y @modelcontextprotocol/server-github", env: "GITHUB_TOKEN, OTHER" }), true)).toEqual({ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN", "OTHER"], enabled: true })
    expect(parseDraft(draft({ name: "GitHub", commandLine: "npx" }), true)).toContain("Name")
    expect(parseDraft(draft({ name: "gh", commandLine: "   " }), true)).toContain("command")
    expect(parseDraft(draft({ name: "gh", commandLine: "--help" }), true)).toContain("program")
    // A value pasted where a name belongs is refused, so it is never saved.
    const pasted = parseDraft(draft({ name: "gh", commandLine: "npx", env: "GITHUB_TOKEN=ghp_secret" }), true)
    expect(pasted).toContain("names only")
    expect(pasted).not.toContain("ghp_secret")
  })

  test("a remote server takes an https address and a token variable's name, never the token", () => {
    expect(parseDraft(draft({ name: "linear", transport: "address", url: "https://mcp.linear.app/mcp", bearerEnv: "LINEAR_API_KEY" }), true)).toEqual({ name: "linear", command: "", args: [], env: [], url: "https://mcp.linear.app/mcp", bearerEnv: "LINEAR_API_KEY", enabled: true })
    expect(parseDraft(draft({ name: "local", transport: "address", url: "http://127.0.0.1:8931/mcp" }), false)).toEqual({ name: "local", command: "", args: [], env: [], url: "http://127.0.0.1:8931/mcp", enabled: false })
    for (const url of ["http://mcp.example.com/mcp", "https://user:pw@mcp.example.com/mcp", "ftp://mcp.example.com", "mcp.example.com"]) expect(parseDraft(draft({ name: "x", transport: "address", url }), true)).toContain("Address")
    const token = parseDraft(draft({ name: "x", transport: "address", url: "https://mcp.example.com/mcp", bearerEnv: "lin_api_secretvalue=1" }), true)
    expect(token).toContain("name only")
    expect(token).not.toContain("secretvalue")
  })

  test("a server can be kept for one project", () => {
    expect(parseDraft(draft({ name: "db", commandLine: "db-mcp", scope: "/code/app" }), true)).toEqual({ name: "db", command: "db-mcp", args: [], env: [], project: "/code/app", enabled: true })
  })

  test("a failure reads as what went wrong, from its stable code", () => {
    expect(mcpFailureText("MCP_TRANSPORT_FAILED")).toContain("did not start")
    expect(mcpFailureText("SOMETHING_NEW")).toBe("It did not start.")
    expect(mcpFailureText(undefined)).toBe("It did not start.")
  })
})

describe("native context menus", () => {
  test("keep plain-text entries, drop leading, trailing, and doubled separators", async () => {
    const { nativeItems } = await import("../src/lib/contextMenu")
    const noop = (): void => undefined
    const items = nativeItems([
      { id: "lead", separator: true },
      { id: "rename", label: "Rename", onSelect: noop },
      { id: "a", separator: true },
      { id: "b", separator: true },
      { id: "rich", label: { not: "text" }, onSelect: noop },
      { id: "delete", label: "Delete", danger: true, onSelect: noop },
      { id: "tail", separator: true },
    ])
    expect(items.map((item) => item.id)).toEqual(["rename", "a", "delete"])
    expect(items[2]).toMatchObject({ danger: true })
  })
})
