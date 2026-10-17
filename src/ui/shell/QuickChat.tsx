import { Keyboard, RotateCcw } from "lucide-react"
import { useEffect, useState } from "react"
import { useWords } from "../../app/platformWords"
import { DEFAULT_SHORTCUT, describeShortcut, loadQuick, setQuick, shortcutOf, useQuick } from "../../app/quick"
import { Button, IconButton, Toggle } from "../common"

/**
 * Quick chat: a global shortcut, Option Space (Ctrl+Alt+Space on Linux) unless the
 * person picks another, opens a small window over any app; what is typed there starts a thread here.
 */
export function QuickChat() {
  const { status, error } = useQuick()
  const words = useWords()
  const fallback = status?.defaultShortcut ?? DEFAULT_SHORTCUT
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void loadQuick()
  }, [])
  useEffect(() => {
    if (!recording || status === undefined) return
    const record = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.code === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        setRecording(false)
        return
      }
      const shortcut = shortcutOf(event)
      if (shortcut === undefined) return
      setRecording(false)
      setBusy(true)
      void setQuick(status.enabled, shortcut).finally(() => setBusy(false))
    }
    window.addEventListener("keydown", record, true)
    return () => window.removeEventListener("keydown", record, true)
  }, [recording, status])
  const change = (enabled: boolean, shortcut: string): void => {
    setBusy(true)
    void setQuick(enabled, shortcut).finally(() => setBusy(false))
  }
  return (
    <div data-setting="quick-chat">
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Quick chat</div>
          <div className="setting-hint">
            Press the shortcut in any app to ask Runrail. What you type starts a thread in the project open here
            {words.mac ? ", and you can tick a box to include a picture of the window you were in. Nothing is captured unless you tick it." : "."}
          </div>
        </div>
        <div className="setting-control">
          <Toggle label="Quick chat" checked={status?.enabled === true} disabled={status === undefined || busy} onChange={(on) => change(on, status?.shortcut ?? fallback)} />
        </div>
      </div>
      {status?.enabled === true && (
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">Shortcut</div>
            <div className="setting-hint">{recording ? `Press the new shortcut, with ${words.modifierKeys}. Esc keeps the old one.` : status.desktop === true ? desktopHint(status.trigger) : `Works while Runrail is open, ${words.inMenuBar} too.`}</div>
          </div>
          <div className="setting-control">
            <Button size="sm" variant="ghost" icon={<Keyboard size={13} />} disabled={busy} onClick={() => setRecording((value) => !value)} aria-pressed={recording}>
              {recording ? "Press keys…" : describeShortcut(status.shortcut)}
            </Button>
            {status.shortcut !== fallback && !recording && (
              <IconButton label={`Back to ${describeShortcut(fallback)}`} size="sm" disabled={busy} onClick={() => change(true, fallback)}>
                <RotateCcw size={13} />
              </IconButton>
            )}
          </div>
        </div>
      )}
      {(error ?? status?.problem) !== undefined && <p className="setting-hint is-error">{error ?? status?.problem}</p>}
    </div>
  )
}

/** On Wayland the desktop holds the shortcut through its portal and may let the person change it there. */
function desktopHint(trigger: string | undefined): string {
  return trigger === undefined ? "Your desktop holds this shortcut, and may ask you to allow it first." : `Your desktop holds this shortcut as ${trigger}. Its keyboard settings can change it.`
}
