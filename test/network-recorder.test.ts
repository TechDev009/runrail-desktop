import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * The script every browser preview runs before the page's own, run here on a
 * stand-in window: requests are kept with their method, status, and address, never their query.
 */

const source = readFileSync(resolve(import.meta.dir, "../src-tauri/src/preview_agent.rs"), "utf8")
const recorder = /pub const NETWORK_RECORDER: &str = r#"([\s\S]*?)"#;/.exec(source)?.[1] ?? ""

type Entry = { kind: string; method: string; url: string; status?: number; failed?: string; ms: number }

function page(answer: (url: string) => Promise<{ status: number }>) {
  class FakeRequest {
    status = 0
    private readonly listeners: (() => void)[] = []
    open(_method: string, _url: string): void {}
    send(): void {
      this.status = 404
      for (const listener of this.listeners) listener()
    }
    addEventListener(_name: string, listener: () => void): void {
      this.listeners.push(listener)
    }
  }
  const window: Record<string, unknown> = { fetch: (input: string) => answer(input) }
  window.top = window
  new Function("window", "XMLHttpRequest", "location", "performance", "PerformanceObserver", recorder)(window, FakeRequest, { href: "http://localhost:5173/app" }, { now: () => 0 }, undefined)
  return { window, FakeRequest, entries: window.__runrailNetwork as Entry[] }
}

test("the recorder is found in the host's source", () => {
  expect(recorder).toContain("__runrailNetwork")
})

test("fetches are kept with their status, and the query never", async () => {
  const { window, entries } = page(async () => ({ status: 500 }))
  const fetch = window.fetch as (input: string, init?: { method?: string }) => Promise<{ status: number }>
  expect((await fetch("/api/sessions?token=secret#x", { method: "post" })).status).toBe(500)
  expect(entries).toEqual([{ kind: "fetch", method: "POST", url: "http://localhost:5173/api/sessions?...", status: 500, ms: 0 }])
  expect(JSON.stringify(entries)).not.toContain("secret")
})

test("a failed fetch is kept and still fails for the page", async () => {
  const { window, entries } = page(async () => {
    throw new TypeError("Load failed")
  })
  const fetch = window.fetch as (input: string) => Promise<unknown>
  await expect(fetch("https://api.example.com/v1/me")).rejects.toThrow("Load failed")
  expect(entries).toEqual([{ kind: "fetch", method: "GET", url: "https://api.example.com/v1/me", failed: "Load failed", ms: 0 }])
})

test("XMLHttpRequest calls are kept too, and the log holds the last hundred", async () => {
  const { window, FakeRequest, entries } = page(async () => ({ status: 200 }))
  const request = new FakeRequest()
  request.open("get", "http://localhost:5173/users.json?page=2")
  request.send()
  expect(entries[0]).toEqual({ kind: "xhr", method: "GET", url: "http://localhost:5173/users.json?...", status: 404, ms: 0 })
  const fetch = window.fetch as (input: string) => Promise<unknown>
  for (let index = 0; index < 120; index += 1) await fetch(`/item/${String(index)}`)
  expect(entries).toHaveLength(100)
  expect(entries.at(-1)?.url).toBe("http://localhost:5173/item/119")
})
