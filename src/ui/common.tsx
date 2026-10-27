import { Check, ChevronDown, CircleAlert, CircleCheck, CircleX, LoaderCircle, Pause, X } from "lucide-react"
import { Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, type RefObject } from "react"
import { createPortal } from "react-dom"
import { create } from "zustand"
import type { ThreadStatus } from "../app/persist"
import { shortcut } from "../lib/format"

export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ")
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly ref?: Ref<HTMLButtonElement>
  readonly variant?: "primary" | "secondary" | "ghost" | "danger" | "subtle"
  readonly size?: "sm" | "md"
  readonly loading?: boolean
  readonly icon?: ReactNode
  readonly kbd?: string
}

export function Button({ variant = "secondary", size = "md", loading, icon, kbd, children, className, disabled, ...rest }: ButtonProps) {
  return (
    <button {...rest} type={rest.type ?? "button"} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)} disabled={disabled === true || loading === true} aria-busy={loading === true}>
      {loading === true ? <LoaderCircle className="spin" size={14} aria-hidden /> : icon}
      {children !== undefined && <span className="btn-label">{children}</span>}
      {kbd !== undefined && <Kbd keys={kbd} />}
    </button>
  )
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly ref?: Ref<HTMLButtonElement>
  readonly label: string
  readonly active?: boolean
  readonly size?: "sm" | "md"
  readonly kbd?: string
}

export function IconButton({ label, active, size = "md", kbd, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      className={cx("icon-btn", `icon-btn-${size}`, active === true && "is-active", className)}
      aria-label={label}
      aria-pressed={active}
      title={kbd === undefined ? label : `${label}  ${shortcut(kbd)}`}
    >
      {children}
    </button>
  )
}

export function Kbd({ keys, className }: { readonly keys: string; readonly className?: string }) {
  return <kbd className={cx("kbd", className)}>{shortcut(keys)}</kbd>
}

export function Spinner({ size = 14, className }: { readonly size?: number; readonly className?: string }) {
  return <LoaderCircle size={size} className={cx("spin", className)} aria-hidden />
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "Idle",
  running: "Working",
  waiting: "Needs approval",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
}

export function statusLabel(status: ThreadStatus): string {
  return STATUS_LABEL[status]
}

/** Status as icon + color + accessible text; color is never the only signal. */
export function StatusIcon({ status, size = 14 }: { readonly status: ThreadStatus; readonly size?: number }) {
  const label = STATUS_LABEL[status]
  switch (status) {
    case "running":
      return <LoaderCircle size={size} className="spin status-running" aria-label={label} />
    case "waiting":
      return <CircleAlert size={size} className="status-waiting" aria-label={label} />
    case "completed":
      return <CircleCheck size={size} className="status-completed" aria-label={label} />
    case "failed":
      return <CircleX size={size} className="status-failed" aria-label={label} />
    case "stopped":
      return <Pause size={size} className="status-stopped" aria-label={label} />
    default:
      return null
  }
}

/** `art` is drawn in place of the icon, without its box. */
export function EmptyState({ icon, art, title, children, actions }: { readonly icon?: ReactNode; readonly art?: ReactNode; readonly title: string; readonly children?: ReactNode; readonly actions?: ReactNode }) {
  return (
    <div className="empty">
      {art ?? (icon !== undefined && <div className="empty-icon">{icon}</div>)}
      <div className="empty-title">{title}</div>
      {children !== undefined && <div className="empty-body">{children}</div>}
      {actions !== undefined && <div className="empty-actions">{actions}</div>}
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { readonly checked: boolean; readonly onChange: (value: boolean) => void; readonly label: string; readonly disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx("toggle", checked && "is-on")} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  )
}

export interface SegmentOption<T extends string> {
  readonly value: T
  readonly label: ReactNode
  readonly title?: string
  readonly icon?: ReactNode
  /** A count drawn after the label, quieter than it. */
  readonly count?: number
}

/** The raised pill (or tab underline) follows the chosen option; it is measured, so labels can be any width. */
function useThumb(track: RefObject<HTMLElement | null>, selector: string, shape: string): { readonly left: number; readonly width: number } | undefined {
  const [thumb, setThumb] = useState<{ readonly left: number; readonly width: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const measure = (): void => {
      const active = track.current?.querySelector<HTMLElement>(selector)
      setThumb(active === null || active === undefined ? undefined : { left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    // A web font that lands late changes label widths; measure again once fonts are ready.
    void document.fonts?.ready.then(measure)
  }, [track, selector, shape])
  return thumb
}

function shapeOf(options: readonly { readonly value: string; readonly label: ReactNode; readonly count?: number }[], value: string): string {
  return `${value}|${options.map((option) => `${option.value}:${typeof option.label === "string" ? option.label : ""}:${String(option.count ?? "")}`).join(",")}`
}

/** Left and right arrows move the choice, as in a native radio group or tab list. */
function arrowStep<T extends string>(event: ReactKeyboardEvent<HTMLElement>, options: readonly { readonly value: T }[], value: T, choose: (value: T) => void): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  const at = options.findIndex((option) => option.value === value)
  const next = options[(at + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length]
  if (next === undefined) return
  event.preventDefault()
  choose(next.value)
  const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button")
  buttons[options.indexOf(next)]?.focus()
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
  disabled = false,
  iconOnly = false,
}: {
  readonly value: T
  readonly options: readonly SegmentOption<T>[]
  readonly onChange: (value: T) => void
  readonly label: string
  readonly size?: "sm" | "md"
  readonly disabled?: boolean
  /** Draw only each option's icon; its label becomes its name and tooltip. */
  readonly iconOnly?: boolean
}) {
  const track = useRef<HTMLDivElement>(null)
  const thumb = useThumb(track, ".segment.is-active", shapeOf(options, value))
  return (
    <div
      ref={track}
      className={cx("segmented", `segmented-${size}`, iconOnly && "is-icons", disabled && "is-disabled", thumb !== undefined && "has-thumb")}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled}
      onKeyDown={(event) => !disabled && arrowStep(event, options, value, onChange)}
    >
      {thumb !== undefined && <span className="segmented-thumb" aria-hidden style={{ transform: `translateX(${String(thumb.left)}px)`, width: thumb.width }} />}
      {options.map((option) => {
        const name = typeof option.label === "string" ? option.label : undefined
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            aria-label={iconOnly ? name : undefined}
            tabIndex={option.value === value ? 0 : -1}
            className={cx("segment", option.value === value && "is-active")}
            title={option.title ?? (iconOnly ? name : undefined)}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {!iconOnly && option.label}
            {option.count !== undefined && <span className="segment-count">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Page-level tabs: plain labels with an underline that slides to the open one. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  readonly value: T
  readonly options: readonly SegmentOption<T>[]
  readonly onChange: (value: T) => void
  readonly label: string
}) {
  const track = useRef<HTMLDivElement>(null)
  const ink = useThumb(track, ".page-tab.is-active", shapeOf(options, value))
  return (
    <div ref={track} className="page-tabs" role="tablist" aria-label={label} onKeyDown={(event) => arrowStep(event, options, value, onChange)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={cx("page-tab", option.value === value && "is-active")}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
          {option.count !== undefined && <span className="page-tab-count">{option.count}</span>}
        </button>
      ))}
      {ink !== undefined && <span className="page-tabs-ink" aria-hidden style={{ transform: `translateX(${String(ink.left)}px)`, width: ink.width }} />}
    </div>
  )
}

export function useOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const handle = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onOutside()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onOutside()
      }
    }
    document.addEventListener("mousedown", handle)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("mousedown", handle)
      document.removeEventListener("keydown", key, true)
    }
  }, [ref, onOutside, active])
}

/**
 * Menus, popovers, and dialogs on screen. A browser preview is a native view drawn above the page,
 * so it hides while one of these overlaps it.
 */
export const useOverlays = create<readonly HTMLElement[]>()(() => [])

/** A ref for an overlay's element that also lists it in `useOverlays` while it is mounted. */
function useOverlayRef(ref: RefObject<HTMLDivElement | null>): (node: HTMLDivElement | null) => void {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (element === null) return
    useOverlays.setState((list) => [...list, element], true)
    return () => useOverlays.setState((list) => list.filter((item) => item !== element), true)
  }, [element])
  return useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node
      setElement(node)
    },
    [ref],
  )
}

export interface MenuItem {
  readonly id: string
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly hint?: ReactNode
  readonly checked?: boolean
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly description?: ReactNode
  readonly onSelect: () => void
}

export type MenuEntry = MenuItem | { readonly separator: true; readonly id: string } | { readonly heading: string; readonly id: string }

type Side = "bottom" | "top"
interface Placement {
  readonly top: number
  readonly left: number
  readonly maxHeight: number
  readonly side: Side
}
/** Below this much room a panel opens on the other side of its anchor, if that side has more. */
const CRAMPED = 240

function place(rect: { readonly top: number; readonly bottom: number }, side: Side, room = CRAMPED): Omit<Placement, "left"> {
  const above = rect.top - 16
  const below = window.innerHeight - rect.bottom - 16
  const [preferred, other] = side === "top" ? [above, below] : [below, above]
  const actual: Side = preferred < room && other > preferred ? (side === "top" ? "bottom" : "top") : side
  return actual === "top" ? { top: rect.top - 6, maxHeight: above, side: actual } : { top: rect.bottom + 6, maxHeight: below, side: actual }
}

/** A popover menu anchored to a trigger; arrow keys move, Enter selects, Escape closes. */
export function Menu({
  trigger,
  items,
  align = "start",
  side = "bottom",
  width,
  className,
}: {
  readonly trigger: (props: { readonly open: boolean; readonly toggle: () => void; readonly ref: RefObject<HTMLButtonElement | null> }) => ReactNode
  readonly items: readonly MenuEntry[]
  readonly align?: "start" | "end"
  readonly side?: "bottom" | "top"
  readonly width?: number
  readonly className?: string
}) {
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState(0)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const attach = useOverlayRef(panel)
  const [position, setPosition] = useState<Placement | undefined>()
  const selectable = items.filter((item): item is MenuItem => "onSelect" in item && item.disabled !== true)

  // Focus goes back to the trigger before the item runs, so whatever the item opens can hand it back there.
  const select = (item: MenuItem): void => {
    setOpen(false)
    anchor.current?.focus()
    item.onSelect()
  }

  useLayoutEffect(() => {
    if (!open || anchor.current === null) return
    const rect = anchor.current.getBoundingClientRect()
    const menuWidth = width ?? 240
    const left = align === "end" ? Math.max(8, rect.right - menuWidth) : Math.min(rect.left, window.innerWidth - menuWidth - 8)
    setPosition({ left, ...place(rect, side) })
    const checked = selectable.findIndex((item) => item.checked === true)
    setFocus(checked < 0 ? 0 : checked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const handle = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panel.current?.contains(target) === true || anchor.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handle)
    return () => document.removeEventListener("mousedown", handle)
  }, [open])

  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open, position])

  const onKey = (event: ReactKeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      anchor.current?.focus()
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setFocus((value) => (value + 1) % Math.max(1, selectable.length))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setFocus((value) => (value - 1 + selectable.length) % Math.max(1, selectable.length))
    } else if (event.key === "Enter") {
      event.preventDefault()
      const item = selectable[focus]
      if (item !== undefined) select(item)
    }
  }

  return (
    <>
      {trigger({ open, toggle: () => setOpen((value) => !value), ref: anchor })}
      {open &&
        position !== undefined &&
        createPortal(
          <div
            ref={attach}
            className={cx("menu", position.side === "top" && "menu-top", className)}
            role="menu"
            tabIndex={-1}
            onKeyDown={onKey}
            style={{ top: position.top, left: position.left, width: width ?? 240, maxHeight: Math.max(160, position.maxHeight) }}
          >
            {items.map((item) => {
              if ("separator" in item) return <div key={item.id} className="menu-sep" role="separator" />
              if ("heading" in item)
                return (
                  <div key={item.id} className="menu-heading">
                    {item.heading}
                  </div>
                )
              const index = selectable.indexOf(item)
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={cx("menu-item", index === focus && "is-focus", item.danger === true && "is-danger")}
                  disabled={item.disabled}
                  onMouseEnter={() => index >= 0 && setFocus(index)}
                  onClick={() => select(item)}
                >
                  <span className="menu-icon">{item.icon ?? (item.checked === true ? <Check size={14} /> : undefined)}</span>
                  <span className="menu-text">
                    <span className="menu-label">{item.label}</span>
                    {item.description !== undefined && <span className="menu-desc">{item.description}</span>}
                  </span>
                  {item.hint !== undefined && <span className="menu-hint">{item.hint}</span>}
                  {item.icon !== undefined && item.checked === true && <Check size={14} className="menu-check" />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}

/** An anchored panel with arbitrary content (pickers, forms). Closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  width = 280,
  room,
  className,
}: {
  readonly trigger: (props: { readonly open: boolean; readonly toggle: () => void; readonly ref: RefObject<HTMLButtonElement | null> }) => ReactNode
  readonly children: (close: () => void) => ReactNode
  /** `center` sits the panel over the middle of its trigger. */
  readonly align?: "start" | "end" | "center"
  readonly side?: "bottom" | "top"
  readonly width?: number
  /** The height the content wants. With less than this on its side, the panel opens on the side with more. */
  readonly room?: number
  readonly className?: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const attach = useOverlayRef(panel)
  const [position, setPosition] = useState<Placement | undefined>()
  const close = useCallback(() => {
    // A choice made from the keyboard hands focus back to the button that opened the panel.
    if (panel.current?.contains(document.activeElement) === true) anchor.current?.focus()
    setOpen(false)
  }, [])
  useLayoutEffect(() => {
    if (!open || anchor.current === null) return
    const rect = anchor.current.getBoundingClientRect()
    const start = align === "end" ? rect.right - width : align === "center" ? (rect.left + rect.right - width) / 2 : rect.left
    const left = Math.max(8, Math.min(start, window.innerWidth - width - 8))
    setPosition({ left, ...place(rect, side, room) })
  }, [open, align, side, width, room])
  useEffect(() => {
    if (!open) return
    const handle = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panel.current?.contains(target) === true || anchor.current?.contains(target) === true) return
      if ((target as Element).closest?.(".menu") !== null && (target as Element).closest?.(".menu") !== undefined) return
      setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpen(false)
        anchor.current?.focus()
      }
    }
    document.addEventListener("mousedown", handle)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("mousedown", handle)
      document.removeEventListener("keydown", key, true)
    }
  }, [open])
  const placed = position !== undefined
  // Focus moves into the panel once it is on screen, so it can be used without a pointer.
  useEffect(() => {
    if (!open || !placed) return
    const node = panel.current
    ;(node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus()
  }, [open, placed])
  return (
    <>
      {trigger({ open, toggle: () => setOpen((value) => !value), ref: anchor })}
      {open &&
        position !== undefined &&
        createPortal(
          <div
            ref={attach}
            tabIndex={-1}
            className={cx("popover", position.side === "top" && "menu-top", className)}
            style={{ top: position.top, left: position.left, width, maxHeight: Math.max(180, position.maxHeight) }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  )
}

interface SelectChoice {
  readonly value: string
  readonly text: string
  readonly disabled: boolean
  readonly group: string | undefined
}

interface OptionProps {
  readonly value?: string | number
  readonly label?: string
  readonly disabled?: boolean
  readonly children?: ReactNode
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  return Array.isArray(node) ? node.map(textOf).join("") : ""
}

/** The `<option>` and `<optgroup>` children of a Select, in order. */
function choicesOf(children: ReactNode, group?: string): SelectChoice[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child)) return []
    if (child.type === "optgroup") return choicesOf(child.props.children, child.props.label)
    if (child.type !== "option") return []
    const text = textOf(child.props.children)
    return [{ value: String(child.props.value ?? text), text, disabled: child.props.disabled === true, group }]
  })
}

/** How long typed letters keep adding to one search, as in a native select. */
const TYPEAHEAD_MS = 700

/**
 * A select drawn in the app's theme. WebKit opens a native macOS menu for a `<select>` whatever its
 * CSS, so this is a combobox button over a listbox. It takes the same `<option>` and `<optgroup>`
 * children and answers the same keys: arrows, Home and End, Enter or Space to pick, Escape to close,
 * and letters to jump to an option.
 */
export function Select({
  value,
  onChange,
  children,
  label,
  className,
  plain = false,
  disabled,
  title,
}: {
  readonly value: string | number | undefined
  readonly onChange: (value: string) => void
  readonly children: ReactNode
  /** Accessible name, when no visible label wraps the select. */
  readonly label?: string
  readonly className?: string
  /** Without the field box and chevron, for a select its parent dresses. */
  readonly plain?: boolean
  readonly disabled?: boolean
  readonly title?: string
}) {
  const choices = choicesOf(children)
  const next = (from: number, delta: 1 | -1): number => {
    for (let index = from + delta; index >= 0 && index < choices.length; index += delta) if (choices[index]?.disabled === false) return index
    return from
  }
  const first = next(-1, 1)
  const last = next(choices.length, -1)
  const matched = choices.findIndex((choice) => choice.value === String(value ?? ""))
  // A value no option has shows the first option, as a controlled `<select>` does.
  const selected = matched >= 0 ? matched : first
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState<(Placement & { readonly minWidth: number }) | undefined>()
  const anchor = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const attach = useOverlayRef(panel)
  const typed = useRef({ text: "", at: 0 })
  const opened = useRef<DOMRect | undefined>(undefined)
  const id = useId()
  const optionId = (index: number): string => `${id}-${String(index)}`

  const show = (index: number): void => {
    setActive(index)
    setOpen(true)
  }
  const pick = (index: number): void => {
    const choice = choices[index]
    if (choice === undefined || choice.disabled) return
    setOpen(false)
    if (index !== matched) onChange(choice.value)
  }
  const typeahead = (key: string): number | undefined => {
    const now = Date.now()
    const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + key.toLowerCase()
    typed.current = { text, at: now }
    // One letter pressed again and again steps through the options that start with it.
    const repeated = [...text].every((char) => char === text[0])
    const query = repeated ? text.slice(0, 1) : text
    const from = Math.max(0, (open ? active : selected) + (repeated ? 1 : 0))
    for (let offset = 0; offset < choices.length; offset++) {
      const index = (from + offset) % choices.length
      const choice = choices[index]
      if (choice !== undefined && !choice.disabled && choice.text.toLowerCase().startsWith(query)) return index
    }
    return undefined
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const { key } = event
    const letter = key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
    if (letter && (key !== " " || Date.now() - typed.current.at < TYPEAHEAD_MS)) {
      event.preventDefault()
      const found = typeahead(key)
      if (found !== undefined) show(found)
      return
    }
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") show(selected)
      else if (key === "Home") show(first)
      else if (key === "End") show(last)
      else return
      event.preventDefault()
      return
    }
    if (key === "ArrowDown") setActive(next(active, 1))
    else if (key === "ArrowUp") setActive(next(active, -1))
    else if (key === "Home") setActive(first)
    else if (key === "End") setActive(last)
    else if (key === "Enter" || key === " ") {
      if (choices[active]?.disabled === false) pick(active)
      else setOpen(false)
    } else {
      if (key === "Tab") setOpen(false)
      return
    }
    event.preventDefault()
  }

  useLayoutEffect(() => {
    if (!open || anchor.current === null) return
    const rect = anchor.current.getBoundingClientRect()
    opened.current = rect
    setPosition({ left: rect.left, minWidth: rect.width, ...place(rect, "bottom") })
  }, [open])

  // A list wider than the room right of its trigger moves left to stay on screen.
  useLayoutEffect(() => {
    const right = panel.current?.getBoundingClientRect().right
    if (position === undefined || right === undefined) return
    const left = Math.max(8, position.left - (right - (window.innerWidth - 8)))
    if (left < position.left) setPosition({ ...position, left })
  }, [position])

  useLayoutEffect(() => {
    const list = panel.current
    const option = document.getElementById(optionId(active))
    if (!open || list === null || option === null) return
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, position])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // A click on the label around the trigger clicks the trigger too, which closes the list itself.
    const owner = anchor.current?.closest("label") ?? anchor.current
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panel.current?.contains(target) !== true && owner?.contains(target) !== true) close()
    }
    // On window, before the dialog or popover around the select hears Escape on document and closes too.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    // Only a scroll that moves the trigger closes the list; a scroll event that lands late from before it opened does not.
    const scroll = (): void => {
      const now = anchor.current?.getBoundingClientRect()
      const then = opened.current
      if (now !== undefined && then !== undefined && (Math.abs(now.top - then.top) > 1 || Math.abs(now.left - then.left) > 1)) close()
    }
    document.addEventListener("mousedown", outside)
    window.addEventListener("keydown", escape, true)
    window.addEventListener("scroll", scroll, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", outside)
      window.removeEventListener("keydown", escape, true)
      window.removeEventListener("scroll", scroll, true)
      window.removeEventListener("resize", close)
    }
  }, [open])

  const sections: { readonly group: string | undefined; readonly items: number[] }[] = []
  choices.forEach((choice, index) => {
    const tail = sections[sections.length - 1]
    if (tail !== undefined && tail.group === choice.group) tail.items.push(index)
    else sections.push({ group: choice.group, items: [index] })
  })
  const option = (index: number): ReactNode => {
    const choice = choices[index]
    if (choice === undefined) return null
    return (
      <div
        key={index}
        id={optionId(index)}
        role="option"
        aria-selected={index === selected}
        aria-disabled={choice.disabled || undefined}
        className={cx("menu-item", "select-option", index === active && "is-focus")}
        onMouseEnter={() => !choice.disabled && setActive(index)}
        onClick={() => pick(index)}
      >
        <span className="menu-icon">{index === selected && <Check size={14} />}</span>
        <span className="menu-label">{choice.text}</span>
      </div>
    )
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={label}
        title={title}
        disabled={disabled}
        className={cx(!plain && "select", className)}
        onClick={() => {
          // WebKit does not focus a clicked button, and the keys that follow must reach this one.
          anchor.current?.focus({ preventScroll: true })
          if (open) setOpen(false)
          else show(selected)
        }}
        onKeyDown={onKeyDown}
        // Space picks on key down; its key up must not click the trigger and open the list again.
        onKeyUp={(event) => event.key === " " && event.preventDefault()}
      >
        <span className="select-value">
          <span className="select-text">{choices[selected]?.text}</span>
          {choices.map((choice, index) => (
            <span key={index} className="select-sizer" aria-hidden>
              {choice.text}
            </span>
          ))}
        </span>
        {!plain && <ChevronDown size={13} className="select-chevron" aria-hidden />}
      </button>
      {open &&
        position !== undefined &&
        createPortal(
          <div
            ref={attach}
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            className={cx("menu", "select-menu", position.side === "top" && "menu-top")}
            style={{ top: position.top, left: position.left, minWidth: position.minWidth, maxHeight: Math.max(160, position.maxHeight) }}
            // Focus stays on the trigger, which answers the keys while the list is open.
            onMouseDown={(event) => event.preventDefault()}
          >
            {sections.map((section, at) =>
              section.group === undefined ? (
                section.items.map(option)
              ) : (
                <div key={`group-${String(at)}`} role="group" aria-label={section.group}>
                  <div className="menu-heading" aria-hidden>
                    {section.group}
                  </div>
                  {section.items.map(option)}
                </div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

/** Open dialogs, oldest first. Only the last one answers Escape, so a dialog over Settings closes alone. */
const openModals: symbol[] = []
const modalPanels = new Map<symbol, HTMLElement>()

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"

/**
 * Keeps Tab inside the dialog. Focus that fell out of it (the focused control was removed by a step
 * change) comes back to the first control of the body; a menu the dialog opened keeps its own keys.
 */
function trapTab(event: KeyboardEvent, panel: HTMLElement): void {
  const active = document.activeElement
  if (active instanceof Element && active.closest(".menu, .popover") !== null) return
  const all = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.getClientRects().length > 0)
  const first = all[0]
  const last = all[all.length - 1]
  if (first === undefined || last === undefined) return
  let target: HTMLElement | undefined
  if (active === null || !panel.contains(active)) target = all.find((node) => !node.classList.contains("modal-close")) ?? first
  else if (event.shiftKey && active === first) target = last
  else if (!event.shiftKey && active === last) target = first
  if (target === undefined) return
  event.preventDefault()
  target.focus()
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
  className,
}: {
  readonly title: ReactNode
  readonly onClose: () => void
  readonly children: ReactNode
  readonly footer?: ReactNode
  readonly width?: number
  readonly className?: string
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const backdrop = useRef<HTMLDivElement | null>(null)
  const attach = useOverlayRef(backdrop)
  // Callers pass a fresh function each render; reading it through a ref keeps focus where the person put it.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const id = Symbol("modal")
    openModals.push(id)
    if (panel.current !== null) modalPanels.set(id, panel.current)
    const previous = document.activeElement as HTMLElement | null
    // React never renders an `autofocus` attribute, so a dialog marks its preferred control itself.
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>("input, textarea, select, button:not(.modal-close)")
    first?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || openModals[openModals.length - 1] !== id) return
      if (event.key === "Tab" && panel.current !== null) return trapTab(event, panel.current)
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("keydown", key)
      const index = openModals.indexOf(id)
      if (index >= 0) openModals.splice(index, 1)
      modalPanels.delete(id)
      if (previous !== null && previous !== document.body && previous.isConnected) return previous.focus()
      // The control that opened this dialog is gone (its list changed): the dialog underneath takes focus back.
      const under = openModals[openModals.length - 1]
      const beneath = under === undefined ? undefined : modalPanels.get(under)
      Array.from(beneath?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        .find((node) => !node.classList.contains("modal-close") && node.getClientRects().length > 0)
        ?.focus()
    }
  }, [])
  return createPortal(
    <div ref={attach} className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className={cx("modal", className)} role="dialog" aria-modal aria-label={typeof title === "string" ? title : undefined} style={{ width }}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <IconButton label="Close" size="sm" className="modal-close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** Drag handle that resizes a side panel; reports the new width. */
export function Resizer({
  side,
  width,
  min,
  max,
  onResize,
}: {
  readonly side: "left" | "right"
  readonly width: number
  readonly min: number
  readonly max: number
  readonly onResize: (width: number) => void
}) {
  const start = useRef<{ x: number; width: number } | undefined>(undefined)
  return (
    <div
      className={cx("resizer", `resizer-${side}`)}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16
        if (event.key === "ArrowLeft") onResize(Math.max(min, Math.min(max, width + (side === "left" ? step : -step))))
        if (event.key === "ArrowRight") onResize(Math.max(min, Math.min(max, width + (side === "left" ? -step : step))))
      }}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width }
        event.currentTarget.setPointerCapture(event.pointerId)
        document.body.classList.add("is-resizing")
      }}
      onPointerMove={(event) => {
        if (start.current === undefined) return
        const delta = event.clientX - start.current.x
        const next = side === "right" ? start.current.width + delta : start.current.width - delta
        onResize(Math.round(Math.max(min, Math.min(max, next))))
      }}
      onPointerUp={() => endResize(start)}
      // A drag the system takes over (a gesture, a window switch) ends too, or the app stays in resize mode.
      onPointerCancel={() => endResize(start)}
      onLostPointerCapture={() => endResize(start)}
    />
  )
}

function endResize(start: { current: { x: number; width: number } | undefined }): void {
  start.current = undefined
  document.body.classList.remove("is-resizing")
}

/** Re-renders every `interval` ms while `active`; used for elapsed timers. */
export function useTicker(active: boolean, interval = 1_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [active, interval])
  return now
}

export function CopyButton({ text, label = "Copy" }: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label={copied ? "Copied" : label}
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1_400)
        })
      }}
    >
      {copied ? <Check size={13} /> : <CopyIcon />}
    </IconButton>
  )
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  )
}
