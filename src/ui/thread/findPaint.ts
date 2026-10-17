/**
 * Marks find matches in the rows on screen with the CSS Custom Highlight API, which leaves the
 * DOM React owns untouched. A webview without it still scrolls to the match and outlines its row.
 */

const ALL = "runrail-find"
const CURRENT = "runrail-find-current"

interface Registry {
  set(name: string, highlight: Highlight): void
  delete(name: string): void
}

function registry(): Registry | undefined {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined") return undefined
  return (CSS as unknown as { readonly highlights?: Registry }).highlights
}

/**
 * Highlights every occurrence of `query` under `root`. The current match is the `rank`-th
 * occurrence inside the row `currentRow` (its `data-index`), or that row's last one drawn when
 * fewer are on screen, as when the match is in tool output that is folded away.
 */
export function paintFind(root: HTMLElement, query: string, currentRow: number | undefined, rank: number): Range | undefined {
  const highlights = registry()
  if (highlights === undefined) return undefined
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) {
    clearFind()
    return undefined
  }
  const all: Range[] = []
  const inRow: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue ?? ""
    const text = value.toLowerCase()
    // Lower case can change a string's length; offsets then no longer line up, so that node is skipped.
    if (text.length !== value.length) continue
    const row = currentRow !== undefined && node.parentElement?.closest(`[data-index="${String(currentRow)}"]`) != null
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      all.push(range)
      if (row) inRow.push(range)
    }
  }
  highlights.set(ALL, new Highlight(...all))
  const current = inRow[Math.min(rank, inRow.length - 1)]
  if (current === undefined) highlights.delete(CURRENT)
  else highlights.set(CURRENT, new Highlight(current))
  return current
}

/** Scrolls `root` so `range` sits mid-view, when it is outside it: a tall reply's match may be far from the row's middle. */
export function revealRange(root: HTMLElement, range: Range): void {
  const box = range.getBoundingClientRect()
  const view = root.getBoundingClientRect()
  if (box.top >= view.top && box.bottom <= view.bottom) return
  root.scrollTop += box.top - view.top - view.height / 2
}

export function clearFind(): void {
  const highlights = registry()
  highlights?.delete(ALL)
  highlights?.delete(CURRENT)
}
