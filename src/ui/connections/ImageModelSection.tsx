import { useState } from "react"
import type { CatalogImageModel } from "../../app/catalog"
import type { Connection } from "../../app/connections"
import { setImageModel, type ImageChoice } from "../../app/connectionSettings"
import { toast } from "../../app/store"
import { toHostError } from "../../host"
import { saveProblemText } from "./text"

/**
 * Settings -> AI providers -> Image model. Runrail picks no provider: the list is
 * the image models the person's own connections offer, and agents make pictures with the one
 * picked here, billed to that connection.
 */

const SEPARATOR = "\u0000"

export function ImageModelSection({ connections, models, choice, onChanged }: { readonly connections: readonly Connection[]; readonly models: readonly CatalogImageModel[]; readonly choice?: ImageChoice; readonly onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const groups = connections.map((connection) => ({ connection, models: models.filter((model) => model.connectionId === connection.id) })).filter((group) => group.models.length > 0)
  const value = choice === undefined ? "" : `${choice.connectionId}${SEPARATOR}${choice.model}`
  // A pick whose connection is off, or whose list did not load this time, still shows as picked.
  const listed = choice === undefined || models.some((model) => model.connectionId === choice.connectionId && model.id === choice.model)
  const owner = choice === undefined ? undefined : connections.find((connection) => connection.id === choice.connectionId)

  const pick = (next: string): void => {
    const [connectionId, model] = next.split(SEPARATOR)
    setBusy(true)
    void setImageModel(connectionId === undefined || model === undefined || next.length === 0 ? undefined : { connectionId, model })
      .then(onChanged, (caught: unknown) => toast("error", saveProblemText(toHostError(caught).code)))
      .finally(() => setBusy(false))
  }

  const hint =
    choice !== undefined && !choice.usable
      ? `${owner?.label ?? "Its provider"} is off, so agents cannot make pictures. Turn it on, or pick another model.`
      : groups.length === 0 && choice === undefined
        ? "None of your providers lists an image model. Add a provider whose models include image generators, and they show here."
        : "Agents make or change a picture with this model when you ask for one, and save it in the project. Each picture is billed to that provider."

  return (
    <div className="setting-row conn-images" data-setting="image-model">
      <div className="setting-text">
        <div className="setting-label">Image model</div>
        <div className="setting-hint">{hint}</div>
      </div>
      <div className="setting-control">
        <select className="select" aria-label="Image model" value={value} disabled={busy || (groups.length === 0 && choice === undefined)} onChange={(event) => pick(event.target.value)}>
          <option value="">None</option>
          {!listed && choice !== undefined && <option value={value}>{`${choice.model} · ${owner?.label ?? choice.connectionId}`}</option>}
          {groups.map((group) => (
            <optgroup key={group.connection.id} label={group.connection.label}>
              {group.models.map((model) => (
                <option key={model.id} value={`${group.connection.id}${SEPARATOR}${model.id}`}>
                  {model.name ?? model.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </div>
  )
}
