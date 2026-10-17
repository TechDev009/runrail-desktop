import { FileDiff, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"
import { readFileChange } from "../../app/fileChanges"
import type { FileChange } from "../../app/filePreview"
import { useApp } from "../../app/store"
import { toHostError } from "../../host"
import { countLines, parseHunks } from "../../lib/diff"
import type { GitDiffFile } from "../../protocol/schemas"
import { Button, EmptyState, IconButton, Segmented, Spinner } from "../common"
import { DIFF_LAYOUTS, DiffLines, layoutFor, PatchView } from "../diff/DiffView"

interface ChangeState {
  readonly loading: boolean
  readonly file?: GitDiffFile
  readonly error?: string
}

export function FileChanges({ threadId, path, change }: { readonly threadId: string; readonly path: string; readonly change?: FileChange }) {
  const [state, setState] = useState<ChangeState>({ loading: change === undefined })
  const [refresh, setRefresh] = useState(0)
  const preferred = useApp((app) => app.prefs.diffView)
  const [mode, setMode] = useState(preferred)
  useEffect(() => {
    if (change !== undefined) return
    let live = true
    setState({ loading: true })
    void readFileChange(threadId, path).then((file) => {
      if (live) setState({ loading: false, ...(file === undefined ? {} : { file }) })
    }).catch((error: unknown) => {
      if (live) setState({ loading: false, error: toHostError(error).message })
    })
    return () => { live = false }
  }, [threadId, path, change, refresh])
  const counts = change === undefined ? state.file : countLines("lines" in change ? change.lines : parseHunks(change.patch).flatMap((hunk) => hunk.lines))
  return <div className="file-changes">
    <div className="pane-toolbar">
      <span className="muted">{change === undefined ? "Working tree changes" : "Tool changes"}</span>
      {counts !== undefined && <span className="review-file-counts"><span className="is-add">+{counts.additions}</span><span className="is-del">-{counts.deletions}</span></span>}
      <div className="pane-toolbar-spacer" />
      <Segmented label="Diff layout" value={mode} onChange={setMode} options={DIFF_LAYOUTS} />
      {change === undefined && <IconButton label="Refresh changes" size="sm" disabled={state.loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={12} /></IconButton>}
    </div>
    <div className="file-preview-body">
      {state.loading ? <div className="pane-loading"><Spinner size={14} /> Loading changes...</div> : state.error !== undefined ? <EmptyState icon={<FileDiff size={20} />} title="Could not load changes" actions={<Button size="sm" onClick={() => setRefresh((value) => value + 1)}>Try again</Button>}>{state.error}</EmptyState> : <FileChangeBody path={path} mode={mode} {...(change === undefined ? {} : { change })} {...(state.file === undefined ? {} : { file: state.file })} />}
    </div>
  </div>
}

export function FileChangeBody({ path, mode, change, file }: { readonly path: string; readonly mode: "unified" | "split"; readonly change?: FileChange; readonly file?: GitDiffFile }) {
  if (change !== undefined) return "lines" in change ? <DiffLines lines={change.lines} path={path} mode={mode} /> : <PatchView patch={change.patch} path={path} mode={mode} />
  if (file === undefined) return <EmptyState icon={<FileDiff size={20} />} title="No current changes">This file has no working tree changes. Switch to File to read its contents.</EmptyState>
  if (file.sensitive === true) return <div className="diff-note">Sensitive file. Its contents are hidden.</div>
  if (file.binary === true) return <div className="diff-note">Binary file changed. A text diff is unavailable.</div>
  return <>
    <PatchView patch={file.patch ?? ""} path={path} mode={layoutFor(file.change, mode)} />
    {file.truncated === true && <div className="diff-note">Only part of this file's changes is shown.</div>}
  </>
}
