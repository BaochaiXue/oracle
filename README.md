# Oracle × Dedicated Chrome 🧿

<p align="center">
  <img src="./README-header.png" alt="Oracle CLI header banner" width="1100">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/ChatGPT-GPT--5.6%20Pro-7257d5?style=flat-square" alt="ChatGPT GPT-5.6 Pro">
  <img src="https://img.shields.io/badge/browser-isolated%20CDP-2f80ed?style=flat-square" alt="Isolated Chrome DevTools Protocol">
  <img src="https://img.shields.io/badge/human%20gate-first%20sign--in%20only-147d64?style=flat-square" alt="First sign-in only">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/IndelibleVivi/oracle?style=flat-square" alt="License"></a>
</p>

**A recoverable browser path from coding agents to ChatGPT GPT-5.6 Pro, using an
Oracle-only Chrome profile instead of attaching to your personal browser.**

This public fork keeps [Oracle](https://github.com/steipete/oracle) in charge of
the prompt bundle, browser actions, session receipt, recovery, transcripts, and
follow-up lineage. Its canonical ChatGPT transport is deliberately simple:

```text
coding agent / human
        │  prompt + selected files
        ▼
Oracle ── session + dispatch receipt + recovery
        │
        │  CDP on 127.0.0.1
        ▼
Chrome for Testing ── ~/.oracle/browser-profile ── ChatGPT GPT-5.6 Pro
  separate app id      dedicated user-data-dir
                       ChatGPT login only
```

The installer supplies an official Chrome for Testing binary whose application
identity is separate from everyday Chrome. Setup opens the Oracle profile in
that browser as a normal window: no CDP endpoint and no prompt automation. On
macOS, the explicit mock-keychain mode adds only Chromium's keychain test flag.
The operator signs in to ChatGPT and closes the whole browser; the setup command
waits for that exit instead of leaving an orphan process. Later runs launch the
same binary and profile with a loopback debugging port,
connect directly through CDP, select the requested model and reasoning tier,
submit the turn, collect the answer, and close their tab or browser according to
the recorded policy. They do not request permission to debug the operator's
already-running personal Chrome.

[OpenCLI](https://github.com/jackwener/opencli) remains supported as an explicit
alternative/recovery transport. It is no longer required for the normal path.

## Why a dedicated profile

Chrome now documents two different agent connection paths:

- `--autoConnect` attaches to a running personal Chrome and displays a
  permission dialog whenever an agent tries to connect.
- Manual connection starts Chrome with `--remote-debugging-port` and a custom <!-- docs-check: external-flags -->
  `--user-data-dir`, then lets the client connect to that loopback endpoint. <!-- docs-check: external-flags -->

Chrome 136+ intentionally ignores remote-debugging switches against the default
Chrome data directory. A non-default user-data directory is therefore not a
workaround around the security boundary; it is the supported boundary. See
[Chrome DevTools agent configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration),
[the Chrome 136 remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port),
and [ChromeDriver custom profiles](https://developer.chrome.com/docs/chromedriver/capabilities).

On macOS, a separate `user-data-dir` isolates data but does not change an app's
LaunchServices identity. Two processes launched from `Google Chrome.app` are
still `com.google.Chrome`, so an Oracle window can receive a normal “Open in
Chrome” event. Chrome itself recommends
[Chrome for Testing for browser automation](https://developer.chrome.com/blog/chrome-for-testing/).
This fork therefore uses both boundaries: a Chrome for Testing app identity
and an Oracle-only user-data directory. A canonical macOS run fails closed if
its executable resolves to everyday `Google Chrome.app`.

This fork turns that distinction into a product contract:

| Boundary          | Owner              | Contract                                                                                 |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Prompt and files  | Oracle             | Assemble locally and send only the selected context.                                     |
| Session truth     | Oracle             | Persist dispatch state, conversation identity, answer, artifacts, and follow-up lineage. |
| Browser process   | Oracle             | Launch a non-default persistent profile and bind CDP to `127.0.0.1`.                     |
| App identity      | Chrome for Testing | Do not register an Oracle process as everyday `com.google.Chrome` on macOS.              |
| Browser data      | Dedicated profile  | Keep ChatGPT login state separate from personal browsing and other accounts.             |
| Account decisions | Human              | Perform the first sign-in and resolve real account or anti-bot challenges.               |

The profile root is created with owner-only permissions on Unix-like systems.
Oracle never points its launcher at the default personal Chrome data directory.

Read the full lifecycle and trust model in
[Dedicated Chrome transport](docs/dedicated-chrome.md).

## Install this fork

The published npm and Homebrew packages are upstream Oracle and do not include
these fork changes. Install this repository from source:

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install
pnpm build
npm link
```

Requirements:

- Node.js 24 or newer.
- Official Chrome for Testing (installed by the command below), or an explicit
  compatible Chromium browser with a separate app identity.
- A ChatGPT account with access to the requested model/tier.
- One local directory dedicated to Oracle's browser identity. The default is
  `~/.oracle/browser-profile`.

Install the official stable automation browser. This stores it under
`~/.oracle/browsers`, writes its executable to `browser.chromePath`, and does
not change the system default browser. If the archive download is interrupted,
rerun the same command; Oracle resumes the retained partial archive instead of
starting it again from byte zero:

```bash
oracle browser install
```

Open the dedicated profile for the one-time sign-in:

```bash
# macOS unattended mode: persists browser.useMockKeychain=true
oracle browser setup --use-mock-keychain
```

The command remains attached while the sign-in window is open. Sign in to
ChatGPT, then close the **entire Chrome for Testing browser**; only then does
setup return. Setup disables browser sync and extensions, so a Google OAuth
sign-in cannot turn the dedicated profile into a copy of the operator's normal
browser. Validate the steady-state transport without sending a prompt:

```bash
oracle browser smoke
```

The smoke performs two real cold starts against the same profile. Each cycle
connects over `127.0.0.1`, verifies that ChatGPT is authenticated and the
composer is ready, submits no prompt, closes Chrome, and waits for the endpoint
to disappear before the second cycle. A passing result is direct evidence that
the persisted login and unattended CDP attachment work after restart.

On macOS, `--use-mock-keychain` is the explicit unattended-mode tradeoff. It
prevents Chrome for Testing from repeatedly requesting access to the everyday
Chrome Safe Storage item and persists the setting for setup, smoke, normal
runs, and reattach. Chromium's mock keychain uses a deterministic test secret,
so the dedicated profile has weaker at-rest cookie protection than a
system-Keychain-backed profile. Keep the profile owner-only and ChatGPT-only.
If a profile was previously opened with the system Keychain, use a fresh
`manualLoginProfileDir` when switching modes; the old encrypted cookies are not
portable between the two modes.

Port `9333` is used by the smoke and ordinary CDP runs by default. Setup does
not open a debugging port. If `9333` is occupied, choose another explicit port
for the smoke and use the same value as `browser.debugPort`:

```bash
oracle browser smoke --port 9444
```

## Configure the canonical browser lane

`cdp` and the isolated persistent profile are the defaults in this fork. A
deliberately explicit macOS configuration looks like this:

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
    "browserLifetime": "while-needed",
    "useMockKeychain": true,
    "modelStrategy": "select",
    "thinkingTime": "pro",
    "profileLockTimeoutMs": 300000,
    "maxConcurrentTabs": 3
  }
}
```

`oracle browser install` writes the exact `chromePath`; the abbreviated path
above is illustrative. `hideWindow:false` keeps normal macOS runs visible and
human-observable, restoring only a previously hidden persistent window without
overriding a later user-positioned window. A cold start uses macOS LaunchServices
background-open semantics so the first visible window also leaves the active app
alone. `browserLifetime:"while-needed"` keeps the shared dedicated Chrome only
while an active lease, unexpired recovery hold, or unowned meaningful page
needs it. Completed Oracle tabs close by exact target/conversation receipts and
the last ordinary run drains Chrome. `persistent` is the explicit always-on
choice; legacy `keepBrowser:true|false` maps to `persistent|ephemeral`. Oracle opens targets with CDP
`Target.createTarget({background:false, focus:false})` and uses page-side focus
emulation, so it can operate the visible page without activating Chrome or
taking the operator's keyboard focus.
`oracle browser setup` is always visible because signing in is a human action;
it is an ordinary isolated Chrome launch with CDP disabled. Persistent CDP
runs retain Chrome's renderer throttling, hang monitor, IPC flood protection,
and Safe Browsing instead of inheriting the aggressive flags intended for
short browser test jobs. `useMockKeychain:true` changes only the macOS keychain
backend for the isolated profile.
`hideWindow:true` remains an opt-in off-screen mode for operators who accept
reduced observability and no practical manual takeover.

If ChatGPT displays a request-frequency gate before the user turn enters the
conversation, Oracle records `promptSubmitted:false`,
`submissionCommitted:false`, and `retrySafe:true`. It does not wait for an
assistant that was never invoked, reattach, or automatically click Send again.

Send a normal consultation directly:

```bash
oracle --engine browser \
  --model gpt-5-pro \
  -p "Audit this change for correctness and missing tests." \
  --file "src/**"
```

For an unusually large or uncertain bundle, add
`--dry-run summary --files-report` as an optional scope diagnostic; it is not a
normal dispatch prerequisite. Long answers remain recoverable Oracle sessions:

```bash
oracle status --hours 72
oracle session <session-id> --render
oracle --followup <session-id> \
  -p "Challenge the previous recommendation and return the final decision."
```

Do not start a duplicate consultation merely because Pro is quiet. Oracle
stores the conversation and runtime receipt so the existing run can be
reattached instead.

## The GPT-5.6 Pro naming contract

The effective browser target and its UI controls have different names:

| Layer                | Name            | Meaning                                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------------------ |
| Human-facing product | **GPT-5.6 Pro** | The effective ChatGPT browser experience this fork targets.                    |
| Oracle browser alias | `gpt-5-pro`     | Stable CLI alias for the moving current Pro browser lane; not an API model ID. |
| ChatGPT model        | `GPT-5.6 Sol`   | Exact model Oracle selects and verifies in the live submission tab.            |
| ChatGPT reasoning    | `Pro`           | Exact Intelligence tier Oracle selects and verifies for that model.            |

`gpt-5.5-pro` remains Oracle's upstream API model/default and is intentionally
not renamed. Versioned legacy browser aliases remain pinned to their documented
families; the unversioned `gpt-5-pro` alias moves with the current fork target.

Picker evidence proves what Oracle requested in the visible UI. It cannot prove
ChatGPT's server-side routing identity. Oracle records the durable dispatch
timestamp and elapsed time to the first stable captured answer. Tiny workloads
(at most 256 estimated input tokens and 16 KiB of uploaded payload) may
legitimately finish in seconds. Substantive workloads below that 60-second guard
remain fail-closed as a routing-anomaly precaution; only the answer digest and
timing evidence survive. Very large runs that pass the guard but still finish
unexpectedly quickly emit an additional warning.

The workload-aware timing guard is transport-independent and applies to both
direct CDP and OpenCLI. In a direct-CDP multi-turn run, the initial prompt and
every follow-up are admitted independently using that submitted turn's own
dispatch, elapsed time, token estimate, and upload bytes; a later tiny turn
cannot make an earlier rejected turn part of a trusted transcript. Missing
attachment sizes are read from the file before dispatch, and missing or partial
active-turn workload is never filled from the initial prompt. Direct-CDP
recovery also requires a verified committed user turn whose normalized prompt
digest matches the stored turn identity. During reattach, an older timing
receipt without workload metadata keeps the previous fixed rule: below 60
seconds remains rejected, while 60 seconds or more remains readable. Sessions
with no timing receipt keep the older legacy-read policy; a timing marker whose
elapsed value cannot be established fails closed.

## Window, concurrency, and recovery behavior

The normal direct-CDP lifecycle is deterministic:

1. Oracle acquires a profile/tab lease.
2. It reuses the already-running dedicated Chrome only when the profile and
   loopback DevTools receipt match; otherwise it cold-starts the profile.
3. Every submission gets its own target identity and durable dispatch time.
4. Long waiting happens inside the browser worker, not by repeatedly waking the
   calling coding model or opening duplicate sessions.
5. A recoverable connection drop reattaches to the stored conversation. It does
   not silently submit the same turn again.
6. A completed run closes its owned target; an incomplete run retains only its
   exact target under a bounded recovery hold. With `while-needed`, the last
   lease drains Chrome only when no recovery or unowned meaningful page remains.
   Cold-start and final-release reconciliation use stored ownership receipts,
   revalidate each target immediately before closing it, and coalesce duplicate
   blank pages to at most one sentinel. Ordinary reconciliation never closes an
   untracked ChatGPT conversation or uses a first-tab/URL-wide conversation
   sweep.

Inspect the exact running dedicated profile without changing it:

```bash
oracle browser reconcile-tabs --plan
```

`--apply` closes only terminal Oracle-owned targets and duplicate blank pages;
active leases plus running, detached, partial, stalled, or otherwise recoverable
sessions survive. An operator may add `--include-untracked-chatgpt` to purge
historical untracked ChatGPT pages, but only for the exact local Chrome for
Testing profile Oracle verifies. The command refuses attach-running, remote,
everyday Chrome, and mismatched profiles. If apply-time evidence changes, the
target is skipped. Receipts are written to
`<profile>/oracle-tab-reconciliation.json` with `complete`, `partial`, or
`failed` status; failed work is retried on the next dedicated-profile
startup/reuse.

Up to three ChatGPT tabs may share the dedicated profile by default. Startup and
composer mutation are separately locked so parallel agents do not race one
another into the same tab. Tune the soft tab limit with
`browser.maxConcurrentTabs` or `ORACLE_BROWSER_MAX_CONCURRENT_TABS`.

## Alternative OpenCLI transport

OpenCLI Browser Bridge remains useful when direct CDP cannot be launched or when
an operator explicitly prefers the bridge. It is opt-in and never an automatic
fallback:

```json
{
  "browser": {
    "transport": "opencli",
    "modelStrategy": "select"
  }
}
```

Install and validate the companion adapters before using that path:

```bash
npm install -g @jackwener/opencli@1.8.6
node scripts/install-opencli-submit-file-adapter.mjs
opencli validate chatgpt/submit-file
opencli validate chatgpt/oracle-wait
```

OpenCLI owns its own browser/window behavior and ephemeral tab leases. Oracle
still owns the sealed payload, dispatch journal, conversation receipt, answer,
and waiter-only recovery. There is no OpenCLI-to-CDP or CDP-to-OpenCLI fallback
after dispatch. See [OpenCLI alternative transport](docs/opencli-transport.md).

## Current fork scope

| Capability                                | Dedicated CDP |       OpenCLI alternative |
| ----------------------------------------- | ------------: | ------------------------: |
| New GPT-5.6 Pro text consult              |           Yes |                       Yes |
| Persistent isolated ChatGPT login         |           Yes |      Browser Bridge-owned |
| No recurring personal-Chrome Allow dialog |           Yes |                       Yes |
| Files and prompt                          |           Yes |     Yes, sealed artifacts |
| Durable conversation receipt              |           Yes |                       Yes |
| Recovery without resubmission             |           Yes |                       Yes |
| Oracle `--followup` lineage               |           Yes |                       Yes |
| Same-invocation browser follow-ups        |           Yes |      No; use `--followup` |
| Deep Research                             |           Yes | No; fails before dispatch |
| Image generation/download                 |           Yes | No; fails before dispatch |
| Workload-aware Pro timing guard           |           Yes |                       Yes |
| Automatic cross-transport fallback        |         Never |                     Never |

Attach-running against a personal Chrome, remote Chrome, Gemini web, API, MCP,
and render paths remain available as separate explicit modes. Their trust and
account boundaries are documented in [Browser Mode](docs/browser-mode.md).

## Upstream Oracle

Oracle is a CLI and MCP server that bundles a prompt with selected files, sends
that context through an API or signed-in browser, and stores the result as a
session. Upstream supports OpenAI, Azure OpenAI, Anthropic, Gemini, xAI,
OpenRouter, compatible endpoints, direct Chrome automation, and a manual
`--render --copy` fallback.

Upstream packages:

```bash
brew install steipete/tap/oracle
npm install -g @steipete/oracle
npx -y @steipete/oracle --help
```

Those commands install [steipete/oracle](https://github.com/steipete/oracle),
not this fork. Full upstream documentation is at
[askoracle.sh](https://askoracle.sh).

## Documentation

| Start here                                                                      | Deeper reference                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Dedicated Chrome transport](docs/dedicated-chrome.md)                          | Canonical topology, setup, lifecycle, privacy, and verification               |
| [Browser Mode](docs/browser-mode.md)                                            | Direct CDP, attach-running, remote Chrome, OpenCLI, Deep Research, and images |
| [Quickstart](docs/quickstart.md)                                                | First sign-in, smoke, first consult, API, render, and reattach                |
| [OpenCLI alternative](docs/opencli-transport.md)                                | Sealed bridge handoff and waiter-only recovery                                |
| [Coding Agents](docs/agents.md)                                                 | Codex, Claude Code, Cursor, CLI, and MCP patterns                             |
| [Sessions](docs/sessions.md) · [Follow-ups](docs/followup.md)                   | Durable runs and conversation lineage                                         |
| [Configuration](docs/configuration.md) · [CLI reference](docs/cli-reference.md) | Config precedence, flags, and limits                                          |

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm docs:check
pnpm test:packed-cli
```

The timing tests cover both transports, including fast tiny-workload acceptance,
substantive-workload rejection, and persistence across reattach. `oracle browser
smoke` is the account-safe live transport test: it cold-starts twice and never
submits a conversation.

## Provenance and license

This is a public fork of [steipete/oracle](https://github.com/steipete/oracle),
preserving upstream history and MIT licensing. The dedicated-profile defaults,
transport-independent workload-aware Pro timing guard, and OpenCLI alternative
are fork features; this is not an upstream release or an OpenAI product.

MIT. See [LICENSE](LICENSE).
