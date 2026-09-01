# Windows work notes

Read this file whenever you're working from Windows and add new findings so the next agent can stay unblocked.

- Browser engine now allowed on Windows; expect more flakiness. If automation fails, rerun with `--engine api --wait` or point `--remote-chrome` to a running Chrome with remote debugging.
- The R0-R9 Oracle v2 `broker` worker is intentionally not a native Windows
  runtime: its canonical authority channel is an owner-only Unix socket on a
  macOS GUI-session host. `oracle worker run` now fails before socket
  acquisition on native Windows; keep ordinary Windows work on the legacy
  `browser` engine until a non-macOS worker has an accepted isolation contract.
- Chrome DevTools via mcporter: `chrome-devtools` server needs `CHROME_DEVTOOLS_URL` from a live session; without it `mcporter call chrome-devtools.*` fails. Expect this to be unset on Windows unless you bring your own Chrome session/URL.
- The agent-scripts `runner` helper can fail under PowerShell/CMD because of CRLF and bash expectations. If it explodes, run commands directly (`pnpm ...`, `git add/commit`) instead.
- `scripts/browser-tools.ts start` is macOS-oriented: it shells out to `killall`,
  `mkdir -p`, and optionally `rsync`, so it is not a valid Windows launcher.
  Run browser tools from this repository when using the other subcommands, and
  use Oracle's dedicated-browser lifecycle for Windows Chrome startup.
- Prefer PowerShell + pnpm directly; watch for CRLF warnings when touching tracked files.
- Native Windows file stats do not expose POSIX permission bits. Keep sealed-content and argv tests active there, but assert owner-only `0600` modes on POSIX runners.
- Cross-platform tests should build path fragments with `node:path` and normalize CRLF before asserting multiline tracked text.
- WSL browser launch host detection: a systemd-resolved stub such as `nameserver 127.0.0.53` is guest loopback, not the Windows host. Keep resolver-derived non-loopback hosts for Windows Chrome compatibility, but route resolver-derived `127/8` values to the standard local Chrome launcher.

Future Windows gotchas belong here. Update this doc when you learn something new.

- ChatGPT sidebar/history labels can include phrases like "Login setup instruction"; login probes must match exact auth CTAs, not any visible text starting with login, or manual-login automation loops forever before typing.
- Direct-CDP retained-draft recovery has Windows live proof on candidate
  `7362caf`: a forced first trusted-click no-op produced one bounded page-side
  retry, one exact user turn, a cleared composer, and a captured Pro response;
  a first click released 1.7 seconds late was observed by the atomic retry gate,
  which cancelled the second dispatch and again produced exactly one user turn.
  Retry authorization must capture a finite turn baseline and per-document token
  before the nominal Send; post-dispatch fallback counts remain observation-only,
  and a same-target reload or replacement document fails the owner gate closed.
  Windows is the reproduction environment, not a proven platform-specific root
  cause.
- The historical `Session with given id not found.` run was emitted by
  Chromium's DevTools dispatcher for a missing flattened child session (CDP
  error `-32001`), not by the Oracle application-session store, an agent terminal
  session, or MCP. Treat that page session as stale: enumerate browser-level
  targets and attach fresh by durable target/conversation identity. Response
  recovery must remain unavailable when `proTurnCommitted:false`.
