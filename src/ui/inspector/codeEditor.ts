import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

/**
 * The Files pane's editor (CodeMirror 6). Loaded only when a file is edited, with
 * its language loaded after it. Colors come from the app's own syntax tokens, so it follows the
 * theme. A file's line endings are kept: one written with CRLF is saved with CRLF.
 */

export interface CodeEditor {
  /** The text as it would be saved. */
  text(): string
  /** Replaces the text, as after reloading the file; the undo history starts over. */
  reset(text: string): void
  focus(): void
  destroy(): void
}

export interface CodeEditorOptions {
  readonly parent: HTMLElement
  readonly text: string
  readonly path: string
  readonly onChange: (text: string) => void
  readonly onSave: () => void
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-token-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-token-string)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName], color: "var(--syn-token-function)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName), t.standard(t.variableName)], color: "var(--syn-token-constant)" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--syn-token-parameter)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-token-comment)", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--syn-token-punctuation)" },
  { tag: [t.link, t.url], color: "var(--syn-token-link)", textDecoration: "underline" },
  { tag: t.heading, color: "var(--syn-token-keyword)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "var(--red)" },
])

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--syn-foreground)", backgroundColor: "transparent", fontSize: "var(--fs-mono)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text)", padding: "var(--sp-8) 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-4)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--accent-soft)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch": { backgroundColor: "var(--amber-soft)", outline: "1px solid var(--amber)" },
  ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { fontSize: "var(--fs-sm)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-2)", border: "none", color: "var(--text-3)" },
  ".cm-tooltip": { backgroundColor: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" },
})

/** The language for a file name; nothing for one the editor does not know. */
async function languageFor(path: string): Promise<Extension> {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : ""
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: ext === "tsx" })
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "jsx" })
    case "json":
    case "jsonc":
      return (await import("@codemirror/lang-json")).json()
    case "md":
    case "mdx":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown()
    case "css":
    case "scss":
      return (await import("@codemirror/lang-css")).css()
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return (await import("@codemirror/lang-html")).html()
    case "py":
      return (await import("@codemirror/lang-python")).python()
    case "rs":
      return (await import("@codemirror/lang-rust")).rust()
    case "yml":
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml()
    default:
      return []
  }
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  const language = new Compartment()
  const state = (text: string): EditorState =>
    EditorState.create({
      doc: text,
      extensions: [
        EditorState.lineSeparator.of(text.includes("\r\n") ? "\r\n" : "\n"),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: false }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        theme,
        language.of([]),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (options.onSave(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.sliceDoc())
        }),
      ],
    })
  const view = new EditorView({ state: state(options.text), parent: options.parent })
  void languageFor(options.path).then((extension) => view.dispatch({ effects: language.reconfigure(extension) }))
  return {
    text: () => view.state.sliceDoc(),
    reset: (text) => {
      view.setState(state(text))
      void languageFor(options.path).then((extension) => view.dispatch({ effects: language.reconfigure(extension) }))
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
