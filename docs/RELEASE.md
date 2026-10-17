# Releases and updates

Releases are built by CI and published from GitHub. A version tag runs
[build.yml](../.github/workflows/build.yml): every platform is built and
signed, and the bundles, the update feed (`latest.json`), and checksums are
collected into a **draft** GitHub release. A draft is visible only to the
repository's collaborators, notifies nobody, and serves no updates; a
maintainer checks it and publishes it by hand.

Installed apps read the feed from the latest *published* release
(`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`), at
launch and every six hours, and install an update only when the user clicks
**Install and restart**. Drafts and prereleases are never offered. Development
builds (`bun run tauri dev`, plain `tauri build`) have no updater, and
Settings says so.

## One-time setup

1. **Generate the updater key** on your own machine, from this repository so the
   project's Tauri CLI runs (`bunx tauri` elsewhere fetches the unrelated Tauri
   0.x package). It asks for a password; choose a strong one.

   ```bash
   bun run tauri signer generate -w ~/.tauri/runrail-updater.key
   ```

   Keep the private key file and its password in a password manager or
   another secret store, and back them up. Every installed copy checks
   updates against the public key built into it: if the private key is lost,
   those copies can never update again, and users must reinstall by hand.

2. **Give CI the key.** The public key is a repository variable (it is
   public), and the private key and its password are secrets:

   ```bash
   gh variable set RUNRAIL_UPDATER_PUBKEY --repo TechDev009/runrail-desktop < ~/.tauri/runrail-updater.key.pub
   ```

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo TechDev009/runrail-desktop < ~/.tauri/runrail-updater.key
   ```

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo TechDev009/runrail-desktop
   ```

   With the variable set, every build outside pull requests compiles in the
   updater and signs its update bundles, and a release tag fails early
   without it. `RUNRAIL_UPDATE_URL`, also a variable, overrides the feed
   address if updates are ever hosted elsewhere.

3. **Optional: a Developer ID for macOS.** Without one, CI signs the macOS
   app ad hoc, and Gatekeeper asks users to approve it once (the README's
   Install section says how). With a paid Apple Developer Program membership,
   add these secrets and CI signs with the Developer ID and notarizes,
   never on pull requests:

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | the Developer ID Application certificate and key, exported as `.p12`, base64 |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
   | `APPLE_API_KEY` | the App Store Connect API key id |
   | `APPLE_API_ISSUER` | its issuer id |
   | `APPLE_API_PRIVATE_KEY` | the key's `.p8` file contents |

   The job imports the certificate into a temporary keychain, deletes it at
   the end, and fails if the certificate is set without the API key or holds
   no Developer ID Application identity.

4. **Turn on private vulnerability reporting** in each repository's
   Settings, Security, so the links in SECURITY.md work.

## Release on GitHub

1. Move the `## [Unreleased]` notes into a `## [<version>] - <date>` section
   of `CHANGELOG.md` in both repositories, and set the version in the
   engine's `package.json` and the desktop's `package.json`,
   `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. The changelog
   section becomes the release notes.
2. Tag the engine first, since the desktop build checks out the engine's tag
   of the same name. Its CI drafts a release with the packed CLI
   (`runrail-<version>.tgz`, installable with `bun add -g <its URL>`):

   ```bash
   git -C ../runrail tag -a v0.1.0 -m "Runrail 0.1.0"
   ```

   ```bash
   git -C ../runrail push origin v0.1.0
   ```

3. Tag the desktop. The workflow stops before building if the tag does not
   match all three versions, the changelog has no section for it, or the
   updater variable is missing:

   ```bash
   git tag -a v0.1.0 -m "Runrail Desktop 0.1.0"
   ```

   ```bash
   git push origin v0.1.0
   ```

4. When every build passes, the draft holds the `.dmg`, `.deb`, `.rpm`,
   `.AppImage`, `.exe`, and `.msi` installers, the macOS update archives
   (`.app.tar.gz`), `latest.json`, and `SHA256SUMS.txt`. A tag with a hyphen
   (`v0.2.0-beta.1`) is marked a prerelease. Running the workflow again for
   the tag replaces the draft's files; it never changes a published release.
5. Install the draft's downloads on a clean machine (a Mac that never built
   the app, a Linux VM), then publish the engine's draft and the desktop's
   draft. Publishing the desktop release is what offers the update to
   installed copies.

The `.sig` files are not attached: `latest.json` carries each bundle's
signature, which names the version it was signed for, and the app is built
with `requireSignedVersion`, so a feed cannot pair a new version number with
an older archive.

## Build on your own machine

CI is the usual path. To build a signed release locally instead, on macOS:

```bash
export RUNRAIL_UPDATER_PUBKEY="$(cat ~/.tauri/runrail-updater.key.pub)"
export RUNRAIL_UPDATE_URL="https://github.com/TechDev009/runrail-desktop/releases/latest/download/latest.json"
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/runrail-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Team> (<TEAMID>)"
export RUNRAIL_NOTARY_PROFILE="runrail"
bun run release:mac --target aarch64-apple-darwin
```

`scripts/release.ts mac` (`release:mac`):

1. Builds the `.app` with `tauri build`, giving it none of the signing or
   notarizing variables, so Tauri neither signs nor notarizes. The updater
   feature and endpoint are compiled in only when `RUNRAIL_UPDATER_PUBKEY` is
   set (with `RUNRAIL_UPDATE_URL`, an https URL).
2. Fails if the bundle holds any code other than the app binary and the
   engine, since notarization rejects unsigned code.
3. Signs, inside out, with the hardened runtime (and, with a Developer ID, a
   secure timestamp): the engine (`Contents/MacOS/runrail`) as
   `com.runrail.desktop.engine` with
   [Engine.entitlements.plist](../src-tauri/Engine.entitlements.plist)
   (`allow-jit` only), then the bundle, and with it the app binary, with
   [Entitlements.plist](../src-tauri/Entitlements.plist) (the microphone
   only). The Tauri bundler would give every binary one entitlements file,
   and only the engine should JIT.
4. Verifies the bundle (`codesign --verify --strict --deep`), checks that each
   binary carries exactly its file's entitlements and the hardened runtime,
   and starts the engine once (`--version`) when it is built for this Mac.
5. With a Developer ID: notarizes the app, staples it, and checks it with
   `spctl`.
6. Makes `bundle/dmg/Runrail_<version>_<arch>.dmg` from the stapled app;
   with a Developer ID, signs, notarizes, staples, and checks it.
7. With the updater on, archives the stapled app as
   `bundle/macos/Runrail_<version>_<arch>.app.tar.gz` and signs it with
   `tauri signer sign --app-version`, which reads the private key from the
   environment.

`--identity -` signs ad hoc and skips steps 5 and the DMG's signature: what CI
does, and a way to try the signing on a Mac without an Apple account. The
identity, the API key's id, issuer, and path, and the profile name are the only
credentials the script handles; codesign, notarytool, and the Tauri CLI read
the secrets themselves.

Linux: `bun run release:config`, then `bun scripts/linux.ts release`
([LINUX.md](LINUX.md)).

Refresh the bundled engine first, and build each architecture you ship
(`--target aarch64-apple-darwin`, `--target x86_64-apple-darwin`). The engine
does not contain the Claude Agent SDK, whose licence reserves all rights: it
pins the version and SHA-512 from `bun.lock`, and downloads that package from
npm into the app's data folder only when the person allows it: Claude Code's
first message asks, and Settings, Agent has an Install button
(`sidecar/agentSdk.ts`, the engine's `claude.sdk.install`). A launch alone
downloads nothing. Bump the SDK with `bun install` before
building to ship a newer pin:

```bash
bun run sidecar --target aarch64-apple-darwin
```

```bash
bun run sidecar --target x86_64-apple-darwin
```

## Host the feed yourself

GitHub releases host the feed for CI builds. For builds made on your own
machine, with `RUNRAIL_UPDATE_URL` pointing at your own server:

```bash
export RUNRAIL_DOWNLOAD_BASE="https://downloads.example.com/runrail"
export RUNRAIL_RELEASE_NOTES="Short, user-facing notes."
bun run release:manifest
```

This writes `release/latest.json` with the version from `tauri.conf.json`,
the notes, and one entry per built platform: the bundle URL
`<base>/<version>/<platform>/<Runrail_<version>_<arch>.app.tar.gz>` and its detached
signature. Upload the archives to those URLs, then the feed to the
`RUNRAIL_UPDATE_URL` location. Upload the feed last, so no client sees a
version whose bundles are not there yet.

## What the app does

- The host checks the feed only through two commands, `update_check` and
  `update_install`. The renderer gets no updater plugin API and no URL or
  key control.
- A check downloads only the feed. The renderer parses the answer with a
  bounded schema; release notes are cut at 4,000 characters.
- An install downloads the archive, verifies it against the public key
  compiled into the build, installs it, and restarts. A bundle that does not
  verify is rejected and reported as a failed install.
- On restart the normal exit path stops the engines. Thread history is on
  disk and comes back after the update.

## Not verified here

- No release has run on GitHub yet: the workflows were linted, and the
  release jobs ran in an Ubuntu container against a stand-in `gh`.
- Notarization and Gatekeeper acceptance need a real Developer ID and a
  clean machine; steps 5 and 6 have never run.
- An update was installed end to end on macOS (Apple silicon, ad hoc): a
  0.1.0 build with the updater found 0.1.1 on a local feed, verified the
  archive `release.ts` makes, replaced itself, and restarted as 0.1.1 with
  both binaries' entitlements intact. An archive signed without its version
  was refused (`requireSignedVersion`). The AppImage update was run the same
  way on Linux in a container. Updates of the deb, rpm, and Windows
  installers have never run.
- The entitlement split was checked with ad hoc signing on Apple silicon. A
  Bun hot loop signed with the hardened runtime took 1,081 ms with
  `Engine.entitlements.plist` and 9,000 ms with the app's file, where Bun falls
  back to its interpreter. The signed app started, loaded its threads, and ran
  its engines, which `codesign` shows with `allow-jit` while the app binary
  has only `audio-input`. The update archive kept a valid signature through a
  tar round trip, and its `.sig` verified against the key. The microphone
  prompt was not exercised.
- Windows and Linux packages are not code-signed; their updates are
  signed with the updater key like every other platform's.
