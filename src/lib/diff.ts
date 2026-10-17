/** Unified diff parsing for the review pane and inline edit previews. */

export type LineKind = "context" | "add" | "del"

export interface DiffLine {
  readonly kind: LineKind
  readonly text: string
  readonly oldNumber?: number
  readonly newNumber?: number
}

export interface Hunk {
  readonly header: string
  readonly oldStart: number
  readonly newStart: number
  readonly lines: readonly DiffLine[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Parses the hunks of one file's patch. File headers are skipped. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: { header: string; oldStart: number; newStart: number; lines: DiffLine[] }[] = []
  let current: { header: string; oldStart: number; newStart: number; lines: DiffLine[] } | undefined
  let oldLine = 0
  let newLine = 0
  for (const raw of patch.split("\n")) {
    const match = HUNK.exec(raw)
    if (match !== null) {
      oldLine = Number(match[1])
      newLine = Number(match[3])
      current = { header: (match[5] ?? "").trim(), oldStart: oldLine, newStart: newLine, lines: [] }
      hunks.push(current)
      continue
    }
    if (current === undefined) continue
    if (raw.startsWith("\\")) continue
    const marker = raw[0]
    const text = raw.slice(1)
    if (marker === "+") current.lines.push({ kind: "add", text, newNumber: newLine++ })
    else if (marker === "-") current.lines.push({ kind: "del", text, oldNumber: oldLine++ })
    else if (marker === " " || raw.length === 0) current.lines.push({ kind: "context", text, oldNumber: oldLine++, newNumber: newLine++ })
  }
  // A trailing empty line from the final newline is not content.
  const last = hunks[hunks.length - 1]
  const tail = last?.lines[last.lines.length - 1]
  if (last !== undefined && tail?.kind === "context" && tail.text.length === 0) last.lines.pop()
  return hunks
}

export interface SplitRow {
  readonly left?: DiffLine
  readonly right?: DiffLine
}

/** Pairs deletions with additions so a split view lines them up side by side. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    const count = Math.max(dels.length, adds.length)
    for (let index = 0; index < count; index += 1) {
      const left = dels[index]
      const right = adds[index]
      rows.push({ ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) })
    }
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.kind === "del") dels.push(line)
    else if (line.kind === "add") adds.push(line)
    else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

/** Builds a minimal unified patch from an edit's old and new text (for inline previews). */
export function editLines(oldText: string, newText: string): DiffLine[] {
  const before = oldText.split("\n")
  const after = newText.split("\n")
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  const lines: DiffLine[] = []
  const context = 2
  for (let index = Math.max(0, prefix - context); index < prefix; index += 1) lines.push({ kind: "context", text: before[index] ?? "" })
  for (let index = prefix; index < before.length - suffix; index += 1) lines.push({ kind: "del", text: before[index] ?? "" })
  for (let index = prefix; index < after.length - suffix; index += 1) lines.push({ kind: "add", text: after[index] ?? "" })
  for (let index = after.length - suffix; index < Math.min(after.length, after.length - suffix + context); index += 1) lines.push({ kind: "context", text: after[index] ?? "" })
  return lines
}

export function countLines(lines: readonly DiffLine[]): { readonly additions: number; readonly deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.kind === "add") additions += 1
    else if (line.kind === "del") deletions += 1
  }
  return { additions, deletions }
}
