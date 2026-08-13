---
title: Oracle × OpenCLI
permalink: /
description: "A recoverable, unattended browser path from coding agents to ChatGPT GPT-5.6 Pro, with Oracle remaining the canonical session authority."
---

# GPT-5.6 Pro without browser babysitting

This fork adds an authenticated OpenCLI Browser Bridge transport to Oracle.
Coding agents can send a sealed, project-grounded consultation to the current
ChatGPT GPT-5.6 Pro tier, wait for a long answer, reattach after interruption,
and continue the same conversation—without making a routine Chrome debugging
approval click part of the workflow.

It is intentionally **not** a wrapper that owns a shadow conversation. Oracle
still owns the prompt bundle, authorization, session state, transcript,
follow-up lineage, and recovery. OpenCLI owns only the browser boundary.

## Try the fork

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

Preview the exact context first:

```bash
oracle --dry-run summary --files-report \
  --engine browser \
  --browser-transport opencli \
  --model gpt-5-pro \
  -p "Review the storage layer for schema drift" \
  --file "src/**/*.ts"
```

Remove `--dry-run summary` to dispatch. Oracle stores the run under
`~/.oracle/sessions/`, so a long answer can be recovered or continued later:

```bash
oracle status --hours 72
oracle session <id> --render
oracle --followup <id> -p "Challenge the weakest assumption."
```

## One authority, one narrow handoff

| Layer           | Owner   | Durable result                                                    |
| --------------- | ------- | ----------------------------------------------------------------- |
| Context         | Oracle  | Selected files, rendered payload, and sealed manifest             |
| Authorization   | Oracle  | Payload digest, target, operation reference, and dispatch journal |
| Browser         | OpenCLI | Execute Oracle's picker and submit on one exact ChatGPT tab       |
| Remote identity | Oracle  | Structured conversation id and URL                                |
| Recovery        | Oracle  | Single-waiter reattach, answer, transcript, and follow-up lineage |

If the handoff may have submitted but no receipt exists, Oracle stops with an
ambiguous state. If the receipt exists but answer collection fails, Oracle
starts one read-only waiter against that receipt and does not send the prompt
twice. The waiter owns one tab for its full lifetime instead of opening and
closing a tab on every observation. OpenCLI never silently falls back to direct
CDP.

## Why three Pro names appear

- **GPT-5.6 Pro** is the human-facing current browser target.
- `gpt-5-pro` is Oracle's stable browser alias for that target.
- `GPT-5.6 Sol` and `Pro` are the exact ChatGPT model and reasoning-tier labels;
  together they form the verified `GPT-5.6 Pro` receipt.

The upstream `gpt-5.5-pro` API model/default is a separate contract and has not
been renamed.

## Pick your path

- **Understand the fork.** [Oracle × OpenCLI](opencli-transport.md) explains the
  architecture, split-brain tradeoff, failure contract, privacy boundary, and
  verification surface.
- **Run the browser lane.** [Browser Mode](browser-mode.md) covers OpenCLI setup,
  recovery, and the explicit legacy CDP paths.
- **Wire a coding agent.** [Agents](agents.md) covers Codex, Claude Code, Cursor,
  CLI, and MCP patterns.
- **Learn the session model.** [Sessions](sessions.md) and
  [Follow-ups](followup.md) cover durable runs and conversation lineage.
- **Use the broader upstream surface.** [Quickstart](quickstart.md),
  [Configuration](configuration.md), and [CLI reference](cli-reference.md)
  include API, render, Gemini, and direct browser modes.

## Upstream and project status

This repository preserves the history and MIT license of
[steipete/oracle](https://github.com/steipete/oracle). The published
`@steipete/oracle` npm package, Homebrew formula, and
[askoracle.sh](https://askoracle.sh) describe the upstream distribution; they do
not yet install this fork's OpenCLI transport.

The fork is not affiliated with OpenAI or the OpenCLI project. Account access,
authentication challenges, and model entitlement remain human-controlled.
