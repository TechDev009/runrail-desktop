import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { searchSettings, SECTION_LABELS, SETTINGS_INDEX } from "../src/ui/shell/settingsIndex"

// Sections drawn in their own files count as the page too.
const source = ["Settings.tsx", "McpSettings.tsx", "SubagentSettings.tsx", "ImportSettings.tsx", "ProjectGit.tsx", "ComputerSettings.tsx", "RemoteMachines.tsx", "PhoneAccess.tsx", "QuickChat.tsx", "../connections/ImageModelSection.tsx"].map((file) => readFileSync(resolve(import.meta.dir, "../src/ui/shell", file), "utf8")).join("\n")

describe("settings search", () => {
  test("every indexed setting is a row the page draws, so a result always has somewhere to land", () => {
    const missing = SETTINGS_INDEX.filter((entry) => !source.includes(`id="${entry.id}"`) && !source.includes(`data-setting="${entry.id}"`)).map((entry) => entry.id)
    expect(missing).toEqual([])
    expect(new Set(SETTINGS_INDEX.map((entry) => entry.id)).size).toBe(SETTINGS_INDEX.length)
  })

  test("finds a row by its label, by a word people use for it, and by its section", () => {
    expect(searchSettings("theme")[0]?.id).toBe("theme")
    expect(searchSettings("font")[0]?.id).toBe("ui-font")
    expect(searchSettings("font").map((entry) => entry.id)).toContain("text-size")
    expect(searchSettings("zsh")[0]?.id).toBe("terminal-shell")
    expect(searchSettings("caffeinate")[0]?.id).toBe("keep-awake")
    expect(searchSettings("api key").map((entry) => entry.id)).toContain("connections")
    expect(searchSettings("permissions").map((entry) => entry.id)).toContain("default-permissions")
  })

  test("git words land on Projects, where each project's git host is; there is no Git hosts page", () => {
    for (const word of ["github", "gitlab", "bitbucket", "remote origin", "git host", "gh cli"]) expect(searchSettings(word)[0]?.id).toBe("project-git")
    // A remote on its own is also a machine a project lives on.
    expect(searchSettings("remote machine")[0]?.id).toBe("remote-machines")
    expect(Object.keys(SECTION_LABELS)).not.toContain("githosts")
  })

  test("a label match ranks above a keyword match, and nothing typed finds nothing", () => {
    const results = searchSettings("reasoning").map((entry) => entry.id)
    expect(results.slice(0, 2).sort()).toEqual(["show-reasoning", "start-on"])
    expect(searchSettings("   ")).toEqual([])
    expect(searchSettings("zzz-not-a-setting")).toEqual([])
  })

  test("show plan limits is found by its own words and takes no other row's search", () => {
    for (const words of ["plan limits", "limits", "agent sdk", "npm", "quota rings"]) expect(searchSettings(words)[0]?.id).toBe("plan-limits")
    expect(searchSettings("usage limit")[0]?.id).toBe("continue-after-limit")
    const label = "show plan limits"
    for (const entry of SETTINGS_INDEX.filter((item) => item.id !== "plan-limits")) {
      expect(searchSettings(entry.label)[0]?.id).not.toBe("plan-limits")
      // A word in its own label may rank it first; a keyword may not.
      const words = `${entry.label} ${entry.keywords ?? ""}`.toLowerCase().split(/\s+/).filter((word) => word.length > 0 && !label.includes(word))
      expect(words.filter((word) => searchSettings(word)[0]?.id === "plan-limits")).toEqual([])
    }
  })
})
