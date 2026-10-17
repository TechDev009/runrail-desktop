# Contributing to Runrail Desktop

Thanks for helping improve Runrail Desktop. The app is a Tauri 2 host with a
React renderer, driving a local [Runrail](https://github.com/TechDev009/runrail)
engine. Changes should keep its boundaries clear and its checks reproducible.

## Development setup

You need [Bun](https://bun.sh) 1.3 or newer, Rust, and a Runrail checkout beside
this one (or `RUNRAIL_DIR` pointing at it). On macOS, local dictation also needs
`cmake` and Xcode's command line tools; Linux needs the packages in
[docs/LINUX.md](docs/LINUX.md).

```sh
bun install
bun run dev
```

`bun run dev` runs the UI in a browser against a scripted preview engine, which
is the quickest way to work on a screen. For the native app:

```sh
bun run sidecar
bun run tauri dev
```

## Boundaries

- The renderer never spawns commands, reads arbitrary paths, or holds a
  provider credential. Anything that touches the system goes through a narrow
  Tauri command in `src-tauri/src`, and the host validates its input.
- Parse every engine response with a bounded schema (`src/protocol`), and show
  a feature the engine does not advertise as unavailable, with the reason.
- Keep prompts, tool inputs, credentials, and raw payloads out of logs,
  diagnostics, and the app database.
- New styles use the design tokens; a test holds every stylesheet to them.
- Use plain ASCII hyphens in code, comments, documentation, and UI text, and
  add a code comment only where the code cannot say why on its own.

[SECURITY.md](SECURITY.md) describes the trust boundaries in full.

## Tests

```sh
bun run typecheck
bun test
cargo test --manifest-path src-tauri/Cargo.toml
```

A change to a user flow should also pass `bun run e2e:native`, which drives a
debug build of the real app with a home folder of its own. Linux changes can be
checked in Docker with `bun scripts/linux.ts check` ([docs/LINUX.md](docs/LINUX.md)).

## Pull requests

Explain the user-facing behavior, the boundaries involved, and what you ran.
Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for a
user-facing change, and keep [docs/FEATURES.md](docs/FEATURES.md) current when a
feature is added or removed.
