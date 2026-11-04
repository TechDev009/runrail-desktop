import { describe, expect, test } from "bun:test"
import { parseGeneratedScreen } from "../src/app/customScreenDesigner"
import { MAX_CUSTOM_SCREEN_BYTES } from "../src/app/persist"

describe("generated custom screens", () => {
  test("accepts the structured screen contract and a JSON fence", () => {
    const screen = { name: "Cockpit", icon: "workflow", html: "<main></main>", css: "main{display:grid}", javascript: "" } as const
    expect(parseGeneratedScreen(JSON.stringify(screen))).toEqual({ ok: true, screen })
    expect(parseGeneratedScreen(`\`\`\`json\n${JSON.stringify(screen)}\n\`\`\``)).toEqual({ ok: true, screen })
  })

  test("rejects malformed responses and unsupported fields", () => {
    expect(parseGeneratedScreen("not json").ok).toBe(false)
    expect(parseGeneratedScreen(JSON.stringify({ name: "Bad icon", icon: "terminal", html: "", css: "", javascript: "", extra: true })).ok).toBe(false)
  })

  test("rejects source whose UTF-8 size exceeds the runtime bound", () => {
    const tooLarge = { name: "Too large", icon: "code", html: "a".repeat(MAX_CUSTOM_SCREEN_BYTES), css: "é", javascript: "" }
    expect(parseGeneratedScreen(JSON.stringify(tooLarge)).ok).toBe(false)
  })
})
