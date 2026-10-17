import { AudioLines, Mic, Square, Volume2 } from "lucide-react"
import { useCallback, useEffect, useRef, type CSSProperties } from "react"
import { paneFocused, toast, useApp } from "../../app/store"
import { dictationAvailable, hostListens, readAloudAvailable, speak, startListening, startTalking, stopListening, stopSpeaking, stopTalking, useVoice } from "../../app/voice"
import { cx, IconButton, Spinner } from "../common"

/** Only one composer answers the dictation shortcut each time it is pressed. */
let consumedDictate = 0

/** Whether this composer can offer talk mode: dictation on, and a voice to read answers with. */
export function useTalkAvailable(threadId: string | undefined): boolean {
  const enabled = useApp((state) => state.prefs.voice.dictation)
  return threadId !== undefined && enabled && dictationAvailable() && readAloudAvailable()
}

/**
 * The composer's microphone. It also runs talk mode in a thread: listen until you stop talking,
 * send, hear the answer, listen again. Talk mode ends when the thread is left.
 */
export function MicButton({ draftKey, threadId, busy, onSend, onFocus }: { readonly draftKey: string; readonly threadId?: string; readonly busy: boolean; readonly onSend: () => void; readonly onFocus: () => void }) {
  const enabled = useApp((state) => state.prefs.voice.dictation)
  const autoSend = useApp((state) => state.prefs.voice.autoSend)
  const signal = useApp((state) => state.dictateSignal)
  const listening = useVoice((state) => state.listening === draftKey)
  const talking = useVoice((state) => threadId !== undefined && state.talking === threadId)
  const speaking = useVoice((state) => state.speaking !== undefined)
  const level = useVoice((state) => (state.listening === draftKey ? state.level : 0))
  const transcribing = useVoice((state) => state.listening === draftKey && state.transcribing)
  const handlers = useRef({ onSend, onFocus })
  handlers.current = { onSend, onFocus }

  const listen = useCallback(
    (untilSilence: boolean, send: boolean): boolean =>
      startListening({
        key: draftKey,
        untilSilence,
        onDone: (heard) => {
          if (heard && send) handlers.current.onSend()
          else handlers.current.onFocus()
        },
        onError: (message) => {
          toast("error", message)
          stopTalking()
        },
      }),
    [draftKey],
  )

  const toggle = useCallback(() => {
    if (useVoice.getState().listening === draftKey) stopListening()
    else if (!listen(autoSend, autoSend)) toast("error", "Dictation is not available here.")
  }, [draftKey, autoSend, listen])

  useEffect(() => {
    if (signal <= consumedDictate || !paneFocused(threadId)) return
    consumedDictate = signal
    if (enabled) toggle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal])

  useEffect(() => {
    if (!talking || busy || listening || speaking) return
    const timer = setTimeout(() => listen(true, true), 300)
    return () => clearTimeout(timer)
  }, [talking, busy, listening, speaking, listen])

  useEffect(
    () => () => {
      const voice = useVoice.getState()
      if (threadId !== undefined && voice.talking === threadId) stopTalking()
      else if (voice.listening === draftKey) stopListening()
    },
    [threadId, draftKey],
  )

  if (!enabled || !dictationAvailable()) return null
  return (
    <IconButton
      label={transcribing ? "Turning speech into text" : listening ? "Stop dictation" : "Dictate"}
      kbd="mod+shift+m"
      className={cx("voice-button", listening && "is-listening", hostListens() && "has-level")}
      style={{ "--level": String(level) } as CSSProperties}
      active={listening}
      disabled={transcribing}
      onClick={toggle}
    >
      {transcribing ? <Spinner size={12} /> : <Mic size={15} />}
    </IconButton>
  )
}

/**
 * Talk mode in the send button's place, while there is nothing to send. Once on, it shows how loud
 * the voice is, or that the answer is being read, and ends talk mode when pressed.
 */
export function TalkButton({ threadId, draftKey }: { readonly threadId: string; readonly draftKey: string }) {
  const talking = useVoice((state) => state.talking === threadId)
  const listening = useVoice((state) => state.listening === draftKey)
  const speaking = useVoice((state) => state.speaking !== undefined)
  const level = useVoice((state) => (state.listening === draftKey ? state.level : 0))
  if (!talking)
    return (
      <IconButton label="Talk: speak, hear the answer, speak again" className="send-button is-talk" onClick={() => startTalking(threadId)}>
        <AudioLines size={15} />
      </IconButton>
    )
  return (
    <button
      type="button"
      className={cx("talk-live", listening && "is-listening", speaking && "is-speaking")}
      style={{ "--level": String(level) } as CSSProperties}
      onClick={() => stopTalking()}
      aria-label="End talk mode"
      title={speaking ? "Reading the answer. Press to end talk mode" : listening ? "Listening. Press to end talk mode" : "Talk mode. Press to end it"}
    >
      <span className="talk-bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span>End</span>
    </button>
  )
}

/** Reads one answer out, or stops it. */
export function ReadAloudButton({ text, itemKey }: { readonly text: string; readonly itemKey: string }) {
  const playing = useVoice((state) => state.speaking === itemKey)
  if (!readAloudAvailable()) return null
  return (
    <IconButton label={playing ? "Stop reading" : "Read aloud"} size="sm" onClick={() => (playing ? stopSpeaking() : speak(text, itemKey))}>
      {playing ? <Square size={11} fill="currentColor" /> : <Volume2 size={13} />}
    </IconButton>
  )
}
