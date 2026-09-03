---
title: Oracle v2 browser ownership and legacy deletion map
summary: "T0 source map for disposable attempt sandboxes and the separately gated removal of legacy browser ownership code."
read_when:
  - Implementing Oracle v2 auth seeds, attempt sandboxes, provider cleanup, G3 cutover, or G4 legacy deletion
---

# Oracle v2 browser ownership and legacy deletion map

Status: T0 authority map; no executable behavior change

Baseline: `fork/main@39ab7fb35297e45fcf219ab31b7c787b44a69e51`

This map records current source truth and the accepted destination. It is not a
claim that auth-seed or disposable-sandbox behavior is implemented. G3 default
cutover and G4 physical deletion remain independent owner gates.

## Corrections to the trim briefing

- The `CertifiedChatGptProvider` class lives in
  `apps/oracle-worker/src/certifiedProvider.ts`; there is no
  `certifiedChatGptProvider.ts` file.
- The current fixed v2 profile is hard-coded as
  `runtimeRoot/browser-profile` by
  `packages/oracle-browser-runtime/src/runtime.ts`.
- `CertifiedChatGptProvider` currently retains one `OracleBrowserRuntime` and
  one `ChatGptAdapter` singleton. The adapter owns a job-keyed page map and the
  three-page `OwnedTabBudget` in
  `packages/chatgpt-adapter/src/tabBudget.ts`.
- The current provider cleanup hook is
  `ProviderAdapter.releaseJob(jobId)`, declared in
  `packages/oracle-kernel/src/provider.ts` and called by
  `apps/oracle-worker/src/runner.ts`. T2 must replace or narrow that hook with
  final durable context; `releaseExecution` is a proposed contract name, not a
  current symbol.
- `ProviderRuntimeBindings.listBrowserRecoveryTargets()` is declared in
  `packages/oracle-kernel/src/provider.ts`, supplied from the store in
  `apps/oracle-worker/src/worker.ts`, and consumed by
  `apps/oracle-worker/src/certifiedProvider.ts` to preserve shared-profile
  `window.name` targets. T2 removes all three edges.
- `JobRunner.schedule()` in `apps/oracle-worker/src/runner.ts` currently turns
  any escaping job error into a global `blocked`/non-accepting runner. T2 must
  classify authority failures separately from job-local sandbox cleanup.
- The v2 browser route is named `broker`. `src/cli/engine.ts` still resolves to
  legacy `browser` when no API environment is present; `bin/oracle-cli.ts`
  dispatches explicit `broker` work through `src/cli/brokerCommand.ts` and
  `src/v2/broker.ts`.
- `apps/oracle-worker/package.json` declares kernel and store dependencies, but
  the source also imports `packages/chatgpt-adapter` and
  `packages/oracle-browser-runtime` by repo-relative paths. The implementation
  slice that changes these imports must reconcile the manifest; T0 does not
  alter dependency metadata.

## Preserve as canonical durable authority

| Surface                                                            | Current authority retained through the trim                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/oracle-kernel/`                                          | JobSpec, events, legal state transitions, receipts, retry/owner action policy, and the no-Send boundary after `dispatch-at-risk`             |
| `packages/oracle-store/`                                           | SQLite/event-log single-writer truth, CAS, idempotent admission, projections, integrity, backups, and retention                              |
| `apps/oracle-worker/src/runner.ts`                                 | Dispatch mutex, durable transition orchestration, capture scheduling, and event append ownership; cleanup/error classification changes in T2 |
| `apps/oracle-worker/src/worker.ts`                                 | Owner-only Unix-socket host and provider/store composition; shared-profile recovery bindings are removed in T2                               |
| `packages/oracle-bundle/`                                          | One deterministic UTF-8 sealed bundle path                                                                                                   |
| `packages/oracle-client/`, `src/v2/broker.ts`                      | Durable admission/reconnect protocol and stable idempotency identity                                                                         |
| `src/batch/`                                                       | Batch lineage, sealed input, barrier, owner closure, and v2 job admission                                                                    |
| `packages/chatgpt-adapter/`                                        | ChatGPT selectors, page semantics, model/effort, prompt/bundle preparation, one-shot Send, commit observation, and capture receipts          |
| `packages/oracle-browser-runtime/src/discovery.ts`, `selection.ts` | Exact Chrome for Testing discovery/selection, subject to auth-seed certification updates                                                     |
| `apps/oracle-provider-fixture/`                                    | Sanitized provider simulation and fault-test surface only                                                                                    |

Browser process, PID, port, page, target, profile, `window.name`, and localStorage
locator remain execution evidence only. None becomes a durable state or a new
ownership registry.

## Replace in T1 and T2

| Current source                                                           | Current role                                                      | Accepted replacement                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/oracle-browser-runtime/src/runtime.ts`                         | Creates and reuses `runtimeRoot/browser-profile`                  | Launch only an explicitly supplied attempt sandbox; new `authSeed.ts` and `attemptSandbox.ts` own seed generation, clone, marker, cleanup, and quarantine                              |
| `packages/oracle-browser-runtime/src/managedBrowser.ts`                  | Owns one process with multiple owned/preserved pages              | One process and at most one page per sandbox; fresh mode closes all restored pages; at-risk mode preserves at most one exact marker                                                    |
| `packages/oracle-browser-runtime/src/reconcile.ts`                       | Preserves recovery windows in a shared profile                    | Sandbox-local restored-page handling with no cross-job/profile search                                                                                                                  |
| `packages/oracle-browser-runtime/src/types.ts`                           | Fixed-profile runtime/certification receipts                      | Auth-seed generation, sandbox owner, exact process, launch, cleanup, and no-Send isolation receipts                                                                                    |
| `packages/chatgpt-adapter/src/adapter.ts`                                | One adapter maps many job IDs to pages                            | One adapter per sandbox/job attempt/purpose with one page; at-risk lookup never crosses the sandbox                                                                                    |
| `packages/chatgpt-adapter/src/tabBudget.ts`                              | Three-page shared-profile budget                                  | Delete after one-page sandbox construction makes shared budgeting impossible                                                                                                           |
| `apps/oracle-worker/src/certifiedProvider.ts`                            | Singleton runtime/adapter and shared recovery target preservation | Router keyed by `jobId + turnAttemptId + purpose`; one `dispatch` key/lifetime spans preparation through at-risk observation, while capture recovery and probe have distinct lifetimes |
| `packages/oracle-kernel/src/provider.ts`                                 | `releaseJob(jobId)` and shared recovery-target binding            | Cleanup receives final durable job context; retain only object readback in runtime bindings                                                                                            |
| `apps/oracle-worker/src/runner.ts`                                       | Any escaping job error globally stops scheduling                  | Store/authority/global compatibility failures remain fatal; sandbox/page/cleanup failures become job-local incidents                                                                   |
| `apps/oracle-worker/src/worker.ts`                                       | Enumerates durable jobs into shared-profile window preservation   | Remove `listBrowserRecoveryTargets`; startup sandbox reconciliation uses ledger state plus owner/process identity                                                                      |
| `scripts/oracle-v2-runtime-spike.ts`, `scripts/oracle-v2-live-canary.ts` | Fixed-profile setup/certification and bounded canary harnesses    | T1/T3 update to auth-seed setup, two-clone no-Send proof, and disposable attempt evidence                                                                                              |

## Legacy ownership and lifecycle reference graph

```text
bin/oracle-cli.ts
  -> src/cli/sessionRunner.ts
    -> src/browser/sessionRunner.ts
      -> src/browserMode.ts
        -> src/browser/index.ts

src/browser/index.ts
  -> tabLeaseRegistry.ts
  -> lifecycleReconciler.ts
  -> dedicatedChromeSupervisor.ts
  -> profileState.ts / chromeLifecycle.ts / liveTabs.ts

src/cli/sessionDisplay.ts -> src/browser/reattach.ts
src/cli/browserTabs.ts -> recoverConversation.ts + lifecycleReconciler.ts
recoverConversation.ts / reattach.ts / projectSourcesRunner.ts
  -> tabLeaseRegistry.ts + lifecycleReconciler.ts
  -> dedicatedChromeSupervisor.ts + profileState.ts

bin/oracle-cli.ts -> src/cli/dedicatedBrowser.ts
  -> dedicatedChromeSupervisor.ts + lifecycleReconciler.ts
  -> tabLeaseRegistry.ts + profileState.ts
```

The principal import/reference set observed at T0 is:

| Ownership surface                                                                                                             | Direct production reference set                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/browser/lifecycleReconciler.ts`                                                                                          | `src/browser/index.ts`, `projectSourcesRunner.ts`, `reattach.ts`, `recoverConversation.ts`, `src/cli/browserTabs.ts`, `src/cli/dedicatedBrowser.ts`                                                                                                                                                                                                                                                                    |
| `src/browser/tabLeaseRegistry.ts`                                                                                             | `src/browser/config.ts`, `dedicatedChromeSupervisor.ts`, `index.ts`, `lifecycleReconciler.ts`, `projectSourcesRunner.ts`, `reattach.ts`, `recoverConversation.ts`, `src/cli/dedicatedBrowser.ts`                                                                                                                                                                                                                       |
| `src/browser/dedicatedChromeSupervisor.ts`                                                                                    | `src/browser/index.ts`, `projectSourcesRunner.ts`, `reattach.ts`, `recoverConversation.ts`, `src/cli/dedicatedBrowser.ts`                                                                                                                                                                                                                                                                                              |
| `src/browser/recoverConversation.ts`                                                                                          | `src/cli/browserTabs.ts`, `src/cli/followup.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| `src/browser/reattach.ts`                                                                                                     | `src/cli/sessionRunner.ts`, `src/cli/sessionDisplay.ts`                                                                                                                                                                                                                                                                                                                                                                |
| legacy metadata (`browserLifetime`, `keepBrowser`, `maxConcurrentTabs`, auto-reattach, disposition/recovery/reconcile fields) | `src/browser/config.ts`, `controlPlan.ts`, `index.ts`, `manualLoginProfile.ts`, `projectSourcesRunner.ts`, `reattach.ts`, `recoverConversation.ts`, `sessionRunner.ts`, `tabLeaseRegistry.ts`, `types.ts`; `src/cli/browserConfig.ts`, `browserDefaults.ts`, `browserTabs.ts`, `dedicatedBrowser.ts`, `sessionRunner.ts`; `src/config.ts`, `src/mcp/tools/consult.ts`, `src/remote/server.ts`, `src/sessionManager.ts` |

Tests named after these surfaces and the browser CLI integration tests are part
of the same removal set; they are not independent reasons to retain production
ownership code.

## G3 default cutover map

G3 is a separate owner decision after T1-T3 evidence. On a supported, certified
macOS GUI worker host, it changes `src/cli/engine.ts` so the no-API default is
`broker`, then reconciles `bin/oracle-cli.ts`, `src/config.ts`, CLI/MCP help and
docs, root integration tests, and packed CLI behavior. Windows and other
deferred worker platforms retain their existing engine default until that
platform has an accepted worker plan and evidence. Legacy `browser` may remain
only as an explicit, temporary rollback engine between G3 and G4 on the
supported cutover platform. G3 does not authorize deletion.

## G4 physical deletion map

G4 is a second owner decision after accepted G3 evidence and a rollback tag.
R11 remote bridging is independent: its absence neither blocks nor authorizes
G4. Because these ownership areas are shared repository code, the macOS-only G3
cutover is not sufficient deletion authority. Before G4, every supported
platform that still selects legacy by default must have an accepted replacement
worker and cutover, or that platform's support must be retired through a
separate explicit owner decision. A deferred worker is not equivalent to either
condition. Delete or strip the following executable ownership areas only after
that platform boundary and a fresh reference scan:

- `src/browser/lifecycleReconciler.ts`,
  `src/browser/tabLeaseRegistry.ts`, and
  `src/browser/dedicatedChromeSupervisor.ts`;
- legacy execution/recovery in `src/browser/index.ts`, `src/browserMode.ts`,
  `src/browser/sessionRunner.ts`, `src/browser/reattach.ts`,
  `src/browser/recoverConversation.ts`, `src/browser/projectSourcesRunner.ts`,
  `src/browser/liveTabs.ts`, `src/browser/chromeLifecycle.ts`, and
  `src/browser/profileState.ts` when no surviving non-legacy caller remains;
- legacy dedicated-profile setup, attach/copy/cookie/remote/deep-research/media
  execution modules and their callers when the final G4 reference scan proves
  they serve no retained API/OpenCLI/read-only path;
- `src/cli/browserTabs.ts`, `src/cli/dedicatedBrowser.ts`, legacy portions of
  `src/cli/sessionRunner.ts` and `src/cli/sessionDisplay.ts`, and corresponding
  dynamic command registration in `bin/oracle-cli.ts`;
- config/schema/help fields for shared max tabs, profile-global locks/holds,
  sentinels, target disposition, `browserLifetime`, `keepBrowser`,
  auto-reattach, draft-retained/manual-intervention recovery, attach-running,
  cookie/profile copy, and direct legacy browser execution;
- corresponding tests and current-behavior docs, including legacy execution
  sections in `docs/browser-mode.md`, `docs/dedicated-chrome.md`,
  `docs/configuration.md`, `docs/cli-reference.md`, and `docs/quickstart.md`.

G4 must retain only evidenced current consumers:

- read-only historical session parsing/rendering in `src/sessionManager.ts`,
  `src/sessionStore.ts`, and CLI session projection code;
- source/bundle selection still used by API, broker, or migration paths;
- explicit OpenCLI transport if it remains supported and has no dependency on
  the deleted ownership stack;
- canonical v2 packages, worker, client protocol, Batch parent authority, and
  the disposable-sandbox adapter/runtime;
- dated historical evidence, clearly labeled as historical rather than live
  operator guidance.

Before deletion, rerun the reference scan and report executable source LOC
added/deleted separately from tests/docs. Net executable growth at G4 requires
an explicit authority or safety justification.

## Gates

- T0: owner accepts this boundary and deletion map. No browser behavior, local
  profile, account state, or Send is touched.
- T1: separately authorize the real two-clone no-Send gate; a dirty clone A must
  be destroyed and clone B from the unchanged seed must be clean.
- T2: integrate the sandbox router and job-local cleanup under fixture/fault
  evidence; the exact dispatch sandbox survives through at-risk observation,
  and no unapproved live Send occurs.
- T3: separately authorize each bounded live case.
- G3: separately accept the default switch.
- G4: separately accept physical legacy deletion after G3 evidence.
