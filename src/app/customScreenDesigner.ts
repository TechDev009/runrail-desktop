import { z } from "zod"
import { CUSTOM_SCREEN_API_CATALOG } from "./harnessApi"
import { MAX_CUSTOM_SCREEN_BYTES, type CustomScreen, type CustomScreenIcon } from "./persist"
import type { Timeline } from "../thread/reducer"

export const MAX_AI_SOURCE_BYTES = 24 * 1024
export const MAX_AI_REQUEST_BYTES = 64 * 1024
export const MAX_AI_DESCRIPTION_LENGTH = 8_000

const GeneratedScreenSchema = z.object({
  name: z.string().trim().min(1).max(40),
  icon: z.enum(["code", "workflow", "terminal", "layout"]),
  html: z.string().max(MAX_CUSTOM_SCREEN_BYTES),
  css: z.string().max(MAX_CUSTOM_SCREEN_BYTES),
  javascript: z.string().max(MAX_CUSTOM_SCREEN_BYTES),
}).strict()

type GeneratedScreen = {
  readonly name: string
  readonly icon: CustomScreenIcon
  readonly html: string
  readonly css: string
  readonly javascript: string
}

type ParseResult = { readonly ok: true; readonly screen: GeneratedScreen } | { readonly ok: false; readonly reason: string }

export function assistantText(timeline: Timeline, turnId: string): string {
  return timeline.items
    .flatMap((item) => item.kind === "assistant" && item.turnId === turnId && item.text.trim().length > 0 ? [item.text] : [])
    .join("\n")
    .trim()
}

export function parseGeneratedScreen(response: string): ParseResult {
  const fenced = response.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const payload = fenced?.[1] ?? response.trim()
  if (new TextEncoder().encode(payload).byteLength > MAX_CUSTOM_SCREEN_BYTES * 2) {
    return { ok: false, reason: "The AI response was too large to apply. Ask it for a smaller, simpler screen." }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(payload) as unknown
  } catch {
    return { ok: false, reason: "The AI response wasn't valid screen data. Ask it to return the screen again, or open the AI conversation." }
  }
  const parsed = GeneratedScreenSchema.safeParse(decoded)
  if (!parsed.success) return { ok: false, reason: "The AI response didn't match the screen format. Ask it to return the screen again, or open the AI conversation." }
  const bytes = new TextEncoder().encode(parsed.data.html).byteLength
    + new TextEncoder().encode(parsed.data.css).byteLength
    + new TextEncoder().encode(parsed.data.javascript).byteLength
  if (bytes > MAX_CUSTOM_SCREEN_BYTES) return { ok: false, reason: "The generated screen exceeds the 256 KB limit. Ask for a smaller screen." }
  return { ok: true, screen: parsed.data }
}

export function designerPrompt(description: string, projectName: string, screen: CustomScreen): string {
  const current = {
    name: screen.name,
    icon: screen.icon,
    html: screen.html,
    css: screen.css,
    javascript: screen.javascript,
  }
  const prompt = [
    "Build or refine the user's Runrail custom screen. The screen lives at one fixed destination in Runrail's left navigation and opens in its isolated desktop webview.",
    "Create an excellent, useful, fully working UI for the requested workflow. Keep the requested layout responsive and make buttons perform actions through the Runrail bridge where relevant. The bridge is a global named runrail.",
    "Use only the API methods, feature routes, RPC calls, and host calls listed in the supplied API catalog. The catalog's confirmationRequired and routesToRunrailUi entries describe existing safeguards. Never bypass them, access keys or app storage, use arbitrary native commands, or call unrelated services.",
    "Do not inspect, create, or edit project files. Do not call tools. Return only one JSON object with exactly these fields: name (1-40 characters), icon (code, workflow, terminal, or layout), html, css, javascript. Do not wrap the object in markdown or add explanation.",
    "The screen source will be validated, saved, and run by Runrail. The app enforces a combined 256 KB source limit. Keep operations that change project or account state behind explicit user clicks so loading the page never triggers them automatically.",
    `Selected project context: ${projectName}.`,
    `User request:\n${description}`,
    `Current screen source (preserve useful behavior while refining):\n${JSON.stringify(current)}`,
    `Runrail API catalog:\n${JSON.stringify(CUSTOM_SCREEN_API_CATALOG)}`,
    `Example: const projects = await runrail.projects.list(); await runrail.app.open("workflows"); await runrail.panels.open(threadId, "files");`,
  ]
  const text = prompt.join("\n\n")
  if (new TextEncoder().encode(text).byteLength > MAX_AI_REQUEST_BYTES) throw new Error("This screen is too large to include in an AI request. Reduce its source in Edit code, then try again.")
  return text
}
