import { parseHunks } from "../lib/diff"

/**
 * A coding tool's review of a pull request: what it is asked to end with, how that
 * block is read back, and what of it would go to GitHub. Pure, so each case is a test.
 */

export type Severity = "high" | "medium" | "low"

export interface Finding {
  readonly severity: Severity
  readonly title: string
  readonly body?: string
  readonly path?: string
  readonly line?: number
}

export type FindingsResult =
  | { readonly state: "ok"; readonly summary?: string; readonly findings: readonly Finding[]; readonly dropped: number }
  | { readonly state: "missing" | "invalid" }

const MAX_FINDINGS = 50
const MAX_TEXT = 200_000

/** The block every route can produce without MCP. Severity words, never numbers, so it reads aloud. */
export const FINDINGS_FORMAT = [
  "End your final message with exactly one fenced code block tagged json, and nothing after it, in this shape:",
  "```json",
  '{"summary": "one or two sentences on the change and its risk", "findings": [{"severity": "high", "path": "src/file.ts", "line": 42, "title": "short statement of the problem", "body": "why it matters and what to do"}]}',
  "```",
  "severity is high, medium, or low. path and line are where the problem is in the changed code, as it is after the change; leave them out when the finding is about the change as a whole. Use an empty findings list when you find nothing worth raising.",
].join("\n")

/** The prompt a review thread starts with. The diff stays in the worktree; the tool reads it there. */
export function reviewPrompt(input: { readonly owner: string; readonly repo: string; readonly number: number; readonly title?: string; readonly base?: string; readonly focus?: string }): string {
  const focus = input.focus?.trim()
  return [
    `Review pull request #${String(input.number)} in ${input.owner}/${input.repo}${input.title === undefined ? "" : `: ${input.title}`}.`,
    `This worktree is checked out at the pull request's head. Compare it with ${input.base === undefined ? "its base branch" : `origin/${input.base}`} (for example \`git diff --merge-base origin/${input.base ?? "main"}\`) and read the changed files.`,
    "You are reviewing only: do not edit files, commit, push, or run commands that change anything. Runrail runs the checks.",
    "Look for bugs, security problems, missing tests, and changes that break callers. Skip style nits.",
    ...(focus === undefined || focus.length === 0 ? [] : [`Pay particular attention to: ${focus}`]),
    "",
    FINDINGS_FORMAT,
  ].join("\n")
}

/** Reads the last json block of a final message. Bad entries are dropped and counted, never guessed at. */
export function parseFindings(message: string): FindingsResult {
  const text = message.length > MAX_TEXT ? message.slice(-MAX_TEXT) : message
  const blocks = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)]
  const raw = blocks[blocks.length - 1]?.[1]
  if (raw === undefined) return { state: "missing" }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { state: "invalid" }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { state: "invalid" }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.findings)) return { state: "invalid" }
  const findings = record.findings.slice(0, MAX_FINDINGS).map(findingOf).filter((finding) => finding !== undefined)
  const summary = typeof record.summary === "string" && record.summary.trim().length > 0 ? record.summary.trim().slice(0, 2_000) : undefined
  return { state: "ok", ...(summary === undefined ? {} : { summary }), findings, dropped: record.findings.length - findings.length }
}

function findingOf(value: unknown): Finding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const severity = item.severity === "high" || item.severity === "medium" || item.severity === "low" ? item.severity : undefined
  const title = typeof item.title === "string" ? item.title.trim().slice(0, 200) : ""
  if (severity === undefined || title.length === 0) return undefined
  const body = typeof item.body === "string" && item.body.trim().length > 0 ? item.body.trim().slice(0, 4_000) : undefined
  const path = typeof item.path === "string" && /^[^\0\r\n]{1,1024}$/.test(item.path) && !item.path.startsWith("/") && !item.path.split("/").includes("..") ? item.path.replace(/^\.\//, "") : undefined
  const line = path !== undefined && typeof item.line === "number" && Number.isSafeInteger(item.line) && item.line >= 1 ? item.line : undefined
  return { severity, title, ...(body === undefined ? {} : { body }), ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) }
}

export interface ReviewPost {
  readonly body: string
  readonly comments: readonly { readonly path: string; readonly line: number; readonly side: "RIGHT"; readonly body: string }[]
}

/** The lines of each file a comment may sit on: the new side of its hunks, added or unchanged. */
export function commentableLines(patch: string): ReadonlySet<number> {
  const lines = new Set<number>()
  for (const hunk of parseHunks(patch)) for (const line of hunk.lines) if (line.newNumber !== undefined) lines.add(line.newNumber)
  return lines
}

/**
 * What would go to GitHub for the findings the person kept: a finding on a line in the diff
 * becomes a comment there, any other a point in the review body.
 */
export function planPost(findings: readonly Finding[], patches: ReadonlyMap<string, string>, tool: string): ReviewPost {
  const lines = new Map<string, ReadonlySet<number>>()
  const comments: ReviewPost["comments"][number][] = []
  const points: string[] = []
  for (const finding of findings) {
    const patch = finding.path === undefined ? undefined : patches.get(finding.path)
    let onLine = false
    if (finding.path !== undefined && finding.line !== undefined && patch !== undefined) {
      const known = lines.get(finding.path) ?? commentableLines(patch)
      lines.set(finding.path, known)
      onLine = known.has(finding.line)
    }
    if (onLine && finding.path !== undefined && finding.line !== undefined) {
      comments.push({ path: finding.path, line: finding.line, side: "RIGHT", body: `**${label(finding.severity)}: ${finding.title}**${finding.body === undefined ? "" : `\n\n${finding.body}`}` })
      continue
    }
    const where = finding.path === undefined ? "" : ` (\`${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`}\`)`
    points.push(`- **${label(finding.severity)}: ${finding.title}**${where}${finding.body === undefined ? "" : ` ${finding.body.replace(/\s*\n\s*/g, " ")}`}`)
  }
  const total = findings.length
  const head = `Review by ${tool}, through Runrail: ${String(total)} finding${total === 1 ? "" : "s"}${comments.length > 0 ? `, ${String(comments.length)} on lines below` : ""}.`
  return { body: [head, ...(points.length > 0 ? ["", ...points] : [])].join("\n"), comments }
}

function label(severity: Severity): string {
  return severity === "high" ? "High" : severity === "medium" ? "Medium" : "Low"
}
