import { readFile } from "node:fs/promises"

/**
 * The Homebrew cask for one release's DMGs, from its SHA256SUMS.txt:
 *
 *   bun scripts/homebrew-cask.ts <version> <SHA256SUMS.txt>
 *
 * publish.yml writes it to Casks/runrail.rb in the TechDev009/homebrew-runrail tap, beside the
 * engine's command-line formula.
 */

/** The DMG checksums for Apple silicon and Intel, read from a `sha256sum` listing. */
export function dmgChecksums(version: string, sums: string): { readonly arm: string; readonly intel: string } {
  const listed = new Map<string, string>()
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) listed.set(match[2], match[1])
  }
  const find = (arch: string): string => {
    const sum = listed.get(`Runrail_${version}_${arch}.dmg`)
    if (sum === undefined) throw new Error(`SHA256SUMS.txt has no Runrail_${version}_${arch}.dmg`)
    return sum
  }
  return { arm: find("aarch64"), intel: find("x64") }
}

export function homebrewCask(version: string, sums: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${version} is not a release version; prereleases get no cask`)
  const sha = dmgChecksums(version, sums)
  return `# Written by Runrail Desktop's publish workflow for each release; edits here are replaced.
cask "runrail" do
  arch arm: "aarch64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha.arm}",
         intel: "${sha.intel}"

  url "https://github.com/TechDev009/runrail-desktop/releases/download/v#{version}/Runrail_#{version}_#{arch}.dmg"
  name "Runrail"
  desc "Desktop app for supervised local coding agents"
  homepage "https://github.com/TechDev009/runrail-desktop"

  # The app updates itself from signed GitHub releases, when you ask it to.
  auto_updates true
  depends_on macos: :ventura

  app "Runrail.app"

  uninstall launchctl: "com.runrail.desktop.wake"

  zap trash: [
    "~/Library/Application Support/com.runrail.desktop",
    "~/Library/Caches/com.runrail.desktop",
    "~/Library/Preferences/com.runrail.desktop.plist",
    "~/Library/Saved Application State/com.runrail.desktop.savedState",
    "~/Library/WebKit/com.runrail.desktop",
  ]
end
`
}

if (import.meta.main) {
  const [version, sumsPath] = process.argv.slice(2)
  if (version === undefined || sumsPath === undefined) throw new Error("usage: bun scripts/homebrew-cask.ts <version> <SHA256SUMS.txt>")
  process.stdout.write(homebrewCask(version, await readFile(sumsPath, "utf8")))
}
