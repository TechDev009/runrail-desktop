import { expect, test } from "bun:test"
import { shownFile } from "../src/app/catalog"

test("Files leaves out git's data and the project's .runrail folder, and nothing else", () => {
  expect([".runrail", ".runrail/native/state.json", ".runrail/attachments/a.png", ".git", "packages/app/.git/HEAD"].filter(shownFile)).toEqual([])
  expect(["src/index.ts", ".github/workflows/ci.yml", "docs/.runrail-notes.md", "packages/app/.runrail/config.json", ".env.example"].every(shownFile)).toBe(true)
})
