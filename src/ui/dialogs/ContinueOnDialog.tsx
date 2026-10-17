import { TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { closeDialog } from "../../app/actions"
import { continueOn, findMoveTargets, movePlan, whereOf, type MovePlan } from "../../app/moveThread"
import type { Project } from "../../app/persist"
import { useWords } from "../../app/platformWords"
import { projectById } from "../../app/store"
import { toHostError } from "../../host"
import { tildify } from "../../lib/format"
import { useThread } from "../hooks"
import { Button, cx, Modal, Spinner } from "../common"

/**
 * Continue a thread on another machine: the projects elsewhere with the same
 * repository are offered, and the new thread starts from what the branch's upstream has.
 */
export function ContinueOnDialog({ threadId }: { readonly threadId: string }) {
  const words = useWords()
  const thread = useThread(threadId)
  const source = projectById(thread?.projectId)
  const [targets, setTargets] = useState<readonly Project[]>()
  const [plan, setPlan] = useState<MovePlan>()
  const [chosen, setChosen] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let live = true
    void Promise.all([findMoveTargets(threadId), movePlan(threadId)]).then(([found, read]) => {
      if (!live) return
      setTargets(found)
      setPlan(read)
      setChosen(found[0]?.id)
    })
    return () => {
      live = false
    }
  }, [threadId])
  const go = async (): Promise<void> => {
    if (chosen === undefined || plan?.ok !== true) return
    setBusy(true)
    setError(undefined)
    try {
      await continueOn(threadId, chosen, plan)
      closeDialog()
    } catch (failure) {
      setError(toHostError(failure).message)
      setBusy(false)
    }
  }
  const loading = targets === undefined || plan === undefined
  return (
    <Modal
      title="Continue on another machine"
      onClose={closeDialog}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog} data-autofocus="">
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={busy || loading || plan.ok !== true || chosen === undefined} onClick={() => void go()}>
            Continue there
          </Button>
        </>
      }
    >
      <p className="dialog-lede">
        A new thread starts in a worktree of this repository on another machine, from this thread's branch as it was pushed{source === undefined ? "" : ` from ${whereOf(source)}`}. The conversation goes in its message box for you to send, and this thread stays as it is.
      </p>
      {loading ? (
        <p className="dialog-note">
          <Spinner size={12} /> Looking for the repository on your other machines…
        </p>
      ) : (
        <>
          {plan.ok ? (
            <p className="dialog-note">
              Starts from <span className="mono">{`${plan.remote}/${plan.branch}`}</span>.
            </p>
          ) : (
            <p className="dialog-note is-warning" role="note">
              <TriangleAlert size={12} aria-hidden="true" /> {plan.reason}
            </p>
          )}
          {targets.length === 0 ? (
            <p className="dialog-note">No project on another machine has this repository. Add its folder there as a project first, from a remote machine in Create project or from this {words.computer}.</p>
          ) : (
            <div className="choice-list" role="radiogroup" aria-label="Where to continue">
              {targets.map((target) => {
                const active = target.id === chosen
                return (
                  <button key={target.id} type="button" role="radio" aria-checked={active} className={cx("choice", active && "is-active")} onClick={() => setChosen(target.id)}>
                    <span className="choice-radio" aria-hidden />
                    <span className="choice-text">
                      <span className="choice-label">
                        {target.name} on {whereOf(target)}
                      </span>
                      <span className="choice-hint mono">{target.remote === undefined ? tildify(target.path) : target.path}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {error !== undefined && <div className="form-error">{error}</div>}
        </>
      )}
    </Modal>
  )
}
