import { z } from "zod"
import { getHost, toHostError } from "../host"
import { parseOr } from "../protocol/schemas"
import { openDialog, openInBrowser } from "./actions"
import { isCode, useDiagnostics, type Diagnostics } from "./diagnostics"
import { get } from "./store"

/**
 * "Report a problem": a report the person reads before anything leaves this machine, and that only
 * leaves when they copy it or open the issue themselves. It is built from versions, the system, the
 * engine's check names and levels, and diagnostics codes and counts, and from nothing else, so no
 * prompt, transcript, tool output, file, project, path, connection, account, or key can reach it.
 */

const ISSUES = "https://github.com/TechDev009/runrail-desktop/issues/new"
/** Longer links are refused by some browsers and servers; Copy always has the whole report. */
export const MAX_ISSUE_URL = 7_000

/** Names and versions as the engine and systems spell them; anything else is left out. */
const Plain = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9 ._()+-]+$/)
const Level = z.enum(["ok", "warn", "fail", "off"])

const FactsSchema = z.object({
  os: Plain(32).catch("unknown"),
  arch: Plain(32).catch("unknown"),
  // The host sends null for either when it has none.
  osVersion: Plain(64).optional().catch(undefined),
  engine: z
    .object({ version: Plain(64), checks: z.array(z.object({ name: Plain(80).catch("other check"), level: Level })).max(64) })
    .optional()
    .catch(undefined),
})

const OS_NAMES: Readonly<Record<string, string>> = { macos: "macOS", linux: "Linux", windows: "Windows", browser: "Browser" }

export interface CodeCount {
  readonly code: string
  readonly count: number
}

export interface ProblemReport {
  readonly app: string
  readonly shell: "desktop" | "browser preview"
  readonly system: string
  readonly engine?: string
  /** Undefined when `runrail doctor` could not run; `checksProblem` then says why, as a code. */
  readonly checks?: readonly { readonly name: string; readonly level: z.infer<typeof Level> }[]
  readonly checksProblem?: string
  /** The recent error ring, newest first, each code once with how often it is in the ring. */
  readonly recentErrors: readonly CodeCount[]
  /** Most frequent first. */
  readonly counters: readonly CodeCount[]
}

export interface ReportInput {
  readonly shell: "tauri" | "preview"
  readonly version: string
  /** The host's `problemReport` answer, unparsed. */
  readonly facts: unknown
  readonly checksProblem?: string
  /** An open engine's version, for when `runrail doctor` gave none. */
  readonly engineVersion?: string
  readonly diagnostics: Pick<Diagnostics, "counters" | "lastCodes">
}

export function buildReport(input: ReportInput): ProblemReport {
  const facts = parseOr(FactsSchema, input.facts)
  const plain = (text: string | undefined, max: number): string | undefined => parseOr(Plain(max), text)
  const os = facts === undefined ? "unknown" : (OS_NAMES[facts.os] ?? facts.os)
  const system = facts === undefined ? "unknown" : `${os}${facts.osVersion === undefined ? "" : ` ${facts.osVersion}`}, ${facts.arch}`
  const engine = facts?.engine?.version ?? plain(input.engineVersion, 64)
  const recent = new Map<string, number>()
  for (const { code } of input.diagnostics.lastCodes) if (isCode(code)) recent.set(code, (recent.get(code) ?? 0) + 1)
  const counters = Object.entries(input.diagnostics.counters)
    .filter(([code, count]) => isCode(code) && Number.isSafeInteger(count) && count > 0)
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
  const checks = facts?.engine?.checks
  const problem = checks === undefined ? (input.checksProblem !== undefined && isCode(input.checksProblem) ? input.checksProblem : "DOCTOR_FAILED") : undefined
  return {
    app: plain(input.version, 64) ?? "development build",
    shell: input.shell === "tauri" ? "desktop" : "browser preview",
    system,
    ...(engine === undefined ? {} : { engine }),
    ...(checks === undefined ? {} : { checks }),
    ...(problem === undefined ? {} : { checksProblem: problem }),
    recentErrors: [...recent].map(([code, count]) => ({ code, count })),
    counters,
  }
}

export function issueTitle(report: ProblemReport): string {
  return `Problem report: Runrail Desktop ${report.app}`
}

/** The report as Markdown for a GitHub issue; `counters` keeps only that many of the most frequent. */
export function reportText(report: ProblemReport, counters = report.counters.length): string {
  const pad = (rows: readonly (readonly [string, string])[]): string[] => {
    const width = Math.max(0, ...rows.map(([left]) => left.length))
    return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
  }
  const kept = report.counters.slice(0, counters)
  const left = report.counters.length - kept.length
  const details = [
    `Runrail Desktop ${report.app} (${report.shell})`,
    `System: ${report.system}`,
    `Engine: ${report.engine ?? "unknown"}`,
    "",
    "Engine checks (runrail doctor):",
    ...(report.checks === undefined ? [`  could not run (${report.checksProblem ?? "DOCTOR_FAILED"})`] : report.checks.length === 0 ? ["  none"] : pad(report.checks.map((check) => [check.level, check.name]))),
    "",
    "Recent error codes, newest first:",
    ...(report.recentErrors.length === 0 ? ["  none"] : pad(report.recentErrors.map((entry) => [entry.code, entry.count === 1 ? "" : `x${String(entry.count)}`]))),
    "",
    "Counters:",
    ...(report.counters.length === 0 ? ["  none"] : pad(kept.map((entry) => [entry.code, String(entry.count)]))),
    ...(left === 0 ? [] : [`  ${String(left)} more left out of this link to keep it short`]),
  ]
  return ["### What happened", "", "<!-- What you did, what you expected, and what happened instead. -->", "", "### Details", "", "```text", ...details.map((line) => line.trimEnd()), "```", ""].join("\n")
}

/** The new-issue link with the report filled in, its least frequent counters left out until it fits. */
export function issueLink(report: ProblemReport): { readonly url: string; readonly omitted: number } {
  const link = (body: string): string => {
    const url = new URL(ISSUES)
    url.searchParams.set("title", issueTitle(report))
    url.searchParams.set("body", body)
    return url.href
  }
  for (let kept = report.counters.length; kept >= 0; kept -= 1) {
    const url = link(reportText(report, kept))
    if (url.length <= MAX_ISSUE_URL) return { url, omitted: report.counters.length - kept }
  }
  // Only the checks and error codes are left, and they are bounded; should they still not fit, the end goes.
  let body = reportText(report, 0)
  while (link(body).length > MAX_ISSUE_URL) body = body.slice(0, Math.floor(body.length * 0.9))
  return { url: link(body), omitted: report.counters.length }
}

/** Asks the host for its part; a host that cannot answer still gets a report, which says so. */
export async function collectReport(): Promise<ProblemReport> {
  const host = getHost()
  const asked = await host.problemReport().then(
    (facts) => ({ facts }),
    (error: unknown) => ({ facts: undefined, checksProblem: toHostError(error).code }),
  )
  const state = get()
  const engineVersion = Object.values(state.runtime)
    .map((runtime) => runtime.contract?.runrailVersion)
    .find((version) => version !== undefined)
  return buildReport({ shell: host.kind, version: state.hostVersion, ...asked, ...(engineVersion === undefined ? {} : { engineVersion }), diagnostics: useDiagnostics.getState() })
}

export function reportProblem(): void {
  openDialog({ kind: "report-problem" })
}

export function openIssue(report: ProblemReport): Promise<void> {
  return openInBrowser(issueLink(report).url)
}
