import { expect, test } from "bun:test"
import { mentionOf } from "../src/ui/thread/Composer"

test("a mentioned path with a space stays one path", () => {
  expect(mentionOf("src/app.ts")).toBe("@src/app.ts")
  expect(mentionOf("docs/Release Notes.md")).toBe('@"docs/Release Notes.md"')
  expect(mentionOf('a "b" c')).toBe('@"a \\"b\\" c"')
})
