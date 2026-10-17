import { memo, useEffect, useMemo, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { openUrl } from "../../app/actions"
import { openFileMenu } from "../../app/fileMenu"
import { openFileLink } from "../../app/filePreview"
import { highlightedHtml, highlightHtml, langFor } from "../../lib/highlight"
import { CopyButton } from "../common"

/**
 * Assistant markdown. Raw HTML in model output is never rendered (react-markdown escapes it);
 * code blocks are highlighted lazily; links open in the system browser, file paths where Settings
 * says (the Files pane by default), with the other places on their right-click menu.
 */

const PLUGINS = [remarkGfm]
const PATH_LIKE = /^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

/** `src/a.ts:42`, `src/a.ts:42:7` and `src/a.ts#L42` all name line 42. */
export function splitLocation(value: string): { readonly path: string; readonly line?: number } {
  const match = /^(.*?)(?:(?::(\d+)(?::\d+)?)|(?:#L(\d+)(?:-L?\d+)?))?$/.exec(value)
  const path = match?.[1] ?? value
  const digits = match?.[2] ?? match?.[3]
  const line = digits === undefined ? undefined : Number(digits)
  return { path, ...(line === undefined || line < 1 ? {} : { line }) }
}

/**
 * The file a markdown link points at, or none for a web page, a mail link, an anchor or any other
 * scheme. `file://` links and percent-encoded paths are read as plain paths.
 */
export function fileLinkTarget(href: string): string | undefined {
  if (href.length === 0 || href.startsWith("#")) return undefined
  let target = href
  if (/^file:\/\//i.test(target)) target = target.slice("file://".length)
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(?:mailto|tel|data|javascript|vbscript|blob|about):/i.test(target)) return undefined
  try {
    target = decodeURI(target)
  } catch {
    return undefined
  }
  return target
}

function FilePathLink({ workspace, value, children }: { readonly workspace: string; readonly value: string; readonly children: ReactNode }) {
  const location = splitLocation(value)
  const at = location.line === undefined ? {} : { line: location.line }
  return (
    <code
      className="inline-path"
      role="link"
      tabIndex={0}
      title={`Open ${location.path}${location.line === undefined ? "" : ` at line ${String(location.line)}`}. Right-click for more.`}
      onClick={() => openFileLink(workspace, location.path, at)}
      onContextMenu={(event) => openFileMenu(event, workspace, location.path, at)}
      onKeyDown={(event) => {
        if (event.key === "Enter") openFileLink(workspace, location.path, at)
      }}
    >
      {children}
    </code>
  )
}

export const CodeBlock = memo(function CodeBlock({ code, lang, streaming }: { readonly code: string; readonly lang?: string; readonly streaming?: boolean }) {
  const [html, setHtml] = useState<string | undefined>(() => highlightedHtml(code, lang))
  useEffect(() => {
    if (streaming === true) return
    let live = true
    void highlightHtml(code, lang).then((value) => {
      if (live) setHtml(value)
    })
    return () => {
      live = false
    }
  }, [code, lang, streaming])
  const label = langFor(lang) === undefined ? (lang ?? "text") : lang
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{label}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      {html !== undefined && streaming !== true ? (
        <div className="code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node !== null && typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children)
  return ""
}

function components(workspace: string | undefined, streaming: boolean): Components {
  return {
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children
      const className = child !== null && typeof child === "object" && "props" in child ? ((child.props as { className?: string }).className ?? "") : ""
      const lang = /language-([\w+#-]+)/.exec(className)?.[1]
      const code = textOf(child).replace(/\n$/, "")
      return <CodeBlock code={code} {...(lang === undefined ? {} : { lang })} streaming={streaming} />
    },
    code: ({ children, className }) => {
      const text = textOf(children)
      if (className === undefined && workspace !== undefined && PATH_LIKE.test(text) && !text.includes("://"))
        return (
          <FilePathLink workspace={workspace} value={text}>
            {children}
          </FilePathLink>
        )
      return <code className={className}>{children}</code>
    },
    a: ({ href, children }) => {
      const target = href ?? ""
      const external = /^https?:\/\//i.test(target)
      const file = external || workspace === undefined ? undefined : fileLinkTarget(target)
      if (file !== undefined && workspace !== undefined) {
        const location = splitLocation(file)
        const at = location.line === undefined ? {} : { line: location.line }
        return (
          <a
            className="file-link"
            role="link"
            tabIndex={0}
            title={`Open ${location.path}${location.line === undefined ? "" : ` at line ${String(location.line)}`}. Right-click for more.`}
            onClick={(event) => {
              event.preventDefault()
              openFileLink(workspace, location.path, at)
            }}
            onContextMenu={(event) => openFileMenu(event, workspace, location.path, at)}
            onKeyDown={(event) => {
              if (event.key === "Enter") openFileLink(workspace, location.path, at)
            }}
          >
            {children}
          </a>
        )
      }
      return (
        <a
          href={external ? target : undefined}
          title={target}
          onClick={(event) => {
            event.preventDefault()
            if (external) void openUrl(target)
          }}
        >
          {children}
        </a>
      )
    },
    img: ({ alt }) => <span className="md-image">[image{alt === undefined || alt.length === 0 ? "" : `: ${alt}`}]</span>,
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
    input: ({ checked, type }) => (type === "checkbox" ? <input type="checkbox" checked={checked === true} readOnly disabled /> : null),
  }
}

/**
 * A streaming answer cut at blank lines outside code fences. Only the last block still grows, so
 * the blocks before it keep their parse. A finished answer is parsed whole, since a reference link
 * or a loose list can span blocks.
 */
export function streamingBlocks(text: string): readonly string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | undefined
  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence === undefined ? marker : undefined
    if (fence === undefined && line.trim().length === 0 && current.length > 0) {
      blocks.push(current.join("\n"))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join("\n"))
  return blocks
}

const Block = memo(function Block({ text, parts }: { readonly text: string; readonly parts: Components }) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} components={parts} skipHtml>
      {text}
    </ReactMarkdown>
  )
})

export const Markdown = memo(function Markdown({ text, workspace, streaming = false }: { readonly text: string; readonly workspace?: string; readonly streaming?: boolean }) {
  const parts = useMemo(() => components(workspace, streaming), [workspace, streaming])
  return (
    <div className="markdown">
      {streaming ? streamingBlocks(text).map((block, index) => <Block key={index} text={block} parts={parts} />) : <Block text={text} parts={parts} />}
    </div>
  )
})
