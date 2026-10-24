import { beforeEach, describe, expect, test } from "bun:test"
import { bump, recordError, resetDiagnostics, useDiagnostics } from "../src/app/diagnostics"
import { defaultState } from "../src/app/persist"
import { buildReport, collectReport, issueLink, MAX_ISSUE_URL, openIssue, reportText } from "../src/app/report"
import { addProject, createThread, get, patchRuntime, set } from "../src/app/store"
import { setHost, type Host, type StreamFrame } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { applyFrames, emptyTimeline } from "../src/thread/reducer"

/** "Report a problem" holds versions, the system, check names and levels, and codes and counts: nothing a person worked on. */

const KEY = "sk-ant-api03-ZEBRAKEY0123456789"
/** Every one of these is seeded somewhere the app holds it; none may reach the report or its link. */
const SECRETS = ["zebra", "alice", "/users/", "sk-ant", "hunter2", "prompt", "transcript", "conn-", ".env", "example.com", "~/"]

const DOCTOR = {
  os: "macos",
  arch: "aarch64",
  osVersion: "15.6.1",
  connectionId: "conn-zebra-7f3a",
  engine: {
    version: "0.1.1",
    account: "alice@example.com",
    checks: [
      { name: "Runrail", level: "ok", detail: "0.1.1" },
      { name: "Sign-ins folder", level: "fail", detail: "/Users/alice/.runrail/accounts cannot be written" },
      { name: "Project", level: "warn", detail: "~/code/zebra-launch is not a git repository" },
      { name: "/Users/alice/code/zebra-launch", level: "ok", detail: "" },
      { name: "Key store", level: "ok", detail: KEY },
    ],
  },
}

let seq = -1
function event(type: string, fields: Record<string, unknown>): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

let opened: string[] = []

function useHost(problemReport: Host["problemReport"]): void {
  setHost({ ...createFakeHost(), problemReport, openUrl: async (url) => void opened.push(url) })
}

beforeEach(() => {
  opened = []
  useHost(async () => DOCTOR)
  set({ ...defaultState(), runtime: {}, toasts: [], drafts: {}, hostVersion: "0.1.1", platform: "macos" })
  addProject({ id: "p1", path: "/Users/alice/code/zebra-launch", name: "Zebra Launch", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1", backend: "claude-code", title: "Rotate the zebra webhook key", connectionId: "conn-zebra-7f3a", model: "alice-zebra-model" })
  set({ drafts: { [thread.id]: `prompt draft: use ${KEY}` } })
  patchRuntime(thread.id, {
    engine: "ready",
    contract: { protocol: 1, apiVersion: "1.0", runrailVersion: "0.1.1", capabilities: {} },
    timeline: applyFrames(emptyTimeline(), [
      event("turn.started", { turnId: "t1", prompt: `PROMPT: rotate ${KEY} in /Users/alice/code/zebra-launch/.env` }),
      event("tool.started", { turnId: "t1", callId: "c1", name: "run_command", presentation: { kind: "shell", title: "cat .env", command: "cat /Users/alice/code/zebra-launch/.env" } }),
      event("tool.completed", { turnId: "t1", callId: "c1", name: "run_command", ok: true, output: "ZEBRA_SECRET=hunter2" }),
      event("assistant.message", { turnId: "t1", text: "TRANSCRIPT: the zebra key is rotated" }),
    ]),
  })
  resetDiagnostics()
  bump("engine.start", 3)
  recordError("ENGINE_NOT_RUNNING")
  recordError("RPC_TIMEOUT")
  recordError("ENGINE_NOT_RUNNING")
  // What a careless caller might pass: diagnostics refuses anything that is not a code.
  recordError("/Users/alice/code/zebra-launch")
  recordError(`could not read ${KEY}`)
  bump("open /Users/alice/.env")
})

function leaks(text: string): string[] {
  const lower = text.toLowerCase()
  return SECRETS.filter((secret) => lower.includes(secret))
}

describe("a problem report", () => {
  test("holds versions, the system, check names and levels, and codes and counts, and none of what the person worked on", async () => {
    expect(leaks(JSON.stringify(get()))).toEqual(expect.arrayContaining(["zebra", "alice", "/users/", "sk-ant", "hunter2", "prompt", "transcript", "conn-", ".env"]))
    const report = await collectReport()
    const text = reportText(report)
    const link = issueLink(report)
    expect(leaks(text)).toEqual([])
    expect(leaks(decodeURIComponent(link.url))).toEqual([])
    expect(leaks(JSON.stringify(report))).toEqual([])
    expect(text).toContain("Runrail Desktop 0.1.1 (browser preview)")
    expect(text).toContain("System: macOS 15.6.1, aarch64")
    expect(text).toContain("Engine: 0.1.1")
    expect(text).toContain("fail  Sign-ins folder")
    expect(text).toContain("ok    other check")
    expect(text).toContain("ENGINE_NOT_RUNNING  x2")
    expect(text).toContain("error.ENGINE_NOT_RUNNING  2")
    expect(text).toContain("engine.start              3")
    expect(text).not.toContain("detail")
  })

  test("opens as a new GitHub issue through the system browser, with its title and body filled in", async () => {
    const report = await collectReport()
    await openIssue(report)
    expect(opened).toHaveLength(1)
    const url = new URL(opened[0] ?? "")
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/TechDev009/runrail-desktop/issues/new")
    expect(url.searchParams.get("title")).toBe("Problem report: Runrail Desktop 0.1.1")
    expect(url.searchParams.get("body")).toBe(reportText(report))
  })

  test("keeps its link short by leaving out the least frequent counters first, while the copied text has them all", () => {
    for (let index = 0; index < 120; index += 1) bump(`rpc.error.A_LONG_STABLE_ERROR_CODE_NUMBER_${String(index).padStart(3, "0")}`, index + 1)
    const report = buildReport({ shell: "tauri", version: "0.1.1", facts: DOCTOR, diagnostics: useDiagnostics.getState() })
    const link = issueLink(report)
    const body = new URL(link.url).searchParams.get("body") ?? ""
    expect(link.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL)
    expect(link.omitted).toBeGreaterThan(0)
    expect(body).toContain("NUMBER_119")
    expect(body).not.toContain("NUMBER_000")
    expect(body).toContain(`${String(link.omitted)} more left out of this link`)
    expect(body).toContain("fail  Sign-ins folder")
    const full = reportText(report)
    expect(full).toContain("NUMBER_000")
    expect(full).not.toContain("left out")
  })

  test("still comes when the engine's checks cannot run, and says why", async () => {
    useHost(async () => Promise.reject({ code: "ENGINE_NOT_FOUND", message: "no engine at /Users/alice/bin/runrail" }))
    const report = await collectReport()
    const text = reportText(report)
    expect(report.checks).toBeUndefined()
    expect(text).toContain("could not run (ENGINE_NOT_FOUND)")
    expect(text).toContain("Engine: 0.1.1")
    expect(text).toContain("System: unknown")
    expect(leaks(text)).toEqual([])
  })
})
