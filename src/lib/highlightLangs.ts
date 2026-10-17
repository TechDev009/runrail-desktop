/**
 * The languages code blocks and diffs are highlighted in. Each grammar is its own chunk and loads
 * on first use, in the highlighting worker.
 */

type Loader = () => Promise<{ default: unknown }>

export const LANGS: Record<string, Loader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  py: "python",
  rs: "rust",
  rb: "ruby",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  htm: "html",
  svg: "xml",
  patch: "diff",
  jsonl: "json",
  json5: "jsonc",
}

export const MAX_CODE = 200 * 1024
export const THEME = "runrail"

export function langFor(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  const lower = value.toLowerCase()
  const name = lower.includes("/") || lower.includes(".") ? lower.slice(lower.lastIndexOf("/") + 1) : lower
  if (name === "dockerfile") return "dockerfile"
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name
  const resolved = ALIASES[extension] ?? extension
  return resolved in LANGS ? resolved : undefined
}
