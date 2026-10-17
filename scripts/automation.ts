/**
 * Drives a debug build started with RUNRAIL_AUTOMATION=1 (src-tauri/src/automation.rs).
 *
 *   bun scripts/automation.ts eval 'return document.title'
 *   bun scripts/automation.ts eval-file steps.js
 *   bun scripts/automation.ts dialog accept|decline     answers the next GitHub write confirmation
 *   bun scripts/automation.ts dialogs                   the confirmations answered that way
 *   bun scripts/automation.ts pick /abs/folder          answers the next project folder dialog
 *   bun scripts/automation.ts menu-bar open|quit        what the menu bar item's Open and Quit do
 *   bun scripts/automation.ts previews                  where each browser preview sits, and whether it shows
 *   bun scripts/automation.ts window-size 1200x800      resizes the main window
 *   bun scripts/automation.ts preview-key TAB mod+k     presses keys while that preview has the keyboard (macOS)
 *
 * The port and token come from automation.json in the app's data folder; set
 * RUNRAIL_AUTOMATION_INFO to read another (a build with its own identifier or HOME).
 * scripts/e2e-native.ts uses the same client.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AutomationAnswer {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

export interface Automation {
  readonly port: number
  /** Runs `source` as the body of an async function in the app's page. */
  readonly eval: (source: string) => Promise<AutomationAnswer>
  readonly dialog: (answer: "accept" | "decline") => Promise<AutomationAnswer>
  readonly dialogs: () => Promise<AutomationAnswer>
  readonly pick: (folder: string) => Promise<AutomationAnswer>
  readonly menuBar: (action: "open" | "quit") => Promise<AutomationAnswer>
  readonly previews: () => Promise<AutomationAnswer>
  readonly windowSize: (width: number, height: number) => Promise<AutomationAnswer>
  readonly previewKey: (tab: string, keys: string) => Promise<AutomationAnswer>
}

export function automation(infoPath: string): Automation {
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as { readonly port: number; readonly token: string }
  const request = async (method: string, path: string, body?: string): Promise<AutomationAnswer> => {
    const response = await fetch(`http://127.0.0.1:${String(info.port)}${path}`, { method, headers: { authorization: `Bearer ${info.token}` }, ...(body === undefined ? {} : { body }) })
    return (await response.json()) as AutomationAnswer
  }
  return {
    port: info.port,
    eval: (source) => request("POST", "/eval", source),
    dialog: (answer) => request("POST", "/dialog", answer),
    dialogs: () => request("GET", "/dialogs"),
    pick: (folder) => request("POST", "/pick", folder),
    menuBar: (action) => request("POST", "/menu-bar", action),
    previews: () => request("GET", "/previews"),
    windowSize: (width, height) => request("POST", "/window-size", `${String(width)}x${String(height)}`),
    previewKey: (tab, keys) => request("POST", "/preview-key", JSON.stringify({ tab, keys })),
  }
}

if (import.meta.main) {
  const client = automation(process.env.RUNRAIL_AUTOMATION_INFO ?? join(homedir(), "Library", "Application Support", "com.runrail.desktop", "automation.json"))
  const [command, argument, keys] = process.argv.slice(2)
  const result =
    command === "eval" && argument !== undefined
      ? await client.eval(argument)
      : command === "eval-file" && argument !== undefined
        ? await client.eval(readFileSync(argument, "utf8"))
        : command === "dialog" && (argument === "accept" || argument === "decline")
          ? await client.dialog(argument)
          : command === "dialogs"
            ? await client.dialogs()
            : command === "pick" && argument !== undefined
              ? await client.pick(argument)
              : command === "menu-bar" && (argument === "open" || argument === "quit")
                ? await client.menuBar(argument)
                : command === "previews"
                  ? await client.previews()
                  : command === "window-size" && argument !== undefined && /^\d+x\d+$/.test(argument)
                    ? await client.windowSize(Number(argument.split("x")[0]), Number(argument.split("x")[1]))
                    : command === "preview-key" && argument !== undefined && keys !== undefined
                      ? await client.previewKey(argument, keys)
                      : undefined
  if (result === undefined) {
    console.error("usage: bun scripts/automation.ts eval <js> | eval-file <path> | dialog accept|decline | dialogs | pick <folder> | menu-bar open|quit | previews | window-size WxH | preview-key <tab> <keys>")
    process.exit(2)
  }
  console.log(JSON.stringify(result, null, 2))
  if (result.ok !== true) process.exit(1)
}
