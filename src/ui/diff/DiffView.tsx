import { Columns2, MessageSquarePlus, Rows2, X } from "lucide-react"
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from "react"
import type { LineComment } from "../../app/reviewMemory"
import { parseHunks, splitRows, type DiffLine, type Hunk } from "../../lib/diff"
import { tokenize, tokenized, tokenStyle, type ThemedToken } from "../../lib/highlight"
import { Button, cx, type SegmentOption } from "../common"

/** The two ways a diff can be laid out, for the segmented controls that switch between them. */
export const DIFF_LAYOUTS: readonly SegmentOption<"unified" | "split">[] = [
  { value: "unified", label: "Unified", icon: <Rows2 size={13} /> },
  { value: "split", label: "Split", icon: <Columns2 size={13} /> },
]

/** A file that was only added or only deleted has one side; side by side would leave the other blank. */
export function layoutFor(change: string, preferred: "unified" | "split"): "unified" | "split" {
  return change === "added" || change === "deleted" || change === "untracked" ? "unified" : preferred
}

/** Syntax-highlighted unified or split diff with optional inline review comments. */

const LARGE_DIFF = 3_000
const LINE_HEIGHT = 19
const HUNK_HEIGHT = 26
const NOTE_HEIGHT = 40

export interface PatchShape {
  readonly lines: number
  readonly hunks: number
}

/** A patch's line and hunk counts, read once so sizing and auto-expanding need not rescan it. */
export function patchShape(patch: string | undefined): PatchShape {
  if (patch === undefined) return { lines: 0, hunks: 0 }
  let lines = 0
  let hunks = 0
  for (let start = 0; start < patch.length; ) {
    if (patch.startsWith("@@", start)) hunks += 1
    const end = patch.indexOf("\n", start)
    if (end < 0) break
    lines += 1
    start = end + 1
  }
  return { lines, hunks }
}

/** About how tall a patch renders, so a virtual list places rows near their place before it measures them. */
export function patchHeight(shape: PatchShape, showLarge = false): number {
  if (shape.lines === 0) return NOTE_HEIGHT
  if (shape.lines > LARGE_DIFF && !showLarge) return NOTE_HEIGHT + 8
  return (shape.lines - shape.hunks) * LINE_HEIGHT + shape.hunks * HUNK_HEIGHT
}

export type { LineComment }

interface Tokens {
  readonly old?: ThemedToken[][]
  readonly new?: ThemedToken[][]
}

interface Indexed {
  readonly line: DiffLine
  readonly oldIndex?: number
  readonly newIndex?: number
}

function indexLines(lines: readonly DiffLine[]): { readonly indexed: readonly Indexed[]; readonly oldText: string; readonly newText: string } {
  const oldParts: string[] = []
  const newParts: string[] = []
  const indexed = lines.map((line): Indexed => {
    const entry: { line: DiffLine; oldIndex?: number; newIndex?: number } = { line }
    if (line.kind !== "add") {
      entry.oldIndex = oldParts.length
      oldParts.push(line.text)
    }
    if (line.kind !== "del") {
      entry.newIndex = newParts.length
      newParts.push(line.text)
    }
    return entry
  })
  return { indexed, oldText: oldParts.join("\n"), newText: newParts.join("\n") }
}

function readyTokens(oldText: string, newText: string, path: string | undefined, enabled: boolean): Tokens {
  if (!enabled || path === undefined) return {}
  const oldTokens = oldText.length > 0 ? tokenized(oldText, path) : undefined
  const newTokens = newText.length > 0 ? tokenized(newText, path) : undefined
  return { ...(oldTokens === undefined ? {} : { old: oldTokens }), ...(newTokens === undefined ? {} : { new: newTokens }) }
}

function useTokens(oldText: string, newText: string, path: string | undefined, enabled: boolean): Tokens {
  // A row a virtual list mounts again paints highlighted at once instead of flashing plain.
  const [tokens, setTokens] = useState<Tokens>(() => readyTokens(oldText, newText, path, enabled))
  useEffect(() => {
    if (!enabled || path === undefined) return
    let live = true
    void Promise.all([oldText.length > 0 ? tokenize(oldText, path) : undefined, newText.length > 0 ? tokenize(newText, path) : undefined]).then(([oldTokens, newTokens]) => {
      if (live) setTokens({ ...(oldTokens === undefined ? {} : { old: oldTokens }), ...(newTokens === undefined ? {} : { new: newTokens }) })
    })
    return () => {
      live = false
    }
  }, [oldText, newText, path, enabled])
  return tokens
}

function Code({ text, tokens }: { readonly text: string; readonly tokens?: ThemedToken[] }) {
  if (tokens === undefined) return <>{text.length === 0 ? " " : text}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className="tok" style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
      {tokens.length === 0 && " "}
    </>
  )
}

function lineTokens(entry: Indexed, tokens: Tokens): ThemedToken[] | undefined {
  if (entry.line.kind === "del") return entry.oldIndex === undefined ? undefined : tokens.old?.[entry.oldIndex]
  return entry.newIndex === undefined ? undefined : tokens.new?.[entry.newIndex]
}

function CommentBox({ onSubmit, onCancel }: { readonly onSubmit: (text: string) => void; readonly onCancel: () => void }) {
  const [text, setText] = useState("")
  return (
    <div className="diff-comment-box">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder="Leave a note for the agent…"
        aria-label="Review comment"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (text.trim().length > 0) onSubmit(text.trim())
          }
          if (event.key === "Escape") onCancel()
        }}
      />
      <div className="diff-comment-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={text.trim().length === 0} onClick={() => onSubmit(text.trim())} kbd="mod+enter">
          Add comment
        </Button>
      </div>
    </div>
  )
}

const SEVERITY_WORD: Readonly<Record<NonNullable<LineComment["severity"]>, string>> = { high: "High", medium: "Medium", low: "Low" }

function CommentList({ comments, onRemove }: { readonly comments: readonly LineComment[]; readonly onRemove?: (id: string) => void }) {
  if (comments.length === 0) return null
  return (
    <div className="diff-comments">
      {comments.map((comment) => (
        <div key={comment.id} className={cx("diff-comment", comment.from !== undefined && "is-review")}>
          {comment.from !== undefined && (
            <span className={cx("diff-comment-from", comment.severity !== undefined && `sev-${comment.severity}`)}>
              {comment.severity === undefined ? comment.from : `${SEVERITY_WORD[comment.severity]} · ${comment.from}`}
            </span>
          )}
          <span className="diff-comment-text">{comment.text}</span>
          {onRemove !== undefined && (
            <button type="button" className="diff-comment-remove" aria-label="Remove comment" onClick={() => onRemove(comment.id)}>
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

interface ViewProps {
  readonly lines: readonly DiffLine[]
  readonly path?: string
  readonly mode?: "unified" | "split"
  readonly numbers?: boolean
  readonly comments?: readonly LineComment[]
  readonly onComment?: (comment: Omit<LineComment, "id">) => void
  readonly onRemoveComment?: (id: string) => void
  readonly hunkStarts?: ReadonlyMap<number, string>
  /** Shows a diff past the size hidden by default; set by a virtual list, which unmounts rows scrolled away. */
  readonly showLarge?: boolean
  readonly onShowLarge?: () => void
}

/** Renders diff lines. Hunk headers can be injected at line offsets via `hunkStarts`. */
export const DiffLines = memo(function DiffLines({ lines, path, mode = "unified", numbers = true, comments = [], onComment, onRemoveComment, hunkStarts, showLarge, onShowLarge }: ViewProps) {
  const [force, setForce] = useState(false)
  const [commenting, setCommenting] = useState<string | undefined>()
  const large = lines.length > LARGE_DIFF && !(showLarge ?? force)
  const { indexed, oldText, newText } = useMemo(() => indexLines(lines), [lines])
  const tokens = useTokens(oldText, newText, path, !large)

  if (large)
    return (
      <div className="diff-large">
        <span>Large diff ({lines.length.toLocaleString()} lines) is hidden to keep the app responsive.</span>
        <Button size="sm" onClick={() => (onShowLarge === undefined ? setForce(true) : onShowLarge())}>
          Show diff
        </Button>
      </div>
    )

  const commentsAt = (side: "old" | "new", line: number | undefined): LineComment[] => (line === undefined ? [] : comments.filter((comment) => comment.side === side && comment.line === line))
  const anchor = (line: DiffLine): { side: "old" | "new"; number?: number } => (line.kind === "del" ? { side: "old", ...(line.oldNumber === undefined ? {} : { number: line.oldNumber }) } : { side: "new", ...(line.newNumber === undefined ? {} : { number: line.newNumber }) })
  const commentKey = (line: DiffLine): string => {
    const target = anchor(line)
    return `${target.side}:${String(target.number ?? -1)}`
  }
  const addButton = (line: DiffLine): ReactNode => {
    const target = anchor(line)
    if (onComment === undefined || target.number === undefined) return null
    return (
      <button type="button" className="diff-add-comment" aria-label={`Comment on line ${String(target.number)}`} onClick={() => setCommenting(commentKey(line))}>
        <MessageSquarePlus size={12} />
      </button>
    )
  }
  const afterLine = (line: DiffLine): ReactNode => {
    const target = anchor(line)
    const here = commentsAt(target.side, target.number)
    const open = commenting === commentKey(line)
    if (here.length === 0 && !open) return null
    return (
      <div className="diff-after">
        <CommentList comments={here} {...(onRemoveComment === undefined ? {} : { onRemove: onRemoveComment })} />
        {open && onComment !== undefined && target.number !== undefined && (
          <CommentBox
            onCancel={() => setCommenting(undefined)}
            onSubmit={(text) => {
              onComment({ path: path ?? "", line: target.number ?? 0, side: target.side, text, excerpt: line.text.slice(0, 240) })
              setCommenting(undefined)
            }}
          />
        )}
      </div>
    )
  }

  if (mode === "split") {
    const rows = splitRows(lines)
    const byLine = new Map(indexed.map((entry) => [entry.line, entry]))
    const positions = new Map(lines.map((line, position) => [line, position]))
    return (
      <div className={cx("diff", "diff-split", !numbers && "no-numbers")} role="table" aria-label={path === undefined ? "Diff" : `Diff of ${path}`}>
        {rows.map((row, index) => {
          const left = row.left === undefined ? undefined : byLine.get(row.left)
          const right = row.right === undefined ? undefined : byLine.get(row.right)
          const leftKind = row.left === undefined ? "empty" : row.left.kind === "context" ? "context" : "del"
          const rightKind = row.right === undefined ? "empty" : row.right.kind === "context" ? "context" : "add"
          const first = row.left ?? row.right
          const header = first === undefined ? undefined : hunkStarts?.get(positions.get(first) ?? -1)
          return (
            <Fragment key={index}>
              {header !== undefined && <div className="diff-hunk">{header}</div>}
              <div className="diff-split-row" role="row">
                <div className={cx("diff-cell", `is-${leftKind}`)}>
                  {numbers && <span className="diff-no">{row.left?.oldNumber ?? ""}</span>}
                  <span className="diff-code">{left === undefined ? "" : <Code text={left.line.text} tokens={lineTokens(left, tokens)} />}</span>
                  {row.left !== undefined && row.left.kind === "del" && addButton(row.left)}
                </div>
                <div className={cx("diff-cell", `is-${rightKind}`)}>
                  {numbers && <span className="diff-no">{row.right?.newNumber ?? ""}</span>}
                  <span className="diff-code">{right === undefined ? "" : <Code text={right.line.text} tokens={lineTokens(right, tokens)} />}</span>
                  {row.right !== undefined && addButton(row.right)}
                </div>
              </div>
              {row.left !== undefined && row.left.kind === "del" && afterLine(row.left)}
              {row.right !== undefined && afterLine(row.right)}
            </Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <div className={cx("diff", "diff-unified", !numbers && "no-numbers")} role="table" aria-label={path === undefined ? "Diff" : `Diff of ${path}`}>
      {indexed.map((entry, index) => {
        const header = hunkStarts?.get(index)
        return (
          <Fragment key={index}>
            {header !== undefined && <div className="diff-hunk">{header}</div>}
            <div className={cx("diff-row", `is-${entry.line.kind}`)} role="row">
              {numbers && <span className="diff-no">{entry.line.oldNumber ?? ""}</span>}
              {numbers && <span className="diff-no">{entry.line.newNumber ?? ""}</span>}
              <span className="diff-marker" aria-hidden>
                {entry.line.kind === "add" ? "+" : entry.line.kind === "del" ? "-" : " "}
              </span>
              <span className="diff-code">
                <Code text={entry.line.text} tokens={lineTokens(entry, tokens)} />
              </span>
              {addButton(entry.line)}
            </div>
            {afterLine(entry.line)}
          </Fragment>
        )
      })}
    </div>
  )
})

/** A whole file patch: hunks parsed, headers shown between them. */
export const PatchView = memo(function PatchView(props: Omit<ViewProps, "lines" | "hunkStarts"> & { readonly patch: string }) {
  const { lines, starts } = useMemo(() => {
    const hunks: Hunk[] = parseHunks(props.patch)
    const all: DiffLine[] = []
    const map = new Map<number, string>()
    for (const hunk of hunks) {
      map.set(all.length, `@@ -${String(hunk.oldStart)} +${String(hunk.newStart)} @@${hunk.header.length > 0 ? `  ${hunk.header}` : ""}`)
      all.push(...hunk.lines)
    }
    return { lines: all, starts: map }
  }, [props.patch])
  if (lines.length === 0) return <div className="diff-empty">No textual changes</div>
  return <DiffLines {...props} lines={lines} hunkStarts={starts} />
})
