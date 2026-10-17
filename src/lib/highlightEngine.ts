import type { HighlighterCore, ThemedToken } from "shiki/core"
import { LANGS, THEME } from "./highlightLangs"

/**
 * Shiki with its JavaScript regex engine (no WebAssembly, no eval). It runs in the highlighting
 * worker; the window loads it only if that worker cannot start. Colors are CSS variables
 * (`--syn-*` in styles/tokens.css), so code follows the theme without highlighting again.
 */

let highlighter: Promise<HighlighterCore> | undefined
const loaded = new Map<string, Promise<boolean>>()

function core(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createCssVariablesTheme, createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")])
    const theme = createCssVariablesTheme({ name: THEME, variablePrefix: "--syn-", fontStyle: true })
    return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
  })()
  return highlighter
}

async function ensure(lang: string): Promise<HighlighterCore | undefined> {
  const loader = LANGS[lang]
  if (loader === undefined) return undefined
  const instance = await core()
  let ready = loaded.get(lang)
  if (ready === undefined) {
    ready = loader()
      .then(async (module) => {
        await instance.loadLanguage(module.default as Parameters<HighlighterCore["loadLanguage"]>[0])
        return true
      })
      .catch(() => false)
    loaded.set(lang, ready)
  }
  return (await ready) ? instance : undefined
}

/** `lang` is already resolved by `langFor`. */
export async function renderHtml(code: string, lang: string): Promise<string | undefined> {
  const instance = await ensure(lang)
  return instance?.codeToHtml(code, { lang, theme: THEME })
}

export async function renderTokens(code: string, lang: string): Promise<ThemedToken[][] | undefined> {
  const instance = await ensure(lang)
  return instance?.codeToTokens(code, { lang, theme: THEME }).tokens
}
