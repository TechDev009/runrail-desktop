import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { connectionsChanged } from "../src/app/connections"
import { initEngines } from "../src/app/engines"
import { announce } from "../src/app/notifications"
import { defaultState } from "../src/app/persist"
import { copyThreadLink, hookUrl, initPhone, loadPhone, makeHook, pairingUrl, phoneItems, publishPage, runPhoneCall, serveCommand, setPhone, shareOnTailnet, shareUrl, unshare, usePhone } from "../src/app/phone"
import { deleteWorkflow, enableWorkflow, saveWorkflow } from "../src/app/workflowRuns"
import { addProject, createThread, get, patchRuntime, patchThread, set } from "../src/app/store"
import { getHost, HostError, setHost, type PhoneCall } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"
import type { StreamFrame } from "../src/host/types"
import { applyFrames, emptyTimeline, type Timeline } from "../src/thread/reducer"

/** What a paired phone may do, as the page runs it. */

setDefaultTimeout(20_000)

let seq = 0
function event(type: string, fields: Record<string, unknown> = {}): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

function asking(approvalId: string, questions?: readonly unknown[]): Timeline {
  return applyFrames(emptyTimeline(), [
    event("turn.started", { turnId: "t1", prompt: "deploy it" }),
    event("tool.started", { turnId: "t1", callId: "c1", name: "run_command", presentation: { kind: "shell", title: "bun test", command: "bun test" } }),
    event("approval.required", { turnId: "t1", approvalId, action: "git push", capability: "shell", reason: "Commands need approval", ...(questions === undefined ? {} : { questions }) }),
  ])
}

let rpcs: { method: string; params: Record<string, unknown> }[] = []
let answers: { id: number; ok: boolean; body: unknown }[] = []
let deliver: (call: PhoneCall) => void = () => undefined
let stop: () => void = () => undefined

beforeEach(() => {
  stop()
  rpcs = []
  answers = []
  const host = createFakeHost()
  const rpc = host.rpc.bind(host)
  host.rpc = async (engineId, method, params = {}) => {
    rpcs.push({ method, params })
    return method === "approval.resolve" ? true : rpc(engineId, method, params)
  }
  host.onPhoneCall = (listener) => {
    deliver = listener
    return () => undefined
  }
  host.phoneAnswer = async (id, ok, body) => {
    answers.push({ id, ok, body })
  }
  setHost(host)
  connectionsChanged()
  set({ ...defaultState(), runtime: {}, git: {}, drafts: {}, toasts: [], view: { kind: "thread" } })
  addProject({ id: "p1", path: "/code/app", name: "app", git: true, addedAt: 1 })
  addProject({ id: "p2", path: "/home/me/app", name: "app", git: true, addedAt: 2, remote: { id: "rm-1", host: "dev-box" } })
  stop = initEngines()
})

describe("a paired phone", () => {
  test("lists threads newest first, with where they run, and not archived ones", async () => {
    const older = createThread({ projectId: "p1", backend: "claude-code", title: "Older" })
    const newer = createThread({ projectId: "p2", backend: "claude-code", title: "On the box" })
    const gone = createThread({ projectId: "p1", backend: "claude-code", title: "Gone" })
    patchThread(older.id, { updatedAt: 1 })
    patchThread(newer.id, { updatedAt: 3 })
    patchThread(gone.id, { updatedAt: 5, archived: true })
    const { threads } = (await runPhoneCall("threads", {})) as { threads: { id: string; machine?: string; project: string; status: string }[] }
    expect(threads.map((thread) => thread.id)).toEqual([newer.id, older.id])
    expect(threads[0]).toMatchObject({ project: "app", machine: "dev-box", status: "idle" })
    expect(threads[1]?.machine).toBeUndefined()
  })

  test("reads a conversation as messages, tool titles and approvals; reasoning stays on the Mac", () => {
    const timeline = applyFrames(asking("a1"), [event("reasoning.delta", { turnId: "t1", itemId: "r1", delta: "thinking hard" })])
    const items = phoneItems(timeline.items)
    expect(items.map((item) => item.kind)).toEqual(["user", "tool", "approval"])
    expect(items[1]).toMatchObject({ title: "bun test" })
    expect(items[2]).toMatchObject({ kind: "approval", approvalId: "a1", action: "git push", status: "pending" })
    expect(phoneItems([{ kind: "user", key: "u", text: "x".repeat(30_000), attachments: 0, state: "sent", at: 1 }])[0]).toMatchObject({ text: `${"x".repeat(20_000)}…` })
  })

  test("sends a message, stops a turn, and answers an approval, but not a question", async () => {
    const thread = createThread({ projectId: "p1", backend: "claude-code", model: "claude-opus-5-5" })
    await expect(runPhoneCall("send", { threadId: thread.id, text: "   " })).rejects.toMatchObject({ code: "PHONE_BAD_MESSAGE" })
    expect(await runPhoneCall("send", { threadId: thread.id, text: "run the tests" })).toEqual({ sent: true })
    expect(get().threads.find((item) => item.id === thread.id)?.title).toBe("run the tests")

    patchRuntime(thread.id, { timeline: asking("a1") })
    await expect(runPhoneCall("approve", { threadId: thread.id, approvalId: "nope", approved: true })).rejects.toMatchObject({ code: "PHONE_NOT_WAITING" })
    await expect(runPhoneCall("approve", { threadId: thread.id, approvalId: "a1", approved: "yes" })).rejects.toMatchObject({ code: "PHONE_BAD_ANSWER" })
    expect(await runPhoneCall("approve", { threadId: thread.id, approvalId: "a1", approved: false })).toEqual({ answered: true })
    expect(rpcs.find((call) => call.method === "approval.resolve")?.params).toMatchObject({ approvalId: "a1", approved: false })

    patchRuntime(thread.id, { timeline: asking("a2", [{ id: "q1", header: "Library", question: "Which one?", options: [{ label: "A" }, { label: "B" }] }]) })
    await expect(runPhoneCall("approve", { threadId: thread.id, approvalId: "a2", approved: true })).rejects.toMatchObject({ code: "PHONE_QUESTION" })

    expect(await runPhoneCall("stop", { threadId: thread.id })).toEqual({ stopped: true })
    expect(rpcs.some((call) => call.method === "turn.cancel")).toBe(true)
  })

  test("is refused for a thread that is gone and for anything else", async () => {
    const thread = createThread({ projectId: "p1", backend: "claude-code" })
    patchThread(thread.id, { archived: true })
    await expect(runPhoneCall("thread", { threadId: thread.id })).rejects.toMatchObject({ code: "PHONE_NO_THREAD" })
    await expect(runPhoneCall("send", { threadId: 42, text: "hi" })).rejects.toMatchObject({ code: "PHONE_NO_THREAD" })
    await expect(runPhoneCall("settings", {})).rejects.toMatchObject({ code: "PHONE_UNKNOWN_METHOD" })
  })

  test("gets each call answered once, a refusal as its code and words", async () => {
    initPhone()
    deliver({ id: 7, device: "ph-1", method: "threads", params: {} })
    deliver({ id: 8, device: "ph-1", method: "settings", params: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answers.find((answer) => answer.id === 7)).toMatchObject({ ok: true, body: { threads: [] } })
    expect(answers.find((answer) => answer.id === 8)).toMatchObject({ ok: false, body: { code: "PHONE_UNKNOWN_METHOD" } })
    expect(answers).toHaveLength(2)
  })

  test("reaches the Mac through the person's own tailscale serve, and pairs from the address's fragment", async () => {
    expect(serveCommand(47615)).toBe("tailscale serve --bg --https=8443 http://127.0.0.1:47615")
    expect(pairingUrl("mac.tail1.ts.net", "K7Q2M9XP")).toBe("https://mac.tail1.ts.net:8443/#pair=K7Q2M9XP")
    // Saying no in the native dialog is not an error; Tailscale's own refusal is.
    usePhone.setState({ error: undefined })
    getHost().tailscaleServe = async () => {
      throw new HostError("TAILSCALE_DECLINED", "Not shared.")
    }
    await shareOnTailnet(true)
    expect(usePhone.getState().error).toBeUndefined()
    getHost().tailscaleServe = async () => {
      throw new HostError("TAILSCALE_HTTPS_OFF", "Turn on HTTPS certificates for your tailnet")
    }
    await shareOnTailnet(true)
    expect(usePhone.getState().error).toContain("HTTPS")
  })
})

describe("notifications on a paired phone", () => {
  test("keep the phone's subscription with the phone, and stop on its say", async () => {
    expect(await runPhoneCall("push.key", {}, "ph-preview")).toEqual({ publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{87}$/) })
    await expect(runPhoneCall("push.subscribe", { subscription: "x", origin: "https://mac.tail1.ts.net:8443" }, "ph-preview")).rejects.toMatchObject({ code: "PHONE_PUSH_INVALID" })
    const subscription = { endpoint: "https://web.push.apple.com/x", keys: { p256dh: "k", auth: "a" } }
    expect(await runPhoneCall("push.subscribe", { subscription, origin: "https://mac.tail1.ts.net:8443" }, "ph-preview")).toEqual({ subscribed: true })
    expect(await getHost().phonePushTargets()).toEqual([{ device: "ph-preview", subscription, origin: "https://mac.tail1.ts.net:8443" }])
    expect(await runPhoneCall("push.unsubscribe", {}, "ph-preview")).toEqual({ subscribed: false })
    expect(await getHost().phonePushTargets()).toEqual([])
  })

  test("are sent while the person is away from Runrail, and a gone phone is forgotten", async () => {
    const thread = createThread({ projectId: "p1", backend: "claude-code", title: "Fix the parser" })
    await getHost().phoneSetPush("ph-preview", { subscription: { endpoint: "https://web.push.apple.com/x" }, origin: "https://mac.tail1.ts.net:8443" })
    const host = getHost()
    const rpc = host.rpc.bind(host)
    let gone = false
    host.rpc = async (engineId, method, params = {}) => {
      if (method !== "push.send") return rpc(engineId, method, params)
      rpcs.push({ method, params })
      return { delivered: !gone, ...(gone ? { gone: true } : {}) }
    }
    patchRuntime(thread.id, { timeline: asking("a1") })
    announce("approval", thread.id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sent = rpcs.filter((call) => call.method === "push.send")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.params).toMatchObject({ contact: "https://mac.tail1.ts.net:8443", message: { title: "Fix the parser", body: "Needs your approval", url: `/#t=${thread.id}`, tag: thread.id, urgency: "high" } })
    gone = true
    announce("finished", thread.id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await getHost().phonePushTargets()).toEqual([])
  })
})

describe("read-only links", () => {
  test("show a shared thread's conversation and status, with nothing to act on", async () => {
    const thread = createThread({ projectId: "p2", backend: "claude-code", title: "Fix the parser" })
    patchRuntime(thread.id, { timeline: asking("a1") })
    const shared = (await runPhoneCall("share.thread", { threadId: thread.id }, "sh-1")) as { title: string; items: { kind: string }[] }
    // Not where it runs or what it is called on this Mac: only what the link shows.
    expect(Object.keys(shared).sort()).toEqual(["items", "status", "title"])
    expect(shared.title).toBe("Fix the parser")
    expect(shared.items.find((item) => item.kind === "approval")).toMatchObject({ status: "pending", question: true })
    patchThread(thread.id, { archived: true })
    await expect(runPhoneCall("share.thread", { threadId: thread.id }, "sh-1")).rejects.toMatchObject({ code: "PHONE_NO_THREAD" })
  })

  test("are one per thread, copied with this Mac's tailnet address, and revoked in Settings", async () => {
    expect(shareUrl({ kind: "thread", token: "abc" }, "mac.tail1.ts.net")).toBe("https://mac.tail1.ts.net:8443/s/abc")
    expect(shareUrl({ kind: "page", token: "abc" }, undefined)).toBe("/p/abc/")
    const thread = createThread({ projectId: "p1", backend: "claude-code", title: "Fix the parser" })
    await copyThreadLink(thread.id)
    expect(get().toasts.map((item) => item.level)).toEqual(["error"])
    await setPhone(true)
    await copyThreadLink(thread.id)
    await copyThreadLink(thread.id)
    const [link] = usePhone.getState().status?.shares ?? []
    expect(usePhone.getState().status?.shares).toHaveLength(1)
    expect(link).toMatchObject({ kind: "thread", threadId: thread.id, title: "Fix the parser" })
    // No clipboard here, so the link is shown to copy by hand.
    expect(get().toasts.map((item) => item.text)).toContain(`Copy this link: https://preview-mac.tail1234.ts.net:8443/s/${link?.token ?? ""}`)
    await publishPage()
    expect(usePhone.getState().status?.shares.map((share) => share.kind)).toEqual(["thread", "page"])
    await unshare(link?.id ?? "")
    expect(usePhone.getState().status?.shares.map((share) => share.kind)).toEqual(["page"])
  })
})

describe("workflow links", () => {
  test("start a workflow that is on and waits for its link, with what the call sent; a gone workflow's link goes", async () => {
    expect(hookUrl("tok", "mac.tail1.ts.net")).toBe("https://mac.tail1.ts.net:8443/hook/tok")
    await saveWorkflow("p1", { id: "alert", name: "On an alert", state: "on", trigger: { kind: "webhook" }, where: "checkout", steps: [{ id: "say", kind: "action", title: "Tell me", action: "notify", text: "Got it" }], budget: { maxMinutes: 30 } })
    const fire = { projectId: "p1", workflowId: "alert", input: '{"alert": "disk full"}' }
    // Only the link itself starts it, never a paired phone or a thread's link.
    await expect(runPhoneCall("hook.fire", fire, "ph-preview")).rejects.toMatchObject({ code: "PHONE_UNKNOWN_METHOD" })
    await expect(runPhoneCall("share.thread", { threadId: "x" }, "ph-preview")).rejects.toMatchObject({ code: "PHONE_UNKNOWN_METHOD" })
    expect(await runPhoneCall("hook.fire", fire, "hk-1")).toMatchObject({ started: true, runId: expect.any(String) })
    expect(rpcs.find((call) => call.method === "workflow.run.start")?.params).toEqual({ id: "alert", trigger: "webhook", input: '{"alert": "disk full"}' })
    await enableWorkflow("p1", "alert", false)
    await expect(runPhoneCall("hook.fire", fire, "hk-1")).rejects.toMatchObject({ code: "PHONE_HOOK_OFF" })

    await setPhone(true)
    const made = await makeHook("p1", "alert")
    expect(made?.token).toBeString()
    expect(usePhone.getState().status?.hooks).toEqual([{ id: made?.id ?? "", projectId: "p1", workflowId: "alert", createdAt: expect.any(Number) }])
    await deleteWorkflow("p1", "alert")
    await expect(runPhoneCall("hook.fire", fire, made?.id ?? "")).rejects.toMatchObject({ code: "PHONE_HOOK_GONE" })
    await loadPhone()
    expect(usePhone.getState().status?.hooks).toEqual([])
  })
})
