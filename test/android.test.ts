import { beforeEach, describe, expect, test } from "bun:test"
import { bootEmulator, loadAndroid, shownEmulator, shutdownEmulator, useAndroid } from "../src/app/android"
import { canAdd, openPanel, panelOf } from "../src/app/panels"
import { defaultState, parseState } from "../src/app/persist"
import { addProject, createThread, get, set } from "../src/app/store"
import { getHost, setHost, toHostError } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** The Android tab, on the preview host's two emulators. */

const PHONE = "Pixel_9_API_36"
const TABLET = "Pixel_Tablet_API_35"

function reset(scenario: Parameters<typeof createFakeHost>[0] = {}): void {
  setHost(createFakeHost(scenario))
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  useAndroid.setState({}, true)
}

describe("the emulators", () => {
  beforeEach(() => reset())

  test("are read with the SDK's state, and the running one shows first", async () => {
    await loadAndroid()
    const state = useAndroid.getState()
    expect(state.status).toEqual({ supported: true, sdk: true, emulator: true, kvm: true, agents: false })
    expect(state.devices?.map((device) => [device.avd, device.serial, device.booted])).toEqual([
      [PHONE, "emulator-5554", true],
      [TABLET, null, false],
    ])
    expect(shownEmulator(state)?.avd).toBe(PHONE)
    useAndroid.setState({ selected: TABLET })
    expect(shownEmulator(useAndroid.getState())?.avd).toBe(TABLET)
  })

  test("start with a serial and shut down, and the list is read again", async () => {
    await loadAndroid()
    const booting = bootEmulator(TABLET)
    expect(useAndroid.getState().busy).toBe(TABLET)
    await booting
    const tablet = useAndroid.getState().devices?.find((device) => device.avd === TABLET)
    expect(tablet).toMatchObject({ booted: true, serial: "emulator-5556" })
    await shutdownEmulator(tablet!)
    expect(useAndroid.getState().devices?.find((device) => device.avd === TABLET)).toMatchObject({ booted: false, serial: null })
    expect(useAndroid.getState().error).toBeUndefined()
  })

  test("a running screen is captured, taps and typing reach it, and a stopped one says so", async () => {
    const host = getHost()
    expect(atob((await host.androidScreenshot("emulator-5554")).dataBase64)).toContain("Taps: 0")
    await host.androidInput("emulator-5554", { kind: "tap", x: 0.5, y: 0.25 })
    await host.androidInput("emulator-5554", { kind: "text", text: "hello" })
    await host.androidLaunch("emulator-5554", "com.example.runner")
    const after = atob((await host.androidScreenshot("emulator-5554")).dataBase64)
    expect(after).toContain("Taps: 1")
    expect(after).toContain("hello")
    expect(after).toContain("com.example.runner")
    await host.androidInput("emulator-5554", { kind: "button", button: "back" })
    expect(atob((await host.androidScreenshot("emulator-5554")).dataBase64)).toContain("Home")
    expect(await host.androidInput("emulator-5554", { kind: "text", text: "café" }).catch((error: unknown) => toHostError(error).message)).toContain("ASCII only")
    expect(await host.androidScreenshot("emulator-5556").catch((error: unknown) => toHostError(error).message)).toBe("the emulator is not running")
  })
})

test("without the SDK there are no emulators to list", async () => {
  reset({ android: "no-sdk" })
  await loadAndroid()
  expect(useAndroid.getState().status?.sdk).toBe(false)
  expect(useAndroid.getState().devices).toEqual([])
})

test("without KVM an emulator cannot start, and the tab says why", async () => {
  reset({ android: "no-kvm" })
  await loadAndroid()
  expect(useAndroid.getState().status?.kvm).toBe(false)
  await bootEmulator(TABLET)
  expect(useAndroid.getState().error).toContain("KVM")
})

test("a thread's panel holds one Android tab, and it is saved with the layout", () => {
  reset()
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "native" })
  openPanel(thread.id, "android")
  openPanel(thread.id, "android")
  const panel = panelOf(thread.id)
  expect(panel.tabs.filter((tab) => tab.kind === "android")).toHaveLength(1)
  expect(canAdd(panel, "android")).toBe(false)
  const tab = panel.tabs[0]!
  const saved = parseState({ ...defaultState(), projects: get().projects, threads: get().threads, layout: { ...defaultState().layout, panels: { [thread.id]: panel } } })
  expect(saved.layout.panels[thread.id]?.tabs).toEqual([{ id: tab.id, kind: "android" }])
})
