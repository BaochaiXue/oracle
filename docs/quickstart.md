---
title: Quickstart
description: "From an isolated ChatGPT sign-in to a recoverable GPT-5.6 Pro consultation, API run, or local render."
---

This guide gets one useful answer back without hiding the browser/account
boundary. The published npm and Homebrew packages are upstream Oracle; install
this fork from source for the dedicated-profile defaults and optional OpenCLI
transport described here. [Install from source](install.md) is this fork's only
installation guide; its appendix names upstream channels only to prevent
confusion, because those channels do not install this fork.

## 1. Pick a mode

| Mode                | When to use it                                                        | What you need                                                     |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Dedicated Chrome    | Default for recoverable ChatGPT GPT-5.6 Pro and browser-only features | This fork, Chrome, one isolated ChatGPT sign-in, and model access |
| API                 | Provider automation, multi-model fan-out, or no browser/account state | `OPENAI_API_KEY` or another configured provider                   |
| OpenCLI alternative | You explicitly prefer Browser Bridge or cannot launch direct CDP      | This fork, OpenCLI 1.8.6+, Browser Bridge, and companion adapters |
| Render              | Inspect/copy the exact bundle without contacting a model              | Oracle only                                                       |

If both API credentials and browser access exist, Oracle follows the effective
engine config. Use `--engine browser` or `--engine api` explicitly in agent
automation so environment changes cannot reroute a consultation.

## 2. Install this fork

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm link
```

Verify the linked binary:

```bash
oracle --version
oracle browser --help
```

## 3. Install and sign in to the isolated browser once

Install official Chrome for Testing, then open Oracle's dedicated profile:

```bash
oracle browser install
# macOS unattended mode; persists browser.useMockKeychain=true
oracle browser setup --use-mock-keychain
```

Sign in to ChatGPT in that window, then close the entire Chrome for Testing
browser. Setup waits for that exit. This profile is
stored at `~/.oracle/browser-profile` by default. It is separate from personal
Chrome and should contain only the browser state Oracle needs.

Check the operator-facing state without inspecting browser internals:

```bash
oracle browser status
```

The default report names browser readiness, installed generation, active or
recoverable consultations, and any human action required. PID, port,
executable, and runtime-receipt details are available only through `--json` or
verbose diagnostics.

Validate the real steady-state lifecycle:

```bash
oracle browser smoke
```

The smoke cold-starts the same profile twice. Both cycles attach over loopback,
verify authentication and a ready composer, submit no prompt, and close the
owned Chrome process. If port `9333` is occupied, use the same alternate port
for the smoke and normal-run config:

```bash
oracle browser smoke --port 9444
```

Setup itself has no CDP port. Put the chosen smoke port in
`browser.debugPort` for ordinary runs.

After this one-time sign-in, Oracle owns normal process maintenance. It reuses
a healthy managed generation, defers an installed-browser rollover until the
profile is idle, clears stale PID/port/lock metadata, and drains a verified
idle ghost process without deleting login data. If the summary requests
attention, preview and then apply the bounded repair:

```bash
oracle browser heal --plan
oracle browser heal
```

`heal` never submits a prompt. It preserves active and recoverable
consultations and refuses to touch an unverified profile owner.

Read [Dedicated Chrome transport](dedicated-chrome.md) for the exact trust and
acceptance contract.

## 4. Configure normal browser runs

Add an explicit policy to `~/.oracle/config.json`:

```json
{
  "engine": "browser",
  "model": "gpt-5-pro",
  "browser": {
    "transport": "cdp",
    "manualLogin": true,
    "manualLoginProfileDir": "/Users/you/.oracle/browser-profile",
    "debugPort": 9333,
    "cookieSync": false,
    "hideWindow": false,
    "browserLifetime": "while-needed",
    "useMockKeychain": true,
    "modelStrategy": "select",
    "thinkingTime": "pro"
  }
}
```

Use the real absolute profile path for your account. On macOS,
`hideWindow:false` keeps ordinary runs visible and manually inspectable, while
the cold launch is background-opened and focus-safe CDP target creation leaves
the currently active macOS app alone.
`browserLifetime:"while-needed"` keeps dedicated Chrome alive for active runs,
bounded recovery, and unowned meaningful pages, then closes it after the last
ordinary consultation. Use `persistent` only when the shared browser is
deliberately always-on. First-time setup is also visible. `hideWindow:true` is an explicit off-screen mode with
reduced observability. On macOS, `useMockKeychain:true` prevents recurring Keychain password
dialogs for this isolated profile, with weaker deterministic at-rest cookie
protection. Keep the profile owner-only and use a fresh directory when changing
between system and mock keychain modes.

The fork defaults to `transport:"cdp"`, `manualLogin:true`, `cookieSync:false`,
and `browserLifetime:"while-needed"` even when these fields are omitted. Writing them explicitly
is useful for a shared setup because it makes the capability boundary visible.

## 5. Send a GPT-5.6 Pro consultation

Normal browser consultations dispatch directly:

```bash
oracle --engine browser \
  --model gpt-5-pro \
  -p "Audit the storage layer for race conditions and missing tests." \
  --file "src/storage/**/*.ts" \
  --file "!src/storage/**/*.test.ts"
```

If the bundle is unusually large or its globs are uncertain, inspect it without
opening Chrome by adding `--dry-run summary --files-report`:

```bash
oracle --dry-run summary --files-report --engine browser \
  --model gpt-5-pro \
  -p "Audit the storage layer for race conditions and missing tests." \
  --file "src/storage/**/*.ts" \
  --file "!src/storage/**/*.test.ts"
```

The ordinary terminal output stays at the task level: `Preparing review…`,
`Review sent.`, `Waiting for GPT-5.6 Pro…`, and `Review complete.` A bounded
self-repair adds only `Repairing Oracle’s dedicated browser…`. If startup
cannot become safe before Send, Oracle says that the review was not sent and
does not describe it as a started consultation.

`gpt-5-pro` maps to the current browser lane: model `GPT-5.6 Sol` plus
reasoning tier `Pro`. Oracle verifies both controls in the submission tab and
stores model-selection evidence with the session.

A picker receipt is not server-routing proof. Oracle also records the elapsed
time from dispatch to the first stable answer. Tiny workloads (at most 256
estimated input tokens and 16 KiB of uploaded payload) may legitimately finish
quickly. A substantive Pro workload first captured below 60 seconds fails closed
as a route-anomaly precaution; very large runs that pass that guard but still
finish unexpectedly quickly emit an additional warning.

## 6. Recover or continue a long run

Pro consultations can legitimately be quiet for many minutes. Inspect the
existing session before considering a retry:

```bash
oracle status --hours 72
oracle session <id> --render
```

If a connection dropped after submission, `oracle session <id>` reuses the
stored profile/target/conversation receipt and harvests that conversation. It
does not silently send the prompt again.

If Oracle retained a prepared draft and you deliberately pressed **Send** in
that exact owned tab, `oracle session <id> --live` can tail the same turn. After
a completed answer is persisted and printed, Oracle marks only the recorded
session target terminal and reconciles it closed; other tabs and the shared
Chrome process remain independent. The action-time session must still exist;
if it already records a stable conversation ID, the harvested tab must supply
that same ID. A missing session or conversation ID, an explicit
`--browser-tab`, a target, conversation, or endpoint mismatch, or incomplete
ownership evidence disables this automatic close rather than risking another
tab. A failed reconciliation never recreates a session that disappeared while
cleanup was running.

Continue the same conversation explicitly:

```bash
oracle --followup <id> \
  -p "Challenge your previous recommendation with the strongest concrete failure mode."
```

For one invocation with a planned challenge/final pass, direct CDP also accepts
repeated `--browser-follow-up` flags:

```bash
oracle --engine browser --model gpt-5-pro \
  -p "Propose the migration." \
  --browser-follow-up "Attack the proposal using the current code." \
  --browser-follow-up "Return the final recommendation and stop conditions."
```

## 7. API mode

With an OpenAI API key:

```bash
export OPENAI_API_KEY=sk-...
oracle --engine api \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

API and ChatGPT subscription access are separate. Having ChatGPT Pro does not
create API credits, and a browser model alias is not necessarily an API model
ID. Keep `--engine` explicit when that distinction matters.

Query several API models in parallel:

```bash
oracle --engine api \
  --models gpt-5.5-pro,grok-4.1,claude-opus-4.6 \
  -p "Compare these two implementation strategies." \
  --file "docs/strategy-a.md" "docs/strategy-b.md"
```

See [Multi-model runs](multimodel.md) and [Configuration](configuration.md) for
provider routing and partial-failure policy.

## 8. Render without contacting a model

```bash
oracle --render --copy \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

This prints the assembled Markdown bundle and copies it to the clipboard. It is
the safest way to inspect what would leave the machine.

## 9. Optional OpenCLI alternative

Install OpenCLI and this fork's companion adapters:

```bash
npm install -g @jackwener/opencli@1.8.6
node scripts/install-opencli-submit-file-adapter.mjs
opencli validate chatgpt/submit-file
opencli validate chatgpt/oracle-wait
```

Select it explicitly for one run:

```bash
oracle --engine browser \
  --browser-transport opencli \
  --model gpt-5-pro \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

OpenCLI is not a fallback from an in-flight CDP run. It owns bridge/browser
access for the selected operation; Oracle still owns the sealed turn,
conversation receipt, answer, and waiter-only recovery. See
[OpenCLI alternative transport](opencli-transport.md).

## 10. Wire it into a coding agent

Start the MCP server:

```bash
oracle-mcp
```

For a browser consult, agent callers should set `engine:"browser"` and
`model:"gpt-5-pro"` explicitly, use `dryRun:true` before the first live request,
and inspect `sessions` before retrying a quiet or interrupted call. The MCP
server and CLI share the same Oracle home, browser config, and session store.

See [Coding Agents](agents.md) and [MCP](mcp.md) for host-specific examples.

## Where to go next

- [Dedicated Chrome transport](dedicated-chrome.md) — canonical architecture,
  security boundary, window policy, smoke, and recovery.
- [Browser Mode](browser-mode.md) — Deep Research, images, attachments,
  attach-running, remote Chrome, and all browser flags.
- [Sessions](sessions.md) and [Follow-ups](followup.md) — durable state and
  conversation lineage.
- [Configuration](configuration.md) and [CLI reference](cli-reference.md) —
  precedence and exact options.
- [Testing](testing.md) and [Manual tests](manual-tests.md) — contributor
  verification.
