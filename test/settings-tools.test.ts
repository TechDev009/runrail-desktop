import { expect, test } from "bun:test"
import { listedTool } from "../src/ui/shell/Settings"

test("coding tools on this computer leave out the engine's own loop, the replay player, and the generic PTY adapter", () => {
  expect(["native", "replay", "pty", "claude-code", "codex", "copilot", "pi", "aider", "gemini", "goose", "opencode"].filter(listedTool)).toEqual(["claude-code", "codex", "copilot", "pi", "aider", "gemini", "goose", "opencode"])
})
