import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expandPastes, nextPasteId, pastePlaceholder, shouldFold } from "../src/app/paste"
import { behaviorFor, DEFAULT_PREFS, parseState, withShell } from "../src/app/persist"
import { setPlanLimits } from "../src/app/planUsage"
import { get, setPrefs } from "../src/app/store"
import { SETTINGS_INDEX } from "../src/ui/shell/settingsIndex"
import type { ImportableConnection } from "../src/protocol/schemas"
import { importAction } from "../src/ui/shell/ImportSettings"
import { parseAgentDraft } from "../src/ui/shell/SubagentSettings"

function prefsOf(prefs: Record<string, unknown>) {
  return parseState({ version: 1, projects: [], threads: [], prefs, layout: {} }).prefs
}

describe("long pastes", () => {
  test("fold past the threshold, never at 0, and go out in full", () => {
    const long = "line\n".repeat(300)
    expect(shouldFold(long, 1_000)).toBe(true)
    expect(shouldFold(long, 0)).toBe(false)
    expect(shouldFold("short", 1_000)).toBe(false)
    const block = { id: 1, text: long }
    expect(pastePlaceholder(block)).toBe("[Pasted text #1, 301 lines]")
    expect(pastePlaceholder({ id: 2, text: "one" })).toBe("[Pasted text #2, 1 line]")
    const draft = `Review this:\n${pastePlaceholder(block)}\nThanks`
    expect(expandPastes(draft, [block])).toBe(`Review this:\n${long}\nThanks`)
    // A placeholder the person deleted drops its paste.
    expect(expandPastes("Just this", [block])).toBe("Just this")
    expect(nextPasteId([block, { id: 4, text: "x" }])).toBe(5)
    expect(nextPasteId([])).toBe(1)
  })
})

describe("new preferences", () => {
  test("thread timestamps are opt-in and survive saved preferences", () => {
    expect(DEFAULT_PREFS.showThreadTimestamps).toBe(false)
    expect(prefsOf({}).showThreadTimestamps).toBe(false)
    expect(prefsOf({ showThreadTimestamps: true }).showThreadTimestamps).toBe(true)
    expect(prefsOf({ showThreadTimestamps: "true" }).showThreadTimestamps).toBe(false)
  })
  test("default to the old behavior and refuse values they do not know", () => {
    expect(prefsOf({})).toMatchObject({ keepAwake: false, uiFont: "system", codeFont: "sf-mono", fileLinks: "app", pasteThreshold: 5_000 })
    expect(prefsOf({}).terminalShell).toBeUndefined()
    expect(prefsOf({ keepAwake: true, uiFont: "rounded", codeFont: "menlo", fileLinks: "editor", pasteThreshold: 0, terminalShell: "/bin/zsh" })).toMatchObject({ keepAwake: true, uiFont: "rounded", codeFont: "menlo", fileLinks: "editor", pasteThreshold: 0, terminalShell: "/bin/zsh" })
    expect(prefsOf({ uiFont: "comic", codeFont: "papyrus", fileLinks: "web", pasteThreshold: 7, terminalShell: "zsh" })).toMatchObject({ uiFont: "system", codeFont: "sf-mono", fileLinks: "app", pasteThreshold: 5_000 })
    expect(prefsOf({ terminalShell: "zsh" }).terminalShell).toBeUndefined()
    expect(DEFAULT_PREFS.keepAwake).toBe(false)
  })

  test("plan limits wait to be asked and onboarding has not run, also for state saved before either existed", () => {
    expect(DEFAULT_PREFS).toMatchObject({ planLimits: "ask", onboarded: false })
    expect(prefsOf({ theme: "dark", continueAfterLimit: true })).toMatchObject({ theme: "dark", continueAfterLimit: true, planLimits: "ask", onboarded: false })
    expect(prefsOf({ planLimits: "on", onboarded: true })).toMatchObject({ planLimits: "on", onboarded: true })
    expect(prefsOf({ planLimits: "off" }).planLimits).toBe("off")
    expect(prefsOf({ planLimits: true, onboarded: "yes" })).toMatchObject({ planLimits: "ask", onboarded: false })
  })

  test("the terminal shell rides along with the behavior, and only when chosen", () => {
    const spec = behaviorFor("ask", "agent", "medium")
    expect(withShell(spec, undefined)).toBe(spec)
    expect(withShell(spec, "/bin/zsh").shell).toBe("/bin/zsh")
  })
})

describe("subagent drafts", () => {
  const base = { name: "reviewer", description: "Reviews diffs", tools: "Read, Grep", model: "sonnet", prompt: "Review." }
  test("become a definition, or say what is wrong", () => {
    expect(parseAgentDraft(base)).toEqual({ name: "reviewer", description: "Reviews diffs", tools: ["Read", "Grep"], model: "sonnet", prompt: "Review." })
    expect(parseAgentDraft({ ...base, tools: "", model: "" })).toEqual({ name: "reviewer", description: "Reviews diffs", tools: [], prompt: "Review." })
    expect(parseAgentDraft({ ...base, name: "Code Reviewer" })).toContain("Name")
    expect(parseAgentDraft({ ...base, description: "  " })).toContain("when the main agent")
    expect(parseAgentDraft({ ...base, tools: "rm -rf /" })).toContain("Tools")
  })
})

describe("providers from other tools", () => {
  const candidate = (fields: Partial<ImportableConnection>): ImportableConnection => ({ source: "codex", id: "x", name: "X", baseUrl: "https://example.com/v1", kind: "remote", models: [], ...fields })
  test("a known provider with its key in the shell is one click; anything else opens the key form", () => {
    expect(importAction(candidate({ kind: "preset", presetId: "openrouter", environmentName: "OPENROUTER_API_KEY", environmentSet: true })).kind).toBe("shell")
    expect(importAction(candidate({ kind: "preset", presetId: "openrouter", environmentName: "OPENROUTER_API_KEY", environmentSet: false }))).toMatchObject({ kind: "key", detail: expect.stringContaining("not set") })
    expect(importAction(candidate({ kind: "preset", presetId: "groq" })).kind).toBe("key")
    expect(importAction(candidate({ kind: "local", baseUrl: "http://localhost:11434/v1" })).kind).toBe("custom")
    expect(importAction(candidate({})).kind).toBe("custom")
  })
})

describe("show plan limits", () => {
  test("is a toggle in Agent that saves the answer; off is saved too, so it is not asked again", () => {
    expect(SETTINGS_INDEX.find((entry) => entry.id === "plan-limits")).toMatchObject({ section: "ai", label: "Show plan limits" })
    const source = readFileSync(resolve(import.meta.dir, "../src/ui/shell/Settings.tsx"), "utf8")
    const agent = source.slice(source.indexOf("function AgentSection("), source.indexOf("\nfunction ", source.indexOf("function AgentSection(")))
    expect(agent).toContain('id="plan-limits"')
    expect(agent).toContain('label="Show plan limits"')
    expect(agent).toContain('<Toggle label="Show plan limits" checked={prefs.planLimits === "on"} onChange={setPlanLimits} />')
    setPrefs({ planLimits: "ask" })
    setPlanLimits(false)
    expect(get().prefs.planLimits).toBe("off")
    setPrefs({ planLimits: "ask" })
  })
})
