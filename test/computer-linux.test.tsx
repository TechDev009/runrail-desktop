import { beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { computerPlace, shareComputerWindow, SHARED_WINDOW, stopSharingComputerWindow, useComputerSetup } from "../src/app/computerAgent"
import { setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { ComputerAccess } from "../src/host/types"
import { WaylandWindow, X11Session } from "../src/ui/shell/ComputerSettings"

/** Computer use on Linux: Settings shows what applies to the running desktop session. */

beforeEach(() => {
  useComputerSetup.setState({}, true)
})

test("an X11 session needs nothing turned on, and says so when the server takes no input", () => {
  const on = renderToStaticMarkup(<X11Session access={{ supported: true, screen: true, accessibility: true, session: "x11" }} />)
  expect(on).toContain("X11 session")
  expect(on).toContain("Nothing needs turning on")
  expect(on).not.toContain("System Settings")
  const seeOnly = renderToStaticMarkup(<X11Session access={{ supported: true, screen: true, accessibility: false, session: "x11" }} />)
  expect(seeOnly).toContain("XTest")
  expect(seeOnly).toContain("See only")
})

test("on Wayland the person shares one window, is warned what not to share, and can stop", () => {
  const ready = renderToStaticMarkup(<WaylandWindow access={{ supported: true, screen: false, accessibility: false, session: "wayland", portal: "ready" }} />)
  expect(ready).toContain("Share a window")
  expect(ready).toContain("Do not share one of those")
  expect(ready).not.toContain("Apps agents may use")
  const shared = renderToStaticMarkup(<WaylandWindow access={{ supported: true, screen: true, accessibility: true, session: "wayland", portal: "shared" }} />)
  expect(shared).toContain("A window is shared")
  expect(shared).toContain("Stop sharing")
})

test("the composer names a Mac on macOS and the computer on Linux", () => {
  expect(computerPlace("macos")).toBe("this Mac")
  expect(computerPlace("browser")).toBe("this Mac")
  expect(computerPlace("linux")).toBe("this computer")
})

test("sharing asks the desktop once and stopping ends the share by its id", async () => {
  let access: ComputerAccess = { supported: true, screen: false, accessibility: false, session: "wayland", portal: "ready" }
  const asked: string[] = []
  const stopped: string[] = []
  const host: Host = {
    ...createFakeHost({}),
    computerAccess: async () => access,
    computerRequestAccess: async (kind) => {
      asked.push(kind)
      access = { ...access, screen: true, accessibility: true, portal: "shared" }
      return access
    },
    computerDisallow: async (bundleId) => {
      stopped.push(bundleId)
      access = { ...access, screen: false, accessibility: false, portal: "ready" }
      return []
    },
  }
  setHost(host)
  expect(await shareComputerWindow()).toBe(true)
  expect(asked).toEqual(["screen"])
  expect(useComputerSetup.getState().access?.portal).toBe("shared")
  await stopSharingComputerWindow()
  expect(stopped).toEqual([SHARED_WINDOW])
  expect(useComputerSetup.getState().access?.portal).toBe("ready")
})

test("a share the person turned down reports no window", async () => {
  const access: ComputerAccess = { supported: true, screen: false, accessibility: false, session: "wayland", portal: "ready" }
  setHost({ ...createFakeHost({}), computerRequestAccess: async () => access })
  expect(await shareComputerWindow()).toBe(false)
})
