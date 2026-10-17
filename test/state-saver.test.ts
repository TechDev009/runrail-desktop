import { expect, test } from "bun:test"
import { createStateSaver } from "../src/app/stateSaver"

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
