---
title: Oracle v2 progress
summary: "Current tranche, evidence, owner gates, and next safe action for Oracle v2."
read_when:
  - Resuming Oracle v2 implementation or checking its current source and gate status
---

# Oracle v2 progress

Updated: 2026-09-01

Branch: `codex/oracle-v2`

Legacy safety baseline: `fork/main@e6f170ff`

## Current state

R0 through R7 are source-complete and verified in the isolated v2 worktree;
the clean, usable `fork-main` checkout remains unchanged. G2 is certified from
three bounded live canaries: canonical text, sealed bundle, and an injected
committed-capture interruption followed by capture-only recovery. Every
certified canary independently verified GPT-5.6 Sol and Pro, preserved exactly
one durable Send attempt and one committed turn, captured the expected answer,
used no automatic fallback, and closed the owned Chrome for Testing runtime.
R8 CLI/MCP cutover work has not begun, and v2 is not installed, activated, or
the default engine.

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

R4 implementation commit: `4d30c010` (`add Oracle v2 provider fixture`),
published only to `fork/codex/oracle-v2`.

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

## Tranche ledger

| Tranche                        | State       | Evidence / blocker                                                                        |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| R0 freeze and architecture     | verified    | public plan, coverage ledger, workspace skeleton, contribution contract, boundary checker |
| R1 kernel                      | verified    | 13 focused tests plus full repository gates                                               |
| R2 store/CAS/projection        | verified    | 8 store tests, 13 kernel tests, and full repository gates                                 |
| R3 worker/client/fake provider | verified    | 9 ordinary tests plus the 1,000-job / 8,000-event bounded soak                            |
| R4 fixture/adapter/faults      | verified    | 15 scenarios, 10 hard faults, and 500-job / 4,000-event no-page-leak soak                 |
| R5 / G1 runtime and login      | verified    | eight checks passed; fixed runtime certified after persistent owner login                 |
| R6 real no-Send probe          | verified    | real compatible receipt; GPT-5.6 Sol/Pro/composer/upload checks; no prompt submitted      |
| R7 / G2 live canary            | verified    | text, sealed-bundle, and committed-capture-recovery receipts all certified                |
| R8 CLI/MCP cutover candidate   | planned     | legacy remains default                                                                    |
| R9 Batch cutover               | planned     | legacy Batch authority unchanged                                                          |
| R10 / G3 default switch        | owner-gated | not reached                                                                               |
| R11 remote job bridge          | planned     | not reached                                                                               |
| R12 / G4 legacy retirement     | owner-gated | not reached                                                                               |

## Current stop conditions

- Any v2 dependency on `src/browser/**`.
- Any need to weaken exact model/effort, attachment, retry, Batch, or owner
  authority contracts.
- Any source change that would alter the current browser engine before G3.
- Any additional live browser Send without a new exact owner-authorized gate
  and a fresh attempt identity.
- Any material scope or gate change not recorded in the master plan.

## Next safe action

Stop after verified R7/G2. Preserve every historical attempt and the three
certified receipts; do not resend or create another live canary. The next
source tranche is the R8 CLI/MCP cutover candidate. It must keep legacy as the
installed/default engine until the separate G3 owner gate proves the candidate
end to end. No installation, default-engine switch, Batch cutover, legacy
mutation, or retirement is authorized by the R7 certification.
