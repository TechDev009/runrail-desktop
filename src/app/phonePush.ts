import { getHost } from "../host"
import { parseOr } from "../protocol/schemas"
import { z } from "zod"
import { systemCapability, systemRpc } from "./connections"

/**
 * Notifications on paired phones, sent through the system engine's Web Push, which
 * encrypts each one for its phone. A phone whose subscription is gone is forgotten; one whose push
 * service cannot be reached misses that notification.
 */

export interface PhoneMessage {
  readonly title: string
  readonly body: string
  /** Where a tap goes on the phone page, such as `/#t=<thread>`. */
  readonly url: string
  /** A newer notification for the same thread replaces the older one. */
  readonly tag: string
  readonly urgency: "normal" | "high"
}

const SentSchema = z.looseObject({ delivered: z.boolean(), gone: z.literal(true).optional() })

export async function pushToPhones(message: PhoneMessage): Promise<void> {
  const host = getHost()
  const targets = await host.phonePushTargets().catch(() => [])
  if (targets.length === 0 || !(await systemCapability("push").catch(() => false))) return
  for (const target of targets) {
    const sent = parseOr(SentSchema, await systemRpc("push.send", { subscription: target.subscription, contact: target.origin, message }).catch(() => undefined))
    if (sent?.gone === true) await host.phoneSetPush(target.device, null).catch(() => undefined)
  }
}
