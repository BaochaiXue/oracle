---
title: Quickstart
description: "From install to a recoverable Oracle consult — use this fork's unattended GPT-5.6 Pro lane, an API provider, or a local render."
---

This walks through the minimum to get a useful answer back. The published npm
and Homebrew packages are upstream Oracle; install this fork from source when
you want the OpenCLI transport described below. See [Install](install.md) for
the broader upstream installation paths.

## 1. Pick a mode

| Mode            | When to use it                                                                 | What you need                                              |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| OpenCLI browser | You want recoverable, unattended GPT-5.6 Pro text consults.                    | This fork, OpenCLI 1.8.6+, Browser Bridge, and Pro access. |
| API             | You have an API key and want reliable provider automation or multi-model runs. | `OPENAI_API_KEY` or another provider key.                  |
| Legacy browser  | You need direct CDP features, Gemini web, images, or Deep Research.            | Chrome on macOS, Linux, or Windows.                        |
| Render          | You want to inspect/copy the bundle without contacting a model.                | Just Oracle.                                               |

If both are available Oracle picks API by default (cheaper to short-circuit). Override per-run with `--engine browser`.

## 2. Your first run

### API mode

```bash
export OPENAI_API_KEY=sk-...
oracle -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts" \
  --file "!**/*.test.ts"
```

Oracle prints the assistant's reply on stdout and stores the run under `~/.oracle/sessions/<id>/`.

### OpenCLI browser mode (unattended GPT-5.6 Pro)

Install this fork and its companion adapters once:

```bash
npm install -g @jackwener/opencli@1.8.6
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install
pnpm build
pnpm link -g
node scripts/install-opencli-submit-file-adapter.mjs
opencli validate chatgpt/submit-file
opencli validate chatgpt/oracle-wait
```

Then send a turn through the authenticated Browser Bridge:

```bash
oracle --engine browser \
  --browser-transport opencli \
  --model gpt-5-pro \
  --browser-model-strategy select \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

`gpt-5-pro` is the stable Oracle browser alias for current GPT-5.6 Pro. The
live ChatGPT receipt verifies model `GPT-5.6 Sol` plus reasoning tier `Pro`.
Oracle stores the conversation receipt and uses single-waiter recovery rather
than silently resubmitting an accepted turn. One isolated OpenCLI tab stays with
the waiter for the whole answer harvest; Oracle does not spawn a new tab every
few seconds.

### Legacy direct browser mode

First run — log in once, browser stays open:

```bash
oracle --engine browser --browser-manual-login \
  --browser-keep-browser --browser-input-timeout 120000 \
  -p "HI"
```

Subsequent runs reuse the saved profile:

```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s \
  --browser-auto-reattach-interval 3s \
  --browser-auto-reattach-timeout 60s \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

`--browser-manual-login` skips Keychain cookie copy and reuses a persistent
automation profile under `~/.oracle/browser-profile/`. This is the explicit legacy CDP
path and can still require browser debugging approval; it is separate from the
OpenCLI lane above.

### Render and copy

```bash
oracle --render --copy -p "Architecture review" --file "src/**/*.ts"
```

The bundle is on your clipboard. Paste it into ChatGPT, Claude, Gemini, AI Studio, or wherever you want the answer.
Generated text context includes stable `Lines:` ranges and `N |` prefixes for `path:line` citations. Direct browser file uploads and ZIP bundles keep the original file contents.

## 3. Preview before you spend

```bash
oracle --dry-run summary --files-report \
  -p "Audit the storage layer for race conditions" \
  --file "src/**/*.ts"
```

`--dry-run summary` lists token counts per file plus the assembled prompt size. Use it to spot a runaway directory before sending. `--dry-run full` prints the entire bundle; `--dry-run json` is structured for tools.

## 4. Multi-model cross-check

Check keys/routes first:

```bash
oracle doctor --providers --models gpt-5.5-pro,gemini-3-pro,claude-4.6-sonnet
```

```bash
oracle -p "Cross-check the data layer assumptions" \
  --models gpt-5.5-pro,gemini-3-pro,claude-4.6-sonnet \
  --allow-partial --write-output /tmp/oracle-panel.md \
  --file "src/**/*.ts"
```

One command, three providers. Oracle aggregates cost and token usage per model, writes per-model output files, and can keep successful answers when one provider fails auth or quota. See [Multi-model](multimodel.md) for output formats and [Mythical Pro Agents](mythical-pro-agents.md) for picking the right combo.

Need startup proof for a slow CLI path?

```bash
oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "Quick smoke"
```

## 5. Reattach to a long run

GPT-5.x Pro replies can take 10 minutes to over an hour. API runs detach by default; reattach later:

```bash
oracle status --hours 24
oracle session <id> --render
```

For OpenCLI runs, `oracle session <id> --render` resumes through one read-only
waiter when a conversation receipt already exists. Legacy CDP browser runs can
use `--browser-auto-reattach-*` to poll an existing ChatGPT tab after a redirect
or timeout. See [Sessions](sessions.md) for the full lifecycle.

## 6. Wire it into your coding agent

Drop this in `AGENTS.md` or `CLAUDE.md`:

```
- This Oracle fork sends sealed project context to ChatGPT GPT-5.6 Pro through OpenCLI Browser Bridge while Oracle owns sessions, recovery, and follow-up lineage. Use it for difficult debugging, architecture, refactoring, or consequential review.
- Run `oracle --help` once per session before first use. For unattended browser work, select `--engine browser --browser-transport opencli --model gpt-5-pro` and inspect `oracle status` before retrying a long run.
```

Or wire MCP — see [MCP](mcp.md) and [Agents](agents.md).

## Where to go next

- [Mythical Pro Agents](mythical-pro-agents.md) — model lineup, costs, when to use which.
- [Browser Mode](browser-mode.md) — full reference for `--engine browser`.
- [Configuration](configuration.md) — defaults in `~/.oracle/config.json`.
- [Followups](followup.md) — continue an existing run with new files.
