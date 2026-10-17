import { beforeEach, describe, expect, test } from "bun:test"
import { connectionsChanged, systemRpc } from "../src/app/connections"
import { serviceLine } from "../src/app/gitHosts"
import { defaultState } from "../src/app/persist"
import { readAllProjectGit, readProjectGit, rereadProjectsOn, resetProjectGit, useProjectHeads } from "../src/app/projectGit"
import { addProject, projectById, set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

/** What a project is connected to is read from its folder, with no thread there. */

let reads: string[]

function project(id: string, name: string, fields: { readonly git?: boolean } = {}) {
  return addProject({ id, path: `/Users/preview/code/${name}`, name, git: fields.git ?? true, addedAt: 1 })
}

beforeEach(() => {
  const host = createFakeHost({})
  const seen: string[] = []
  reads = seen
  setHost({
    ...host,
    rpc: async (engineId, method, params) => {
      if (method === "codehost.remotes") seen.push(String((params as { path?: unknown }).path))
      return host.rpc(engineId, method, params)
    },
  })
  connectionsChanged()
  resetProjectGit()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
})

describe("a project's git host, read without a thread", () => {
  test("the sidebar mark and the Projects row come from the folder itself", async () => {
    project("p1", "example-web")
    project("p2", "local-tool")
    await readAllProjectGit()
    expect(projectById("p1")?.connectedTo).toEqual({ service: "github", certain: true, host: "github.com", path: "example-org/web" })
    expect(serviceLine(projectById("p1")?.connectedTo)?.short).toBe("GitHub")
    expect(projectById("p2")?.connectedTo).toEqual({ service: "local", certain: true })
    expect(reads).toEqual(["/Users/preview/code/example-web", "/Users/preview/code/local-tool"])
  })

  test("the checkout's branch comes with the remotes and is kept for the session only", async () => {
    project("p1", "example-web")
    project("p2", "mobile-app")
    project("p3", "local-tool")
    project("p4", "notes")
    await readAllProjectGit()
    const heads = useProjectHeads.getState()
    expect(heads.p1).toMatchObject({ branch: "main", detached: false, initial: false })
    expect(heads.p2).toMatchObject({ detached: true, initial: false, head: "4f2c9e1a7b3d5e6f8091a2b3c4d5e6f708192a3b" })
    expect(heads.p2?.branch).toBeUndefined()
    expect(heads.p3).toEqual({ branch: "main", detached: false, initial: true })
    expect(heads.p4).toBeUndefined()
    expect(projectById("p1")).not.toHaveProperty("branch")
  })

  test("an engine that answers no branch leaves none, and a folder that stops being a repository drops it", async () => {
    project("p1", "example-web")
    const host = createFakeHost({})
    let branch = false
    setHost({ ...host, rpc: async (engineId, method, params) => (method === "codehost.remotes" ? (branch ? { git: false } : { git: true, remotes: [] }) : host.rpc(engineId, method, params)) })
    connectionsChanged()
    resetProjectGit(true)
    useProjectHeads.setState({ p1: { branch: "old", detached: false, initial: false } }, true)
    await readProjectGit("p1")
    expect(useProjectHeads.getState().p1).toBeUndefined()
    useProjectHeads.setState({ p1: { branch: "old", detached: false, initial: false } }, true)
    branch = true
    await readProjectGit("p1", 0)
    expect(useProjectHeads.getState().p1).toBeUndefined()
  })

  test("one read at a time per project, at most once per five minutes unless asked for now", async () => {
    project("p1", "example-web")
    await Promise.all([readProjectGit("p1"), readProjectGit("p1")])
    await readProjectGit("p1")
    expect(reads).toHaveLength(1)
    await readProjectGit("p1", 0)
    expect(reads).toHaveLength(2)
  })

  test("a folder that is not a repository is connected to nothing", async () => {
    project("p1", "notes")
    set((state) => ({ projects: state.projects.map((item) => ({ ...item, connectedTo: { service: "github", certain: true, host: "github.com", path: "a/b" } as const })) }))
    await readProjectGit("p1")
    expect(projectById("p1")?.git).toBe(false)
    expect(projectById("p1")?.connectedTo).toBeUndefined()
  })

  test("answering which service a guessed host is reads the projects on it again", async () => {
    project("p1", "corp-api")
    await readProjectGit("p1")
    expect(projectById("p1")?.connectedTo).toMatchObject({ service: "gitlab", certain: false, host: "git.corp.example" })
    await systemRpc("codehost.set", { host: "git.corp.example", service: "bitbucket" })
    await rereadProjectsOn("git.corp.example")
    expect(projectById("p1")?.connectedTo).toMatchObject({ service: "bitbucket", certain: true })
  })

  test("an engine without codehost.remotes is not asked; threads still read remotes when they open", async () => {
    resetProjectGit(false)
    project("p1", "example-web")
    await readAllProjectGit()
    expect(reads).toEqual([])
    expect(projectById("p1")?.connectedTo).toBeUndefined()
  })
})
