import { ChevronDown, ChevronUp, X } from "lucide-react"
import { useEffect, useRef } from "react"
import { MAX_MATCHES } from "../../thread/find"
import { IconButton } from "../common"

/** Find in thread: Return and Shift+Return step through the matches, Escape closes. */
export function FindBar({ query, count, current, focus, onQuery, onStep, onClose }: {
  readonly query: string
  readonly count: number
  readonly current: number
  /** Changes each time the shortcut asks for the bar, so a second press selects the words again. */
  readonly focus: number
  readonly onQuery: (query: string) => void
  readonly onStep: (step: 1 | -1) => void
  readonly onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focus])
  const searched = query.trim().length > 0
  const status = !searched ? "" : count === 0 ? "No results" : `${String(current + 1)} of ${String(count)}${count >= MAX_MATCHES ? "+" : ""}`
  return (
    <div className="find-bar" role="search">
      <input
        ref={input}
        className="find-input"
        type="text"
        value={query}
        placeholder="Find in thread"
        aria-label="Find in thread"
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          } else if (event.key === "Escape") {
            // Escape also stops a running turn elsewhere; here it only closes the bar.
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {status}
      </span>
      <IconButton size="sm" label="Previous match" disabled={count === 0} onClick={() => onStep(-1)}>
        <ChevronUp size={13} />
      </IconButton>
      <IconButton size="sm" label="Next match" disabled={count === 0} onClick={() => onStep(1)}>
        <ChevronDown size={13} />
      </IconButton>
      <IconButton size="sm" label="Close find" onClick={onClose}>
        <X size={13} />
      </IconButton>
    </div>
  )
}
