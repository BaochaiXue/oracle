---
title: Install from source
description: "Build and link the IndelibleVivi Oracle fork from its source checkout. Node 24+ is required."
---

# Install this fork from source

This repository is the only installation source for the IndelibleVivi fork.
It does not publish an npm package, Homebrew formula, or prebuilt release.

## Requirements

- Git
- Node.js **24 or newer**
- Corepack with the repository-pinned pnpm version
- macOS, Linux, or Windows for the CLI; macOS is required only to build the
  optional native notifier helper

## Clone, build, and link

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm link
oracle --help
oracle --version
```

`npm link` exposes the locally built `oracle` and `oracle-mcp` commands. It does
not publish anything. Run commands from the checkout with `pnpm oracle -- ...`
if you prefer not to create a global link.

## Updating the source checkout

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
npm link
```

Review incoming source changes before updating a machine that owns a signed-in
browser profile.

## API keys (optional)

API mode is opt-in and reads keys from the environment. Browser mode is the
fork's primary GPT-5.6 Pro path and does not require an API key.

| Provider     | Environment variables                                            |
| ------------ | ---------------------------------------------------------------- |
| OpenAI       | `OPENAI_API_KEY`                                                 |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, deployment vars |
| Anthropic    | `ANTHROPIC_API_KEY`                                              |
| OpenRouter   | `OPENROUTER_API_KEY`                                             |

See [Browser Mode](browser-mode.md) for the dedicated-profile login flow and
[Configuration](configuration.md) for source-owned defaults.

## Local state

| Path                       | Contents                                                |
| -------------------------- | ------------------------------------------------------- |
| `~/.oracle/config.json`    | Defaults (JSON5)                                        |
| `~/.oracle/sessions/<id>/` | Run logs, bundles, transcripts, generated artifacts     |
| `~/.oracle/cookies.json`   | Optional inline cookies for explicitly configured modes |

These paths may contain sensitive account or conversation data. Never attach
them to an issue or pull request. Override the state root with
`ORACLE_HOME_DIR=/some/path` when an isolated location is required.

## Upstream-only distribution appendix

The upstream project separately distributes the npm package
`@steipete/oracle`, the Homebrew formula `steipete/tap/oracle`, and upstream
release artifacts. Those channels install upstream Oracle, **not this fork**.
They are named here only to prevent installation ambiguity; this fork does not
control, mirror, endorse, or publish through them.
