import { HostError } from "./types"
import type { SimulatorApp, SimulatorDevice, SimulatorInput, SimulatorScreen, SimulatorStatus } from "./types"

/**
 * The preview's iOS simulators: an iPhone that is running and an iPad that is
 * not. The screen is drawn from what was done to it, so taps, typing, launches and addresses show.
 */

interface Device {
  readonly udid: string
  readonly name: string
  readonly runtime: string
  booted: boolean
}

interface Screen {
  app?: string
  url?: string
  taps: number
  text: string
  last?: { readonly x: number; readonly y: number }
}

const WIDTH = 402
const HEIGHT = 874

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`)
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fakeSimulator(scenario: "no-xcode" | "no-idb" | undefined) {
  const devices: Device[] = [
    { udid: "4744AA9D-4D49-4B67-80E1-DE8AC68FEDC3", name: "iPhone 17 Pro", runtime: "iOS 26.3", booted: true },
    { udid: "408CC8E7-2569-4052-9FA1-D6C1AC7E34C9", name: "iPad Air 13-inch (M3)", runtime: "iOS 26.3", booted: false },
  ]
  const installed: SimulatorApp[] = [{ bundleId: "com.example.Runner", name: "Runner" }]
  const screens = new Map<string, Screen>()
  let agents = false

  const status = (): SimulatorStatus => ({ supported: true, xcode: scenario !== "no-xcode", idb: scenario === undefined, agents })
  const device = (udid: string): Device => {
    if (scenario === "no-xcode") throw new HostError("SIMULATOR_UNAVAILABLE", "Xcode is not installed, so there are no simulators", 501)
    const found = devices.find((entry) => entry.udid === udid)
    if (found === undefined) throw new HostError("SIMULATOR_FAILED", "no simulator has this id")
    return found
  }
  const running = (udid: string): Device => {
    const found = device(udid)
    if (!found.booted) throw new HostError("SIMULATOR_FAILED", "the simulator is not running")
    return found
  }
  const screen = (udid: string): Screen => {
    const found = screens.get(udid) ?? { taps: 0, text: "" }
    screens.set(udid, found)
    return found
  }
  const draw = (udid: string): SimulatorScreen => {
    const state = screen(udid)
    const title = state.app ?? "Home"
    const dot = state.last === undefined ? "" : `<circle cx="${String(Math.round(state.last.x * WIDTH))}" cy="${String(Math.round(state.last.y * HEIGHT))}" r="14" fill="orange" opacity="0.8"/>`
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}">`,
      `<rect width="100%" height="100%" fill="whitesmoke"/>`,
      `<text x="32" y="40" font-family="-apple-system, sans-serif" font-size="17" font-weight="600" fill="black">9:41</text>`,
      `<text x="24" y="120" font-family="-apple-system, sans-serif" font-size="34" font-weight="700" fill="black">${escapeXml(title)}</text>`,
      state.url === undefined ? "" : `<text x="24" y="160" font-family="-apple-system, sans-serif" font-size="15" fill="dimgray">${escapeXml(state.url.slice(0, 48))}</text>`,
      `<rect x="16" y="200" width="${String(WIDTH - 32)}" height="52" rx="12" fill="white"/>`,
      `<text x="32" y="232" font-family="-apple-system, sans-serif" font-size="17" fill="${state.text === "" ? "gray" : "black"}">${escapeXml(state.text === "" ? "Type here" : state.text.slice(-40))}</text>`,
      `<text x="24" y="300" font-family="-apple-system, sans-serif" font-size="15" fill="dimgray">Taps: ${String(state.taps)}</text>`,
      `<rect x="${String(WIDTH / 2 - 70)}" y="${String(HEIGHT - 14)}" width="140" height="5" rx="2.5" fill="black"/>`,
      dot,
      `</svg>`,
    ].join("")
    return { mediaType: "image/svg+xml", dataBase64: base64(svg), width: WIDTH, height: HEIGHT }
  }

  return {
    status,
    devices: (): readonly SimulatorDevice[] => {
      if (scenario === "no-xcode") throw new HostError("SIMULATOR_UNAVAILABLE", "Xcode is not installed, so there are no simulators", 501)
      return devices.map((entry) => ({ ...entry }))
    },
    boot: (udid: string): void => {
      device(udid).booted = true
    },
    shutdown: (udid: string): void => {
      device(udid).booted = false
      screens.delete(udid)
    },
    open: (udid: string): void => {
      device(udid)
    },
    screenshot: (udid: string): SimulatorScreen => {
      running(udid)
      return draw(udid)
    },
    apps: (udid: string): readonly SimulatorApp[] => {
      running(udid)
      return installed
    },
    install: (udid: string): SimulatorApp => {
      running(udid)
      return installed[0]!
    },
    launch: (udid: string, bundleId: string): void => {
      running(udid)
      const app = installed.find((entry) => entry.bundleId === bundleId)
      if (app === undefined) throw new HostError("SIMULATOR_FAILED", "the app is not installed")
      screen(udid).app = app.name
    },
    openUrl: (udid: string, url: string): void => {
      running(udid)
      screen(udid).url = url
    },
    input: (udid: string, input: SimulatorInput): void => {
      running(udid)
      if (!status().idb) throw new HostError("SIMULATOR_FAILED", "idb is not installed")
      const state = screen(udid)
      if (input.kind === "tap") {
        state.taps += 1
        state.last = { x: input.x, y: input.y }
      } else if (input.kind === "swipe") state.last = { x: input.toX, y: input.toY }
      else if (input.kind === "text") state.text += input.text
      else if (input.kind === "key" && input.key === "Backspace") state.text = state.text.slice(0, -1)
      else if (input.kind === "button" && input.button === "home") {
        delete state.app
        delete state.url
      }
    },
    setAgents: (on: boolean): SimulatorStatus => {
      agents = on
      return status()
    },
  }
}
