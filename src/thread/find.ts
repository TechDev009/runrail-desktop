import { displayPrompt, type TimelineItem, type ToolItem } from "./reducer"

/**
 * Find in thread: the words a search reads in each item, and every place they
 * match. Only what the timeline already holds is searched; earlier history that was never loaded
 * is not.
 */

/** More matches than this are not counted one by one. */
export const MAX_MATCHES = 1_000

/** One occurrence: the item it is in, and which occurrence in that item's words it is. */
export interface FindMatch {
  readonly key: string
  readonly nth: number
}

/** How a tool's title reads on screen; the timeline passes its own, which says "Edited" for a finished edit. */
export type TitleOf = (item: ToolItem) => string

const plainTitle: TitleOf = (item) => item.presentation.title || item.name

/** Messages, replies, thinking, tool titles and their output, plan steps, and what an approval asks. */
export function searchText(item: TimelineItem, titleOf: TitleOf = plainTitle): string {
  switch (item.kind) {
    case "user":
      return displayPrompt(item.text)
    case "assistant":
    case "reasoning":
      return item.text
    case "tool":
      return `${titleOf(item)}\n${item.output ?? ""}`
    case "plan":
      return [item.explanation ?? "", ...item.steps.map((step) => step.text)].join("\n")
    case "approval":
      return item.action
    default:
      return ""
  }
}

/** Every case-insensitive occurrence of `query`, in timeline order, at most MAX_MATCHES. */
export function findMatches(items: readonly TimelineItem[], query: string, titleOf: TitleOf = plainTitle): FindMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return []
  const matches: FindMatch[] = []
  for (const item of items) {
    const text = searchText(item, titleOf).toLocaleLowerCase()
    let nth = 0
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      matches.push({ key: item.key, nth })
      if (matches.length >= MAX_MATCHES) return matches
      nth += 1
    }
  }
  return matches
}

/** The match after (or before) `current`, round the ends. */
export function stepMatch(count: number, current: number, step: 1 | -1): number {
  if (count === 0) return 0
  return (((current + step) % count) + count) % count
}
