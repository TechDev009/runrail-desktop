import type { ConnectionModel } from "../protocol/schemas"
import type { Connection } from "./connections"
import { BACKEND_LABELS } from "./persist"

/** Names for models and connections. Plain functions, so lists and tests can use them without the catalog. */

/** A model, bound to the connection it is reached through. */
export interface CatalogModel extends ConnectionModel {
  readonly connectionId: string
}

/** Human model name: "claude-sonnet-5-5" -> "Sonnet 5.5", "gpt-5.5-mini" -> "GPT-5.5 mini". */
export function modelLabel(id: string | undefined): string {
  if (id === undefined || id.length === 0) return "Default model"
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(id)
  if (claude !== null) return `${claude[1]?.[0]?.toUpperCase() ?? ""}${claude[1]?.slice(1) ?? ""} ${claude[2] ?? ""}.${claude[3] ?? ""}`
  const gpt = /^gpt-([\d.]+)(?:-(\w+))?$/.exec(id)
  if (gpt !== null) return `GPT-${gpt[1] ?? ""}${gpt[2] === undefined ? "" : ` ${gpt[2]}`}`
  return id
}

/** Display name: the vendor's own when its list sent one. */
export function modelName(model: CatalogModel): string {
  return model.name ?? modelLabel(model.id)
}

export interface RunDisplay {
  readonly backend?: string
  readonly model?: string
  readonly connectionId?: string
}

/** A compact route label used on completed turn rows and model switch notices. */
export function runLabel(run: RunDisplay): string {
  const backend = run.backend === undefined ? undefined : BACKEND_LABELS[run.backend as keyof typeof BACKEND_LABELS] ?? run.backend
  const model = run.model === undefined ? undefined : modelLabel(run.model)
  if (backend === undefined) return model ?? "Default model"
  if (model === undefined) return `${backend} default model`
  return `${model} via ${backend}`
}

/** Key for a model in a list: several connections can offer the same model id. */
export function modelKey(model: { readonly id: string; readonly connectionId?: string | undefined }): string {
  return `${model.connectionId ?? ""} ${model.id}`
}

export function connectionLabel(id: string | undefined, connections: readonly Connection[]): string {
  if (id === undefined) return "Other"
  return connections.find((connection) => connection.id === id)?.label ?? id
}
