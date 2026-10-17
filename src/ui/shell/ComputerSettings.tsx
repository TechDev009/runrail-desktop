import { AppWindowMac, MonitorCheck, Plus, Smartphone, X } from "lucide-react"
import { useEffect, useState } from "react"
import { loadAndroidStatus, setAndroidAgents, useAndroid } from "../../app/android"
import { allowComputerApp, disallowComputerApp, loadComputerSetup, requestComputerAccess, shareComputerWindow, stopSharingComputerWindow, useComputerSetup } from "../../app/computerAgent"
import { loadSimulator, setSimulatorAgents, useSimulator } from "../../app/simulator"
import { toast } from "../../app/store"
import { getHost, toHostError, type RunningComputerApp } from "../../host"
import type { AndroidStatus, ComputerAccess } from "../../host/types"
import { Button, cx, IconButton, Menu, Toggle } from "../common"

/**
 * Computer use in Settings → Permissions. Agents may use only the apps listed here,
 * in threads the person turned it on in. An app joins the list after the person agrees in a dialog
 * the page cannot draw; the system's own access, Screen Recording and Accessibility, is the person's
 * to grant in System Settings. On Linux, X11 needs no grant, and on Wayland the desktop
 * shares the one window the person picks instead of the list. Running iOS simulators and Android
 * emulators join once the person turns them on.
 */

const ACCESS = [
  { kind: "screen", label: "Screen Recording", hint: "Lets agents see an allowed app's window." },
  { kind: "accessibility", label: "Accessibility", hint: "Lets agents click, type, and scroll in an allowed app." },
] as const

export function ComputerSettings() {
  const { access, allowed } = useComputerSetup()
  const [running, setRunning] = useState<readonly RunningComputerApp[]>([])
  useEffect(() => {
    const reload = (): void => void loadComputerSetup().catch(() => undefined)
    reload()
    // Access changes in System Settings; it is read again when the person comes back.
    window.addEventListener("focus", reload)
    return () => window.removeEventListener("focus", reload)
  }, [])
  if (access === undefined) return null
  if (!access.supported) {
    return (
      <div data-setting="computer-use">
        <h3>Computer use</h3>
        <p className="setting-hint">{access.reason ?? "Agents can use apps on macOS only."}</p>
        <EmulatorRow />
      </div>
    )
  }
  if (access.session === "wayland") return <WaylandWindow access={access} />
  const apps = allowed ?? []
  const loadRunning = (): void => {
    void getHost()
      .computerRunningApps()
      .then(setRunning)
      .catch((error: unknown) => toast("error", `Could not list open apps: ${toHostError(error).message}`))
  }
  const add = async (app: RunningComputerApp): Promise<void> => {
    try {
      await allowComputerApp(app.bundleId)
    } catch (error) {
      const failure = toHostError(error)
      // The person said no in the system dialog.
      if (failure.code !== "COMPUTER_DECLINED") toast("error", `Could not allow ${app.name}: ${failure.message}`)
    }
  }
  const remove = (bundleId: string): void => {
    void disallowComputerApp(bundleId).catch((error: unknown) => toast("error", `Could not remove the app: ${toHostError(error).message}`))
  }
  const choices = running.filter((app) => !apps.some((entry) => entry.bundleId === app.bundleId))
  return (
    <div className="computer-settings" data-setting="computer-use">
      <h3>Computer use</h3>
      <p className="setting-hint">
        In a thread you turn it on in, from the composer's + menu, a Codex or Claude Code agent can see and use the apps below, one action at a time. It never uses another app, and Runrail never lets agents use password managers, security settings, or terminals.
      </p>
      {access.session === "x11" ? (
        <X11Session access={access} />
      ) : (
        <ul className="settings-list">
          {ACCESS.map((item) => {
            const on = access[item.kind]
            return (
              <li key={item.kind} className="settings-list-row">
                <MonitorCheck size={14} className="muted" />
                <span className="settings-list-text">
                  <span className="settings-list-title">{item.label}</span>
                  <span className="settings-list-hint">{item.hint}</span>
                </span>
                {on ? (
                  <span className="pill is-ok">On</span>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => void getHost().computerOpenSettings(item.kind).catch(() => undefined)}>
                      Open System Settings
                    </Button>
                    <Button size="sm" onClick={() => void requestComputerAccess(item.kind).catch((error: unknown) => toast("error", toHostError(error).message))}>
                      Turn on
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="computer-apps-head">
        <span className="settings-list-title">Apps agents may use</span>
        <Menu
          align="end"
          width={280}
          items={
            choices.length === 0
              ? [{ heading: running.length === 0 ? "Looking for open apps…" : "Every open app is listed already", id: "none" }]
              : [
                  { heading: "Open apps", id: "heading" },
                  ...choices.map((app) => ({
                    id: app.bundleId,
                    label: app.name,
                    hint: app.never ? "Never allowed" : undefined,
                    disabled: app.never,
                    onSelect: () => void add(app),
                  })),
                ]
          }
          trigger={({ toggle, ref, open }) => (
            <Button
              ref={ref}
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              className={cx(open && "is-active")}
              onClick={() => {
                if (!open) loadRunning()
                toggle()
              }}
            >
              Add an open app
            </Button>
          )}
        />
      </div>
      {apps.length === 0 ? (
        <p className="setting-hint">No apps yet. Open the app, then add it here.</p>
      ) : (
        <ul className="settings-list computer-apps">
          {apps.map((app) => (
            <li key={app.bundleId} className="settings-list-row">
              <AppWindowMac size={14} className="muted" />
              <span className="settings-list-text">
                <span className="settings-list-title">{app.name}</span>
                <span className="settings-list-hint">{app.bundleId}</span>
              </span>
              <IconButton label={`Stop letting agents use ${app.name}`} size="sm" onClick={() => remove(app.bundleId)}>
                <X size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <SimulatorRow />
      <EmulatorRow />
    </div>
  )
}

/** X11: the X server shows and drives an allowed app's windows; nothing to grant. */
export function X11Session({ access }: { readonly access: ComputerAccess }) {
  return (
    <ul className="settings-list" data-computer-session="x11">
      <li className="settings-list-row">
        <MonitorCheck size={14} className="muted" />
        <span className="settings-list-text">
          <span className="settings-list-title">X11 session</span>
          <span className="settings-list-hint">
            {access.accessibility ? "Agents see an allowed app's windows and click, type, and scroll in them through the X server. Nothing needs turning on." : "This X server lacks the XTest extension, so agents see allowed apps but cannot click or type in them."}
          </span>
        </span>
        <span className={cx("pill", access.accessibility ? "is-ok" : "is-warn")}>{access.accessibility ? "On" : "See only"}</span>
      </li>
    </ul>
  )
}

/**
 * Wayland: the desktop shares one window the person picks in its own dialog, for
 * as long as Runrail runs, and that window is the only thing agents may use.
 */
export function WaylandWindow({ access }: { readonly access: ComputerAccess }) {
  const shared = access.portal === "shared"
  const share = (): void => {
    void shareComputerWindow()
      .then((done) => {
        if (!done) toast("info", "No window was shared.")
      })
      .catch((error: unknown) => toast("error", `Could not share a window: ${toHostError(error).message}`))
  }
  const stop = (): void => {
    void stopSharingComputerWindow().catch((error: unknown) => toast("error", `Could not stop sharing: ${toHostError(error).message}`))
  }
  return (
    <div className="computer-settings" data-setting="computer-use" data-computer-session="wayland">
      <h3>Computer use</h3>
      <p className="setting-hint">
        On Wayland the desktop shares one window with Runrail, the one you pick in its dialog. In a thread you turn it on in, from the composer's + menu, a Codex or Claude Code agent can see and use that window only, one action at a time, until you stop sharing or quit Runrail.
      </p>
      <ul className="settings-list">
        <li className="settings-list-row" data-computer-portal={access.portal}>
          <MonitorCheck size={14} className="muted" />
          <span className="settings-list-text">
            <span className="settings-list-title">{shared ? "A window is shared" : "No window is shared"}</span>
            <span className="settings-list-hint">
              {shared ? "Agents may see it and click, type, and scroll in it. The desktop asks again after you stop." : "Wayland does not say which app a window belongs to, so Runrail cannot keep agents out of password managers, settings, or terminals here. Do not share one of those."}
            </span>
          </span>
          {shared ? (
            <Button size="sm" variant="ghost" onClick={stop}>
              Stop sharing
            </Button>
          ) : (
            <Button size="sm" onClick={share}>
              Share a window
            </Button>
          )}
        </li>
      </ul>
      <EmulatorRow />
    </div>
  )
}

/** Booted iOS simulators as something agents may use. */
function SimulatorRow() {
  const status = useSimulator((state) => state.status)
  useEffect(() => {
    void loadSimulator()
  }, [])
  if (status === undefined || !status.supported) return null
  const change = (on: boolean): void => {
    void setSimulatorAgents(on).catch((error: unknown) => {
      const failure = toHostError(error)
      if (failure.code !== "COMPUTER_DECLINED") toast("error", `Could not change it: ${failure.message}`)
    })
  }
  const hint = !status.xcode ? "Needs Xcode." : status.idb ? "Agents see a running simulator and tap, swipe, and type in it." : "Agents see a running simulator. Tapping and typing need idb, which is not installed."
  return (
    <ul className="settings-list" data-setting="computer-simulators">
      <li className="settings-list-row">
        <Smartphone size={14} className="muted" />
        <span className="settings-list-text">
          <span className="settings-list-title">iOS simulators</span>
          <span className="settings-list-hint">{hint}</span>
        </span>
        <Toggle label="Let agents use iOS simulators" checked={status.agents} disabled={!status.xcode && !status.agents} onChange={change} />
      </li>
    </ul>
  )
}

/** Running Android emulators as something agents may use. */
function EmulatorRow() {
  const status = useAndroid((state) => state.status)
  useEffect(() => {
    void loadAndroidStatus()
  }, [])
  if (status === undefined || !status.supported) return null
  return <EmulatorToggle status={status} />
}

export function EmulatorToggle({ status }: { readonly status: AndroidStatus }) {
  const change = (on: boolean): void => {
    void setAndroidAgents(on).catch((error: unknown) => {
      const failure = toHostError(error)
      if (failure.code !== "COMPUTER_DECLINED") toast("error", `Could not change it: ${failure.message}`)
    })
  }
  const using = "Agents see a running emulator and tap, swipe, and type in it."
  const hint = !status.sdk ? "Needs the Android SDK, from Android Studio." : status.kvm ? using : `${using} Starting one needs KVM, which is not set up here.`
  return (
    <ul className="settings-list" data-setting="computer-emulators">
      <li className="settings-list-row">
        <Smartphone size={14} className="muted" />
        <span className="settings-list-text">
          <span className="settings-list-title">Android emulators</span>
          <span className="settings-list-hint">{hint}</span>
        </span>
        <Toggle label="Let agents use Android emulators" checked={status.agents} disabled={!status.sdk && !status.agents} onChange={change} />
      </li>
    </ul>
  )
}
