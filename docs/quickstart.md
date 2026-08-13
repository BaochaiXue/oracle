---
title: Quickstart
description: "From an isolated ChatGPT sign-in to a recoverable GPT-5.6 Pro consultation, API run, or local render."
---

This guide gets one useful answer back without hiding the browser/account
boundary. The published npm and Homebrew packages are upstream Oracle; install
this fork from source for the dedicated-profile defaults and optional OpenCLI
transport described here. See [Install](install.md) for broader upstream paths.

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
pnpm install
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
oracle browser setup
```

Sign in to ChatGPT in that window, then close the entire Chrome for Testing
browser. Setup waits for that exit. This profile is
stored at `~/.oracle/browser-profile` by default. It is separate from personal
Chrome and should contain only the browser state Oracle needs.

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
    "hideWindow": true,
    "modelStrategy": "select",
    "thinkingTime": "pro"
  }
}
```

Use the real absolute profile path for your account. On macOS,
`hideWindow:true` keeps ordinary runs headful but off-screen. First-time setup
is always visible. Use `hideWindow:false` while debugging selector or account
state.

The fork defaults to `transport:"cdp"`, `manualLogin:true`, and
`cookieSync:false` even when these fields are omitted. Writing them explicitly
is useful for a shared setup because it makes the capability boundary visible.

## 5. Preview and send a GPT-5.6 Pro consultation

Preview bundle scope without opening Chrome:

```bash
oracle --dry-run summary --files-report \
  --engine browser \
  --browser-transport cdp \
  --model gpt-5-pro \
  -p "Audit the storage layer for race conditions and missing tests." \
  --file "src/storage/**/*.ts" \
  --file "!src/storage/**/*.test.ts"
```

Then remove `--dry-run summary`:

```bash
oracle --engine browser \
  --browser-transport cdp \
  --model gpt-5-pro \
  -p "Audit the storage layer for race conditions and missing tests." \
  --file "src/storage/**/*.ts" \
  --file "!src/storage/**/*.test.ts"
```

`gpt-5-pro` maps to the current browser lane: model `GPT-5.6 Sol` plus
reasoning tier `Pro`. Oracle verifies both controls in the submission tab and
stores model-selection evidence with the session.

A picker receipt is not server-routing proof. If the first stable answer arrives
in under 60 seconds, Oracle terminates the run with
`pro-fast-response-untrusted`, retains only digest/timing evidence, and does not
surface that answer as Pro advice. A later reattach uses the first elapsed time;
it cannot make the rejected response trusted by waiting.

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
  --models gpt-5.5-pro,gemini-3.1-pro,claude-opus-4.6 \
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
