import { HostError } from "./types"

/**
 * The preview's memory: a few memories for the project and the person, recall by shared words as
 * the engine's `memory.recall` does, and sources that "sync" a fixed set of entries.
 */

interface FakeEntry {
  id: string
  scope: "project" | "person"
  text: string
  source: { readonly kind: string; readonly id?: string; readonly ref?: string }
  createdAt: number
  updatedAt: number
}

interface FakeSource {
  readonly id: string
  readonly kind: "folder" | "github" | "feed"
  readonly scope: "project" | "person"
  readonly name: string
  readonly target: string
  readonly addedAt: number
  lastSync?: { at: number; ok: boolean; error?: string; added: number; removed: number; kept: number }
}

const STOP = new Set(
  "the and for are but not you all any can had was one our out has have this that with from they will would there their what about which when your into than then them these some just also only very more most such over does did how why who its use used using should could make made like want need get".split(
    " ",
  ),
)

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []).filter((word) => !STOP.has(word)))].slice(0, 12)
}

const SOURCE_TEXT: Readonly<Record<FakeSource["kind"], readonly { readonly ref: string; readonly text: string }[]>> = {
  folder: [
    { ref: "release.md", text: "Releases are cut from main on Tuesdays and tagged vX.Y.Z." },
    { ref: "onboarding/setup.md", text: "Run bun install, then bun run dev. The preview opens on port 1420." },
  ],
  github: [
    { ref: "#41", text: "#41 Session parser drops blank lines\n\nBlank lines in a session file end the parse early." },
    { ref: "#38", text: "#38 Add dark mode to the share page" },
  ],
  feed: [{ ref: "post-1", text: "Release 2.0\n\nFaster builds and a smaller bundle." }],
}

export class FakeMemory {
  private readonly entries: FakeEntry[] = [
    {
      id: "mem-1",
      scope: "project",
      text: "Deploys go to staging first, then production after the smoke test passes.",
      source: { kind: "manual" },
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 86_400_000,
    },
    {
      id: "mem-2",
      scope: "project",
      text: "parseSession lives in src/session.ts; its tests are in test/session.test.ts.",
      source: { kind: "suggested" },
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 3_600_000,
    },
    { id: "mem-3", scope: "person", text: "I prefer small pull requests with one change each.", source: { kind: "manual" }, createdAt: Date.now() - 7_200_000, updatedAt: Date.now() - 7_200_000 },
  ]
  private readonly sources: FakeSource[] = []
  private provider: unknown = "local"
  private next = 10

  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "memory.status":
        return {
          provider: this.provider === "local" ? { kind: "local" } : { kind: "mcp", name: (this.provider as { name: string }).name },
          health: { ok: true, detail: `${String(this.entries.length)} memories` },
          counts: { project: this.count("project"), person: this.count("person") },
        }
      case "memory.recall": {
        const query = terms(String(params.query ?? ""))
        if (query.length === 0) return { hits: [] }
        const hits = this.entries
          .map((entry) => ({ ...entry, score: Math.min(1, query.filter((term) => entry.text.toLowerCase().includes(term.length > 5 ? term.slice(0, -2) : term)).length / Math.min(query.length, 4)), from: "local" }))
          .filter((hit) => hit.score >= 0.34)
          .sort((a, b) => b.score - a.score)
          .slice(0, typeof params.limit === "number" ? params.limit : 3)
        return { hits }
      }
      case "memory.add": {
        const text = String(params.text ?? "").trim()
        if (text.length === 0) throw new HostError("CONTROL_MEMORY_INVALID", "a memory is text up to 4000 characters", 400)
        const entry: FakeEntry = {
          id: `mem-${String((this.next += 1))}`,
          scope: params.scope === "person" ? "person" : "project",
          text,
          source: { kind: params.source === "suggested" ? "suggested" : "manual" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        this.entries.unshift(entry)
        return entry
      }
      case "memory.update": {
        const entry = this.entries.find((item) => item.id === params.id)
        if (entry === undefined) throw new HostError("CONTROL_MEMORY_NOT_FOUND", "no memory has that id", 404)
        entry.text = String(params.text)
        entry.updatedAt = Date.now()
        return entry
      }
      case "memory.forget": {
        const index = this.entries.findIndex((item) => item.id === params.id)
        if (index >= 0) this.entries.splice(index, 1)
        return { forgotten: index >= 0 }
      }
      case "memory.list": {
        const query = typeof params.query === "string" ? params.query.toLowerCase() : undefined
        return {
          memories: this.entries
            .filter((entry) => (params.sourceId === undefined || entry.source.id === params.sourceId) && (query === undefined || entry.text.toLowerCase().includes(query)))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        }
      }
      case "memory.settings.get":
        return { provider: this.provider }
      case "memory.settings.set":
        this.provider =
          params.provider === "server-memory"
            ? { kind: "mcp", name: "MCP memory server", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], mapping: {} }
            : params.provider === "local"
              ? "local"
              : { kind: "mcp", ...(params.provider as object) }
        return { provider: this.provider }
      case "memory.source.list":
        return { sources: this.sources.map((source) => ({ ...source, entries: this.entries.filter((entry) => entry.source.id === source.id).length })) }
      case "memory.source.add": {
        const kind = params.kind === "github" || params.kind === "feed" ? params.kind : "folder"
        const target = String(params.target ?? "").trim()
        if (kind === "folder" && !target.startsWith("/")) throw new HostError("CONTROL_MEMORY_INVALID", "a folder must be an absolute path", 400)
        const source: FakeSource = {
          id: `src-${crypto.randomUUID()}`,
          kind,
          scope: params.scope === "person" ? "person" : "project",
          name: kind === "folder" ? (target.split("/").filter(Boolean).pop() ?? target) : kind === "github" ? `${target} issues` : (target.replace(/^https?:\/\//, "").split("/")[0] ?? target),
          target,
          addedAt: Date.now(),
        }
        this.sources.push(source)
        return { ...source, entries: 0 }
      }
      case "memory.source.remove": {
        const index = this.sources.findIndex((source) => source.id === params.id)
        if (index < 0) return { removed: false, forgotten: 0 }
        this.sources.splice(index, 1)
        const before = this.entries.length
        for (let at = this.entries.length - 1; at >= 0; at -= 1) if (this.entries[at]?.source.id === params.id) this.entries.splice(at, 1)
        return { removed: true, forgotten: before - this.entries.length }
      }
      case "memory.source.sync": {
        const source = this.sources.find((entry) => entry.id === params.id)
        if (source === undefined) throw new HostError("CONTROL_MEMORY_NOT_FOUND", "no source has that id", 404)
        await new Promise((resolve) => setTimeout(resolve, 800))
        const had = this.entries.filter((entry) => entry.source.id === source.id).length
        if (had === 0)
          for (const item of SOURCE_TEXT[source.kind])
            this.entries.push({ id: `mem-${String((this.next += 1))}`, scope: source.scope, text: item.text, source: { kind: source.kind, id: source.id, ref: item.ref }, createdAt: Date.now(), updatedAt: Date.now() })
        source.lastSync = { at: Date.now(), ok: true, added: had === 0 ? SOURCE_TEXT[source.kind].length : 0, removed: 0, kept: had }
        return { ...source, entries: this.entries.filter((entry) => entry.source.id === source.id).length }
      }
      default:
        throw new HostError("CONTROL_METHOD_UNKNOWN", `preview does not implement ${method}`, 404)
    }
  }

  /** What the engine appends to a message sent with `recall: true`, in its exact format. */
  async blockFor(text: string): Promise<string> {
    const { hits } = (await this.rpc("memory.recall", { query: text, limit: 3 })) as { hits: readonly FakeEntry[] }
    if (hits.length === 0) return ""
    const label = (entry: FakeEntry): string =>
      `${entry.scope === "person" ? "your memory" : "project memory"}${entry.source.kind === "folder" && entry.source.ref !== undefined ? `, from ${entry.source.ref}` : entry.source.kind === "github" && entry.source.ref !== undefined ? `, from issue ${entry.source.ref}` : ""}`
    const lines = hits.map((hit, index) => `[m${String(index + 1)}] ${label(hit)}: ${hit.text.replace(/\s+/g, " ")}`)
    return `\n\n[Runrail recalled memories: use them only where they help, and cite one as [m1] when you rely on it]\n${lines.join("\n")}\n[End recalled memories]`
  }

  private count(scope: FakeEntry["scope"]): number {
    return this.entries.filter((entry) => entry.scope === scope).length
  }
}
