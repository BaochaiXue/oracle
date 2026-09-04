---
name: oracle
description: "Second-opinion review from ChatGPT GPT-5.6 Pro with real repository context: hard bugs, stuck investigations, design and refactor decisions. Bundles a prompt plus selected files, and always names the project GitHub owner/repository so the connector can read it."
---

# Oracle (CLI) — best use

Oracle bundles a prompt and selected files for a ChatGPT GPT-5.6 Pro
second-model review with real repository context. GPT-5.6 Pro is multimodal:
plots, screenshots, and diagrams attached with `--file` are uploaded as native
image attachments and read visually (see "Showing the model visual evidence").
Oracle guarantees only the upload; whether ChatGPT interprets a video or the
figures inside a PDF visually depends on the account tier, so render such
material to PNG first. The canonical lane is browser mode over direct CDP with
Oracle's dedicated profile. A prompt is required;
attach files only when they add necessary context. Treat responses as advisory:
verify them against the codebase and tests, and argue back in the same
conversation when they are wrong or over-engineered (see "Arguing with the
model").

This fork reserves the canonical Oracle lane for ChatGPT GPT-5.6 Pro. Use
OpenCLI separately for incidental Gemini queries; Oracle never dispatches or
falls back to Gemini.

## Main use case (browser, GPT-5.6)

Use browser mode with GPT-5.6 when the ChatGPT account exposes it. Base Sol and
Sol Pro are two execution tiers of the same model row, not two model rows: base
Sol tops out at the Extra High effort setting, while Pro is the top tier of the
same Intelligence picker, reserved for difficult or long-running work. Without a
`--browser-thinking-time` value, base aliases leave ChatGPT's current tier
untouched, while the Pro alias `gpt-5-pro` defaults the tier to Pro.

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
6. Read the answer critically. Verify every claim you will act on; where the
   model is wrong, over-defensive, or answering a different question, push back
   with evidence in the same conversation through `--followup` rather than
   accepting it or opening a new one.

## Arguing with the model

GPT-5.6 Pro is a strong reviewer, not an authority. The agent is expected to
disagree with it, and to keep the disagreement inside one conversation until
both sides converge.

Never accept an answer on trust. Before acting on a recommendation, check it
against the code, run the tests or reproduction it implies, and confirm that it
answers the question actually asked. Push back when the model:

- states something the code or a test contradicts;
- proposes defensive code for failure modes that cannot occur here, redundant
  validation, speculative abstractions, or "just in case" fallbacks that hide
  real errors;
- hedges into several options where the evidence supports one;
- answers a neighbouring question, or silently changes the constraints;
- asserts a library, API, or platform behaviour that a quick check disproves.

A rebuttal is evidence, not opinion. Quote the file and line, the test output,
the reproduction, or the documentation that contradicts the model, state the
specific claim being challenged, and ask for a revised answer that engages with
that evidence. Do not restate the original question and do not soften the
challenge with a persona. When the model is right and the agent was wrong, say
so plainly and move on; the point is a correct decision, not winning.

Continue the exchange until consensus: both sides agree on the claim and its
justification, or the model concedes, or the agent concedes. If evidence on
both sides is exhausted and positions are stable, record the disagreement
verbatim in the working notes, state which side the agent is acting on and why,
and surface it to the operator rather than looping.

### Stay in one conversation

For one agent working one task, the default is a single ChatGPT conversation
extended turn by turn. Continue it with `--followup` on the stored session:

Before creating any root session, check the task's recorded Oracle lineage and
run `oracle status --hours 72` for that task's slug. If its latest owned session
is running or recoverable, reattach and wait without submitting another turn.
If it is completed and the new question advances the same investigation,
follow up from the latest child. Create a new root only when no same-task
lineage exists or one of the explicit exceptions below applies. A new agent
turn, context compaction, or process restart is not a new investigation.

```bash
oracle --followup <session-id-or-slug> \
  -p "You claimed X. src/foo.ts:42 does Y, and the attached test fails as shown. Revise." \
  --file src/foo.ts --file tests/foo.test.ts
```

Oracle creates a child session, reopens the parent's exact ChatGPT conversation,
inherits its browser profile, configuration, and model, bypasses the model
picker, and submits the new turn there. Pass the latest child, not the root, so
the lineage in `oracle status` stays linear. New evidence can be attached with
`--file` on any turn. When the follow-up turns are known in advance, plan them
in the initial run with repeated `--browser-follow-up "<prompt>"` instead.

An Oracle _session_ is not a ChatGPT _conversation_. Every turn, including a
`--followup` turn, gets its own session id and its own row in `oracle status`;
that is bookkeeping, not a new chat. The conversation identity is
`browser.runtime.conversationId` in the session's `meta.json` (also the
`/c/<id>` in its `tabUrl`). Two sessions with the same conversation id are the
same ChatGPT thread. After every follow-up, confirm that the child's
conversation id equals the parent's; if it differs, a new conversation was
opened by mistake and the parent must be resumed instead.

This skill changes. An agent whose context still holds an older copy will act
on stale rules (an earlier version said runs were one-shot and never mentioned
follow-ups). Re-invoke the skill at the start of each consultation rather than
relying on text loaded in a previous task.

Open a new conversation only when the current one cannot continue: browser
resume fails closed because the saved URL is not a recoverable ChatGPT
conversation, the browser lands on a different conversation, the account
raises a challenge, or an earlier error by the model has anchored the thread on
a false premise that repeated correction does not dislodge. Preference for
another phrasing, a fresh start, or a cleaner transcript is not a reason. When a
new conversation is unavoidable, carry the settled conclusions and the open
disagreement into its opening prompt so nothing already established is
re-litigated from zero.

Follow-ups keep the parent's evidence authority: a settled GitHub repository
identity and connector directive need not be repeated unless the repository or
the local commit changed.

## GitHub repository context (mandatory)

Every GPT-5.6 Pro consultation about a project already published on GitHub MUST
actively instruct ChatGPT to open that repository through its connected GitHub
app/connector. This is not optional and not a fallback: the connector is how the
model reads commit history, issues, pull requests, and the files you chose not
to attach. Dispatching without it wastes the strongest context channel Oracle
has. The only exemption is a project with no GitHub remote at all.

Name the project by its full GitHub identity, never by the local folder name
alone. A checkout in `~/bit` whose remote is `git@github.com:BaochaiXue/bit.git`
must be introduced to ChatGPT as `BaochaiXue/bit`. A bare `bit` is not an
identity: GitHub holds many repositories with that name, and the connector needs
the owner to open the right one. When the folder was renamed or cloned under a
different name, the remote still decides.

Resolve the identity from Git metadata before writing the prompt:

```bash
git -C <repo> rev-parse --abbrev-ref HEAD                         # current branch
git -C <repo> rev-parse --abbrev-ref --symbolic-full-name '@{u}'  # tracked remote
git -C <repo> remote                                              # remote names only
git -C <repo> remote get-url <name> \
  | sed -E 's#^.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$#\1#'     # emits owner/repo only
git -C <repo> rev-parse --short HEAD                              # commit
git -C <repo> status --porcelain                                  # dirty state
```

Never print the raw remote URL (`git remote -v`, bare `git remote get-url`):
an HTTPS remote can carry an embedded token, and anything printed lands in the
agent transcript before any later sanitizing. The `sed` above reduces the URL to
the bare `owner/repository` slug without echoing it; `git@github.com:BaochaiXue/oracle.git`
becomes `BaochaiXue/oracle`. If the pattern does not match, the remote is not
GitHub: omit the block.

Then decide:

- Exactly one GitHub remote: that is the project.
- Fork with both `origin` and `upstream`: the project is the fork. State both
  roles explicitly so the model does not answer from the wrong tree, and use
  upstream as the project only when the task targets upstream.
- Several GitHub remotes that disagree and none is the tracked one, or no GitHub
  remote: omit the block. Never guess a slug and never substitute the directory
  name.

Never place a raw remote URL, embedded credentials, access token, or private
machine path in the prompt. Include the sanitized `owner/repository` slug, the
branch, and the commit: the connector reads the default branch unless told
otherwise, so an unnamed feature branch makes the model review the wrong code.
Before dispatch, add this block with the placeholders replaced:

```text
GitHub repository context:
Use the connected GitHub app/connector to inspect the exact repository
`OWNER/REPOSITORY` on branch `BRANCH` at commit `COMMIT` for relevant code,
documentation, issues, and pull requests before answering. Read that branch,
not the default branch, wherever they differ. This repository identity comes
from Git metadata, not the local directory name. Do not substitute a similarly
named repository. If the GitHub app or this repository is unavailable or
unauthorized in this ChatGPT surface, state that explicitly and continue only
from the prompt and attached files. Treat the attached files and stated local
commit or dirty diff as authoritative wherever they differ from GitHub.
```

Verify all four before pressing Send:

1. The slug came from Git metadata, not from the directory name.
2. The slug carries no URL, credential, token, or local path.
3. Fork and upstream roles are named whenever both remotes exist.
4. The branch is named, and the commit and dirty state are stated when they
   affect the answer. Unpushed commits are invisible to the connector: push
   first, or attach the files that carry the unpushed change.

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
carries the expected password-store flag. The setup browser is the one
exception to tab-level cleanup: it exposes no CDP endpoint, and `oracle browser
setup` returns only after the human closes the whole sign-in window, so waiting
for a setup tab to close over CDP hangs forever. Every later consultation runs
in the shared CDP Chrome, where a run closes only its exact owned tab. Never
send `WM_DELETE_WINDOW`, use a broad `pkill`, or signal the Chrome process
merely to clean up a consultation. Run the account-safe
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
Testing instance is closed. `smoke` is a first-install validator, not a repair
tool: it refuses to start while the dedicated Chrome is running and performs two
cold starts that end with the endpoint shut down. Run it only after first setup
or a concrete browser-contract change, and only when `oracle browser status`
reports `active 0` and `recoverable 0`. Never kill Chrome to make `smoke` run.
For a stuck profile use `oracle browser heal` before considering any
process-level action; `heal` preserves active and recoverable work by design.

## Sharing one Chrome across agents

Several agents consult in parallel through one dedicated Chrome. Each run owns
one tab under a lease (`maxConcurrentTabs`, default 3), the profile lock
serializes only the launch decision and the composer mutation while a prompt is
being submitted, and waiting for the answer holds no lock. Two runs started 49
milliseconds apart have been observed to share one Chrome correctly: the first
launched it, the second reused it, both prompts were submitted.

What breaks this is not contention but process-level action against the shared
browser. A `kill` of the Chrome PID, `oracle browser smoke`, or `oracle browser
setup` while another agent's consultation is live closes that agent's tab
mid-answer ("Chrome window closed before oracle finished") and forces every
following run into a cold start, where ChatGPT is far more likely to answer
with an HTTP error or an unready model picker. A string of `error` sessions
after a kill is the kill's consequence, not a reason for another kill.

Rules for every agent on a shared machine:

- Before any browser maintenance, run `oracle browser status`. If `active` or
  `recoverable` is not zero, the browser belongs to someone else's work: do
  nothing to the process. `Action required: do not close active browser`
  means exactly that, even when the line above it says `ambiguous`.
- Never `kill`, `pkill`, or signal the Chrome process to recover from a failed
  consultation. Recover the session instead.
- Never run `smoke` or `setup` while any consultation is active or recoverable.
- Pass `--browser-keep-browser` on every run, or set
  `browser.browserLifetime: "persistent"` in `~/.oracle/config.json` so the
  default `while-needed` lifetime cannot drain the browser after a failed run
  and cold-start the next agent.
- A run that failed before Send in a fresh Chrome is a cold-start symptom. Wait
  for the browser to settle and retry once; do not repair the process.

### Three invariants for multi-agent use

**No preemption.** An agent touches only the tab, lease, and session it created.
Never pass `--browser-tab <ref>` to reuse an existing ChatGPT tab, never
`--browser-attach-running` against the dedicated profile, never run
`reconcile-tabs --apply` or `--include-untracked-chatgpt` while `oracle browser
status` shows other work, and never raise `maxConcurrentTabs` or kill a process
to free a slot. If every slot is taken, the run waits: lease acquisition polls
for up to the run timeout (60 minutes on the Pro lane) and logs "Waiting for
Oracle browser target slot" every 30 seconds. Waiting is the correct behavior.

**No deadlock.** Every wait in Oracle is bounded and ordered, so a true deadlock
cannot form: a run takes its tab lease first, then the profile lock only for the
launch decision and the composer mutation, and releases the lock before waiting
for the answer. The profile lock gives up after 300 seconds with "Oracle
profile lock still held by pid N"; the lease wait gives up at the run timeout.
Treat either message as "someone else is submitting or all slots are busy":
inspect with `oracle browser status` and `oracle status --browser-tabs`, then
retry later or reduce parallel demand. Do not remove lock files, do not clear
the lease registry, and do not kill the pid named in the message; a dead pid is
pruned automatically, a live one is doing work.

**No lost tracking.** Each agent keeps an explicit map from its task to its own
Oracle session lineage and never operates on a session it did not create.

- Give every run a `--slug` that names the agent and task, for example
  `<agent>-<task>-r1`, and record the printed session id next to the task in
  the working notes together with the conversation URL from `oracle status`.
- Continue that task only with `--followup <latest own child>`; children keep
  the slug prefix, so `oracle status` shows the lineage as one tree.
- Never `oracle session <id> --live|--harvest`, `--followup`, or `restart` a
  session whose slug or lineage is not yours. Reading another agent's session
  is allowed only through `oracle session <id>` as a read-only snapshot.
- After a host cut-off, use `oracle status --hours 72` to find your own work by
  slug. Do not pick the most recent session; another agent's run may be newer.
- One task, one conversation. Do not open a second conversation for the same
  task while the first is `running` or `recoverable`; two live conversations on
  one task is how an agent loses track of which answer is authoritative.

## Long runs and host timeouts

A Pro browser capture is allowed 60 minutes per bound-conversation attempt, with
one same-conversation reload, for a two-hour default ceiling. Agent harnesses cap
a single shell call far below that; Claude Code's Bash tool tops out at ten
minutes.

The canonical lane survives this. A browser run on a Pro-tier alias such as
`gpt-5-pro` requests a detached worker, so the consultation keeps running and
still persists its answer after the foreground stream is cut. The request can
fall back to inline execution when the worker fails to launch (the CLI prints
"Unable to detach session runner ... Running inline"), so confirm before
relying on it: `lifecycle.detached` in the session's `meta.json` must be `true`.
With that confirmed, a host tool timeout is not evidence that the review failed,
and it is never grounds for a duplicate dispatch.

When the foreground call is cut off:

1. `oracle status --hours 72` to locate the session.
2. `oracle session <id> --render` to read the stored answer. `--render` targets
   a rich TTY; from a non-interactive shell read the session directory
   directly: `~/.oracle/sessions/<id>/meta.json` holds status, error, and
   `browser.runtime`; `output.log` is the run log; the answer is
   `~/.oracle/sessions/<id>/artifacts/transcript.md` once captured.
   `oracle session <id> --print-paths` prints the session directory and file
   paths. Do not use `oracle session <id> --path`: the root-level
   `--path <paths...>` alias for `--file` shadows that spelling and the CLI
   rejects it with "argument missing".
3. Create another attempt only after a durable receipt proves the prompt was
   never submitted. Never re-run a consultation merely to make it look complete.

A detached worker survives a tool timeout, not a restart of the agent harness:
reloading Claude Code has been observed to kill the worker while the session
stays `running` in `meta.json`. Do not resend. Run `oracle session <id> --live`;
it reopens the saved conversation in the shared Chrome and tails it. While
GPT-5.6 Pro is still working, ChatGPT shows a progress card and no Stop button
with the last message still being yours; that state is `running`, and the
answer arrives as a new assistant message.

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

## Showing the model visual evidence

GPT-5.6 Pro reads images. When the question is about a training curve, a
distribution, a confusion matrix, an attention map, a UI rendering, a diagram,
or anything else a human would judge by looking, attach the picture instead of
transcribing numbers into prose. A plot carries the shape, the outliers, and
the axis scale at once; a paragraph of numbers loses all three.

Media goes through the same `--file` flag. Oracle recognizes it by extension,
never inlines it, and uploads the raw bytes as a ChatGPT attachment:

- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`, `.heic`, `.heif`
- Video: `.mp4`, `.mov`, `.webm`, `.mkv`, `.m4v`, `.avi`
- Audio: `.mp3`, `.wav`, `.flac`, `.ogg`, `.m4a`, `.aac`
- Documents: `.pdf` (uploaded as a file; figures inside it are not guaranteed to
  be read visually on a Pro account, so export the pages you need as PNG)

```bash
oracle --engine browser --browser-transport cdp --model gpt-5-pro \
  --browser-thinking-time pro --browser-keep-browser \
  -p "Attached: validation PER per epoch for runs A and B (same seed, same data).
Look at the curves before reading the code. Is the divergence after epoch 40
consistent with the LR schedule in train.py, or does it point elsewhere?" \
  --file outputs-for-review/per_curves.png \
  --file outputs-for-review/per_curves.csv \
  --file src/train.py
```

Rules that make visual evidence useful rather than decorative:

- Tell the model what it is looking at and what question the image answers.
  Name the axes, units, series, and the run or commit each series comes from
  when the figure itself does not.
- Ask it to describe what it sees before interpreting it. A wrong reading of
  the picture is caught in one turn instead of propagating through the answer.
- Attach the numbers behind the picture when precision matters: the `.csv` or
  `.json` next to the `.png`. The image carries shape; the table carries values.
- Prefer one clear figure per question over a grid of tiny panels. Legible
  labels beat high resolution.
- For video, decide whether motion is the evidence. If not, extract two or
  three key frames as images; they upload faster and are read more reliably.
  If motion matters, keep the clip short and say which seconds to watch.
- Never attach a figure that contains credentials, private paths, or personal
  data in its labels or window title. Screenshots leak more than plots.

Constraints that apply to media in this fork:

- The 1 MB default file cap applies to text files only. Raw media and archive
  uploads are uncapped unless a limit is set explicitly, so a 40 MB screen
  recording is uploaded without complaint. Set a deliberate per-run
  `--max-file-size-bytes <bytes>` when attaching large or sensitive media; do
  not rely on a default that does not exist for these files.
- One browser turn accepts at most 10 attachments. When source files must be
  bundled alongside figures, pass `--browser-bundle-files` with
  `--browser-bundle-format text`. The text bundle becomes one attachment and
  every image stays a separate native upload, so `1 + number of figures` must
  be at most 10. Do not use
  `zip` or leave the format on `auto` with media present: both pack the images
  into the archive, and GPT receives one ZIP instead of pictures it can look at.
- `--browser-attachments never` and `--browser-inline-files` fail on media,
  because media has no inline form. Leave attachments on `auto` or `always`.
- `.gitignore` never drops a file you named literally. `--file outputs/plot.png`
  attaches the plot even though `outputs/` is ignored, alone or next to globs
  such as `--file "src/**"`. Files discovered through a glob or a directory
  argument still go through `.gitignore`, and an explicit `!` exclusion still
  wins over a literal. Name figures explicitly rather than through globs, and
  confirm with `--dry-run summary --files-report` that each image is listed as
  an upload before the real run.
- Follow-ups accept `--file`, so a plot can be introduced mid-conversation as
  evidence in a rebuttal (see "Arguing with the model").

Images the model returns are downloaded as session artifacts; pass
`--generate-image <file>` to choose the output path.

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

## API preflight (operator-only CLI reference)

This section is outside the skill's supported workflow: the skill dispatches
only GPT-5.6 Sol Pro. It is kept as operator reference for deliberate API runs
and must not be read as permission to route an agent consult to another model.
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
- Visual evidence when the question is about a curve, a distribution, a layout,
  or a rendering: attach the plot or screenshot itself, and say what to look at
- Constraints such as API compatibility, performance budgets, and files not to change
- Desired output such as a patch plan, tests, risk list, or tradeoff comparison

For a long investigation, make the prompt restorable: put a 6–30 sentence
briefing at the top, concrete reproduction and errors in the middle, and attach
all context files required by a fresh model at the bottom. A fresh run is
one-shot; memory of earlier turns exists only inside a conversation continued
with `--followup`, which is why the same conversation is preferred.
