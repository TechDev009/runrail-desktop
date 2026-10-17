import { z } from "zod"
import { getHost } from "../host"

/**
 * New apps from a starter (`runrail new`). The list comes from the engine, which marks Nifra, made
 * by Runrail's authors, as the default and says who makes each one; the dialog shows both.
 */

const StarterSchema = z.object({
  id: z.string().max(32),
  label: z.string().max(80),
  description: z.string().max(400),
  maker: z.string().max(80),
  recommended: z.boolean(),
  creator: z.string().max(80).optional(),
})
const StartersSchema = z.object({ default: z.string().max(32), starters: z.array(StarterSchema).min(1).max(16) })
const CreatedSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), workspace: z.object({ path: z.string(), name: z.string(), git: z.boolean() }), warnings: z.array(z.string().max(500)).max(16) }),
  z.object({ ok: z.literal(false), code: z.string().max(64), message: z.string().max(500), output: z.string().max(16 * 1024).nullish() }),
])

export type AppStarter = z.infer<typeof StarterSchema>
export type AppStarters = z.infer<typeof StartersSchema>
export type AppCreated = z.infer<typeof CreatedSchema>

let starters: Promise<AppStarters> | undefined

export function loadStarters(): Promise<AppStarters> {
  if (starters === undefined) {
    const loading = getHost().appStarters().then((value) => StartersSchema.parse(value))
    loading.catch(() => {
      if (starters === loading) starters = undefined
    })
    starters = loading
  }
  return starters
}

/** Undefined when the person closed the dialog that asks where. */
export async function createApp(name: string, starter: string): Promise<AppCreated | undefined> {
  const value = await getHost().appCreate(name, starter)
  return value === null ? undefined : CreatedSchema.parse(value)
}

/** A project name as a folder name npm accepts, as every creator requires: "My Shop" is "my-shop". */
export function appFolderName(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 214)
  return slug.length === 0 ? undefined : slug
}
