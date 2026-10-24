import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { heldWords, persistChanges } from "../src/app/boot"
import { defaultState, loadState } from "../src/app/persist"
import { createStateSaver, warnOnFailure } from "../src/app/stateSaver"
import { addProject, get, set } from "../src/app/store"
import { getHost, HostError, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Longer than the save delay, so a save that was going to happen has. */
const SETTLE_MS = 450

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

test("saves run one at a time, a failed one is tried again, and a flush waits for the write", async () => {
  let state = "a"
  const written: string[] = []
  let running = 0
  let overlapped = false
  let failNext = false
  const failures: number[] = []
  const saver = createStateSaver({
    read: () => state,
    write: async (text) => {
      running += 1
      if (running > 1) overlapped = true
      await Bun.sleep(5)
      running -= 1
      if (failNext) {
        failNext = false
        throw new Error("disk full")
      }
      written.push(text)
    },
    failed: (_error, attempt) => failures.push(attempt),
    delayMs: 5,
  })
  state = "b"
  failNext = true
  await saver.flush()
  expect(written).toEqual([])
  expect(failures).toEqual([1])
  await until(() => written.length > 0)
  expect(written).toEqual(["b"])
  state = "c"
  saver.changed()
  state = "d"
  await Promise.all([saver.flush(), saver.flush()])
  expect(written).toEqual(["b", "d"])
  expect(overlapped).toBe(false)
})

describe("saving while saves keep failing", () => {
  test("the person is told at the first failure, then again every so often, not only once", () => {
    const told = Array.from({ length: 30 }, (_, index) => index + 1).filter(warnOnFailure)
    expect(told).toEqual([1, 10, 20, 30])
  })
})

describe("saved state that could not be read", () => {
  let saved: unknown[] = []
  let quitting: (() => Promise<void>)[] = []
  let stop: () => void = () => undefined

  afterEach(() => {
    stop()
    stop = () => undefined
  })

  beforeEach(() => {
    saved = []
    quitting = []
    const host = createFakeHost()
    setHost({
      ...host,
      stateSave: async (value) => {
        saved.push(value)
      },
      onQuit: (save) => {
        quitting.push(save)
        return () => undefined
      },
    })
    set({ ...defaultState(), toasts: [] })
  })

  test("is told apart from no saved state at all, and from state this version writes", async () => {
    const project = { id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }
    expect(await loadState(async () => null)).toEqual({ state: defaultState() })
    expect((await loadState(async () => ({ version: 1, projects: [project] }))).state.projects).toEqual([project])
    expect(await loadState(async () => ({ version: 2, projects: [project] }))).toEqual({ state: defaultState(), problem: "unknown-version" })
    expect(await loadState(async () => [project])).toEqual({ state: defaultState(), problem: "unreadable" })
    expect(
      await loadState(async () => {
        throw new HostError("STATE_UNAVAILABLE", "desktop state could not be read")
      }),
    ).toEqual({ state: defaultState(), problem: "unreadable", message: "desktop state could not be read" })
  })

  test("is never saved over in that session; the first change says so once, and quitting is not held up", async () => {
    const saving = persistChanges("unknown-version")
    stop = saving.stop
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    set((state) => ({ prefs: { ...state.prefs, theme: "dark" } }))
    await saving.flush()
    await Promise.all(quitting.map((save) => save()))
    await Bun.sleep(SETTLE_MS)
    expect(saved).toEqual([])
    expect(get().toasts.map((toast) => toast.text)).toEqual([heldWords("unknown-version")])
    expect(quitting).toHaveLength(1)
  })

  test("read state is saved as it changes, and saved on quit", async () => {
    const saving = persistChanges(undefined)
    stop = saving.stop
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    await Promise.all(quitting.map((save) => save()))
    expect(saved).toHaveLength(1)
    expect((saved[0] as { projects: unknown[] }).projects).toHaveLength(1)
  })

  test("a state too large to save says what to do about it", async () => {
    let tooLarge = true
    getHost().stateSave = async () => {
      if (!tooLarge) return
      tooLarge = false
      throw new HostError("STATE_LIMIT", "desktop state is too large")
    }
    const saving = persistChanges(undefined)
    stop = saving.stop
    addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
    await saving.flush()
    expect(get().toasts.map((toast) => toast.text)).toEqual(["Could not save state: there is too much to save. Delete archived threads you no longer need."])
  })
})
