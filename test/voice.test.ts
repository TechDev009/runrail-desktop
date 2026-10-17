import { describe, expect, test } from "bun:test"
import { DEFAULT_PREFS } from "../src/app/persist"
import { wantsSystemNote } from "../src/app/notifications"
import { get, set } from "../src/app/store"
import { dictationError, spokenText, startListening, stopListening, useVoice } from "../src/app/voice"
import { setHost } from "../src/host"
import { createFakeHost } from "../src/host/fakeHost"

describe("voice", () => {
  test("an answer is read as prose: code is named, links read as their text, marks are dropped", () => {
    const answer = "## Done\n\nI changed **two** files, see [the diff](https://example.com/diff) and `src/app.ts`:\n\n```ts\nconst x = 1\n```\n\n- first\n- second\n\nMore at https://example.com."
    const spoken = spokenText(answer)
    expect(spoken).toContain("I changed two files, see the diff and src/app.ts")
    expect(spoken).toContain("(code)")
    expect(spoken).not.toContain("const x")
    expect(spoken).not.toContain("https://")
    expect(spoken).not.toMatch(/[#*`]/)
    expect(spoken).toContain("first\nsecond")
  })

  test("a very long answer stops at a sentence and says where the rest is", () => {
    const spoken = spokenText("This is one sentence. ".repeat(400))
    expect(spoken.length).toBeLessThan(4_100)
    expect(spoken.endsWith("sentence. The rest is in the thread.")).toBe(true)
  })

  test("recognition errors read as what to do; a stop or silence is not an error", () => {
    expect(dictationError("not-allowed")).toContain("Privacy & Security")
    expect(dictationError("service-not-allowed")).toContain("Dictation")
    expect(dictationError("aborted")).toBeUndefined()
    expect(dictationError("no-speech")).toBeUndefined()
    expect(dictationError("something-new")).toBe("Dictation stopped (something-new).")
  })

  test("dictation on the host fills the draft as words arrive, then hands it over", async () => {
    setHost(createFakeHost())
    set({ prefs: { ...DEFAULT_PREFS, voice: { ...DEFAULT_PREFS.voice, sounds: false } }, drafts: { "new:p1": "Please" } })
    const done = new Promise<boolean>((resolve) => startListening({ key: "new:p1", untilSilence: true, onDone: resolve }))
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(useVoice.getState().listening).toBe("new:p1")
    expect(get().drafts["new:p1"]).toStartWith("Please Add")
    expect(await done).toBe(true)
    expect(get().drafts["new:p1"]).toBe("Please Add a test for the empty cart and run it")
    expect(useVoice.getState()).toMatchObject({ listening: undefined, transcribing: false, level: 0 })
  }, 10_000)

  test("Whisper without a downloaded model says so, and the draft is untouched", async () => {
    setHost(createFakeHost())
    set({ prefs: { ...DEFAULT_PREFS, voice: { ...DEFAULT_PREFS.voice, engine: "whisper", model: "small", sounds: false } }, drafts: { "new:p1": "keep me" } })
    const failed = new Promise<string>((resolve) => startListening({ key: "new:p1", untilSilence: false, onError: resolve }))
    expect(await failed).toContain("download the Whisper model")
    expect(get().drafts["new:p1"]).toBe("keep me")
    expect(useVoice.getState().listening).toBeUndefined()
    stopListening()
  })

  test("Linux asks the host for Whisper even with Apple's recognizer chosen", async () => {
    const host = createFakeHost()
    const asked: string[] = []
    const voiceStart = host.voiceStart.bind(host)
    host.voiceStart = (input) => {
      asked.push(input.engine)
      return voiceStart(input)
    }
    setHost(host)
    const platform = get().platform
    set({ platform: "linux", prefs: { ...DEFAULT_PREFS, voice: { ...DEFAULT_PREFS.voice, engine: "apple", model: "small", sounds: false } } })
    const failed = new Promise<string>((resolve) => startListening({ key: "new:p1", untilSilence: false, onError: resolve }))
    expect(await failed).toContain("download the Whisper model")
    expect(asked).toEqual(["whisper"])
    set({ platform })
    stopListening()
  })
})

describe("macOS notifications", () => {
  test("posted in the background by default, always or never by choice, and only for chosen events", () => {
    expect(wantsSystemNote(DEFAULT_PREFS, "finished", false)).toBe(true)
    expect(wantsSystemNote(DEFAULT_PREFS, "finished", true)).toBe(false)
    expect(wantsSystemNote({ ...DEFAULT_PREFS, systemNotifications: "always" }, "approval", true)).toBe(true)
    expect(wantsSystemNote({ ...DEFAULT_PREFS, systemNotifications: "off" }, "failed", false)).toBe(false)
    expect(wantsSystemNote({ ...DEFAULT_PREFS, notifyOn: { ...DEFAULT_PREFS.notifyOn, approvals: false } }, "approval", false)).toBe(false)
  })
})
