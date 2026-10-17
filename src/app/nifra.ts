import { z } from "zod"
import type { Prefs } from "./persist"

/**
 * Nifra, the framework Runrail's authors make, as the desktop shows it: the engine adds Nifra's
 * tools, instructions, and check only in a Nifra project, the thread header says when it does,
 * and one setting turns it all off (the README's Nifra in Runrail).
 */

/** What Nifra adds to a thread's engine (`nifra.status`); all false outside a Nifra project. */
export const NifraUseSchema = z.object({ mcp: z.boolean(), pi: z.boolean(), check: z.boolean() })
export type NifraUse = z.infer<typeof NifraUseSchema>

export const NIFRA_SETTING_HINT =
  "Nifra is a TypeScript framework made by the authors of Runrail. In a Nifra project, threads on Runrail's own agent get the tools of the nifra MCP server on your PATH (docs, examples, and types without asking; anything else asks first), and Pi threads get Nifra's instructions and tools. Other projects get none of this, and nothing about it is sent anywhere."

export function nifraOn(prefs: Pick<Prefs, "nifra">): boolean {
  return prefs.nifra !== false
}

export function nifraInUse(use: NifraUse | undefined): use is NifraUse {
  return use !== undefined && (use.mcp || use.pi || use.check)
}

/** The thread header's explanation: what Nifra adds here, who makes it, and where to turn it off. */
export function nifraSummary(use: NifraUse): string {
  const parts = [
    ...(use.mcp ? ["Nifra's MCP tools for the agent"] : []),
    ...(use.pi ? ["Nifra's instructions and tools for Pi"] : []),
    ...(use.check ? ["a nifra check after each turn"] : []),
  ]
  const added = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`
  return `A Nifra project: Runrail adds ${added}. Nifra is made by the authors of Runrail; turn this off in Settings, General.`
}
