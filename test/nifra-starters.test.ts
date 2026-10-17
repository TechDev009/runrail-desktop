import { beforeEach, describe, expect, test } from "bun:test"
import { remoteStart } from "../src/app/engines"
import { nifraInUse, nifraOn, nifraSummary, NifraUseSchema } from "../src/app/nifra"
import { defaultState, parseState } from "../src/app/persist"
import { appFolderName, createApp, loadStarters } from "../src/app/starters"
import { set } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

beforeEach(() => {
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" }, dialog: undefined })
  setHost(createFakeHost({}))
})

describe("new apps", () => {
  test("a project name becomes a folder name npm accepts", () => {
    expect(appFolderName("My Shop")).toBe("my-shop")
    expect(appFolderName("  Shop & Co.  ")).toBe("shop-co")
    expect(appFolderName("api.v2_beta")).toBe("api.v2_beta")
    expect(appFolderName("--Admin")).toBe("admin")
    expect(appFolderName("***")).toBeUndefined()
    expect(appFolderName("x".repeat(300))).toHaveLength(214)
  })

  test("the starters list Nifra first, as the default and the one recommended, with who makes it", async () => {
    const list = await loadStarters()
    expect(list.default).toBe("nifra")
    expect(list.starters.map((starter) => starter.id)).toEqual(["nifra", "vite", "next", "empty"])
    expect(list.starters.filter((starter) => starter.recommended).map((starter) => starter.id)).toEqual(["nifra"])
    expect(list.starters[0]?.maker).toBe("the authors of Runrail")
  })

  test("a made app comes back as a folder to add", async () => {
    expect(await createApp("shop", "vite")).toEqual({ ok: true, workspace: { path: "/Users/preview/code/shop", name: "shop", git: true }, warnings: [] })
  })
})

describe("Nifra", () => {
  test("is on until the person turns it off, and the setting survives a restart", () => {
    expect(nifraOn(defaultState().prefs)).toBe(true)
    expect(nifraOn({ nifra: false })).toBe(false)
    const saved = { ...defaultState(), prefs: { ...defaultState().prefs, nifra: false } }
    expect(parseState(JSON.parse(JSON.stringify(saved))).prefs.nifra).toBe(false)
  })

  test("a remote thread's engine is told when Nifra is off", () => {
    const base = { engineId: "e-1", workspace: "/home/me/app", sessionId: "t1", behavior: undefined, remote: "rm-1", threadTools: false }
    expect(remoteStart({ backend: "native" }, { ...base, noNifra: true })).toMatchObject({ noNifra: true })
    expect(remoteStart({ backend: "native" }, base)).not.toHaveProperty("noNifra")
  })

  test("the header says what Nifra adds, who makes it, and where to turn it off", () => {
    expect(nifraInUse(undefined)).toBe(false)
    expect(nifraInUse({ mcp: false, pi: false, check: false })).toBe(false)
    const summary = nifraSummary({ mcp: true, pi: false, check: true })
    expect(summary).toBe("A Nifra project: Runrail adds Nifra's MCP tools for the agent and a nifra check after each turn. Nifra is made by the authors of Runrail; turn this off in Settings, General.")
    expect(NifraUseSchema.safeParse({ mcp: true }).success).toBe(false)
  })
})
