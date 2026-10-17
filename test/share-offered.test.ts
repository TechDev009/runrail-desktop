import { expect, test } from "bun:test"
import { shareOffered } from "../src/app/workflows"

test("Share is offered only in developer mode while no transport carries a share anywhere", () => {
  expect(shareOffered(false)).toBe(false)
  expect(shareOffered(true)).toBe(true)
})
