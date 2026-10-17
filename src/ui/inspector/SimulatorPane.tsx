import { AppWindow, Circle, ExternalLink, Globe, House, Plus, Power, Smartphone } from "lucide-react"
import { useEffect, useState } from "react"
import { bootDevice, loadSimulator, selectDevice, shownDevice, shutdownDevice, useSimulator } from "../../app/simulator"
import { toast } from "../../app/store"
import { getHost, toHostError, type SimulatorApp, type SimulatorDevice } from "../../host"
import { Button, cx, EmptyState, IconButton, Menu, Spinner } from "../common"
import { DeviceScreen } from "./DeviceScreen"

/**
 * The Simulator tab: one iOS simulator's screen, read again about once a second
 * while the tab shows. With idb installed, a click taps, a drag swipes, and typing goes to the
 * device; without it the screen is view only.
 */

export function SimulatorPane() {
  const { status, devices, busy, error } = useSimulator()
  const device = useSimulator(shownDevice)
  useEffect(() => {
    void loadSimulator()
  }, [])
  if (status === undefined) {
    return (
      <div className="pane-loading">
        {error === undefined ? (
          <>
            <Spinner size={12} /> Looking for simulators…
          </>
        ) : (
          error
        )}
      </div>
    )
  }
  if (!status.supported) return <EmptyState icon={<Smartphone size={18} />} title="iOS simulators need a Mac" />
  if (!status.xcode)
    return (
      <EmptyState icon={<Smartphone size={18} />} title="Xcode is not installed">
        Install Xcode from the App Store, open it once, then come back to use its iOS simulators here.
      </EmptyState>
    )
  if (device === undefined)
    return (
      <EmptyState icon={<Smartphone size={18} />} title="No iOS simulators">
        Add one in Xcode, under Window, Devices and Simulators.
      </EmptyState>
    )
  return (
    <div className="simulator">
      <div className="pane-toolbar">
        <Smartphone size={13} aria-hidden="true" className="muted" />
        <select className="select select-sm simulator-device" aria-label="Simulator" value={device.udid} onChange={(event) => selectDevice(event.target.value)}>
          {(devices ?? []).map((entry) => (
            <option key={entry.udid} value={entry.udid}>
              {entry.name} · {entry.runtime}
              {entry.booted ? " · running" : ""}
            </option>
          ))}
        </select>
        <div className="pane-toolbar-spacer" />
        {device.booted && <AppMenu device={device} />}
        <IconButton label="Show in the Simulator app" size="sm" onClick={() => void getHost().simulatorOpen(device.udid).catch((failure: unknown) => toast("error", toHostError(failure).message))}>
          <ExternalLink size={13} />
        </IconButton>
        {device.booted && (
          <Button size="sm" variant="ghost" icon={<Power size={12} />} loading={busy === device.udid} onClick={() => void shutdownDevice(device.udid)}>
            Shut down
          </Button>
        )}
      </div>
      {error !== undefined && <div className="inspect-empty is-error pad">{error}</div>}
      {device.booted ? (
        <SimulatorScreen key={device.udid} device={device} canInput={status.idb} />
      ) : (
        <EmptyState
          icon={<Smartphone size={18} />}
          title={`${device.name} is not running`}
          actions={
            <Button variant="primary" size="sm" loading={busy === device.udid} onClick={() => void bootDevice(device.udid)}>
              Start {device.name}
            </Button>
          }
        >
          Starting it can take a little while the first time.
        </EmptyState>
      )}
    </div>
  )
}

/** Install a built app, open one, or open an address on the device. */
function AppMenu({ device }: { readonly device: SimulatorDevice }) {
  const [apps, setApps] = useState<readonly SimulatorApp[] | undefined>()
  const [address, setAddress] = useState<string | undefined>()
  const fail = (what: string) => (failure: unknown) => toast("error", `${what}: ${toHostError(failure).message}`)
  const load = (): void => {
    void getHost().simulatorApps(device.udid).then(setApps).catch(fail("Could not list the apps"))
  }
  const install = async (): Promise<void> => {
    try {
      const app = await getHost().simulatorInstall(device.udid)
      if (app === null) return
      toast("success", `Installed ${app.name}`)
      await getHost().simulatorLaunch(device.udid, app.bundleId)
    } catch (failure) {
      fail("Could not install the app")(failure)
    }
  }
  const open = (): void => {
    const url = address?.trim() ?? ""
    if (url.length === 0) return
    void getHost()
      .simulatorOpenUrl(device.udid, url)
      .then(() => setAddress(undefined))
      .catch(fail("Could not open the address"))
  }
  return (
    <>
      <Menu
        align="end"
        width={260}
        items={[
          { id: "install", label: "Install a built app…", icon: <Plus size={13} />, onSelect: () => void install() },
          { id: "address", label: "Open an address…", icon: <Globe size={13} />, onSelect: () => setAddress("") },
          { separator: true, id: "sep" },
          { heading: apps === undefined ? "Looking for apps…" : apps.length === 0 ? "No apps installed yet" : "Open an app", id: "apps" },
          ...(apps ?? []).map((app) => ({
            id: app.bundleId,
            label: app.name,
            hint: app.bundleId,
            icon: <AppWindow size={13} />,
            onSelect: () => void getHost().simulatorLaunch(device.udid, app.bundleId).catch(fail(`Could not open ${app.name}`)),
          })),
        ]}
        trigger={({ toggle, ref, open: shown }) => (
          <Button
            ref={ref}
            size="sm"
            variant="ghost"
            icon={<AppWindow size={12} />}
            className={cx(shown && "is-active")}
            onClick={() => {
              if (!shown) load()
              toggle()
            }}
          >
            Apps
          </Button>
        )}
      />
      {address !== undefined && (
        <form
          className="simulator-address"
          onSubmit={(event) => {
            event.preventDefault()
            open()
          }}
        >
          <input
            className="input input-sm"
            autoFocus
            aria-label="Address to open on the simulator"
            placeholder="https://… or myapp://…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setAddress(undefined)}
          />
          <Button size="sm" type="submit" disabled={address.trim().length === 0}>
            Open
          </Button>
        </form>
      )}
    </>
  )
}

function SimulatorScreen({ device, canInput }: { readonly device: SimulatorDevice; readonly canInput: boolean }) {
  return (
    <DeviceScreen
      id={device.udid}
      name={device.name}
      canInput={canInput}
      capture={() => getHost().simulatorScreenshot(device.udid)}
      input={(input) => getHost().simulatorInput(device.udid, input)}
      refused="The simulator did not take that"
      foot={(act) =>
        canInput ? (
          <>
            <IconButton label="Home" size="sm" onClick={() => act(() => getHost().simulatorInput(device.udid, { kind: "button", button: "home" }))}>
              <House size={13} />
            </IconButton>
            <IconButton label="Lock" size="sm" onClick={() => act(() => getHost().simulatorInput(device.udid, { kind: "button", button: "lock" }))}>
              <Circle size={13} />
            </IconButton>
            <span className="simulator-note">Click to tap, drag to swipe. Click the screen, then type.</span>
          </>
        ) : (
          <span className="simulator-note">
            View only. Tapping and typing from here need idb: <code>brew install facebook/fb/idb-companion</code> and <code>pip3 install fb-idb</code>. Or use the Simulator app.
          </span>
        )
      }
    />
  )
}
