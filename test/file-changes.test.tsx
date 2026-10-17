import { beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileChange } from "../src/app/fileChanges"
import { usePreviewRequest } from "../src/app/filePreview"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, set } from "../src/app/store"
import { ensureEngine } from "../src/app/engines"
import type { TaskRow } from "../src/app/tasks"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { GitDiffFile } from "../src/protocol/schemas"
import type { ToolItem } from "../src/thread/reducer"
import { FileChangeBody } from "../src/ui/inspector/FileChanges"
import { TaskStopButton } from "../src/ui/inspector/TasksPane"
import { previewToolFile } from "../src/ui/thread/rows"

beforeEach(() => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  usePreviewRequest.setState({ request: undefined })
  setHost(createFakeHost({}))
  addProject({ id: "p1", path: "/work/app", name: "app", git: true, addedAt: 1 })
})

const tool = (presentation: ToolItem["presentation"]): ToolItem => ({ kind: "tool", key: "edit", callId: "edit", name: "edit", at: 1, status: "ok", presentation })

test("every file in a multi-file patch opens its changes in the right pane", () => {
  const thread = createThread({ projectId: "p1" })
  const item = tool({ kind: "patch", title: "Edit files", paths: ["src/a.ts", "src/b.ts"] })
  for (const path of item.presentation.paths ?? []) {
    previewToolFile(item, "/work/app", path)
    expect(usePreviewRequest.getState().request).toMatchObject({ threadId: thread.id, path, view: "changes" })
    expect(get().layout.panels[thread.id]?.tabs.some((tab) => tab.kind === "files")).toBe(true)
  }
  previewToolFile(item, "/work/app", "../private.txt")
  expect(usePreviewRequest.getState().request?.path).toBe("src/b.ts")
})

test("an edit carries its actual removed and added lines; a read keeps the full file view", () => {
  createThread({ projectId: "p1" })
  previewToolFile(tool({ kind: "edit", title: "Update a", path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }), "/work/app", "a.ts")
  const change = usePreviewRequest.getState().request?.change
  const html = renderToStaticMarkup(<FileChangeBody path="a.ts" mode="unified" {...(change === undefined ? {} : { change })} />)
  expect(html).toContain('aria-label="Diff of a.ts"')
  expect(html).toContain("is-del")
  expect(html).toContain("is-add")
  expect(html).toContain("old")
  expect(html).toContain("new")
  previewToolFile(tool({ kind: "read", title: "Read a", path: "a.ts" }), "/work/app", "a.ts")
  expect(usePreviewRequest.getState().request?.view).toBeUndefined()
})

test("an overwrite without its old text requests a real working tree diff", () => {
  createThread({ projectId: "p1" })
  previewToolFile({ ...tool({ kind: "write", title: "Write a", path: "a.ts", content: "new" }), created: false }, "/work/app", "a.ts")
  expect(usePreviewRequest.getState().request).toMatchObject({ view: "changes", path: "a.ts" })
  expect(usePreviewRequest.getState().request?.change).toBeUndefined()
})

test("working tree reads are scoped to the clicked file and malformed responses are refused", async () => {
  const thread = createThread({ projectId: "p1", backend: "native" })
  await ensureEngine(thread.id)
  const file: GitDiffFile = { path: "b.ts", change: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }
  let params: Record<string, unknown> | undefined
  let invalid = false
  const host = createFakeHost({})
  setHost({ ...host, rpc: async (_id, method, input) => {
    expect(method).toBe("git.diff")
    params = input
    return invalid ? { files: "bad" } : { files: [file], totals: { files: 1, additions: 1, deletions: 1 } }
  } })
  expect(await readFileChange(thread.id, "b.ts")).toEqual(file)
  expect(params).toMatchObject({ paths: ["b.ts"], scope: "head", includeUntracked: true, maxFiles: 1 })
  invalid = true
  await expect(readFileChange(thread.id, "b.ts")).rejects.toMatchObject({ code: "CONTROL_INVALID_RESPONSE" })
})

test("binary and sensitive changes stay hidden, and absent changes never render the file as a diff", () => {
  const file: GitDiffFile = { path: "a", change: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-secret\n+new\n" }
  for (const extra of [{ binary: true }, { sensitive: true }]) {
    const html = renderToStaticMarkup(<FileChangeBody path="a" mode="unified" file={{ ...file, ...extra }} />)
    expect(html).not.toContain("secret")
    expect(html).not.toContain('role="table"')
  }
  expect(renderToStaticMarkup(<FileChangeBody path="a" mode="unified" />)).toContain("No current changes")
})

test("task stop is a styled button and stays a disabled button while stopping", () => {
  const row: TaskRow = { id: "agent", kind: "agent", status: "running", label: "Parser", entry: { id: "agent", kind: "agent", label: "Parser", status: "running", stoppable: true, hasOutput: false } }
  const html = renderToStaticMarkup(<TaskStopButton row={row} stopping={false} onStop={() => undefined} />)
  expect(html).toContain("btn-secondary")
  expect(html).toContain("task-stop")
  expect(html).toContain("lucide-square")
  const stopping = renderToStaticMarkup(<TaskStopButton row={row} stopping onStop={() => undefined} />)
  expect(stopping).toContain('disabled=""')
  expect(stopping).toContain('aria-busy="true"')
  expect(stopping).toContain("Stopping...")
  const fallback = renderToStaticMarkup(<TaskStopButton row={{ ...row, entry: undefined }} stopping={false} onStop={() => undefined} />)
  expect(fallback).toContain("Stop turn")
})
