import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import type { Catalog } from "../src/app/catalog"
import type { Connection } from "../src/app/connections"
import { reasoningView, triggerView, type PickerValue } from "../src/app/picker"
import { RunsOnSelect } from "../src/ui/RunsOnSelect"
import { EffortSlider, PickerPanel } from "../src/ui/thread/ModelPicker"

/**
 * The app talks about models, connections, and coding tools. The engine's word for what runs a
 * thread, "harness", is an implementation term and never reaches the screen.
 *
 * Two checks. Every piece of text the source can put on screen is read from the syntax tree, so a
 * string in a branch no test renders is still seen. And the model menu is rendered in each of its
 * states, so text built at run time is seen too. Messages the engine itself writes (an error from
 * a failed start, say) are not covered by either.
 */

const ROOT = join(import.meta.dir, "..")
const SOURCE = join(ROOT, "src")
const WORD = /harness/i
/** Control methods of the engine, sent over RPC and never shown. */
const RPC_METHODS: ReadonlySet<string> = new Set(["harness.list", "harness.status"])

function files(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path, extensions)
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : []
  })
}

/** Every string a file holds that could be shown: literals, template text, and JSX text. */
function texts(path: string): { readonly text: string; readonly line: number }[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { text: string; line: number }[] = []
  const add = (node: ts.Node, text: string): void => {
    found.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
  }
  const visit = (node: ts.Node): void => {
    // Where a module is loaded from is not text.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      return
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text)
    else if (ts.isJsxText(node)) add(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("the word harness", () => {
  test("is in no text the source can show", () => {
    const sources = files(SOURCE, [".ts", ".tsx"])
    // The scan is only worth something if it sees the app.
    expect(sources.length).toBeGreaterThan(40)
    expect(sources.some((path) => path.endsWith("ModelPicker.tsx"))).toBe(true)
    const hits = sources.flatMap((path) =>
      texts(path)
        .filter((entry) => WORD.test(entry.text) && !RPC_METHODS.has(entry.text))
        .map((entry) => `${relative(ROOT, path)}:${String(entry.line)} ${JSON.stringify(entry.text.trim().slice(0, 80))}`),
    )
    expect(hits).toEqual([])
  })

  test("the scan reads literals, templates, and JSX text, and skips imports", () => {
    const sample = join(import.meta.dir, "wording.test.tsx")
    const seen = texts(sample).map((entry) => entry.text)
    expect(seen).toContain("harness.list")
    // Spelled in two parts here, so the only whole copy in this file is the import itself.
    expect(seen).not.toContain(["react-dom", "server"].join("/"))
    expect(seen.some((text) => text.includes("sample JSX text"))).toBe(true)
    expect(seen).toContain("sample template ")
  })

  test("is in no stylesheet, page shell, or window title", () => {
    const others = [...files(join(SOURCE, "styles"), [".css"]), join(ROOT, "index.html"), join(ROOT, "src-tauri", "tauri.conf.json")]
    expect(others.length).toBeGreaterThan(4)
    expect(others.filter((path) => WORD.test(readFileSync(path, "utf8"))).map((path) => relative(ROOT, path))).toEqual([])
  })
})

// Read by the scan's own test above; never rendered.
export function ScanSample({ name }: { readonly name: string }) {
  return <span title={`sample template ${name}`}>sample JSX text</span>
}

// -----------------------------------------------------------------------------------------------
// Rendered text

function conn(id: string, label: string, extra: Partial<Connection> = {}): Connection {
  return { id, label, presetId: id, authMode: "api-key", status: "ready", ...extra }
}

type MenuCatalog = Catalog & { readonly loading: boolean; readonly reload: () => void }

function catalog(extra: Partial<MenuCatalog> = {}): MenuCatalog {
  return { connections: [], models: [], modelErrors: {}, imageModels: [], harnesses: [], skills: [], agents: [], loading: false, reload: () => undefined, ...extra }
}

const FULL = catalog({
  connections: [conn("anthropic", "Anthropic"), conn("openai", "OpenAI"), conn("relay", "Local relay"), conn("groq", "Groq", { status: "error" })],
  models: [
    { connectionId: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", contextTokens: 200_000 },
    { connectionId: "openai", id: "gpt-5.5-mini", name: "GPT-5.5 mini", reasoning: false },
  ],
  modelErrors: { openai: "TIMEOUT" },
  harnesses: [{ id: "native" }, { id: "claude-code" }, { id: "codex" }],
})

function menu(input: { catalog?: MenuCatalog; value?: PickerValue; developer?: boolean; busy?: boolean } = {}): string {
  return renderToStaticMarkup(
    <PickerPanel catalog={input.catalog ?? FULL} value={input.value ?? { backend: "native", model: "claude-opus-5-5", connectionId: "anthropic", thinking: "medium" }} developer={input.developer ?? false} busy={input.busy ?? false} onPick={() => undefined} close={() => undefined} />,
  )
}

/** The effort slider's text for a selection, or nothing when the chip has no effort. */
function levels(value: PickerValue, source: MenuCatalog = FULL): string {
  const chip = triggerView(value, source, false, undefined)
  if (chip.reasoning === undefined) return ""
  return readable(renderToStaticMarkup(<EffortSlider level={chip.reasoning} view={reasoningView(value, source.models, source.harnesses)} busy={false} onChange={() => undefined} />))
}

/** The markup as a reader meets it: visible text plus the names and tooltips of controls. */
function readable(markup: string): string {
  const attributes = [...markup.matchAll(/(?:title|aria-label|placeholder|label)="([^"]*)"/g)].map((match) => match[1] ?? "")
  return [markup.replace(/<[^>]*>/g, " "), ...attributes].join(" ").replace(/\s+/g, " ")
}

/** Each coding tool as the engine reports it once asked: one ready, one signed out, one missing. */
const ASKED = catalog({
  ...FULL,
  harnesses: [
    { id: "claude-code", available: true, signedIn: true, models: [{ id: "opus", name: "Opus" }], freeTextModel: true },
    { id: "codex", available: true, signedIn: false, models: [{ id: "codex-large", name: "Codex Large" }] },
    { id: "pi", available: false },
  ],
})

describe("the model menu, as drawn", () => {
  test("lists models under their connection and under the coding tool that runs them", () => {
    const text = readable(menu())
    for (const expected of ["Search models", "Anthropic", "Claude Opus 5.5", "OpenAI", "No answer in time (TIMEOUT)", "GPT-5.5 mini", "Local relay", "Lists no models. Type a model id above to use it.", "Claude Code", "Default", "Set in Claude Code", "Sonnet", "Codex", "Set in Codex", "GitHub Copilot", "Set in GitHub Copilot", "Through Pi", "Set in Pi", "Not installed", "Connect another model", "Manage connections", "Refresh models", "200K", "tokens of context"]) {
      expect(text).toContain(expected)
    }
    expect(text).not.toContain("Groq")
    expect(text).not.toContain("Recorded session")
    expect(text).not.toContain("Replay")
  })

  test("never says harness or backend, whatever it shows", () => {
    const states: string[] = [
      menu(),
      menu({ busy: true }),
      menu({ value: { backend: "claude-code" } }),
      menu({ value: { backend: "claude-code", model: "opus", thinking: "off" } }),
      menu({ value: { backend: "pi" } }),
      menu({ catalog: ASKED }),
      menu({ catalog: ASKED, value: { backend: "codex", model: "codex-large" } }),
      menu({ catalog: catalog({ harnesses: ASKED.harnesses }) }),
      menu({ value: { backend: "native" } }),
      menu({ value: { backend: "native", model: "gpt-5.5-mini", connectionId: "openai" } }),
      menu({ value: { backend: "native", model: "gpt-5.5", connectionId: "gone" } }),
      menu({ catalog: catalog() }),
      menu({ catalog: catalog({ loading: true }) }),
      menu({ catalog: catalog({ connections: [conn("groq", "Groq", { status: "error" })] }) }),
      menu({ catalog: catalog({ connectionsError: "ENGINE_NOT_RUNNING" }) }),
      menu({ developer: true }),
      menu({ developer: true, value: { backend: "replay" } }),
    ]
    for (const markup of states) {
      expect(readable(markup)).not.toMatch(WORD)
      expect(readable(markup)).not.toMatch(/backend/i)
    }
  })

  test("says what to do when there is nothing to pick", () => {
    expect(readable(menu({ catalog: catalog() }))).toContain("No model is connected yet.")
    expect(readable(menu({ catalog: catalog() }))).toContain("Connect a model")
    expect(readable(menu({ catalog: catalog({ connections: [conn("groq", "Groq", { status: "error" })] }) }))).toContain("None of your connections is ready to use.")
    expect(readable(menu({ catalog: catalog({ connections: [conn("groq", "Groq", { status: "error" })] }) }))).toContain("Open Connections")
    expect(readable(menu({ catalog: catalog({ connectionsError: "ENGINE_NOT_RUNNING" }) }))).toContain("Connections could not be read.")
    expect(readable(menu({ catalog: catalog({ connectionsError: "ENGINE_NOT_RUNNING" }) }))).toContain("Try again")
    expect(readable(menu({ catalog: catalog({ loading: true }) }))).toContain("Reading your connections")
  })

  test("reasoning is offered for a model and for a coding tool that takes it, and absent for one that takes none", () => {
    expect(levels({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })).toContain("Effort")
    expect(levels({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })).toContain("Balanced for everyday work")
    expect(levels({ backend: "native", model: "gpt-5.5-mini", connectionId: "openai" })).toBe("")
    expect(levels({ backend: "claude-code" })).toContain("Effort")
    expect(levels({ backend: "claude-code", thinking: "off" })).toContain("Runs as Low, the lowest Claude Code takes")
    expect(levels({ backend: "claude-code", thinking: "high" })).not.toContain("Runs as Low")
    expect(levels({ backend: "pi" })).toContain("Effort")
    expect(levels({ backend: "pi", thinking: "off" })).not.toContain("Runs as Low")
    expect(levels({ backend: "replay" })).toBe("")
  })

  test("the levels never say harness or backend either", () => {
    for (const value of [{ backend: "claude-code" }, { backend: "claude-code", thinking: "off" }, { backend: "pi" }, { backend: "codex", model: "codex-large" }, { backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" }] as const) {
      expect(levels(value, ASKED)).not.toMatch(WORD)
      expect(levels(value, ASKED)).not.toMatch(/backend/i)
    }
  })

  test("a coding tool that may not run says why, and what to do about it", () => {
    const markup = menu({ catalog: ASKED })
    const text = readable(markup)
    for (const expected of ["Not signed in", "Run codex login in a terminal, then refresh.", "Codex Large", "Not installed", "Pi was not found on this computer"]) expect(text).toContain(expected)
    expect(markup).toContain("<code>codex login</code>")
    // A tool that is not there cannot be picked. One that says it is not signed in warns and can still be tried.
    expect(markup).toMatch(/<button[^>]*title="Pi was not found on this computer"[^>]*disabled=""/)
    expect(markup.match(/<button[^>]*title="Codex is not signed in[^"]*"[^>]*>/g)).toHaveLength(2)
    expect(markup).not.toMatch(/<button[^>]*title="Codex is not signed in[^"]*"[^>]*disabled/)
  })

  test("developer mode adds the scripted model and recorded sessions", () => {
    const text = readable(menu({ developer: true }))
    expect(text).toContain("Developer")
    expect(text).toContain("Test model")
    expect(text).toContain("Recorded session")
  })
})

describe("the runs-on select, as drawn", () => {
  const draw = (value: PickerValue, from: MenuCatalog = FULL): string => renderToStaticMarkup(<RunsOnSelect catalog={from} value={value} label="Runs on" unbound={{ label: "First connected model", disabled: true }} onChange={() => undefined} />)

  test("groups models by connection, then the coding tools", () => {
    const markup = draw({ backend: "native", model: "claude-opus-5-5", connectionId: "anthropic" })
    const text = readable(markup)
    for (const expected of ["First connected model", "Anthropic", "Claude Opus 5.5", "OpenAI", "GPT-5.5 mini", "Coding tools", "Claude Code", "Opus via Claude Code", "Codex", "Pi (not installed)"]) expect(text).toContain(expected)
    expect(text).not.toMatch(WORD)
    expect(markup).toContain('value="native|anthropic|claude-opus-5-5" selected=""')
  })

  test("a coding tool's model is the selected option, and a tool that cannot run says why", () => {
    const markup = draw({ backend: "claude-code", model: "opus" }, ASKED)
    expect(markup).toContain('value="claude-code|opus" selected=""')
    const text = readable(markup)
    for (const expected of ["Opus via Claude Code", "Codex (not signed in)", "Codex Large via Codex (not signed in)", "Pi (not installed)"]) expect(text).toContain(expected)
    expect(text).not.toMatch(WORD)
    expect(text).not.toMatch(/backend/i)
  })

  test("a model whose connection was removed is still the selected option", () => {
    const markup = draw({ backend: "native", model: "gpt-5.5", connectionId: "gone" })
    expect(readable(markup)).toContain("Removed connection")
    expect(markup).toContain('value="native|gone|gpt-5.5" selected=""')
    // While the connections are still being read, nothing is called removed.
    expect(readable(draw({ backend: "native", model: "gpt-5.5", connectionId: "gone" }, catalog({ loading: true })))).not.toContain("Removed connection")
  })
})
