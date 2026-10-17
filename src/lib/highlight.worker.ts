import { renderHtml, renderTokens } from "./highlightEngine"

/** Highlighting off the window's thread: Shiki's regexes are slow enough in WebKit to drop frames. */

interface Request {
  readonly id: number
  readonly kind: "html" | "tokens"
  readonly code: string
  readonly lang: string
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, kind, code, lang } = event.data
  const work = kind === "html" ? renderHtml(code, lang) : renderTokens(code, lang)
  work.then(
    (result) => self.postMessage({ id, result }),
    () => self.postMessage({ id }),
  )
}
