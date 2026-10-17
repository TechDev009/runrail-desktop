import { expect, test } from "bun:test"
import { createFakeHost } from "../src/host/fakeHost"
import { WorkspaceReadSchema, WorkspaceWriteSchema, parseOr } from "../src/protocol/schemas"

/** Editing in the Files pane: a save goes only over the text that was opened. */

async function engine() {
  const host = createFakeHost({})
  const info = await host.engineStart({ engineId: "e1", workspace: "/code/app", backend: "native", sessionId: "t1" })
  return { host, engineId: info.engineId }
}

test("a save over the text that was opened goes through, and its hash is the next base", async () => {
  const { host, engineId } = await engine()
  const read = parseOr(WorkspaceReadSchema, await host.rpc(engineId, "workspace.read", { path: "src/parser.ts" }))
  expect(read?.hash).toMatch(/^[0-9a-f]{64}$/)
  const saved = parseOr(WorkspaceWriteSchema, await host.rpc(engineId, "workspace.write", { path: "src/parser.ts", content: "// mine\n", baseHash: read?.hash }))
  expect(saved).toMatchObject({ path: "src/parser.ts", bytes: 8 })
  const again = parseOr(WorkspaceReadSchema, await host.rpc(engineId, "workspace.read", { path: "src/parser.ts" }))
  expect(again).toMatchObject({ content: "// mine\n", hash: saved?.hash })
})

test("a file the agent changed since it was opened answers a conflict", async () => {
  const { host, engineId } = await engine()
  const read = parseOr(WorkspaceReadSchema, await host.rpc(engineId, "workspace.read", { path: "src/parser.ts" }))
  await expect(host.rpc(engineId, "workspace.write", { path: "src/parser.ts", content: "x", baseHash: "0".repeat(64) })).rejects.toMatchObject({ code: "CONTROL_WORKSPACE_CONFLICT" })
  expect(parseOr(WorkspaceReadSchema, await host.rpc(engineId, "workspace.read", { path: "src/parser.ts" }))?.content).toBe(read?.content)
})

test("an answer without a valid hash is not taken as a save", () => {
  expect(parseOr(WorkspaceWriteSchema, { path: "a.ts", bytes: 1, hash: "nope" })).toBeUndefined()
  expect(parseOr(WorkspaceReadSchema, { path: "a.ts", content: "x" })?.hash).toBeUndefined()
})
