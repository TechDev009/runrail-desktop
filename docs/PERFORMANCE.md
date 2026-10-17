# Performance budgets

What the app has to stay under, how each number is taken, and the last
measurement. A change that breaks a budget needs a reason in its pull request.

## Budgets

| Budget | Limit | How it is measured |
| --- | --- | --- |
| Renderer ready | 300 ms | `performance.mark("runrail:ready")` (set in `src/app/boot.ts` once saved state is loaded) from navigation start, production build, warm cache |
| Native cold start | 1.5 s | launch of the release app to the host's ready time (`startup.json`), measured with `scripts/perf/coldstart.swift` |
| Idle JS heap | 25 MB | `performance.memory.usedJSHeapSize` after load, one thread open |
| 2,000-item thread | 40 MB heap, 1,500 DOM nodes | the `long` preview scenario (`?preview=long`), after scrolling top to bottom |
| Scroll step | 16 ms p95 | set `scrollTop`, dispatch `scroll`, wait one task, read layout; 200 steps through the long thread |
| Keystroke | 16 ms p95 | composer input event to React commit, 100 keys |
| Frame time | p95 within one display frame, under 2% of frames dropped | `requestAnimationFrame` intervals in a visible WebKit window (`scripts/perf/framebench.swift`): 300 frames scrolling up the long thread at 60 px per frame, 300 back down, then 150 keystrokes |
| Transfer | 400 KB | first-load JavaScript and CSS over the wire (gzip), excluding lazily loaded languages |
| Resident memory | 500 MB | host, web view, and engines summed (RSS), one project, three threads |
| Thread open | 200 ms first open (up to 2,048 items), 50 ms revisit | click to the first painted frame that shows the thread's rows: `scripts/perf/switchbench.swift` on the preview host; in the app, Settings → Advanced → Show the details |

## Last measurement

2026-10-02, Apple Silicon Mac, macOS 15.6. Renderer numbers come from a
production `vite build` served by `vite preview` with the preview host. The
browser pane used was hidden, so `requestAnimationFrame` never fired: the scroll
and keystroke numbers use timers instead and include the browser's ~4 ms timer
clamp. They are upper bounds, not frame times.

| Budget | Result |
| --- | --- |
| Renderer ready | 116 ms (DOMContentLoaded 117 ms) |
| Idle JS heap | 9.9 MB |
| 2,000-item thread | 12.5 MB heap after load, 18.5 MB after the scroll run; 505 DOM nodes; the list mounts 16 to 24 rows |
| Scroll step | p50 12.3 ms, p95 14.6 ms, max 18.5 ms |
| Keystroke | p50 5.9 ms, p95 6.4 ms, max 6.5 ms |
| Transfer | 285 KB |
| Resident memory | about 398 MB (debug build): host 99.4 MB, web view about 184 MB, three engines 37 to 39 MB each |

For comparison, PI-Desktop, already running on the same machine, summed to
about 1,085 MB over 11 processes. RSS counts shared pages in every process, so
both totals overstate real use; they are rough and only comparable to each
other.

## Frame times and cold starts

2026-10-02, same Mac, 60 Hz display.

**Frame times.** `framebench` loads the production build of the long preview
thread in a WKWebView in a visible, floating window. WebKit reports
`requestAnimationFrame` times in whole milliseconds, so a frame on time reads
17 or 18 ms; a frame counts as dropped above 25.5 ms.

| Run | Scroll up p95 / p99 / max | Dropped | Scroll back p95 / p99 / max | Dropped | Keystroke p95 / max |
| --- | --- | --- | --- | --- | --- |
| 1 | 18 / 18 / 22 ms | 0 of 300 | 18 / 18 / 19 ms | 0 of 300 | 18 / 18 ms |
| 2 | 18 / 19 / 32 ms | 1 | 18 / 19 / 24 ms | 0 | 19 / 53 ms |
| 3 | 18 / 23 / 35 ms | 1 | 24 / 38 / 102 ms | 12 | 18 / 18 ms |

The budget held in two runs out of three. Run 3 dropped 4% of frames
scrolling back, with one 102 ms frame. An earlier pass that scrolled down from
the top over 400 frames missed it in all four runs (p95 20 to 26 ms, 7 to 20
frames dropped). Long frames come when new rows mount, so this budget is not
met reliably yet.

**Syntax highlighting moved off the window's thread.** Profiling the long
frames found nearly all of their script time in Shiki's regular expressions,
run when a code block or diff mounts. Highlighting now runs in a Web Worker,
results are kept for the last 200 blocks, and a block shown again draws its
colors in its first frame. The preview thread was also made realistic (long
answers with code and diffs every third turn) so the benchmark mounts real
code.

The Mac was under heavy load from other work (load average 100 to 180 on 16
cores), so absolute numbers are noisy. The two builds were run alternately,
three rounds each, so both saw the same load:

| Round | Old: dropped up / back | Old: p99 up / back | Worker: dropped up / back | Worker: p99 up / back |
| --- | --- | --- | --- | --- |
| 1 | 10 / 1 | 114 / 23 ms | 0 / 1 | 18 / 21 ms |
| 2 | 15 / 9 | 123 / 31 ms | 9 / 7 | 30 / 29 ms |
| 3 | 12 / 2 | 119 / 25 ms | 0 / 0 | 18 / 20 ms |

Scrolling up into rows never shown before, the worse case, went from 10 to
15 dropped frames with a p99 above 110 ms to none in two rounds of three.
The worker build has not been measured on an idle Mac yet.

A cache of rendered markdown was tried and removed: with the cache, the same
three runs read p95 18 ms and 0 to 7 dropped frames, which is within the
run-to-run noise above.

**Cold starts.** `coldstart` opens each app with `NSWorkspace`, waits for its
first on-screen window of at least 400 by 300 points, waits a few seconds,
quits it, and repeats. These are relaunches with a warm disk cache, not starts
after a reboot. Runrail's build is the local release build (ad hoc signed,
66 MiB), launched with the file credential store so it never touches the
Keychain.

| App | Window, run 1 / 2 / 3 | Ready, run 1 / 2 / 3 |
| --- | --- | --- |
| Runrail (Tauri) | 1,397 / 338 / 272 ms | 1,743 / 614 / 491 ms |
| PI-Desktop (Electron) | 1,031 / 1,001 / 967 ms | not reported |
| Codex (installed as ChatGPT.app, Electron) | 1,917 / 1,522 / 1,526 ms | not reported |

Runrail's run 1 was its first launch after the build. "Ready" is the time the
host writes to `startup.json` once the window has loaded saved state, measured
from the open request; from process start it read 1,707 / 601 / 479 ms. The
other apps report no ready time, so they are compared only on the first
window. A window can appear before its content draws, and that gap differs by
framework, so first-window times are not a like-for-like measure of when an
app can be used.

## Event delivery

2026-10-02, Apple M3 Max, macOS 15.6.1, under load (load average 15 to 18 on
16 cores).

**Engine start.** From spawn to the engine's `control.ready` line, native
backend, no MCP servers, four runs each. MCP servers and coding-tool backends
start before the handshake and add their own time; the host waits up to 90 s.

| Engine | Run 1 | Runs 2 to 4 |
| --- | --- | --- |
| Bundled sidecar (release builds) | 866 ms | 74 to 77 ms |
| Core checkout through `bun run` (debug builds) | 75 ms (Bun's cache already warm) | 66 to 77 ms |

**Lone events.** From the engine writing an event to the host handing its
batch to the page, for an event with nothing behind it: an approval request, a
turn ending, the last tokens of a burst. The host used to read with a fixed
40 ms timeout, so such an event waited it out: p50 40.8 ms, max 43.6 ms. A
pending batch now waits only for the rest of its 16 ms window: p50 16.9 ms,
max 17.2 ms (30 events; `a_lone_event_is_delivered_within_one_batch_window` in
`src-tauri/src/engine.rs`).

**Into the page.** Batches used to reach the page through Tauri's `emit`,
which inlines the JSON in a script the web view parses. `deliverybench.swift`
times that against the custom-scheme fetch a Tauri `Channel` uses from 8 KB up,
in a visible WKWebView, from the native call until the page's listener has read
the batch. p50 over 100 runs (20 from 1 MB), every payload different:

| Batch | Inline script | Fetch and `JSON.parse` |
| --- | --- | --- |
| 1 KB | 0.08 ms | 0.20 ms |
| 8 KB | 0.13 ms | 0.20 ms |
| 32 KB | 0.32 ms | 0.24 ms |
| 128 KB | 1.05 ms | 0.38 ms |
| 512 KB | 4.40 ms | 0.96 ms |
| 1 MB | 9.57 ms | 1.48 ms |
| 4 MB | 62.63 ms | 5.01 ms |

Token batches are a few KB, where the inline script is faster and a `Channel`
uses it too. Large tool output, diffs, and replays after a reconnect cost the
page's main thread about 10 ms per MB on the inline path. Batches now go
through a `Channel` (the `onBatch` argument of `control_stream_start`), so
those take the fetch path. The benchmark's fetch is a same-origin GET; Tauri's
is an `invoke` to its IPC protocol, so in-app numbers may differ.

The host also passes each frame through as raw JSON and reads only its
cursors, instead of parsing it into a tree and encoding it again: 1.3 µs
instead of 8.8 µs for a batch of four token frames, 0.21 ms instead of 0.49 ms
for a 1 MB frame (a scratch benchmark, not in the repository). Both are small
next to the 16 ms batch window.

**Requests.** Each control request opens a new loopback connection: p50
0.129 ms against the engine's `/health`, against 0.071 ms on a kept-alive
connection. Not worth pooling.

## Thread open

2026-10-04, Apple M3 Max, macOS 15.6.1, under load (load average 9 to 22 on
16 cores).

**Engine side.** `scripts/perf/thread-open.ts` starts the engine the way the
host starts a thread's (the debug build path, `bun run scripts/dev-engine.ts`),
then makes the control requests `startEngine` makes, in order, against a
seeded transcript: 2,048 timeline items, 512 turns, 5,120 records, 3.5 MB.
Three runs each:

| Backend | Spawn to `control.ready` | Live read | History read and snapshot | Live cursor | Total |
| --- | --- | --- | --- | --- | --- |
| Runrail | 163 to 166 ms | 4 ms | 24 to 25 ms | 0.2 ms | 192 to 194 ms |
| Claude Code | 157 to 160 ms | 4 ms | 23 to 24 ms | 0.2 ms | 185 to 188 ms |
| Codex | 195 to 233 ms | 5 ms | 23 to 25 ms | 0.2 ms | 224 to 261 ms |

No vendor process starts at open: every run found no process under the
engine (`pgrep -P`).

Inside the start, from the engine's own timings (`RUNRAIL_TIMINGS=1`):

| Phase | Runrail | Claude Code | Codex |
| --- | --- | --- | --- |
| Process start and module load | 87 to 91 ms | 87 to 89 ms | 87 to 96 ms |
| Runtime: policy, behavior, skills, backend | 4 to 5 ms | 4 to 5 ms | 31 to 78 ms |
| Transcript recover | 15 to 17 ms | 15 ms | 15 to 17 ms |
| History restore (Runrail) or carryover check (coding tools) | 19 ms | 16 ms | 16 to 21 ms |
| Usage totals | 17 to 19 ms | 17 to 18 ms | 17 to 18 ms |
| Git check | 13 to 16 ms | 13 ms | 13 to 14 ms |

- The transcript is read whole four times before history reaches the page:
  recover, restore or carryover, usage totals, and the history read. That is
  about 75 ms of the 190, and it grows with the transcript.
- Codex's extra runtime is `resolveCodexCommand`, which runs `codex --version`
  for the PATH install and for the app's copy: two processes on every open.

**Page side.** `scripts/perf/switchbench.swift` loads the production build on
the preview host in a visible WKWebView, opens three 2,000-item threads, then
switches between them four times. Each switch is timed from the click to the
first painted frame that shows the thread's rows. Three runs:

| Run | First opens | Revisits p50 / max |
| --- | --- | --- |
| 1 | 291, 209, 1,916 ms | 16 / 24 ms |
| 2 | 252, 200, 198 ms | 16 / 25 ms |
| 3 | 251, 200, 197 ms | 16 / 21 ms |

A revisit draws in the next frame, so the 50 ms budget holds. A first open on
the preview host includes its fake engine start, about 180 ms of timers, so
the page's own share is roughly 20 to 70 ms. The 1,916 ms open came when the
load average was 22.

In a background browser tab the same clicks read 490 to 1,030 ms. That tab
gets one animation frame a second, so it cannot time paints.

**Where a first open goes.** 190 to 260 ms of engine start come before any
history can show, plus the host's spawn and the page's share. History first
takes the engine start off that path: the system engine, already
running, reads the transcript once.

**History first, measured.** The system engine's `conversation.peek` reads the
same 2,048 items in 16 to 27 ms (`thread-open.ts`, three reads per backend's
thread). `switchbench`, same setup as above:

| | Before | With history first |
| --- | --- | --- |
| First open, first thread of a run | 251 to 291 ms | 94 to 160 ms |
| First open, next threads | 197 to 252 ms | 41 to 48 ms |
| Revisit | 7 to 25 ms | 12 to 29 ms |

The first thread of a run also waits for the app's first question to the
system engine. Rows are on screen 30 to 36 ms after the click for the next
threads. Several runs lost samples because another window came to the front
and hid the page; `switchbench` now drops a sample taken while the page was
hidden. Not measured in the running app yet.

## Not measured yet

- Frame times with the highlighting worker on an idle Mac.
- A start after a reboot (cold disk cache), for any of the three apps.
- Frame times on a 120 Hz display.
- Native cold start of a signed, notarized build.
- Batch delivery in the running app, engine to React commit, before and after
  the move to a `Channel`.
- Engine memory with the `bun run` engines debug builds now use. The resident
  memory above was measured on a debug build that ran compiled engines.
- Thread opens in the running app, and with the bundled sidecar.
  Settings → Advanced → Show the details lists each open's steps and its
  click-to-drawn time.
