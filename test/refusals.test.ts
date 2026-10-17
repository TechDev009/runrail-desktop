import { afterEach, describe, expect, test } from "bun:test"
import { refusedLevels, rememberRefusal, resetRefusals } from "../src/app/refusals"

afterEach(() => resetRefusals())

describe("refused reasoning levels", () => {
  test("belong to one model on one connection, once each", () => {
    rememberRefusal("openai", "gpt-5.5", "high")
    rememberRefusal("openai", "gpt-5.5", "high")
    rememberRefusal("openai", "gpt-5.5", "minimal")
    expect(refusedLevels("openai", "gpt-5.5")).toEqual(["high", "minimal"])
    expect(refusedLevels("relay", "gpt-5.5")).toEqual([])
    expect(refusedLevels("openai", "gpt-5.5-mini")).toEqual([])
    expect(refusedLevels(undefined, "gpt-5.5")).toEqual([])
  })

  test("keep a bounded number of models, dropping the oldest", () => {
    for (let index = 0; index < 300; index += 1) rememberRefusal("relay", `model-${String(index)}`, "high")
    expect(refusedLevels("relay", "model-0")).toEqual([])
    expect(refusedLevels("relay", "model-299")).toEqual(["high"])
  })
})
