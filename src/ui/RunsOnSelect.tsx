import type { Catalog } from "../app/catalog"
import { decodeSelection, encodeSelection, selectGroups, type Selection } from "../app/picker"
import { cx } from "./common"

/**
 * What a run uses, as one select: every connected model grouped by its connection, then the coding
 * tools on this computer. For forms, where the model menu of the composer would be too much.
 */
export function RunsOnSelect({
  catalog,
  value,
  onChange,
  label,
  unbound,
  className,
  disabled,
}: {
  readonly catalog: Catalog & { readonly loading: boolean }
  readonly value: Selection
  readonly onChange: (selection: Selection) => void
  /** Accessible name, when no visible label wraps the select. */
  readonly label?: string
  /** The option that names no model: what it is called here, and whether it can be chosen. */
  readonly unbound: { readonly label: string; readonly disabled?: boolean }
  readonly className?: string
  readonly disabled?: boolean
}) {
  const known = !catalog.loading && catalog.connectionsError === undefined
  const groups = selectGroups(catalog, value, known)
  return (
    <select
      className={cx("select", className)}
      aria-label={label}
      value={encodeSelection(value)}
      disabled={disabled}
      onChange={(event) => {
        const picked = decodeSelection(event.target.value)
        if (picked !== undefined) onChange(picked)
      }}
    >
      <option value="native" disabled={unbound.disabled === true}>
        {unbound.label}
      </option>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled === true}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
