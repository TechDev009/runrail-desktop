/**
 * Short tones made on the spot with Web Audio, so no sound files ship with the app. WebKit keeps
 * audio suspended until the person interacts with the page, so the first key or click wakes it.
 */

export type Tone = "done" | "attention" | "raise" | "listen" | "stop"

const NOTES: Readonly<Record<Tone, readonly number[]>> = {
  done: [660, 880],
  attention: [880, 660, 880],
  // A thread raising its hand: three rising notes, unlike any other tone.
  raise: [587, 784, 1175],
  listen: [520, 780],
  stop: [780, 520],
}

/** Settings' volume when nothing says otherwise; at this level a tone peaks where it always has. */
export const DEFAULT_TONE_VOLUME = 0.6
const PEAK_GAIN = 0.2

let context: AudioContext | undefined

function audio(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined
  context ??= new AudioContext()
  if (context.state === "suspended") void context.resume().catch(() => undefined)
  return context
}

export function unlockTones(): void {
  if (typeof window === "undefined") return
  const wake = (): void => {
    audio()
    window.removeEventListener("pointerdown", wake)
    window.removeEventListener("keydown", wake)
  }
  window.addEventListener("pointerdown", wake)
  window.addEventListener("keydown", wake)
}

export function playTone(tone: Tone, volume = DEFAULT_TONE_VOLUME): void {
  const peak = PEAK_GAIN * Math.min(1, Math.max(0, volume))
  if (peak <= 0) return
  const ctx = audio()
  if (ctx === undefined) return
  const start = ctx.currentTime
  NOTES[tone].forEach((frequency, index) => {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = "sine"
    oscillator.frequency.value = frequency
    const at = start + index * 0.09
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.18)
  })
}
