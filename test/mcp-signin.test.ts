import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { signInFlows, systemRpc } from "../src/app/connections"
import { initEngines } from "../src/app/engines"
import { checkMcpServer, clearMcpApp, HOSTED_SERVERS, listMcpSignIns, mcpFailureText, setMcpApp, signInAddress, signInMcpServer, signOutMcpServer, signsIn } from "../src/app/mcp"
import { defaultState } from "../src/app/persist"
import type { SignInView } from "../src/app/signIn"
import { addProject, set } from "../src/app/store"
import { getHost, setHost } from "../src/host"
import type { PreviewScenario } from "../src/host/fakeConnections"
import { createFakeHost } from "../src/host/fakeHost"

/** A remote MCP server that signs in with its own page: started from Settings, kept by the engine for that address. */

setDefaultTimeout(20_000)

const PROJECT = "p1"
const DOCS = { name: "docs", command: "", args: [], env: [], url: "https://mcp.example.com/mcp", enabled: true }
let stop: () => void = () => undefined

async function signedIn(): Promise<string[]> {
  return [...(await listMcpSignIns()).values()].filter((entry) => entry.signedIn).map((entry) => entry.url)
}

function use(scenario: PreviewScenario = {}): void {
  stop()
  setHost(createFakeHost({ signInDelayMs: 5, ...scenario }))
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: PROJECT, path: "/code/app", name: "app", git: true, addedAt: 1 })
  stop = initEngines()
}

beforeEach(() => use())

function until(views: SignInView[], done: (view: SignInView) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000
    const poll = (): void => {
      if (views.some(done)) return resolve()
      if (Date.now() > deadline) return reject(new Error(`no such step; saw ${views.map((view) => view.phase).join(", ")}`))
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe("MCP server sign-in", () => {
  test("only a remote server with no token variable signs in with its own page", () => {
    expect(signsIn(DOCS)).toBe(true)
    expect(signsIn({ ...DOCS, bearerEnv: "DOCS_TOKEN" })).toBe(false)
    expect(signsIn({ ...DOCS, url: undefined, command: "docs-mcp" })).toBe(false)
    expect(signInAddress("https://mcp.example.com/#x")).toBe("https://mcp.example.com")
    expect(signInAddress("https://mcp.example.com/mcp?team=1")).toBe("https://mcp.example.com/mcp?team=1")
    expect(mcpFailureText("MCP_SIGN_IN_REQUIRED")).toBe("It asks you to sign in. Use Sign in, then check it again.")
    expect(mcpFailureText("MCP_TOKEN_REJECTED")).toBe("It refused the token in its token variable.")
    // Each suggested hosted server is one that signs in with its own page, at a fixed https address.
    for (const hosted of HOSTED_SERVERS) {
      expect(signsIn({ ...DOCS, name: hosted.name, url: hosted.url })).toBe(true)
      expect(signInAddress(hosted.url)).toBe(hosted.url)
      expect(new URL(hosted.url).protocol).toBe("https:")
    }
  })

  test("a server that asks for a sign-in is ready once signed in, and asks again after signing out", async () => {
    await getHost().mcpSave(DOCS)
    expect(await checkMcpServer(PROJECT, "docs")).toEqual({ name: "docs", state: "failed", tools: 0, code: "MCP_SIGN_IN_REQUIRED" })
    expect(await signedIn()).toEqual([])

    const views: SignInView[] = []
    signInMcpServer(DOCS, (view) => views.push(view))
    await until(views, (view) => view.phase === "done")
    expect(views.map((view) => view.phase)).toContain("browser")
    expect(views.at(-1)?.accountId).toMatch(/^mcp-oauth:/)
    expect(await signedIn()).toEqual([DOCS.url])
    expect(await checkMcpServer(PROJECT, "docs")).toEqual({ name: "docs", state: "ready", tools: 3 })

    await signOutMcpServer(DOCS.url)
    expect(await signedIn()).toEqual([])
    expect((await checkMcpServer(PROJECT, "docs")).code).toBe("MCP_SIGN_IN_REQUIRED")
  })

  test("a server that offers no usable sign-in fails with its code, and a cancelled one leaves nothing saved", async () => {
    use({ signIn: "unsupported" })
    const refused: SignInView[] = []
    signInMcpServer(DOCS, (view) => refused.push(view))
    await until(refused, (view) => view.phase === "failed")
    expect(refused.at(-1)?.code).toBe("AUTH_UNSUPPORTED")

    use({ signIn: "never" })
    const waiting: SignInView[] = []
    const run = signInMcpServer(DOCS, (view) => waiting.push(view))
    await until(waiting, (view) => view.phase === "browser")
    // Listed for the host's page check, never offered as a provider to connect.
    expect(((await systemRpc("auth.flows")) as { preset: string }[]).some((flow) => flow.preset === "mcp-oauth")).toBe(true)
    expect((await signInFlows()).some((flow) => flow.preset === "mcp-oauth")).toBe(false)
    await run.cancel()
    expect(waiting.at(-1)?.phase).toBe("cancelled")
    expect(await signedIn()).toEqual([])
  })

  test("a server whose provider registers no apps asks for one; it signs in with the app named, whose secret goes through the host", async () => {
    const GITHUB = { ...DOCS, name: "github", url: "https://api.githubcopilot.com/mcp/" }
    const refused: SignInView[] = []
    signInMcpServer(GITHUB, (view) => refused.push(view))
    await until(refused, (view) => view.phase === "failed")
    expect(refused.at(-1)?.code).toBe("AUTH_CLIENT_REQUIRED")

    await setMcpApp(GITHUB.url, { clientId: "Iv1.0123456789abcdef", secret: "app-secret-value" })
    expect((await listMcpSignIns()).get(GITHUB.url)).toMatchObject({ signedIn: false, client: { id: "Iv1.0123456789abcdef", secret: true } })
    const views: SignInView[] = []
    signInMcpServer(GITHUB, (view) => views.push(view))
    await until(views, (view) => view.phase === "done")
    expect((await listMcpSignIns()).get(GITHUB.url)).toMatchObject({ signedIn: true, client: { id: "Iv1.0123456789abcdef" } })

    await clearMcpApp(GITHUB.url)
    expect((await listMcpSignIns()).get(GITHUB.url)?.client).toBeUndefined()
  })
})
