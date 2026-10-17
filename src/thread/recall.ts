/**
 * The engine adds recalled memories after the person's message, as a `[Runrail recalled
 * memories]` block every route reads (engine `src/memory/block.ts` writes it). The bubble hides
 * the block (`displayPrompt`) and shows it as its own card, read back from the message, so a
 * reopened thread shows what the agent was given too.
 */

export interface RecalledMemory {
  readonly n: number
  /** Where it came from, in words: "project memory, from release.md". */
  readonly label: string
  readonly text: string
}

const OPEN = "[Runrail recalled memories:"
const CLOSE = "\n[End recalled memories]"

/** The memories in a sent message and the note on how they were found, or nothing when it has none. */
export function recalledIn(text: string): { readonly recalled?: readonly RecalledMemory[]; readonly recallNote?: string } {
  const start = text.indexOf(`\n\n${OPEN}`)
  if (start < 0) return {}
  const end = text.indexOf(CLOSE, start)
  if (end < 0) return {}
  const lines = text
    .slice(start + 2, end)
    .split("\n")
    .slice(1)
  const recalled = lines.flatMap((line) => {
    const match = /^\[m(\d{1,2})\] ([^:]{1,200}): (.*)$/.exec(line)
    return match === null ? [] : [{ n: Number(match[1]), label: match[2] ?? "", text: match[3] ?? "" }]
  })
  const note = lines.find((line) => line.startsWith("[note] "))?.slice(7)
  return { ...(recalled.length === 0 ? {} : { recalled }), ...(note === undefined ? {} : { recallNote: note }) }
}
