---
title: Oracle v2 progress
summary: "Current tranche, evidence, owner gates, and next safe action for Oracle v2."
read_when:
  - Resuming Oracle v2 implementation or checking its current source and gate status
---

# Oracle v2 progress

Updated: 2026-08-31

Branch: `codex/oracle-v2`

Legacy safety baseline: `fork/main@e6f170ff`

## Current state

R0 is source-complete and verified. The v2 worktree is isolated from the clean, usable
`fork-main` checkout. No browser behavior, installed payload, browser profile,
account state, live conversation, default engine, or legacy implementation has
been changed.

Fresh R0 evidence:

- `pnpm install --frozen-lockfile`: passed;
- `pnpm check`: passed;
- `pnpm test`: 168 files passed, 15 skipped; 1,959 tests passed, 32 skipped;
- `pnpm build`: passed;
- `pnpm docs:check`: README sync and 99-flag help check passed;
- `pnpm run v2:boundaries`: passed;
- `git diff --check`: passed.

## Tranche ledger

| Tranche                        | State       | Evidence / blocker                                                                        |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| R0 freeze and architecture     | verified    | public plan, coverage ledger, workspace skeleton, contribution contract, boundary checker |
| R1 kernel                      | next        | strict red-green typed state and transition contract                                      |
| R2 store/CAS/projection        | planned     | depends on R1                                                                             |
| R3 worker/client/fake provider | planned     | depends on R1-R2                                                                          |
| R4 fixture/adapter/faults      | planned     | depends on R3                                                                             |
| R5 / G1 runtime and login      | owner-gated | not reached                                                                               |
| R6 real no-Send probe          | planned     | depends on G1                                                                             |
| R7 / G2 live canary            | owner-gated | not reached; no Send authorized or attempted by R0                                        |
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
- Any live browser Send before G2.
- Any material scope or gate change not recorded in the master plan.

## Next safe action

Commit R0 as a source-only architecture tranche, then begin R1 with red-green
reducer and schema tests. The next owner action is G1, after R4 is complete; no
owner intervention is currently required.
