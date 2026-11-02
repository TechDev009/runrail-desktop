import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "bun:test"
import { Markdown, streamingBlocks } from "../src/ui/thread/Markdown"
import { AssistantRow, UserRow } from "../src/ui/thread/rows"
import type { AssistantItem, UserItem } from "../src/thread/reducer"

test("a streaming answer is cut at blank lines, never inside a code fence", () => {
  const text = "Intro line.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n- one\n- two\n\nTail"
  expect(streamingBlocks(text)).toEqual(["Intro line.", "```ts\nconst a = 1\n\nconst b = 2\n```", "- one\n- two", "Tail"])
  expect(streamingBlocks("````\n```\n\n````\nafter")).toEqual(["````\n```\n\n````\nafter"])
  expect(streamingBlocks("open fence\n```\nstill code\n\nmore")).toEqual(["open fence\n```\nstill code\n\nmore"])
})

function renderedBlock(language: string, streaming = false): string {
  const text = [`\`\`\`${language}`, "echo ready", "\`\`\`"].join("\n")
  return renderToStaticMarkup(createElement(Markdown, { text, threadId: "thread-a", streaming }))
}

test("Run is available only for supported shell fences in completed markdown", () => {
  for (const language of ["bash", "sh", "zsh", "shell"]) expect(renderedBlock(language)).toContain(">Run</span>")
  for (const language of ["ts", "python", "text", ""]) expect(renderedBlock(language)).not.toContain(">Run</span>")
  expect(renderedBlock("bash", true)).not.toContain(">Run</span>")
})

test("only complete assistant replies with a thread target expose Run", () => {
  const text = ["```bash", "echo ready", "```"].join("\n")
  const answer: AssistantItem = { kind: "assistant", key: "a", text, streaming: false, at: 1 }
  const user: UserItem = { kind: "user", key: "u", text, attachments: 0, state: "sent", at: 1 }
  expect(renderToStaticMarkup(createElement(AssistantRow, { item: answer, threadId: "thread-a" }))).toContain(">Run</span>")
  expect(renderToStaticMarkup(createElement(AssistantRow, { item: answer }))).not.toContain(">Run</span>")
  expect(renderToStaticMarkup(createElement(AssistantRow, { item: { ...answer, streaming: true }, threadId: "thread-a" }))).not.toContain(">Run</span>")
  expect(renderToStaticMarkup(createElement(UserRow, { item: user, threadId: "thread-a" }))).not.toContain(">Run</span>")
})
