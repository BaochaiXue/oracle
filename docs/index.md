---
title: Oracle × Dedicated Chrome
permalink: /
description: "A recoverable ChatGPT GPT-5.6 Pro lane using an Oracle-only persistent Chrome profile and loopback CDP, with OpenCLI retained as an explicit alternative."
---

# GPT-5.6 Pro without personal-browser babysitting

This fork gives Oracle an official Chrome for Testing app plus its own
persistent profile. The operator signs in to ChatGPT once; later browser
consultations launch that non-default
`user-data-dir`, attach directly over loopback CDP, select the live model and
reasoning tier, and preserve the resulting conversation as an Oracle session.

It does not make attaching to the operator's personal Chrome the default. That
is the architectural difference that removes the routine “Allow debugging”
gate without weakening the personal-browser boundary.

```text
agent / human
    │ authorized context
    ▼
Oracle ── bundle · receipt · recovery · transcript
    │
    │ CDP @ 127.0.0.1
    ▼
Chrome for Testing (separate app identity)
~/.oracle/browser-profile
    │
    └── signed-in ChatGPT GPT-5.6 Pro
```

## Try the canonical path

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install
pnpm build
npm link

oracle browser install
oracle browser setup --use-mock-keychain # unattended macOS profile
# sign in to ChatGPT, then close the entire browser
oracle browser smoke
```

The smoke cold-starts the same profile twice, attaches twice, verifies the
persisted login and ready composer, and submits no prompt.

Normal browser consultations dispatch directly:

```bash
oracle --engine browser \
  --model gpt-5-pro \
  -p "Review the storage layer for schema drift" \
  --file "src/**/*.ts"
```

Add `--dry-run summary --files-report` only when an unusually large or uncertain
bundle needs a scope diagnostic. It is not part of the normal consultation
path. Oracle stores every dispatched run under
`~/.oracle/sessions/`, so a long answer can be recovered or continued:

```bash
oracle status --hours 72
oracle session <id> --render
oracle --followup <id> -p "Challenge the weakest assumption."
```

## One authority, one isolated capability

| Layer                     | Owner             | Durable result                                                |
| ------------------------- | ----------------- | ------------------------------------------------------------- |
| Context and authorization | Oracle            | Selected files, assembled prompt, and stored request          |
| Browser process           | Oracle            | Chrome for Testing, non-default profile, and loopback CDP     |
| Remote identity           | Oracle            | Exact ChatGPT target, conversation id/URL, and model evidence |
| Recovery                  | Oracle            | Reattach to the accepted conversation without resubmission    |
| Account identity          | Dedicated profile | ChatGPT login state, separate from personal Chrome            |
| First sign-in/challenges  | Human             | Explicit account decisions remain human-controlled            |

Chrome's official guidance now presents personal-browser automatic attachment
and custom-profile manual CDP connection as different workflows. Chrome 136+
also refuses remote-debugging switches against the default profile while
retaining them for a custom `user-data-dir`. See
[Dedicated Chrome transport](dedicated-chrome.md) for the evidence, lifecycle,
security boundary, and two-cold-start acceptance test.

## GPT-5.6 Pro receipts

- **GPT-5.6 Pro** is this fork's human-facing current browser target.
- `gpt-5-pro` is Oracle's stable moving alias for that browser lane.
- `GPT-5.6 Sol` is the model selected in ChatGPT.
- `Pro` is the selected reasoning tier.

The picker proves requested UI state, not hidden server-side routing. Oracle
therefore also rejects every purported Pro response first captured in under 60
seconds. The answer text is not trusted or persisted as advisory evidence; the
timing and digest are retained, and reattach cannot launder the same fast
answer by waiting longer.

## Explicit alternatives

OpenCLI Browser Bridge is still present for people who prefer it or cannot
launch direct CDP. It is opt-in via `browser.transport:"opencli"`; there is no
automatic fallback in either direction. Oracle remains the session authority,
and OpenCLI owns only the browser bridge handoff. Read
[OpenCLI alternative transport](opencli-transport.md).

Attach-running personal Chrome, remote Chrome, API providers, Gemini web, MCP,
Deep Research, image generation, and render/copy are separate documented paths.

## Pick the next guide

- **Understand the fork.** [Dedicated Chrome transport](dedicated-chrome.md)
  explains the canonical topology, first login, smoke, runtime receipts,
  admission gate, privacy boundary, and recovery invariants.
- **Run a consultation.** [Quickstart](quickstart.md) covers first setup, direct
  CDP, API, render, and reattach.
- **See every browser feature.** [Browser Mode](browser-mode.md) covers direct
  CDP, remote/attach-running paths, Deep Research, files, images, and OpenCLI.
- **Wire a coding agent.** [Agents](agents.md) covers Codex, Claude Code,
  Cursor, CLI, and MCP patterns.
- **Understand durable state.** [Sessions](sessions.md) and
  [Follow-ups](followup.md) cover stored runs and conversation lineage.
- **Configure precisely.** [Configuration](configuration.md) and
  [CLI reference](cli-reference.md) cover precedence, flags, and limits.

## Upstream and project status

This repository preserves the history and MIT license of
[steipete/oracle](https://github.com/steipete/oracle). The published
`@steipete/oracle` npm package, Homebrew formula, and
[askoracle.sh](https://askoracle.sh) describe the upstream distribution; they do
not install this fork's dedicated-profile defaults or OpenCLI alternative.

The fork is not affiliated with OpenAI, Google Chrome, or the OpenCLI project.
Account access, authentication challenges, and model entitlement remain
human-controlled.
