import { invoke } from "@tauri-apps/api/core"
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { createRoot } from "react-dom/client"
import "../styles/tokens.css"
import "../styles/quick.css"

/**
 * Quick chat's window: a message box over whatever the person is doing, and a box
 * to tick for a picture of the window that was in front. It can only read that window's name, send
 * the message to Runrail's main window, and hide.
 */

interface QuickContext {
  readonly app?: string
  readonly title?: string
  readonly capturable: boolean
  readonly includeWindow: boolean
  readonly screenAccess: boolean
}

function message(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message
  return "That did not work."
}

function Quick() {
  const [text, setText] = useState("")
  const [context, setContext] = useState<QuickContext>()
  const [include, setInclude] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const box = useRef<HTMLTextAreaElement>(null)
  const refresh = useCallback(async () => {
    setError(undefined)
    const next = await invoke<QuickContext>("quick_context").catch(() => undefined)
    setContext(next)
    setInclude(next?.capturable === true && next.includeWindow)
    box.current?.focus()
    box.current?.select()
  }, [])
  useEffect(() => {
    void refresh()
    // The window is made once and shown again on each press of the shortcut.
    const shown = (): void => void refresh()
    window.addEventListener("focus", shown)
    return () => window.removeEventListener("focus", shown)
  }, [refresh])
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const sending = include && context?.capturable === true
    if (busy || (text.trim().length === 0 && !sending)) return
    setBusy(true)
    setError(undefined)
    try {
      await invoke("quick_submit", { text, includeWindow: sending })
      setText("")
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      void invoke("quick_hide")
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }
  return (
    <form className="qk" onSubmit={(event) => void submit(event)}>
      <textarea ref={box} className="qk-input" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={keys} placeholder="Ask Runrail" rows={3} maxLength={20_000} aria-label="Message" autoFocus />
      {error !== undefined && (
        <p className="qk-error" role="alert">
          {error}
        </p>
      )}
      <div className="qk-bar">
        {context?.capturable === true ? (
          <label className="qk-check" title={context.title}>
            <input type="checkbox" checked={include} onChange={(event) => setInclude(event.target.checked)} />
            <span className="qk-where">
              Include the {context.app ?? "front"} window{context.title !== undefined && <span className="qk-title"> {context.title}</span>}
            </span>
          </label>
        ) : (
          <span className="qk-hint">{context?.app === undefined ? "Starts a thread in the project open in Runrail" : `Runrail never pictures ${context.app} windows`}</span>
        )}
        <span className="qk-hint qk-keys">
          <kbd>Enter</kbd> send · <kbd>Esc</kbd> close
        </span>
      </div>
      {include && context?.screenAccess === false && <p className="qk-hint">The picture needs Screen Recording permission; macOS asks the first time.</p>}
    </form>
  )
}

function followTheme(): void {
  const light = window.matchMedia("(prefers-color-scheme: light)")
  const apply = (): void => {
    document.documentElement.dataset.theme = light.matches ? "light" : "dark"
  }
  apply()
  light.addEventListener("change", apply)
}

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root")
followTheme()
createRoot(root).render(
  <StrictMode>
    <Quick />
  </StrictMode>,
)
