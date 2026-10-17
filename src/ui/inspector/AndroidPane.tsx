import { AppWindow, ArrowLeft, Globe, House, Plus, Power, Smartphone, Square } from "lucide-react"
import { useEffect, useState } from "react"
import { bootEmulator, loadAndroid, selectEmulator, shownEmulator, shutdownEmulator, useAndroid } from "../../app/android"
import { toast, useApp } from "../../app/store"
import { getHost, toHostError, type AndroidApp } from "../../host"
import { Button, cx, EmptyState, IconButton, Menu, Spinner } from "../common"
import { DeviceScreen } from "./DeviceScreen"

/**
 * The Android tab: one Android emulator's screen, read again about once a second
 * while the tab shows. A click taps, a drag swipes, and typing goes to the device through `adb`.
 */

export function AndroidPane() {
  const { status, devices, busy, error } = useAndroid()
  const device = useAndroid(shownEmulator)
  const mac = useApp((state) => state.platform === "macos")
  useEffect(() => {
    void loadAndroid()
  }, [])
  if (status === undefined) {
    return (
      <div className="pane-loading">
        {error === undefined ? (
          <>
            <Spinner size={12} /> Looking for emulators…
          </>
        ) : (
          error
        )}
      </div>
    )
  }
  if (!status.supported) return <EmptyState icon={<Smartphone size={18} />} title="Android emulators are not available on this system yet" />
  if (!status.sdk)
    return (
      <EmptyState icon={<Smartphone size={18} />} title="The Android SDK is not installed">
        Install Android Studio and create a virtual device in its Device Manager. Runrail looks in <code>ANDROID_HOME</code>, then <code>{mac ? "~/Library/Android/sdk" : "~/Android/Sdk"}</code>.
      </EmptyState>
    )
  if (device === undefined)
    return (
      <EmptyState icon={<Smartphone size={18} />} title="No Android emulators">
        Create a virtual device in Android Studio's Device Manager.
      </EmptyState>
    )
  const serial = device.booted ? (device.serial ?? undefined) : undefined
  const cannotStart = !status.emulator ? "The emulator is not installed. Add Android Emulator in Android Studio's SDK Manager." : !status.kvm ? "The emulator needs KVM: /dev/kvm is missing, or you are not in its group (often kvm)." : undefined
  return (
    <div className="simulator">
      <div className="pane-toolbar">
        <Smartphone size={13} aria-hidden="true" className="muted" />
        <select className="select select-sm simulator-device" aria-label="Emulator" value={device.avd} onChange={(event) => selectEmulator(event.target.value)}>
          {(devices ?? []).map((entry) => (
            <option key={entry.avd} value={entry.avd}>
              {entry.name}
              {entry.booted ? " · running" : ""}
            </option>
          ))}
        </select>
        <div className="pane-toolbar-spacer" />
        {serial !== undefined && <AppMenu serial={serial} />}
        {serial !== undefined && (
          <Button size="sm" variant="ghost" icon={<Power size={12} />} loading={busy === device.avd} onClick={() => void shutdownEmulator(device)}>
            Shut down
          </Button>
        )}
      </div>
      {error !== undefined && <div className="inspect-empty is-error pad">{error}</div>}
      {serial !== undefined ? (
        <EmulatorScreen key={serial} serial={serial} name={device.name} />
      ) : (
        <EmptyState
          icon={<Smartphone size={18} />}
          title={device.serial === undefined || device.serial === null ? `${device.name} is not running` : `${device.name} is starting`}
          actions={
            <Button variant="primary" size="sm" loading={busy === device.avd} disabled={cannotStart !== undefined} onClick={() => void bootEmulator(device.avd)}>
              Start {device.name}
            </Button>
          }
        >
          {cannotStart ?? "It opens in its own window too. A cold start can take a few minutes."}
        </EmptyState>
      )}
    </div>
  )
}

/** Install an APK, open an installed app, or open an address on the device. */
function AppMenu({ serial }: { readonly serial: string }) {
  const [apps, setApps] = useState<readonly AndroidApp[] | undefined>()
  const [address, setAddress] = useState<string | undefined>()
  const fail = (what: string) => (failure: unknown) => toast("error", `${what}: ${toHostError(failure).message}`)
  const load = (): void => {
    void getHost().androidApps(serial).then(setApps).catch(fail("Could not list the apps"))
  }
  const install = async (): Promise<void> => {
    try {
      const app = await getHost().androidInstall(serial)
      if (app === null) return
      toast("success", `Installed ${app.name}`)
      if (app.package !== "") await getHost().androidLaunch(serial, app.package)
    } catch (failure) {
      fail("Could not install the app")(failure)
    }
  }
  const open = (): void => {
    const url = address?.trim() ?? ""
    if (url.length === 0) return
    void getHost()
      .androidOpenUrl(serial, url)
      .then(() => setAddress(undefined))
      .catch(fail("Could not open the address"))
  }
  return (
    <>
      <Menu
        align="end"
        width={280}
        items={[
          { id: "install", label: "Install an APK…", icon: <Plus size={13} />, onSelect: () => void install() },
          { id: "address", label: "Open an address…", icon: <Globe size={13} />, onSelect: () => setAddress("") },
          { separator: true, id: "sep" },
          { heading: apps === undefined ? "Looking for apps…" : apps.length === 0 ? "No apps installed yet" : "Open an app", id: "apps" },
          ...(apps ?? []).map((app) => ({
            id: app.package,
            label: app.name,
            icon: <AppWindow size={13} />,
            onSelect: () => void getHost().androidLaunch(serial, app.package).catch(fail(`Could not open ${app.name}`)),
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
            aria-label="Address to open on the emulator"
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

function EmulatorScreen({ serial, name }: { readonly serial: string; readonly name: string }) {
  const button = (act: (run: () => Promise<void>) => void, which: "back" | "home" | "recents") => () => act(() => getHost().androidInput(serial, { kind: "button", button: which }))
  return (
    <DeviceScreen
      id={serial}
      name={name}
      canInput
      capture={() => getHost().androidScreenshot(serial)}
      input={(input) => getHost().androidInput(serial, input)}
      refused="The emulator did not take that"
      foot={(act) => (
        <>
          <IconButton label="Back" size="sm" onClick={button(act, "back")}>
            <ArrowLeft size={13} />
          </IconButton>
          <IconButton label="Home" size="sm" onClick={button(act, "home")}>
            <House size={13} />
          </IconButton>
          <IconButton label="Recent apps" size="sm" onClick={button(act, "recents")}>
            <Square size={12} />
          </IconButton>
          <span className="simulator-note">Click to tap, drag to swipe. Click the screen, then type (ASCII only).</span>
        </>
      )}
    />
  )
}
