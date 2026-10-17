import { describe, expect, test } from "bun:test"
import { highlightedHtml, highlightHtml, langFor, tokenize } from "../src/lib/highlight"

describe("syntax highlighting off the window's thread", () => {
  test("a code block is highlighted once, then kept for the next time it is shown", async () => {
    const code = "const answer: number = 42"
    expect(highlightedHtml(code, "ts")).toBeUndefined()
    const first = highlightHtml(code, "ts")
    expect(highlightHtml(code, "ts")).toBe(first)
    const html = await first
    expect(html).toContain("var(--syn-")
    expect(html).toContain("answer")
    await Promise.resolve()
    expect(highlightedHtml(code, "typescript")).toBe(html)
  })

  test("diff lines come back as tokens", async () => {
    const tokens = await tokenize("let total = 1\ntotal += 2", "js")
    expect(tokens?.length).toBe(2)
    expect(tokens?.[0]?.map((token) => token.content).join("")).toBe("let total = 1")
  })

  test("an unknown language or an oversized block is left plain, without starting work", async () => {
    expect(langFor("no-such-language")).toBeUndefined()
    expect(await highlightHtml("x", "no-such-language")).toBeUndefined()
    expect(await highlightHtml("x".repeat(200 * 1024 + 1), "ts")).toBeUndefined()
    expect(highlightedHtml("x", "no-such-language")).toBeUndefined()
  })
})
