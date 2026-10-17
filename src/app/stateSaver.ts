/**
 * Saves the desktop state one write at a time, always the latest state. What counts as saved
 * moves only when the host wrote it, so a failed save is tried again instead of being forgotten.
 */
export interface StateSaver {
  /** Something changed: save after the delay. */
  changed(): void
  /** Save now, after any save already under way. */
  flush(): Promise<void>
}

export interface StateSaverOptions {
  readonly read: () => string
  readonly write: (text: string) => Promise<void>
  readonly failed: (error: unknown, attempt: number) => void
  readonly delayMs: number
  readonly maxDelayMs?: number
}

export function createStateSaver(options: StateSaverOptions): StateSaver {
  let saved = options.read()
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let writing: Promise<void> = Promise.resolve()
  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => void flush(), ms)
  }
  const flush = (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    writing = writing.then(async () => {
      const next = options.read()
      if (next === saved) return
      try {
        await options.write(next)
        saved = next
        failures = 0
      } catch (error) {
        failures += 1
        options.failed(error, failures)
        if (timer === undefined) schedule(Math.min(options.delayMs * 2 ** failures, options.maxDelayMs ?? 60_000))
      }
    })
    return writing
  }
  return { changed: () => schedule(options.delayMs), flush }
}
