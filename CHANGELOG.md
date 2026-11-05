# Changelog

All notable changes to Runrail Desktop will be documented here.

## [Unreleased]

## [0.4.1] - 2026-11-05

- The Custom screen is no longer in the left rail, the Go menu, or on Cmd+9. It
  was added to 0.4.0 before it was ready.

## [0.4.0] - 2026-11-05

- Grok Build joins the coding tools in Add provider and onboarding. It never
  asks before it edits files or runs commands, so threads on it need full
  access.
- Settings keeps a history of plan usage per account, and themes can be saved
  and switched between.
- MCP servers take their keys in the app: values go to the OS keychain and are
  never shown again. Importing skills has select all, one-click browser
  sign-in for remote servers, and clearer buttons; Updates is last in General.
- Workflows start from templates for pull request review and a model relay.
- A thread can start from a GitHub issue, and a project's
  `.runrail/worktree.json` setup and archive commands run in each worktree only
  after the exact commands are approved. Editing the file asks again.
- Adding a project under Desktop, Documents or Downloads no longer makes macOS
  ask for the whole folder, and launch reads only the open project.

## [0.3.0] - 2026-11-02

- Office mode now has a Sakura theme and a Needs attention board for approvals
  and questions across projects.
- Pull request review adds an inbox and thread-aware review feedback. CI checks
  can be watched, with bounded log excerpts available to the agent handling the
  thread. An optional GitHub App relay forwards minimized event metadata to
  paired desktops; the relay does not store logs or raw webhook payloads.
- Threads can use inline terminal runs, clearer question and review cards, and
  fast mode for supported coding tools.
- Update the Nifra starter shown in the desktop app to `create-nifra@5.11.0`.

### Security

- CI logs and GitHub review text are marked as untrusted data in agent prompts.
  CI excerpts are fetched locally and remain in local thread history; only
  selected excerpts go to the tool handling that thread.

## [0.2.0] - 2026-10-30

Setup runs that resume, recall by meaning, sign-in to remote MCP servers, and
form controls that follow the app's theme. Runrail Desktop 0.1.1 and 0.1.2
were never released, so this release also brings their changes, listed below.

- A Setup chip in the composer sends the message to a setup instead of the
  thread: pick one of the project's setups, or Manage setups to make one.
- A setup run you started picks up where it stopped after Runrail quits or
  restarts, and a note says which run carried on.
- Setups can cap tokens ("Most tokens (K)" in the budget), and a run's header
  shows the tokens its threads have used.
- Up to four evals run at once in a project (was one), and the scoreboard
  shows tokens per passing case.
- Recall by meaning, in Memory under "Recall memories": pick an embedding
  model from your connections and Runrail also recalls a memory that says the
  same thing in other words. The page names the provider the memories are sent
  to, or says the model runs on this computer, and shows how far indexing has
  got. Off until you pick a model.
- Sign in to a remote MCP server from Settings, MCP servers. A server added by
  address with no token variable gets a Sign in button; your browser opens the
  server's own sign-in page, and threads use the sign-in when their agent next
  starts. Sign out is in the server's menu, and removing the server forgets
  its sign-in too. A server that wants a sign-in now says so instead of "It did
  not start."
- A server whose provider does not let apps register themselves, such as
  GitHub's, asks for an app you registered: enter its app ID, its secret
  (kept in the Keychain through the host, never sent through the page), and
  an optional callback port, from the sign-in or the server's menu.
- One-click suggestions for hosted servers you sign in to in the browser
  (Linear, Notion, Jira and Confluence, Sentry, GitHub) fill in the add-server
  form, and Integrations, Connectors points to them for anyone who would
  rather sign in than paste a key.
- The app's own dialogs for posting a review and merging a pull request end
  in Continue instead of Post or Merge: they choose what to send, and the
  macOS dialog after them is the one confirmation.
- Checkboxes, radio buttons and dropdowns follow the app's theme instead of
  drawing as native macOS controls: your accent and flower palette, in light
  and dark. A dropdown opens the app's own list, grouped like before, and
  answers the same keys: arrows, Home and End, Enter or Space, Escape, and
  typing a few letters to jump to an option.

### Fixes

- Run schedules after Quit stays on after it opens Runrail. The launch it
  opened wrote its helper again with a longer PATH, and the restart that
  followed could fail and remove the helper, which turned the setting off.
  The PATH coding tools get from your login shell now comes out the same
  however Runrail was opened.

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
