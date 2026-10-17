import { expect, test } from "bun:test"
import { hostSetting } from "../src/app/power"

test("a host setting is sent one call at a time, ends at the latest wish, and is set again after a failure", async () => {
  const host: string[] = []
  let failNext = false
  let inFlight = 0
  let overlapped = false
  const set = hostSetting<string>("off", async (value: string) => {
    inFlight += 1
    if (inFlight > 1) overlapped = true
    await Bun.sleep(5)
    inFlight -= 1
    if (failNext) {
      failNext = false
      throw new Error("caffeinate failed")
    }
    host.push(value)
  }, 20)
  set("system")
  set("off")
  set("display")
  await Bun.sleep(30)
  expect(host.at(-1)).toBe("display")
  failNext = true
  set("off")
  await Bun.sleep(15)
  expect(host.at(-1)).toBe("display")
  await Bun.sleep(40)
  expect(host.at(-1)).toBe("off")
  expect(overlapped).toBe(false)
})

test("a workflow, setup or eval run going asks before quitting, like a turn", async () => {
  const { setHost } = await import("../src/host")
  const { createFakeHost } = await import("../src/host/fakeHost")
  const { guardRuns, initKeepAwake } = await import("../src/app/power")
  const asked: boolean[] = []
  setHost({ ...createFakeHost(), quitGuard: async (on: boolean) => void asked.push(on), keepAwake: async () => true })
  initKeepAwake()
  guardRuns(true)
  await Bun.sleep(5)
  expect(asked.at(-1)).toBe(true)
  guardRuns(false)
  await Bun.sleep(5)
  expect(asked.at(-1)).toBe(false)
})
