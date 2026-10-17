import { beforeEach, expect, test } from "bun:test"
import { noteBrowserFrames } from "../src/app/browserAgent"
import { closeProject } from "../src/app/engines"
import { defaultState, parseState } from "../src/app/persist"
import { usePreviews } from "../src/app/previews"
import { setBrowserSignIns, signInProject } from "../src/app/signIns"
import { addProject, createThread, patchThread, projectById, set } from "../src/app/store"
import { getHost, setHost, type Host } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** Saved browser sign-ins, per project and opt-in. */

const PROJECT = { id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 }
let opens: { url: string; project: string | undefined }[]
let forgotten: string[]

beforeEach(() => {
  const host = createFakeHost()
  opens = []
  forgotten = []
  const wrapped: Host = {
    ...host,
    rpc: async (engineId, method, params) => {
      const body = params as { requestId: string }
      if (method === "browser.take") return { requestId: body.requestId, action: "open", params: { url: "http://localhost:5173/login" }, expiresAt: Date.now() + 30_000 }
      if (method === "browser.respond") return { ok: true }
      return host.rpc(engineId, method, params)
    },
    previewOpen: async (tab, url, bounds, hidden, project) => {
      opens.push({ url, project })
      return host.previewOpen(tab, url, bounds, hidden, project)
    },
    signInsForget: async (project) => {
      forgotten.push(project)
      return host.signInsForget(project)
    },
  }
  setHost(wrapped)
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  usePreviews.setState({}, true)
  addProject(PROJECT)
})

test("the choice is saved with the project, and anything but on is dropped", () => {
  const saved = (browserSignIns: unknown) => parseState({ ...defaultState(), projects: [{ ...PROJECT, browserSignIns }] }).projects[0]?.browserSignIns
  expect(saved(true)).toBe(true)
  expect(saved(false)).toBeUndefined()
  expect(saved("yes")).toBeUndefined()
})

test("a thread's previews use its project's sign-ins only once the person turns them on", async () => {
  const thread = createThread({ projectId: PROJECT.id, backend: "codex" })
  expect(signInProject(thread.id)).toBeUndefined()
  await setBrowserSignIns(PROJECT.id, true)
  expect(projectById(PROJECT.id)?.browserSignIns).toBe(true)
  expect(signInProject(thread.id)).toBe(PROJECT.id)
  // The agent's pages start signed in too.
  patchThread(thread.id, { browser: { agent: true } })
  noteBrowserFrames(thread.id, "engine-1", [{ kind: "live", data: { type: "browser.request", liveSeq: 1, requestId: `br-${"a".repeat(32)}`, action: "open" } }])
  for (let tries = 0; tries < 400 && opens.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(opens).toEqual([{ url: "http://localhost:5173/login", project: PROJECT.id }])
  const host = getHost()
  await host.signInsForget(PROJECT.id)
  expect(await host.signInsSaved(PROJECT.id)).toBe(false)
  await host.previewOpen("tab-1", "http://localhost:5173/", { x: 0, y: 0, width: 1, height: 1 }, false, signInProject(thread.id))
  expect(opens.at(-1)).toEqual({ url: "http://localhost:5173/", project: PROJECT.id })
  expect(await host.signInsSaved(PROJECT.id)).toBe(true)
})

test("turning it off forgets what was saved, and so does removing the project", async () => {
  await setBrowserSignIns(PROJECT.id, true)
  await setBrowserSignIns(PROJECT.id, false)
  expect(projectById(PROJECT.id)?.browserSignIns).toBeUndefined()
  expect(forgotten).toEqual([PROJECT.id])
  await closeProject(PROJECT.id)
  expect(forgotten).toEqual([PROJECT.id, PROJECT.id])
})
