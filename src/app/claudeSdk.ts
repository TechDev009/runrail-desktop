import { create } from "zustand"
import { z } from "zod"
import { HostError, toHostError } from "../host"
import { systemCapability, systemRpc } from "./connections"
import type { ThreadMeta } from "./persist"
import { get } from "./store"

/**
 * The Claude Agent SDK, which lets Claude Code ask before it uses a tool. Its licence reserves all
 * rights, so the app never ships it: the system engine downloads it from npm, pinned and checked,
 * only after the person says yes (`claude.sdk.install`). Without it Claude Code runs in print mode
 * and refuses whatever it would have asked about.
 */

/** A held message's code, and its line; the card under it asks. */
export const CLAUDE_SDK_CODE = "CLAUDE_SDK_MISSING"
export const HELD_FOR_SDK = "Waiting for your answer about the Claude Agent SDK"
/** The card's notice code. */
export const CLAUDE_SDK_NOTICE = "claude.sdk"
/** For an engine that has not answered yet; its own answer names the same pages. */
export const CLAUDE_SDK_NPM_URL = "https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk"
export const CLAUDE_SDK_TERMS_URL = "https://code.claude.com/docs/en/legal-and-compliance"

const StatusSchema = z.object({
  ready: z.boolean(),
  source: z.string().max(32),
  version: z.string().max(64),
  npmUrl: z.string().regex(/^https:\/\//).max(512),
  termsUrl: z.string().regex(/^https:\/\//).max(512),
  installCommand: z.string().max(1024),
})

export type ClaudeSdkStatus = z.infer<typeof StatusSchema>

export const useClaudeSdk = create<{ readonly status?: ClaudeSdkStatus; readonly installing: boolean; readonly error?: string }>(() => ({ installing: false }))

/** The system engine's answer, asked again until it says ready; none from an engine that cannot say. */
export async function readClaudeSdk(): Promise<ClaudeSdkStatus | undefined> {
  const known = useClaudeSdk.getState().status
  if (known?.ready === true) return known
  try {
    if (!(await systemCapability("claude.sdk"))) return undefined
    const status = StatusSchema.parse(await systemRpc("claude.sdk.status"))
    useClaudeSdk.setState({ status })
    return status
  } catch {
    return undefined
  }
}

/** Whether a send could wait on the SDK at all, answered without asking the engine so other sends go at once. */
export function mayAskForSdk(thread: Pick<ThreadMeta, "backend">): boolean {
  return thread.backend === "claude-code" && get().prefs.claudeSdk !== "without" && useClaudeSdk.getState().status?.ready !== true
}

/** Whether a Claude Code message waits for the person's answer: the SDK can be downloaded and has not been, and they have not said to go on without it. */
export async function claudeSdkRefusal(thread: Pick<ThreadMeta, "backend">): Promise<HostError | undefined> {
  if (!mayAskForSdk(thread)) return undefined
  const status = await readClaudeSdk()
  return status !== undefined && !status.ready && status.source === "installable" ? new HostError(CLAUDE_SDK_CODE, HELD_FOR_SDK) : undefined
}

/** Downloads the SDK after the person's yes. A failure stays on the card with its reason. */
export async function installClaudeSdk(): Promise<boolean> {
  if (useClaudeSdk.getState().installing) return false
  useClaudeSdk.setState({ installing: true, error: undefined })
  try {
    const status = StatusSchema.parse(await systemRpc("claude.sdk.install", { confirm: true }))
    useClaudeSdk.setState({ status, installing: false })
    return status.ready
  } catch (error) {
    useClaudeSdk.setState({ installing: false, error: toHostError(error).message })
    return false
  }
}
