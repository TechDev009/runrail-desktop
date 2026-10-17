import { expect, test } from "bun:test"
import { streamingBlocks } from "../src/ui/thread/Markdown"

test("a streaming answer is cut at blank lines, never inside a code fence", () => {
  const text = "Intro line.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n- one\n- two\n\nTail"
  expect(streamingBlocks(text)).toEqual(["Intro line.", "```ts\nconst a = 1\n\nconst b = 2\n```", "- one\n- two", "Tail"])
  expect(streamingBlocks("````\n```\n\n````\nafter")).toEqual(["````\n```\n\n````\nafter"])
  expect(streamingBlocks("open fence\n```\nstill code\n\nmore")).toEqual(["open fence\n```\nstill code\n\nmore"])
})
