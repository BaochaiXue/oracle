---
title: Oracle v2 progress
summary: "Current tranche, evidence, owner gates, and next safe action for Oracle v2."
read_when:
  - Resuming Oracle v2 implementation or checking its current source and gate status
---

# Oracle v2 progress

Updated: 2026-09-01

Source integration record: PR #5 targets `fork/main` from `codex/oracle-v2`;
the PR merge/read-back is the authority for whether integration is complete.

Legacy safety baseline: `fork/main@e6f170ff`

## Current state

R0 through R9 are source-complete and carried by PR #5 as an opt-in source
candidate for `fork/main`; GitHub's merge state and the exact `fork/main` head,
not this dated note, prove completion. The usable legacy execution path and
ordinary default remain unchanged. R8 adds an explicit opt-in `broker` engine
for CLI and MCP, durable job inspection/recovery commands, and v2 session
projection readback. R9 maps new Batch lane and synthesis attempts to
Batch-owned durable v2 jobs while preserving the v1 parent manifest, sealing,
blind-lane, barrier, answer-integrity, and owner-closure contracts.

The canonical R0-R9 worker remains a macOS GUI-session runtime over an
owner-only Unix socket. Native Windows fails closed before socket acquisition,
and other non-macOS browser workers remain deferred. The legacy `browser`
engine remains the ordinary Windows path.

On 2026-09-01, an owner-authorized bounded dogfood exercised the repo-local R9
candidate through one ordinary broker review and one two-lane-plus-synthesis
Batch. The candidate was invoked by its exact repo-local build, then stopped;
it was not linked or installed over the global CLI. Legacy `browser` remains
the shipped/default ordinary engine until G3. No v2 worker, Chrome for Testing
process, page, socket, or listener remained after orderly shutdown.

G2 remains certified from three bounded live canaries: canonical text, sealed
bundle, and an injected committed-capture interruption followed by
capture-only recovery. Every certified canary independently verified GPT-5.6
Sol and Pro, preserved exactly one durable Send attempt and one committed turn,
captured the expected answer, used no automatic fallback, and closed the owned
Chrome for Testing runtime.

G1 certified the single worker-managed exact Chrome for Testing runtime over
loopback direct CDP. The fixed v2-only profile retained its authenticated
session across repeated complete close/reopen cycles, all eight owner
acceptance checks passed, and no PID or port became durable job authority. The
private certification is `~/.oracle/v2/browser-runtime.json`; it is runtime
evidence only and does not install or activate v2 as the default engine.

R6 produced `compatible:true` from the real no-Send adapter probe with all ten
provider capabilities verified. It opened the Intelligence picker to verify
GPT-5.6 Sol and Pro independently, filled and cleared a fixed synthetic
composer marker to verify the lazy Send control, and separately uploaded then
removed `oracle-v2-no-send-probe.md`. The receipt records
`promptSubmitted:false` and lives at
`~/.oracle/v2/chatgpt-adapter-compatibility.json`. Sanitized fixture coverage
now mirrors the observed current control shapes, hidden fallback composer,
blocking history-limit modal, and strict no-sidebar/no-composer-content
diagnostic boundary.

The initial G1 spike rejected Playwright-bundled Chromium and the exact Chrome
for Testing executable launched as a Playwright persistent context because
owner-observed Google login could not complete. The branded stable Chrome
channel remained safety-blocked on macOS. Both failed runtimes closed cleanly,
did not submit a prompt, and did not affect everyday Chrome.

Faye accepted the evidence-driven G1 plan delta on 2026-08-31: v2 now has one
candidate path, with the exact Oracle Chrome for Testing process owned by the
worker/runtime host and Playwright attached over loopback direct CDP. The
runtime uses one fixed v2-only profile, has no automatic fallback, and never
persists PID or port as job authority. This changes neither the installed
legacy runtime nor the default browser engine.

Fresh R0 evidence:

- `pnpm install --frozen-lockfile`: passed;
- `pnpm check`: passed;
- `pnpm test`: 168 files passed, 15 skipped; 1,959 tests passed, 32 skipped;
- `pnpm build`: passed;
- `pnpm docs:check`: README sync and 99-flag help check passed;
- `pnpm run v2:boundaries`: passed;
- `git diff --check`: passed.

R0 commit: `7135507a` (`establish Oracle v2 architecture boundary`).

Fresh R1 evidence:

- `pnpm exec vitest run tests/v2/oracle-kernel.test.ts`: 13 tests passed;
- `pnpm check`: passed, including v2 boundaries;
- `pnpm test`: 169 files passed, 15 skipped; 1,972 tests passed, 32 skipped;
- `pnpm build`: passed;
- `git diff --check`: passed.

The kernel now owns strict JobSpec/event/state/receipt schemas, explicit schema
upcasting, the closed transition table, full receipt identity checks, and
action policy. `dispatch-at-risk` and every later state forbid Send;
verified-unsent work requires a new owner-authorized attempt, while committed
failures permit capture recovery only.

R1 commit: `2c5ab030` (`add Oracle v2 job kernel`).

Fresh R2 evidence:

- `pnpm exec vitest run tests/v2/oracle-store.test.ts tests/v2/oracle-kernel.test.ts`:
  21 tests passed;
- `pnpm check`: passed, including v2 boundaries;
- `pnpm test`: 170 files passed, 15 skipped; 1,980 tests passed, 32 skipped;
- `pnpm build`: passed;
- `git diff --check`: passed.

The store now owns migration v1, SQLite WAL/FULL transactions, explicit
idempotent admission, event/snapshot CAS updates, replay-based startup
integrity, owner-only CAS objects, rebuildable session projections, bounded
SQLite backups, and debug TTL/cap/pinning. Injected faults after event insert
and after snapshot update both roll back to the same last-good version.

R2 commit: `0d9df00e` (`add Oracle v2 durable job store`).

Fresh R3 evidence:

- `pnpm exec vitest run tests/v2/oracle-kernel.test.ts tests/v2/oracle-store.test.ts tests/v2/oracle-worker.test.ts`:
  30 tests passed, 1 soak test skipped;
- `ORACLE_V2_SOAK=1 pnpm exec vitest run tests/v2/oracle-worker.test.ts -t '1,000-job'`:
  1,000 jobs and 8,000 durable events passed in 137.51 seconds;
- `pnpm check`: passed, including v2 boundaries;
- `pnpm test`: 171 files passed, 15 skipped; 1,989 tests passed, 33 skipped;
- `pnpm build`: passed;
- `git diff --check`: passed.

The worker now binds an owner-only Unix socket before opening the single-writer
store, exposes upload/job/event/resume/abandon/canary operations, survives
client disconnect, enforces idempotent admission, and recovers preparing and
at-risk jobs from the ledger. Preparation/dispatch are serialized; committed
capture is bounded at three. A dispatch-at-risk restart uses commit observation
only and the same attempt never sends twice. The fake provider and client
exercise reconnect, restart, degraded read-only access, owner closure, capture
recovery, and bounded high-volume behavior without browser access.

R3 commit: `0e0c15bb` (`add Oracle v2 durable worker`).

Fresh R4 evidence:

- `pnpm exec vitest run tests/v2/oracle-kernel.test.ts tests/v2/oracle-store.test.ts tests/v2/oracle-worker.test.ts tests/v2/chatgpt-adapter.test.ts tests/v2/oracle-worker-faults.test.ts`:
  55 tests passed, 2 soak tests skipped, including 15 ordinary Playwright
  fixture scenarios and 10 hard child-process fault points;
- `ORACLE_V2_SOAK=1 pnpm exec vitest run tests/v2/oracle-worker.test.ts -t '1,000-job'`:
  the current R4 capture path completed 1,000 jobs and 8,000 durable events in
  169.25 seconds;
- `ORACLE_V2_FIXTURE_SOAK=1 pnpm exec vitest run tests/v2/chatgpt-adapter.test.ts -t '500 fixture jobs'`:
  500 jobs, 500 one-attempt Sends, 4,000 durable events, and zero leaked
  adapter pages passed in 424.42 seconds;
- `pnpm check`: passed, including the adapter/fixture boundary check;
- `pnpm test`: 173 files passed, 15 skipped; 2,014 tests passed, 34 skipped;
- `pnpm build`: passed;
- `pnpm docs:check`: README sync and 99-flag help check passed;
- `pnpm public:check`: 527 source files and 39 generated docs files passed the
  public-safety scan;
- `git diff --check`: passed.

The adapter now owns all Playwright page-reading and automation knowledge,
semantic locators, a bounded no-Send capability probe, structural UI
fingerprinting, exact model/Pro/prompt/bundle verification, one-shot dispatch,
commit recovery, conversation-bound capture, streaming completion, and native
copy/text-projection quality receipts. Capture persists canonical Markdown,
plain-text, and HTML-fragment roles while reusing one CAS object when two
representations are byte-identical. The sanitized fixture owns simulated UI
markup and scenarios only. Incompatible auth/rate/UI states create one durable
provider-status row and keep new jobs queued with `blockedBy=provider`; they do
not create per-job DOM incidents or Send. All ten test-only hard fault points
default off and recover from the same DB/socket/fixture state with at most one
Send per attempt.

R4 implementation commit: `4d30c010` (`add Oracle v2 provider fixture`), first
published on `fork/codex/oracle-v2` and retained in the integrated R0-R9
history.

Fresh R5-R6 evidence:

- both Playwright-owned executable candidates produced durable `login=fail`
  receipts; dependent checks are `blocked`, not misreported as failures;
- the installed direct-CDP safety baseline completed two no-Send cold starts
  with authenticated, prompt-ready observations and orderly browser drain;
- the replacement runtime contract exposes only worker-owned exact Chrome for
  Testing over direct CDP, one fixed profile, and no automatic fallback;
- the focused runtime suite passes 6 tests, including a real direct-CDP profile
  persistence cold restart against the sanitized provider fixture;
- Faye completed the one-time login and confirmed the authenticated state
  remained present after repeated orderly close/reopen cycles;
- all eight G1 checks passed at restart ordinal 17 and produced the fixed
  runtime certification;
- the real R6 adapter receipt at restart ordinal 19 is `compatible:true`, with
  all ten capabilities `verified` and `promptSubmitted:false`;
- real no-Send checks verified GPT-5.6 Sol, Pro, a background Playwright click,
  a lazy Send control, and synthetic attachment upload/removal without reading
  sidebar or conversation content;
- TypeScript, the focused current-style fixture tests, and the v2
  legacy-import/adapter boundary check pass;
- the final focused runtime/adapter run passed 25 tests with one bounded soak
  skipped; the full repository suite passed 174 files and 2,024 tests with 15
  files and 34 tests skipped;
- `pnpm check`, production build, docs/help check, packed-CLI smoke, public
  safety scan, and `git diff --check` pass.

Fresh R7 source and G2 evidence:

- the worker/runtime still owns one exact Chrome for Testing process and one
  fixed profile, while the adapter enforces at most three owned ChatGPT tabs
  and backpressures a fourth request;
- runtime startup closes stale restored page targets before adapter work, and
  each new page is bound through an exact unique target marker rather than an
  arbitrary next-page event;
- the hard-fault harness now shares one parent-owned browser across each fault
  case instead of relaunching a browser from every child; the full fault suite
  completed with no owned Chrome for Testing process left after closure;
- current UI regressions cover ProseMirror composer readback, the late
  conversation-history rate-limit modal, composer-anchored `aria-label` file
  tiles including provider duplicate-name suffixes, transient
  conversation-route rollback after apparent commit, and client-created
  provisional `/c/WEB:...` routes that must canonicalize before commit;
- the real preflight passed compatibility, exact GPT-5.6 Sol/Pro preparation,
  text-composer verification, and sealed-bundle attachment verification with
  `promptSubmitted:false` and no automatic fallback;
- the two earlier text attempts remain preserved without resubmission. The first
  exposed a transient route rollback; the second exposed that a client-created
  `/c/WEB:...` route had been accepted as durable conversation authority. Commit
  observation now rejects provisional identifiers and requires one stable
  canonical route plus the exact user-turn candidate;
- `r7-g2-text-v3` and `r7-g2-bundle-v1` each record one
  `dispatch-marked-at-risk`, one `submission-committed`, zero `capture-failed`,
  one `capture-completed`, and the exact expected answer;
- the first recovery harness attempt completed its new job but was not
  certified because an older recoverable job consumed the unscoped fault
  marker during worker startup. Worker fault points now carry job/request
  identity, and a regression proves that older recoverable jobs cannot consume
  a target-scoped interruption;
- `r7-g2-committed-capture-recovery-v2` records one durable Send and commit,
  exactly one target-bound `capture-failed`, then one `capture-completed` after
  worker restart with no resend. Its persisted marker and receipt both verify
  the exact job/request identity;
- the focused final R7 suite passed 6 files and 60 tests with 2 bounded tests
  skipped. `pnpm check`, `pnpm build`, `pnpm docs:check`,
  `pnpm public:check`, `git diff --check`, final canary inspection, and final
  browser ownership cleanup passed;
- private manifests, ledgers, answer objects, and certification receipts remain
  under `~/.oracle/v2/`; none are tracked source or installation evidence.

Fresh R8 source and live evidence:

- root CLI and MCP now use `oracle-client` plus the canonical
  `oracle-bundle` only when the explicit `broker` engine or its opt-in feature
  override is selected; v2 boundaries still prohibit browser/worker authority
  imports from those clients;
- live broker admission requires a stable request/idempotency identity. The
  client atomically creates one immutable `(scope, key)` intent and a separate
  admission binding before relying on a transport response; mismatched prompt,
  bundle, policy, lineage, route, or owner identity fails closed;
- source membership is shadow-compared with the legacy selector, then sealed
  into one deterministic UTF-8 bundle with bytewise path ordering,
  path-independent external aliases, and content receipts;
- `oracle job|resume|abandon`, `oracle worker run|status|doctor`, `oracle
canary`, `oracle debug export`, and `oracle session <job-id>` expose durable
  job operations without moving browser or ledger authority into the CLI;
- MCP `consult` returns `jobId + state` when its host wait expires and repeats
  the same key against the same job. `job_status`, `job_result`, `job_events`,
  and `job_resume` expose explicit allowlisted public projections; generic
  resume/abandon rejects Batch-owned jobs;
- a real child CLI was hard-killed after admission; the worker completed the
  job and a new CLI reattached with the same key, final answer, and exactly one
  Send. Output artifacts are atomic, owner-only files and post-admission client
  errors retain the durable job handle;
- three bounded ordinary real reviews completed through the R8 broker. Each
  recorded one committed Send and one capture, returned through its exact job,
  and released its review page; final CDP page count was zero after each of the
  last two reviews. Findings were reconciled into durable identity, public MCP
  projection, socket ownership, startup readiness, signal timing, and
  failure-independent cleanup fixes;
- the production host now publishes `phase:"starting"` before store/provider
  readiness instead of returning a transient 500, then reaches
  `phase:"ready"`. A no-Send live startup/shutdown readback ended with the Unix
  socket and the owned Chrome for Testing process both absent;
- the focused R8 integration set passed. The final full repository suite passed
  182 files and 2,057 tests with 15 files and 34 tests skipped; `pnpm check`,
  production build, docs/help check, packed-CLI smoke, public-safety scan, v2
  boundary check, and `git diff --check` passed;
- private live-review answers, run logs, intents, job ledgers, and browser
  receipts remain under `~/.oracle/v2/`; none are tracked source or evidence of
  installation/default activation.

Fresh R9 source and fixture evidence:

- every lane attempt uses
  `batch:<batchId>:lane:<laneId>:attempt:<n>` and synthesis uses
  `batch:<batchId>:synthesis:<synthesisId>:attempt:<n>`; immutable client
  intent identity includes prompt bytes, bundle bytes and media type, policy,
  lineage, route, and exact Batch owner;
- the Batch parent no longer imports or launches the legacy browser child
  runtime. It seals the complete first stage, admits jobs through
  `oracle-client`, hides sibling answers until the barrier, and consumes only
  worker answer objects bound to immutable Batch receipts and input manifests;
- local `maxParallel` is only a client admission cap. The worker retains one
  global preparation/dispatch lane and no more than three concurrent captures;
  Batch does not create or retain a page pool of its own;
- generic job resume/abandon rejects Batch-owned work. Parent-only resume and
  abandon require the exact owner identity. Failed-unsent or verified-unsent
  work gets a new attempt only through explicit Batch resume; committed
  capture recovery keeps the same `jobId` and performs zero additional Sends;
- the R9 integration runs a three-lane blind Batch through synthesis, restarts
  the worker after one committed lane capture failure, creates one safe second
  attempt after a targeted final-verification failure, accepts one ambiguous
  lane as missing, performs explicit partial synthesis, verifies raw answer
  receipts, and preserves TXT or ZIP sealed bundle media types. Every admitted
  attempt records at most one Send;
- pre-R9 Batch child-session state remains readable and protected from
  retention while referenced, but the v2 Batch runtime refuses to relaunch it;
- the full gate found that launcher cleanup could SIGKILL Chrome after its CDP
  endpoint closed but before Chrome 152 finished flushing the profile. Runtime
  close now waits a bounded interval for the owned process to exit naturally
  before fallback cleanup; the real managed-process cold-restart fixture
  preserves its profile sentinel and exits cleanly;
- focused Batch/client/adapter gates passed 38 tests with one bounded test
  skipped. The memory-safe serialized full repository suite passed 181 files
  and 2,047 tests with 15 files and 34 tests skipped. No real ChatGPT prompt was
  submitted for R9; all Batch Send/recovery evidence uses the sanitized fixture
  or `FakeProvider`.

## Bounded opt-in dogfood after R9

- the exact R9 repo-local build started one detached, explicitly owned v2
  worker against the certified profile. Worker doctor reached `ready` with a
  compatible provider and an empty queue. The global installed Oracle path,
  version, config, and legacy default were not changed;
- one ordinary broker review with a sealed documentation bundle completed with
  exactly one `submission-committed` and one `capture-completed` event. Its
  answer artifact and durable job projection agreed, and its page count returned
  to zero after completion;
- Batch `v2-bounded-dogfood-20260901T102353Z-a2ba` sealed two distinct blind
  lanes with an effective client admission cap of two and a total child cap of
  three. First-stage page count peaked at two, fell as lanes completed, and both
  verified answers were accepted before the durable barrier closed;
- the barrier admitted one synthesis job only after both lanes completed. That
  job recorded one committed Send. Its first 30-minute capture window ended
  recoverable; parent-only `batch resume` restarted capture on the same `jobId`
  without another Send or attempt. A second bounded capture window also ended
  recoverable;
- after the owner explicitly accepted the unavailable synthesis, the worker
  recorded `job-abandoned`, preserved the conversation and both verified lane
  answers, and terminalized the Batch as honest `partial`. The synthesis never
  produced a second `submission-committed` event;
- orderly worker shutdown removed the final retained page, exact v2 Chrome for
  Testing process family, Unix socket, and loopback endpoint. The earlier idle
  legacy Chrome for Testing runtime was independently reconciled and drained;
  final readback found neither Oracle runtime active;
- both independent lane reviews support continued bounded opt-in dogfood while
  legacy remains default. They do not establish the D19 stable-window resource
  plateau required for G3, and the synthesis timeout is retained as negative
  operational evidence rather than converted into a success claim.

## Tranche ledger

| Tranche                        | State       | Evidence / blocker                                                                               |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------ |
| R0 freeze and architecture     | verified    | public plan, coverage ledger, workspace skeleton, contribution contract, boundary checker        |
| R1 kernel                      | verified    | 13 focused tests plus full repository gates                                                      |
| R2 store/CAS/projection        | verified    | 8 store tests, 13 kernel tests, and full repository gates                                        |
| R3 worker/client/fake provider | verified    | 9 ordinary tests plus the 1,000-job / 8,000-event bounded soak                                   |
| R4 fixture/adapter/faults      | verified    | 15 scenarios, 10 hard faults, and 500-job / 4,000-event no-page-leak soak                        |
| R5 / G1 runtime and login      | verified    | eight checks passed; fixed runtime certified after persistent owner login                        |
| R6 real no-Send probe          | verified    | real compatible receipt; GPT-5.6 Sol/Pro/composer/upload checks; no prompt submitted             |
| R7 / G2 live canary            | verified    | text, sealed-bundle, and committed-capture-recovery receipts all certified                       |
| R8 CLI/MCP cutover candidate   | verified    | repeated real reviews, killed-client reconnect, MCP timeout retrieval; legacy default kept       |
| R9 Batch cutover               | verified    | durable lane/synthesis jobs; restart, retry, owner closure, barrier, receipts, no duplicate Send |
| R10 / G3 default switch        | owner-gated | bounded opt-in dogfood completed; D19 stable-window and default owner decision remain            |
| R11 remote job bridge          | planned     | not reached                                                                                      |
| R12 / G4 legacy retirement     | owner-gated | not reached                                                                                      |

## Current stop conditions

- Any v2 dependency on `src/browser/**`.
- Any need to weaken exact model/effort, attachment, retry, Batch, or owner
  authority contracts.
- Any source change that would alter the current browser engine before G3.
- Any additional live browser Send without an exact owner-authorized scope and
  a fresh stable attempt identity.
- Any material scope or gate change not recorded in the master plan.

## Next safe action

Preserve every historical canary, R8 review, and bounded-dogfood job; do not
resend or create a duplicate. Continued dogfood may use the exact repo-local
candidate only under a fresh owner-authorized scope, stable idempotency
identity, separately owned worker, and the three-page worker ceiling. Collect
measured D19 stable-window evidence, including process/page/RSS/socket/profile
settling and orderly shutdown. R10/G3 still requires a separate explicit owner
decision to make v2 the default ordinary browser engine. Until then, do not
replace the global install, change the default engine, remove legacy execution,
start R11, or make a release claim.
