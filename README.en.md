<!-- readme-sync:language -->
<p align="right">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="./assets/readme/oracle-hero.svg" alt="Oracle visual identity: an indigo and gold wordmark above sealed context, exact-session recovery, declared batches, and dedicated Chrome capabilities" width="1100">
</p>

<!-- readme-sync:identity -->

# Oracle / IndelibleVivi fork

> Recoverable GPT-5.6 Pro consultations — one durable session or a declared parallel batch.

A high-cost Pro run should not depend on one fragile browser tab. This public fork persists selected context, dispatch receipts, conversation identity, answers, artifacts, and recovery lineage inside an Oracle session. Its canonical browser lane reaches ChatGPT through a dedicated Chrome for Testing profile and loopback CDP.

Oracle owns the prompt bundle, browser actions, session truth, recovery, and follow-up lineage. The human owns the first sign-in, real account challenges, and explicit owner decisions required by Batch Oracle. OpenCLI remains an explicit alternative transport for ordinary consultations; it never takes over a failed CDP run automatically.

`GPT-5.6 Pro` is the current human-facing target. The CLI uses the stable alias `gpt-5-pro` and selects and verifies the current GPT-5.6 Sol + Pro combination in the submission tab.

<!-- readme-sync:modes -->

## Two primary paths

| Path                | Best for                                                            | What Oracle persists                                                                           |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Single consultation | One complex review, research, or architecture question              | dispatch, conversation, answer, artifacts, follow-up, and recovery state                       |
| Batch Oracle        | At least two independently reviewable questions inside one decision | sealed source snapshot, parallel blind lanes, barrier, owner decisions, and optional synthesis |

Batch lanes are separated by responsibility rather than used as a same-question voting panel. Every first-stage input is sealed before any dispatch. Lanes then run concurrently within local and account capacity, and synthesis can start only after the barrier closes.

<!-- readme-sync:quickstart -->

## Quick start

> The Oracle packages published through Homebrew and npm come from upstream and do not contain this fork's changes. Install this repository from source.

Requirements: Node.js 24 or newer and a ChatGPT account with access to the requested model and reasoning tier.

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install
pnpm build
npm link
```

Install the official Chrome for Testing build and establish an Oracle-only browser identity:

```bash
oracle browser install
oracle browser setup --use-mock-keychain
oracle browser smoke
```

`setup` is used only for the first human sign-in and does not expose a CDP endpoint. The command returns after the entire Chrome for Testing browser is closed. `smoke` performs two real cold starts and verifies persisted authentication, composer readiness, exact-target cleanup, and endpoint shutdown without submitting a prompt.

On macOS, `--use-mock-keychain` is an explicit unattended-mode tradeoff. It prevents the isolated profile from repeatedly requesting access to everyday Chrome Safe Storage while weakening at-rest cookie protection for that profile. Keep the directory owner-only and ChatGPT-only.

<!-- readme-sync:single-session -->

## Run one consultation

```bash
oracle --engine browser \
  --model gpt-5-pro \
  -p "Audit this change for correctness and missing tests." \
  --file "src/**"
```

Long runs remain recoverable sessions. When Pro is quiet, do not create a duplicate consultation. Read or reattach the existing session first:

```bash
oracle status --hours 72
oracle session <session-id> --render
oracle --followup <session-id> \
  -p "Challenge the previous recommendation and return the final decision."
```

Oracle records the committed turn identity and timing evidence. Recovery must return to the original conversation. A new attempt is allowed only on explicit resume after a durable receipt proves that the prompt was unsubmitted, uncommitted, and `retrySafe:true`.

<!-- readme-sync:batch -->

## Batch Oracle

Batch Oracle separates one complex decision into independent review responsibilities such as product constitution, security, human cognition, and an adversarial tribunal. It preserves every raw lane answer and disagreement. The host may integrate those answers directly or configure a contradiction-first synthesis.

```bash
oracle batch validate batch.json5
oracle batch run batch.json5
oracle batch status <batch-id> --json
oracle batch resume <batch-id>
oracle batch accept-missing <batch-id> --lane <lane-id> --reason "<owner reason>"
oracle batch resume <batch-id> --allow-partial
oracle batch accept-missing <batch-id> --synthesis --reason "<owner reason>"
oracle batch render <batch-id> --all
```

A missing first-stage lane and a committed synthesis that remains unavailable after bounded recovery both require an explicit durable owner decision. Oracle never silently accepts missing work and never replaces a committed conversation with a new prompt. Ordinary field use usually means two or three independent lanes; configured Pro synthesis remains optional.

See [Batch Oracle v1](docs/batch-oracle.md) for the manifest, state machine, recovery matrix, bundle identity, and v1 boundaries.

<!-- readme-sync:browser -->

## Why a dedicated Chrome

The canonical lane in this fork uses two isolation boundaries together:

- Chrome for Testing provides an application identity separate from everyday Chrome.
- `~/.oracle/browser-profile` provides an Oracle-only persistent user-data directory.

Ordinary runs expose CDP only on `127.0.0.1` and manage pages by exact target ID. Oracle never points its launcher at the default personal Chrome profile and does not depend on the recurring Allow dialog used when an agent connects to everyday Chrome.

See [Dedicated Chrome transport](docs/dedicated-chrome.md) for the full lifecycle, privacy, and verification contract.

<!-- readme-sync:trust -->

## Trust boundary

| Boundary                           | Authority          | Contract                                                                              |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Prompt and selected files          | Oracle             | Assemble locally and send only explicitly selected context                            |
| Session truth                      | Oracle             | Persist dispatch, conversation, answer, artifacts, and lineage                        |
| Browser process                    | Oracle             | Launch the isolated profile, bind only loopback CDP, and clean up exact owned targets |
| App identity                       | Chrome for Testing | Keep Oracle processes separate from everyday Chrome                                   |
| Browser data                       | Dedicated profile  | Separate ChatGPT login state from personal browsing and other accounts                |
| Account and missing-work decisions | Human owner        | Complete first sign-in, real challenges, and explicit owner closure                   |

<!-- readme-sync:scope -->

## Current fork scope

| Capability                         | Dedicated CDP |          OpenCLI alternative |
| ---------------------------------- | ------------: | ---------------------------: |
| GPT-5.6 Pro text consultation      |           Yes |                          Yes |
| Persistent isolated login          |           Yes |         Browser Bridge-owned |
| Recovery without resubmission      |           Yes |                          Yes |
| Oracle follow-up lineage           |           Yes |                          Yes |
| Deep Research                      |           Yes | No; rejected before dispatch |
| Image generation and download      |           Yes | No; rejected before dispatch |
| Batch Oracle v1                    |           Yes |                           No |
| Automatic cross-transport fallback |         Never |                        Never |

Attach-running personal Chrome, remote Chrome, API, MCP, and render paths remain separate explicit modes. See [Browser Mode](docs/browser-mode.md) for their boundaries.

<!-- readme-sync:docs -->

## Documentation

| Start here                                                                      | Contents                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Dedicated Chrome transport](docs/dedicated-chrome.md)                          | canonical topology, setup, lifecycle, privacy, and verification                |
| [Batch Oracle v1](docs/batch-oracle.md)                                         | parallel-first manifests, sealing, barrier, synthesis, recovery, and rendering |
| [Quickstart](docs/quickstart.md)                                                | first sign-in, smoke, first consultation, render, and reattach                 |
| [Browser Mode](docs/browser-mode.md)                                            | direct CDP, attach-running, remote Chrome, OpenCLI, Deep Research, and images  |
| [OpenCLI alternative](docs/opencli-transport.md)                                | sealed bridge handoff and waiter-only recovery                                 |
| [Coding Agents](docs/agents.md)                                                 | Codex, Claude Code, Cursor, CLI, and MCP usage                                 |
| [Sessions](docs/sessions.md) · [Follow-ups](docs/followup.md)                   | durable runs and conversation lineage                                          |
| [Configuration](docs/configuration.md) · [CLI reference](docs/cli-reference.md) | config precedence, flags, and limits                                           |

<!-- readme-sync:development -->

## Development and verification

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm docs:check
pnpm test:packed-cli
```

`oracle browser smoke` is the account-safe live transport test: it performs two cold starts and never creates a ChatGPT conversation.

<!-- readme-sync:provenance -->

## Provenance and license

This is a public fork of [steipete/oracle](https://github.com/steipete/oracle), preserving upstream Git history and the MIT license. The dedicated-Chrome default path, the fork's Pro timing and receipt contract, the OpenCLI alternative, and Batch Oracle are maintained within this fork. This repository is neither an upstream release nor an OpenAI product.

MIT. See [LICENSE](LICENSE).
