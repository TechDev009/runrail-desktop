import { beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { loadAndroidStatus, setAndroidAgents, useAndroid } from "../src/app/android"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { AndroidStatus } from "../src/host/types"
import { EmulatorToggle } from "../src/ui/shell/ComputerSettings"
import { searchSettings } from "../src/ui/shell/settingsIndex"

/** Agents and Android emulators: a toggle under Computer use, next to iOS simulators. */

const READY: AndroidStatus = { supported: true, sdk: true, emulator: true, kvm: true, agents: false }

beforeEach(() => {
  setHost(createFakeHost({}))
  useAndroid.setState({}, true)
})

test("agents may use emulators only once the person turns it on, and turning it off sticks", async () => {
  await loadAndroidStatus()
  expect(useAndroid.getState().status?.agents).toBe(false)
  expect(useAndroid.getState().devices).toBeUndefined()
  await setAndroidAgents(true)
  expect(useAndroid.getState().status?.agents).toBe(true)
  await loadAndroidStatus()
  expect(useAndroid.getState().status?.agents).toBe(true)
  await setAndroidAgents(false)
  expect(useAndroid.getState().status?.agents).toBe(false)
})

test("Settings names the emulators, says what agents do in them, and why the toggle is off", () => {
  const ready = renderToStaticMarkup(<EmulatorToggle status={READY} />)
  expect(ready).toContain('data-setting="computer-emulators"')
  expect(ready).toContain("Android emulators")
  expect(ready).toContain("Agents see a running emulator and tap, swipe, and type in it.")
  expect(ready).toContain('aria-label="Let agents use Android emulators"')
  expect(ready).toContain('aria-checked="false"')
  expect(ready).not.toContain("disabled")
  expect(renderToStaticMarkup(<EmulatorToggle status={{ ...READY, agents: true }} />)).toContain('aria-checked="true"')
  const noSdk = renderToStaticMarkup(<EmulatorToggle status={{ ...READY, sdk: false, emulator: false }} />)
  expect(noSdk).toContain("Needs the Android SDK, from Android Studio.")
  expect(noSdk).toContain("disabled")
  // Turned on before the SDK went away, it can still be turned off.
  expect(renderToStaticMarkup(<EmulatorToggle status={{ ...READY, sdk: false, agents: true }} />)).not.toContain("disabled")
  const noKvm = renderToStaticMarkup(<EmulatorToggle status={{ ...READY, kvm: false }} />)
  expect(noKvm).toContain("Starting one needs KVM, which is not set up here.")
  expect(noKvm).not.toContain("disabled")
  for (const markup of [ready, noSdk, noKvm]) expect(markup).not.toMatch(/\bMac\b|macOS|Finder|System Settings/)
})

test("searching Settings for an emulator finds the toggle", () => {
  for (const words of ["android emulator", "adb"]) expect(searchSettings(words)[0]?.id).toBe("computer-emulators")
})
