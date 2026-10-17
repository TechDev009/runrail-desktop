import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { triageKey, type TriageKey, type WaitingItem } from "../src/app/attention"
import { createFakeHost } from "../src/host/fakeHost"
import type { StreamFrame } from "../src/host/types"
import { QuestionSchema, type Question } from "../src/protocol/schemas"
import { applyFrames, emptyTimeline, loadHistory, type ApprovalItem } from "../src/thread/reducer"
import { answersSoFar, collectAnswers, numberAnswer, optionLabel, QuestionCard, QuestionField, QuestionForm, questionsLead } from "../src/ui/thread/QuestionCard"
import { ApprovalCard, approvalDetail, approvalQuestion } from "../src/ui/thread/rows"

let seq = -1
function event(type: string, fields: Record<string, unknown>): StreamFrame {
  seq += 1
  return { kind: "event", data: { version: 1, sessionId: "s", seq, at: 1_000 + seq, type, ...fields } }
}

const questions = [
  { id: "q1", header: "Library", question: "Which library?", options: [{ label: "Luxon", description: "Zones" }, { label: "date-fns" }], other: true },
  { id: "q2", question: "Which checks?", options: [{ label: "Tests" }, { label: "Lint" }], multiSelect: true, other: true },
  { id: "token", question: "Paste the token", options: [], other: true, secret: true },
]

function asked(extra: () => readonly StreamFrame[] = () => [], fields: Record<string, unknown> = { questions }): ApprovalItem {
  const timeline = applyFrames(emptyTimeline(), [
    event("turn.started", { turnId: "t1", prompt: "plan" }),
    event("tool.started", { turnId: "t1", callId: "c1", name: "AskUserQuestion", presentation: { kind: "other", title: "Ask: Which library?" } }),
    event("approval.required", { turnId: "t1", approvalId: "ap1", action: "question", capability: "user.input", reason: "Which library? (and 2 more)", ...fields }),
    // Built after the question, so each frame takes a later seq.
    ...extra(),
  ])
  return timeline.items.find((item): item is ApprovalItem => item.kind === "approval")!
}

describe("a coding tool's question", () => {
  test("arrives with its questions, and leads with what it asks rather than a permission", () => {
    const item = asked()
    expect(item).toMatchObject({ status: "pending", questions })
    expect(approvalQuestion(item)).toBe("Which library? (and 2 more)")
    expect(approvalDetail(item, undefined)).toBeUndefined()
    const html = renderToStaticMarkup(<QuestionCard item={item} threadId="t" primary={false} />)
    expect(html).toContain("3 questions for you")
    expect(html).toContain("Luxon")
    expect(html).toContain("Zones")
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('type="password"')
    expect(html).toContain("Send answers")
    expect(html).toContain("Skip")
  })

  test("malformed questions leave a plain approval rather than dropping it", () => {
    const item = asked(() => [], { questions: [{ id: "q1", question: "", options: "none" }] })
    expect(item).toBeDefined()
    expect(item.status).toBe("pending")
    expect(item).not.toHaveProperty("questions")
  })

  test("once answered it shows the answers; a secret one is never shown", () => {
    const item = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: true, answers: { q1: ["Luxon"], q2: ["Tests", "Lint"] } })])
    expect(item).toMatchObject({ status: "approved", answers: { q1: ["Luxon"], q2: ["Tests", "Lint"] } })
    const html = renderToStaticMarkup(<QuestionCard item={item} threadId="t" primary={false} />)
    expect(html).toContain("Answered")
    expect(html).toContain("Tests, Lint")
    expect(html).toContain("Answered (kept secret)")
  })

  test("skipped, or approved by a client that showed no questions, it says so", () => {
    const skipped = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: false })])
    expect(renderToStaticMarkup(<QuestionCard item={skipped} threadId="t" primary={false} />)).toContain("Not answered")
    const inReply = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: true })])
    expect(renderToStaticMarkup(<QuestionCard item={inReply} threadId="t" primary={false} />)).toContain("Asked in the reply instead")
  })

  test("every question needs an answer: a choice, or one's own words", () => {
    expect(collectAnswers(questions, { q1: ["Luxon"], q2: ["Tests"] }, {})).toBeUndefined()
    expect(collectAnswers(questions, { q1: ["Luxon"], q2: ["Tests"] }, { token: " s3cret " })).toEqual({ q1: ["Luxon"], q2: ["Tests"], token: ["s3cret"] })
    // One's own words replace a single choice, and join a multi-select's.
    expect(collectAnswers(questions, { q1: ["Luxon"], q2: ["Tests"] }, { q1: "Temporal", q2: "Format", token: "x" })).toEqual({ q1: ["Temporal"], q2: ["Tests", "Format"], token: ["x"] })
  })

  test("in the tray, Return opens it to be answered and D skips it; it is never approved blind", () => {
    const press = (key: string): TriageKey => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false })
    const waiting: WaitingItem = { key: "approval:ap1", kind: "approval", threadId: "t", projectId: "p", title: "T", since: 0, approval: asked() }
    expect(triageKey(press("Enter"), waiting, true)).toEqual({ kind: "open" })
    expect(triageKey(press("a"), waiting, true)).toBeUndefined()
    expect(triageKey(press("d"), waiting, true)).toEqual({ kind: "deny" })
  })
})

describe("an MCP server's form", () => {
  const fields = [
    { id: "q1", header: "github", question: "Branch", options: [{ label: "Main" }, { label: "Next" }] },
    { id: "q2", header: "github", question: "Reviewer", options: [], other: true },
  ]

  test("shows the server's message above its fields, and keeps it once answered", () => {
    const item = asked(() => [], { questions: fields, reason: "github: Open the pull request?" })
    expect(questionsLead(item)).toBe("github: Open the pull request?")
    expect(renderToStaticMarkup(<QuestionCard item={item} threadId="t" primary={false} />)).toContain("github: Open the pull request?")
    const answered = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: true, answers: { q1: ["Next"], q2: ["ada"] } })], { questions: fields, reason: "github: Open the pull request?" })
    expect(renderToStaticMarkup(<QuestionCard item={answered} threadId="t" primary={false} />)).toContain("github: Open the pull request?")
  })

  test("a reason that only repeats the questions is not shown twice; one naming who asked is", () => {
    expect(questionsLead(asked())).toBeUndefined()
    const single = [{ id: "q1", header: "github", question: "Which branch?", options: [], other: true }]
    expect(questionsLead(asked(() => [], { questions: single, reason: "github: Which branch?" }))).toBeUndefined()
    expect(questionsLead(asked(() => [], { questions, reason: "Asked by Codex sub-agent Euclid: Which library? (and 2 more)" }))).toBe("Asked by Codex sub-agent Euclid: Which library? (and 2 more)")
  })

  test("one Runrail declined without asking says why, live and once the thread is read back", () => {
    const why = "It asks you to open a web page, which Runrail cannot show yet"
    const declined = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: false, reason: why })], { action: "Sign in to GitHub", reason: "github: Sign in to GitHub", questions: undefined })
    expect(declined).toMatchObject({ status: "rejected", denial: why })
    const html = renderToStaticMarkup(<ApprovalCard item={declined} threadId="t" primary={false} />)
    expect(html).toContain("Denied")
    expect(html).toContain(why)
    const history = loadHistory(emptyTimeline(), [{ id: "1", seq: 0, at: 1, turnId: "t1", kind: "approval", approvalId: "ap1", action: "Sign in to GitHub", capability: "user.input", reason: "github: Sign in to GitHub", status: "rejected", denial: why }], false)
    const read = history.items.find((item): item is ApprovalItem => item.kind === "approval")
    expect(read).toMatchObject({ denial: why })
    // Withdrawn is not a denial, so its reason is not kept as one.
    const withdrawn = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: false, withdrawn: true, reason: "Codex no longer needs an answer" })])
    expect(withdrawn).not.toHaveProperty("denial")
  })
})

describe("every kind of question a coding tool or an MCP form asks", () => {
  const library: Question = { id: "lib", question: "Which library?", options: [{ label: "date-fns (Recommended)", recommended: true }, { label: "Luxon" }], other: true }
  const checks: Question = { id: "checks", question: "Which checks?", options: [{ label: "Tests" }, { label: "Lint" }], multiSelect: true, other: true }
  const message: Question = { id: "msg", question: "Commit message?", kind: "text", options: [], placeholder: "One line" }
  const slides: Question = { id: "slides", question: "How many slides?", kind: "number", options: [], min: 1, max: 20, step: 1, defaultValue: 5, unit: "slides" }
  const ignore = (): void => undefined

  test("a number answers within its bounds and on its step grid from the minimum, as plain digits", () => {
    expect(collectAnswers([slides], {}, { slides: "5" })).toEqual({ slides: ["5"] })
    expect(collectAnswers([slides], {}, { slides: " 7.0 " })).toEqual({ slides: ["7"] })
    for (const text of ["", " ", "0", "21", "2.5", "abc", "Infinity"]) expect(collectAnswers([slides], {}, { slides: text })).toBeUndefined()
    const odd: Question = { ...slides, min: 1, max: 9, step: 2 }
    expect(numberAnswer(odd, "3")).toBe(3)
    expect(numberAnswer(odd, "4")).toBeUndefined()
    expect(numberAnswer({ ...slides, min: 0, max: 1, step: 0.1 }, "0.3")).toBe(0.3)
    expect(numberAnswer({ ...slides, step: undefined }, "2.5")).toBe(2.5)
  })

  test("text answers with its words; a choice takes a pick or one's own words, and a multi-select both", () => {
    expect(collectAnswers([message], {}, { msg: "  Parse dates\n" })).toEqual({ msg: ["Parse dates"] })
    expect(collectAnswers([message], {}, { msg: "   " })).toBeUndefined()
    expect(collectAnswers([checks], { checks: ["Tests", "Lint"] }, { checks: " Format " })).toEqual({ checks: ["Tests", "Lint", "Format"] })
    expect(collectAnswers([checks], {}, { checks: "Format" })).toEqual({ checks: ["Format"] })
    expect(collectAnswers([checks], { checks: [] }, {})).toBeUndefined()
    // The answer keeps the label as the tool wrote it.
    expect(collectAnswers([library], { lib: ["date-fns (Recommended)"] }, {})).toEqual({ lib: ["date-fns (Recommended)"] })
    expect(collectAnswers([library], { lib: ["Luxon"] }, { lib: "Moment" })).toEqual({ lib: ["Moment"] })
    expect(collectAnswers([library], {}, { lib: "  " })).toBeUndefined()
    // A choice with nothing to choose is a typebox.
    expect(collectAnswers([{ id: "f", question: "Reviewer", options: [] }], {}, { f: "ada" })).toEqual({ f: ["ada"] })
    expect(optionLabel("date-fns (Recommended)")).toBe("date-fns")
    expect(optionLabel("Keep it (recommended) ")).toBe("Keep it")
    expect(optionLabel("(Recommended)")).toBe("(Recommended)")
  })

  test("one malformed extra field is dropped, never the question", () => {
    const sent = { id: "q1", question: "How many?", kind: "number", description: "x".repeat(501), options: [{ label: "A", recommended: "yes", preview: 5 }], min: 1, max: "lots", step: -1, defaultValue: Number.POSITIVE_INFINITY, unit: "u".repeat(17), placeholder: 3 }
    expect(asked(() => [], { questions: [sent] }).questions).toEqual([{ id: "q1", question: "How many?", kind: "number", options: [{ label: "A" }], min: 1 }])
    // An unknown kind is asked as a choice, which with nothing to choose is a typebox.
    const later = { id: "q", question: "When?", kind: "date", options: [] }
    expect(QuestionSchema.parse(later)).toEqual({ id: "q", question: "When?", options: [] })
    expect(renderToStaticMarkup(<QuestionCard item={asked(() => [], { questions: [later] })} threadId="t" primary={false} />)).toContain('class="question-other"')
  })

  test("the preview host's question set shows each kind, and its answers read back as shown", async () => {
    const host = createFakeHost()
    const frames: StreamFrame[] = []
    host.onBatch((_engineId, batch) => frames.push(...batch))
    await host.engineStart({ engineId: "e-ask", workspace: "/Users/preview/code/app", backend: "claude-code", sessionId: "s-ask" })
    await host.streamStart("e-ask", -1, 0)
    const turn = host.rpc("e-ask", "turn.enqueue", { message: "ask me" })
    const question = (): ApprovalItem | undefined => applyFrames(emptyTimeline(), frames).items.find((item): item is ApprovalItem => item.kind === "approval" && item.questions !== undefined)
    for (let tries = 0; tries < 400 && question() === undefined; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const item = question()!
    const asked = item.questions ?? []
    expect(asked.map((one) => one.kind ?? (one.multiSelect === true ? "multi" : "choice"))).toEqual(["choice", "multi", "text", "number", "choice", "choice"])

    const html = renderToStaticMarkup(<QuestionForm item={item} threadId="t" primary={false} />)
    expect(html).toContain('<span class="question-badge">Recommended</span>')
    expect(html).toContain('<span class="question-option-label">date-fns</span>')
    expect(html).toContain('<span class="question-option-label">Keep a wrapper</span>')
    expect(html).not.toContain("(Recommended)")
    expect(html).toContain("The parser reads due dates from issue text.")
    const choices = html.split("<fieldset").filter((part) => part.includes('class="question-options"'))
    expect(choices).toHaveLength(3)
    for (const part of choices) expect(part).toContain('class="question-other"')
    expect(html).toContain('placeholder="Or write your own answer"')
    expect(html).toContain('placeholder="Add an answer of your own"')
    const number = /<input[^>]*type="number"[^>]*>/.exec(html)?.[0] ?? ""
    for (const attribute of ['min="1"', 'max="20"', 'step="1"', 'value="5"']) expect(number).toContain(attribute)
    const slider = /<input[^>]*type="range"[^>]*>/.exec(html)?.[0] ?? ""
    for (const attribute of ['min="1"', 'max="20"', 'step="1"', 'value="5"']) expect(slider).toContain(attribute)
    expect(html).toContain('<span class="question-unit">slides</span>')
    expect(html).toContain("Between 1 and 20 slides")
    expect(/<textarea[^>]*>/.exec(html)?.[0]).toContain('placeholder="e.g. Parse due dates with date-fns"')
    expect(html).toContain('type="password"')
    // Previews wait for an option, and only the single-select one has them.
    expect(html.split("Pick an option to preview it")).toHaveLength(2)
    const compact = renderToStaticMarkup(<QuestionForm item={item} threadId="t" primary={false} compact />)
    expect(compact).toContain("is-compact")
    expect(compact).not.toContain("6 questions for you")
    expect(compact).toContain('type="range"')

    const library = asked[0]!
    const field = (chosen: readonly string[], pointed?: string): string =>
      renderToStaticMarkup(<QuestionField question={library} chosen={chosen} text="" pointed={pointed} disabled={false} onChoose={ignore} onWrite={ignore} onPoint={ignore} onSend={ignore} onSkip={ignore} />)
    expect(field([])).not.toContain("DateTime")
    const picked = field(["Luxon"])
    expect(picked).toContain('class="question-preview"')
    expect(picked).toContain("DateTime.fromISO")
    expect(picked).not.toContain("Pick an option to preview it")
    // The option pointed at shows over the picked one.
    const pointed = field(["Luxon"], "Temporal polyfill")
    expect(pointed).toContain("Bundle size, gzipped:")
    expect(pointed).not.toContain("DateTime")

    const answers = collectAnswers(asked, { q1: ["date-fns (Recommended)"], q2: ["Lint"], q5: ["Keep a wrapper (Recommended)"] }, { q3: "Parse due dates", q4: "8", q6: "s3cret" })
    expect(answers).toEqual({ q1: ["date-fns (Recommended)"], q2: ["Lint"], q3: ["Parse due dates"], q4: ["8"], q5: ["Keep a wrapper (Recommended)"], q6: ["s3cret"] })
    await host.rpc("e-ask", "approval.resolve", { approvalId: item.approvalId, approved: true, answers })
    await turn
    const answered = question()!
    expect(answered.status).toBe("approved")
    expect(answered.answers).not.toHaveProperty("q6")
    const done = renderToStaticMarkup(<QuestionCard item={answered} threadId="t" primary={false} />)
    expect(done).toContain(">date-fns</dd>")
    expect(done).toContain(">8 slides</dd>")
    expect(done).toContain(">Keep a wrapper</dd>")
    expect(done).toContain("Answered (kept secret)")
    expect(done).not.toContain("(Recommended)")
    expect(done).not.toContain("s3cret")
    const reply = frames
      .map((frame) => frame.data as { readonly type?: unknown; readonly text?: unknown })
      .map((data) => (data.type === "assistant.delta" ? String(data.text) : ""))
      .join("")
    expect(reply).toContain("Going with date-fns, then running Lint. The deck gets 8 slides.")
    await host.engineStop("e-ask")
  })
})

describe("asking the coding tool for more questions", () => {
  test("is offered only when the tool takes it, and only on questions", () => {
    const offered = asked(() => [], { questions, takesFollowUp: true })
    expect(offered.takesFollowUp).toBe(true)
    expect(renderToStaticMarkup(<QuestionForm item={offered} threadId="t" primary={false} />)).toContain("Ask me more")
    expect(renderToStaticMarkup(<QuestionForm item={asked()} threadId="t" primary={false} />)).not.toContain("Ask me more")
    expect(asked(() => [], { action: "command", capability: "process.exec", questions: undefined, takesFollowUp: true })).not.toHaveProperty("takesFollowUp")
  })

  test("sends only the questions answered so far", () => {
    expect(answersSoFar(questions as unknown as readonly Question[], { q1: ["Luxon"], q2: [] }, { token: "  " })).toEqual({ q1: ["Luxon"] })
    expect(answersSoFar(questions as unknown as readonly Question[], {}, {})).toEqual({})
    // A number still at the tool's default is not the person's answer yet.
    const slides = QuestionSchema.parse({ id: "n", question: "How many?", kind: "number", options: [], min: 1, max: 9, defaultValue: 5 })
    expect(answersSoFar([slides], {}, { n: "5" })).toEqual({})
    expect(answersSoFar([slides], {}, { n: "6" })).toEqual({ n: ["6"] })
  })

  test("once asked it says so, with the note and the answers given, live and once the thread is read back", () => {
    const resolved = { approved: true, answers: { q1: ["Luxon"] }, followUp: true, note: "Ask about time zones too" }
    const item = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", ...resolved })], { questions, takesFollowUp: true })
    expect(item).toMatchObject({ status: "approved", followUp: true, note: "Ask about time zones too", answers: { q1: ["Luxon"] } })
    const html = renderToStaticMarkup(<QuestionCard item={item} threadId="t" primary={false} />)
    expect(html).toContain("Asked for more questions")
    expect(html).toContain("Your note: Ask about time zones too")
    expect(html).toContain("Not shown (secret)")
    expect(html).toContain(">Luxon</dd>")
    expect(html).toContain('<dd class="muted">-</dd>')
    const history = loadHistory(emptyTimeline(), [{ id: "1", seq: 0, at: 1, turnId: "t1", kind: "approval", approvalId: "ap1", action: "question", capability: "user.input", status: "approved", questions, takesFollowUp: true, ...resolved }], false)
    expect(history.items.find((one): one is ApprovalItem => one.kind === "approval")).toMatchObject({ followUp: true, note: "Ask about time zones too", answers: { q1: ["Luxon"] } })
    // A denial is never a request for more.
    const skipped = asked(() => [event("approval.resolved", { turnId: "t1", approvalId: "ap1", approved: false, followUp: true, note: "x" })], { questions, takesFollowUp: true })
    expect(skipped).not.toHaveProperty("followUp")
  })

  test("the preview host asks a second round, and the reply uses both", async () => {
    const host = createFakeHost()
    const frames: StreamFrame[] = []
    host.onBatch((_engineId, batch) => frames.push(...batch))
    await host.engineStart({ engineId: "e-more", workspace: "/Users/preview/code/app", backend: "claude-code", sessionId: "s-more" })
    await host.streamStart("e-more", -1, 0)
    const turn = host.rpc("e-more", "turn.enqueue", { message: "ask me" })
    const pending = (): ApprovalItem | undefined => applyFrames(emptyTimeline(), frames).items.find((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending")
    const waitFor = async (): Promise<ApprovalItem> => {
      for (let tries = 0; tries < 400 && pending() === undefined; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      return pending()!
    }
    const first = await waitFor()
    expect(first.takesFollowUp).toBe(true)
    await expect(host.rpc("e-more", "approval.resolve", { approvalId: first.approvalId, approved: true, note: "alone" })).rejects.toThrow("followUp is invalid")
    await host.rpc("e-more", "approval.resolve", { approvalId: first.approvalId, approved: true, answers: { q1: ["Luxon"] }, followUp: true, note: "time zones" })
    const second = await waitFor()
    expect(second.approvalId).not.toBe(first.approvalId)
    expect(second.questions?.map((one) => one.id)).toEqual(["q7", "q8"])
    await host.rpc("e-more", "approval.resolve", { approvalId: second.approvalId, approved: true, answers: { q7: ["UTC (Recommended)"], q8: ["ISO 8601"] } })
    await turn
    const settled = applyFrames(emptyTimeline(), frames).items.filter((item): item is ApprovalItem => item.kind === "approval")
    expect(settled[0]).toMatchObject({ status: "approved", followUp: true, note: "time zones", answers: { q1: ["Luxon"] } })
    expect(settled[1]).toMatchObject({ status: "approved", answers: { q7: ["UTC (Recommended)"] } })
    expect(settled[1]).not.toHaveProperty("followUp")
    const reply = frames
      .map((frame) => frame.data as { readonly type?: unknown; readonly text?: unknown })
      .map((data) => (data.type === "assistant.delta" ? String(data.text) : ""))
      .join("")
    expect(reply).toContain("Sure, a few more (you asked: time zones).")
    expect(reply).toContain("Going with Luxon")
    expect(reply).toContain("Dates default to UTC.")
    await host.engineStop("e-more")
  })
})
