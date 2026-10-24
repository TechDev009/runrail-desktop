import { expect, test } from "bun:test"
import { homebrewCask } from "../scripts/homebrew-cask"

const SUMS = [`${"a".repeat(64)}  Runrail_0.1.2_aarch64.dmg`, `${"b".repeat(64)} *Runrail_0.1.2_x64.dmg`, `${"c".repeat(64)}  Runrail_0.1.2_amd64.deb`].join("\n")

test("the cask names the release's DMG checksum for each Mac", () => {
  const cask = homebrewCask("0.1.2", SUMS)
  expect(cask).toContain('version "0.1.2"')
  expect(cask).toContain(`sha256 arm:   "${"a".repeat(64)}",\n         intel: "${"b".repeat(64)}"`)
  expect(cask).toContain('url "https://github.com/TechDev009/runrail-desktop/releases/download/v#{version}/Runrail_#{version}_#{arch}.dmg"')
  expect(cask).toContain('app "Runrail.app"')
})

test("a missing DMG or a prerelease gets no cask", () => {
  expect(() => homebrewCask("0.1.2", SUMS.replace("_x64.dmg", "_x86_64.dmg"))).toThrow("no Runrail_0.1.2_x64.dmg")
  expect(() => homebrewCask("0.2.0-beta.1", SUMS)).toThrow("prereleases get no cask")
})
