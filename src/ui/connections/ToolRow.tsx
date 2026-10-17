import { Ellipsis, KeyRound, ListChecks, LogIn, LogOut, Pencil, Trash } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { confirmAction, connectModel } from "../../app/actions"
import { removeToolConnection, toolConnectionStatus, toolSignOut, updateConnectionSettings, type ToolConnection, type ToolStatus } from "../../app/connectionSettings"
import { BACKEND_LABELS } from "../../app/persist"
import { toast } from "../../app/store"
import { toHostError } from "../../host"
import { Button, cx, IconButton, Menu, Toggle, type MenuEntry } from "../common"
import { Notice, StatusChip } from "./parts"
import { countText, saveProblemText, toolRoute, toolStatusText } from "./text"

type Busy = "toggle" | "rename" | "remove" | "sign-out"

const SIGNED_OUT_POLL_MS = 5_000

/** One coding-tool connection in the providers list: how it signs in, whether it can run, its models. */
export function ToolRow({ connection, isDefault, nonce }: { readonly connection: ToolConnection; readonly isDefault: boolean; readonly nonce: number }) {
  const [status, setStatus] = useState<ToolStatus | undefined>(undefined)
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [renaming, setRenaming] = useState(false)
  const [asked, setAsked] = useState(0)
  const settled = useRef(false)
  const name = BACKEND_LABELS[connection.tool]
  const shown = toolStatusText(connection, status)

  // A sign-in finished in a terminal or browser elsewhere shows without a refresh: the tool is asked
  // again when the window comes back, and every few seconds while it says it is not signed in.
  useEffect(() => {
    const again = (): void => setAsked((value) => value + 1)
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [])
  useEffect(() => {
    if (status?.signedIn !== false || !connection.enabled) return
    const timer = setInterval(() => setAsked((value) => value + 1), SIGNED_OUT_POLL_MS)
    return () => clearInterval(timer)
  }, [status?.signedIn, connection.enabled])

  // The tool is asked again after any change to the list, so a sign-in finished elsewhere shows.
  useEffect(() => {
    let live = true
    toolConnectionStatus(connection.id).then(
      (value) => {
        if (live) setStatus(value)
      },
      () => {
        if (live) setStatus({})
      },
    )
    return () => {
      live = false
    }
  }, [connection, nonce, asked])

  const act = async (kind: Busy, run: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(kind)
    setError(undefined)
    try {
      await run()
      if (done !== undefined) toast("success", done)
    } catch (caught) {
      setError(saveProblemText(toHostError(caught).code))
    }
    setBusy(undefined)
  }

  const rename = (value: string): void => {
    if (settled.current) return
    settled.current = true
    setRenaming(false)
    const next = value.trim()
    if (next === connection.label || next.length === 0) return
    void act("rename", () => updateConnectionSettings(connection.id, { label: next }))
  }

  const remove = (): void =>
    confirmAction({
      title: `Remove ${connection.label}?`,
      body: `${connection.authMode === "api-key" ? "Its stored key is deleted. " : ""}${name}'s own sign-in is not touched${connection.separateAccount ? "; its folder stays, so adding it again finds the account still signed in" : ""}. Threads that ran as it keep their history and need another model to continue.`,
      confirm: "Remove",
      danger: true,
      onConfirm: () => void act("remove", () => removeToolConnection(connection.id), `${connection.label} was removed.`),
    })

  const signOut = (): void =>
    confirmAction({
      title: `Sign ${connection.label} out?`,
      body: `Runs ${name}'s own sign-out for this connection's folder. Your usual ${name} login is not touched. Sign in again from this list.`,
      confirm: "Sign out",
      onConfirm: () => void act("sign-out", () => toolSignOut(connection.id), `${connection.label} is signed out.`),
    })

  const repair = (): void => connectModel({ connectionId: connection.id })
  const separate = connection.authMode === "subscription" && connection.separateAccount
  const items: MenuEntry[] = [
    { id: "models", label: "Choose models", icon: <ListChecks size={14} />, onSelect: () => connectModel({ models: connection.id }) },
    {
      id: "rename",
      label: "Rename",
      icon: <Pencil size={14} />,
      onSelect: () => {
        settled.current = false
        setRenaming(true)
      },
    },
    ...(connection.authMode === "api-key" ? [{ id: "key", label: status?.keyStored === true ? "Replace key" : "Add key", icon: <KeyRound size={14} />, onSelect: repair }] : []),
    ...(separate ? [{ id: "sign-in", label: status?.signedIn === true ? "Sign in again" : "Sign in", icon: <LogIn size={14} />, onSelect: repair }] : []),
    ...(separate && status?.signedIn === true ? [{ id: "sign-out", label: "Sign out", icon: <LogOut size={14} />, onSelect: signOut }] : []),
    { separator: true, id: "separator" },
    { id: "remove", label: "Remove", icon: <Trash size={14} />, danger: true, onSelect: remove },
  ]

  return (
    <li className={cx("conn-row", busy === "remove" && "is-leaving", !connection.enabled && "is-off")} aria-busy={busy !== undefined}>
      <StatusChip tone={busy === "remove" || busy === "sign-out" ? "busy" : shown.tone} label={busy === "remove" ? "Removing" : busy === "sign-out" ? "Signing out" : shown.label} />
      <div className="conn-row-main">
        {renaming ? (
          <input
            className="input conn-rename"
            defaultValue={connection.label}
            maxLength={160}
            autoFocus
            aria-label={`New name for ${connection.label}`}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => rename(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                rename(event.currentTarget.value)
              } else if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                settled.current = true
                setRenaming(false)
              }
            }}
          />
        ) : (
          <div className="conn-row-title">
            <span className="conn-row-name">{connection.label}</span>
            {isDefault && <span className="conn-badge">Default</span>}
          </div>
        )}
        <div className="conn-row-meta">
          {toolRoute(connection)} · {connection.models === undefined ? `Every ${name} model` : countText(connection.models.length, "model")}
        </div>
        {error !== undefined ? (
          <Notice tone="fail" role="alert">
            {error}
          </Notice>
        ) : (
          shown.hint !== undefined && <div className={cx("conn-row-hint", `is-${shown.tone}`)}>{shown.hint}</div>
        )}
      </div>
      <div className="conn-row-actions">
        {shown.fix !== undefined && (
          <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={repair}>
            {shown.fix}
          </Button>
        )}
        <Toggle checked={connection.enabled} label={connection.enabled ? `Turn ${connection.label} off` : `Turn ${connection.label} on`} disabled={busy !== undefined} onChange={(enabled) => void act("toggle", () => updateConnectionSettings(connection.id, { enabled }))} />
        <Menu
          align="end"
          items={items}
          trigger={({ open, toggle, ref }) => (
            <IconButton ref={ref} className="conn-row-more" label={`More for ${connection.label}`} size="sm" active={open} disabled={busy !== undefined} onClick={toggle}>
              <Ellipsis size={15} />
            </IconButton>
          )}
        />
      </div>
    </li>
  )
}
