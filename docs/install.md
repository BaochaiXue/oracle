---
title: Install
description: "Install the IndelibleVivi Oracle fork from source. Upstream Homebrew and npm packages are documented separately. Node 24+ required."
---

## Install this fork from source

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install
pnpm build
npm link
```

This is the installation path for the fork's dedicated Chrome defaults, GPT-5.6 Pro receipt
contract, OpenCLI alternative, and Batch Oracle. It requires Node **24 or newer**.

Install the official Chrome for Testing build and create the Oracle-only browser identity:

```bash
oracle browser install
oracle browser setup --use-mock-keychain
oracle browser smoke
```

See [Quickstart](quickstart.md) for the first sign-in, smoke contract, and first consultation.

## Upstream package distributions

The following commands install [steipete/oracle](https://github.com/steipete/oracle), not this
fork. They remain useful when the upstream release is the intended product boundary.

### Homebrew (macOS / Linux)

```bash
brew install steipete/tap/oracle
```

The tap also publishes the `oracle-notifier` macOS helper used by long-running browser runs.

### npm / pnpm

```bash
npm install -g @steipete/oracle
# or
pnpm add -g @steipete/oracle
```

### Run without installing

```bash
npx -y @steipete/oracle --help
pnpx @steipete/oracle --help
```

For CI or repeatable scripts, pin the upstream package version instead of resolving its moving
latest tag on every run.

## API keys (optional)

API mode is opt-in and reads keys from the environment. Set whichever providers you'll use:

| Provider     | Env var                                                           | Models                                        |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------- |
| OpenAI       | `OPENAI_API_KEY`                                                  | GPT-5.x, GPT-5.x Pro, GPT-5.1 Codex           |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `..._DEPLOYMENT` | Same models, hosted on Azure                  |
| Anthropic    | `ANTHROPIC_API_KEY`                                               | Claude Sonnet 4.6, Claude Opus 4.1            |
| OpenRouter   | `OPENROUTER_API_KEY`                                              | Any OpenRouter id (e.g. `minimax/minimax-m2`) |

If no key is set, Oracle defaults to **browser mode** and drives ChatGPT directly — see [Browser Mode](browser-mode.md) for the manual-login flow.

## Where Oracle stores state

| Path                       | Contents                                                 |
| -------------------------- | -------------------------------------------------------- |
| `~/.oracle/config.json`    | Defaults (JSON5). See [Configuration](configuration.md). |
| `~/.oracle/sessions/<id>/` | Run logs, bundles, transcripts, generated artifacts      |
| `~/.oracle/cookies.json`   | (Optional) inline ChatGPT cookies for browser mode       |

Override the root with `ORACLE_HOME_DIR=/some/path` if you'd rather keep state under XDG config or per-project.

## Updating this fork

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
npm link
```

Run those commands from the fork checkout. `oracle --version` reports the linked build.

For an upstream package installation, use `brew upgrade oracle` or
`npm update -g @steipete/oracle`. Upstream releases live on
[steipete/oracle Releases](https://github.com/steipete/oracle/releases).
