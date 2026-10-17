import { create } from "zustand"
import { getHost, toHostError } from "../host"
import type { AndroidDevice, AndroidStatus } from "../host/types"

/**
 * Android emulators, as the side panel's Android tab shows them, and whether agents
 * may use them. The host runs the SDK's `emulator` and `adb`. Which device the tab shows
 * lives in memory only.
 */

interface AndroidState {
  readonly status?: AndroidStatus
  readonly devices?: readonly AndroidDevice[]
  /** The virtual device picked, by name. */
  readonly selected?: string
  /** The device being started or shut down. */
  readonly busy?: string
  readonly error?: string
}

export const useAndroid = create<AndroidState>()(() => ({}))

/** The device the tab shows: the one picked, else the first running one, else the first. */
export function shownEmulator(state: AndroidState): AndroidDevice | undefined {
  const devices = state.devices ?? []
  return devices.find((device) => device.avd === state.selected) ?? devices.find((device) => device.booted) ?? devices[0]
}

export async function loadAndroid(): Promise<void> {
  const host = getHost()
  try {
    const status = await host.androidStatus()
    const devices = status.sdk ? await host.androidDevices() : []
    useAndroid.setState({ status, devices, error: undefined })
  } catch (error) {
    useAndroid.setState({ error: toHostError(error).message })
  }
}

/** The SDK's state alone, for Settings and the composer, without listing the emulators. */
export async function loadAndroidStatus(): Promise<void> {
  try {
    useAndroid.setState({ status: await getHost().androidStatus() })
  } catch (error) {
    useAndroid.setState({ error: toHostError(error).message })
  }
}

export function selectEmulator(avd: string): void {
  useAndroid.setState({ selected: avd })
}

async function changing(avd: string, work: () => Promise<unknown>): Promise<void> {
  useAndroid.setState({ busy: avd, error: undefined })
  try {
    await work()
    useAndroid.setState({ devices: await getHost().androidDevices() })
  } catch (error) {
    useAndroid.setState({ error: toHostError(error).message })
  } finally {
    useAndroid.setState({ busy: undefined })
  }
}

export function bootEmulator(avd: string): Promise<void> {
  return changing(avd, () => getHost().androidBoot(avd))
}

export function shutdownEmulator(device: AndroidDevice): Promise<void> {
  const serial = device.serial
  if (serial === undefined || serial === null) return Promise.resolve()
  return changing(device.avd, () => getHost().androidShutdown(serial))
}

export async function setAndroidAgents(on: boolean): Promise<void> {
  useAndroid.setState({ status: await getHost().androidAgents(on) })
}
