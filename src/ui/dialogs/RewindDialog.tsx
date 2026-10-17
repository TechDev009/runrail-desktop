import { TriangleAlert } from "lucide-react"
import { useState } from "react"
import { closeDialog } from "../../app/actions"
import { changeLabel, runRewind, type RewindPlan } from "../../app/rewind"
import { firstLine } from "../../lib/format"
import { Button, cx, Modal } from "../common"

/**
 * Going back to before a message: every file that changed since is listed and
 * ticked, the person unticks what should stay, and a copy of the thread as it is goes to Archived.
 */
export function RewindDialog({ plan }: { readonly plan: RewindPlan }) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(plan.files.map((file) => file.path)))
  const [busy, setBusy] = useState(false)
  const toggle = (path: string): void => {
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      await runRewind(plan, plan.files.filter((file) => ticked.has(file.path)).map((file) => file.path))
    } finally {
      closeDialog()
    }
  }
  const all = ticked.size === plan.files.length
  return (
    <Modal
      title={plan.edit ? "Edit this message" : "Go back to before this message"}
      onClose={closeDialog}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog} data-autofocus="">
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void go()}>
            {plan.edit ? "Go back and edit" : "Go back"}
          </Button>
        </>
      }
    >
      <p className="dialog-lede">
        The thread goes back to before "{firstLine(plan.text, 80)}", and everything after it is removed. A copy of the thread as it is now is kept in Archived.
        {plan.edit ? " The message goes back in the box for you to change." : ""}
      </p>
      {plan.skipped !== undefined ? (
        <p className="dialog-note">Files stay as they are: {plan.skipped === "too-large" ? "the folder was too large to save before that message." : "they could not be saved before that message."}</p>
      ) : plan.files.length === 0 ? (
        <p className="dialog-note">No files changed since then.</p>
      ) : (
        <div className="rewind-files">
          <label className="rewind-all">
            <input type="checkbox" checked={all} onChange={() => setTicked(all ? new Set() : new Set(plan.files.map((file) => file.path)))} />
            Put {plan.files.length === 1 ? "this file" : `these ${String(plan.files.length)} files`} back as they were
          </label>
          <ul>
            {plan.files.map((file) => (
              <li key={file.path} className={cx("rewind-file", !ticked.has(file.path) && "is-kept")}>
                <input type="checkbox" checked={ticked.has(file.path)} onChange={() => toggle(file.path)} aria-label={`Put back ${file.path}`} />
                <span className="rewind-path mono" title={file.path}>
                  {file.path}
                </span>
                <span className={cx("rewind-change", `is-${file.change}`)}>{changeLabel(file.change)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.sharers.length > 0 && plan.files.length > 0 && (
        <p className="dialog-note is-warning" role="note">
          <TriangleAlert size={12} aria-hidden="true" /> {plan.sharers.length === 1 ? `"${plan.sharers[0]}" also worked` : `${String(plan.sharers.length)} other threads also worked`} in this folder since then. Putting files back can undo {plan.sharers.length === 1 ? "its" : "their"} changes too.
        </p>
      )}
    </Modal>
  )
}
