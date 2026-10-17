import { beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { initEngines } from "../src/app/engines"
import { syncAllSources, useMemory } from "../src/app/memory"
import { defaultState } from "../src/app/persist"
import { initStayRunning, wokenReasons } from "../src/app/stayRunning"
import { addProject, set } from "../src/app/store"
import { useUpcoming } from "../src/app/workflowRuns"
import { setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Run after Quit: a launch the wake service opened does the work due, then quits. */

setDefaultTimeout(20_000)

let holds: string[][] = []
let synced: string[] = []
let background: ((hidden: boolean, tray: boolean) => void) | undefined
let stop: () => void = () => undefined

const HOUR = 60 * 60_000
const source = (id: string, scope: "project" | "person", syncedAt?: number) => ({ id, kind: "folder", scope, name: id, target: `/notes/${id}`, addedAt: 1, entries: 0, ...(syncedAt === undefined ? {} : { lastSync: { at: syncedAt, ok: true, added: 0, removed: 0, kept: 0 } }) })

function use(woken: boolean): void {
  stop()
  holds = []
  synced = []
  const host = createFakeHost()
  const wrapped: Host = {
    ...host,
    launchWoken: async () => woken,
    backgroundHold: async (reasons) => {
      holds.push([...reasons])
    },
    onBackground: (listener) => {
      background = listener
      return () => undefined
    },
    rpc: async (engineId, method, params) => {
      if (method === "memory.source.list") return { sources: [source("shared", "person"), source("fresh", "project", Date.now()), source("old", "project", Date.now() - 2 * HOUR)] }
      if (method === "memory.source.sync") {
        synced.push(String((params as { id: string }).id))
        return source(String((params as { id: string }).id), "project", Date.now())
      }
      return host.rpc(engineId, method, params)
    },
  }
  setHost(wrapped)
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  useMemory.setState({ byProject: {}, suggestions: {}, syncing: {} }, true)
  useUpcoming.setState({ upcoming: { armed: 1 } }, true)
  stop = initEngines()
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

beforeEach(() => use(false))

test("only work under way keeps a woken launch; a schedule to come and hourly sources do not", () => {
  expect(wokenReasons(["turn", "workflow-run", "schedule", "memory-sync", "limit-wait"], false)).toEqual(["turn", "workflow-run", "limit-wait"])
  expect(wokenReasons(["schedule", "memory-sync"], false)).toEqual([])
  expect(wokenReasons(["schedule"], true)).toEqual(["memory-sync"])
})

test("a woken launch syncs each stale source once, across every project", async () => {
  addProject({ id: "p1", path: "/code/one", name: "one", git: true, addedAt: 1 })
  addProject({ id: "p2", path: "/code/two", name: "two", git: true, addedAt: 2 })
  await syncAllSources(["p1", "p2"])
  await until(() => synced.length >= 2)
  // "shared" is the person's: both projects list it, and it syncs once.
  expect(synced.sort()).toEqual(["old", "shared"])
})

test("woken, the app lets a pending schedule go until the person opens the window", async () => {
  use(true)
  initStayRunning()
  await until(() => holds.length > 0 && !holds[holds.length - 1]!.includes("schedule"))
  expect(holds[holds.length - 1]).toEqual([])
  background?.(false, true)
  await until(() => holds[holds.length - 1]!.includes("schedule"))
})
