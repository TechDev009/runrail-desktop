import { PhoneApiError, type PhoneTransport } from "./api"

/**
 * The phone page in a plain browser during development: the app runs in the same page on its
 * preview host, and calls go straight to the handler a real phone's calls reach on the Mac.
 */
export async function previewTransport(): Promise<PhoneTransport> {
  const { initHost } = await import("../host")
  await initHost()
  const { boot } = await import("../app/boot")
  await boot()
  const { PhoneError, runPhoneCall } = await import("../app/phone")
  const { getHost } = await import("../host")
  const run = async <T,>(method: string, params: Record<string, unknown>, device = "ph-preview"): Promise<T> => {
    try {
      return (await runPhoneCall(method, params, device)) as T
    } catch (error) {
      throw error instanceof PhoneError ? new PhoneApiError(error.code, error.message) : error
    }
  }
  return {
    async pair(code) {
      if (code.replace(/[\s-]/g, "").toUpperCase() !== "K7Q2M9XP") throw new PhoneApiError("PHONE_PAIRING_WRONG", "That code is not right. The preview's code is K7Q2 M9XP.")
      return "preview"
    },
    async call<T>(_token: string, method: string, params: Record<string, unknown> = {}) {
      return run<T>(method, params)
    },
    async share<T>(token: string) {
      const share = (await getHost().phoneStatus()).shares.find((each) => each.kind === "thread" && each.token === token)
      if (share?.threadId === undefined) throw new PhoneApiError("PHONE_SHARE_GONE", "This link was revoked or never existed.")
      return run<T>("share.thread", { threadId: share.threadId }, share.id)
    },
  }
}
