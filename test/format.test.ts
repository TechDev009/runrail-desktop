import { expect, test } from "bun:test"
import { firstLine, plainText } from "../src/lib/format"

test("plainText flattens inline markdown for previews", () => {
  expect(plainText("Done. `parseSession` now **skips** blank lines, see [docs](https://x.test).")).toBe("Done. parseSession now skips blank lines, see docs.")
})

test("plainText drops code fences and list markers", () => {
  expect(plainText("## Summary\n- one\n- two\n```ts\nconst a = 1\n```\nend")).toBe("Summary one two end")
})

test("plainText drops tables", () => {
  expect(plainText("Before\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter")).toBe("Before After")
})

test("firstLine bounds long text", () => {
  expect(firstLine("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`)
})
