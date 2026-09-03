# Browser Mode

Oracle's `--engine browser` supports four explicit execution paths:

- **Dedicated local CDP** (canonical for ChatGPT GPT models): Oracle launches a
  non-default persistent Chrome profile, binds CDP to loopback, and drives the
  ChatGPT UI without attaching to personal Chrome.
- **OpenCLI Browser Bridge** (optional GPT-5.6 Pro text lane): Oracle owns the
  sealed turn/session while OpenCLI owns browser access and ephemeral tab
  leases.
- **Attach-running or remote Chrome** (operator-controlled): Oracle connects to
  an already-running CDP endpoint. Personal-browser approval and remote-network
  boundaries apply separately.

## Dedicated local CDP (default)

The default direct transport uses `~/.oracle/browser-profile` as an
Oracle-only Chrome user-data directory. Cookie sync from personal Chrome is
disabled. The first run is an explicit sign-in setup; normal runs reuse that
profile and connect directly over `127.0.0.1`.

```bash
oracle browser install
oracle browser setup --use-mock-keychain # recommended for unattended macOS use
# sign in to ChatGPT, then close the entire Chrome for Testing browser
oracle browser smoke
```

`oracle browser smoke` cold-starts the same profile twice, verifies login and a
ready composer on both starts, and submits no prompt. It is the acceptance test
for persistent login plus unattended CDP attachment. See
[Dedicated Chrome transport](dedicated-chrome.md) for the official Chrome
connection distinction, security boundary, lifecycle, and exact smoke receipt.

On macOS, run `oracle browser install` before setup. It installs official Chrome
for Testing under `~/.oracle/browsers` and records its executable. A separate
`user-data-dir` protects browser data; the Chrome for Testing bundle id also
prevents the Oracle process from receiving ordinary URLs intended for everyday
`Google Chrome.app`. Canonical dedicated runs fail closed if configured with
the shared `com.google.Chrome` app identity.

Chrome for Testing can otherwise request access to everyday Chrome's Safe
Storage Keychain item again on each macOS cold start. The explicit
`--use-mock-keychain` setup option persists `browser.useMockKeychain:true` and
keeps setup, smoke, normal runs, and reattach on Chromium's deterministic test
keychain. This removes recurring permission dialogs but weakens at-rest cookie
protection; keep the profile owner-only, ChatGPT-only, and use a fresh directory
when switching modes.

Run a consultation:

```bash
oracle --engine browser \
  --browser-transport cdp \
  --model gpt-5-pro \
  -p "Audit this change for correctness and missing tests." \
  --file "src/**"
```

On macOS, keep `browser.hideWindow:false` when normal runs should be visible and
manually inspectable. A cold start is background-opened through LaunchServices;
later targets use `focus:false` plus page-side focus emulation, so neither path
activates Chrome over the current app. `true` is an explicit off-screen mode
with reduced observability and no practical manual takeover; setup remains
visible in either policy. Oracle never describes an off-screen window as headless.

`oracle --engine browser` routes the assembled bundle through the selected web
transport instead of the Responses API. Legacy `--browser` still aliases it.
If `--engine` is omitted, Oracle follows `ORACLE_ENGINE` and effective config,
then selects API when credentials are available and browser otherwise. Agent
workflows should choose an engine explicitly.

`--dry-run`/legacy `--preview` work with browser mode: Oracle renders the
composed prompt, lists uploaded versus inlined files, and reports bundle and
control policy without launching Chrome.

### GPT-5.6 Pro naming and timing

- `gpt-5-pro` is the stable moving alias for the current effective browser Pro
  target; it is not an API model id.
- `GPT-5.6 Sol` is the model Oracle selects and verifies in ChatGPT.
- `Pro` is the reasoning tier Oracle selects and verifies.
- **GPT-5.6 Pro** is the human-facing combination.

The model picker proves requested UI state, not server-side routing. Both direct
CDP and OpenCLI record dispatch intent and the elapsed time to the first stable
Pro answer. Tiny workloads can legitimately complete in seconds and are exempt
from duration admission. Substantive workloads captured below 60 seconds fail
closed with only digest/timing evidence retained. Very large runs that pass the
guard but still complete unexpectedly quickly add a warning for operator review.

Direct-CDP follow-ups use one receipt per submitted turn. The active turn's
scalar runtime fields identify the turn recoverable by reattach, while completed
turn receipts retain that turn's dispatch timestamp, first stable-answer
elapsed time, input estimate, and uploaded bytes. Oracle admits each turn before
adding it to a multi-turn transcript. OpenCLI remains single-turn in this
surface and keeps its existing scalar receipt compatibility.

The active direct-CDP receipt also stores commit state, the exact committed
user-turn index, and a SHA-256 digest of normalized prompt text. Reattach must
match that digest at that index before waiting for its assistant successor; an
uncommitted or mismatched turn is terminal instead of falling back to an older
answer. Missing attachment sizes are established from the local file before
dispatch. Partial active workload and timing markers with no valid elapsed
value remain unknown and fail closed rather than borrowing initial-turn data.

Direct CDP distinguishes a Send attempt from a committed user turn. A visible
request-frequency warning detected before any potentially submitting input
event produces a terminal, retry-safe receipt with `promptSubmitted:false`.
After `mousePressed` or Enter `keyDown`, an unverifiable commit is instead
indeterminate and recoverable with `retrySafe:false`; Oracle preserves the exact
tab, persists `incomplete-capture` session state for explicit reattach, and does
not redispatch or wait for a response whose existence is unknown. The durable
dispatch-boundary marker must be written before either event; persistence
failure prevents dispatch. Copied-profile runs remain retry-unsafe but are
explicitly non-reattachable because their temporary profile is always removed.

## OpenCLI Browser Bridge (explicit alternative)

Select OpenCLI when you deliberately prefer Browser Bridge or cannot launch
the dedicated CDP profile. It is never an automatic fallback:

```bash
npm install -g @jackwener/opencli@1.8.6
node scripts/install-opencli-submit-file-adapter.mjs
opencli validate chatgpt/submit-file
opencli validate chatgpt/oracle-wait

oracle --engine browser \
  --browser-transport opencli \
  --model gpt-5-pro \
  -p "Audit this change for correctness and missing tests." \
  --file "src/**"
```

Oracle stores a mode-`0600` payload/manifest, selects and verifies
`GPT-5.6 Sol` plus `Pro` in the exact submission tab, records a structured
conversation receipt, and starts one read-only waiter command. The waiter owns
one isolated tab for the whole harvest; it does not open a new process/tab on
every observation. Recovery after a receipt exists runs the waiter only and
does not resubmit.

OpenCLI requests background window mode, but Browser Bridge owns the physical
window/tab presentation. A Chrome window may be visible or focused; do not use
that observation to infer the dedicated-CDP window policy.

OpenCLI currently supports sealed GPT-5.6 Pro text turns and normal Oracle
`--followup` lineage. Image generation, Deep Research, and same-invocation
`--browser-follow-up` fail before dispatch. See
[OpenCLI alternative transport](opencli-transport.md) for its full failure and
privacy contract.

## Quick example: browser mode with custom cookies

This is a non-canonical ephemeral-profile path for compatibility. Set
`browser.manualLogin:false` in the effective config before supplying inline
cookies; otherwise the dedicated profile intentionally ignores personal-cookie
seeding.

```bash
# Minimal inline-cookies flow: keep ChatGPT logged in without Keychain
jq '.' ~/.oracle/cookies.json  # file must contain CookieParam[]
oracle --engine browser \
  --browser-inline-cookies-file ~/.oracle/cookies.json \
  --model gpt-5.5 \
  --browser-thinking-time pro \
  -p "Run the UI smoke" \
  --file "src/**/*.ts" --file "!src/**/*.test.ts"
```

`~/.oracle/cookies.json` should be a JSON array shaped like:

```json
[
  {
    "name": "__Secure-next-auth.session-token",
    "value": "<token>",
    "domain": "chatgpt.com",
    "path": "/",
    "secure": true,
    "httpOnly": true
  },
  { "name": "_account", "value": "personal", "domain": "chatgpt.com", "path": "/", "secure": true }
]
```

You can pass the same payload inline (`--browser-inline-cookies '<json or base64>'`) or via env (`ORACLE_BROWSER_COOKIES_JSON`, `ORACLE_BROWSER_COOKIES_FILE`). Cloudflare cookies (`cf_clearance`, `__cf_bm`, etc.) are only needed when you hit a challenge.

## Quick example: attach to your running Chrome

Use this when you already have a signed-in Chrome session running with DevTools access enabled and want Oracle to reuse that browser instead of launching its own copy.

```bash
oracle --engine browser \
  --browser-attach-running \
  --model gpt-5.5 \
  --browser-thinking-time pro \
  -p "Summarize the last assistant response in one paragraph"
```

Notes:

- `--browser-attach-running` defaults to local attach discovery at `127.0.0.1:9222`.
- If the browser UI shows a different local endpoint, you can point Oracle at it explicitly:
  ```bash
  oracle --engine browser \
    --browser-attach-running \
    --remote-chrome 127.0.0.1:63332 \
    --model gpt-5.5 \
    --browser-thinking-time pro \
    -p "Summarize the last assistant response in one paragraph"
  ```
- Oracle reads local `DevToolsActivePort` metadata, connects to the browser websocket directly, and then reuses the normal CDP automation flow.
- If Chrome shows a remote-debugging approval prompt on first attach, Oracle issues one attach request and waits briefly for you to allow it before failing.
- Attach mode always opens a fresh Oracle-owned tab and closes only that tab after a successful run.
- Cookie sync, Chrome launch flags, and profile lifecycle flags are skipped because the browser is already running.
- If Chrome is not exposing a classic `/json/version` endpoint, use `--browser-attach-running` instead of standalone `--remote-chrome`.

## Current Pipeline

1. **Prompt assembly** – we reuse the normal prompt builder (`buildPrompt`) and the markdown renderer. Browser mode pastes the system + user text (no special markers) into the ChatGPT composer and, by default, pastes resolved file contents inline until the total pasted content reaches ~60k characters (then switches to uploads).
2. **Automation stack** – code lives under `src/browser/`:
   - Canonical launcher mode starts Oracle's persistent non-default profile via `chrome-launcher`, binds CDP to loopback, and connects with `chrome-remote-interface`.
   - Attach-running mode reads local `DevToolsActivePort` metadata for the selected local port, connects to the browser websocket, opens a dedicated tab, and reuses the same DOM automation/capture flow against that attached browser.
   - Ephemeral compatibility mode can optionally copy cookies from an explicitly requested browser profile. The dedicated-profile default never copies personal Chrome cookies.
   - Navigates to `chatgpt.com`, switches to the requested current model (including `GPT-5.6 Sol`) and reasoning tier, optionally activates Deep Research, pastes the prompt, waits for completion, and captures Markdown through the built-in “copy turn” action.
   - After Send commits, binds the first durable conversation URL only when the exact committed user-turn digest is present. That conversation ID is immutable capture authority: if the same CDP target later navigates to another conversation, thinking/response/Copy capture stops and the original conversation remains recoverable.
   - Immediately probes the cookie-authenticated `/api/auth/session` endpoint in the ChatGPT tab and checks only whether it contains a user; returned tokens are never logged. If that endpoint is unavailable, Oracle falls back to the legacy `/backend-api/me` probe and a visible composer plus profile or chat-history authentication signals. Auth pages, visible login controls, resolved sessions without a user, composer-only shells, and pages without profile/history signals still fail with login guidance.
   - When `--file` inputs would push the pasted composer content over ~60k characters, we switch to uploading attachments (optionally bundled). Oracle first waits for every expected attachment to settle while the prompt is intentionally empty; ChatGPT may keep Send disabled in that state. It then composes the exact system+user prompt, re-verifies the attachments, and requires an enabled Send button before clicking.
   - Immediately before dispatch, Oracle activates the exact owned target, rechecks ownership and the visible composer, and measures a fresh trusted Send point. Coordinate clicks and Enter share the same exact-turn verification. The durable dispatch-boundary marker must be persisted before either potentially submitting input event. Enter is permitted as an alternate only when trusted-click emitted no potentially submitting input event at all. Once `mousePressed` or Enter `keyDown` has been emitted, Oracle never changes methods or dispatches again automatically.
   - Oracle refuses to overwrite or append to non-empty composer content it cannot prove it owns. After a potentially submitting event, retained drafts and cleared-but-unobserved commits are classified as indeterminate/recoverable with `retrySafe:false` and keep their exact tab with sanitized submission diagnostics. Preserve that session and inspect it with `oracle session <id> --render`; do not rerun the prompt while commit state is uncertain.
   - A first non-empty composer observation receives up to five seconds of read-only settling checks for transient profile/SPA restoration; persistent content remains untouched. Before any submitting event, an attachment Send-readiness failure may clear only the current attempt's attachments and exact prompt after exact-target, ownership, current full-prompt, and exact attachment-set re-verification. Verified cleanup records `retrySafe:true`; unverifiable or partial cleanup retains the exact tab with `retrySafe:false`.
   - Dedicated mode treats the persistent profile as a shared browser-scope resource while process lifetime defaults to `while-needed`; each run owns only its exact tab, and the last lease drains Chrome when no recovery hold or unowned meaningful page remains. Ephemeral mode removes its temporary profile unless explicitly retained.

3. **Session integration** – browser sessions use the normal log writer, add `mode: "browser"` plus `browser.config/runtime` metadata, and persist Chrome pid/port or websocket attach metadata plus the Oracle-owned target and committed conversation URL for reattach. A later URL observed in that mutable target cannot replace the committed conversation receipt.
4. **Usage accounting** – we estimate input tokens with the same tokenizer used for API runs and estimate output tokens via `estimateTokenCount`. `oracle status` therefore shows comparable cost/timing info even though the call ran through the browser.

### CLI Options

- `--engine browser`: enables browser mode (legacy `--browser` remains as an alias for now). Without `--engine`, Oracle chooses API when `OPENAI_API_KEY` exists, otherwise browser.
- `--browser-transport <opencli|cdp>`: choose the ChatGPT browser boundary. `cdp` is the canonical isolated-profile transport; `opencli` is the authenticated Browser Bridge alternative. Neither silently falls back to the other after dispatch.
- `--browser-chrome-path`: override the Chrome/Chromium binary. `--browser-chrome-profile` selects a profile only for explicit cookie/copy compatibility paths; canonical dedicated mode uses its own user-data directory.
- `--browser-cookie-path`: explicit path to the Chrome/Chromium/Edge `Cookies` SQLite DB. Handy when you launch a fork via `--browser-chrome-path` and want to copy its session cookies; see [docs/chromium-forks.md](chromium-forks.md) for examples.
- `--browser-attach-running`: attach to a local already-running browser instead of launching Chrome directly. Defaults to `127.0.0.1:9222`; combine with `--remote-chrome <host:port>` to use a different local attach hint.
- `--chatgpt-url`: override the ChatGPT base URL. Works with the root homepage (`https://chatgpt.com/`), Temporary Chat (`https://chatgpt.com/?temporary-chat=true`), **or** a specific workspace/folder link such as `https://chatgpt.com/g/.../project`. `--browser-url` stays as a hidden alias.
- `--browser-timeout`, `--browser-input-timeout`, `--browser-attachment-timeout`: `1200s (20m)`/`60s`/`45s` defaults. The attachment timeout controls upload/readiness before clicking Send and can also be set with `ORACLE_BROWSER_ATTACHMENT_TIMEOUT` or `browser.attachmentTimeoutMs`. Durations accept `ms`, `s`, `m`, or `h` and can be chained (`1h2m10s`).
- `--browser-recheck-delay`, `--browser-recheck-timeout`: after an assistant timeout, wait the delay, revisit the conversation, and retry capture (default recheck timeout 120s). Useful for Pro runs that finish later.
- `--browser-reuse-wait`: wait for the dedicated profile's existing `DevToolsActivePort` before launching Chrome. This lets concurrent callers converge on one owned process.
- `--browser-profile-lock-timeout`: wait for the dedicated profile lock before sending, serializing startup and composer mutation across parallel runs.
- `--browser-max-concurrent-tabs`: soft limit for simultaneous ChatGPT tabs sharing the dedicated profile (default `3`). Set `ORACLE_BROWSER_MAX_CONCURRENT_TABS` for a per-host default; explicit CLI/config values win. Additional runs wait up to the browser timeout for a slot and log `[browser] Waiting for ChatGPT browser slot...`.
- `--browser-auto-reattach-delay`, `--browser-auto-reattach-interval`, `--browser-auto-reattach-timeout`: after an actual timeout, periodically retry capture from the stored conversation (delay, interval, and per-attempt timeout). Normal direct CDP waits in one browser worker; OpenCLI waits in one long-lived tool-side waiter. Neither requires the calling coding model to poll or open duplicate tabs. Auto-reattach is disabled by default.
- `--heartbeat`: browser mode uses this interval to emit long-run ChatGPT status. When ChatGPT exposes a Thinking/Reasoning disclosure, Oracle opens it and logs only liveness metadata such as sidecar presence, UI progress percentage, elapsed time, and last-change age. It does not log the reasoning text.
- If an assistant response still times out (common with long Pro runs), Oracle marks the session as an incomplete capture, stores reattach/runtime diagnostics, and keeps enough browser metadata for `oracle session <id>` to recover the final answer. Visible ChatGPT rate-limit, temporary-unavailable, and authentication/challenge warnings are included in the error and session metadata instead of being reduced to a generic timeout. Increase `--browser-timeout` only when the browser session is truly unrecoverable.
- `--browser-model-strategy <select|current|ignore>`: control ChatGPT model selection. `select` (default) switches to the requested model; `current` keeps the active model and logs its label; `ignore` skips the picker entirely.
- Temporary Chat can reduce account-sidebar clutter for one-shot browser consults, but it is a different ChatGPT workflow and the local transcript/artifacts are the durable record. Verify live behavior before relying on Project Sources, Deep Research reports, or multi-turn persistence.
- `--browser-thinking-time <light|standard|extended|extra-high|pro|heavy>`: set the ChatGPT thinking-time intensity. The unversioned `--model gpt-5-pro` selects `GPT-5.6 Sol` with Pro effort automatically; versioned legacy Pro aliases remain pinned to their documented family. Because Pro is expensive and rate-limited, `pro` fails closed: an unconfirmed selection aborts instead of quietly submitting at a cheaper tier. Effort rows are matched across the currently supported UI languages. In ChatGPT's current unified Intelligence picker Oracle verifies model identity separately, then adopts a Power slider only when it is a visible, interactive, valid five-position ARIA control. After bounded navigation, both the maximum numeric position and an exact `Pro` semantic label or effort pill must agree; Unicode whitespace and punctuation are accepted without parsing locale-specific ordinal grammar, while position-only, `Professional`, malformed, or contradictory states fail closed. Older unified-picker layouts continue through `Advanced` → `Effort`; Oracle declines to guess when neither control can be verified. Failure diagnostics include the requested model/effort, independent model-verification receipt, page locale, picker shape, bounded slider state/label, and structural role/testid summaries—never composer, conversation, or sidebar text.
- GPT-5.6 Pro is represented in the current ChatGPT UI as model `GPT-5.6 Sol` plus effort `Pro`. Oracle verifies both selections independently and **fails closed** rather than silently submitting at a weaker model or effort. Detection failures write a bounded, redacted picker diagnostic to the normal session log. Versioned GPT-5.5/5.4 aliases retain their legacy picker contracts instead of being silently remapped.
- `--browser-research deep`: activate ChatGPT Deep Research before submitting the prompt. Use this for broad public-web research and final cited reports, not as a replacement for GPT-5.x Pro Heavy code review or pure reasoning.
- `--browser-follow-up <prompt>`: submit another prompt in the same ChatGPT conversation after the initial answer. Repeat the flag for multi-turn reviews such as “challenge your recommendation”, “compare against this constraint”, then “give the final decision”. Deep Research has its own report lifecycle, so browser follow-ups are rejected when `--browser-research deep` is enabled.
- `--followup <session-id>`: reopen the exact saved ChatGPT conversation from a completed browser session. Oracle inherits the parent browser profile, configuration, and model, then verifies the thread and prior turns before submitting.
- `--browser-port <port>` (alias: `--browser-debug-port`; env: `ORACLE_BROWSER_PORT`/`ORACLE_BROWSER_DEBUG_PORT`): pin the DevTools port (handy on WSL/Windows firewalls). When omitted, a random open port is chosen.
- `ORACLE_CHATGPT_ACCOUNT_EMAIL`: exact saved-account email to select if ChatGPT shows its “Welcome back” account picker. Set it on the machine running browser automation. Oracle never logs the address; without it, Oracle selects only a single unambiguous saved account and fails closed when several are present.
- `--browser-manual-login` is the historical flag name for the persistent isolated profile and is enabled by default for direct CDP in this fork. Profile persistence is separate from process lifetime: `browser.browserLifetime:"while-needed"` is the default, `persistent` is explicitly always-on, and `ephemeral` is one-shot. Legacy `browser.keepBrowser:true|false` maps to `persistent|ephemeral`; `--browser-keep-browser` remains the persistent compatibility flag. `--browser-no-cookie-sync`, `--browser-headless`, `--browser-hide-window`, and global `-v/--verbose` control the other compatibility/visibility overrides.
- `--copy-profile <dir>`: copy a signed-in Chrome user-data directory (e.g. `"$HOME/Library/Application Support/Google/Chrome"`) to a throwaway profile and run against it, reusing your live ChatGPT session with no manual sign-in. Oracle copies the profile recorded as active in `Local State`; pass `--browser-chrome-profile <name>` to select another direct child profile. The copy is launched with the real Keychain (not mocked) so its encrypted cookies decrypt, and is always deleted afterward—including setup/launch failures, incomplete captures, Cloudflare challenges, ambiguous submissions, and interrupts. Copied-profile runs cannot be kept or reattached; an ambiguous dispatch is reported as non-reattachable with `retrySafe:false` instead of promising recovery from a tab that will be removed. Not compatible with `--browser-keep-browser`, `--browser-manual-login`, `--browser-attach-running`, `--remote-chrome`, or `--remote-host`, and fails fast if the required `Local State` cannot be copied. macOS/Linux; requires `rsync`.
- `--browser-url`: override ChatGPT base URL if needed.
- `--browser-attachments <auto|never|always>`: control how `--file` inputs are delivered in browser mode. Default `auto` pastes text contents inline up to ~60k characters and uploads larger or raw files. `never` requires inline-compatible text inputs and rejects raw/binary files.
- `--browser-inline-files`: alias for `--browser-attachments never` (forces inline paste; never uploads attachments).
- `--browser-bundle-files`: bundle all resolved attachments into a single temp file before uploading (only used when uploads are enabled/selected).
- `--browser-bundle-format <auto|text|zip>`: choose the bundle format. `auto` uses a text bundle for text-only inputs and a byte-preserving ZIP when bundled inputs include raw files; `text` keeps the single Markdown-style text bundle; `zip` archives the original file bytes. ZIP bundle inputs are capped at 128 MiB because bundle creation is in-memory.
- sqlite bindings: automatic rebuilds now require `ORACLE_ALLOW_SQLITE_REBUILD=1`. Without it, the CLI logs instructions instead of running `pnpm rebuild` on your behalf.
- `--model`: `gpt-5.6` and `gpt-5.6-sol` map to the `GPT-5.6 Sol` picker entry. `gpt-5-pro` is the moving current browser alias and also selects Pro effort. GPT-5.2 base, Instant, and Thinking remain API-only because ChatGPT retired those picker rows; versioned legacy Pro aliases retain their documented mapping.
- Cookie sync is disabled in canonical dedicated-profile mode. If `browser.manualLogin:false` explicitly selects ephemeral compatibility mode, Oracle can copy a narrow ChatGPT auth/Cloudflare allowlist or use supplied inline cookies; that path fails when it cannot establish a valid authenticated session.
- Attach-running mode is mutually exclusive with launcher-owned flags such as `--browser-manual-login`, `--browser-chrome-profile`, `--browser-cookie-path`, `--browser-hide-window`, `--browser-keep-browser`, and `--browser-port`. `--remote-chrome` is allowed in attach-running mode, but only as the local host:port hint used to find matching `DevToolsActivePort` metadata. `--browser-chrome-path` is accepted but ignored.
- Experimental cookie controls (hidden flags/env):
  - `--browser-cookie-names <comma-list>` or `ORACLE_BROWSER_COOKIE_NAMES`: override the default allowlist of cookies to sync. Useful when ChatGPT changes auth cookie names.
  - `--browser-cookie-wait <ms|s|m>`: if cookie sync fails or returns no cookies, wait once and retry (helps when macOS Keychain prompts are slow).
  - `--browser-inline-cookies <jsonOrBase64>` or `ORACLE_BROWSER_COOKIES_JSON`: skip Chrome/keychain and set cookies directly. Payload is a JSON array of DevTools `CookieParam` objects (or the same, base64-encoded). At minimum you need `name`, `value`, and either `url` or `domain`; we infer `path=/`, `secure=true`, `httpOnly=false`.
  - `--browser-inline-cookies-file <path>` or `ORACLE_BROWSER_COOKIES_FILE`: load the same payload from disk (JSON or base64 JSON). If no args/env are provided, Oracle also auto-loads `~/.oracle/cookies.json` or `~/.oracle/cookies.base64` when present.
  - Practical minimal set that keeps ChatGPT logged in and avoids the workspace picker: `__Secure-next-auth.session-token` (include `.0`/`.1` variants) and `_account` (active workspace/account). Cloudflare proofs (`cf_clearance`, `__cf_bm`/`_cfuvid`/`CF_Authorization`/`__cflb`) are only needed when a challenge is active. In practice our allowlist pulls just two cookies (session token + `_account`) and works; add the Cloudflare names if you hit a challenge.
  - Inline payload shape example (we ignore extra fields like `expirationDate`, `sameSite`, `hostOnly`):
    ```json
    [
      {
        "name": "__Secure-next-auth.session-token",
        "value": "<token>",
        "domain": "chatgpt.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "expires": 1771295753
      },
      {
        "name": "_account",
        "value": "personal",
        "domain": "chatgpt.com",
        "path": "/",
        "secure": true,
        "httpOnly": false,
        "expires": 1770702447
      }
    ]
    ```

All options are persisted with the session so restarts (`oracle restart <id>`) reuse the same automation settings.

### Deep Research mode

Use `--browser-research deep` when the task needs broad web discovery, source comparison, or a cited report:

```bash
oracle --engine browser \
  --browser-manual-login \
  --browser-research deep \
  -p "Research the current browser support for WebGPU in enterprise-managed Chrome and cite sources."
```

Oracle activates ChatGPT Deep Research through the composer tools menu, recognizing both the `Deep research` label and current `Get a detailed report` menu variants. It waits for the research plan to auto-confirm, logs high-level progress, then captures the final report from the Deep Research report surface instead of trusting the assistant tool-call wrapper.

If ChatGPT initially exposes only `Called tool` / `Used tool`, Oracle treats that as an incomplete capture for Deep Research rather than a final answer. Reattach the existing session with `oracle session <id> --render` so Oracle can recover the lazy-loaded report from the existing Chrome tab; do not rerun the research unless the browser session is unrecoverable.

Deep Research is browser-only. It does not use connected apps in v1; give it public-web scope, uploaded files, and any domain/source guidance in the prompt. For deep thinking over code or architecture without web search, prefer a normal browser run with GPT-5.6 Sol and `--browser-thinking-time extra-high`, or a Pro model with `--browser-thinking-time extended`.

Completed browser sessions also save durable artifacts under `~/.oracle/sessions/<id>/artifacts/`. Deep Research writes the extracted report to `deep-research-report.md`, and every browser run writes `transcript.md` with the prompt, final answer, conversation URL, and saved artifact references. Use `--write-output <path>` when you also need a copy of just the final answer at a specific path.

When ChatGPT generates downloadable files in the assistant response (for example a ZIP, wheel, source distribution, CSV, or PDF), Oracle saves those files beside the transcript. The downloader is intentionally narrow: it only follows ChatGPT-owned file/download URLs from the assistant response and uses `sandbox:/mnt/data/...` links as source metadata and filename hints, not as arbitrary fetch targets. External links in the response are left in the transcript but are not downloaded. In bridge mode, a patched Windows host advertises artifact-transfer capability through `/health`; the Linux client then pulls each saved file over the authenticated bridge endpoint, stores it under the Linux session `artifacts/` directory, and verifies safe filename, byte size, SHA-256, and ZIP structure where applicable. If either side is older or transfer validation fails, the text response still completes and Oracle prints a manual-copy fallback instead of leaking host paths or signed download URLs.

### Conversation archiving

Oracle has no ChatGPT conversation-archive capability. It leaves every ChatGPT conversation visible for inspection, provenance, recovery, and manual follow-up after saving `transcript.md`, generated artifacts, the final answer, and the conversation URL locally. Browser target cleanup closes Oracle-owned Chrome targets; it never archives or deletes the corresponding ChatGPT account conversation.

### ChatGPT Project Sources

ChatGPT Project Sources can act as explicit shared context for project workflows where chats should not implicitly share memory. This is especially useful with Developer Mode / Memory Off: separate chats do not see each other's conversation history, but they can read files attached to the Project Sources tab.

Oracle exposes a narrow, non-destructive v1:

```bash
# Preview the upload plan without touching ChatGPT
oracle project-sources add \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login \
  --file docs/architecture.md \
  --dry-run

# List current sources
oracle project-sources list \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login

# Append files to the Sources tab
oracle project-sources add \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login \
  --file docs/architecture.md docs/decisions.md
```

This command uses browser automation but does not select a model, start a consult, or send a prompt. It only opens the Project Sources surface, lists existing files, or appends new files. Destructive operations such as delete, replace, and sync are intentionally left out until the UI path is safer and better covered by live tests.

### Multi-turn browser consults

Use browser follow-ups when a one-shot review would be too easy for the model to answer shallowly. Oracle keeps the same ChatGPT conversation open, waits for each answer, then submits the next follow-up:

```bash
oracle --engine browser \
  --model gpt-5.5-pro \
  --browser-thinking-time extended \
  -p "Review this migration plan and identify the top risks." \
  --file docs/migration-plan.md \
  --browser-follow-up "Challenge your previous recommendation. What would fail in production?" \
  --browser-follow-up "Now give the final decision with the smallest safe next step."
```

The CLI output and saved `transcript.md` include each captured turn. For PR validation, compare a one-shot run with the same initial prompt against a two-turn run that asks the model to challenge itself; record concrete differences such as additional failure modes, test cases, or rollback steps rather than claiming a fixed quality percentage.

Guardrails for agents:

- Use one-shot browser runs for narrow bugs, exact file sets, quick code review, or when the expected answer is a short decision.
- Use explicit follow-ups for ambiguous architecture, competing options, product tradeoffs, or review flows where a challenge pass and final recommendation are useful.
- Use Deep Research for broad public-web research that needs citations; Deep Research has its own lifecycle and is not combined with browser follow-ups.
- Oracle never invents follow-ups automatically. Agents may suggest a short follow-up sequence, but the caller must pass each prompt explicitly with `--browser-follow-up` or `browserFollowUps`.

### ChatGPT generated images

When ChatGPT returns downloadable generated images in browser mode, Oracle downloads them using the active browser cookies and records them as session artifacts. To choose an output path, pass `--generate-image <file>`:

```bash
oracle --engine browser \
  --browser-manual-login \
  --model "GPT-5.5 Pro" \
  --generate-image /tmp/oracle-image.png \
  -p "Create a simple product icon on a transparent background."
```

If ChatGPT returns multiple images, the first image saves to the requested path and the rest save as numbered siblings. Without `--generate-image`, Oracle writes images to the session `artifacts/` directory.

MCP agents should prefer the `chatgpt_image` tool. It wraps the same behavior with a smaller input shape, uploads reference files by default, and returns saved files in `structuredContent.images`. Advanced callers can still pass `generateImage` to `consult` directly.

### Dedicated profile mode (historical `manualLogin` name)

The option and stored field retain the upstream `manualLogin` name for
compatibility, but this is now the canonical direct-CDP mode. Do not initialize
it by sending a dummy consultation. Use the non-submitting lifecycle commands:

```bash
oracle browser install
oracle browser setup --use-mock-keychain # recommended for unattended macOS use
# sign in, close the entire Chrome for Testing browser
oracle browser smoke
```

- Oracle uses `~/.oracle/browser-profile` by default. Override it with
  `ORACLE_BROWSER_PROFILE_DIR`, `browser.manualLoginProfileDir`, or the
  setup/smoke `--profile-dir` option.
- The profile root is created with owner-only permissions on Unix-like systems.
- Cookie copy from personal Chrome is disabled. Login state is created inside
  the dedicated profile by the operator.
- Normal runs reuse that profile while work needs it. A run owns its tab, not
  manually opened or concurrently generating tabs in the same window. After
  the final lease release, Oracle preserves active, recoverable, and unowned
  meaningful work; otherwise the verified idle process drains automatically.
- `browser.hideWindow:false` keeps ordinary macOS runs visible and manually
  recoverable without activating the window or taking keyboard focus. Cold
  starts use LaunchServices background-open semantics; later targets use
  `focus:false`. Oracle restores only a previously hidden off-screen window, so
  a user-positioned window or second-screen placement remains untouched. `true`
  is an explicit off-screen policy with reduced observability.
- `browser.useMockKeychain:true` avoids recurring macOS Keychain prompts for
  this isolated profile. It is user-config-only and trades OS-bound encryption
  for Chromium's deterministic test key; do not reuse a system-keychain profile
  after changing the mode.
- Oracle automatically discovers and reuses a reachable DevTools endpoint for
  the exact profile. Do not add `--remote-chrome` merely to reuse Oracle Chrome.
- A healthy older installed Chrome for Testing generation remains reusable for
  current work and rolls over after the profile becomes idle. Stale metadata
  and a verified unusable managed process are repaired before Send. Inspect
  the concise state with `oracle browser status`; use `oracle browser heal
--plan` and then `oracle browser heal` only for an explicit no-prompt repair.
- A non-setup run fails fast with `oracle browser setup` guidance when the
  profile has never been initialized.
- Remote Chrome has its own profile/network authority and participates in tab
  coordination only when the remote service identifies a shared profile root.

### Concurrent agents and long Pro runs

When Codex, Claude Code, or another Oracle caller share the same dedicated profile, each browser run acquires a tab slot before opening a ChatGPT tab. The default allows three simultaneous ChatGPT tabs; the fourth caller waits instead of racing another agent. This is most useful for long Pro/Thinking runs where one agent may wait for a response while another starts a separate consult.

Use `--browser-max-concurrent-tabs <n>`, `browser.maxConcurrentTabs`, or `ORACLE_BROWSER_MAX_CONCURRENT_TABS` to tune the soft limit. Precedence is explicit CLI/config value, then environment, then the default of `3`; invalid or non-positive values fall back instead of disabling the cap. Keep the value modest: too many concurrent ChatGPT tabs can destabilize the UI or trigger account-side throttling. Oracle serializes dedicated-profile startup, reuses the first reachable DevTools session instead of racing multiple launches against one `user-data-dir`, and separately locks the send/upload moment so agents do not type into one composer.

The dedicated launcher is itself the stable local concurrency path: the first
caller owns process startup and later callers reuse its exact profile endpoint.
Use `--remote-chrome` only when Chrome actually lives under a different
host/process authority.

## Remote Chrome Sessions (headless/server workflows)

Oracle can reuse an already-running Chrome/Edge instance on another machine by tunneling over the Chrome DevTools Protocol. This is handy when:

- Your CLI runs on a headless server (Linux/macOS CI, remote mac minis, etc.) but you want the browser UI to live on a desktop where you can see uploads or respond to Captcha challenges.
- You want to keep a single signed-in profile open (e.g., Windows VM with company SSO) while sending prompts from other hosts.

### 1. Start Chrome with remote debugging enabled

On the machine that should host the browser window:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/path/to/profile \
  --profile-directory='Default'
```

Notes:

- Any Chromium flavor works (Chrome, Edge, Vivaldi, etc.)—just ensure CDP is exposed on a reachable host:port. Linux distributions often call the binary `google-chrome-stable`. On macOS you can run `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `--remote-debugging-address=0.0.0.0` is required if the CLI connects from another machine. Lock it down behind a VPN or SSH tunnel if the network is untrusted.
- Keep this browser window open and signed into ChatGPT; Oracle will reuse that session and **will not** copy cookies over the wire.

### 2. Point Oracle at the remote browser

From the machine running `oracle`:

```bash
oracle --engine browser \
  --remote-chrome 192.168.1.10:9222 \
  --prompt "Summarize the latest incident doc" \
  --file docs/incidents/latest.md
```

Key behavior:

- Use IPv6 by wrapping the host in brackets, e.g. `--remote-chrome "[2001:db8::1]:9222"`.
- Local-only flags like `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and `--browser-chrome-path` are ignored because Oracle no longer launches Chrome. You still get verbose logging, model switching, attachment uploads, and markdown capture.
- Cookie sync is skipped automatically (the remote browser already has cookies). If you need inline cookies, use them on the machine that’s actually running Chrome.
- Oracle opens a dedicated CDP target (new tab) for each run and closes it afterward so your existing tabs stay untouched.
- When remote runs are served by an Oracle host with a dedicated persistent profile, the host-side tab lease registry applies the same concurrent tab limit.
- Attachments are transferred via CDP: Oracle reads each file locally, base64-encodes it, and uses `DataTransfer` inside the remote browser to populate the upload field. Files larger than 20 MB are rejected to keep CDP messages reasonable.
- When the remote WebSocket disconnects, Oracle errors with “Remote Chrome connection lost…” so you can re-run after restarting the browser.

### 3. Troubleshooting

- Run `scripts/test-remote-chrome.ts <host> [port]` to sanity-check connectivity (`npx tsx scripts/test-remote-chrome.ts my-host 9222`).
- If you target IPv6 without brackets (e.g., `2001:db8::1:9222`), the CLI rejects it—wrap the address like `[2001:db8::1]:9222`.
- Ensure firewalls allow inbound TCP to the debugging port and that you’re not behind a captive proxy stripping WebSocket upgrades.
- Because we do not control the remote lifecycle, Chrome stays running after the session. Shut it down manually when you’re done or remove `--remote-debugging-port` to stop exposing CDP.

### Remote Service Mode (`oracle serve`)

Prefer to keep Chrome entirely on the remote Mac (no DevTools tunneling, no manual cookie shuffling)? Use the built-in service:

1. **Start the host**

   ```bash
   oracle serve
   ```

   Oracle picks a free port, launches Chrome, starts an HTTP/NDJSON API on
   loopback, and prints:

   ```
   Listening at 127.0.0.1:9473
   Access token: c4e5f9...
   ```

   Use `--port` or `--token` to override those values. `--host` remains
   available, but any non-loopback address also requires the independent
   `--allow-non-loopback` opt-in and prints a prominent security warning:

   ```bash
   oracle serve --host 192.168.64.2 --allow-non-loopback
   ```

   Prefer an SSH/private tunnel to the default loopback listener. A bearer
   token alone does not make the service safe for the public Internet.
   If the host Chrome profile is not signed into ChatGPT, the service opens chatgpt.com for login and exits—sign in, then restart `oracle serve`.

2. **Run from your laptop**

   ```bash
   oracle --engine browser \
     --remote-host 192.168.64.2:9473 \
     --remote-token c4e5f9... \
   --prompt "Summarize the incident doc" \
    --file docs/incidents/latest.md
   ```

   - `--remote-host` points the CLI at an explicitly exposed private address or
     at the local end of a tunnel to the host's default loopback listener.
   - `--remote-token` matches the token printed by `oracle serve` (set `ORACLE_REMOTE_TOKEN` to avoid repeating it).
   - You can also set defaults in `~/.oracle/config.json` (`browser.remoteHost`, `browser.remoteToken`) so you don’t need the flags; env vars still override those when present.
   - Cookies are **not** transferred from your laptop. The service requires the host Chrome profile to be signed in; if not, it opens chatgpt.com and exits so you can log in, then restart `oracle serve`.

3. **What happens**
   - The CLI assembles the composed prompt + file bundle locally, sends them to the VM, and streams log lines/answer text back through the same HTTP connection.
   - The remote host runs Chrome locally, pulls ChatGPT cookies from its own Chrome profile, and reuses them across runs while the service is up. If cookies are missing, the service exits after opening chatgpt.com so you can sign in before restarting.
   - A bearer-token client may describe the conversation target, model/research intent, time budgets, and whether the completed conversation tab should remain open. Chrome executables and profiles, debugger endpoints, existing-tab selection, cookies, transport, process/profile lifetime, diagnostic logging, and shared-profile concurrency remain host-owned.
   - `GET /status` is intentionally unauthenticated and returns only
     `{ "ok": true }`. `GET /health`, artifact transfer, and `POST /runs`
     require the bearer token. Unauthorized run requests are rejected before
     their body is read.
   - Request bodies are capped at 64 MiB and rejected with HTTP 413 as soon as
     their declared or streamed size crosses the limit; the service does not
     fully buffer an oversized body.
   - Background/detached sessions (`--no-wait`) are disabled in remote mode so the CLI can keep streaming output.
   - `oracle serve` logs the DevTools port of its dedicated Chrome. Runs automatically attach to that logged-in browser; use the printed port/JSON URL only for controlled diagnostics.

   Treat `oracle serve` as a controlled-host bridge, not a public Internet
   endpoint. It binds to loopback by default. Prefer loopback plus an
   SSH/private tunnel; if a non-loopback bind is required, provide both
   `--host` and `--allow-non-loopback`, then keep it inside private
   infrastructure with an explicit firewall.
   A loopback startup banner lists only the loopback address actually bound.

4. **Stop the host**
   - `Ctrl+C` on the VM shuts down the HTTP server and Chrome. Restart `oracle serve` whenever you need a new session; omit `--token` to let it rotate automatically.

This mode is ideal when you have a macOS VM (or spare Mac mini) logged into ChatGPT and you just want to run the CLI from another machine without ever copying profiles or keeping Chrome visible locally.

## Limitations / Follow-Up Plan

- **Attachment lifecycle** – in `auto` mode we prefer inlining files into the composer (fewer moving parts). When we do upload, each `--file` path is uploaded separately (or bundled) so ChatGPT can ingest filenames/content. The pre-prompt gate accepts only stable complete attachment evidence with no explicit upload progress; an empty composer may legitimately keep Send disabled. After composing the exact prompt, the final gate re-verifies the attachments and requires enabled Send before submitting. When inline paste is rejected by ChatGPT (too large), Oracle retries automatically with uploads.
- **Model picker drift** – Oracle relies on current UI evidence to pick GPT-5.6 / GPT-5.5 / GPT-5.4 variants and effort tiers. If ChatGPT changes the DOM, refresh selectors and receipts before trusting new submissions.
- **Non-mac platforms** – window hiding uses AppleScript today; Linux/Windows just ignore the flag. We should detect platforms explicitly and document the behavior.
- **Streaming UX** – browser runs cannot stream tokens, so we emit heartbeat/status logs while waiting. Investigate whether we can stream clipboard deltas via mutation observers for a closer UX.

## Testing Notes

- ChatGPT automation smoke: `pnpm test:browser`
- `pnpm test --filter browser` does not exist yet; manual runs with `--engine browser -v` are the current validation path.
- Most of the heavy lifting lives in `src/browserMode.ts`. If you change selectors or the mutation observer logic, run a local `oracle --engine browser --browser-keep-browser` session so you can inspect DevTools before cleanup.
