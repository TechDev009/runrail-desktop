import { MessageSquarePlus } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { artboardLayout, artboardTab, type ArtboardPlace } from "../../app/artboards"
import { startPicking, stopPicking, usePicking } from "../../app/pageComments"
import { openArtboard, usePreviews } from "../../app/previews"
import { signInProject } from "../../app/signIns"
import { getHost } from "../../host"
import type { PreviewBounds } from "../../host/types"
import { cx, IconButton } from "../common"
import { useHidePreviewWhenGone } from "../hooks"

/**
 * A browser tab's page at phone, tablet, and desktop widths side by side. Each
 * artboard is its own native page, placed over its box and zoomed so it lays out at its full width;
 * in the UI preview a scaled iframe stands in.
 */

/** The least the host scales a page by. */
const MIN_ZOOM = 0.1

interface Area {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export function Artboards({ threadId, tab, url, covered }: { readonly threadId: string; readonly tab: string; readonly url: string; readonly covered: boolean }) {
  const node = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<Area | undefined>()

  useLayoutEffect(() => {
    const element = node.current
    if (element === null) return
    let pending = 0
    const sync = (): void => {
      pending = 0
      const box = element.getBoundingClientRect()
      setArea((previous) => (previous !== undefined && previous.left === box.left && previous.top === box.top && previous.width === box.width && previous.height === box.height ? previous : { left: box.left, top: box.top, width: box.width, height: box.height }))
    }
    const schedule = (): void => {
      if (pending === 0) pending = requestAnimationFrame(sync)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener("resize", schedule)
    sync()
    return () => {
      cancelAnimationFrame(pending)
      observer.disconnect()
      window.removeEventListener("resize", schedule)
    }
  }, [])

  const places = area === undefined ? [] : artboardLayout(area).places
  const last = places[places.length - 1]
  // Narrower than the smallest scale the host takes: say so rather than spill over the app.
  const cramped = area !== undefined && last !== undefined && last.x + last.width > area.width + 1

  return (
    <div ref={node} className="browser-artboards">
      {area === undefined ? null : cramped ? (
        <div className="browser-covered">Widen the panel to see the artboards</div>
      ) : (
        places.map((place) => <ArtboardFrame key={place.artboard.id} threadId={threadId} tab={tab} url={url} place={place} area={area} covered={covered} />)
      )}
    </div>
  )
}

function ArtboardFrame({ threadId, tab, url, place, area, covered }: { readonly threadId: string; readonly tab: string; readonly url: string; readonly place: ArtboardPlace; readonly area: Area; readonly covered: boolean }) {
  const host = getHost()
  const native = host.previewNative
  const id = artboardTab(tab, place.artboard.id)
  const page = usePreviews((state) => state[id])
  const picking = usePicking((state) => state.tab === id)
  const zoom = Math.min(1, Math.max(MIN_ZOOM, place.width / place.artboard.width))
  const bounds: PreviewBounds | null = covered ? null : { x: Math.round(area.left + place.x), y: Math.round(area.top + place.y), width: place.width, height: place.height }
  const latest = useRef(bounds)
  latest.current = bounds
  // A page the agent already loaded here out of sight shows as it is, not reloaded.
  const [opened, setOpened] = useState<string | undefined>(() => {
    const kept = usePreviews.getState()[id]
    return native && kept?.url === url && !kept.unloaded ? url : undefined
  })
  const sent = useRef<string | undefined>(undefined)

  // Loads the tab's address, and again after the host closed the page to make room.
  useEffect(() => {
    if (!native) return
    if (opened === url && page?.unloaded !== true) return
    let live = true
    openArtboard(id, url, latest.current, signInProject(threadId)).then(
      (reachable) => {
        if (!live || !reachable) return
        sent.current = undefined
        setOpened(url)
      },
      // The tab's own page shows why; an artboard stays empty.
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [native, id, url, opened, page?.unloaded, threadId])

  // Follows its box, zoomed so the page lays out at the artboard's width; only when something moved.
  useEffect(() => {
    if (!native || opened === undefined) return
    const key = bounds === null ? "hidden" : `${String(bounds.x)},${String(bounds.y)},${String(bounds.width)},${String(bounds.height)},${String(zoom)}`
    if (sent.current === key) return
    sent.current = key
    void host.previewBounds(id, bounds).then(() => (bounds === null ? undefined : host.previewZoom(id, zoom))).catch(() => {
      sent.current = undefined
    })
  })

  useHidePreviewWhenGone(host, id)

  const { artboard } = place
  return (
    <div className="artboard" style={{ left: place.x, top: place.y, width: place.width, height: place.height }}>
      <div className="artboard-head">
        <span className="artboard-name">{artboard.label}</span>
        <span className="artboard-width">{artboard.width}</span>
        <IconButton label={picking ? "Stop picking" : `Comment on an element at ${artboard.label.toLowerCase()} width`} size="sm" active={picking} disabled={native && opened === undefined} onClick={() => void (picking ? stopPicking() : startPicking(threadId, id))}>
          <MessageSquarePlus size={12} />
        </IconButton>
      </div>
      <div className={cx("artboard-page", page?.loading === true && "is-loading")}>
        {!native && (
          <iframe
            className="artboard-iframe"
            title={`${artboard.label}, ${String(artboard.width)} wide`}
            src={url}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            style={{ width: artboard.width, height: artboard.height, transform: `scale(${String(zoom)})` }}
          />
        )}
      </div>
    </div>
  )
}
