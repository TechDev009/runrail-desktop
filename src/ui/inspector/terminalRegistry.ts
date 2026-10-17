/**
 * Lets the shell close terminals without loading the terminal emulator. The terminal pane
 * registers its closers when its chunk loads; before that no terminal can be open.
 */

interface Closers {
  readonly thread: (threadId: string) => void
  readonly one: (threadId: string, terminalId: string) => void
}

let closers: Closers | undefined

export function registerTerminalClosers(value: Closers): void {
  closers = value
}

/** Closes every terminal a thread owns, e.g. before its engine stops or the thread is deleted. */
export function closeThreadTerminals(threadId: string): void {
  closers?.thread(threadId)
}

/** Ends one terminal's shell, when its tab closes. */
export function closeTerminal(threadId: string, terminalId: string): void {
  closers?.one(threadId, terminalId)
}
