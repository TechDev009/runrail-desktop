/**
 * Notifications on this phone: the page's service worker subscribes with the Mac's
 * key and hands the subscription to Runrail, which encrypts each notification for this phone.
 */

type Caller = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

/** iPhone and iPad deliver web notifications only to a page added to the Home Screen. */
export function needsHomeScreen(): boolean {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true
  return apple && !standalone
}

function keyBytes(text: string): Uint8Array<ArrayBuffer> {
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="))
  return Uint8Array.from(plain, (char) => char.charCodeAt(0))
}

function sameKey(left: ArrayBuffer | null | undefined, right: Uint8Array): boolean {
  if (left === null || left === undefined || left.byteLength !== right.length) return false
  const bytes = new Uint8Array(left)
  return bytes.every((byte, index) => byte === right[index])
}

export async function subscribed(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false
  const registration = await navigator.serviceWorker.getRegistration("/")
  return (await registration?.pushManager.getSubscription()) != null
}

/** Asks for notifications and hands the subscription to Runrail; needs a tap, as browsers require. */
export async function subscribe(call: Caller): Promise<void> {
  const registration = await navigator.serviceWorker.register("/phone-sw.js", { scope: "/" })
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are off for this page. Turn them on in the phone's settings for this browser.")
  const { publicKey } = await call<{ readonly publicKey: string }>("push.key")
  const key = keyBytes(publicKey)
  await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  // A subscription made with an older key of the Mac's would never be delivered.
  if (subscription !== null && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await call("push.subscribe", { subscription: subscription.toJSON(), origin: window.location.origin })
}

export async function unsubscribe(call: Caller): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration("/")
  await (await registration?.pushManager.getSubscription())?.unsubscribe()
  await call("push.unsubscribe")
}
