# Changelog

All notable changes to Runrail Desktop will be documented here.

## [Unreleased]

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
