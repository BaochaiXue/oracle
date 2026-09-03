---
name: oracle
description: "Second-opinion review from ChatGPT GPT-5.6 Pro with real repository context: hard bugs, stuck investigations, design and refactor decisions. Bundles a prompt plus selected files, and always names the project GitHub owner/repository so the connector can read it."
---

# Oracle (CLI) — best use

Oracle bundles a prompt and selected files for a ChatGPT GPT-5.6 Pro
second-model review with real repository context. The canonical lane is browser
mode over direct CDP with Oracle's dedicated profile. A prompt is required;
attach files only when they add necessary context. Treat responses as advisory
and verify them against the codebase and tests.

This fork reserves the canonical Oracle lane for ChatGPT GPT-5.6 Pro. Use
OpenCLI separately for incidental Gemini queries; Oracle never dispatches or
falls back to Gemini.

## Main use case (browser, GPT-5.6)

Use browser mode with GPT-5.6 when the ChatGPT account exposes it. Base Sol and
Sol Pro are two execution tiers of the same model row, not two model rows: base
Sol tops out at the Extra High effort setting, while Pro is the top tier of the
same Intelligence picker, reserved for difficult or long-running work. Without a
`--browser-thinking-time` value Oracle leaves ChatGPT's default tier untouched.

This skill supports exactly one target: GPT-5.6 Sol Pro. GPT-5.5 and GPT-5.5
Pro are no longer supported here. The CLI still parses their legacy aliases for
compatibility, but this skill never issues them; a request that needs GPT-5.5
is out of scope and must be reported as such rather than dispatched.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Browser transport: direct CDP (`--browser-transport cdp`)
- Window: visible while needed and never activated for submission. Invoke the
  canonical browser lane with `--browser-keep-browser` so the dedicated Chrome
  process remains available across users and sessions. A terminal run closes
  only its exact Oracle-owned tab; incomplete, foreign, and unowned meaningful
  tabs remain open. macOS cold starts use LaunchServices background-open
  semantics with Chrome's no-startup-window switch, new tabs use `focus:false`,
  and page-side focus emulation supports trusted input without changing the
  frontmost app
- Base Sol: `--model gpt-5.6-sol`
- Base Sol maximum reasoning: `--browser-thinking-time extra-high` (Extra High)
- Explicit Pro effort: `--browser-thinking-time pro` (fails closed if Pro cannot
  be confirmed). Pair it with `--model gpt-5-pro`, not with a non-Pro alias; see
  "GPT-5.6 model selection" for why the alias changes run behavior.
- API Pro maximum reasoning: `--model gpt-5.6-sol --reasoning-mode pro --reasoning-effort max`
- Browser Pro capture: 60 minutes per bound-conversation attempt, with one
  same-conversation reload and no resubmission, for a two-hour default ceiling
- Attachments: directories/globs plus excludes; never attach secrets by default

GPT-5.6 availability is account-dependent. Confirm the base Sol picker and
retain model-selection evidence. A bare `Pro` picker label proves picker
selection but does not, by itself, prove the server-side Pro generation. If the
Pro target cannot be confirmed, fail closed; do not substitute another model.

## GPT-5.6 model selection

This version supports GPT-5.6 on both surfaces, but Pro selection differs:

- `gpt-5.6`: follow the GPT-5.6 family default
- `gpt-5.6-sol`: pin ChatGPT's `GPT-5.6 Sol` entry
- Browser: `gpt-5-pro` is the stable CLI alias for the canonical lane. It selects
  the `GPT-5.6 Sol` model row and then drives the `Pro` effort tier. There is no
  separate `Pro` model row to select.
- API: `--reasoning-mode pro` enables Pro execution on `gpt-5.6-sol`; pair it with `--reasoning-effort max` for maximum reasoning

Use `--model gpt-5-pro` for every canonical browser consult. `--model
gpt-5.6-sol` reaches the same ChatGPT model row, but the CLI does not classify
it as a Pro-tier alias: it neither defaults the effort tier to Pro nor starts
the run in a detached worker. Requesting Pro effort on a non-Pro alias leaves a
capture of up to two hours attached to the foreground process, where any host
timeout destroys it.

For the canonical GPT-5.6 Pro browser lane, use:

```bash
oracle --engine browser --browser-transport cdp --model gpt-5-pro \
  --browser-thinking-time pro --browser-keep-browser \
  -p "<task>" --file "src/**"
```

For GPT-5.6 Sol Pro through the Responses API, use:

```bash
oracle --engine api --model gpt-5.6-sol \
  --reasoning-mode pro \
  --reasoning-effort max \
  -p "<task>" --file "src/**"
```

Do not use `--model "GPT-5.6 Sol Pro"`. Pro is intentionally handled as a
browser effort tier and an API reasoning mode, never as a model slug. Browser
label validation rejects unknown future variants such as `gpt-5.6-luna` instead
of silently falling back to Sol; API runs preserve such provider model IDs
unchanged.

Browser mode maps these aliases to ChatGPT's Sol picker. API and multi-model
runs preserve the corresponding first-party OpenAI model IDs; provider-qualified
and unrelated custom IDs remain pass-through values.

The GPT-5.6 browser support depends on the unified Intelligence picker. It
recognizes the current English and Chinese effort labels, avoids matching
`高` inside `极高`, drives the current five-step Power slider through its ARIA
position and keyboard-owning row when Pro is not a static menu option, and
re-queries the composer pill after React replaces it so selection verification
cannot rely on a detached stale node.

## Golden path

1. For a project published on GitHub, resolve its canonical GitHub repository
   identity from Git metadata and add the mandatory connector directive below.
   This step is required, not advisory; the only exemption is a project with no
   GitHub remote.
2. Pick the smallest file set that still contains the truth.
3. Run the browser consultation directly. Normal consults must not run
   dry-runs, smoke tests, live tests, doctor, or preflight validation unless a
   concrete bundle/runtime uncertainty makes that diagnostic material.
4. Use browser mode, direct CDP, and the GPT-5.6 Pro target. Do not switch
   model, tier, provider, or transport silently.
5. If a run detaches or times out, reattach to the stored session instead of
   starting a duplicate. A host tool timeout is not a failed review; see
   "Long runs and host timeouts".

## GitHub repository context (mandatory)

Every GPT-5.6 Pro consultation about a project already published on GitHub MUST
actively instruct ChatGPT to open that repository through its connected GitHub
app/connector. This is not optional and not a fallback: the connector is how the
model reads commit history, issues, pull requests, and the files you chose not
to attach. Dispatching without it wastes the strongest context channel Oracle
has. The only exemption is a project with no GitHub remote at all.

Name the project by its GitHub identity, never by the local folder. A checkout
in `~/bit` whose remote is `Owner/neural-decoder` must be introduced to ChatGPT
as `Owner/neural-decoder`; `bit` is not the project name.

Resolve the identity from Git metadata before writing the prompt:

```bash
git -C <repo> rev-parse --abbrev-ref --symbolic-full-name '@{u}'  # tracked remote
git -C <repo> remote -v                                           # all remotes
git -C <repo> rev-parse --short HEAD                              # commit
git -C <repo> status --porcelain                                  # dirty state
```

Reduce the remote URL to a bare `owner/repository` slug: drop
`git@github.com:`, `https://github.com/`, any embedded credentials, and a
trailing `.git`. `git@github.com:BaochaiXue/oracle.git` becomes
`BaochaiXue/oracle`.

Then decide:

- Exactly one GitHub remote: that is the project.
- Fork with both `origin` and `upstream`: the project is the fork. State both
  roles explicitly so the model does not answer from the wrong tree, and use
  upstream as the project only when the task targets upstream.
- Several GitHub remotes that disagree and none is the tracked one, or no GitHub
  remote: omit the block. Never guess a slug and never substitute the directory
  name.

Never place a raw remote URL, embedded credentials, access token, or private
machine path in the prompt. Include only the sanitized `owner/repository` slug
and, when useful, the branch and commit. Before dispatch, add this block with
the placeholders replaced:

```text
GitHub repository context:
Use the connected GitHub app/connector to inspect the exact repository
`OWNER/REPOSITORY` for relevant code, documentation, issues, and pull requests
before answering. This repository identity comes from Git metadata, not the
local directory name. Do not substitute a similarly named repository. If the
GitHub app or this repository is unavailable or unauthorized in this ChatGPT
surface, state that explicitly and continue only from the prompt and attached
files. Treat the attached files and stated local commit or dirty diff as
authoritative wherever they differ from GitHub.
```

Verify all four before pressing Send:

1. The slug came from Git metadata, not from the directory name.
2. The slug carries no URL, credential, token, or local path.
3. Fork and upstream roles are named whenever both remotes exist.
4. The local commit and dirty state are stated when they affect the answer.

The connector supplies remote background; it does not replace the minimal
attachments needed to establish unpushed, dirty, generated, or otherwise
commit-specific facts. For Batch Oracle, place the same repository identity
and directive in every relevant lane while keeping the sealed snapshot as the
evaluation authority. A follow-up in the same conversation need not repeat the
block unless the repository or authority changed.

## WSLg Linux Chrome ownership

When Oracle runs its Linux Chrome for Testing inside WSLg, invoke every
`oracle` and `oracle-mcp` command with both
`ORACLE_BROWSER_REMOTE_DEBUG_HOST=127.0.0.1` and
`ORACLE_BROWSER_LINUX_BASIC_PASSWORD_STORE=1`. The first keeps CDP inside the
WSL guest instead of routing it to the Windows resolver host. The second is an
explicit tradeoff for WSL installations without Secret Service: it lets the
dedicated profile retain ChatGPT cookies with Chromium's weaker basic password
store. Keep that profile owner-only and never reuse an everyday browser profile.

The human performs only ChatGPT sign-in and real account challenges. The agent
owns browser setup, exact-tab closure, status, smoke, recovery, and normal
lifecycle. Process-level termination is not normal cleanup. Changing
password-store mode requires moving the old dedicated
profile to a recoverable backup and creating a fresh owner-only profile before
sign-in; restored tabs from an old profile are not login-persistence evidence.
After the human confirms sign-in, verify that the setup PID belongs to Oracle's
Chrome for Testing executable, names the dedicated user-data directory, and
carries the expected password-store flag. Keep that Chrome process running and
close only the exact setup tab through its verified CDP target when it is no
longer needed. Never send `WM_DELETE_WINDOW`, use a broad `pkill`, or signal the
Chrome process merely to clean up a consultation. Run the account-safe
two-cold-start smoke after first setup or a concrete browser-contract change;
it submits no prompt.

## First-run browser setup

Before the first consultation on a machine, bring up Oracle's dedicated Chrome:

```bash
oracle browser install   # fetch Chrome for Testing
oracle browser setup     # human signs in to ChatGPT; opens no CDP endpoint
oracle browser status    # four-line health summary
oracle browser smoke     # two real cold starts; submits no prompt
```

`setup` exists only for the human sign-in and returns after the whole Chrome for
Testing instance is closed. Run `smoke` after first setup or a concrete
browser-contract change. For a stuck profile use `oracle browser heal` before
considering any process-level action.

## Long runs and host timeouts

A Pro browser capture is allowed 60 minutes per bound-conversation attempt, with
one same-conversation reload, for a two-hour default ceiling. Agent harnesses cap
a single shell call far below that; Claude Code's Bash tool tops out at ten
minutes.

The canonical lane survives this. A browser run on a Pro-tier alias such as
`gpt-5-pro` starts in a detached worker, so the consultation keeps running and
still persists its answer after the foreground stream is cut. A host tool timeout
is therefore not evidence that the review failed, and it is never grounds for a
duplicate dispatch.

When the foreground call is cut off:

1. `oracle status --hours 72` to locate the session.
2. `oracle session <id> --render` to read the stored answer. `--render` targets
   a rich TTY; from a non-interactive shell use `oracle session <id> --path`
   and read the printed `transcript.md` directly.
3. Create another attempt only after a durable receipt proves the prompt was
   never submitted. Never re-run a consultation merely to make it look complete.

Detachment is off in two cases: `ORACLE_NO_DETACH=1` in the environment, and
remote execution through `--remote-host`. Never set the first for a Pro consult
from an agent harness. Non-Pro aliases do not detach either. Do not request Pro
effort on one and then leave it in the foreground.

## Commands

- Show help:
  - `oracle --help --verbose`

- Optional bundle diagnostics (large or uncertain file sets only):
  - `oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `oracle --dry-run full -p "<task>" --file "src/**"`

- Inspect token usage:
  - `oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run:
  - `oracle --engine browser --browser-transport cdp --model gpt-5-pro --browser-thinking-time pro --browser-keep-browser -p "<task>" --file "src/**"`

- Manual paste fallback:
  - `oracle --render-markdown --copy-markdown -p "<task>" --file "src/**"`
  - `--render` is an alias for `--render-markdown`.
  - `--render-markdown` cannot be combined with `--dry-run`; the CLI rejects it.

- Performance trace:
  - `oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "<task>" --file "src/**"`

## Parallel-first Batch Oracle

Use a declared batch when one difficult decision contains at least two
independent, decision-relevant questions whose prompts and evidence can be
sealed before either answer is known.

For every lane, state its mandate, why it exists, falsification target,
authority/files, exact prompt, and output contract. Do not fan out an identical
prompt for voting or manufacture distinction through reviewer personas alone.

Before dispatch, determine the ready set. A lane belongs in the current
parallel stage whenever its complete input can already be sealed. Dispatch all
ready lanes concurrently up to the owner's configured capacity. Do not
serialize independent work for procedural convenience.

Resolve the ready-set membership, copy each admitted source exactly once into
the owner-only batch snapshot, and assemble every first-stage lane from that
published snapshot. Seal every lane before dispatching any of them.
Independent lanes receive a blind first pass and never see sibling answers
while the stage is open.

Arrival order is transport state, not epistemic priority. Persist each raw
answer and receipt as it arrives, but do not perform rolling synthesis, rewrite
sibling prompts, or choose a direction before the barrier closes.

A batch owns one recoverable logical session per lane. Reattach quiet,
detached, or timed-out work within that lane. Create another attempt only when
durable evidence proves the prior prompt was unsubmitted, uncommitted, and
retry-safe. Once `dispatchStartedAt` exists, missing runtime evidence is
indeterminate rather than permission to send again.

Close the first-stage barrier only after every required lane is terminal.
Partial synthesis requires two explicit owner actions: record each unavailable
lane with `oracle batch accept-missing <batch-id> --lane <lane-id> --reason
"<reason>"`, then resume with `--allow-partial`. It must name missing lanes and
weakened conclusions.

Batch child sessions may be inspected by ID, where inspection means only
reading status/metadata, rendering existing logs/artifacts, or printing paths.
A plain `oracle session <child-id>` attach must return one read-only snapshot:
never wait, auto-reattach, repair capture, append logs/artifacts, update a model
run/session, or terminalize. Completed children remain renderable.

Never complete, recover, continue, or clone a Batch child with generic
`session --live|--harvest`, `--followup <child-id>`, or `restart <child-id>`.
Those paths fail closed before tab access, conversation URL resolution, or new
session creation, including for an owner-abandoned synthesis. Use `oracle batch
resume <batch-id>` for recovery/retry/completion and the parent
`batch accept-missing` commands for owner closure. Start a new ordinary Oracle
run explicitly when the desired consultation must be independent of the Batch
lineage.

A synthesis session receives canonical shared-authority bytes plus each
verified answer, its immutable receipt, and its sealed input manifest. It must
preserve dissent, identify unsupported agreement, produce a contradiction
matrix, expose owner-pending decisions, and propose one bounded next experiment
with kill criteria. Never decide by majority vote alone.

When every first-stage lane is accepted but synthesis remains `recoverable`,
`error`, or `indeterminate` after bounded exact recovery, the owner may preserve
that child and close the stage with `oracle batch accept-missing <batch-id>
--synthesis --reason "<reason>"`. This marks synthesis `abandoned` and the
parent `partial`; it never resends and does not discard verified lane answers.

Keep raw answers durable and loadable on demand. Do not permanently inject
every long child answer into the host's working context. During an open stage,
retain only batch status, lane identities, receipts, and paths.

Batch v1 has one independent parallel stage plus one optional synthesis stage.
Do not recursively spawn batches or grow an undeclared workflow DAG. Use only
the owner's configured capacity. Stop and report allowance or request-frequency
gates; never bypass them by changing model, transport, provider, account, or
engine.

Use `oracle batch validate <manifest.json5>` before the first real run when the
manifest or file scope is new. Continue with `oracle batch run`, then recover
the parent through `oracle batch status` and `oracle batch resume`; do not
restart individual Batch children. Load raw answers only when needed through
`oracle batch render --lane` or `--all`.

## Attaching files

`--file` accepts files, directories, and globs. Pass it multiple times or use
comma-separated entries.

- Include: `--file "src/**"`, `--file src/index.ts`, `--file docs --file README.md`
- Exclude: prefix a pattern with `!`, for example `--file "!src/**/*.test.ts"`
- Default ignored directories: `node_modules`, `dist`, `coverage`, `.git`,
  `.turbo`, `.next`, `build`, and `tmp`
- Globs honor `.gitignore` and do not follow symlinks.
- Dotfiles require an explicit dot-segment in the pattern, such as
  `--file ".github/**"`.
- Files over 1 MB are rejected by default; configure
  `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` when necessary.

Keep total input under roughly 196k tokens. Use `--files-report` or
`--dry-run json` to identify oversized inputs. Never attach `.env` files,
private keys, auth tokens, or other secrets unless they have been redacted and
are essential to the question.

## Engines and browser controls

- The canonical skill invocation explicitly selects browser mode, direct CDP,
  and GPT-5.6 Pro; it does not rely on engine auto-selection.
- Browser mode in this fork supports ChatGPT GPT targets only. API-only models
  remain available only when the operator explicitly intends an API run.
- API runs require explicit user consent because they may incur usage costs.
- Browser attachments use `--browser-attachments auto|never|always`.
- For many files, add `--browser-bundle-files --browser-bundle-format auto|text|zip`.
- Reuse an existing Chrome session with `--browser-tab <ref>`,
  `--browser-attach-running`, or `--remote-chrome <host:port>`.
- Use `--browser-model-strategy select|current|ignore` to control picker
  behavior.
- Use `--browser-follow-up "<prompt>"` for another turn in the same browser
  conversation, or `--followup <sessionId|responseId>` for a stored run.
- Use `--browser-research deep` only when Deep Research is explicitly wanted.

## API preflight

Before an API run, check provider readiness without printing secrets:

```bash
oracle doctor --providers --models gpt-5.6-sol,claude-4.6-sonnet
oracle --preflight --models gpt-5.6-sol,claude-4.6-sonnet
oracle --route --model gpt-5.6-sol
```

Use `--provider openai` or `--no-azure` when first-party OpenAI routing is
required. For multi-model panels where partial success is useful, use
`--allow-partial --write-output <path>` so successful outputs and the manifest
can be recovered.

Set an explicit deadline for automation, for example `--timeout 10m`; Oracle
derives the HTTP timeout unless `--http-timeout` is supplied.

## Sessions and recovery

- Sessions are stored under `~/.oracle/sessions`; override with
  `ORACLE_HOME_DIR`.
- Browser artifacts include `transcript.md` and, when available, research
  reports and generated images.
- List recent sessions with `oracle status --hours 72`.
- Attach with `oracle session <id> --render`.
- Use `--slug "<3-5 words>"` for readable session IDs.
- If a run times out, reattach; do not re-run it. Use `--force` only when a
  genuinely new identical run is intended.
- This skill explicitly selects `browserLifetime:"persistent"` through
  `--browser-keep-browser`, even though the CLI baseline is `while-needed`.
  The creation-time CDP target ID is immutable ownership evidence.
  Browser-terminal owned tabs close even when later evidence admission rejects
  the captured result; recoverable incomplete tabs receive bounded holds;
  unknown meaningful pages are preserved. Startup/final-release reconciliation
  closes terminal owned targets, coalesces blank sentinels, and reports a durable
  `complete`, `partial`, or `failed` receipt without terminating the shared
  Chrome process.
- Keep the dedicated Chrome process running after consultations. Prefer
  `oracle browser reconcile-tabs --plan` and bounded exact-target cleanup over
  process shutdown. Process repair, restart, or termination is allowed only as
  explicit browser maintenance after `oracle browser status` reports zero
  active and zero recoverable consultations and exact-profile inspection proves
  that no foreign or unowned meaningful page would be lost. If any of those
  conditions is unknown, leave Chrome running.
- A missing model-selector button is not permission to retry a Pro request with
  `--browser-model-strategy current` or `ignore`. The canonical lane reloads
  the same Oracle-owned target once before Send and re-runs strict model/effort
  verification. If that bounded repair still fails, report the consultation as
  unsent and stop; never navigate an attached user-owned tab, create a
  replacement target, switch transport, or weaken the requested model.
- Diagnose retained tabs with `oracle browser reconcile-tabs --plan`. Apply
  ordinary owned/blank cleanup with `--apply`; add
  `--include-untracked-chatgpt` only when the operator explicitly intends to
  purge historical ChatGPT pages from Oracle's verified exact local Chrome for
  Testing profile. Never use that mode for attach-running, remote, everyday, or
  another Chrome profile.
- Keep caller-facing output task-level by default: preparing, sent, waiting,
  and complete, plus a repair phase only when one actually occurs. If browser
  startup fails before a verified Send, say that the review was not sent and
  preserve `promptSubmitted:false`; do not describe it as a started independent
  review, expose PID/port/executable/receipt internals, write private
  continuity, or launch a duplicate consultation merely to make the failure
  look complete.
- For direct-CDP Pro runs, trust is turn-scoped. The active turn must have its
  own dispatch/elapsed/workload receipt, a verified commit, and a normalized
  prompt digest bound to the exact committed user-turn index. Reattach accepts
  only the assistant successor of that matched turn. The first durable
  conversation URL is accepted only after that committed turn matches, then its
  conversation ID is frozen: same-target navigation to another conversation
  must stop thinking/response/Copy capture without overwriting the original
  recovery receipt. Treat
  `pro-turn-not-committed`, `pro-turn-identity-mismatch`,
  `conversation-id-mismatch`, `committed-prompt-mismatch`,
  `pro-response-timing-indeterminate`, and partial active workload as terminal;
  never start a duplicate to work around them.
- Attachment bytes are established before each Pro dispatch, including
  fallback submissions. A missing size is read from the local file; it is never
  counted as zero.
- Oracle has no ChatGPT conversation-archive capability. Conversations remain
  visible for inspection, recovery, provenance, and manual follow-up. Browser
  target cleanup may close Oracle-owned Chrome targets; it must never archive
  or delete the corresponding ChatGPT account conversation.

## Prompt template

Oracle starts with zero project knowledge. Include:

- GitHub project identity and the mandatory connector directive above whenever
  the project is published on GitHub, named by its `owner/repository` slug
- Project briefing: stack, services, build/test commands, and platform constraints
- Where things live: entrypoints, configs, key modules, and dependency boundaries
- Exact question, prior attempts, and verbatim error text
- Constraints such as API compatibility, performance budgets, and files not to change
- Desired output such as a patch plan, tests, risk list, or tradeoff comparison

For a long investigation, make the prompt restorable: put a 6–30 sentence
briefing at the top, concrete reproduction and errors in the middle, and attach
all context files required by a fresh model at the bottom. Oracle runs are
one-shot; the model does not remember prior runs.
