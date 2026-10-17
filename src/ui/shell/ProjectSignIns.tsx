import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"
import { forgetSignIns, setBrowserSignIns, signInsSupport } from "../../app/signIns"
import { toast } from "../../app/store"
import type { Project } from "../../app/persist"
import { getHost, toHostError } from "../../host"
import { Toggle } from "../common"

/** Whether a project's browser previews keep their sign-ins, in Settings → Projects. */
export function ProjectSignIns({ project }: { readonly project: Project }) {
  const on = project.browserSignIns === true
  const [saved, setSaved] = useState(false)
  const [unavailable, setUnavailable] = useState<string>()
  useEffect(() => {
    let live = true
    void signInsSupport().then((support) => live && setUnavailable(support.available ? undefined : (support.reason ?? "Saved sign-ins are not available here.")))
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!on) return setSaved(false)
    let live = true
    void getHost()
      .signInsSaved(project.id)
      .then((value) => live && setSaved(value))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [on, project.id])
  const fail = (error: unknown): void => toast("error", `Could not change the saved sign-ins: ${toHostError(error).message}`)
  return (
    <>
      <span className="project-sign-ins">
        <KeyRound size={12} aria-hidden="true" />
        <span>Keep browser sign-ins</span>
        <Toggle label={`Keep browser sign-ins for ${project.name}`} checked={on && unavailable === undefined} disabled={unavailable !== undefined} onChange={(value) => void setBrowserSignIns(project.id, value).catch(fail)} />
        {on && saved && (
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void forgetSignIns(project.id)
                .then(() => {
                  setSaved(false)
                  toast("success", `Forgot ${project.name}'s browser sign-ins. Pages open now keep theirs until they close.`)
                })
                .catch(fail)
            }
          >
            Forget saved sign-ins
          </button>
        )}
      </span>
      {unavailable !== undefined && <span className="project-sign-ins-off">{unavailable}</span>}
    </>
  )
}
