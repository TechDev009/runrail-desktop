import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual"
import { useLayoutEffect, useState, type RefObject } from "react"

/** How far below the top of its scroller a virtual list starts: the scroller's padding and anything above the list. */
export function useListOffset(scroller: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, key: unknown): number {
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => {
    const outer = scroller.current
    const inner = list.current
    if (outer === null || inner === null) return
    setOffset(Math.max(0, Math.round(inner.getBoundingClientRect().top - outer.getBoundingClientRect().top + outer.scrollTop)))
  }, [scroller, list, key])
  return offset
}

/** The rows in view plus `pinned`, so scrolling away does not unmount a row holding focus, such as a half-written comment. */
export function keepMounted(pinned: number | undefined): (range: Range) => number[] {
  return (range) => {
    const indexes = defaultRangeExtractor(range)
    if (pinned === undefined || pinned < 0 || pinned >= range.count || indexes.includes(pinned)) return indexes
    return [...indexes, pinned].sort((left, right) => left - right)
  }
}
