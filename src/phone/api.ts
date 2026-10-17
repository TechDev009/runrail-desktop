/**
 * How the phone page reaches Runrail on the Mac: two endpoints on the page's own
 * origin, which the person's `tailscale serve` brings from the Mac. The phone's token lives in this
 * browser's storage only, and goes in a header, never in an address.
 */

export class PhoneApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface PhoneTransport {
  pair(code: string, name: string): Promise<string>
  call<T>(token: string, method: string, params?: Record<string, unknown>): Promise<T>
  /** A thread through its read-only link; the link's secret is all it takes. */
  share<T>(token: string): Promise<T>
}

/** "Mac", or "computer" when a Linux desktop serves this page and marks its root so. */
export const COMPUTER = typeof document !== "undefined" && document.documentElement.dataset.host === "linux" ? "computer" : "Mac"

const UNREACHABLE = `Runrail on your ${COMPUTER} is not answering. Check that it is open and that this phone is on your tailnet.`

async function post(path: string, body: unknown, token?: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    })
  } catch {
    throw new PhoneApiError("PHONE_UNREACHABLE", UNREACHABLE)
  }
  const answer: unknown = await response.json().catch(() => undefined)
  if (response.ok && typeof answer === "object" && answer !== null) return answer
  const error = typeof answer === "object" && answer !== null && "error" in answer ? (answer.error as { code?: unknown; message?: unknown }) : undefined
  // Tailscale answers 502 when nothing listens on the Mac: the app is closed or phone access is off.
  if (error === undefined) throw new PhoneApiError("PHONE_UNREACHABLE", UNREACHABLE)
  throw new PhoneApiError(typeof error.code === "string" ? error.code : "PHONE_FAILED", typeof error.message === "string" ? error.message : "That did not work.")
}

export const httpTransport: PhoneTransport = {
  async pair(code, name) {
    const answer = (await post("/api/pair", { code, name })) as { token?: unknown }
    if (typeof answer.token !== "string") throw new PhoneApiError("PHONE_FAILED", "The pairing answer was not understood.")
    return answer.token
  },
  async call<T>(token: string, method: string, params: Record<string, unknown> = {}) {
    const answer = (await post("/api/call", { method, params }, token)) as { result?: unknown }
    return answer.result as T
  },
  async share<T>(token: string) {
    const answer = (await post("/api/share", { token })) as { result?: unknown }
    return answer.result as T
  },
}

const TOKEN_KEY = "runrail.phone.token"

export function savedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function saveToken(token: string | undefined): void {
  try {
    if (token === undefined) localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // A private window keeps nothing; the phone pairs again next time.
  }
}
