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
- Batch Oracle v1 preserves its strict manifest, admitted source snapshot,
  sealed inputs, blind first stage, durable barrier, owner decisions, and
  verified rendering. New lane and synthesis attempts are Batch-owned Oracle
  v2 jobs admitted through `oracle-client`; the worker alone owns browser
  execution and global page concurrency.
- Batch parent state owns logical lineage, retry admission, barrier progression,
  answer acceptance, and owner closure. Durable worker jobs own execution and
  capture. Pre-R9 child-session state remains readable and protected from
  pruning, but is not a canonical execution path for new Batch work.
- Never click or auto-click ChatGPT's `Answer now` control. A quiet Pro run is
  recovered by reattaching its exact stored session, not by resubmitting.

## Oracle v2 integration boundary

- `fork/main@e6f170ff` is the historical legacy direct-CDP safety baseline from
  which the integrated v2 candidate was built. Until G4, do not add
  capabilities to or broadly refactor
  `src/browser/**`; only bounded P0/P1 safety, data-loss, duplicate-send, or
  current-user-blocking fixes belong there.
- The accepted v2 architecture and complete coverage ledger live in
  `docs/oracle-v2-master-plan.md`. Current tranche and gate evidence live in
  `docs/oracle-v2-progress.md`.
- New v2 source lives under `packages/*` and `apps/*`. It must not import the
  legacy browser implementation. ChatGPT page-reading and Playwright
  automation knowledge belongs only in `packages/chatgpt-adapter`. The
  sanitized `apps/oracle-provider-fixture` may define simulated provider
  markup and scenarios, but it must not become a second adapter or production
  selector authority.
- The R8 opt-in `broker` engine routes CLI and MCP through `oracle-client` and
  `oracle-bundle`; neither surface owns browser execution or worker state. R9
  routes Batch lane and synthesis execution through the same client protocol.
  Legacy `browser` remains the shipped/default ordinary engine until G3.
  Source-complete broker or Batch support is not an installed-runtime update,
  default-engine switch, or legacy retirement.
- Keep G1 runtime/login selection, G2 first live Send, G3 default-engine
  cutover, and G4 legacy removal as separate owner decisions.

## Batch Oracle source and documentation

- Canonical Batch implementation: `src/batch/` and `src/cli/batchCommand.ts`.
- Canonical Batch job lineage fields and reconciliation:
  `src/batch/types.ts` and `src/batch/reconcile.ts`.
- Pre-R9 child-session compatibility and pruning protection:
  `src/sessionManager.ts` and `src/batch/store.ts`; do not use them to launch
  new Batch work.
- User contract: `docs/batch-oracle.md`.
- CLI/config/session surfaces: `docs/cli-reference.md`,
  `docs/configuration.md`, and `docs/sessions.md`.
- Agent working method: `skills/oracle/SKILL.md`, especially
  `Parallel-first Batch Oracle`.
- Batch manifests are strict JSON/JSON5. Do not add YAML or a permissive
  unknown-field path.
- One active recoverable attempt is allowed per logical lane. Stable attempt
  keys are `batch:<batchId>:lane:<laneId>:attempt:<n>` and
  `batch:<batchId>:synthesis:<synthesisId>:attempt:<n>`. A new attempt is valid
  only on explicit Batch resume after the worker proves the earlier job
  failed-unsent or verified-unsent. A committed recoverable attempt resumes
  the same job and never resubmits Send.
- Source admission is snapshot-first: resolve membership, copy each admitted
  file once, hash the copied bytes, atomically publish the snapshot, then
  assemble every lane from it. Resume must use sealed copies and must not
  re-glob a changed workspace.
- Ambiguous or possibly committed work waits for owner resolution and must
  never be redispatched.
- Synthesis and raw rendering consume answers only through the accepted answer
  digest, receipt, and sealed input manifest. Integrity mismatch blocks use.
- Synthesis starts only after the durable barrier. Partial synthesis is an
  explicit two-step owner decision (`accept-missing`, then `--allow-partial`)
  and must preserve missing-lane provenance.
- Generic v2 job resume and abandon reject Batch-owned jobs. Recovery, retry,
  completion, and owner closure go through the Batch parent, which supplies the
  exact owner identity to parent-only worker operations. Generic inspection of
  pre-R9 Batch child sessions remains read-only.

## Verification

For Batch or shared worker/client changes, run the narrow affected tests
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
