import { MessageCircleQuestion, MessageCircleX, MessageCircleReply } from "lucide-react"
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { resolveApproval } from "../../app/engines"
import { get } from "../../app/store"
import type { Question, QuestionOption } from "../../protocol/schemas"
import type { ApprovalItem } from "../../thread/reducer"
import { Button, cx, useOverlays } from "../common"
import { Markdown } from "./Markdown"
import { approvalQuestion, approvalShortcut, reasonParts, visibleText } from "./rows"

type Answers = Readonly<Record<string, readonly string[]>>
type Written = Readonly<Record<string, string>>

const RECOMMENDED = /\s*\(recommended\)\s*$/i
/** The bound on each answer read back from the engine. */
const MAX_ANSWER = 2_000
const MAX_TEXT_HEIGHT = 160

/** An option's label as shown: without the "(Recommended)" a tool appends, which its badge says instead. The answer keeps it. */
export function optionLabel(label: string): string {
  const shown = label.replace(RECOMMENDED, "")
  return shown.length > 0 ? shown : label
}

function isRecommended(option: QuestionOption): boolean {
  return option.recommended === true || RECOMMENDED.test(option.label)
}

/** A number with its unit: "5 slides", "40%". */
export function withUnit(value: string, unit: string | undefined): string {
  if (unit === undefined || unit.length === 0) return value
  return /^\p{L}/u.test(unit) ? `${value} ${unit}` : `${value}${unit}`
}

/** A number question's answer as typed: a number within its bounds and on its step grid from the minimum, else undefined. */
export function numberAnswer(question: Question, text: string): number | undefined {
  const trimmed = text.trim()
  const value = trimmed.length === 0 ? Number.NaN : Number(trimmed)
  if (!Number.isFinite(value)) return undefined
  if ((question.min !== undefined && value < question.min) || (question.max !== undefined && value > question.max)) return undefined
  if (question.step === undefined) return value
  const steps = (value - (question.min ?? 0)) / question.step
  // Float error: 0.3 is 2.9999999999999996 steps of 0.1.
  return Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(1, Math.abs(steps)) ? value : undefined
}

function numberHint(question: Question): string | undefined {
  const { min, max, step, unit } = question
  const bound = (value: number): string => withUnit(String(value), unit)
  const range = min !== undefined && max !== undefined ? `Between ${String(min)} and ${bound(max)}` : min !== undefined ? `At least ${bound(min)}` : max !== undefined ? `At most ${bound(max)}` : undefined
  if (step === undefined || step === 1) return range
  return range === undefined ? `In steps of ${String(step)}` : `${range}, in steps of ${String(step)}`
}

function answerOf(question: Question, chosen: readonly string[], text: string): readonly string[] | undefined {
  if (question.kind === "number") {
    const value = numberAnswer(question, text)
    return value === undefined ? undefined : [String(value)]
  }
  const own = text.trim()
  if (question.kind === "text") return own.length > 0 ? [own] : undefined
  const list = question.multiSelect === true ? [...chosen, ...(own.length > 0 ? [own] : [])] : own.length > 0 ? [own] : chosen.slice(0, 1)
  return list.length > 0 ? list : undefined
}

/**
 * Each question's answer: the choices picked, or the person's own words (a single-choice question
 * takes one or the other; a multi-select one takes both), the text written, or a number in range.
 * Undefined until every question has one.
 */
export function collectAnswers(questions: readonly Question[], picked: Answers, written: Written): Answers | undefined {
  const answers: Record<string, readonly string[]> = {}
  for (const question of questions) {
    const list = answerOf(question, picked[question.id] ?? [], written[question.id] ?? "")
    if (list === undefined) return undefined
    answers[question.id] = list
  }
  return answers
}

/**
 * The questions answered so far, for a request for more questions; the rest go unanswered. A number
 * left at the tool's own default is not the person's answer yet.
 */
export function answersSoFar(questions: readonly Question[], picked: Answers, written: Written): Answers {
  const answers: Record<string, readonly string[]> = {}
  for (const question of questions) {
    const text = written[question.id] ?? ""
    if (question.kind === "number" && question.defaultValue !== undefined && text.trim() === String(question.defaultValue)) continue
    const list = answerOf(question, picked[question.id] ?? [], text)
    if (list !== undefined) answers[question.id] = list
  }
  return answers
}

/** Where the answers start: a number question at its default. */
function startingAnswers(questions: readonly Question[]): Written {
  return Object.fromEntries(questions.flatMap((question) => (question.kind === "number" && question.defaultValue !== undefined ? [[question.id, String(question.defaultValue)]] : [])))
}

/**
 * What the request says beyond its questions: an MCP server's message above its fields, or the
 * sub-agent that asked. Undefined when the reason only repeats the questions.
 */
export function questionsLead(item: ApprovalItem): string | undefined {
  const reason = item.reason?.replace(/\s+/g, " ").trim()
  if (reason === undefined || reason.length === 0) return undefined
  const summary = approvalQuestion(item).replace(/\s+/g, " ").trim()
  return reason === summary || reasonParts(reason)?.detail === summary ? undefined : visibleText(reason)
}

/** A coding tool's questions in the thread: answered here, or shown with their answers once settled. */
export const QuestionCard = memo(function QuestionCard({ item, threadId, primary }: { readonly item: ApprovalItem; readonly threadId: string; readonly primary: boolean }) {
  if (item.status === "pending") return <QuestionForm item={item} threadId={threadId} primary={primary} />
  const answered = item.status === "approved" && (item.answers !== undefined || item.followUp === true)
  // Approved without answers, by a client that showed no questions: the tool asks in its reply.
  const label = item.followUp === true && item.status === "approved" ? "Asked for more questions" : answered ? "Answered" : item.status === "approved" ? "Asked in the reply instead" : item.withdrawn === true ? "No longer needed" : "Not answered"
  const lead = questionsLead(item)
  return (
    <div className="row-question-done" role="group" aria-label={label}>
      <div className={cx("row-approval-done", answered ? "is-approved" : "is-unanswered")}>
        {answered ? <MessageCircleReply size={13} /> : <MessageCircleX size={13} />}
        <span>{label}</span>
      </div>
      {lead !== undefined && <p className="question-lead is-done">{lead}</p>}
      {item.denial !== undefined && <div className="approval-denial">{visibleText(item.denial)}</div>}
      {item.note !== undefined && <p className="question-note">Your note: {visibleText(item.note)}</p>}
      <dl className="question-answers">
        {(item.questions ?? []).map((question) => (
          <div key={question.id} className="question-answer">
            <dt>{question.question}</dt>
            <dd className={cx((!answered || item.answers?.[question.id] === undefined) && "muted")}>{answerText(question, item.answers, item.followUp === true)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
})

/** `partial`: some questions may be unanswered, and a secret answer never comes back to tell. */
function answerText(question: Question, answers: Answers | undefined, partial: boolean): string {
  if (question.secret === true) return answers === undefined ? "-" : partial ? "Not shown (secret)" : "Answered (kept secret)"
  const given = answers?.[question.id]
  if (given === undefined || given.length === 0) return "-"
  return given.map((answer) => (question.kind === "number" ? withUnit(answer, question.unit) : question.options.some((option) => option.label === answer) ? optionLabel(answer) : answer)).join(", ")
}

/** The questions with their choices; `compact` drops the heading, for the office and comparison cards. */
export function QuestionForm({ item, threadId, primary, compact = false }: { readonly item: ApprovalItem; readonly threadId: string; readonly primary: boolean; readonly compact?: boolean }) {
  const questions = item.questions ?? []
  const lead = questionsLead(item)
  const [picked, setPicked] = useState<Answers>({})
  const [written, setWritten] = useState<Written>(() => startingAnswers(questions))
  const [pointed, setPointed] = useState<Readonly<Record<string, string | undefined>>>({})
  const [busy, setBusy] = useState<"send" | "skip" | "more" | undefined>()
  // The note for a request for more questions, while the person is writing one.
  const [more, setMore] = useState<string | undefined>()
  const answers = collectAnswers(questions, picked, written)
  const send = async (): Promise<void> => {
    if (answers === undefined || busy !== undefined) return
    setBusy("send")
    await resolveApproval(threadId, item.approvalId, true, undefined, undefined, answers)
    setBusy(undefined)
  }
  const askMore = async (): Promise<void> => {
    if (more === undefined || busy !== undefined) return
    setBusy("more")
    const note = more.trim()
    await resolveApproval(threadId, item.approvalId, true, undefined, undefined, answersSoFar(questions, picked, written), note.length === 0 ? {} : { note })
    setBusy(undefined)
  }
  const skip = async (): Promise<void> => {
    if (busy !== undefined) return
    setBusy("skip")
    await resolveApproval(threadId, item.approvalId, false)
    setBusy(undefined)
  }
  // The keys shown on the buttons, while nothing covers the thread; the latest answers are read when pressed.
  const latest = useRef({ answers, send, skip })
  latest.current = { answers, send, skip }
  const armed = primary && busy === undefined && more === undefined
  useEffect(() => {
    if (!armed) return
    const armedAt = Date.now()
    const key = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const answer = approvalShortcut({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing, defaultPrevented: event.defaultPrevented, target }, Date.now() - armedAt)
      if (answer === undefined || (answer === "approve" && latest.current.answers === undefined)) return
      const state = get()
      if (state.dialog !== undefined || state.settings !== false || state.palette || useOverlays.getState().length > 0) return
      event.preventDefault()
      void (answer === "approve" ? latest.current.send() : latest.current.skip())
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [armed, item.approvalId])
  const choose = (question: Question, label: string): void => {
    setPicked((current) => {
      const chosen = current[question.id] ?? []
      if (question.multiSelect !== true) return { ...current, [question.id]: chosen[0] === label ? [] : [label] }
      return { ...current, [question.id]: chosen.includes(label) ? chosen.filter((item) => item !== label) : [...chosen, label] }
    })
    // One answer to a single-choice question: a picked choice replaces one's own words.
    if (question.multiSelect !== true) setWritten((current) => ({ ...current, [question.id]: "" }))
  }
  const write = (question: Question, text: string): void => {
    setWritten((current) => ({ ...current, [question.id]: text }))
    if (question.multiSelect !== true && text.trim().length > 0) setPicked((current) => ({ ...current, [question.id]: [] }))
  }
  return (
    <div className={cx("row-approval", "row-question", compact && "is-compact")} role="group" aria-label="Question from the coding tool" data-primary-approval={primary ? "true" : undefined}>
      {!compact && (
        <div className="approval-head">
          <MessageCircleQuestion size={15} />
          <span className="approval-title">{questions.length > 1 ? `${String(questions.length)} questions for you` : "A question for you"}</span>
        </div>
      )}
      {lead !== undefined && <p className="question-lead">{lead}</p>}
      {questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          chosen={picked[question.id] ?? []}
          text={written[question.id] ?? ""}
          pointed={pointed[question.id]}
          disabled={busy !== undefined}
          onChoose={(label) => choose(question, label)}
          onWrite={(text) => write(question, text)}
          onPoint={(label) => setPointed((current) => ({ ...current, [question.id]: label }))}
          onSend={() => void send()}
          onSkip={() => void skip()}
        />
      ))}
      {more !== undefined && <MoreNote text={more} disabled={busy !== undefined} onWrite={setMore} onSend={() => void askMore()} onCancel={() => setMore(undefined)} />}
      <div className="approval-actions">
        {more === undefined ? (
          <>
            <Button variant="primary" size="sm" loading={busy === "send"} disabled={answers === undefined || busy !== undefined} onClick={() => void send()} {...(primary ? { kbd: "mod+enter" } : {})}>
              {questions.length > 1 ? "Send answers" : "Send answer"}
            </Button>
            {item.takesFollowUp === true && (
              <Button size="sm" disabled={busy !== undefined} title="The coding tool asks more questions before it goes on" onClick={() => setMore("")}>
                Ask me more
              </Button>
            )}
            <Button size="sm" loading={busy === "skip"} disabled={busy !== undefined} title="The coding tool goes on without an answer" onClick={() => void skip()} {...(primary ? { kbd: "mod+shift+enter" } : {})}>
              Skip
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" loading={busy === "more"} disabled={busy !== undefined} onClick={() => void askMore()}>
              Ask for more questions
            </Button>
            <Button size="sm" disabled={busy !== undefined} onClick={() => setMore(undefined)}>
              Back
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** What else the tool should ask about; answers already given go with the request. */
function MoreNote({ text, disabled, onWrite, onSend, onCancel }: { readonly text: string; readonly disabled: boolean; readonly onWrite: (text: string) => void; readonly onSend: () => void; readonly onCancel: () => void }) {
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  return (
    <div className="question-more">
      <textarea
        ref={box}
        className="question-other question-text-answer"
        rows={2}
        maxLength={MAX_ANSWER}
        disabled={disabled}
        value={text}
        placeholder="What else should it ask about? (optional)"
        aria-label="What else the coding tool should ask about"
        onChange={(event) => onWrite(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            onSend()
          }
        }}
      />
      <span className="question-hint">The answers you gave go with it.</span>
    </div>
  )
}

interface FieldProps {
  readonly question: Question
  readonly chosen: readonly string[]
  readonly text: string
  /** The option under the pointer or keyboard focus, whose preview shows over the picked one's. */
  readonly pointed: string | undefined
  readonly disabled: boolean
  readonly onChoose: (label: string) => void
  readonly onWrite: (text: string) => void
  readonly onPoint: (label: string | undefined) => void
  readonly onSend: () => void
  readonly onSkip: () => void
}

/** One question, asked by its kind: choices with a typebox for one's own answer, free text, or a number. */
export function QuestionField(props: FieldProps) {
  const { question } = props
  const descriptionId = useId()
  const description = question.description !== undefined && question.description.length > 0 ? question.description : undefined
  // The thread-wide keys skip fields, so a field takes Return itself; Shift+Return is a new line in a text answer.
  const enter = (event: ReactKeyboardEvent<HTMLElement>, multiline: boolean): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    const mod = event.metaKey || event.ctrlKey
    if (multiline && event.shiftKey && !mod) return
    event.preventDefault()
    if (mod && event.shiftKey) props.onSkip()
    else props.onSend()
  }
  return (
    <fieldset className="question" aria-describedby={description === undefined ? undefined : descriptionId}>
      <legend className="question-legend">
        {question.header !== undefined && question.header.length > 0 && <span className="question-header">{question.header}</span>}
        <span className="question-text">{question.question}</span>
      </legend>
      {description !== undefined && (
        <p id={descriptionId} className="question-description">
          {description}
        </p>
      )}
      {question.kind === "number" ? (
        <NumberAnswer {...props} enter={enter} />
      ) : question.kind === "text" ? (
        <OwnAnswer question={question} text={props.text} disabled={props.disabled} multiline placeholder={question.placeholder ?? "Your answer"} label={question.question} onWrite={props.onWrite} enter={enter} />
      ) : (
        <ChoiceAnswer {...props} enter={enter} />
      )}
    </fieldset>
  )
}

type Enter = (event: ReactKeyboardEvent<HTMLElement>, multiline: boolean) => void

function ChoiceAnswer({ question, chosen, text, pointed, disabled, onChoose, onWrite, onPoint, enter }: FieldProps & { readonly enter: Enter }) {
  const multi = question.multiSelect === true
  const options = question.options
  const previews = !multi && options.some((option) => option.preview !== undefined && option.preview.length > 0)
  const preview = previews ? (options.find((option) => option.label === pointed)?.preview ?? options.find((option) => chosen.includes(option.label))?.preview) : undefined
  const point = (label: string | undefined): (() => void) | undefined => (previews ? () => onPoint(label) : undefined)
  return (
    <>
      {options.length > 0 && (
        <div className={cx("question-choices", previews && "has-preview")}>
          <div className="question-options" role={multi ? "group" : "radiogroup"} aria-label={question.question}>
            {options.map((option) => {
              const selected = chosen.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  role={multi ? "checkbox" : "radio"}
                  aria-checked={selected}
                  className={cx("question-option", selected && "is-selected")}
                  disabled={disabled}
                  onClick={() => onChoose(option.label)}
                  onMouseEnter={point(option.label)}
                  onFocus={point(option.label)}
                  onMouseLeave={point(undefined)}
                  onBlur={point(undefined)}
                >
                  <span className="question-option-head">
                    <span className="question-option-label">{optionLabel(option.label)}</span>
                    {isRecommended(option) && <span className="question-badge">Recommended</span>}
                  </span>
                  {option.description !== undefined && option.description.length > 0 && <span className="question-option-description">{option.description}</span>}
                </button>
              )
            })}
          </div>
          {previews && <div className="question-preview">{preview !== undefined && preview.length > 0 ? <Markdown text={preview} /> : <span className="question-preview-empty">Pick an option to preview it</span>}</div>}
        </div>
      )}
      {(question.other === true || options.length === 0) && (
        <OwnAnswer
          question={question}
          text={text}
          disabled={disabled}
          multiline={false}
          placeholder={options.length > 0 ? (multi ? "Add an answer of your own" : "Or write your own answer") : (question.placeholder ?? "Your answer")}
          label={options.length > 0 ? `Your own answer to: ${question.question}` : question.question}
          onWrite={onWrite}
          enter={enter}
        />
      )}
      {multi && <span className="question-hint">Pick any that apply</span>}
    </>
  )
}

/** The person's own words: one line beside choices, a growing box for a text question, always masked when secret. */
function OwnAnswer({ question, text, disabled, multiline, placeholder, label, onWrite, enter }: { readonly question: Question; readonly text: string; readonly disabled: boolean; readonly multiline: boolean; readonly placeholder: string; readonly label: string; readonly onWrite: (text: string) => void; readonly enter: Enter }) {
  const box = useRef<HTMLTextAreaElement>(null)
  const secret = question.secret === true
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    element.style.height = "auto"
    // scrollHeight leaves out the border, which a border-box height includes.
    const border = element.offsetHeight - element.clientHeight
    element.style.height = `${String(Math.min(element.scrollHeight + border, MAX_TEXT_HEIGHT))}px`
  }, [text])
  if (multiline && !secret) {
    return <textarea ref={box} className="question-other question-text-answer" rows={1} spellCheck maxLength={MAX_ANSWER} disabled={disabled} value={text} placeholder={placeholder} aria-label={label} onChange={(event) => onWrite(event.target.value)} onKeyDown={(event) => enter(event, true)} />
  }
  return (
    <input
      className="question-other"
      type={secret ? "password" : "text"}
      autoComplete="off"
      spellCheck={!secret}
      maxLength={MAX_ANSWER}
      disabled={disabled}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => onWrite(event.target.value)}
      onKeyDown={(event) => enter(event, false)}
    />
  )
}

function NumberAnswer({ question, text, disabled, onWrite, enter }: FieldProps & { readonly enter: Enter }) {
  const hintId = useId()
  const { min, max, step, unit } = question
  const value = numberAnswer(question, text)
  const invalid = text.trim().length > 0 && value === undefined
  const hint = numberHint(question)
  const typed = text.trim().length > 0 ? Number(text) : Number.NaN
  const ranged = min !== undefined && max !== undefined && min < max
  // Claude Code rarely sends a step; between whole bounds the slider moves by one, the box still takes any value.
  const slide = step ?? (ranged && Number.isInteger(min) && Number.isInteger(max) ? 1 : "any")
  return (
    <>
      <div className="question-number">
        <input
          className="question-other question-number-input"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step ?? "any"}
          disabled={disabled}
          value={text}
          aria-label={question.question}
          aria-invalid={invalid || undefined}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => onWrite(event.target.value)}
          onKeyDown={(event) => enter(event, false)}
        />
        {unit !== undefined && unit.length > 0 && <span className="question-unit">{unit}</span>}
        {ranged && (
          <input
            className={cx("question-range", value === undefined && "is-unset")}
            type="range"
            min={min}
            max={max}
            step={slide}
            disabled={disabled}
            value={Number.isFinite(typed) ? Math.min(max, Math.max(min, typed)) : min}
            aria-label={`${question.question} (slider)`}
            onChange={(event) => onWrite(event.target.value)}
          />
        )}
      </div>
      {hint !== undefined && (
        <span id={hintId} className={cx("question-hint", invalid && "is-invalid")}>
          {hint}
        </span>
      )}
    </>
  )
}
