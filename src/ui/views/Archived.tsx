import { Archive, ArchiveRestore, Search, Trash, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmDeleteForever } from "../../app/archive"
import { archiveThread } from "../../app/engines"
import { archivedAt, archivedList } from "../../app/sidebar"
import { openThread, toast, useApp } from "../../app/store"
import { timeAgo } from "../../lib/format"
import { Button, EmptyState } from "../common"

/** Archived threads by project, newest first, to find, open, restore, or delete forever. */
export function ArchivedView() {
  const { projects, threads } = useApp(useShallow((state) => ({ projects: state.projects, threads: state.threads })))
  const [query, setQuery] = useState("")
  const list = useMemo(() => archivedList({ projects, threads, query }), [projects, threads, query])
  const typed = query.trim()
  const now = Date.now()

  const restore = (threadId: string, title: string): void => {
    void archiveThread(threadId, false)
    toast("success", `Restored ${title}`, { label: "Open", run: () => openThread(threadId) })
  }

  return (
    <main className="view" aria-label="Archived threads">
      <header className="view-header" data-tauri-drag-region>
        <div className="pane-toolbar-spacer" data-tauri-drag-region />
      </header>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Archived threads</h1>
          <p className="page-lead">Archived threads keep their history and stop their engines. Restore one to put it back in the sidebar.</p>
        </div>
      </div>
      {list.total > 0 && (
        <div className="view-toolbar">
          <div className="search-field">
            <Search size={13} />
            <input value={query} placeholder="Search archived threads" aria-label="Search archived threads" maxLength={200} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
            {query.length > 0 && (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="view-body">
        {list.total === 0 ? (
          <EmptyState icon={<Archive size={20} />} title="No archived threads">
            Archive a thread from its menu in the sidebar. It leaves the list and keeps its history here.
          </EmptyState>
        ) : list.groups.length === 0 ? (
          <p className="archived-none">No archived thread matches “{typed}”.</p>
        ) : (
          <div>
            {list.groups.map((group) => (
              <section key={group.project.id} className="archived-group" aria-label={group.project.name}>
                <h2 className="archived-group-head">
                  {group.project.name}
                  <span className="archived-count">{group.threads.length}</span>
                </h2>
                <ul className="archived-rows">
                  {group.threads.map((thread) => (
                    <li key={thread.id} className="archived-row">
                      <button type="button" className="archived-main" onClick={() => openThread(thread.id)} aria-label={`Open ${thread.title}`}>
                        <span className="archived-title">{thread.title}</span>
                        <span className="archived-meta">
                          Archived {timeAgo(archivedAt(thread), now)}
                          {thread.worktree !== undefined && " · worktree"}
                        </span>
                      </button>
                      <span className="archived-actions">
                        <Button size="sm" variant="ghost" onClick={() => openThread(thread.id)}>
                          Open
                        </Button>
                        <Button size="sm" icon={<ArchiveRestore size={13} />} onClick={() => restore(thread.id, thread.title)}>
                          Restore
                        </Button>
                        <Button size="sm" variant="ghost" className="archived-delete" icon={<Trash size={13} />} aria-label={`Delete ${thread.title} forever`} onClick={() => confirmDeleteForever(thread.id)}>
                          Delete forever
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
