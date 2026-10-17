import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { gesture, keyInput, screenPoint } from "../../app/simulator"
import { toast } from "../../app/store"
import { toHostError, type SimulatorInput, type SimulatorScreen } from "../../host"
import { cx, Spinner } from "../common"

/**
 * A device's screen, read again about once a second while it shows: an iOS simulator's or an
 * Android emulator's. When the device takes input, a click taps, a drag swipes, and typing goes to
 * the device.
 */

/** Time between screen reads; each read waits for the one before. */
const REFRESH_MS = 900
/** Keys typed close together go to the device as one piece of text. */
const TYPE_BATCH_MS = 160

export type ScreenInput = Exclude<SimulatorInput, { readonly kind: "button" }>

interface DeviceScreenProps {
  readonly id: string
  readonly name: string
  readonly canInput: boolean
  readonly capture: () => Promise<SimulatorScreen>
  readonly input: (input: ScreenInput) => Promise<void>
  /** Starts the toast when the device refuses an input, as in "The simulator did not take that". */
  readonly refused: string
  /** The row under the screen; `act` runs an input and reads the screen again soon after. */
  readonly foot: (act: (run: () => Promise<void>) => void) => ReactNode
}

export function DeviceScreen({ id, name, canInput, capture, input, refused, foot }: DeviceScreenProps) {
  const [screen, setScreen] = useState<SimulatorScreen | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const image = useRef<HTMLImageElement | null>(null)
  const pressed = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined)
  const typed = useRef("")
  const typing = useRef<number | undefined>(undefined)
  const refresh = useRef<() => void>(() => undefined)
  const stage = useRef<HTMLDivElement | null>(null)
  const captureRef = useRef(capture)
  captureRef.current = capture

  useEffect(() => {
    let stopped = false
    let shown = false
    let timer: number | undefined
    const read = async (force = false): Promise<void> => {
      if (stopped) return
      window.clearTimeout(timer)
      // A hidden window is not read again, but the first frame, and the one after an input, are.
      if (force || !document.hidden || !shown) {
        try {
          const next = await captureRef.current()
          if (stopped) return
          shown = true
          setScreen(next)
          setFailed(undefined)
        } catch (error) {
          if (!stopped) setFailed(toHostError(error).message)
        }
      }
      if (!stopped) timer = window.setTimeout(() => void read(), REFRESH_MS)
    }
    refresh.current = () => void read(true)
    void read()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.clearTimeout(typing.current)
    }
  }, [id])

  const act = (run: () => Promise<void>): void => {
    void run()
      .then(() => window.setTimeout(() => refresh.current(), 250))
      .catch((error: unknown) => toast("error", `${refused}: ${toHostError(error).message}`))
  }
  const send = (next: ScreenInput): void => act(() => input(next))
  const flushTyped = (): void => {
    window.clearTimeout(typing.current)
    const text = typed.current
    typed.current = ""
    if (text.length > 0) send({ kind: "text", text })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!canInput || event.metaKey || event.ctrlKey || event.altKey) return
    const next = keyInput(event.key)
    if (next === undefined) return
    event.preventDefault()
    if (next.kind === "text") {
      typed.current += next.text
      window.clearTimeout(typing.current)
      typing.current = window.setTimeout(flushTyped, TYPE_BATCH_MS)
      return
    }
    flushTyped()
    if (next.kind !== "button") send(next)
  }
  const at = (event: PointerEvent<HTMLElement>) => (image.current === null ? undefined : screenPoint(image.current.getBoundingClientRect(), event.clientX, event.clientY))

  return (
    <div className="simulator-body">
      <div
        ref={stage}
        className={cx("simulator-stage", canInput && "can-input")}
        tabIndex={canInput ? 0 : -1}
        role={canInput ? "application" : undefined}
        aria-label={canInput ? `${name} screen. Click to tap, drag to swipe, type to enter text.` : `${name} screen`}
        onKeyDown={onKeyDown}
      >
        {screen === undefined ? (
          <div className="pane-loading">{failed ?? <Spinner size={12} />}</div>
        ) : (
          <img
            ref={image}
            className="simulator-screen"
            alt={`${name} screen`}
            draggable={false}
            src={`data:${screen.mediaType};base64,${screen.dataBase64}`}
            style={{ aspectRatio: `${String(screen.width)} / ${String(screen.height)}` }}
            onPointerDown={(event) => {
              if (!canInput) return
              // Typing goes to the device once its screen is clicked, not to the composer.
              event.preventDefault()
              stage.current?.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              pressed.current = at(event)
            }}
            onPointerUp={(event) => {
              const from = pressed.current
              pressed.current = undefined
              const to = at(event)
              if (!canInput || from === undefined || to === undefined) return
              flushTyped()
              const made = gesture(from, to)
              if (made.kind !== "button") send(made)
            }}
          />
        )}
      </div>
      <div className="simulator-foot">{foot(act)}</div>
    </div>
  )
}
