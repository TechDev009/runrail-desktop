// The phone page's service worker: it shows Runrail's notifications, which arrive
// encrypted for this phone, and a tap opens their thread. It caches nothing.

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === "string" ? data.title : "Runrail"
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      ...(typeof data.tag === "string" ? { tag: data.tag } : {}),
      icon: "/phone-icon-256.png",
      data: { url },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const open = windows.find((client) => "focus" in client)
      if (open !== undefined) {
        await open.navigate(url).catch(() => undefined)
        return open.focus()
      }
      return self.clients.openWindow(url)
    })(),
  )
})
