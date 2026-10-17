import { HostError } from "./types"

/** The preview's built-in connectors: GitHub on through `gh`, Slack keyed, Linear and Jira not yet. */

type Kind = "github" | "linear" | "slack" | "jira"

interface Setting {
  on: boolean
  site?: string
  email?: string
}

const NAMES: Readonly<Record<Kind, string>> = { github: "GitHub", linear: "Linear", slack: "Slack", jira: "Jira" }
const KINDS: readonly Kind[] = ["github", "linear", "slack", "jira"]

export class FakeConnectors {
  private readonly settings = new Map<Kind, Setting>([
    ["github", { on: true }],
    ["slack", { on: true }],
  ])
  private readonly keys = new Set<Kind>(["slack"])

  rpc(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "connector.setup.list":
        return {
          connectors: KINDS.map((kind) => ({
            id: kind,
            name: NAMES[kind],
            on: this.settings.get(kind)?.on === true,
            connected: kind === "github" || this.keys.has(kind),
            signIn: kind === "github" ? "gh" : "key",
            ...this.extra(kind),
          })),
        }
      case "connector.setup.save": {
        const kind = this.kind(params.id)
        if (kind === "jira" && params.on === true && (typeof params.site !== "string" || typeof params.email !== "string")) throw new HostError("CONTROL_INVALID_INPUT", "Jira needs its site and the account's email", 400)
        const setting: Setting = { on: params.on === true, ...(typeof params.site === "string" ? { site: params.site } : {}), ...(typeof params.email === "string" ? { email: params.email } : {}) }
        this.settings.set(kind, setting)
        return { id: kind, ...setting }
      }
      case "connector.setup.remove": {
        const kind = this.kind(params.id)
        this.settings.delete(kind)
        this.keys.delete(kind)
        return { id: kind, removed: true }
      }
      default:
        throw new HostError("CONTROL_METHOD_NOT_FOUND", `unknown method ${method}`, 404)
    }
  }

  setSecret(id: string): unknown {
    const kind = this.kind(id)
    if (kind === "github") throw new HostError("CONTROL_INVALID_INPUT", "connector does not take a pasted key", 400)
    this.keys.add(kind)
    return { connector: kind, connected: true }
  }

  private extra(kind: Kind): Record<string, string> {
    const setting = this.settings.get(kind)
    return { ...(setting?.site === undefined ? {} : { site: setting.site }), ...(setting?.email === undefined ? {} : { email: setting.email }) }
  }

  private kind(value: unknown): Kind {
    if (typeof value !== "string" || !(KINDS as readonly string[]).includes(value)) throw new HostError("CONTROL_INVALID_INPUT", "connector is unknown", 400)
    return value as Kind
  }
}
