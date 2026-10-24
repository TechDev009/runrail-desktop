# Security

## Reporting a vulnerability

Please do not report a suspected vulnerability in a public issue. Report it
privately through GitHub's
[private vulnerability reporting](https://github.com/TechDev009/runrail-desktop/security/advisories/new).
A problem in the engine goes to
[its own advisories](https://github.com/TechDev009/runrail/security/advisories/new).

Include the version (shown in Settings), your operating system, a concise
reproduction, and the impact. You can expect an acknowledgement within a week.
Please allow reasonable time to investigate and release a fix before public
disclosure; reporters are credited in the advisory unless they ask not to be.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

The rest of this file is the desktop security model.

# Desktop security model

Runrail Desktop is a local control client, not a sandbox. A workspace, a
Runrail engine, provider credentials, and any tools enabled by the user are
trusted according to explicit policy, but the renderer and all process/network
responses are treated as untrusted input.

## Trust boundaries

1. The React renderer receives user input and untrusted control responses.
2. The Tauri host owns filesystem, process, token, and OS capabilities.
3. The Runrail control process owns session authorization, task capability
   checks, approvals, provider/harness execution, and event authority.
4. Providers, harnesses, plugins, connectors, and workspace tools are separate
   execution authorities and are never assumed to be safe sandboxes.

## Required controls

- Bind the engine to loopback unless a future, explicit remote mode defines
  transport encryption and an authorization model.
- Generate a high-entropy bearer token per engine process. Keep it in memory,
  pass it over the narrow host boundary, and never put it in URLs, logs,
  diagnostics, crash reports, or persistent app state.
- Validate the health contract before enabling controls. Reject unsupported
  protocol versions and incompatible limits.
- Parse every response with a bounded schema. Reject malformed JSON, invalid
  UTF-8, oversized bodies/frames, unknown event types, invalid scopes, and
  non-monotonic event cursors.
- Keep request and response size limits enforced on both sides.
- Use caller-owned idempotency keys for task mutations. Do not synthesize a
  retry key from the current time or an implicit retry counter.
- Let the core make authorization decisions. A UI visibility check is never an
  authorization check.
- Require an explicit approval path for capability-bearing operations and show
  the requested action, capability, workspace, and reason to the user.
- Restrict Tauri capabilities to the minimum required commands. Do not expose
  an arbitrary shell command, arbitrary path read, or generic eval bridge. The
  one exception, `automation.rs`, is compiled into debug builds only and opens
  only with `RUNRAIL_AUTOMATION=1`: a 127.0.0.1 socket that takes a random
  token kept in an owner-only file, for `scripts/e2e-native.ts`.
- Resolve and validate workspace paths in the Rust host. Do not trust renderer
  path strings or process environment values. A workspace must be a folder the
  person picked in the system folder dialog, or one inside it
  (`approvals.rs`); the host's own worktree and system folders are the only
  others.
- Shut down child processes on window/app exit. Use bounded graceful shutdown
  followed by a narrowly scoped escalation path.

## Data handling

The desktop must not persist prompts, tool inputs, credentials, raw provider
payloads, or PII as diagnostics or evidence. UI state may hold bounded content
needed to render the active conversation, but it must have explicit lifecycle
and size limits. Diagnostics should contain stable error codes, timestamps,
engine state, protocol version, and safe counters only.

The app database holds a connection id per thread and as the default. It
never holds a key, a token, or a sign-in answer. It also holds, per project,
the ids of skills turned off, and for a best-of run when its changes were
applied.

A thread continued from another names that thread by id when its engine
starts. The host checks the id and finds that thread's transcript folder
itself; the renderer never passes a path. The engine copies the conversation
once, into the new thread's own storage.

## Connections and stored secrets

A connection is a named account: a provider, an address, and how it signs in.
The engine owns the list and the secrets behind it. The renderer sees only the
redacted record: id, label, provider, sign-in kind, and a status.

### Who stores what

- The engine is the only reader and writer of stored secrets. The host and the
  renderer never open the vault.
- Signed release builds use the OS keychain (service
  `dev.runrail.credentials`, one item per connection id) and the account list
  the `runrail` CLI uses, `~/.runrail/accounts`.
- Development builds use a file vault under the app data folder (mode 0600 in
  a 0700 folder), because a rebuilt binary makes the keychain ask again on
  every build. The Settings footer says "stored in a file, not the keychain"
  when this is active.
- `RUNRAIL_DESKTOP_CREDENTIAL_VAULT=file|keychain` overrides the choice. It
  is read by the host from its own environment, never from the renderer.

### The system engine

The host runs one engine with no project for accounts and sign-ins. Its
workspace is a fixed folder under app data; the renderer cannot choose it,
start it with other options, or stop it. It runs no turns, and it answers the
renderer only for `account.*`, `connection.*`, `auth.*`, and `harness.status`
(which coding tools are installed, so the providers list can suggest them).
It never gets a shell: a coding tool's own sign-in runs in a terminal tab the
person sees (below).

### Write-only secrets

1. The key is typed into an uncontrolled password field, read once on submit,
   and cleared. It is not placed in React or store state.
2. It goes to the host through `connection_secret_set`, a command that returns
   nothing but success or a stable error code.
3. The host bounds it (one line, at most 16 KiB), builds the request in a
   single buffer that is wiped on drop, and posts it to the engine's `/secret`
   endpoint over the authenticated loopback channel.
4. `/secret` sits outside `/rpc`: no idempotency cache, no event, no journal
   entry. The engine writes the vault and answers with the redacted record.

No command or control method returns a stored secret. "Paste from clipboard"
(`connection_secret_from_clipboard`, macOS) has the host read the clipboard
itself, so the key never enters the web view at all.

A coding tool's API key (Claude Code, Codex) takes the same path with
`tool: true` on either command. The host then sends it under `connectionId`
instead of `accountId`, so a key can only land on the tool connection the
person picked. The engine hands it to the tool as one named variable or in
the tool's own sign-in request; it is never written to the user's own tool
settings.

### What the host refuses from the renderer

Every control request passes one guard before it reaches an engine. A refusal
is `HOST_RPC_REFUSED` (403):

- any `auth.secret*` method;
- on the system engine, any method outside `account.*`, `connection.*`,
  `auth.*`, and `harness.status`;
- on a project engine, any `auth.*` method (sign-in runs on the system engine,
  where the host can check the page it opens);
- on account, connection, sign-in, provider, and model methods: a parameter
  named `secret`, `token`, `apiKey`, `password`, `accessToken`,
  `refreshToken`, or `credential`, in any letter case, at any depth;
- sign-in input on a control method (it has its own command,
  `auth_submit_input`, with the same write-only handling as a key);
- an address, a shell variable name, headers, or an account id on the older
  `provider.select`, `provider.discover`, and `model.discover` methods: a
  connection fixes all of them;
- an account that reads a shell variable and also names its own address.

A thread starts with a connection id and a model. The host passes both to the
engine; it no longer accepts a provider name, an address, or a key variable.
A coding-tool thread starts with a tool connection id instead, passed as
`--tool-connection`. The host refuses one on the system engine, on the native
and replay backends, or together with a connection id.

### Coding-tool sign-in

A tool connection with its own account (Claude Code, Codex) signs in with the
tool's own command, in a folder of its own; Runrail never sees the token. The
engine answers `connection.loginCommand` with the command, its arguments, and
the folder variable. The renderer accepts only a short command name, plain
arguments, upper-case variable names, and absolute paths, quotes the line,
and shows it to copy. From an engine with the `connection.login` capability,
"Sign in with ..." runs the same command in a terminal inside the dialog:
`connection.loginStart` names only the connection, and the engine picks the
program and its arguments, so the system engine still runs no shell and the
renderer cannot name a command. What the tool prints and what the person types,
such as a code pasted back, pass through the engine in memory only, as they do
in a terminal tab, and are never logged or stored. An older engine types the
line into a new terminal tab of the open thread instead. Nothing runs it
unseen: each run starts from the person's click. Removing a
connection never signs the tool out; "Sign out" runs the tool's own sign-out
for that connection's folder only, after a confirmation.

### Sign-in pages

The renderer asks for a sign-in to be opened by id (`auth_open`). It never
supplies an address. The host asks the engine which page the sign-in is
waiting on and opens it only when all of these hold: the scheme is `https`,
there is no user info and no explicit port, the host is a name (not an IP
address), and that name is exactly one of the hosts the sign-in flow declares.
Anything else is `AUTH_URL_REFUSED` and nothing is opened.

### Known limits

- A key typed in the window crosses Tauri's IPC once as a string. The host
  wipes its own request buffer, but it cannot wipe the copies the web view and
  the IPC layer made. The clipboard route avoids them.
- A shell variable can be attached to a named provider. It is then sent to
  that provider's own fixed address, not to one the caller chose, but a
  variable that belongs to a different vendor would still leave the machine.
- The clipboard route and the opening of a real sign-in page have unit tests
  for their checks only. Neither has been exercised end to end.
- Unofficial sign-ins (xAI Grok plan, Kimi Code, Meta AI plan; labelled as
  such in the app) use the public client id of the vendor's own command-line
  tool, because the vendor issues no other. They send Runrail's name, never
  another product's. The app says so, and that the vendor may block the
  sign-in or act on the account, before the sign-in starts. None of the three
  has been run against the real vendor by this project.

## Coding tools on this computer

Claude Code, Codex, the GitHub Copilot CLI, and Pi run unmodified, as the
binaries the user installed, and sign in by themselves. The app never reads, stores, or relays their
credentials, and no sign-in method of theirs is removed or replaced.

- The engine learns whether each tool is installed and signed in by running
  the tool's own commands. It reads a yes or no for "signed in" and the list
  of models. No account name, address, organization, or plan reaches the
  renderer, the logs, or the saved state.
- The Copilot CLI has no command that says whether someone is signed in, so
  the app shows it as "Installed", never "Ready", and a missing login shows
  as the tool's own error on the first message. Pi is asked which models it
  can run (`pi --list-models`); the list names providers and models only.
- "Not signed in" is a warning, not a lock: it is the tool's answer to a short
  question, so the tool can still be picked and its own error shows if the
  answer was right. "Not installed" disables the tool.
- A tool found on this computer is listed as off under AI providers. No
  thread runs on its login until the user turns it on, after a confirmation
  that says whose plan or key its threads use. Turning one on, or all of them
  at once, never makes it the default.
- A thread on a coding tool saves the model id and nothing else about the
  tool. A model id is sent to the engine as one argument and is refused if it
  starts with a hyphen.
- Permissions are passed to the tool as an explicit mode each time it is
  started or its conversation is resumed, so a wider default in the tool's own
  settings never applies under a narrower choice shown here. Claude Code cannot ask from here yet: under "Ask" it
  refuses what it would have asked about. Codex asks through the app.
  Copilot asks through the app too: the engine answers each of its permission
  requests from the thread's permission choice. A tool the user already
  allowed in Copilot's own settings may run without a request; that has not
  been checked against the real CLI.
- GitHub Copilot is reached only through GitHub's own CLI. The app never signs
  in to GitHub, holds no GitHub token, and never presents itself as another
  editor.
- The tool is a separate program with the user's rights. It is not a sandbox.
- For Codex the engine runs `codex` from PATH, or the Codex desktop app's own
  copy of the CLI when that copy reports a strictly newer version. An app
  copy is used only if it is a regular file that no account other than its
  owner (the user or root) can write, and only if it answers as `codex-cli`.
  Its code signature is not checked: it is trusted as much as the PATH copy,
  which sits in a folder the user can write too. `RUNRAIL_CODEX_APP_SEARCH=off`
  in the app's environment turns this off.

## Sessions from other harnesses

Importing a Claude Code, Codex, or Pi session is done by the engine, not the
renderer. The engine reads only those harnesses' own session folders, and only
sessions recorded for the open project's folder. It copies bounded text and
tool summaries into the new thread's transcript and leaves the original file
untouched. The renderer sends a source and an id; it never sends a path, and
it keeps nothing from the imported session beyond the thread's title and the
source/id pair that links the thread back to it.

## Instructions

Settings → Instructions edits two things:

- Global instructions, kept in the app's saved preferences (at most 8 KiB).
  The host writes them into each thread's behavior file when its engine
  starts; it refuses a NUL character or anything over the limit.
- The open project's `AGENTS.md`. The renderer names the project folder and
  the host resolves it like any workspace path (absolute, an existing
  folder, not the filesystem root); the file name is fixed and only
  `AGENTS.md` at that folder's root is touched. A symbolic link or anything
  that is not a regular file is refused (`INSTRUCTIONS_INVALID`), as is text
  over 256 KiB or with a NUL. The write is atomic and keeps the file's
  existing permissions. As with starting an engine, the host does not check
  that the folder is one the user opened as a project.

## MCP servers

An MCP server is a program the engine starts with the user's rights, so the
list is the host's, not the renderer's.

- The host keeps the list in `mcp-servers.json` under app data and adds it to
  each project engine's behavior file when that engine starts. A start
  request cannot carry or change it, and the system engine never gets it.
- Saving a new server, or changing an existing one's command, arguments,
  variables, address, token variable, or project, shows a native
  confirmation that spells out the exact command line or address and which
  threads will use it. Cancelling it is `MCP_DECLINED` and nothing is saved. Turning a saved
  server on or off, or removing it, needs no confirmation.
- The host checks every field (`deny_unknown_fields`): a lowercase name, a
  command with no whitespace that does not start with `-`, at most 32
  arguments, at most 16 servers. The engine checks the same bounds again.
- Variables are names only. No value is ever saved, shown, or sent by the
  app; the server reads the named variables from the environment the app
  itself started with, together with a fixed safe set (`PATH`, `HOME`,
  `LANG`, `LC_ALL`, `TERM`, `CI`). Every other variable is withheld. The form
  never repeats a pasted `NAME=value` entry back, in case the value is the
  secret.
- A server runs either as a program or at an address. An address must be
  `https`, or `http` only on `localhost`, `127.0.0.1`, or `[::1]`, with no
  user name or password in it; the host and the engine both refuse anything
  else. Its access token is the name of a shell variable, never a value: the
  engine reads that variable when it connects and sends it as a bearer token
  to that address only. An unset variable is `MCP_TOKEN_MISSING`, and the
  form never shows the variable's value.
- A server can be limited to one project. The host stores that project's
  canonical folder path and adds the server only to engines started in that
  folder; every other project's engines never see it.
- Only threads on Runrail's own loop connect to these servers. Claude Code and
  Codex keep their own MCP settings and never see this list.
- A server that fails to start is reported by a stable `MCP_*` code; the
  thread runs on without its tools. "Check" starts one server once in the
  project's quiet engine, lists its tools, and stops it.

## Settings from other tools

Settings → Skills, MCP servers, Subagents, and Instructions can bring over
what Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, opencode, and Pi
are set up with on this computer.

- **What is read.** Only fixed, well-known paths: each tool's own settings
  file, instruction file, and skills or agents folder in the home folder,
  plus `.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`,
  `opencode.json`, `GEMINI.md`, `.github/copilot-instructions.md`, and
  `.cursorrules` in the open project. The renderer cannot name another path.
  Settings files are read up to 4 MiB, text files up to 256 KiB, and at most
  512 skills, 128 servers, and 128 subagents are listed. Links are followed,
  since these are the person's own settings and often live in a dotfiles
  repository.
- **What is never returned.** An MCP server's environment values, request
  headers, and anything that could carry a token: environment entries come
  back as names only, `Bearer ${NAME}` becomes a token variable name, and
  every other header, a URL with a user name or password, or a value written
  in place is listed as left out. A test feeds the scan settings files full
  of secret values and checks none of them reaches its result.
- **Copying a skill or subagent.** The renderer sends back a path from the
  list; the host scans again and refuses any path that is not one of the
  folders or files it found (`SKILL_INVALID`, `AGENT_INVALID`). The copy then
  follows the same rules as a skill folder import or a subagent save below,
  including refusing a skill folder that holds a link, and it never replaces
  a skill or subagent of the same name.
- **Adding MCP servers.** The picked servers go through the same checks as a
  server added by hand, and one native confirmation lists every command line
  or address before any is saved. Cancelling saves none (`MCP_DECLINED`).
- **Instructions.** An instruction file's text is returned to the renderer
  and lands in the editor only when the person picks it; nothing is saved
  until they save.

## Voice

- **Listening.** The host opens the microphone (the one picked in Settings,
  or the system's input) only while the composer shows it listening, and
  only for one session at a time, at most two minutes. The app's
  `Info.plist` carries the microphone and speech recognition usage
  descriptions, and the release entitlements add
  `com.apple.security.device.audio-input`, so macOS asks the person the
  first time. A microphone that delivers only silence for two seconds (what
  macOS does when access is denied) ends the session with
  `VOICE_NO_AUDIO`.
- **Asking without crashing.** macOS asks on behalf of the process's
  responsible app and kills the process when that app's `Info.plist` has no
  matching usage description. Runrail checks the microphone and speech
  status first (a check never prompts) and asks only when the responsible
  app declares the matching key; otherwise it fails with
  `VOICE_ASK_UNAVAILABLE`. A refusal is `VOICE_MIC_DENIED` or
  `VOICE_SPEECH_DENIED`. A development build started from a terminal, an
  editor, or Claude Code starts itself again as its own responsible process
  (debug builds only), so macOS asks in Runrail's name with the descriptions
  embedded in the binary; the first process only passes signals on and exits
  with it. An automated run (`RUNRAIL_AUTOMATION=1`) skips this, since
  answering for itself would wait on macOS asking for the checkout's folder.
- **No audio is kept.** Samples stay in memory for the session and are
  dropped when it ends; nothing is written to disk or logged, and
  whisper.cpp's own logging is switched off because it could echo what was
  said. Recognized words go into the composer draft like typed text and are
  sent only when the person sends, or, with "Send when you stop talking" or
  talk mode, when they stop speaking.
- **Apple's recognizer** (the Speech framework) may process audio on Apple's
  servers, depending on the Mac and language; "Keep speech on this Mac" sets
  `requiresOnDeviceRecognition`, and the host refuses to start
  (`VOICE_ON_DEVICE_MISSING`) rather than fall back to the servers when
  there is no on-device model. Settings → Voice says which applies.
- **Whisper** runs whisper.cpp in the host; nothing leaves the Mac. Models
  come from a fixed list in the host: each is pinned to one revision of
  `ggerganov/whisper.cpp` on Hugging Face with its size and SHA-256. The
  renderer names a model by id only. The host downloads with
  `/usr/bin/curl` over https only (redirects too), into a `.part` file
  capped at the model's size, and renames it into place only when size and
  SHA-256 match; otherwise it deletes the file (`VOICE_MODEL_CHECK`). Only a
  file at the final name is ever loaded. One download runs at a time and can
  be cancelled; removing a model unloads it first.
- **Words to recognize** (at most 100, one line of 64 characters each) are
  passed to the recognizer as hints and kept in the app's preferences.
- **Reading aloud** uses the system's voices through `speechSynthesis`; the
  text never leaves the app.
- In the browser preview and on other systems, dictation falls back to
  WebKit's `webkitSpeechRecognition`.

## Notifications

- macOS notifications go through Apple's UserNotifications. macOS lets only
  an app bundle use it, so a development build reports notifications
  unavailable and keeps the notes in its window. Permission is asked the
  first time one is needed, or when the person turns them on.
- A notification carries the thread's title and one of three fixed words
  (finished, failed, needs approval), as one line cut at 256 and 512
  characters; never a prompt, an answer, or a tool's output. macOS keeps
  delivered notifications in Notification Center, and shows them on the
  lock screen only as its own per-app settings allow. Opening the thread
  clears that launch's notifications for it.
- The renderer can only name a thread id (letters, digits, `.`, `_`, `-`);
  a click gives that id back to the window, which opens the thread only if
  it exists.

## Plan usage

- A thread on Codex or Claude Code shows how much of that tool's
  subscription is used, in the context card beside the model. The engine
  passes on only each window's share used, its length, and when it resets,
  plus the plan's name; account ids, balances, and credit details are dropped
  in the engine, and the window keeps only those fields.
- The numbers live in memory for the running app. They are not written to
  `desktop-state.json`, logs, or diagnostics, and they are only as fresh as
  the tool's last report, which the card says.
- The context window each model last reported is kept in the window's local
  storage (`runrail.context-windows`, keyed by tool and model id, at most 64
  entries) so a new thread shows its size before the first answer. Nothing
  about a thread or its messages is kept there.

## Skills and subagents picked in the composer

- A skill picked from the add menu goes to Runrail's own agent by id with
  the message (up to eight), and the engine loads it as it would for
  `/skill:<id>`. A coding tool gets the same choice as a line of text, as a
  subagent always does. Turning an MCP server on or off from the menu is the
  same switch as in Settings, and restarts the engines the same way.

## New apps

Create project, New app, asks the host for an app name and a starter id, both
checked against fixed rules (npm's package-name rule and the four known
starters). The host shows the folder picker, so the renderer never names
where to write; it runs the bundled engine's `runrail new` into a new folder
there and approves only that folder as a project. The engine fetches the
chosen creator from npm at a pinned version and runs it, the same trust as
running it yourself. What a failed creator printed is shown in the dialog and
never logged.

## Project files the app writes

Each of these takes a project folder from the renderer and resolves it like
any workspace path (absolute, an existing folder, not the filesystem root).
As with starting an engine, the host does not check that the folder is one
the user opened as a project.

- **Skill import** (Settings → Skills). The host, not the renderer, shows
  the folder picker, so the renderer never names a source path. The folder
  must hold a `SKILL.md` of at most 256 KiB. The host copies at most 64 files
  and 2 MB, four folders deep, skips `.DS_Store` and `.git`, and refuses the
  whole import if any entry is a symbolic link (`SKILL_INVALID`). It copies
  into a hidden staging folder and renames it to
  `<project>/.agents/skills/<name>`; it never replaces an existing skill
  (`SKILL_EXISTS`).
- **Subagents** (Settings → Subagents). Files are
  `<project>/.claude/agents/<name>.md` in Claude Code's format. The name is
  lowercase letters, digits, and `-`; the description is one line of at most
  1,024 characters; at most 64 tools and 64 KiB of instructions; at most 128
  files of 96 KiB are read. The host refuses a linked `.claude/agents`
  folder, never follows or overwrites a link, writes atomically, and keeps
  front-matter lines it does not edit. Only Claude Code threads read these
  files.

## Other host features

- **Keep awake.** While on, the host runs `/usr/bin/caffeinate -i -w <the
  app's process id>`, with `-d` added when the person also keeps the display
  on, and no other arguments, so the assertion ends when the app does, even
  after a crash. It never changes a system setting.
- **Asking before quitting.** While a turn runs and the setting is on, the
  renderer sets a flag in the host; closing the window or quitting then shows
  a native confirmation. The flag only delays the person's own quit; an exit
  the app asks for itself is never stopped.
- **Terminal shell.** The renderer can name a shell for the terminal, but the
  host passes it to the engine only if it is listed in `/etc/shells`, and the
  engine checks `/etc/shells` again before it starts the shell. The setting
  takes a path, never arguments.
- **Providers from other tools** (Settings → Import). The engine reads
  `~/.codex/config.toml`, `~/.pi/agent/models.json`, and
  `~/.config/opencode/opencode.json` and returns names, addresses, model ids,
  and variable names only. A key written in one of those files is never
  returned, logged, or copied; a provider that needs one is added through the
  key form like any other. A variable name is returned only when it is the
  preset's own (for example `OPENAI_API_KEY`), and an address only when it is
  a known provider's host, `https`, or on this computer. Adding a known
  provider uses that provider's fixed address, not the one in the file.
- **Startup timing.** The first time the window reports it is ready, the host
  writes `startup.json` (`readyMs` and a timestamp, nothing else) to app
  data. Later reports in the same launch, and readings over ten minutes, are
  ignored.

## Browser previews

A browser tab in the side panel is a separate webview (`preview-<n>`) placed
over the panel inside the main window. The page is untrusted:

- **No access to the app.** The app manifest in `build.rs` lists every host
  command, so each one needs a permission, and the only capability grants them
  to the `main` webview (`webviews: ["main"]`, never `windows`). A host test
  fails if a capability targets a window, a remote origin, or any other
  webview, or if a command is missing from the manifest.
- **Addresses.** The page and every navigation, frame, and new-window request
  may only be `http` or `https` (frames also `about:`, `data:`, `blob:`), never
  with user info, at most 2048 characters, and never the app's own origins
  (`tauri://localhost`, `tauri.localhost`, `ipc.localhost`, `asset.localhost`,
  the dev server's origin).
  A new window loads in the same tab when allowed and is refused otherwise.
- **Nothing kept or granted.** Each preview is incognito (no cookies or
  storage on disk), camera and microphone requests are denied, downloads are
  denied, and developer tools exist only in debug builds.
- **Bounds.** At most 6 live previews app-wide; the least recently shown is
  closed and loads again when its tab shows. Closing a tab, deleting its
  thread, or quitting destroys the webview.
- **Saved state.** A tab's address is saved as origin and path only (no query
  or fragment, which can carry tokens).
- Native views draw above the page, so a preview hides while a menu, popover,
  dialog, or the palette overlaps it.

## Agent browser use

A thread's agent can use its browser tab only after the person turns browser
use on for that thread in the tab's toolbar. It is off by default and saved as
`browser: { agent: true, anySite?: true }`, nothing more. Only Runrail's own
loop, Codex, and Claude Code threads start with `--browser-tools`; the system
engine refuses the flag, and any change restarts the thread's engine.

- **Claimed once.** The engine announces a request by id, with no parameters.
  The renderer claims it once with `browser.take` and answers with
  `browser.respond`; a replayed announcement finds nothing to claim.
- **The renderer checks again.** Before acting, it reads the thread's own
  switch, not the engine's word: off answers `BROWSER_OFF`, and without "any
  site" only `localhost`, `*.localhost`, `127.0.0.0/8`, and `[::1]` open. User
  info and non-http(s) addresses are refused. The preview address rules above
  still apply.
- **Fixed scripts.** Reading the page, clicking, typing, pressing a key, and
  reading the console run scripts compiled into the host (`preview_script`);
  the renderer sends an action and an element reference, never code. Answers
  are strings of at most 64 KiB. Values of password, card (`cc-`), and
  one-time-code fields are never read.
- **Scripts ask every time.** `preview_eval` runs the agent's expression (at
  most 8192 characters) only after a native dialog the renderer cannot answer,
  one dialog at a time. It runs in the untrusted page, never in the app, so it
  is not an eval bridge into Runrail.
- **Screenshots** (macOS) are a JPEG of the preview alone, at most 1600 pixels
  wide and 900 KiB of base64.
- **Claude Code** reaches the browser through a stdio MCP server the engine
  starts (`runrail browser-mcp`). It reads its address and a token from a 0600
  file in a 0700 temporary folder, removed when the engine stops; that token
  opens only `POST /browser`. Neither appears on a command line.
- **Nothing kept.** Requests, page text, and screenshots pass through memory
  only, never desktop state, logs, or diagnostics.
- A page can hold text written to steer the agent. The "any site" switch says
  so where it is turned on.

## Background work

The Tasks tab lists what the engine reports through `background.*` and stops
only by the ids the engine announced; it never sends a process id or path. The
system engine refuses these methods (pinned by a host test). Labels arrive
already redacted, are kept in memory, and are never written to desktop state.
A settings change that restarts the engine waits while background work runs,
and "Apply now" asks first because the restart stops that work.

## Remote machines

A project can live on a machine the person reaches with `ssh`.
The host keeps the list of machines in app data and saves a new or changed one
only after a native confirmation that names the host and the command it will
run there. A host must look like an SSH alias, a host name, or `user@host`, so
it can never be read as an `ssh` option. Runrail runs the system `ssh` with
`BatchMode=yes`, so it never prompts, and uses the person's own SSH settings
and keys; it never reads `~/.ssh` beyond the `Host` names in `~/.ssh/config`
offered while adding a machine. Each remote thread's `ssh` process is the
ControlMaster for a socket in app data, and the engine's loopback port there
comes back through a `-O forward` on that socket to `127.0.0.1` here, so the
engine's bearer token and traffic stay inside the SSH connection. The remote
engine exits when its `ssh` ends. Provider keys, connections, related folders,
and browser, computer and image tools stay on this Mac; a remote thread runs on
the coding tools signed in on that machine. Continuing a thread on another
machine never commits or pushes; work not yet on the branch's upstream is
refused until the person pushes it.

## Phone access

Phone access is off until the person turns it on. It is a
small HTTP server bound to `127.0.0.1` only, at a port kept in app data; the
person's own `tailscale serve` brings it to their tailnet over HTTPS, and the
host runs that command only after a native confirmation that shows it. The
host reads just three facts from `tailscale status`: whether it is connected,
this Mac's tailnet name, and whether HTTPS certificates are on.

- A phone pairs with a one-time code shown in Settings: eight characters from
  an unambiguous alphabet, good for five minutes, five tries, and one use. A
  QR code carries it in the address fragment, which the browser never sends;
  the phone page drops it from the address once paired.
- A paired phone gets a random 256-bit bearer token. App data keeps only its
  SHA-256 with the phone's name and dates; the token itself stays in that
  phone's browser storage and travels only in a header. Removing a phone in
  Settings revokes it at once, and a phone unused for 30 days is unpaired on
  its own and must pair again.
- Requests whose `Host` is not loopback or a `ts.net` name are refused, so a
  page that rebinds its own domain to `127.0.0.1` reaches nothing; once
  Tailscale has reported this Mac's tailnet name, only that name is accepted.
  Bodies are capped at 1 MB, answers at 4 MB, connections at 32 at a time,
  and each request must arrive whole within 15 seconds. The page is served
  with a strict Content-Security-Policy and no framing.
- A phone may list threads, read one (messages, tool titles, approvals and
  errors, not reasoning), send a message, stop a turn, and allow or deny an
  approval. Questions are answered on the Mac, and nothing else is reachable.
  Each call is run by the app's page with the window's own code, answered
  once, and given up after 30 seconds. No call, answer, or token is logged.
- A phone that asks for notifications hands over its Web Push subscription
  and its page's origin, kept with that phone in app data and dropped when the
  phone is removed or its push service says the subscription is gone. The
  system engine sends each notification encrypted for that phone (RFC 8291),
  so Apple's or Google's push service sees only ciphertext, signed with a VAPID
  key kept owner-only in `~/.runrail/push`, and posts only to the browsers'
  own push services. A notification carries the thread's title, a few words
  ("Needs your approval", "Finished"), and the thread's id, and is sent for
  the events macOS notifications are, while Runrail is not the app in front.

### Read-only links and pages

Through the same server, the person can hand out read-only
links: a thread at `/s/<token>`, and a published page at `/p/<token>/`. Each
token is 192 random bits in the address, so anyone on the tailnet who has the
link can use it, and nobody else; app data keeps the tokens so Settings can
copy a link again, and revoking one there ends it at once. At most 100 are
kept, and one thread has one link.

- A thread link shows the thread's title, status, messages, tool titles,
  approvals and errors, as a paired phone sees them, and never its project,
  machine, or folder. The host passes the thread's id from app data, not from
  the request, and the page answers only that read: nothing can be sent,
  stopped, or approved through it. A link to an archived or deleted thread
  shows nothing.
- A page is a copy of a folder the person picks, made after a native
  confirmation that says how many files and bytes it holds. Hidden files and
  folders, `node_modules`, and links are left out, and it is capped at 2,000
  files, 50 MB, and 16 levels; a link that appears while copying stops the
  copy. Later edits to the folder are never served, and unpublishing deletes
  the copy.
- Page files are served with `Content-Security-Policy: sandbox` (scripts,
  forms, popups and downloads, but not the same origin), so a page runs on an
  opaque origin: it cannot read the phone page's storage, where a paired
  phone's token lives, or call the phone API as that phone. A path is decoded
  before it is checked, then refused if it climbs out with `..`, names a
  hidden file, or holds a backslash, and links inside the copy are never
  followed.

### Workflow links

A workflow whose trigger is "When its link is called" can
get a webhook link, `POST /hook/<token>`, on the same server. The token is
192 random bits; app data keeps only its SHA-256, so the link is shown once,
when it is made, and a new link ends the old one. At most 50 workflows have
links, and Settings, Phone access lists them to remove.

- The host names the workflow from app data, never from the request, and the
  page starts it only while it is on and still waits for its link; a link to
  a deleted workflow removes itself. A link starts at most one run every 10
  seconds, and a workflow already running refuses another.
- A call sends up to 16 KB of UTF-8 text. Agent and setup steps see it first,
  in a code fence nothing inside can close, labelled as outside data and not
  the person's instructions; the engine keeps it in memory only, never in the
  run's record or status, and notices and Slack text never include it. The
  workflow's own approval steps and access levels still apply to whatever its
  agents decide to do with it.
- Paired phones cannot start workflows or read shared threads through
  `/api/call`: those calls reach the page only through their own links.
- The link answers only on the tailnet. Reaching it from the internet would
  need the person to turn on Tailscale Funnel for port 8443 themselves, which
  would expose pairing and every link with it; Runrail never does.

## Quick chat

Quick chat is a global shortcut, Option Space unless the
person picks another in Settings, General; a shortcut needs a modifier, so a
plain key never fires in every app. It is registered with the system's own
hot key service, which needs no permission and sees no other keys.

- Pressing it notes which app and window are in front (their names, from the
  window list) and opens a small window of Runrail's own. Nothing is captured
  then. Only when the person ticks "Include the ... window" and sends is that
  one window captured, as a JPEG capped like computer use's, and only with the
  Screen Recording permission the person grants in macOS's own prompt. Apps
  that hold passwords or change security settings (System Settings, Keychain
  Access, Passwords, 1Password, Bitwarden, the login and security prompts)
  cannot be included.
- The small window is a separate webview whose capability allows exactly three
  commands: read those names, hand the message to the main window, and hide.
  It cannot reach engines, files, settings, or any other host command, and it
  listens to no events.
- The message and the picture go to the main window, which starts a thread in
  the project in front and saves the picture as that thread's attachment, as
  a pasted image would be. Without a model to send on, the text waits as the
  new thread's draft and the picture is dropped. Nothing is logged, and the
  settings file keeps only the shortcut, whether it is on, and the box's last
  state.

## Updates

Only release builds, made with the `updater` feature, can update themselves.
The renderer can ask the host to check and to install; it cannot set the
feed URL, the key, or a download location. Every downloaded bundle is
verified against the public key compiled into the build before it is
installed. Signing keys and Apple credentials live in the release
environment and are read only by the Tauri CLI (see
[docs/RELEASE.md](./docs/RELEASE.md)).

## Recovery rules

- A failed health check leaves the UI disconnected and disables mutations.
- A cursor-expired response triggers snapshot reconciliation; it never silently
  drops the missing range.
- A protocol parse failure tears down the stream and presents a bounded error;
  it does not guess or display unvalidated payloads.
- A child process that exits unexpectedly is marked failed/stale until a fresh
  authenticated process is established.
- Network or provider errors are not retried blindly. Mutating operations are
  retried only with the same stable idempotency key and only after the client
  can establish the original request outcome safely.

## Release checklist

- [ ] Tauri CSP is explicit and does not allow unsafe inline/eval behavior.
- [ ] Tauri capability files expose only required commands and windows.
- [ ] No bearer token, provider key, prompt, tool input, or raw payload appears
      in logs, test snapshots, or crash artifacts.
- [ ] All renderer-to-host inputs are parsed and bounded.
- [ ] No command or control method returns a stored key or token; the only
      secret-bearing commands are write-only.
- [ ] The release build selects the keychain vault, and a key added in the app
      is usable by the `runrail` CLI for the same user.
- [ ] A sign-in opens only an `https` page on a host its flow declares.
- [ ] Workspace and executable policies fail closed.
- [ ] Process cleanup is verified after normal close, crash, and forced quit.
- [ ] Control protocol compatibility is checked before mutating actions enable.
- [ ] Clean-machine packaging tests pass without depending on a developer's
      checkout or shell environment.
