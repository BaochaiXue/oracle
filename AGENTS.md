# Oracle fork agent contract

This repository is `BaochaiXue/oracle`, a public fork of `IndelibleVivi/oracle`. Keep changes
portable and public-safe: never add personal account URLs, private machine
paths, signing-key locations, credentials, OTP procedures, private continuity,
or maintainer-only release instructions.

## Canonical product boundary

- The ordinary canonical consultation lane is ChatGPT GPT-6 Pro through the
  local dedicated Chrome for Testing profile and loopback direct CDP. GPT-5.6
  Sol Pro is the sole fallback, only on verified model/effort unavailability
  before Send. New follow-up turns reselect Latest/GPT-6 Pro in the same
  conversation; read-only recovery retains the original answer and model.
- OpenCLI is an explicit alternative transport for ordinary consultations. It
  is never an automatic fallback.
- Batch Oracle v1 uses direct CDP only. It does not dispatch through API,
  OpenCLI, MCP, remote Chrome, attach-running Chrome, or another account/model.
- Browser child session metadata remains execution and recovery authority.
  Batch parent state coordinates the admitted source snapshot, sealed inputs,
  child lineage, dispatch claims, the first-stage barrier, owner decisions, and
  verified rendering.
- Never click or auto-click ChatGPT's `Answer now` control. A quiet Pro run is
  recovered by reattaching its exact stored session, not by resubmitting.

## Upstream integration boundary

- The integration decision is recorded in `docs/upstream-integration.md`.
  Upstream v2 plans and evidence describe the upstream project, not a local
  runtime certification, owner decision, or instruction to retire this fork.
- Keep ordinary browser and Batch direct-CDP execution available on Linux/WSL
  and Windows. Latest/GPT-6 Pro remains the browser default. Do not replace
  these paths with the macOS-only v2 worker or freeze normal use implicitly.
- Imported v2 kernel/store/client/worker, adapter, and disposable-sandbox
  primitives remain opt-in source. `--engine broker` is explicit, retains its
  upstream GPT-5.6 contract, and is never an automatic browser fallback.
- New v2 source in `packages/*` and `apps/*` must not import `src/browser/**`.
  Page selectors belong in `packages/chatgpt-adapter`; fixtures are not a
  second production adapter. Preserve the upstream boundary checker.
- Auth-seed migration, real sandbox probes, worker activation, Batch cutover,
  and legacy removal need a separate supported-platform acceptance decision.
  Do not change or destroy the shared Chrome profile to satisfy upstream gates.

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
- Source admission is snapshot-first: resolve membership, copy each admitted
  file once, hash the copied bytes, atomically publish the snapshot, then
  assemble every lane from it. Resume must use sealed copies and must not
  re-glob a changed workspace.
- Once a worker records `dispatchStartedAt`, absence of an explicit safe
  pre-submit receipt or reattachable runtime is indeterminate and must never be
  redispatched.
- Synthesis and raw rendering consume answers only through the accepted answer
  digest, receipt, and sealed input manifest. Integrity mismatch blocks use.
- Synthesis starts only after the durable barrier. Partial synthesis is an
  explicit two-step owner decision (`accept-missing`, then `--allow-partial`)
  and must preserve missing-lane provenance.
- Generic session inspection of a Batch child is read-only: status, render,
  paths, logs, and artifacts only. Attach must not wait or repair. Generic
  live/harvest, follow-up, restart, or stored-session execution must fail closed;
  recovery, retry, completion, and owner closure stay with the Batch parent.

## Verification

For Batch or shared browser/session changes, run the narrow affected tests
first, then complete the repository gates before proposing release:

```bash
pnpm check
pnpm test
pnpm build
pnpm docs:check
pnpm public:check
pnpm test:packed-cli
git diff --check
```

Do not relax recovery, prompt-identity, target-ownership, Pro timing, or
attachment-readiness assertions to make a change pass. Account-side live tests
are explicit and bounded; run them only when the task authorizes the exact
submission. `oracle browser smoke` is account-safe and submits no prompt.

Windows-specific browser changes must also update `docs/windows-work.md` when
its operator truth changes. Public changelog entries describe shipped or
unreleased behavior honestly and never claim a source-only candidate is live.
