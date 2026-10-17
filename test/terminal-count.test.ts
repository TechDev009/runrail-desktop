import { expect, test } from "bun:test"
import { get, set } from "../src/app/store"
import { patchTermMeta, runningTerminalCount } from "../src/ui/inspector/terminalMeta"

test("only a terminal running a shell counts toward asking before an archive", () => {
  set({ layout: { ...get().layout, panels: { t1: { tabs: [{ id: "term-a", kind: "terminal" }, { id: "term-b", kind: "terminal" }, { id: "rev", kind: "review" }] } } } })
  patchTermMeta("term-a", { status: "running" })
  patchTermMeta("term-b", { status: "closed" })
  expect(runningTerminalCount("t1")).toBe(1)
  expect(runningTerminalCount("t2")).toBe(0)
})
