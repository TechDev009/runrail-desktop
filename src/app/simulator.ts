import { create } from "zustand"
import { getHost, toHostError } from "../host"
import type { SimulatorDevice, SimulatorInput, SimulatorStatus } from "../host/types"

/**
 * iOS Simulator, as the side panel's Simulator tab shows it. The host runs Xcode's
 * `simctl`, and `idb` for taps and typing when it is installed. Which device the tab shows lives in
 * memory only.
 */

interface SimulatorState {
  readonly status?: SimulatorStatus
  readonly devices?: readonly SimulatorDevice[]
  readonly selected?: string
  /** The device being started or shut down. */
  readonly busy?: string
  readonly error?: string
}

export const useSimulator = create<SimulatorState>()(() => ({}))

/** The device the tab shows: the one picked, else the first running one, else the first. */
export function shownDevice(state: SimulatorState): SimulatorDevice | undefined {
  const devices = state.devices ?? []
  return devices.find((device) => device.udid === state.selected) ?? devices.find((device) => device.booted) ?? devices[0]
}

export async function loadSimulator(): Promise<void> {
  const host = getHost()
  try {
    const status = await host.simulatorStatus()
    const devices = status.xcode ? await host.simulatorDevices() : []
    useSimulator.setState({ status, devices, error: undefined })
  } catch (error) {
    useSimulator.setState({ error: toHostError(error).message })
  }
}

export function selectDevice(udid: string): void {
  useSimulator.setState({ selected: udid })
}

async function changing(udid: string, work: () => Promise<void>): Promise<void> {
  useSimulator.setState({ busy: udid, error: undefined })
  try {
    await work()
    useSimulator.setState({ devices: await getHost().simulatorDevices() })
  } catch (error) {
    useSimulator.setState({ error: toHostError(error).message })
  } finally {
    useSimulator.setState({ busy: undefined })
  }
}

export function bootDevice(udid: string): Promise<void> {
  return changing(udid, () => getHost().simulatorBoot(udid))
}

export function shutdownDevice(udid: string): Promise<void> {
  return changing(udid, () => getHost().simulatorShutdown(udid))
}

export async function setSimulatorAgents(on: boolean): Promise<void> {
  useSimulator.setState({ status: await getHost().simulatorAgents(on) })
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Where a pointer is on the shown screen, as fractions of it. */
export function screenPoint(rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }, clientX: number, clientY: number): { readonly x: number; readonly y: number } {
  return { x: clamp((clientX - rect.left) / Math.max(1, rect.width)), y: clamp((clientY - rect.top) / Math.max(1, rect.height)) }
}

/** A press that moved less than this share of the screen is a tap; farther is a swipe. */
const TAP_SLOP = 0.02

export function gesture(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): SimulatorInput {
  return Math.hypot(to.x - from.x, to.y - from.y) < TAP_SLOP ? { kind: "tap", x: from.x, y: from.y } : { kind: "swipe", x: from.x, y: from.y, toX: to.x, toY: to.y }
}

/** A key typed while the screen has focus: text for a character, a key for the few iOS takes. */
export function keyInput(key: string): SimulatorInput | undefined {
  if (key === "Enter") return { kind: "key", key: "Return" }
  if (key === "Backspace" || key === "Tab" || key === "Escape" || key === "Delete" || key.startsWith("Arrow")) return { kind: "key", key }
  return [...key].length === 1 ? { kind: "text", text: key } : undefined
}
