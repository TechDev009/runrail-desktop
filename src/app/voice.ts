import { create } from "zustand"
import { getHost, toHostError, type VoiceEvent } from "../host"
import { playTone } from "../lib/tones"
import type { VoicePrefs } from "./persist"
import { get, set, threadOnScreen } from "./store"

/**
 * Voice: dictation into the composer, answers read out with the system's voices, and talk mode,
 * which goes round the two: listen, send, read the answer, listen. On the Mac the host listens
 * (the chosen microphone, to Apple's recognizer or to Whisper on this Mac); elsewhere WebKit's
 * `webkitSpeechRecognition` does. Nothing here records or keeps audio; the text lands in the
 * composer like typing.
 */

interface RecognitionAlternative {
  readonly transcript: string
}
interface RecognitionResult {
  readonly isFinal: boolean
  readonly 0: RecognitionAlternative
}
interface RecognitionEvent {
  readonly resultIndex: number
  readonly results: ArrayLike<RecognitionResult>
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { readonly error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionClass = new () => Recognition

function recognitionClass(): RecognitionClass | undefined {
  const scope = globalThis as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/** The host listens itself: the Mac and Linux apps, and the preview's stand-in. */
export function hostListens(): boolean {
  const kind = getHost().kind
  const platform = get().platform
  return kind === "preview" || (kind === "tauri" && (platform === "macos" || platform === "linux"))
}

/** Apple's recognizer is macOS's own; Linux listens with Whisper only. */
export function voiceEngine(engine: VoicePrefs["engine"], platform: string | undefined = get().platform): VoicePrefs["engine"] {
  return platform === "linux" ? "whisper" : engine
}

export function dictationAvailable(): boolean {
  return hostListens() || recognitionClass() !== undefined
}

export function readAloudAvailable(): boolean {
  return typeof speechSynthesis !== "undefined"
}

export interface VoiceState {
  /** The composer draft being dictated into. */
  readonly listening?: string
  /** Words heard but not settled yet. */
  readonly interim: string
  /** The microphone's loudness, 0 to 1, while the host listens. */
  readonly level: number
  /** Listening ended and the recognizer is turning it into text. */
  readonly transcribing: boolean
  /** The message being read out. */
  readonly speaking?: string
  /** Thread in talk mode. */
  readonly talking?: string
}

export const useVoice = create<VoiceState>(() => ({ interim: "", level: 0, transcribing: false }))

/** Settling time after the last word before dictation ends by itself. */
const SILENCE_MS = 1_800

const ERRORS: Readonly<Record<string, string>> = {
  "not-allowed": "Runrail may not use the microphone or speech recognition. Allow both in System Settings > Privacy & Security.",
  "service-not-allowed": "Speech recognition is unavailable. Turn on Dictation in System Settings > Keyboard.",
  "audio-capture": "No microphone was found. Pick an input in System Settings > Sound.",
  network: "Speech recognition could not reach Apple's servers.",
  "language-not-supported": "The system cannot recognize speech in this language.",
}

export function dictationError(code: string): string | undefined {
  if (code === "aborted" || code === "no-speech") return undefined
  return ERRORS[code] ?? `Dictation stopped (${code.slice(0, 40)}).`
}

let active: { readonly recognition: Recognition; readonly key: string; timer?: ReturnType<typeof setTimeout> } | undefined

export interface ListenOptions {
  /** The composer draft the words go into. */
  readonly key: string
  /** Ends by itself once speech stops, then hands over the draft. */
  readonly untilSilence: boolean
  readonly onDone?: (heard: boolean) => void
  readonly onError?: (message: string) => void
}

interface HostRun {
  readonly options: ListenOptions
  /** The draft before listening, put back when nothing was heard. */
  readonly original: string
  readonly base: string
  session?: number
  stopWhenStarted?: boolean
  text: string
  failed: boolean
}

let hostRun: HostRun | undefined
let hostEvents: (() => void) | undefined

function writeDraft(key: string, text: string): void {
  set((state) => ({ drafts: { ...state.drafts, [key]: text } }))
}

function baseOf(key: string): string {
  const draft = get().drafts[key] ?? ""
  return draft.length === 0 || /\s$/.test(draft) ? draft : `${draft} `
}

function onHostEvent(event: VoiceEvent): void {
  const run = hostRun
  if (run === undefined) return
  // Events can come before `voiceStart` answers with the session id.
  run.session ??= event.session
  if (run.session !== event.session) return
  const key = run.options.key
  switch (event.kind) {
    case "level":
      useVoice.setState({ level: event.level })
      return
    case "partial":
      writeDraft(key, run.base + event.text.trim())
      return
    case "transcribing":
      useVoice.setState({ transcribing: true, level: 0 })
      return
    case "final":
      run.text = event.text.trim()
      writeDraft(key, run.base + run.text)
      return
    case "error":
      run.failed = true
      run.options.onError?.(event.message)
      return
    case "ended":
      hostRun = undefined
      if (run.text.length === 0) writeDraft(key, run.original)
      useVoice.setState((state) => (state.listening === key ? { listening: undefined, interim: "", level: 0, transcribing: false } : state))
      if (get().prefs.voice.sounds) playTone("stop")
      run.options.onDone?.(run.text.length > 0 && !run.failed)
  }
}

function startOnHost(options: ListenOptions): boolean {
  stopListening()
  stopSpeaking()
  const voice = get().prefs.voice
  hostEvents ??= getHost().onVoice(onHostEvent)
  const run: HostRun = { options, original: get().drafts[options.key] ?? "", base: baseOf(options.key), text: "", failed: false }
  hostRun = run
  useVoice.setState({ listening: options.key, interim: "", level: 0, transcribing: false })
  getHost()
    .voiceStart({
      engine: voiceEngine(voice.engine),
      ...(voice.device === undefined ? {} : { device: voice.device }),
      language: voice.language ?? navigator.language,
      onDevice: voice.onDevice,
      ...(voice.model === undefined ? {} : { model: voice.model }),
      words: voice.words,
      untilSilence: options.untilSilence,
    })
    .then((session) => {
      if (hostRun !== run) {
        void getHost().voiceCancel(session)
        return
      }
      run.session = session
      if (voice.sounds) playTone("listen")
      if (run.stopWhenStarted === true) void getHost().voiceStop(session)
    })
    .catch((error: unknown) => {
      if (hostRun !== run) return
      hostRun = undefined
      useVoice.setState({ listening: undefined, level: 0, transcribing: false })
      options.onError?.(toHostError(error).message)
    })
  return true
}

export function startListening(options: ListenOptions): boolean {
  if (hostListens()) return startOnHost(options)
  const Recognition = recognitionClass()
  if (Recognition === undefined) return false
  stopListening()
  stopSpeaking()
  const voice = get().prefs.voice
  const recognition = new Recognition()
  recognition.lang = voice.language ?? navigator.language
  recognition.continuous = true
  recognition.interimResults = true
  const base = baseOf(options.key)
  let settled = ""
  const write = (text: string): void => writeDraft(options.key, text)
  const session: NonNullable<typeof active> = { recognition, key: options.key }
  recognition.onresult = (event) => {
    let interim = ""
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index]
      if (result === undefined) continue
      if (result.isFinal) settled = joinWords(settled, result[0].transcript)
      else interim = joinWords(interim, result[0].transcript)
    }
    write(base + joinWords(settled, interim))
    useVoice.setState({ interim })
    if (options.untilSilence) {
      if (session.timer !== undefined) clearTimeout(session.timer)
      session.timer = setTimeout(() => recognition.stop(), SILENCE_MS)
    }
  }
  recognition.onerror = (event) => {
    const message = dictationError(event.error)
    if (message !== undefined) options.onError?.(message)
  }
  recognition.onend = () => {
    if (session.timer !== undefined) clearTimeout(session.timer)
    if (active === session) active = undefined
    write(base + settled)
    useVoice.setState((state) => (state.listening === options.key ? { listening: undefined, interim: "" } : state))
    if (voice.sounds) playTone("stop")
    options.onDone?.(settled.trim().length > 0)
  }
  try {
    recognition.start()
  } catch {
    return false
  }
  active = session
  useVoice.setState({ listening: options.key, interim: "" })
  if (voice.sounds) playTone("listen")
  return true
}

/** Ends dictation, keeping what was heard. */
export function stopListening(): void {
  const run = hostRun
  if (run !== undefined) {
    if (run.session === undefined) run.stopWhenStarted = true
    else void getHost().voiceStop(run.session)
  }
  active?.recognition.stop()
}

function joinWords(left: string, right: string): string {
  const next = right.trim()
  if (next.length === 0) return left
  return left.length === 0 ? next : `${left} ${next}`
}

// ---------------------------------------------------------------------------------------------
// Reading out

/** Longer answers are read up to here, at a sentence end where one is near. */
const MAX_SPOKEN = 4_000

/** Markdown as it sounds: code is named rather than read, links read as their text. */
export function spokenText(markdown: string): string {
  const text = markdown
    .replace(/```[^\n]*\n[\s\S]*?(```|$)/g, " (code) ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~\n]+?)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
  if (text.length <= MAX_SPOKEN) return text
  const cut = text.slice(0, MAX_SPOKEN)
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"))
  return `${end > MAX_SPOKEN / 2 ? cut.slice(0, end + 1) : cut} The rest is in the thread.`
}

export interface SystemVoice {
  readonly id: string
  readonly name: string
  readonly lang: string
}

export function systemVoices(): readonly SystemVoice[] {
  if (!readAloudAvailable()) return []
  // WebKit lists some system voices twice; the id is what a choice is saved as, so one entry each.
  return [...new Map(speechSynthesis.getVoices().map((voice) => [voice.voiceURI, { id: voice.voiceURI, name: voice.name, lang: voice.lang }])).values()]
}

/** Reads `markdown` out; `key` names it so its button can show it playing. */
export function speak(markdown: string, key: string, onEnd?: () => void): void {
  if (!readAloudAvailable()) return
  stopSpeaking()
  const text = spokenText(markdown)
  if (text.length === 0) return
  const voice = get().prefs.voice
  const utterance = new SpeechSynthesisUtterance(text)
  const chosen = voice.voiceId === undefined ? undefined : speechSynthesis.getVoices().find((item) => item.voiceURI === voice.voiceId)
  if (chosen !== undefined) utterance.voice = chosen
  utterance.lang = chosen?.lang ?? voice.language ?? navigator.language
  utterance.rate = voice.rate
  const finish = (): void => {
    useVoice.setState((state) => (state.speaking === key ? { speaking: undefined } : state))
    onEnd?.()
  }
  utterance.onend = finish
  utterance.onerror = finish
  useVoice.setState({ speaking: key })
  speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (!readAloudAvailable()) return
  if (useVoice.getState().speaking !== undefined) useVoice.setState({ speaking: undefined })
  speechSynthesis.cancel()
}

// ---------------------------------------------------------------------------------------------
// Talk mode

export function startTalking(threadId: string): void {
  useVoice.setState({ talking: threadId })
}

export function stopTalking(): void {
  if (useVoice.getState().talking === undefined) return
  useVoice.setState({ talking: undefined })
  stopListening()
  stopSpeaking()
}

/** A turn ended: its answer is read out in talk mode, or when Settings reads every answer in the thread on screen. */
export function readAnswer(threadId: string, text: string | undefined, key: string): boolean {
  const state = get()
  const talking = useVoice.getState().talking === threadId
  if (text === undefined || (!talking && !(state.prefs.voice.readAloud && threadOnScreen(state) === threadId))) return false
  speak(text, key)
  return true
}
