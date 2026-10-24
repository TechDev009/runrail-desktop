import { Bug, Check, Copy, ExternalLink, ShieldAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { closeDialog } from "../../app/actions"
import { collectReport, issueLink, openIssue, reportText, type ProblemReport } from "../../app/report"
import { toast } from "../../app/store"
import { Button, Modal, Spinner } from "../common"

/** The whole report, shown before anything leaves; Copy and Open issue are the only ways it does. */
export function ReportDialog() {
  const [report, setReport] = useState<ProblemReport | undefined>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    void collectReport().then((built) => live && setReport(built))
    return () => {
      live = false
    }
  }, [])

  const text = useMemo(() => (report === undefined ? undefined : reportText(report)), [report])
  const omitted = useMemo(() => (report === undefined ? 0 : issueLink(report).omitted), [report])
  const copy = (): void => {
    if (text === undefined) return
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1_400)
      },
      () => toast("error", "Could not copy the report."),
    )
  }

  return (
    <Modal
      title={
        <>
          <Bug size={15} /> Report a problem
        </>
      }
      onClose={closeDialog}
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Close
          </Button>
          <Button icon={copied ? <Check size={14} /> : <Copy size={14} />} disabled={text === undefined} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="primary" icon={<ExternalLink size={14} />} disabled={report === undefined} onClick={() => report !== undefined && void openIssue(report)}>
            Open issue
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="share-privacy">
          <ShieldAlert size={14} />
          <span>
            This is the whole report: versions, your system, the engine's checks, and counts of error codes. It has no prompts, code, tool output, file paths, project names, connections, accounts, or keys. Nothing is sent from here: Open issue fills in a new GitHub issue in your browser, and you can edit it before you post it.
          </span>
        </div>
        {text === undefined ? (
          <p className="report-loading" role="status">
            <Spinner size={13} /> Running the engine's checks…
          </p>
        ) : (
          <pre className="report-text" aria-label="Report" tabIndex={0}>
            {text}
          </pre>
        )}
        {omitted > 0 && <p className="form-hint">The issue link leaves out the {omitted} least frequent counters to stay short. Copy has them all.</p>}
      </div>
    </Modal>
  )
}
