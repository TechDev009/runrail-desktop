import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { fileMenuItems } from "../src/app/fileMenu"
import { insideWorkspace, openFileLink, previewWorkspaceFile, usePreviewRequest } from "../src/app/filePreview"
import { words } from "../src/app/platformWords"
import { defaultState } from "../src/app/persist"
import { addProject, createThread, get, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { fileLinkTarget, Markdown, splitLocation } from "../src/ui/thread/Markdown"

test("each edited file opens in the Files pane using the same path as single-file links", () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/work/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1" })
  let editorOpens = 0
  const host = createFakeHost({})
  setHost({ ...host, workspaceOpenIn: async () => { editorOpens += 1 } })
  for (const path of ["src/a.ts", "src/b.ts"]) {
    previewWorkspaceFile("/work/app", path)
    expect(usePreviewRequest.getState().request).toMatchObject({ threadId: thread.id, path })
    expect(get().layout.panels[thread.id]?.tabs.some((tab) => tab.kind === "files")).toBe(true)
  }
  expect(editorOpens).toBe(0)
  previewWorkspaceFile("/work/app", "../private.txt")
  expect(usePreviewRequest.getState().request?.path).toBe("src/b.ts")
})

test("a path a model names opens only when it stays inside the workspace", () => {
  expect(insideWorkspace("/work/app", "src/index.ts")).toBe("src/index.ts")
  expect(insideWorkspace("/work/app/", "./src/../README.md")).toBe("README.md")
  expect(insideWorkspace("/work/app", "/work/app/src/a.ts")).toBe("src/a.ts")
  expect(insideWorkspace("/work/app", "/work/app")).toBe("")
  for (const outside of ["../secrets.txt", "src/../../x", "/etc/passwd", "/work/application/a.ts", "~/.ssh/id_rsa", "a\0b", ""]) expect(insideWorkspace("/work/app", outside)).toBeUndefined()
})

test("a file link opens in the Files pane at the line it names, never in an editor", () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/work/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1" })
  let editorOpens = 0
  setHost({ ...createFakeHost({}), workspaceOpenIn: async () => { editorOpens += 1 } })
  previewWorkspaceFile("/work/app", "/work/app/src/a.ts", { line: 42 })
  expect(usePreviewRequest.getState().request).toMatchObject({ threadId: thread.id, path: "src/a.ts", line: 42 })
  previewWorkspaceFile("/work/app/docs", "guide.md", { threadId: thread.id, folder: "/work/app/docs" })
  expect(usePreviewRequest.getState().request).toMatchObject({ path: "guide.md", folder: "/work/app/docs" })
  expect(usePreviewRequest.getState().request?.line).toBeUndefined()
  expect(editorOpens).toBe(0)
})

test("links name a file, and a line, the ways answers write them", () => {
  expect(splitLocation("src/a.ts")).toEqual({ path: "src/a.ts" })
  expect(splitLocation("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 })
  expect(splitLocation("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42 })
  expect(splitLocation("src/a.ts#L9-L12")).toEqual({ path: "src/a.ts", line: 9 })
  expect(splitLocation("src/a.ts:0")).toEqual({ path: "src/a.ts" })
  expect(fileLinkTarget("src/My%20File.ts:3")).toBe("src/My File.ts:3")
  expect(fileLinkTarget("file:///work/app/a.ts")).toBe("/work/app/a.ts")
  expect(fileLinkTarget("a.ts:42")).toBe("a.ts:42")
  for (const other of ["https://example.com/a.ts", "mailto:a@b.c", "javascript:alert(1)", "data:text/plain,x", "vscode://file/a.ts", "#top", "", "%E0%A4%A"]) expect(fileLinkTarget(other)).toBeUndefined()
})

test("an answer's file links go to the Files pane and say so", () => {
  const html = renderToStaticMarkup(<Markdown text={"See `src/a.ts:12` and [the readme](README.md#L3), or [the site](https://example.com)."} workspace="/work/app" />)
  expect(html).toContain('class="inline-path"')
  expect(html).toContain("Open src/a.ts at line 12. Right-click for more.")
  expect(html).toContain('class="file-link"')
  expect(html).toContain("Open README.md at line 3.")
  expect(html).toContain('href="https://example.com"')
})

test("a file's right-click menu lists the editors this computer has, the chosen one first, then the file manager and the path", async () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" }, openIn: ["finder", "cursor", "vscode", "terminal", "zed"] })
  set((state) => ({ prefs: { ...state.prefs, editor: "vscode" } }))
  addProject({ id: "p1", path: "/work/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1" })
  const opened: unknown[][] = []
  setHost({ ...createFakeHost({}), workspaceOpenIn: async (...args: unknown[]) => { opened.push(args) } })
  const items = fileMenuItems("/work/app", "src/a.ts", { line: 4 })
  const labels = items.map((item) => ("separator" in item ? "-" : item.label))
  expect(labels).toEqual(["Open in Runrail", "-", "Open in VS Code", "Open in Cursor", "Open in Zed", words().reveal, "-", "Copy path", "Copy relative path"])
  const pick = (label: string) => items.find((item) => !("separator" in item) && item.label === label)
  const cursor = pick("Open in Cursor")
  if (cursor === undefined || "separator" in cursor) throw new Error("no Cursor entry")
  cursor.onSelect()
  await Promise.resolve()
  expect(opened).toEqual([["/work/app", "src/a.ts", "cursor"]])
  const open = pick("Open in Runrail")
  if (open === undefined || "separator" in open) throw new Error("no Open entry")
  open.onSelect()
  expect(usePreviewRequest.getState().request).toMatchObject({ threadId: thread.id, path: "src/a.ts", line: 4 })
  const folder = fileMenuItems("/work/app", "src", {}, { directory: true }).map((item) => ("separator" in item ? "-" : item.label))
  expect(folder[0]).toBe("Open in VS Code")
  expect(fileMenuItems("/work/app", "../outside.ts")).toEqual([])
})

test("a remote project's files have no local editor or file manager on the menu", () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "r1", path: "/srv/app", name: "app", git: true, addedAt: 1, remote: { id: "box", host: "box" } })
  const labels = fileMenuItems("/srv/app", "a.ts").map((item) => ("separator" in item ? "-" : item.label))
  expect(labels).toEqual(["Open in Runrail", "-", "Copy path", "Copy relative path"])
})

test("a file named in an answer opens in Runrail by default, or in the editor when Settings says so", async () => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/work/app", name: "app", git: true, addedAt: 1 })
  const thread = createThread({ projectId: "p1" })
  const opened: unknown[][] = []
  setHost({ ...createFakeHost({}), workspaceOpenIn: async (...args: unknown[]) => { opened.push(args) } })
  usePreviewRequest.setState({ request: undefined })
  expect(get().prefs.fileLinks).toBe("app")
  openFileLink("/work/app", "src/a.ts", { line: 7 })
  expect(usePreviewRequest.getState().request).toMatchObject({ threadId: thread.id, path: "src/a.ts", line: 7 })
  expect(opened).toEqual([])
  usePreviewRequest.setState({ request: undefined })
  set((state) => ({ prefs: { ...state.prefs, fileLinks: "editor" } }))
  openFileLink("/work/app", "/work/app/src/b.ts", { line: 3 })
  await Promise.resolve()
  expect(opened).toHaveLength(1)
  expect(opened[0]?.slice(0, 2)).toEqual(["/work/app", "src/b.ts"])
  expect(usePreviewRequest.getState().request).toBeUndefined()
  openFileLink("/work/app", "../secret.ts")
  expect(opened).toHaveLength(1)
})
