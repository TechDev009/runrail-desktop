import { ExternalLink, FolderUp, Globe, Link, RefreshCw, Share2, Smartphone, Trash, Webhook } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useState } from "react"
import { openUrl } from "../../app/actions"
import { forgetPhone, loadPhone, loadTailscale, pairingUrl, pairPhone, PHONE_HTTPS_PORT, publishPage, removeHook, serveCommand, setPhone, shareOnTailnet, shareUrl, unshare, usePhone } from "../../app/phone"
import { useWords } from "../../app/platformWords"
import { projectById } from "../../app/store"
import { useWorkflows } from "../../app/workflowRuns"
import type { PhoneHook, PhoneShare, TailscaleStatus } from "../../host"
import { bytes, relativeTime, timeAgo } from "../../lib/format"
import { Button, CopyButton, IconButton, Toggle } from "../common"

/**
 * Phone access: Runrail listens on this Mac only, and the person's own Tailscale
 * brings it to their phone. Pairing takes a one-time code shown here.
 */
export function PhoneAccess() {
  const words = useWords()
  const { status, tailscale, error } = usePhone()
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    void loadPhone()
  }, [])
  const running = status?.running === true
  useEffect(() => {
    if (running) void loadTailscale()
  }, [running])
  const pairing = status?.pairing !== undefined && status.pairing.expiresAt > now ? status.pairing : undefined
  const shown = status?.pairing?.code
  useEffect(() => {
    if (shown === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [shown])
  const act = (work: () => Promise<void>): void => {
    setBusy(true)
    void work().finally(() => setBusy(false))
  }
  const left = pairing === undefined ? 0 : Math.max(0, Math.ceil((pairing.expiresAt - now) / 1_000))
  const address = tailscale?.name === undefined ? undefined : `https://${tailscale.name}:${String(PHONE_HTTPS_PORT)}`
  return (
    <div className="phone-access" data-setting="phone-access">
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Phone access</div>
          <div className="setting-hint">
            See threads, send messages, stop a turn, and answer approvals from your phone through your own Tailscale. Runrail listens only on this {words.computer}; your tailnet reaches it through tailscale serve, and only phones you pair here can use it.
          </div>
        </div>
        <div className="setting-control">
          <Toggle label="Phone access" checked={status?.enabled === true} disabled={status === undefined || busy} onChange={(on) => act(() => setPhone(on))} />
        </div>
      </div>
      {(error ?? status?.problem) !== undefined && <p className="setting-hint is-error">{error ?? status?.problem}</p>}
      {running && status !== undefined && (
        <div className="phone-steps">
          <div className="phone-step">
            <div className="setting-label">Share it on your tailnet</div>
            <Tailnet tailscale={tailscale} busy={busy} onCheck={() => act(loadTailscale)} onShare={(on) => act(() => shareOnTailnet(on))} />
            {tailscale?.served !== true && (
              <div className="conn-command">
                <code className="conn-code mono">{serveCommand(status.port)}</code>
                <CopyButton text={serveCommand(status.port)} label="Copy the command" />
              </div>
            )}
          </div>
          <div className="phone-step">
            <div className="setting-label">Pair a phone</div>
            {pairing === undefined ? (
              <>
                <p className="setting-hint">{address === undefined ? `On the phone, open this ${words.computer}'s Tailscale name at port 8443 and enter the code shown here.` : `Scan the code with the phone's camera, or open ${address} and enter the code.`}</p>
                <Button size="sm" variant="ghost" icon={<Smartphone size={13} />} onClick={() => void pairPhone()}>
                  Show a pairing code
                </Button>
              </>
            ) : (
              <div className="phone-pairing" role="status">
                {tailscale?.name !== undefined && (
                  <div className="phone-qr" aria-label="QR code to pair a phone">
                    <QRCodeSVG value={pairingUrl(tailscale.name, pairing.code)} size={148} marginSize={2} level="M" />
                  </div>
                )}
                <div className="phone-pairing-text">
                  <span className="phone-code mono" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>
                    {pairing.code.slice(0, 4)} {pairing.code.slice(4)}
                  </span>
                  {address !== undefined && <span className="setting-hint mono">{address}</span>}
                  <span className="setting-hint">
                    Good for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}, once.
                  </span>
                </div>
              </div>
            )}
          </div>
          {status.devices.length > 0 && (
            <ul className="settings-list" aria-label="Paired phones">
              {status.devices.map((device) => (
                <li key={device.id} className="settings-list-row">
                  <Smartphone size={14} className="muted" />
                  <span className="settings-list-text">
                    <span className="settings-list-title">{device.name}</span>
                    <span className="settings-list-hint">
                      Paired {relativeTime(device.addedAt, now)} · last used {relativeTime(device.seenAt, now)}
                    </span>
                  </span>
                  <IconButton label={`Remove ${device.name}`} size="sm" onClick={() => void forgetPhone(device.id)}>
                    <Trash size={13} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <SharedLinks shares={status.shares} name={tailscale?.name} now={now} busy={busy} onPublish={() => act(publishPage)} />
          {status.hooks.length > 0 && <WorkflowLinks hooks={status.hooks} now={now} />}
        </div>
      )}
    </div>
  )
}

/** Read-only thread links and published pages, each until it is revoked here. */
function SharedLinks({ shares, name, now, busy, onPublish }: { readonly shares: readonly PhoneShare[]; readonly name?: string; readonly now: number; readonly busy: boolean; readonly onPublish: () => void }) {
  return (
    <div className="phone-step" data-setting="phone-links">
      <div className="setting-label">Read-only links</div>
      <p className="setting-hint">Anyone on your tailnet with a link can read that thread or open that page; they cannot send, stop, or approve. Copy a thread's link from its menu, or publish a folder with an index.html, such as a site's build output. A page is a copy taken when you publish it.</p>
      <Button size="sm" variant="ghost" icon={<FolderUp size={13} />} disabled={busy} onClick={onPublish}>
        Publish a folder…
      </Button>
      {shares.length > 0 && (
        <ul className="settings-list" aria-label="Read-only links">
          {shares.map((share) => (
            <li key={share.id} className="settings-list-row">
              {share.kind === "thread" ? <Link size={14} className="muted" /> : <Globe size={14} className="muted" />}
              <span className="settings-list-text">
                <span className="settings-list-title">{share.title}</span>
                <span className="settings-list-hint">
                  {share.kind === "thread" ? "Thread" : `Page, ${String(share.files ?? 0)} files, ${bytes(share.bytes ?? 0)}`} · {relativeTime(share.createdAt, now)}
                </span>
              </span>
              <CopyButton text={shareUrl(share, name)} label={`Copy the link to ${share.title}`} />
              <IconButton label={share.kind === "thread" ? `Revoke the link to ${share.title}` : `Unpublish ${share.title}`} size="sm" onClick={() => void unshare(share.id)}>
                <Trash size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Workflows' webhook links: made in a workflow's trigger, removable here too. */
function WorkflowLinks({ hooks, now }: { readonly hooks: readonly PhoneHook[]; readonly now: number }) {
  const byProject = useWorkflows((state) => state.byProject)
  return (
    <div className="phone-step" data-setting="phone-hooks">
      <div className="setting-label">Workflow links</div>
      <p className="setting-hint">Anyone on your tailnet with one of these links can start that workflow while it is on. Make or renew a link in the workflow's trigger.</p>
      <ul className="settings-list" aria-label="Workflow links">
        {hooks.map((hook) => {
          const project = projectById(hook.projectId)?.name ?? "A removed project"
          const name = byProject[hook.projectId]?.workflows.find((item) => item.id === hook.workflowId)?.name ?? hook.workflowId
          return (
            <li key={hook.id} className="settings-list-row">
              <Webhook size={14} className="muted" />
              <span className="settings-list-text">
                <span className="settings-list-title">{name}</span>
                <span className="settings-list-hint">
                  {project} · made {timeAgo(hook.createdAt, now)}
                  {hook.usedAt === undefined ? "" : ` · last called ${timeAgo(hook.usedAt, now)}`}
                </span>
              </span>
              <IconButton label={`Remove the link to ${name}`} size="sm" onClick={() => void removeHook(hook.id)}>
                <Trash size={13} />
              </IconButton>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Where the person's Tailscale stands, and the one thing to do next. */
function Tailnet({ tailscale, busy, onCheck, onShare }: { readonly tailscale?: TailscaleStatus; readonly busy: boolean; readonly onCheck: () => void; readonly onShare: (on: boolean) => void }) {
  const words = useWords()
  const check = (
    <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} disabled={busy} onClick={onCheck}>
      Check again
    </Button>
  )
  if (tailscale === undefined) return <p className="setting-hint">Looking for Tailscale on this {words.computer}…</p>
  if (!tailscale.installed)
    return (
      <>
        <p className="setting-hint">Install Tailscale on this {words.computer} and on your phone, and sign in to the same tailnet on both.</p>
        <div className="phone-actions">
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void openUrl("https://tailscale.com/download")}>
            Get Tailscale
          </Button>
          {check}
        </div>
      </>
    )
  if (!tailscale.running)
    return (
      <>
        <p className="setting-hint">
          Tailscale is not connected on this {words.computer}. {words.tailscaleConnect}
        </p>
        {check}
      </>
    )
  if (!tailscale.https)
    return (
      <>
        <p className="setting-hint">Your tailnet needs HTTPS certificates: in the Tailscale admin console, open DNS and turn on HTTPS Certificates.</p>
        <div className="phone-actions">
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void openUrl("https://login.tailscale.com/admin/dns")}>
            Open DNS settings
          </Button>
          {check}
        </div>
      </>
    )
  if (tailscale.served)
    return (
      <div className="phone-actions">
        <p className="setting-hint">
          Shared on your tailnet at <span className="mono">{`https://${tailscale.name ?? `this ${words.computer}`}:${String(PHONE_HTTPS_PORT)}`}</span>.
        </p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onShare(false)}>
          Stop sharing
        </Button>
      </div>
    )
  return (
    <>
      <p className="setting-hint">Runrail asks before it runs tailscale serve for this {words.computer}'s port 8443. Or run the command yourself.</p>
      <Button size="sm" variant="ghost" icon={<Share2 size={13} />} disabled={busy} onClick={() => onShare(true)}>
        Share on my tailnet
      </Button>
    </>
  )
}
