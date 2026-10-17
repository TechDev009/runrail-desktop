import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CALLER_ADDRESS_KEYS, CALLER_ADDRESS_METHODS, CREDENTIAL_NAMESPACES, MAX_PARAM_NODES, RAW_CREDENTIAL_KEYS, SYSTEM_METHODS, SYSTEM_NAMESPACES, SYSTEM_ONLY_METHODS } from "../src/host/fakeConnections"

const rust = readFileSync(join(import.meta.dir, "../src-tauri/src/connections.rs"), "utf8")

function rustList(name: string): readonly string[] {
  const match = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`).exec(rust)
  if (match === null) throw new Error(`${name} is missing from connections.rs`)
  return [...(match[1] ?? "").matchAll(/"([^"]*)"/g)].map((item) => item[1] ?? "")
}

test("the browser preview's request guard makes the same decisions as the desktop host's", () => {
  expect([...RAW_CREDENTIAL_KEYS].sort()).toEqual([...rustList("RAW_CREDENTIAL_KEYS")].sort())
  expect([...CREDENTIAL_NAMESPACES].sort()).toEqual([...rustList("CREDENTIAL_NAMESPACES")].sort())
  expect([...SYSTEM_NAMESPACES].sort()).toEqual([...rustList("SYSTEM_NAMESPACES")].sort())
  expect([...SYSTEM_METHODS].sort()).toEqual([...rustList("SYSTEM_METHODS")].sort())
  expect([...SYSTEM_ONLY_METHODS].sort()).toEqual([...rustList("SYSTEM_ONLY_METHODS")].sort())
  expect([...CALLER_ADDRESS_METHODS].sort()).toEqual([...rustList("CALLER_ADDRESS_METHODS")].sort())
  expect([...CALLER_ADDRESS_KEYS].sort()).toEqual([...rustList("CALLER_ADDRESS_KEYS")].sort())
  expect(rust).toContain(`const MAX_PARAM_NODES: usize = ${MAX_PARAM_NODES.toLocaleString("en-US").replace(/,/g, "_")};`)
})
