import { describe, expect, test } from "bun:test"
import { conversationText, memoryLabel, parseSuggestions, staleSources, suggestPrompt } from "../src/app/memory"
import type { StreamFrame } from "../src/host/types"
import { MemorySchema, parseOr, type MemorySourceInfo } from "../src/protocol/schemas"
import { recalledIn } from "../src/thread/recall"
import { addPendingUser, applyFrames, displayPrompt, emptyTimeline, loadHistory, type TimelineItem } from "../src/thread/reducer"

let seq = 0
function event(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

// The engine's block, exactly as `src/memory/block.ts` writes it.
const BLOCK =
  "\n\n[Runrail recalled memories: use them only where they help, and cite one as [m1] when you rely on it]\n[m1] project memory, from release.md: Releases are cut on Tuesdays.\n[m2] your memory: I like: small pull requests.\n[note] The memory server did not answer (timeout); these are from local memory.\n[End recalled memories]"

describe("recalled memories", () => {
  test("travel after the message, hidden in the bubble and read back as numbered memories with the note", () => {
    const sent = `When do we release?${BLOCK}`
    expect(displayPrompt(sent)).toBe("When do we release?")
    expect(recalledIn(sent)).toEqual({
      recalled: [
        { n: 1, label: "project memory, from release.md", text: "Releases are cut on Tuesdays." },
        { n: 2, label: "your memory", text: "I like: small pull requests." },
      ],
      recallNote: "The memory server did not answer (timeout); these are from local memory.",
    })
    expect(recalledIn("no memories here")).toEqual({})
    expect(recalledIn(`${sent}\n\n[Runrail file attachment: a.txt]\nhello\n[End file attachment]`).recalled?.length).toBe(2)
  })

  test("show on the live bubble and on a reopened thread alike", () => {
    const sent = `When do we release?${BLOCK}`
    const pending = addPendingUser(emptyTimeline(), { text: "When do we release?", attachments: 0 })
    const live = applyFrames(pending.timeline, [event("turn.started", { turnId: "t1", prompt: sent })])
    const user = live.items.find((item) => item.kind === "user")
    expect(user?.kind === "user" ? [user.key, user.text, user.recalled?.length, user.recallNote !== undefined] : undefined).toEqual([pending.key, "When do we release?", 2, true])
    const reopened = loadHistory(emptyTimeline(), [{ id: "u1", seq: 0, kind: "user", turnId: "t1", text: sent, at: 1 }], false)
    const again = reopened.items.find((item) => item.kind === "user")
    expect(again?.kind === "user" ? [again.text, again.recalled?.map((memory) => memory.n)] : undefined).toEqual(["When do we release?", [1, 2]])
  })

  test("labels say whose memory it is and where it came from", () => {
    expect(memoryLabel({ scope: "project", source: { kind: "folder", ref: "docs/a.md" } })).toBe("project memory, from docs/a.md")
    expect(memoryLabel({ scope: "person", source: { kind: "suggested" } })).toBe("your memory")
    expect(memoryLabel({ scope: "project", source: { kind: "github", ref: "#7" } })).toBe("project memory, from issue #7")
    expect(memoryLabel({ scope: "external", source: { kind: "manual" } })).toBe("memory server")
  })

  test("another project's memory never reads as this one's", () => {
    expect(parseOr(MemorySchema, { id: "m", scope: "project:abc", text: "t", source: { kind: "manual" }, createdAt: 1, updatedAt: 1 })?.scope).toBe("other")
  })
})

describe("remember this?", () => {
  const items: TimelineItem[] = [
    { kind: "user", key: "u1", turnId: "t1", text: "Fix the parser", attachments: 0, state: "sent", at: 1 },
    { kind: "assistant", key: "a1", turnId: "t1", text: "Done. Blank lines are skipped now.", streaming: false, at: 2 },
    { kind: "assistant", key: "a2", turnId: "t1", text: "   ", streaming: false, at: 3 },
  ]

  test("the conversation goes as person and agent lines, newest kept when long", () => {
    expect(conversationText(items)).toBe("Person: Fix the parser\n\nAgent: Done. Blank lines are skipped now.")
    const long: TimelineItem[] = Array.from({ length: 400 }, (_, index) => ({
      kind: "user" as const,
      key: `u${String(index)}`,
      text: `message ${String(index)} ${"x".repeat(100)}`,
      attachments: 0,
      state: "sent" as const,
      at: index,
    }))
    const text = conversationText(long)
    expect(text.length).toBe(24_000)
    expect(text.endsWith(`message 399 ${"x".repeat(100)}`)).toBe(true)
    expect(suggestPrompt("C")).toContain("<conversation>\nC\n</conversation>")
  })

  test("suggestions come from the last json block, at most five, project unless person", () => {
    const answer = 'Here.\n\n```json\n{"memories": [{"text": " Use bun ", "scope": "person"}, {"text": "Tests in test/"}, {"text": ""}, {"scope": "project"}]}\n```'
    expect(parseSuggestions(answer)).toEqual([
      { text: "Use bun", scope: "person", state: "new" },
      { text: "Tests in test/", scope: "project", state: "new" },
    ])
    expect(parseSuggestions("no block")).toBeUndefined()
    expect(parseSuggestions('```json\n{"memories": "x"}\n```')).toBeUndefined()
  })
})

test("a source is synced again once an hour", () => {
  const source = (at?: number): MemorySourceInfo => ({
    id: "s",
    kind: "folder",
    scope: "project",
    name: "n",
    target: "/t",
    addedAt: 0,
    entries: 0,
    ...(at === undefined ? {} : { lastSync: { at, ok: true, added: 0, removed: 0, kept: 0 } }),
  })
  expect(staleSources([source(), source(0), source(3_000_000)], 3_600_000).length).toBe(2)
})
