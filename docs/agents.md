---
title: Coding Agents
description: "Use Oracle from Claude Code, Codex, Cursor, and any other coding agent — as a CLI, as an MCP server, or as a one-shot skill."
---

Oracle is built to be called _by_ coding agents as much as by humans. In this
fork, the default unattended browser pattern is: the agent gathers exact
project context, Oracle records the turn, its isolated Chrome profile crosses
the authenticated browser boundary over loopback CDP, and GPT-5.6 Pro returns a
second opinion to the same recoverable Oracle session. OpenCLI remains an
explicit alternative, not the default.

## The 30-second wiring

Drop this into the project's `AGENTS.md` or `CLAUDE.md`:

```
- This Oracle fork gives Oracle a dedicated persistent Chrome profile and uses
  direct loopback CDP for ChatGPT GPT-5.6 Pro. Oracle owns browser actions,
  sessions, recovery, transcripts, and follow-up lineage; it does not attach to
  personal Chrome by default.
- The operator must complete `oracle browser install`, `oracle browser setup
  --use-mock-keychain` on macOS, and `oracle browser smoke` once before
  unattended work. Agents use
  `--engine browser --browser-transport cdp --model gpt-5-pro` directly and
  inspect `oracle status` before retrying a quiet/interrupted run. Dry-runs,
  smoke tests, and preflight checks are diagnostics, not normal consult steps.
- Tiny Pro requests can finish quickly. For substantive bundles, treat a
  sub-minute timing rejection as a route-anomaly stop condition; inspect the
  picker receipt and do not quote or adopt the rejected answer digest as advice.
```

That's enough for most agents to discover and use Oracle correctly. The patterns below cover the deeper integrations.

## Claude Code

### As an MCP server (recommended)

```bash
oracle bridge claude-config --local-browser > .mcp.json
```

That writes a `.mcp.json` configured for the local browser path, so Claude Code can call `oracle.consult` and `oracle.sessions` without API keys. Set `browser.transport` to `"cdp"`, `browser.manualLogin` to `true`, and `browser.manualLoginProfileDir` to the isolated profile in `~/.oracle/config.json`; then pass `engine:"browser"` and `model:"gpt-5-pro"`. Use `dryRun:true` to inspect the resolved bundle before sending. The operator, not the MCP caller, owns transport/profile selection. The upstream `chatgpt-pro-heavy` preset retains its separate model/effort contract.

See [MCP](mcp.md) for connection details and other clients.

### As a skill

Copy the bundled skill into `~/.claude/skills/`:

```bash
mkdir -p ~/.claude/skills
cp -R skills/oracle ~/.claude/skills/oracle
```

Then reference `oracle` in `CLAUDE.md`. Claude Code will load `SKILL.md` whenever the trigger conditions match (debugging, refactor, design check).

### As a slash command

Many users alias the linked fork binary behind a custom `/consult` slash command. Prefer explicit `--followup <session-id>` lineage over silently routing unrelated consults into one current tab.

## Codex

Copy the same skill into the Codex skills folder:

```bash
mkdir -p ~/.codex/skills
cp -R skills/oracle ~/.codex/skills/oracle
```

Then reference it in `AGENTS.md`. Codex will pick it up automatically.

For Codex slash prompts, drop a wrapper in `~/.codex/prompts/oracle.md` that calls Oracle with your preferred defaults (engine, model, follow-up flags).

## Cursor

Cursor speaks MCP. Drop a `.cursor/mcp.json` like:

```json
{
  "oracle": {
    "command": "oracle-mcp",
    "args": []
  }
}
```

Or use the [one-click install](https://cursor.com/en-US/install-mcp?name=oracle&config=eyJjb21tYW5kIjoibnB4IC15IEBzdGVpcGV0ZS9vcmFjbGUgb3JhY2xlLW1jcCJ9). The `oracle` source then shows up in Cursor's MCP picker.

## Generic CLI usage from any agent

When the agent has shell access, the simplest hand-off is the bundle-on-clipboard fallback:

```bash
oracle --render --copy -p "$TASK" --file "$RELEVANT_FILES"
```

…then the agent (or a human) pastes into whichever Pro model they have access to. No keys, no MCP, works everywhere.

For unusually large or uncertain bundles, the optional JSON diagnostic exposes
the resolved scope before spending model time:

```bash
oracle --dry-run json \
  --engine browser \
  --browser-transport cdp \
  --model gpt-5-pro \
  -p "$TASK" --file "$RELEVANT_FILES"
```

Completed runs persist answers, usage, cost, session ids, model choices, and lineage under `~/.oracle/sessions/<id>/`. Exit code is non-zero on failure.

## Dedicated-profile concurrency and account boundaries

Direct-CDP consultations share Oracle's dedicated profile but own distinct tab
leases. Startup converges on one exact profile endpoint, and model
selection/submission is serialized at the composer boundary. Long waiting stays
inside the browser worker; the coding agent does not need to poll, reopen the
same URL, or create a duplicate Oracle session. Agents must not retry an
interrupted submission blindly: check the Oracle session first, because a
stored conversation receipt changes recovery into read-only capture.

Authentication, model entitlement, and account challenges remain human-owned.
Unattended means Oracle connects to its isolated profile without a recurring
personal-browser debugging approval. It does not mean bypassing account
controls.

OpenCLI's alternative transport uses one Oracle-owned transport lock for model
selection/submission and one long-lived waiter tab for answer harvest. It does
not launch repeated OpenCLI processes/tabs as a polling loop.

## Multi-agent shared profile

When multiple agents share Oracle's dedicated profile, Oracle coordinates browser tab slots so parallel runs queue instead of crashing. Tune with:

- `--browser-max-concurrent-tabs` — default 3 simultaneous tabs.
- `--browser-profile-lock-timeout` — wait for the profile lock before sending.
- `--browser-reuse-wait` — wait for a shared Chrome profile before launching.

The normal local launcher already reuses one signed-in dedicated Chrome process
when it is reachable; do not expose or manually route its port. Use
`--remote-chrome` only when a separately controlled host actually owns the
browser. See [Dedicated Chrome](dedicated-chrome.md) and
[Browser Mode](browser-mode.md).

## Cost / safety hygiene

- **Preview costly API bundles when scope is uncertain.** `--dry-run summary --files-report` is useful before a large metered API call. It is not a gate for normal subscription-backed browser consultations.
- **Cap file size.** `~/.oracle/config.json` → `maxFileSizeBytes`, or `ORACLE_MAX_FILE_SIZE_BYTES`. Default is 1 MB per file.
- **Excludes are your friend.** `--file "src/**" --file "!**/*.test.ts" --file "!**/*.snap"` cuts most fixtures.
- **API mode runs cost real money.** If your agent runs Oracle autonomously, scope it: pin `--model`, set `--timeout`, and review the session log. Many users gate API mode behind explicit user consent and let browser mode run free.

## Patterns that work

- **Stuck → Oracle.** When the agent has been spinning on the same bug, hand the failing test plus the involved files to GPT-5.6 Pro through the dedicated-CDP lane. Keep the question self-contained so the second model can challenge the actual evidence rather than reconstructing the first agent's context.
- **Plan → Oracle → execute.** Draft the plan, ask ChatGPT GPT-5.6 Pro through the canonical Oracle lane to challenge it, then implement.
- **Refactor → cross-check.** After a non-trivial refactor, send the diff plus the spec to a different provider than the one that wrote the diff. Catches drift fast.
- **Followup chain.** Use `--followup <id>` to keep one Pro session alive across iterations rather than re-bundling the whole repo every time. See [Followup](followup.md).
