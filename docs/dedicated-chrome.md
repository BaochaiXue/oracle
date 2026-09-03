---
title: Dedicated Chrome transport
description: "Oracle's canonical unattended ChatGPT transport: a persistent isolated user-data directory, loopback CDP, one-time sign-in, durable recovery, and no attachment to personal Chrome."
---

# Dedicated Chrome transport

Oracle's canonical ChatGPT lane owns a separate persistent Chrome identity and
talks to it directly through the Chrome DevTools Protocol (CDP) on loopback.
The operator signs in once. Ordinary consultations can then start, wait,
recover, and finish without attaching to the operator's personal Chrome or
asking for a new debugging approval on every connection.

Oracle owns both the exact consultation targets and the managed Chrome process
lifecycle. The operator does not need to reconcile PID files, DevTools ports,
or installed executable paths during ordinary use.

```text
                         local machine
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Codex / Claude / human                                      │
│          │ authorized prompt + selected files                │
│          ▼                                                   │
│  Oracle session authority                                    │
│    ├─ bundle + attachment manifest                           │
│    ├─ model/effort selection                                 │
│    ├─ dispatch timestamp + conversation receipt              │
│    ├─ answer capture + artifacts                             │
│    └─ reattach/follow-up lineage                             │
│          │                                                   │
│          │ CDP, 127.0.0.1:<port>                             │
│          ▼                                                   │
│  Chrome for Testing (separate macOS app identity)            │
│    └─ ~/.oracle/browser-profile                              │
│         ├─ ChatGPT login state                               │
│         ├─ ChatGPT local storage                             │
│         └─ no personal Chrome history/profile reuse          │
│                                                              │
│  Personal Chrome  ◀── no attach / no cookie copy / no app id │
└──────────────────────────────────────────────────────────────┘
```

## The Chrome boundary

Chrome's current agent documentation distinguishes two mechanisms:

| Mechanism                                            | Browser identity                     | Connection contract                                          | Human gate                                                      |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `--autoConnect` / personal-browser attach            | An already-running personal Chrome   | Agent requests a debugging session from Chrome               | Chrome displays a permission dialog for each connection attempt |
| `--remote-debugging-port` + custom `--user-data-dir` | A separately launched Chrome profile | Client connects directly to the configured loopback endpoint | First account sign-in and real account challenges only          |

Chrome 136+ ignores `--remote-debugging-port` and
`--remote-debugging-pipe` when they target the default Chrome data directory.
The switches remain supported with a non-default `--user-data-dir`. That
security change matches Oracle's desired capability boundary exactly: the
automation browser is useful because it is not the personal browser.

That is the data/debugging boundary, not the whole desktop-integration
boundary. On macOS, launching the executable inside everyday
`Google Chrome.app` with another `user-data-dir` still creates an application
whose bundle id is `com.google.Chrome`. While that process is alive,
LaunchServices can deliver an ordinary browser URL to it. Oracle therefore
uses official Chrome for Testing (with a bundle identity distinct from `com.google.Chrome`) for the
canonical macOS lane and rejects everyday Chrome for setup, smoke, and normal
dedicated runs. Chrome recommends Chrome for Testing for automation scenarios.

Primary references:

- [Chrome DevTools: configure Chrome for agents](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)
- [Chrome 136 remote-debugging security change](https://developer.chrome.com/blog/remote-debugging-port)
- [ChromeDriver: use a custom profile](https://developer.chrome.com/docs/chromedriver/capabilities)
- [Chrome for Testing: reliable automation downloads](https://developer.chrome.com/blog/chrome-for-testing/)

The docs do not phrase the manual route as an absolute promise that a consent
dialog can never appear. They do, however, describe the permission dialog as a
step in the automatic personal-browser flow and document custom-profile remote
debugging as the separate manual-connection workflow. Oracle validates the
actual local behavior with a two-cold-start smoke rather than relying on the
wording alone.

## First-time setup

After building and linking this fork, run:

```bash
oracle browser install
# macOS unattended mode; persists browser.useMockKeychain=true
oracle browser setup --use-mock-keychain
```

`browser install` downloads the current stable Chrome for Testing into
`~/.oracle/browsers` and writes the exact executable to
`~/.oracle/config.json` as `browser.chromePath`. It neither installs an app in
`/Applications` nor changes the default browser. Interrupted archive downloads
are retained and resumed by the next identical install command; the config is
updated only after unpacking and app-identity validation succeed. Use
`--no-write-config` only when another config owner will persist the returned
executable path.

`browser setup` then:

1. creates `~/.oracle/browser-profile` with owner-only directory permissions on
   Unix-like systems;
2. launches a normal Chrome for Testing window with that directory, without CDP
   or prompt automation, with browser sync and extensions disabled
   (`--use-mock-keychain` is added on macOS when explicitly configured);
3. opens `https://chatgpt.com/` visibly;
4. submits no prompt and waits while the operator signs in;
5. returns only after the entire sign-in browser exits.

Sign in to ChatGPT in that window. Google OAuth may still authenticate the
ChatGPT web session, but setup does not allow that account to import Chrome
sync data or run unrelated extensions. Keep this profile narrowly scoped: do
not use it as a general browser and do not sign unrelated accounts into it.
Close the Chrome for Testing browser after sign-in so the cold-start validation
can own the profile exclusively. Closing a single tab is insufficient.

After the first sign-in, `oracle browser status` reports the supported
operator-facing state without exposing PID, port, or executable details by
default. Use `--json` when those diagnostics are genuinely needed.

On macOS, the Chrome for Testing app identity does not own everyday Chrome's
`Chrome Safe Storage` Keychain ACL. System-Keychain mode can therefore ask for
the login password again on later cold starts. `--use-mock-keychain` makes the
choice explicit, writes `browser.useMockKeychain:true` to the user config, and
uses Chromium's deterministic test keychain consistently in setup, smoke,
normal runs, and reattach. This avoids recurring dialogs but weakens at-rest
protection for cookies in that profile. Keep the directory mode `0700`, use it
only for ChatGPT, and never copy or publish it. A profile initialized in system
mode must not be reused after switching; choose a fresh `--profile-dir`.

This behavior follows Chromium's own macOS test path: its
[test launcher adds `--use-mock-keychain` to prevent blocking permission dialogs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/test/base/test_launcher_utils.cc),
and the [mock Apple Keychain implementation returns a fixed test password](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/crypto/mock_apple_keychain.cc).
That is why the flag removes the human gate and also why the security tradeoff
must remain explicit.

Use an explicit profile path when required:

```bash
oracle browser setup \
  --profile-dir "$HOME/.oracle/browser-profile"
```

Setup refuses to launch when the same dedicated profile is already in use. It
never reuses a debug endpoint or attaches to the sign-in window. Its command
process owns the browser lifecycle, so a successful return also proves the
sign-in browser is no longer available to receive unrelated system URLs. CDP
begins only when the smoke or a normal Oracle run starts.

This separation is deliberate. Persistent CDP runs also ignore
`chrome-launcher`'s aggressive short-test defaults: Chrome's renderer
throttling, hang monitor, IPC flood protection, and Safe Browsing remain
enabled. The configured `system` or `mock` keychain mode is the only keychain
choice changed. If an Oracle Chrome ever shows abnormal memory growth,
force-quit that isolated Chrome, do not submit a duplicate consultation, and
inspect the profile/process receipt before retrying.

## Two-cold-start validation

Run this before trusting the profile for unattended work:

```bash
oracle browser smoke
```

The smoke is intentionally not an Oracle consultation. It never fills or sends
the ChatGPT composer. It performs this sequence twice:

```text
assert profile is not already in use
  → launch same user-data-dir
  → attach to 127.0.0.1:<port>
  → open ChatGPT
  → verify authenticated session
  → verify composer ready
  → record host/port/pid and promptSubmitted=false
  → close and confirm the exact smoke-owned target
  → close the CDP client and owned Chrome
  → wait until DevTools endpoint is gone
  → clear the exact dead PID receipt for the now-idle profile
  → repeat from a cold process
```

On macOS, `chrome-launcher` briefly owns an `open -W` wrapper before Chrome for
Testing settles. Smoke replaces that intermediate PID receipt with the
discovered browser owner, then gives the unchanged receipt a bounded exit grace
after the endpoint is confirmed down. A changed receipt or any Chrome still
using the profile is preserved; only unchanged dead metadata is removed.

A passing second cycle demonstrates that the important state survived the first
shutdown: the custom profile exists, its ChatGPT login is reusable, and a fresh
CDP client can attach without borrowing personal Chrome state. The command
refuses to run when the profile is already active or the requested port already
serves another DevTools endpoint; it never kills an unresolved browser process
to make the test pass. It also fails if exact target closure cannot be confirmed,
preventing smoke pages from returning through Chrome session restore.
After the second confirmed shutdown, `oracle browser status --json` reports the
profile process state as `absent`, not `stale-metadata`.

Use `--visible` to observe both validation cycles. On macOS the default smoke
keeps Chrome headful but off-screen so the page remains fully rendered.

Machine-readable output is available for diagnostics:

```bash
oracle browser smoke --json
```

The receipt includes only process/transport facts and the ChatGPT host. It does
not include cookies, tokens, account identifiers, page contents, or a prompt.

## Normal configuration

Direct CDP and the dedicated profile are the fork defaults. This explicit
configuration records the full local policy:

```json
{
  "engine": "browser",
  "model": "gpt-5-pro",
  "browser": {
    "transport": "cdp",
    "chromePath": "/Users/you/.oracle/browsers/.../Google Chrome for Testing",
    "manualLogin": true,
    "manualLoginProfileDir": "/Users/you/.oracle/browser-profile",
    "debugPort": 9333,
    "cookieSync": false,
    "hideWindow": false,
    "useMockKeychain": true,
    "browserLifetime": "while-needed",
    "modelStrategy": "select",
    "thinkingTime": "pro",
    "profileLockTimeoutMs": 300000,
    "maxConcurrentTabs": 3
  }
}
```

Important fields:

- `transport:"cdp"` selects the canonical direct transport. OpenCLI is never
  chosen implicitly.
- `chromePath` is written by `oracle browser install`. On macOS Oracle checks
  the containing app's bundle id and rejects everyday `com.google.Chrome`.
- `manualLogin:true` means “reuse Oracle's persistent isolated profile.” The
  historical option name is retained for CLI/config compatibility.
- `manualLoginProfileDir` must be a dedicated directory, never the default
  personal Chrome user-data root.
- `debugPort` is optional; Oracle can allocate and rediscover a dynamic port.
  A fixed loopback port makes local diagnostics simpler. Do not expose it on a
  non-loopback interface.
- `cookieSync:false` prevents personal Chrome cookie extraction. This is the
  default whenever the dedicated profile is active.
- `hideWindow:false` keeps normal headful Chrome visible and manually
  inspectable, actively restoring remembered off-screen bounds to an on-screen
  position once without overriding a later user-positioned window. On macOS, a
  cold start goes through LaunchServices with background-open semantics and
  `--no-startup-window`; Oracle then creates the first real page with
  `focus:false`, so neither operation activates Chrome. New targets become the
  current Chrome tab without
  activates the Chrome window or takes the operator's keyboard focus. Page-side focus
  emulation supports trusted input without changing OS focus. `true` remains an
  off-screen opt-in with reduced observability and no practical manual takeover.
- `useMockKeychain:true` is a user-config-only macOS unattended-mode choice. It
  avoids recurring Keychain approval dialogs for the isolated profile at the
  cost of deterministic, weaker at-rest cookie encryption. Do not enable it for
  an existing system-Keychain profile; create a fresh profile directory.
- `browserLifetime:"while-needed"` is the dedicated-profile default. A run owns
  its exact tab; shared Chrome remains while another lease, an unexpired
  recovery hold, or an unowned meaningful page exists, then drains after the
  last ordinary run. Use `persistent` for an explicitly always-on browser or
  `ephemeral` for one-shot process ownership. Legacy `keepBrowser:true|false`
  maps to `persistent|ephemeral`.
- `profileLockTimeoutMs` serializes the short profile/composer mutation window.
- `maxConcurrentTabs` caps simultaneous ChatGPT targets in the shared profile.

The launcher adds `--remote-debugging-address=127.0.0.1`. A caller-specific WSL
route may override that address as part of the separately documented host
bridge, but local dedicated Chrome never defaults to `0.0.0.0`.

## Managed process supervision and rollover

Three entrypoints share one dedicated-browser supervisor: consultation
startup, the final tab-lease release, and explicit `oracle browser heal`.
Under the profile lock it binds process identity and start time to the exact
profile, Chrome for Testing executable generation, and loopback DevTools port.
The owner-only runtime receipt is diagnostic evidence; it is not a reason for
the operator to manage the browser by hand.

At startup Oracle applies one bounded decision:

- reuse a healthy current generation;
- reuse a healthy older installed or receipt-backed Chrome for Testing
  generation and mark rollover pending;
- clear stale PID, port, receipt, and Chromium lock metadata when no live owner
  exists;
- terminate a verified managed process whose endpoint is unusable, then launch
  the current generation; or
- fail closed before Send when the profile owner is foreign, everyday,
  attach-running, remote, or otherwise ambiguous.

After at most one safe repair Oracle re-inspects the profile. If the state is
still inconsistent, it stops with `promptSubmitted:false`,
`externalDataSent:false`, and a plain statement that the review was not sent.
It never starts a second consultation to work around browser repair.

When the final lease releases, target reconciliation runs first. Active leases,
bounded recovery holds, and unowned meaningful pages preserve the existing
process and generation. Otherwise Oracle drains the verified idle browser,
which also completes a pending generation rollover. Termination attempts
`Browser.close` over CDP, then revalidates the same PID/start-time/profile/
executable/port identity before `SIGTERM` and, only if still necessary,
`SIGKILL`. Success requires both the process and endpoint to be gone. Cleanup
removes only runtime metadata and Chromium lock files; the persistent profile,
cookies, login state, history, and user data remain intact.

The normal operator surface is deliberately small:

```bash
oracle browser status
oracle browser heal --plan
oracle browser heal
```

`status` reports readiness, generation (`current` or `compatible update
pending`), active/recoverable consultation counts, and any human action.
`heal --plan` changes nothing. `heal` submits no prompt, preserves protected
work, and refuses an unverified owner. `oracle browser reconcile-tabs` remains
the advanced exact-target hygiene surface rather than a prerequisite for
ordinary consultations.

## Dispatch and recovery lifecycle

For a normal Pro consultation Oracle:

1. resolves and validates the authorized prompt/file bundle;
2. acquires a tab lease for the dedicated profile;
3. asks the shared supervisor to reuse, repair, roll over, or launch the exact
   managed profile before any prompt data is sent;
4. creates and records an owned target without activating the browser window,
   preserving the exact creation-time CDP target ID for its full lifetime;
5. waits for navigation to commit a new ChatGPT document rather than accepting
   the old ready `about:blank` page. If the selector is still absent on this
   Oracle-owned target, reloads that same target once and retries model
   verification; it never redirects an attached user-owned tab or creates a
   replacement target for this repair;
6. verifies ChatGPT login, model `GPT-5.6 Sol`, and reasoning tier `Pro`;
7. re-reads the visible composer and refuses to send if its exact contents were
   changed after Oracle populated it;
8. records dispatch intent at the actual Send boundary while keeping
   `promptSubmitted:false`;
9. marks `promptSubmitted:true` only after the exact user turn is verified,
   accepts the first durable conversation id/URL only when that same committed
   user-turn index and privacy-safe prompt digest are present, then freezes the
   conversation id for the rest of the run;
10. waits in the browser worker for completion instead of spawning repeated
    command/tab polls;
11. scopes thinking, assistant reads, Copy, and artifact capture to that frozen
    conversation id. Same-target navigation to another conversation fails
    closed before capture and keeps the original conversation as recovery
    authority;
12. closes its owned target after the browser turn is terminal, including when
    later evidence/admission rejects the captured result; retains that target
    only when the browser turn is genuinely incomplete/recoverable; then, after
    the last lease releases, drains the verified idle Chrome or preserves it
    for active, recoverable, or unowned meaningful work. Final-release and
    startup reconciliation close terminal owned targets and coalesce duplicate
    blank pages while preserving untracked ChatGPT conversations during
    ordinary operation.

## Target reconciliation

The operator command is plan-only unless `--apply` is explicit:

```bash
oracle browser reconcile-tabs --plan
oracle browser reconcile-tabs --apply
oracle browser reconcile-tabs --apply --include-untracked-chatgpt
```

The ordinary apply policy closes terminal Oracle-owned targets and duplicate
`about:blank`, `chrome://newtab/`, or `chrome://new-tab-page/` targets, keeping
at most one deterministic sentinel if Chrome still needs a page. It preserves
active leases, running controllers, and detached, stalled, partial, or otherwise
recoverable sessions. It also preserves every untracked ChatGPT page.

`--include-untracked-chatgpt` is an explicit historical-tab purge. It is accepted
only after Oracle proves that the live loopback DevTools process owns the exact
configured dedicated profile and is a current or compatible managed Chrome for
Testing generation.
It is never applied to `--browser-attach-running`, remote Chrome, everyday
Chrome, or another profile.

Apply re-reads the live target, active leases, durable session state, controller
liveness, and ownership evidence immediately before each close. A changed URL,
type, lease, ownership, or session classification causes a skip rather than a
stale close. The durable receipt at
`<profile>/oracle-tab-reconciliation.json` reports `complete`, `partial`, or
`failed` plus preserved, closed, skipped, and failed target IDs. Failed cleanup
does not invalidate lease release or hold the lease-registry lock; startup/reuse
retries it.

If CDP disconnects after submission, the stored runtime contains the profile,
port/browser endpoint, target, conversation receipt, and dispatch time. A
recoverable reattach opens that existing conversation and captures the answer;
it does not submit the prompt again. A connection failure before submission is
safe to retry. A state where submission may have occurred but no conversation
can be identified remains an explicit ambiguity rather than an automatic
duplicate.

The creation-time CDP target ID proves which page Oracle owns; it does not make
every later URL in that mutable page authoritative. Once a submitted turn is
bound to conversation A, a later navigation of the same target to conversation
B is recorded as a `conversation-identity` failure. Oracle does not overwrite
the stored A receipt, wait on B's thinking state, click B's Copy action, or
report B's answer as the result of A.

If ChatGPT instead renders a request-frequency/rate-limit warning before the
turn commits, Oracle stops the commit wait promptly and stores a terminal
`chatgpt-submission-gate` receipt with `promptSubmitted:false`,
`submissionCommitted:false`, `dispatchAttempted` (true or false), and
`retrySafe:true`. Recovery deliberately does not reattach or resubmit: the
operator may start a new attempt after the page/account gate clears.

## Pro request evidence and response timing

The ChatGPT picker is request-side evidence. It proves that Oracle selected the
model and reasoning controls visible in the submission tab, not that the server
honored an undocumented routing identity.

For every run whose effective reasoning tier is `pro`, Oracle records and
classifies:

```text
dispatch timestamp
       │
       └── first stable answer captured
               ├── tiny workload (≤256 estimated tokens and ≤16 KiB upload)
               │       → accept; simple Pro tasks can finish quickly
               │
               ├── substantive workload captured before 60s
               │       → terminal response-timing error
               │       → keep timing + SHA-256 only
               │
               └── substantive workload captured at or after 60s
                       → retain for normal source/runtime review
                       → timing alone still does not prove Pro
```

For direct CDP, the at-risk dispatch boundary is persisted before final target,
composer, attachment, and Send-point revalidation. Its response-timing marker is
then durably written immediately before the actual `mousePressed` or Enter
`keyDown`, so any post-boundary attachment wait is excluded from reasoning time.
The first observed elapsed time is durable runtime metadata. An 83-token fixed
reply captured in 19 seconds is valid; a 4,096-token engineering review captured
in 19 seconds is not. Runs at or above 25,000 input tokens that pass the
60-second guard but finish before 120 seconds emit an additional warning. Old
sessions created before the timing receipt existed remain readable. A migration
case with timing metadata but no workload metadata is never inferred to be
tiny: below 60 seconds stays rejected under the old fixed rule, while 60 seconds
or more remains readable. New Pro submissions fail closed if their dispatch
timestamp or workload receipt is missing.

For a direct-CDP multi-turn invocation, `proTurnIndex` plus the scalar
`proDispatchAt`, `proResponseElapsedMs`, `proInputTokens`,
`proAttachmentBytes`, `proTurnCommitted`, `proPromptSha256`, and
`proCommittedTurnIndex` describe the active or latest turn. Each accepted turn
is also appended to `proResponseTimingReceipts` with its own turn index,
dispatch, elapsed time, input estimate, uploaded bytes, normalized prompt
digest, committed DOM user-turn index, and literal `commitVerification` value
`"verified"`. Completed receipt indices are unique, contiguous, and strictly
ordered. Within the verified receipts, committed DOM user-turn indices must
also strictly advance without duplicates. The active scalar may identify the
latest completed receipt or one in-flight follow-up exactly one index beyond
it; if that next turn is already committed, its DOM user-turn index must be
greater than the last verified historical index. If a receipt for the active
scalar turn already exists, their timing, workload, and commit identities must
agree.
The initial answer and every follow-up pass timing admission before transcript
formatting, so neither a tiny first prompt nor a tiny final prompt can launder
another turn's rejected answer. Reattach verifies every self-contained receipt
against the exact committed DOM user turn before accepting a following
assistant answer; it does not reuse a previous turn's workload or identity.

Historical receipts written before the self-contained identity fields remain
readable as `legacy-partial` provenance. Oracle never backfills their prompt
digest or committed DOM index from previews, transcripts, or turn position. A
complete active/latest scalar may still be verified for recovery, but that does
not upgrade earlier identity-less receipts. Mixed chains therefore remain
`legacy-partial`; only a chain whose every completed receipt is self-contained
can be represented as `verified` multi-turn provenance.

Attachment bytes are established before each primary or fallback dispatch,
using the supplied size only when it is a valid non-negative safe integer and
otherwise reading the local file metadata. A missing or partial active-turn
workload is not completed from the initial prompt. Invalid elapsed markers and
timing markers that cannot establish elapsed time fail closed as
`pro-response-timing-indeterminate`; a valid elapsed-only legacy scalar and a
session with no timing marker keep their documented migration behavior.

The same workload-aware timing module is used by direct CDP and the optional
OpenCLI transport.

## Window policy

There are three intentionally different visual states:

| Operation                          | Policy                       | Reason                                                                        |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `oracle browser setup`             | Visible, command waits       | The operator authenticates; setup returns only after the whole browser exits. |
| Normal run with `hideWindow:false` | Visible, not activated       | Observable and manually recoverable without taking OS keyboard focus.         |
| Normal run with `hideWindow:true`  | Headful, off-screen on macOS | Opt-in desktop quieting with reduced observability and no manual takeover.    |

Headless Chrome remains available but is not the canonical ChatGPT lane because
Cloudflare or ChatGPT may treat it differently. Off-screen is not headless: a
window may flash briefly during process launch, and macOS can expose it through
window-management UI. It is not a reliable human recovery surface. Oracle
records the chosen control plan in logs rather
than claiming physical invisibility.

Off-screen isolation is not application-identity isolation. The separate
Chrome for Testing bundle prevents normal `com.google.Chrome` URL dispatch from
choosing the Oracle process; the user-data directory separately prevents data
sharing. Both are required by the macOS contract.

OpenCLI has a separate bridge-owned window policy. Selecting OpenCLI means its
extension/window lifecycle is authoritative for that run; it must not be used
to infer how the dedicated-CDP path behaves.

## Privacy and account safety

The dedicated profile reduces capability, but it still contains a live ChatGPT
session. Treat it as sensitive local state:

- keep the profile under a user-owned directory;
- never commit, upload, archive, or include it in Oracle prompt bundles;
- do not expose its CDP port beyond loopback;
- do not sign unrelated accounts into it;
- do not point Oracle at the personal Chrome user-data directory;
- stop and inspect real ChatGPT security/account challenges rather than trying
  to automate around them.

Oracle session records may contain selected local file paths, prompt material,
conversation URLs, model receipts, artifacts, and timing evidence. They must
not contain Chrome cookies, Browser Bridge credentials, access tokens, or raw
account session responses.

## Alternative paths

| Path                           | Use when                                             | Distinct boundary                                              |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| Dedicated local CDP            | Default ChatGPT work                                 | Oracle owns isolated profile and loopback endpoint.            |
| OpenCLI                        | Explicit bridge preference or CDP launch unavailable | Browser Bridge owns browser access; Oracle owns session truth. |
| Attach-running                 | Operator deliberately wants an existing browser      | Personal-browser approval and existing-browser state apply.    |
| Remote Chrome / `oracle serve` | Browser runs on another controlled host              | Network/auth boundary must be configured separately.           |
| API                            | Provider credentials and API semantics are preferred | No ChatGPT web account or browser session.                     |

There is no silent cross-path fallback after dispatch. A transport may fail
before submission and be retried explicitly; it may not hand an accepted turn
to another transport and guess whether to send it again.

## Verification for contributors

Run the source checks:

```bash
pnpm check
pnpm test
pnpm build
pnpm docs:check
pnpm test:packed-cli
```

Then, on a machine with the dedicated ChatGPT profile:

```bash
oracle browser smoke --json
```

The automated suite covers:

- managed current/compatible/foreign ownership classification and pure
  startup/heal/drain planning;
- stale PID, port, receipt, and lock recovery without deleting profile data;
- verified CDP → SIGTERM → SIGKILL escalation with ownership revalidation;
- active/recoverable preservation, idle rollover, concurrent startup locking,
  and concise status/heal output;
- dedicated-profile defaults and disabling personal cookie sync;
- owner-only profile-root creation;
- loopback debugging address on Oracle-launched Chrome;
- current `gpt-5-pro` → `GPT-5.6 Sol` + `Pro` mapping;
- dispatch receipt persistence through session results and reconnect errors;
- acceptance of fast tiny workloads and fail-closed rejection of fast
  substantive workloads;
- independent timing/workload receipts and admission for direct-CDP follow-up
  turns;
- committed prompt digest/index matching across direct-CDP timeout and reattach;
- attachment-size normalization before primary, fallback, local, or remote
  dispatch;
- fail-closed handling for partial active workload and indeterminate timing;
- fail-closed migration of legacy timing receipts whose workload is unknown;
- preservation of the first observed elapsed time across reattach;
- direct-CDP versus explicit OpenCLI configuration boundaries.

Return to [Browser Mode](browser-mode.md) for the full feature surface or the
[documentation home](index.md) for agent, MCP, API, and session guides.
