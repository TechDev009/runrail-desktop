/**
 * A long paste sits in the composer as one line, "[Pasted text #1, 120 lines]", and goes out in
 * full when the message is sent. Deleting the line drops the paste.
 */

export interface PastedBlock {
  readonly id: number
  readonly text: string
}

export function pastePlaceholder(block: PastedBlock): string {
  const lines = block.text.split("\n").length
  return `[Pasted text #${String(block.id)}, ${String(lines)} ${lines === 1 ? "line" : "lines"}]`
}

/** Folds a paste longer than `threshold` characters; 0 never folds. */
export function shouldFold(text: string, threshold: number): boolean {
  return threshold > 0 && text.length > threshold
}

export function expandPastes(text: string, blocks: readonly PastedBlock[]): string {
  let expanded = text
  for (const block of blocks) expanded = expanded.split(pastePlaceholder(block)).join(block.text)
  return expanded
}

export function nextPasteId(blocks: readonly PastedBlock[]): number {
  return blocks.reduce((highest, block) => Math.max(highest, block.id), 0) + 1
}
