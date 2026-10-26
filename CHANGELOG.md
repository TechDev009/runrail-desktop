# Changelog

All notable changes to Runrail Desktop will be documented here.

## [Unreleased]

- Recall by meaning, in Memory under "Recall memories": pick an embedding
  model from your connections and Runrail also recalls a memory that says the
  same thing in other words. The page names the provider the memories are sent
  to, or says the model runs on this computer, and shows how far indexing has
  got. Off until you pick a model.

## [0.1.2] - 2026-10-25

Report a problem, a Homebrew cask, and the bundled engine kept clear of a
project's own Bun settings. Runrail Desktop 0.1.1 was never released, so this
release also brings its changes, listed under 0.1.1 below.

- A Homebrew cask: `brew install --cask TechDev009/runrail/runrail`. Publishing
  a release writes its DMGs' checksums into the cask, in the tap that also
  holds the command line's formula.
- Report a problem, in the command palette, Settings, Advanced, and the Help
  menu. It shows you a report first: the app's version, your system and
  architecture, the engine's version and `runrail doctor` checks by name and
  level, and the recent error codes and counters. Copy takes all of it; Open
  issue fills in a new GitHub issue in your browser, leaving out the least
  frequent counters if the link would be too long. It holds no prompts,
  transcripts, tool output, files, project names or paths, connections,
  accounts, or keys, and nothing leaves unless you send it.

### Security

- The bundled engine never loads a `.env` or `bunfig.toml` from the folder it
  starts in. Coding tools can start its MCP servers in your project, where a
  `bunfig.toml` could name a `preload` script that would run inside it.

## [0.1.1] - 2026-10-24

Security fixes from a review of 0.1.0, and steadier saving and streaming.

- Runrail asks before it downloads the Claude Agent SDK. Claude Code's first
  message waits on a card that explains what the SDK does, links its npm page
  and Anthropic's terms, and offers Install and continue or Continue without
  it; Settings, Agent can install it later. Before, the app downloaded it on
  first use without asking.

### Security

- A message one thread's agent sends another runs only when both threads are
  on the same access. A refused one shows in the thread it was sent to, with
  what was asked and why it did not run.
- Best of N checks a finished run on its own only when the run is on Auto or
  Full access, since the check runs scripts the agent may have edited; the
  others wait for Check. Threads on Runrail's own agent with Auto run as Ask,
  so their runs now wait too.
- Every load of the Claude Agent SDK checks its kept download against the
  pinned checksum and its files against the download. Existing installs are
  asked to download it once more.
- Links open only through the app's rules: a page on this computer in the
  thread's browser tab, any other https page in your browser, nothing else.
  Links in terminals, including OSC 8 hyperlinks, follow the same rules.
- Phone access: each request must arrive whole within 15 seconds, only this
  Mac's tailnet name is served once Tailscale has reported it, and a phone
  unused for 30 days is unpaired.
- Release builds never see the updater key or the Apple credentials. A
  separate sign job, run only for version tags in a protected `release`
  environment, signs and notarizes. Every action is pinned by commit.
- SECURITY.md says plainly that the window is trusted to run commands, and
  that native dialogs are consent prompts, not a boundary.
- source-map-js 1.2.2.

### Fixes

- Saved projects and threads that cannot be read, or that another version of
  Runrail wrote, are never saved over: the app says so and leaves the file
  as it is. A damaged file that cannot be moved aside is an error, and each
  damaged copy is kept under its own name.
- Each thread remembers the models of its last 64 turns, archived threads
  none, so saved state stays small. A save that keeps failing warns again
  about every ten minutes, and one that is too large says what to do.
- A workflow's webhook that arrives while its workflows cannot be read is
  answered 503 with `Retry-After`, instead of removing the hook.
- Streaming long answers does less work: each batch of frames is parsed once,
  and the timeline copies only what a batch changes.
- A code block whose highlighting timed out is highlighted again the next
  time it shows.
- A preview whose lock was poisoned by a panic no longer takes the app down.

## [0.1.0] - 2026-10-16

First public release, for macOS, Linux, and (experimental) Windows.

- Threads on a supervised local Runrail engine: Runrail's own agent loop on any
  connected model, or Claude Code, Codex, GitHub Copilot, and Pi through their
  own sign-ins.
- Plan, Ask, Auto-edit, and Full access modes, with approval cards that show the
  exact command or file.
- A worktree per thread, Best of N across models and tools, and a review view to
  stage, comment, and commit.
- Pull requests waiting on you across repositories, with checks and reviews,
  through your own `gh` sign-in.
- Import sessions, skills, MCP servers, and instructions from Claude Code, Codex,
  Cursor, Gemini CLI, opencode, and Pi.
- Dictation and talk mode with Apple's recognizer or local Whisper.
- Terminals, browser previews, files, and running tasks in a tabbed side panel.
  A file named in an answer, a tool call, or the review opens there at its line
  (answers can open files in your editor instead, in Settings); right-click one
  for your editors, Finder, and its path.
- Workflows on a schedule or a pull request event, notifications, and a menu bar
  item that keeps work running after the window closes.
- Signed updates from GitHub releases, installed only when you ask.
- Start a new app from a starter: Nifra (the default), Vite + React, Next.js, or
  an empty folder.
- Pin threads from any project into one list at the top of the sidebar.
- First-run setup: turn on the coding tools you use, choose whether Runrail
  reads your plan limits (never unasked), set how much agents do on their own,
  and bring MCP servers and instructions over from other tools.
- In a Nifra project, Runrail's own agent gets Nifra's MCP tools and Pi gets
  Nifra's instructions and tools; the thread header says so, and one switch in
  Settings turns it off.
- On macOS, the bundled engine alone may JIT; the app binary has only the
  microphone entitlement.
