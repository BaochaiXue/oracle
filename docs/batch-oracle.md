---
title: Batch Oracle v1
description: "Declare independent GPT-5.6 Pro lanes, dispatch a blind parallel first pass, recover each original session, and optionally synthesize after a durable barrier."
---

# Parallel consultation without rolling consensus

Batch Oracle is for one difficult decision that contains at least two
independent, decision-relevant questions. Each question becomes a declared
lane with its own mandate, falsification target, evidence, exact prompt, output
contract, and recoverable Oracle session. Oracle seals the complete first-stage
ready set before sending anything, dispatches those lanes concurrently up to
the owner's configured capacity, and keeps sibling answers hidden while the
stage is open. Recoverable work keeps the barrier open until its original
session is resumed or reaches a terminal state.

An optional synthesis lane starts only after the first-stage barrier closes. It
receives the raw answers and their provenance together, preserves dissent, and
adjudicates contradictions. Batch Oracle is not identical-prompt voting, a
persona panel, rolling synthesis, or an arbitrary workflow DAG.

```text
strict JSON5 manifest
        │
        ▼
all-or-nothing first-stage seal
        │
        ├── lane A ── child session A ── raw answer + receipt
        ├── lane B ── child session B ── raw answer + receipt
        └── lane C ── child session C ── raw answer + receipt
                            │
                    durable stage barrier
                            │
                            ▼
              optional synthesis child session
```

## Manifest

Batch manifests are strict JSON or JSON5. Unknown fields, unsupported schema
versions, unsafe paths, lane ID collisions, exact normalized prompt duplicates,
and prompt/files/mandate duplicates fail validation. A batch requires at least
two first-stage lanes.

```json5
{
  schemaVersion: "oracle.batch.v1",
  slug: "release-readiness-tribunal",
  project: "example",
  objective: "Decide whether the release candidate is ready and identify one bounded next experiment.",
  cwd: ".",
  sharedAuthority: {
    revisionLabel: "release-candidate-4",
    files: ["docs/product-contract.md", "docs/release-criteria.md"],
  },
  policy: {
    maxParallel: 3,
    maxChildSessions: 4,
    allowanceGate: "pause-batch",
    partialSynthesis: "owner-explicit",
    revealLaneAnswersBeforeBarrier: false,
  },
  lanes: [
    {
      id: "contract",
      title: "Product contract",
      mandate: "Test the candidate against the declared user job and boundaries.",
      whyThisLane: "Feature completeness is independent from runtime reliability.",
      falsificationTarget: "The candidate can pass implementation checks while missing the declared job.",
      prompt: "Audit the release candidate against the product contract.",
      files: ["src/product/**", "tests/product/**"],
      bundleRole: "sources",
      outputContract: ["supported claims", "contract violations", "release blockers"],
    },
    {
      id: "recovery",
      title: "Recovery",
      mandate: "Test crash, detach, and retry behavior.",
      whyThisLane: "Durability requires different evidence from feature completeness.",
      falsificationTarget: "A passing foreground run hides duplicate-submit or lost-session risk.",
      prompt: "Audit recovery invariants and failure evidence.",
      files: ["src/session/**", "tests/recovery/**"],
      bundleRole: "evidence",
      outputContract: ["failure matrix", "duplicate-submit risks", "missing tests"],
    },
  ],
  synthesis: {
    id: "adjudication",
    title: "Release adjudication",
    prompt: "Reconcile the independent findings without voting by majority.",
    files: ["docs/release-criteria.md"],
    requiredOutput: ["contradiction matrix", "owner-pending decisions", "kill criteria"],
  },
}
```

Every file path or glob is resolved beneath the manifest's effective `cwd`.
Absolute paths, traversal, backslashes, empty path segments, and symlink escapes
are rejected. The resolved files and their byte digests become source
provenance; later workspace changes may set `workspaceDrift:true`, but never
replace already sealed child input.

## Commands

```bash
# Parse, validate, resolve files, and stop before browser/session creation.
oracle batch validate batch.json5

# Print the batch ID, seal all first-stage inputs, create all child mappings,
# and dispatch the ready set through the canonical dedicated CDP Pro lane.
oracle batch run batch.json5

# Inspect one reconciled parent or list recent batches.
oracle batch status <batch-id>
oracle batch status <batch-id> --json
oracle batch status --hours 168

# Reattach original recoverable sessions. This never duplicates a committed turn.
oracle batch resume <batch-id>

# Explicitly accept terminal failed lanes before partial synthesis.
oracle batch resume <batch-id> --allow-partial

# Summary hides raw child answers; load one or all only on demand.
oracle batch render <batch-id>
oracle batch render <batch-id> --lane recovery
oracle batch render <batch-id> --all
```

`--max-parallel` may lower the effective run capacity. It cannot raise the
manifest, local owner, or browser tab caps.

## Sealing, bundle identity, and privacy

All first-stage lanes must assemble successfully before Oracle creates any
child session or dispatches any prompt. The final prompt text, attachment
bytes, source identities, token estimate, and input-manifest digest are copied
to owner-only batch storage. Resume reads those sealed copies; it does not
re-glob the mutable workspace.

Generated TXT and ZIP attachments have semantic identities such as:

```text
example--contract--sources--2c71e4a9.txt
example--recovery--evidence--d90a12f7.zip
example--adjudication--lane-answers--716eb620.zip
```

The eight-character ID is derived from the canonical internal manifest, not
from a temporary path. TXT headers and ZIP root manifests repeat the same
project, subject, role, file identities, and digest. A browser-added suffix
such as ` (1)` may change the transported outer filename, but not the internal
bundle identity.

The batch store is local and owner-only:

```text
~/.oracle/batches/<batch-id>/
├── manifest.source.json5
├── manifest.normalized.json
├── source-manifest.json
├── state.json
├── report.md
├── inputs/
│   ├── first-stage-seal.json
│   ├── lanes/<lane-id>/
│   └── synthesis/
└── outputs/
    ├── lanes/<lane-id>/answer.md + answer-receipt.json
    └── synthesis/answer.md + answer-receipt.json
```

Raw child answers are persisted as they arrive but are not printed during an
open stage. `render --all` emits them in manifest order, never completion order.

## Recovery and owner gates

Each logical lane has one active recoverable attempt. Quiet, detached, or
timed-out work reattaches to that lane's original child session. A new attempt
is allowed only during explicit `batch resume` when durable child evidence says
the previous prompt was unsubmitted, uncommitted, and `retrySafe:true`.
Committed, indeterminate, or recoverable submissions are never resubmitted.

The parent reconciles child metadata after a process interruption, including a
child session written before its parent mapping and an answer written before
the parent receipt. State mutation locks are short-lived: they protect
reconciliation and dispatch reservation, but are not held while GPT-5.6 Pro is
thinking. Concurrent resume processes therefore cannot reserve a second active
attempt for the same lane.

If ChatGPT raises a request-frequency gate before prompt commit, Oracle pauses
new lane starts and preserves already committed siblings. It reports the batch
and original session IDs. It does not loop Send, change transport, switch
provider/model/account, or use an API workaround.

A terminal failed lane keeps the batch at `awaiting-owner`. Synthesis remains
blocked until the owner explicitly uses `--allow-partial`; recoverable or
otherwise nonterminal lanes cannot be waived. The synthesis prompt, receipts,
report, and final `partial` status all name missing lanes and weakened evidence.

If the complete synthesis input exceeds the GPT-5.6 Pro context limit, Oracle
fails closed with per-answer sizes. It does not truncate answers or create a
hidden summary child.

## v1 boundary

Batch Oracle v1 supports one independent parallel stage plus one optional
synthesis stage. It does not add MCP tools, a TUI, YAML, API multi-model fanout,
OpenCLI batch dispatch, account-side quota probing, recursive batches, rolling
synthesis, or lane-to-lane dependencies. Use multiple declared batches when a
later stage genuinely depends on an earlier result.

See [CLI reference](cli-reference.md), [Configuration](configuration.md), and
[Sessions](sessions.md) for the corresponding command, local policy, and
lineage surfaces.
