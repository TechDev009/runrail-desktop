import { ExternalLink } from "lucide-react"
import { openUrl } from "../../app/actions"
import type { AttentionViewItem } from "../../app/attentionView"

const LABELS: Readonly<Record<AttentionViewItem["kind"], string>> = {
  approval: "Thread approval",
  "ci-watch": "CI watch paused",
  review: "Changes requested",
  workflow: "Workflow waiting",
}

export function AttentionBoard({ items, onOpen }: { readonly items: readonly AttentionViewItem[]; readonly onOpen: (item: AttentionViewItem) => void }) {
  return (
    <section className="office-attention" aria-label="Needs attention">
      <header className="office-attention-header">
        <div>
          <h2>Needs attention</h2>
          <p>Work waiting on your next action</p>
        </div>
        <span className="office-attention-count">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <div className="office-attention-empty">
          <h3>Nothing needs your attention</h3>
          <p>Pending approvals, paused CI watches, requested changes, and workflow waits will appear here.</p>
        </div>
      ) : (
        <ul className="office-attention-list">
          {items.map((item) => {
            const url = item.prUrl
            return (
              <li key={item.key} className="office-attention-item">
                <button type="button" className="office-attention-open" onClick={() => onOpen(item)}>
                  <span className={`office-attention-kind is-${item.kind}`}>{LABELS[item.kind]}</span>
                  <span className="office-attention-title">{item.title}</span>
                  <span className="office-attention-next">{item.nextAction}</span>
                </button>
                {url !== undefined && (
                  <button type="button" className="office-attention-pr" onClick={() => void openUrl(url)} aria-label="Open pull request">
                    <ExternalLink size={13} />
                    PR
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
