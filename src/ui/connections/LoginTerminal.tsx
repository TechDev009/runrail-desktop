import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import { useEffect, useRef } from "react"
import { openUrl } from "../../app/actions"
import { closeToolLogin, readToolLogin, startToolLogin, writeToolLogin } from "../../app/connectionSettings"
import { toHostError } from "../../host"
import { terminalLinks, terminalTheme } from "../inspector/TerminalPane"

const POLL_MS = 150

export type LoginState = { readonly kind: "starting" | "running" | "ended" } | { readonly kind: "failed"; readonly code: string }

/**
 * A coding tool's own sign-in, in a terminal inside the dialog. The engine runs the tool's login
 * command and nothing else; this shows what the tool prints and sends what the person types.
 * Each new `run` starts the sign-in again; leaving ends it.
 */
export function LoginTerminal({ connectionId, run, onState }: { readonly connectionId: string; readonly run: number; readonly onState: (state: LoginState) => void }) {
  const host = useRef<HTMLDivElement | null>(null)
  const report = useRef(onState)
  report.current = onState

  useEffect(() => {
    const element = host.current
    if (element === null) return
    let live = true
    let loginId: string | undefined
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let writes = Promise.resolve()
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-term")) || 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 1_000,
      macOptionIsMeta: true,
      theme: terminalTheme(),
      linkHandler: terminalLinks(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)))
    term.open(element)
    fit.fit()
    term.focus()
    // The dialog can grow or shrink while a sign-in runs; the text keeps to the box it is in.
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => fit.fit())
    resized?.observe(element)
    report.current({ kind: "starting" })

    const fail = (error: unknown): void => {
      if (live) report.current({ kind: "failed", code: toHostError(error).code })
    }
    const poll = async (): Promise<void> => {
      if (!live || loginId === undefined) return
      try {
        const output = await readToolLogin(loginId, seq)
        if (!live) return
        if (output.data.length > 0) term.write(output.data)
        seq = output.nextSeq
        if (output.closed) {
          report.current({ kind: "ended" })
          return
        }
      } catch (error) {
        fail(error)
        return
      }
      timer = setTimeout(() => void poll(), POLL_MS)
    }
    const input = term.onData((data) => {
      const id = loginId
      if (id === undefined) return
      // In order, one at a time: a pasted code arrives whole and before the Enter after it.
      writes = writes.then(() => writeToolLogin(id, data)).catch(() => undefined)
    })
    // Started a tick later, so a mount that is undone at once (React's dev double mount) starts none:
    // two starts for one connection could reach the engine out of order and end the one on screen.
    const begin = setTimeout(() => {
      startToolLogin(connectionId, term.cols, term.rows).then((id) => {
        if (!live) {
          void closeToolLogin(id)
          return
        }
        loginId = id
        report.current({ kind: "running" })
        void poll()
      }, fail)
    }, 0)

    return () => {
      live = false
      clearTimeout(begin)
      if (timer !== undefined) clearTimeout(timer)
      input.dispose()
      resized?.disconnect()
      term.dispose()
      if (loginId !== undefined) void closeToolLogin(loginId)
    }
  }, [connectionId, run])

  return <div ref={host} className="conn-login-term" />
}
