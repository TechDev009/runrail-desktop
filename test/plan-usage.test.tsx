import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { connectionsChanged } from "../src/app/connections"
import { detectTools, listConnectionSettings } from "../src/app/connectionSettings"
import { cleanLimits, currentLimits, footerWindows, loadPlanLimits, mergeLimits, notePlanReading, planAccount, planReadings, shortWindowLabel, tightestWindow, usageLevel, usePlanLimits, windowLabel, type PlanLimits, type PlanWindow } from "../src/app/limits"
import { initPlanUsage, lastUsageRead, readAccountUsage, readAllPlanUsage, resetPlanUsage, setPlanLimits, useAccountLabels, useToolProxies, useUsageAccounts, useUsageSignIns } from "../src/app/planUsage"
import { get, setPrefs } from "../src/app/store"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import { parsePreviewScenario } from "../src/host/fakeConnections"
import { proxyText, UsageRings } from "../src/ui/thread/PlanUsage"

const NOW = 10_000_000_000

/** A window whose timers wait to be run by hand and whose listeners can be seen. */
function fakeWindow() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  const timers: { run: () => Promise<void>; delay: number; cleared: boolean }[] = []
  const listeners: { type: string; listener: () => void }[] = []
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (run: () => Promise<void>, delay: number) => { timers.push({ run, delay, cleared: false }); return timers.length },
    clearTimeout: (id: number) => { const timer = timers[id - 1]; if (timer !== undefined) timer.cleared = true },
    addEventListener: (type: string, listener: () => void) => { listeners.push({ type, listener }) },
    removeEventListener: (type: string, listener: () => void) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.listener === listener)
      if (at >= 0) listeners.splice(at, 1)
    },
  } })
  return {
    timers,
    listening: (type: string) => listeners.filter((entry) => entry.type === type).length,
    fire: (type: string) => { for (const entry of listeners.filter((entry) => entry.type === type)) entry.listener() },
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "window")
      else Object.defineProperty(globalThis, "window", previous)
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function limits(windows: readonly PlanWindow[], at = NOW - 60_000): PlanLimits {
  return { windows, at }
}

describe("plan usage in the bar and the rail", () => {
  test("windows go by a few letters, as the tools name them", () => {
    expect(windowLabel({ id: "five-hour", usedPercent: 1 }, "claude-code")).toBe("Session limit")
    expect(shortWindowLabel({ id: "five-hour", usedPercent: 1 }, "claude-code")).toBe("session")
    expect(windowLabel({ id: "five-hour", usedPercent: 1 }, "codex")).toBe("5-hour limit")
    expect(shortWindowLabel({ id: "five-hour", usedPercent: 1 })).toBe("5h")
    expect(shortWindowLabel({ id: "weekly", usedPercent: 1 })).toBe("wk")
    expect(shortWindowLabel({ id: "weekly-opus", usedPercent: 1 })).toBe("wk Opus")
    expect(shortWindowLabel({ id: "primary", usedPercent: 1, windowMinutes: 300 })).toBe("5h")
    expect(shortWindowLabel({ id: "secondary", usedPercent: 1, windowMinutes: 10_080 })).toBe("wk")
    expect(shortWindowLabel({ id: "secondary", usedPercent: 1, windowMinutes: 2_880 })).toBe("2d")
    expect(shortWindowLabel({ id: "primary", usedPercent: 1, windowMinutes: 45 })).toBe("45m")
    expect(shortWindowLabel({ id: "primary", usedPercent: 1 })).toBe("short")
  })

  test("green under 80% used, amber from 80%, red from 95%", () => {
    expect(usageLevel(0)).toBe("is-ok")
    expect(usageLevel(0.79)).toBe("is-ok")
    expect(usageLevel(0.8)).toBe("is-high")
    expect(usageLevel(0.949)).toBe("is-high")
    expect(usageLevel(0.95)).toBe("is-full")
  })

  test("the bar shows the window closest to its limit, the shorter one on a tie", () => {
    expect(tightestWindow(limits([{ id: "five-hour", usedPercent: 62 }, { id: "weekly", usedPercent: 18 }]))?.id).toBe("five-hour")
    expect(tightestWindow(limits([{ id: "five-hour", usedPercent: 10 }, { id: "weekly", usedPercent: 81 }]))?.id).toBe("weekly")
    expect(tightestWindow(limits([{ id: "five-hour", usedPercent: 40 }, { id: "weekly", usedPercent: 40 }]))?.id).toBe("five-hour")
    expect(tightestWindow(limits([]))).toBeUndefined()
  })

  test("a footer line pairs the short window with the tightest long one", () => {
    const pair = footerWindows(limits([{ id: "five-hour", usedPercent: 62 }, { id: "weekly", usedPercent: 18 }, { id: "weekly-opus", usedPercent: 44 }]))
    expect(pair.map((window) => window.id)).toEqual(["five-hour", "weekly-opus"])
    expect(footerWindows(limits([{ id: "weekly", usedPercent: 18 }])).map((window) => window.id)).toEqual(["weekly"])
  })

  test("every account with a reading that still holds, Claude Code first and each usual login before its own folders", () => {
    const fresh = limits([{ id: "five-hour", usedPercent: 62, resetsAt: NOW + 60_000 }])
    const reset = limits([{ id: "five-hour", usedPercent: 90, resetsAt: NOW - 1 }])
    expect(planReadings({ "codex:codex-2": fresh, codex: fresh, "claude-code:work": fresh, "claude-code": fresh }, NOW).map((reading) => reading.account.key)).toEqual(["claude-code", "claude-code:work", "codex", "codex:codex-2"])
    expect(planReadings({ codex: fresh, "claude-code": reset }, NOW).map((reading) => reading.account.key)).toEqual(["codex"])
    expect(planReadings({ codex: limits(fresh.windows, NOW - 8 * 86_400_000) }, NOW)).toEqual([])
    expect(planReadings({ gemini: fresh, "codex:": fresh }, NOW)).toEqual([])
    expect(planReadings({}, NOW)).toEqual([])
  })

  test("the preview can put Claude Code past the amber or red line", () => {
    expect(parsePreviewScenario("usage-high").usage).toBe("high")
    expect(parsePreviewScenario("pr-none,usage-full").usage).toBe("full")
    expect(parsePreviewScenario("default").usage).toBeUndefined()
  })
})

describe("plan usage per account", () => {
  test("Codex quotas saved under a profile cannot identify its next sign-in", () => {
    const saved = JSON.stringify({ codex: limits([{ id: "weekly", usedPercent: 99 }]), "codex:work": limits([{ id: "weekly", usedPercent: 88 }]), "claude-code": limits([{ id: "weekly", usedPercent: 3 }]) })
    expect(loadPlanLimits({ getItem: () => saved })).toEqual({ "claude-code": limits([{ id: "weekly", usedPercent: 3 }]) })
  })
  test("a new session without a reset time clears the expired reset instead of disappearing", () => {
    const previous = limits([{ id: "five-hour", usedPercent: 90, resetsAt: NOW - 1 }])
    const merged = mergeLimits(previous, { windows: [{ id: "five-hour", usedPercent: 0 }] }, NOW)
    expect(currentLimits(merged, NOW)?.windows).toEqual([{ id: "five-hour", usedPercent: 0 }])
    const active = mergeLimits(limits([{ id: "five-hour", usedPercent: 10, resetsAt: NOW + 60_000 }]), { windows: [{ id: "five-hour", usedPercent: 11 }] }, NOW)
    expect(active.windows[0]?.resetsAt).toBe(NOW + 60_000)
  })
  const tool = (fields: Partial<{ id: string; tool: string; authMode: "subscription" | "api-key"; separateAccount: boolean }>) => ({ id: "c1", tool: "claude-code", authMode: "subscription" as const, separateAccount: false, ...fields })

  test("the usual login, a connection sharing it, a folder of its own, and a key", () => {
    expect(planAccount("claude-code", undefined)).toEqual({ key: "claude-code", source: "claude-code" })
    expect(planAccount("claude-code", tool({}))).toEqual({ key: "claude-code", source: "claude-code" })
    expect(planAccount("claude-code", tool({ id: "work", separateAccount: true }))).toEqual({ key: "claude-code:work", source: "claude-code", connectionId: "work" })
    expect(planAccount("codex", tool({ tool: "codex", authMode: "api-key", separateAccount: true }))).toBeUndefined()
    expect(planAccount("codex", tool({}))).toBeUndefined()
  })

  test("stored readings are checked", () => {
    const saved = JSON.stringify({ "claude-code:work": { plan: "max", windows: [{ id: "weekly-model", model: "Fable", usedPercent: 41 }], at: NOW }, "claude-code:9bad": { windows: [{ id: "weekly", usedPercent: 1 }], at: NOW } })
    expect(loadPlanLimits({ getItem: (key) => (key === "runrail.plan-limits.v2" ? saved : null) })).toEqual({ "claude-code:work": { plan: "max", windows: [{ id: "weekly-model", model: "Fable", usedPercent: 41 }], at: NOW } })
    expect(cleanLimits({ codex: { windows: [{ id: "weekly-model", usedPercent: 4 }], at: NOW } })).toEqual({})
    expect(cleanLimits({ codex: { windows: [{ id: "weekly", model: "Fable", usedPercent: 4 }], at: NOW } })).toEqual({})
  })

  test("each model's own weekly window is its own line, named for the model", () => {
    const fable: PlanWindow = { id: "weekly-model", model: "Fable", usedPercent: 41 }
    expect(windowLabel(fable)).toBe("Weekly · Fable")
    expect(shortWindowLabel(fable)).toBe("wk Fable")
    const merged = mergeLimits(limits([{ id: "weekly-model", model: "Opus", usedPercent: 3 }, fable]), { windows: [{ id: "weekly-model", model: "Fable", usedPercent: 44 }, { id: "five-hour", usedPercent: 9 }] }, NOW)
    expect(merged.windows).toEqual([{ id: "five-hour", usedPercent: 9 }, { id: "weekly-model", model: "Opus", usedPercent: 3 }, { id: "weekly-model", model: "Fable", usedPercent: 44 }])
    expect(footerWindows(merged).map((window) => shortWindowLabel(window))).toEqual(["5h", "wk Fable"])
  })
})

describe("plan usage read with no thread running (usage.read)", () => {
  test("installed accounts keep a usage button when every cached window has reset", () => {
    const html = renderToStaticMarkup(<UsageRings readings={[]} accounts={[{ key: "claude-code", source: "claude-code" }]} labels={{}} />)
    expect(html).toContain("Plan usage, Claude Code: usage unavailable")
    expect(html).toContain("Session limit unavailable")
    expect(html).not.toContain("NaN")
  })
  let asked: string[]
  let most: number

  beforeEach(async () => {
    const host = createFakeHost({ seed: "mixed" })
    const seen: string[] = []
    asked = seen
    most = 0
    let running = 0
    setHost({
      ...host,
      rpc: async (engineId, method, params) => {
        if (method !== "usage.read") return host.rpc(engineId, method, params)
        const { tool, connectionId } = params as { tool: string; connectionId?: string }
        seen.push(connectionId === undefined ? tool : `${tool}:${connectionId}`)
        running += 1
        most = Math.max(most, running)
        try {
          return await host.rpc(engineId, method, params)
        } finally {
          running -= 1
        }
      },
    })
    setPrefs({ planLimits: "on" })
    connectionsChanged()
    resetPlanUsage()
    usePlanLimits.setState({}, true)
    await detectTools(true)
  })

  afterEach(() => {
    setPrefs({ planLimits: "ask" })
  })

  test("after start each account is read once, one after another: signed-out logins and key connections are not asked", async () => {
    await readAllPlanUsage()
    expect(asked).toEqual(["claude-code", "claude-code:claude-code-2"])
    expect(most).toBe(1)
    const stored = usePlanLimits.getState()
    expect(Object.keys(stored)).toEqual(["claude-code"])
    expect(stored["claude-code"]?.plan).toBe("max")
    expect(stored["claude-code"]?.windows.map((window) => shortWindowLabel(window))).toEqual(["5h", "wk", "wk Fable"])
    await readAllPlanUsage()
    expect(asked).toEqual(["claude-code", "claude-code:claude-code-2", "claude-code:claude-code-2"])
    expect(useUsageAccounts.getState().accounts.map((account) => account.key)).toEqual(["claude-code", "claude-code:claude-code-2"])
  })

  test("a failed startup read does not block a retry, and explicit refresh bypasses both caches", async () => {
    const host = createFakeHost({ seed: "mixed" })
    let calls = 0
    const refreshes: unknown[] = []
    setHost({ ...host, rpc: async (engineId, method, params) => {
      if (method !== "usage.read") return host.rpc(engineId, method, params)
      calls += 1
      refreshes.push(params?.refresh)
      if (calls === 1) throw new Error("temporary failure")
      return host.rpc(engineId, method, params)
    } })
    resetPlanUsage(true)
    const account = { key: "claude-code", source: "claude-code" as const }
    await readAccountUsage(account)
    expect(lastUsageRead(account.key)).toBeUndefined()
    await readAccountUsage(account)
    expect(calls).toBe(2)
    expect(usePlanLimits.getState()[account.key]?.windows.some((window) => window.id === "five-hour")).toBe(true)
    await readAccountUsage(account)
    expect(calls).toBe(2)
    await readAccountUsage(account, 0)
    expect(calls).toBe(3)
    expect(refreshes).toEqual([undefined, undefined, true])
  })

  test("Codex refresh replaces the previous sign-in's windows and a failed read clears its quota", async () => {
    const host = createFakeHost({ seed: "mixed" })
    let calls = 0
    setHost({ ...host, rpc: async (engineId, method, params) => {
      if (method !== "usage.read") return host.rpc(engineId, method, params)
      if (++calls === 3) throw new Error("signed out")
      return { account: { label: calls === 1 ? "first@example.invalid" : "second@example.invalid" }, plan: { type: "plan.limits", source: "codex", windows: calls === 1 ? [{ id: "weekly", usedPercent: 99 }] : [{ id: "five-hour", usedPercent: 10 }] } }
    } })
    resetPlanUsage(true)
    const account = { key: "codex", source: "codex" as const }
    await readAccountUsage(account, 0)
    expect(useUsageSignIns.getState().codex).toBe("first@example.invalid")
    await readAccountUsage(account, 0)
    expect(useUsageSignIns.getState().codex).toBe("second@example.invalid")
    expect(usePlanLimits.getState().codex?.windows).toEqual([{ id: "five-hour", usedPercent: 10 }])
    await readAccountUsage(account, 0)
    expect(usePlanLimits.getState().codex).toBeUndefined()
    expect(useUsageSignIns.getState().codex).toBeUndefined()
  })
  test("a signed-out default Codex profile cannot keep a cached usage ring", async () => {
    notePlanReading({ key: "codex", source: "codex" }, { source: "codex", windows: [{ id: "weekly", usedPercent: 99 }] })
    await readAllPlanUsage(0)
    expect(usePlanLimits.getState().codex).toBeUndefined()
    expect(useUsageAccounts.getState().accounts.some((account) => account.source === "codex")).toBe(false)
  })
  test("a read started before connections change cannot resurrect the previous Codex sign-in", async () => {
    const host = createFakeHost({ seed: "mixed" })
    let answer: (value: unknown) => void = () => undefined
    let started: () => void = () => undefined
    const ready = new Promise<void>((resolve) => { started = resolve })
    setHost({ ...host, rpc: async (engineId, method, params) => {
      if (method !== "usage.read") return host.rpc(engineId, method, params)
      return new Promise((resolve) => { answer = resolve; started() })
    } })
    resetPlanUsage(true)
    const pending = readAccountUsage({ key: "codex", source: "codex" }, 0)
    await ready
    resetPlanUsage(true)
    answer({ account: { label: "previous@example.invalid" }, plan: { type: "plan.limits", source: "codex", windows: [{ id: "weekly", usedPercent: 99 }] } })
    await pending
    expect(usePlanLimits.getState().codex).toBeUndefined()
    expect(useUsageSignIns.getState().codex).toBeUndefined()
  })
  test("startup refresh recovers from an empty cached tool detection", async () => {
    const host = createFakeHost({ seed: "mixed" })
    let detections = 0
    setHost({ ...host, rpc: async (engineId, method, params) => {
      if (method === "harness.status" && ++detections === 1) return []
      return host.rpc(engineId, method, params)
    } })
    expect(await detectTools(true)).toEqual([])
    resetPlanUsage(true)
    await readAllPlanUsage(0)
    expect(detections).toBe(2)
    expect(useUsageAccounts.getState().accounts.some((account) => account.key === "claude-code")).toBe(true)
    expect(usePlanLimits.getState()["claude-code"]?.windows.some((window) => window.id === "five-hour")).toBe(true)
  })

  test("startup retries a missing five-hour window without waiting for the user to refresh", async () => {
    const host = createFakeHost({ seed: "mixed" })
    let calls = 0
    setHost({ ...host, rpc: async (engineId, method, params) => {
      if (method !== "usage.read") return host.rpc(engineId, method, params)
      calls += 1
      expect(params?.refresh).toBe(true)
      return { plan: { type: "plan.limits", source: "claude-code", windows: calls === 1 ? [{ id: "weekly", usedPercent: 20 }] : [{ id: "five-hour", usedPercent: 10, resetsAt: Date.now() + 300_000 }] } }
    } })
    resetPlanUsage(true)
    const { timers, restore } = fakeWindow()
    const stop = initPlanUsage()
    try {
      expect(timers[0]?.delay).toBe(2_000)
      await timers[0]!.run()
      expect(usePlanLimits.getState()["claude-code"]?.windows.some((window) => window.id === "five-hour")).toBe(false)
      expect(timers[1]?.delay).toBe(10_000)
      await timers[1]!.run()
      expect(usePlanLimits.getState()["claude-code"]?.windows.map((window) => window.id)).toEqual(["five-hour", "weekly"])
      expect(timers).toHaveLength(2)
    } finally {
      stop()
      restore()
    }
  })

  test("not asked yet or turned off, nothing starts a tool: not at start, on focus, on a connection change, or on Refresh", async () => {
    for (const answer of ["ask", "off"] as const) {
      setPrefs({ planLimits: answer })
      notePlanReading({ key: "claude-code", source: "claude-code" }, { source: "claude-code", windows: [{ id: "weekly", usedPercent: 40 }] })
      const { timers, listening, fire, restore } = fakeWindow()
      const stop = initPlanUsage()
      try {
        expect(timers).toEqual([])
        expect(listening("focus")).toBe(0)
        // A reading saved by an earlier start is dropped, not shown.
        expect(usePlanLimits.getState()).toEqual({})
        fire("focus")
        connectionsChanged()
        await readAllPlanUsage(0)
        await readAccountUsage({ key: "claude-code", source: "claude-code" }, 0)
        await readAccountUsage({ key: "codex", source: "codex" }, 0)
        await settle()
        expect(asked).toEqual([])
        expect(useUsageAccounts.getState().accounts).toEqual([])
      } finally {
        stop()
        restore()
      }
    }
  })

  test("turned on, every account is read right away and then on focus and connection changes", async () => {
    setPrefs({ planLimits: "ask" })
    const { timers, listening, restore } = fakeWindow()
    try {
      setPlanLimits(true)
      expect(get().prefs.planLimits).toBe("on")
      expect(timers[0]?.delay).toBe(0)
      expect(listening("focus")).toBe(1)
      await timers[0]!.run()
      expect(asked).toEqual(["claude-code", "claude-code:claude-code-2"])
      expect(usePlanLimits.getState()["claude-code"]?.windows.length).toBeGreaterThan(0)
      connectionsChanged()
      await settle()
      expect(asked.length).toBeGreaterThan(2)
    } finally {
      setPlanLimits(false)
      restore()
    }
  })

  test("turned off, the readings go, timers and watchers stop, and nothing more is read", async () => {
    setPrefs({ planLimits: "ask" })
    const { timers, listening, restore } = fakeWindow()
    try {
      setPlanLimits(true)
      await timers[0]!.run()
      // The own-folder account has no reading yet, so a retry waits.
      const retry = timers[1]
      expect(retry?.cleared).toBe(false)
      const before = asked.length
      setPlanLimits(false)
      expect(get().prefs.planLimits).toBe("off")
      expect(usePlanLimits.getState()).toEqual({})
      expect(useUsageAccounts.getState().accounts).toEqual([])
      expect(retry?.cleared).toBe(true)
      expect(listening("focus")).toBe(0)
      // A timer that fired anyway, a connection change, and Refresh all read nothing.
      await retry!.run()
      connectionsChanged()
      await readAccountUsage({ key: "claude-code", source: "claude-code" }, 0)
      await settle()
      expect(asked).toHaveLength(before)
      expect(usePlanLimits.getState()).toEqual({})
    } finally {
      restore()
    }
  })

  test("the rail has a ring per account, an own folder named by its connection, each its own button", async () => {
    await readAllPlanUsage()
    expect(useAccountLabels.getState()["claude-code-2"]).toBe("Claude Code (work)")
    notePlanReading({ key: "claude-code", source: "claude-code" }, { source: "claude-code", windows: [{ id: "weekly-model", model: "Fable", usedPercent: 81 }] })
    notePlanReading({ key: "claude-code:claude-code-2", source: "claude-code", connectionId: "claude-code-2" }, { source: "claude-code", windows: [{ id: "weekly", usedPercent: 30 }] })
    // A frame about another tool than the account's is not filed there.
    notePlanReading({ key: "codex", source: "codex" }, { source: "claude-code", windows: [{ id: "weekly", usedPercent: 30 }] })
    const text = renderToStaticMarkup(<UsageRings readings={planReadings(usePlanLimits.getState(), Date.now())} labels={useAccountLabels.getState()} />)
    const lines = [...text.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])
    expect(lines).toEqual(["Plan usage, Claude Code Max: Session limit 62%, Weekly · Fable 81%", "Plan usage, Claude Code (work): Weekly 30%"])
    expect(text).toContain("wk Fable 81%")
    // The ring takes the tightest window's color.
    expect(text).toContain("usage-ring is-high")
    expect(renderToStaticMarkup(<UsageRings readings={planReadings({ "claude-code:gone": { windows: [{ id: "weekly", usedPercent: 1 }], at: Date.now() } }, Date.now())} labels={{}} />)).toContain("Claude Code (own sign-in)")
  })

  test("an account whose tool goes through a proxy says so; an own folder is not assumed to", async () => {
    const proxy = { address: "127.0.0.1:8787", name: "OpenAI via Headroom proxy" }
    await readAllPlanUsage()
    // As harness.status said it: the preview's Codex goes through Headroom, Claude Code goes direct.
    expect(useToolProxies.getState()).toEqual({ codex: proxy })
    expect(proxyText(proxy)).toBe("OpenAI via Headroom proxy at 127.0.0.1:8787")
    expect(proxyText({ address: "127.0.0.1:8787" })).toBe("Via a proxy at 127.0.0.1:8787")
    const now = Date.now()
    const reading = { windows: [{ id: "weekly" as const, usedPercent: 7 }], at: now }
    const text = renderToStaticMarkup(<UsageRings readings={planReadings({ codex: reading, "codex:own": reading }, now)} labels={{ own: "Codex (work)" }} proxies={{ codex: proxy }} />)
    const lines = [...text.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])
    expect(lines).toEqual(["Plan usage, Codex: Weekly 7%; OpenAI via Headroom proxy at 127.0.0.1:8787", "Plan usage, Codex (work): Weekly 7%"])
  })

  test("removing a connection drops its reading; the usual login stays", async () => {
    await listConnectionSettings()
    notePlanReading({ key: "claude-code", source: "claude-code" }, { source: "claude-code", windows: [{ id: "weekly", usedPercent: 5 }] })
    notePlanReading({ key: "claude-code:gone", source: "claude-code", connectionId: "gone" }, { source: "claude-code", windows: [{ id: "weekly", usedPercent: 5 }] })
    await readAllPlanUsage()
    expect(Object.keys(usePlanLimits.getState()).sort()).toEqual(["claude-code"])
  })
})

describe("thread views show no plan usage", () => {
  test("only the rail reads plan usage; a thread's files share the meter and nothing else", () => {
    const dir = join(import.meta.dir, "../src/ui/thread")
    const readers = readdirSync(dir).filter((name) => name !== "PlanUsage.tsx" && /\.tsx?$/.test(name)).filter((name) => /usePlanLimits|planReadings|RailUsage|readAccountUsage|currentLimits/.test(readFileSync(join(dir, name), "utf8")))
    expect(readers).toEqual([])
  })
})
