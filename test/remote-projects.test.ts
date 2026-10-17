import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { openInEditor, remoteHostOf } from "../src/app/actions"
import { connectionsChanged } from "../src/app/connections"
import { ensureEngine, initEngines, remoteStart, stopProjectService } from "../src/app/engines"
import { anyElsewhere, continueOn, findMoveTargets, movePlan, moveTargets, sameRepository } from "../src/app/moveThread"
import { defaultState, parseState, type Project } from "../src/app/persist"
import { readAllProjectGit, resetProjectGit } from "../src/app/projectGit"
import { existingProject } from "../src/app/projectForm"
import { checkRemote, loadRemotes, saveRemote, useRemotes, validRemotePath } from "../src/app/remotes"
import { addProject, createThread, get, patchThread, projectById, set, threadById } from "../src/app/store"
import { getHost, setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { EngineStartInput } from "../src/host/types"

/** Projects on a remote machine over SSH. */

setDefaultTimeout(20_000)

const REMOTE = { id: "rm-1", host: "dev-box" } as const
let starts: EngineStartInput[] = []
let opened: string[] = []
let stop: () => void = () => undefined

beforeEach(() => {
  stop()
  starts = []
  opened = []
  const host = createFakeHost()
  const start = host.engineStart.bind(host)
  host.engineStart = (input) => {
    starts.push(input)
    return start(input)
  }
  host.workspaceOpenIn = async (workspace) => {
    opened.push(workspace)
  }
  setHost(host)
  connectionsChanged()
  useRemotes.setState({ machines: [], loaded: false }, true)
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "local", path: "/code/app", name: "app", git: true, addedAt: 1 })
  addProject({ id: "far", path: "/home/me/app", name: "app on dev-box", git: true, addedAt: 2, remote: REMOTE })
  stop = initEngines()
})

describe("a remote thread's engine", () => {
  test("starts on that machine with nothing that lives only on this Mac", async () => {
    const thread = createThread({ projectId: "far", backend: "claude-code", model: "claude-opus-5-5" })
    patchThread(thread.id, { browser: { agent: true, anySite: true }, computer: true, connectionId: "claude-code-2" })
    set((state) => ({ projects: state.projects.map((project) => (project.id === "far" ? { ...project, folders: ["/home/me/api"] } : project)) }))
    await ensureEngine(thread.id)
    const started = starts.find((input) => input.sessionId === thread.id)
    expect(started).toMatchObject({ workspace: "/home/me/app", backend: "claude-code", remote: "rm-1", model: "claude-opus-5-5" })
    for (const key of ["browserTools", "browserAnySite", "computerTools", "imageTools", "folders", "connectionId", "toolConnectionId", "continueFrom"] as const) expect(started?.[key]).toBeUndefined()
    // The project's own engine runs there too.
    const local = createThread({ projectId: "local", backend: "claude-code", model: "claude-opus-5-5" })
    await ensureEngine(local.id)
    expect(starts.find((input) => input.sessionId === local.id)?.remote).toBeUndefined()
  })

  test("takes the model for a coding tool, not for Runrail's own loop, whose keys stay here", () => {
    const base = { engineId: "e-1", workspace: "/home/me/app", sessionId: "t1", behavior: undefined, remote: "rm-1", threadTools: true }
    expect(remoteStart({ backend: "codex", model: "gpt-5.5", thinking: "high" }, base)).toEqual({ engineId: "e-1", workspace: "/home/me/app", backend: "codex", sessionId: "t1", remote: "rm-1", model: "gpt-5.5", thinking: "high", threadTools: true })
    expect(remoteStart({ backend: "native", model: "claude-opus-5-5" }, { ...base, threadTools: false })).toEqual({ engineId: "e-1", workspace: "/home/me/app", backend: "native", sessionId: "t1", remote: "rm-1" })
  })
})

describe("remote projects", () => {
  test("are kept with their machine, and the same path elsewhere is another project", () => {
    const state = parseState({ ...defaultState(), projects: get().projects })
    expect(state.projects.find((project) => project.id === "far")?.remote).toEqual(REMOTE)
    const broken = parseState({ ...defaultState(), projects: [{ id: "x", path: "/home/x", name: "x", git: false, addedAt: 1, remote: { id: "../etc", host: "-oProxyCommand=x" } }] })
    expect(broken.projects[0]?.remote).toBeUndefined()

    expect(existingProject({ path: "/home/me/app", name: "app", git: true, remote: REMOTE }, get().projects)?.id).toBe("far")
    expect(existingProject({ path: "/home/me/app", name: "app", git: true }, get().projects)).toBeUndefined()
    const other = addProject({ id: "far2", path: "/home/me/app", name: "app on build", git: true, addedAt: 3, remote: { id: "rm-2", host: "build" } })
    expect(other.id).toBe("far2")
  })

  test("open on that machine, not in an editor here", async () => {
    expect(remoteHostOf("/home/me/app/src")).toBe("dev-box")
    expect(remoteHostOf("/code/app")).toBeUndefined()
    await openInEditor("/home/me/app", "README.md")
    expect(opened).toEqual([])
    expect(get().toasts.at(-1)?.text).toContain("dev-box")
    await openInEditor("/code/app")
    expect(opened).toEqual(["/code/app"])
  })
})

describe("machines", () => {
  test("are the host's list; a folder is looked at there before a project is made", async () => {
    await loadRemotes()
    expect(useRemotes.getState()).toMatchObject({ machines: [], loaded: true })
    const saved = await saveRemote({ host: " dev-box ", engine: "  " })
    expect(saved).toEqual({ id: "rm-1", host: "dev-box" })
    await expect(saveRemote({ host: "-oProxyCommand=x" })).rejects.toThrow()
    expect(await checkRemote("rm-1", "/home/me/app")).toEqual({ version: "0.1.0", folder: true, git: true })
    expect(await checkRemote("rm-1", "/srv/nothing")).toMatchObject({ folder: false })
    expect(validRemotePath("/home/me/app")).toBe(true)
    for (const path of ["home/me", "/a\nb", ""]) expect(validRemotePath(path)).toBe(false)
  })
})

describe("continuing a thread on another machine", () => {
  const status = (fields: Record<string, unknown>): Record<string, unknown> => ({ branch: "feat/move", detached: false, ahead: 0, behind: 0, upstream: "origin/feat/move", entries: [], counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, ...fields })
  let answer: Record<string, unknown> = status({})

  beforeEach(async () => {
    // A service engine started under the last test's host is not on this one.
    for (const id of ["web-here", "web-there", "other-there"]) await stopProjectService(id)
    answer = status({})
    const host = getHost()
    const rpc = host.rpc.bind(host)
    host.rpc = async (engineId, method, params) => (method === "git.status" && engineId !== "system" ? answer : rpc(engineId, method, params))
    resetProjectGit(true)
    addProject({ id: "web-here", path: "/code/example-web", name: "example-web", git: true, addedAt: 4 })
    addProject({ id: "web-there", path: "/home/me/example-web", name: "example-web", git: true, addedAt: 5, remote: REMOTE })
    addProject({ id: "other-there", path: "/home/me/mobile-app", name: "mobile-app", git: true, addedAt: 6, remote: REMOTE })
  })

  test("finds the same repository there, reading a remote folder only when asked", async () => {
    await readAllProjectGit(0)
    expect(projectById("web-here")?.connectedTo).toMatchObject({ host: "github.com", path: "example-org/web" })
    expect(projectById("web-there")?.connectedTo).toBeUndefined()
    expect(starts.some((input) => input.remote !== undefined)).toBe(false)

    const thread = createThread({ projectId: "web-here", backend: "claude-code" })
    expect(anyElsewhere(projectById("web-here") as Project, get().projects)).toBe(true)
    expect((await findMoveTargets(thread.id)).map((project) => project.id)).toEqual(["web-there"])
    expect(starts.find((input) => input.engineId === "svc-web-there")?.remote).toBe("rm-1")
    // And back: a thread there is offered this Mac's project, not another one on the same machine.
    const there = createThread({ projectId: "web-there", backend: "claude-code" })
    expect(moveTargets(there.id).map((project) => project.id)).toEqual(["web-here"])
    expect(sameRepository({ git: true, connectedTo: { service: "github", certain: true, host: "GitHub.com", path: "Example-Org/Web.git" } }, { git: true, connectedTo: { service: "github", certain: true, host: "github.com", path: "example-org/web" } })).toBe(true)
    expect(sameRepository({ git: true, connectedTo: { service: "local", certain: true } }, { git: true, connectedTo: { service: "local", certain: true } })).toBe(false)
  })

  test("needs the branch's work pushed, and never commits or pushes it", async () => {
    const thread = createThread({ projectId: "web-here", backend: "claude-code" })
    expect(await movePlan(thread.id)).toEqual({ ok: true, remote: "origin", branch: "feat/move" })
    answer = status({ counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 } })
    expect(await movePlan(thread.id)).toMatchObject({ ok: false, reason: expect.stringContaining("2 changed files are not committed") })
    answer = status({ ahead: 1 })
    expect(await movePlan(thread.id)).toMatchObject({ ok: false, reason: expect.stringContaining("1 commit on feat/move is not pushed") })
    answer = status({ upstream: null })
    expect(await movePlan(thread.id)).toMatchObject({ ok: false, reason: expect.stringContaining("has no upstream") })
    answer = status({ detached: true, branch: null })
    expect(await movePlan(thread.id)).toMatchObject({ ok: false, reason: "The thread is not on a branch." })
  })

  test("starts a worktree there on the same branch, the conversation ready to send", async () => {
    const thread = createThread({ projectId: "web-here", backend: "codex", model: "gpt-5.5" })
    patchThread(thread.id, { connectionId: "codex-1", title: "Speed up search" })
    const created = await continueOn(thread.id, "web-there", { ok: true, remote: "origin", branch: "feat/move" })
    expect(created).toMatchObject({ projectId: "web-there", backend: "codex", model: "gpt-5.5", title: "Speed up search", worktree: { branch: "feat/move" } })
    expect(created.connectionId).toBeUndefined()
    expect(get().layout.activeThreadId).toBe(created.id)
    expect(get().drafts[created.id]).toContain("This worktree starts from origin/feat/move, where it was left on this Mac.")
    // The thread it came from stays.
    expect(threadById(thread.id)?.projectId).toBe("web-here")
  })
})
