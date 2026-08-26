# Oracle fork agent contract

This repository is the public `IndelibleVivi/oracle` fork. Keep changes
portable and public-safe: never add personal account URLs, private machine
paths, signing-key locations, credentials, OTP procedures, private continuity,
or maintainer-only release instructions.

## Canonical product boundary

- The ordinary canonical consultation lane is ChatGPT GPT-5.6 Pro through the
  local dedicated Chrome for Testing profile and loopback direct CDP.
- OpenCLI is an explicit alternative transport for ordinary consultations. It
  is never an automatic fallback.
- Batch Oracle v1 uses direct CDP only. It does not dispatch through API,
  OpenCLI, MCP, remote Chrome, attach-running Chrome, or another account/model.
- Browser child session metadata remains execution and recovery authority.
  Batch parent state coordinates sealed inputs, child lineage, dispatch
  reservations, the first-stage barrier, owner decisions, and rendering.
- Never click or auto-click ChatGPT's `Answer now` control. A quiet Pro run is
  recovered by reattaching its exact stored session, not by resubmitting.

## Batch Oracle source and documentation

- Canonical Batch implementation: `src/batch/` and `src/cli/batchCommand.ts`.
- Canonical child-session lineage fields: `src/sessionManager.ts`.
- User contract: `docs/batch-oracle.md`.
- CLI/config/session surfaces: `docs/cli-reference.md`,
  `docs/configuration.md`, and `docs/sessions.md`.
- Agent working method: `skills/oracle/SKILL.md`, especially
  `Parallel-first Batch Oracle`.
- Batch manifests are strict JSON/JSON5. Do not add YAML or a permissive
  unknown-field path.
- One active recoverable attempt is allowed per logical lane. A new attempt is
  valid only on explicit resume after durable evidence proves the earlier
  prompt unsubmitted, uncommitted, and retry-safe.
- First-stage inputs are all-or-nothing sealed. Resume must use sealed copies
  and must not re-glob a changed workspace.
- Synthesis starts only after the durable barrier. Partial synthesis is an
  explicit owner decision and must preserve missing-lane provenance.

## Verification

For Batch or shared browser/session changes, run the narrow affected tests
first, then complete the repository gates before proposing release:

```bash
pnpm check
pnpm test
pnpm build
pnpm docs:check
pnpm test:packed-cli
```

Do not relax recovery, prompt-identity, target-ownership, Pro timing, or
attachment-readiness assertions to make a change pass. Account-side live tests
are explicit and bounded; run them only when the task authorizes the exact
submission. `oracle browser smoke` is account-safe and submits no prompt.

Windows-specific browser changes must also update `docs/windows-work.md` when
its operator truth changes. Public changelog entries describe shipped or
unreleased behavior honestly and never claim a source-only candidate is live.
