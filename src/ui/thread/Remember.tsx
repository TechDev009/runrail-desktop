import { Brain, Check, X } from "lucide-react"
import { useState } from "react"
import { dismissSuggestions, keepSuggestion, setSuggestion, suggestMemories, useMemory, type ScopeName } from "../../app/memory"
import { set } from "../../app/store"
import { toHostError } from "../../host"
import { Button, cx, IconButton, Spinner } from "../common"

/**
 * "Remember this?" at the end of a thread at rest: asked first, then one call to the default model, then each
 * suggested fact kept or skipped by the person. Nothing is kept on its own.
 */
export function RememberCard({ threadId }: { readonly threadId: string }) {
  const suggestions = useMemory((state) => state.suggestions[threadId])
  const [error, setError] = useState<string>()
  if (suggestions === "dismissed") return null
  return (
    <section className="remember-card" aria-label="Remember from this thread">
      <header className="remember-head">
        <Brain size={13} aria-hidden="true" />
        <span>{suggestions === undefined ? "Remember anything from this thread?" : "Remember from this thread"}</span>
        <span className="remember-spacer" />
        <IconButton size="sm" label="Not now" onClick={() => dismissSuggestions(threadId)}>
          <X size={13} />
        </IconButton>
      </header>
      {suggestions === undefined && (
        <div className="remember-row">
          <span className="muted">The default model reads this thread once and suggests facts to keep. You choose each one.</span>
          <Button size="sm" variant="secondary" onClick={() => suggestMemories(threadId)}>
            Suggest
          </Button>
        </div>
      )}
      {suggestions?.state === "running" && (
        <p className="remember-row muted" role="status">
          <Spinner size={12} /> Reading the thread…
        </p>
      )}
      {suggestions?.state === "error" && <p className="remember-row form-warning">{suggestions.message}</p>}
      {suggestions?.state === "ready" && suggestions.items.length === 0 && <p className="remember-row muted">Nothing here worth keeping.</p>}
      {suggestions?.state === "ready" && suggestions.items.length > 0 && (
        <ul className="remember-list">
          {suggestions.items.map((item, index) => (
            <li key={`${String(index)}-${item.text.slice(0, 20)}`} className={cx("remember-item", `is-${item.state}`)}>
              <span className="remember-text">{item.text}</span>
              {item.state === "new" ? (
                <span className="remember-actions">
                  <select className="select remember-scope" aria-label="Keep for" value={item.scope} onChange={(event) => setSuggestion(threadId, index, { scope: event.target.value as ScopeName })}>
                    <option value="project">This project</option>
                    <option value="person">All my projects</option>
                  </select>
                  <Button size="sm" variant="secondary" icon={<Check size={12} />} onClick={() => void keepSuggestion(threadId, index).catch((cause: unknown) => setError(toHostError(cause).message))}>
                    Keep
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSuggestion(threadId, index, { state: "skipped" })}>
                    Skip
                  </Button>
                </span>
              ) : (
                <span className="remember-done muted">{item.state === "kept" ? "Kept" : "Skipped"}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {suggestions?.state === "ready" && suggestions.items.some((item) => item.state === "kept") && (
        <button type="button" className="link-button remember-row" onClick={() => set({ view: { kind: "memory" } })}>
          Open Memory
        </button>
      )}
      {error !== undefined && <p className="remember-row form-warning">{error}</p>}
    </section>
  )
}
