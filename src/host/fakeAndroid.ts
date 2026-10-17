import { HostError } from "./types"
import type { AndroidApp, AndroidDevice, AndroidInput, AndroidStatus, SimulatorScreen } from "./types"

/**
 * The preview's Android emulators: a phone that is running and a tablet that is
 * not. The screen is drawn from what was done to it, so taps, typing, launches and addresses show.
 */

interface Device {
  readonly avd: string
  readonly name: string
  serial: string | null
  booted: boolean
}

interface Screen {
  app?: string
  url?: string
  taps: number
  text: string
  last?: { readonly x: number; readonly y: number }
}

const WIDTH = 412
const HEIGHT = 915

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`)
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fakeAndroid(scenario: "no-sdk" | "no-kvm" | undefined) {
  const devices: Device[] = [
    { avd: "Pixel_9_API_36", name: "Pixel 9 API 36", serial: "emulator-5554", booted: true },
    { avd: "Pixel_Tablet_API_35", name: "Pixel Tablet API 35", serial: null, booted: false },
  ]
  const installed: AndroidApp[] = [{ package: "com.example.runner", name: "com.example.runner" }]
  const screens = new Map<string, Screen>()
  let agents = false

  const status = (): AndroidStatus => ({ supported: true, sdk: scenario !== "no-sdk", emulator: scenario !== "no-sdk", kvm: scenario !== "no-kvm", agents })
  const unavailable = (): never => {
    throw new HostError("ANDROID_UNAVAILABLE", "the Android SDK is not installed, so there are no emulators", 501)
  }
  const running = (serial: string): Device => {
    if (scenario === "no-sdk") unavailable()
    const found = devices.find((entry) => entry.serial === serial && entry.booted)
    if (found === undefined) throw new HostError("ANDROID_FAILED", "the emulator is not running")
    return found
  }
  const screen = (serial: string): Screen => {
    const found = screens.get(serial) ?? { taps: 0, text: "" }
    screens.set(serial, found)
    return found
  }
  const draw = (serial: string): SimulatorScreen => {
    const state = screen(serial)
    const title = state.app ?? "Home"
    const dot = state.last === undefined ? "" : `<circle cx="${String(Math.round(state.last.x * WIDTH))}" cy="${String(Math.round(state.last.y * HEIGHT))}" r="14" fill="orange" opacity="0.8"/>`
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}">`,
      `<rect width="100%" height="100%" fill="ghostwhite"/>`,
      `<text x="24" y="34" font-family="Roboto, sans-serif" font-size="15" fill="black">12:00</text>`,
      `<text x="24" y="120" font-family="Roboto, sans-serif" font-size="32" fill="black">${escapeXml(title)}</text>`,
      state.url === undefined ? "" : `<text x="24" y="160" font-family="Roboto, sans-serif" font-size="15" fill="dimgray">${escapeXml(state.url.slice(0, 48))}</text>`,
      `<rect x="16" y="200" width="${String(WIDTH - 32)}" height="56" rx="28" fill="white"/>`,
      `<text x="36" y="234" font-family="Roboto, sans-serif" font-size="16" fill="${state.text === "" ? "gray" : "black"}">${escapeXml(state.text === "" ? "Type here" : state.text.slice(-40))}</text>`,
      `<text x="24" y="300" font-family="Roboto, sans-serif" font-size="15" fill="dimgray">Taps: ${String(state.taps)}</text>`,
      `<rect x="${String(WIDTH / 2 - 54)}" y="${String(HEIGHT - 16)}" width="108" height="4" rx="2" fill="black"/>`,
      dot,
      `</svg>`,
    ].join("")
    return { mediaType: "image/svg+xml", dataBase64: base64(svg), width: WIDTH, height: HEIGHT }
  }

  return {
    status,
    devices: (): readonly AndroidDevice[] => {
      if (scenario === "no-sdk") unavailable()
      return devices.map((entry) => ({ ...entry }))
    },
    boot: (avd: string): string => {
      if (scenario === "no-sdk") unavailable()
      if (scenario === "no-kvm") throw new HostError("ANDROID_UNAVAILABLE", "the emulator needs KVM: /dev/kvm is missing or you are not in its group (often `kvm`)", 501)
      const found = devices.find((entry) => entry.avd === avd)
      if (found === undefined) throw new HostError("ANDROID_FAILED", "no emulator has this name")
      found.serial ??= `emulator-${String(5554 + 2 * devices.filter((entry) => entry.serial !== null).length)}`
      found.booted = true
      return found.serial
    },
    shutdown: (serial: string): void => {
      const found = running(serial)
      found.booted = false
      found.serial = null
      screens.delete(serial)
    },
    screenshot: (serial: string): SimulatorScreen => {
      running(serial)
      return draw(serial)
    },
    apps: (serial: string): readonly AndroidApp[] => {
      running(serial)
      return installed
    },
    install: (serial: string): AndroidApp => {
      running(serial)
      return installed[0]!
    },
    launch: (serial: string, packageName: string): void => {
      running(serial)
      const app = installed.find((entry) => entry.package === packageName)
      if (app === undefined) throw new HostError("ANDROID_FAILED", "the app has nothing to open")
      screen(serial).app = app.name
    },
    openUrl: (serial: string, url: string): void => {
      running(serial)
      screen(serial).url = url
    },
    input: (serial: string, input: AndroidInput): void => {
      running(serial)
      const state = screen(serial)
      if (input.kind === "tap") {
        state.taps += 1
        state.last = { x: input.x, y: input.y }
      } else if (input.kind === "swipe") state.last = { x: input.toX, y: input.toY }
      else if (input.kind === "text") {
        // adb's input types ASCII only, and so does the fake.
        if (/[^\x20-\x7e\n\t]/.test(input.text)) throw new HostError("ANDROID_FAILED", "the emulator's input types ASCII only; paste other text in the emulator")
        state.text += input.text
      } else if (input.kind === "key" && input.key === "Backspace") state.text = state.text.slice(0, -1)
      else if (input.kind === "button" && (input.button === "home" || input.button === "back")) {
        delete state.app
        delete state.url
      }
    },
    setAgents: (on: boolean): AndroidStatus => {
      agents = on
      return status()
    },
  }
}
