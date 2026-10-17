import { beforeEach, describe, expect, test } from "bun:test"
import { canAdd, openPanel, panelOf } from "../src/app/panels"
import { defaultState, parseState } from "../src/app/persist"
import { bootDevice, gesture, keyInput, loadSimulator, screenPoint, setSimulatorAgents, shownDevice, shutdownDevice, useSimulator } from "../src/app/simulator"
import { addProject, createThread, get, set } from "../src/app/store"
import { getHost, setHost, toHostError } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** The iOS Simulator tab, on the preview host's two simulators. */

const PHONE = "4744AA9D-4D49-4B67-80E1-DE8AC68FEDC3"
const PAD = "408CC8E7-2569-4052-9FA1-D6C1AC7E34C9"

function reset(scenario: Parameters<typeof createFakeHost>[0] = {}): void {
  setHost(createFakeHost(scenario))
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  useSimulator.setState({}, true)
}

describe("pointer and keys on the shown screen", () => {
  test("a place on the image is a fraction of it, kept inside", () => {
    const rect = { left: 100, top: 50, width: 200, height: 400 }
    expect(screenPoint(rect, 200, 250)).toEqual({ x: 0.5, y: 0.5 })
    expect(screenPoint(rect, 50, 900)).toEqual({ x: 0, y: 1 })
  })

  test("a press that barely moves is a tap, and a longer one a swipe", () => {
    expect(gesture({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.51 })).toEqual({ kind: "tap", x: 0.5, y: 0.5 })
    expect(gesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 })).toEqual({ kind: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2 })
  })

  test("characters are text, and only the keys iOS takes are keys", () => {
    expect(keyInput("a")).toEqual({ kind: "text", text: "a" })
    expect(keyInput("é")).toEqual({ kind: "text", text: "é" })
    expect(keyInput("Enter")).toEqual({ kind: "key", key: "Return" })
    expect(keyInput("ArrowLeft")).toEqual({ kind: "key", key: "ArrowLeft" })
    expect(keyInput("Shift")).toBeUndefined()
    expect(keyInput("F5")).toBeUndefined()
  })
})

describe("the simulators", () => {
  beforeEach(() => reset())

  test("are read with Xcode's and idb's state, and the running one shows first", async () => {
    await loadSimulator()
    const state = useSimulator.getState()
    expect(state.status).toEqual({ supported: true, xcode: true, idb: true, agents: false })
    expect(state.devices?.map((device) => [device.udid, device.booted])).toEqual([
      [PHONE, true],
      [PAD, false],
    ])
    expect(shownDevice(state)?.udid).toBe(PHONE)
    useSimulator.setState({ selected: PAD })
    expect(shownDevice(useSimulator.getState())?.udid).toBe(PAD)
    useSimulator.setState({ selected: "gone" })
    expect(shownDevice(useSimulator.getState())?.udid).toBe(PHONE)
  })

  test("start and shut down, and the list is read again", async () => {
    await loadSimulator()
    const booting = bootDevice(PAD)
    expect(useSimulator.getState().busy).toBe(PAD)
    await booting
    expect(useSimulator.getState().busy).toBeUndefined()
    expect(useSimulator.getState().devices?.find((device) => device.udid === PAD)?.booted).toBe(true)
    await shutdownDevice(PHONE)
    expect(useSimulator.getState().devices?.find((device) => device.udid === PHONE)?.booted).toBe(false)
    expect(useSimulator.getState().error).toBeUndefined()
  })

  test("a running screen is captured, taps and typing reach it, and a stopped one says so", async () => {
    const host = getHost()
    const before = atob((await host.simulatorScreenshot(PHONE)).dataBase64)
    expect(before).toContain("Taps: 0")
    await host.simulatorInput(PHONE, { kind: "tap", x: 0.5, y: 0.25 })
    await host.simulatorInput(PHONE, { kind: "text", text: "hello" })
    await host.simulatorLaunch(PHONE, "com.example.Runner")
    const after = atob((await host.simulatorScreenshot(PHONE)).dataBase64)
    expect(after).toContain("Taps: 1")
    expect(after).toContain("hello")
    expect(after).toContain("Runner")
    expect(await host.simulatorScreenshot(PAD).catch((error: unknown) => toHostError(error).message)).toBe("the simulator is not running")
  })

  test("agents may use them only once the person turns it on", async () => {
    await loadSimulator()
    await setSimulatorAgents(true)
    expect(useSimulator.getState().status?.agents).toBe(true)
    await setSimulatorAgents(false)
    expect(useSimulator.getState().status?.agents).toBe(false)
  })
})

test("without idb the screen is view only", async () => {
  reset({ simulator: "no-idb" })
  await loadSimulator()
  expect(useSimulator.getState().status?.idb).toBe(false)
  const refused = await getHost()
    .simulatorInput(PHONE, { kind: "tap", x: 0.1, y: 0.1 })
    .catch((error: unknown) => toHostError(error))
  expect(refused).toMatchObject({ code: "SIMULATOR_FAILED" })
})

test("without Xcode there are no devices to list", async () => {
  reset({ simulator: "no-xcode" })
  await loadSimulator()
  expect(useSimulator.getState().status?.xcode).toBe(false)
  expect(useSimulator.getState().devices).toEqual([])
})

test("a thread's panel holds one Simulator tab, and it is saved with the layout", () => {
  reset()
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "native" })
  openPanel(thread.id, "simulator")
  openPanel(thread.id, "simulator")
  const panel = panelOf(thread.id)
  expect(panel.tabs.filter((tab) => tab.kind === "simulator")).toHaveLength(1)
  expect(canAdd(panel, "simulator")).toBe(false)
  const tab = panel.tabs[0]!
  const saved = parseState({ ...defaultState(), projects: get().projects, threads: get().threads, layout: { ...defaultState().layout, panels: { [thread.id]: panel } } })
  expect(saved.layout.panels[thread.id]?.tabs).toEqual([{ id: tab.id, kind: "simulator" }])
})
