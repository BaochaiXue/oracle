---
title: Upstream integration and fork runtime boundary
summary: "Oracle 0.19.0 integration decisions, preserved browser behavior, and deferred macOS-only Batch cutover."
read_when:
  - Merging upstream Oracle changes or deciding whether to activate a v2 runtime
---

# Oracle 0.19.0 upstream integration

This fork integrates `IndelibleVivi/oracle:main@a10ef152` into the
`BaochaiXue/oracle` line based on `a975a704`. The upstream side contains 73
commits; the fork side contains 27. Merge ancestry includes both histories;
the resolutions below are intentional behavior differences, not claims that
every upstream policy is adopted.

## Adopted fixes

- Revalidate target ownership, exact composer and attachments, and the
  hit-tested Send control after the durable dispatch boundary and immediately
  before the potentially submitting event. Never retry with another input
  method after an event may have submitted. Start Pro timing at that event.
- Preserve ambiguous dispatches for exact-target recovery. Bind a recovered
  answer to the current prompt and reject multiple new user turns.
- Require an empty composer before upload, wait for transient attachment
  processing, and clear only the exact owned draft and attachment set.
- Verify Pro using a visible, interactive, valid five-position ARIA control
  plus an exact semantic label, independently from model-family verification.
- Import the v2 durable kernel/store, sealed client intent, worker, adapter,
  auth-seed/sandbox isolation, cleanup and process-identity race fixes as
  opt-in source. Keep their tests and architecture boundary checks.

## Preserved fork behavior

Latest/GPT-6 Pro remains the ordinary browser default for roots and same-chat
follow-ups. Only verified model/Pro unavailability before Send permits Sol Pro
fallback. Read-only recovery never changes the model or sends again.
Markdown normalization, virtualized long-chat matching, shared Chrome/tab
ownership, WSL start-tick identity, and the two-hour Pro capture budget remain.

Prompt size cannot prove that a dispatched prompt was unsent. The merge also
removes the old post-dispatch large-prompt retry heuristic; only actual
pre-dispatch composer truncation can enter the owned-draft file fallback.

Two integration-specific gaps are also corrected: packed production installs
include Playwright for the imported runtime modules, and sandbox Linux Chrome
receives the literal POSIX profile path instead of chrome-launcher's WSL UNC
rewrite. A no-account sandbox fixture exposed the latter in the isolated merge
worktree; this fix does not certify or activate a non-macOS worker.

## Deferred cutovers

Upstream's R9 Batch replacement requires a separately running macOS GUI
worker. Adopting it as-is would remove working Linux/WSL Batch execution and
strand existing recoverable child sessions. This fork therefore retains the
direct-CDP `src/batch` implementation, its CLI, tests, and documentation.
There is no new platform-dependent fallback or automatic migration.

The explicit `--engine broker` candidate retains its upstream GPT-5.6 model
contract and supported-platform checks. It is not the skill's default, not a
fallback when browser automation fails, and has not been live-certified here.
The imported v2 plan/progress/ownership documents are upstream evidence only.
Their freeze, auth-seed login, worker activation, and legacy-retirement gates
do not imply permission to stop this fork's shared Chrome or change defaults.

## Verification boundary

Use affected browser/model/follow-up/Batch regression tests plus `pnpm check`,
`pnpm test`, `pnpm build`, `pnpm docs:check`, `pnpm public:check`, and
`pnpm test:packed-cli`. Account-side canaries and auth-seed changes are separate
from merge verification; fixture results must never be reported as live proof.

When updating an installation with active consultations, install a separate
versioned package and switch CLI entrypoints for new processes only. Leave the
previous runtime and shared browser intact for existing workers. Building a
source checkout alone does not update that installed release: verify
`oracle --version` and refresh both the plugin cache and standalone skill
installations before declaring deployment complete.
