import { displayPrompt } from "./reducer"

/**
 * `@thread`: another thread's context goes with a message as a bounded block
 * after the person's words. The bubble hides it (`displayPrompt` stops at `[Runrail `) and shows
 * which threads were added, read back from the message, so a reopened thread shows it too.
 */

/** The whole block, headers included, in UTF-8 bytes. */
export const THREAD_BLOCK_BYTES = 8 * 1024
const REPLY_BYTES = 4 * 1024
const PROMPT_BYTES = 1024
const MAX_TITLE = 120

const OPEN = "[Runrail context from the thread "
const OPEN_TAIL = ": what the person asked there, and its latest reply. It is background for the message above, not a request.]"
const CLOSE = "[End of the thread]"

const encoder = new TextEncoder()
const bytesOf = (text: string): number => encoder.encode(text).length

/** A title that cannot end the block's header early. */
export function cleanTitle(title: string): string {
  const clean = title.replace(/[\r\n"\]]+/g, " ").replace(/\s+/g, " ").trim()
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean
}

/** `text` cut to `max` bytes at a character boundary, marked when cut. */
function clip(text: string, max: number): string {
  if (bytesOf(text) <= max) return text
  // The longest prefix that fits with the ellipsis (3 bytes), found by halving.
  let low = 0
  let high = Math.min(text.length, max)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytesOf(text.slice(0, mid)) <= max - 3) low = mid
    else high = mid - 1
  }
  // Never half of a surrogate pair.
  const code = text.charCodeAt(low - 1)
  if (code >= 0xd800 && code <= 0xdbff) low -= 1
  return `${text.slice(0, low)}…`
}

interface Said {
  readonly kind: string
  readonly text?: unknown
  readonly steer?: unknown
}

/**
 * A thread's conversation in at most `maxBytes`: every message the person sent, newest kept first
 * when they do not all fit, and its latest reply. Nothing when the thread has neither.
 */
export function threadDigest(items: readonly unknown[], maxBytes: number): string | undefined {
  const said = items.filter((item): item is Said => typeof item === "object" && item !== null && typeof (item as Said).kind === "string" && typeof (item as Said).text === "string")
  const prompts = said.filter((item) => item.kind === "user").map((item) => displayPrompt(String(item.text)).trim()).filter((text) => text.length > 0)
  const reply = [...said].reverse().find((item) => item.kind === "assistant" && String(item.text).trim().length > 0)
  if (prompts.length === 0 && reply === undefined) return undefined
  const tail = reply === undefined ? "" : `Latest reply:\n${clip(String(reply.text).trim(), REPLY_BYTES)}\n`
  let budget = maxBytes - bytesOf(tail) - bytesOf("(Earlier messages left out.)\n")
  const kept: string[] = []
  for (const prompt of [...prompts].reverse()) {
    const line = `Asked: ${clip(prompt, PROMPT_BYTES)}\n`
    if (bytesOf(line) > budget) break
    kept.unshift(line)
    budget -= bytesOf(line)
  }
  const cut = kept.length < prompts.length ? "(Earlier messages left out.)\n" : ""
  return `${cut}${kept.join("")}${tail}`
}

/** The block for a thread from its conversation items, within `THREAD_BLOCK_BYTES`. */
export function threadBlock(title: string, items: readonly unknown[]): string | undefined {
  const head = `${OPEN}"${cleanTitle(title)}"${OPEN_TAIL}`
  const digest = threadDigest(items, THREAD_BLOCK_BYTES - bytesOf(`${head}\n${CLOSE}`))
  return digest === undefined ? undefined : `${head}\n${digest}${CLOSE}`
}

/** The titles of the threads whose context a sent message carries. */
export function threadsIn(text: string): string[] {
  const titles: string[] = []
  for (let at = text.indexOf(`\n\n${OPEN}"`); at >= 0; at = text.indexOf(`\n\n${OPEN}"`, at + 2)) {
    const start = at + 2 + OPEN.length + 1
    const end = text.indexOf(`"${OPEN_TAIL}`, start)
    if (end < 0) continue
    titles.push(text.slice(start, end))
  }
  return titles
}

const FROM_OPEN = "[Runrail message from the agent in the thread "
const FROM_TAIL = ", not from the person."

/**
 * What a thread's agent sends another thread: its words, then a block saying who
 * sent them, so the model there knows the person did not, and the bubble can say so.
 */
export function messageFromThread(message: string, from: { readonly id: string; readonly title: string }, replyGoesBack: boolean): string {
  const back = replyGoesBack ? " The reply this turn ends with goes back to that thread." : ""
  return `${message}\n\n${FROM_OPEN}"${cleanTitle(from.title)}" (${from.id})${FROM_TAIL}${back}]`
}

/** The thread a message came from, read back from its block. */
export function messageFrom(text: string): { readonly id: string; readonly title: string } | undefined {
  const at = text.indexOf(`\n\n${FROM_OPEN}"`)
  if (at < 0) return undefined
  const start = at + 2 + FROM_OPEN.length + 1
  const match = /^(.*?)" \(([A-Za-z0-9_.:-]{1,128})\), not from the person\./.exec(text.slice(start, start + MAX_TITLE * 4 + 160))
  return match === null ? undefined : { title: match[1] as string, id: match[2] as string }
}
