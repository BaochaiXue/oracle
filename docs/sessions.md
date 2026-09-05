---
title: Sessions
description: "Every Oracle run is a stored session you can list, replay, follow up on, or prune. Background API runs detach by default; reattach later."
---

Every Oracle run gets an id, a slug, and a folder. You can list runs, render the prompts you sent, replay the answer, and continue from any of them. This page is the lifecycle reference.

## Where sessions live

```
~/.oracle/sessions/<id>/
├── meta.json                # status, model(s), cost, lineage
├── prompt.md                # assembled bundle (what was sent)
├── response.md              # the model's answer (when complete)
├── log.jsonl                # per-event log
└── artifacts/               # browser-only: transcript, generated images/files, deep-research-report.md
```

Override the root with `ORACLE_HOME_DIR=/some/path`.

Batch Oracle adds a parent store beside ordinary sessions:

```text
~/.oracle/batches/<batch-id>/
├── state.json
├── report.md
├── inputs/       # admitted source snapshot, sealed prompts, bytes, provenance
└── outputs/      # manifest-ordered raw answers and immutable receipts
```

Every Batch lane and optional synthesis remains an ordinary child session under
`~/.oracle/sessions/`, with `batchId`, `laneId`, role, attempt, and sealed input
digest in its metadata. The parent coordinates the stage; child session/browser
metadata remains execution and reattach authority. Nonterminal batch children
are protected from time-based session pruning.

## Listing

```bash
oracle status                  # last 20 sessions
oracle status --hours 168      # last week
```

`status` shows status, model, mode, timestamp, character count, cost, and slug — with a tree of `--followup` lineage:

```
Recent Sessions
Status    Model         Mode    Timestamp           Chars    Cost  Slug
completed gpt-5.2-pro   api     03/01 09:00 AM      1800   $2.110  architecture-review-parent
completed gpt-5.2-pro   api     03/01 09:14 AM      2200   $2.980  ├─ architecture-review-followup
running   gpt-5.2-pro   api     03/01 09:22 AM      1400        -  │  └─ implementation-pass
pending   gpt-5.2-pro   api     03/01 09:25 AM       900        -  └─ risk-check
```

## Replaying

```bash
oracle session <id>            # print metadata + answer
oracle session <id> --render   # print the prompt that was sent
```

Use the slug or a unique id prefix; Oracle resolves both.

## Reattach

GPT-5.x Pro answers can take 10–60 minutes. API runs detach by default — Oracle returns the session id, you reattach later:

```bash
oracle status                  # find the running one
oracle session <id>            # blocks until done, then prints the answer
```

Every new run prints a lifecycle block so foreground and detached behavior is explicit:

```text
Session: 20260515-name-panel
Mode: api background
Models: 3 parallel
Detach: yes, polling
Reattach: oracle session 20260515-name-panel
```

`oracle status` uses compact mode labels such as `api/fg`, `api/bg`, `br/fg`, and `br/bg`; `oracle session <id>` shows the persisted execution state.

To keep the original CLI attached until completion, pass `--wait`:

```bash
oracle --wait --model gpt-5.5-pro -p "Long architecture review" --file "src/**"
```

For API runs, `--wait` executes the request in the foreground. Local Pro browser runs use a detached worker even with `--wait`, while the original CLI stays attached to the session log. This lets the browser worker capture and save the answer if the foreground CLI exits unexpectedly. Pressing Ctrl-C still cancels the worker and exits with code 130.

For browser runs, ChatGPT sometimes redirects mid-page-load. The auto-reattach flags poll the existing tab without manual intervention:

```bash
oracle --engine browser \
  --browser-timeout 6m \
  --browser-auto-reattach-delay 30s \
  --browser-auto-reattach-interval 2m \
  --browser-auto-reattach-timeout 2m \
  -p "Long UI audit" --file "src/**"
```

See [Browser Mode](browser-mode.md) for the full set.

If direct CDP emits one potentially submitting event but cannot verify the
exact committed user turn, the session is stored as `error` with
`incompleteReason: "incomplete-capture"`, an exact recoverable browser target,
and `retrySafe:false`. Use `oracle session <id> --render` to reattach that target;
do not start a replacement attempt while commit state remains indeterminate.
If the stored exact target ID no longer exists, recovery fails closed rather
than opening another tab or browser for the same conversation.
The receipt persists the current prompt digest and pre-dispatch turn baseline
before the event; Oracle emits no submitting event when it cannot establish the
baseline. Reattach must match that digest to exactly one user turn at
or after the baseline before it can capture the corresponding answer, including
when the commit became visible only after the original run stopped.

If an exact target is retained before dispatch because a draft is present, or
the target otherwise requires manual intervention, the session instead records
`incompleteReason: "manual-intervention"`. `oracle session <id> --render`
reattaches that exact tab for inspection only: it never captures an earlier
answer and never submits from the retained state.

This recovery contract does not apply to `--copy-profile`, whose temporary
profile is always removed, or locally launched `--browser-headless`, whose
browser process is not retained. Ambiguous, retained-draft, and manual outcomes
in either mode are explicitly non-reattachable. Remote Chrome ignores the local
headless launch flag and keeps its exact-target recovery eligibility.

For a declared parallel batch, resume the parent instead of restarting a child:

```bash
oracle batch status <batch-id> --json
oracle batch resume <batch-id>
```

Batch resume reuses the original recoverable child session. It creates a new
attempt only when the previous child has durable evidence that no prompt was
submitted or committed and the failure is retry-safe. Every generic mutation
surface rejects Batch children: `oracle restart <child>`, `--followup <child>`,
and `oracle session <child> --live|--harvest`. These paths cannot own parent
reservations, canonical answers, receipts, or the stage barrier.

A Batch child remains inspectable with `oracle session <child>`, `oracle status
<child>`, `oracle session <child> --print-paths`, or stored log/artifact rendering.
Here **inspect** is strictly read-only. Plain attach displays one current
snapshot and returns; it does not wait, auto-reattach, repair capture, append a
log, create an artifact, update model/session state, or terminalize. This is
true for running, recoverable, completed, and owner-abandoned synthesis
children. All recovery, retry, completion, and owner closure must pass through
the Batch parent. See [Batch Oracle v1](batch-oracle.md).

If an unavailable lane must be omitted, preserve its session and record the
owner decision before partial synthesis:

```bash
oracle batch accept-missing <batch-id> --lane <lane-id> --reason "<reason>"
oracle batch resume <batch-id> --allow-partial
```

If every first-stage lane is accepted but synthesis remains nonterminal after
bounded recovery, close it without resending while preserving its session and
conversation:

```bash
oracle batch accept-missing <batch-id> --synthesis --reason "<reason>"
```

The parent becomes terminal `partial`, the report records synthesis as
unavailable, and verified raw lane answers remain usable.

## Restart

```bash
oracle restart <id>            # re-run with the same prompt + files
```

Useful when a transient ordinary browser/API error truncated the answer.
Restart copies the bundle, opens a new session, and links lineage back. Batch
children are rejected before options are cloned or a new session is created;
use `oracle batch resume <batch-id>`, or create a deliberately independent
ordinary Oracle run without Batch lineage.

## Follow up

Continue a saved ChatGPT browser conversation or an OpenAI / Azure Responses API session with new context:

```bash
oracle --followup <id> -p "Re-evaluate with these files" \
  --file "src/migrations/**"
```

Browser followup reopens the exact saved conversation and inherits its browser
configuration and model. A Batch child is rejected before Oracle resolves or
opens its conversation URL; Batch conversations can only advance through the
parent. For multi-model API parents, pick the lineage with `--followup-model`.
See [Followup](followup.md) for the full ordinary-session flow and the formats
`--followup` accepts (session ids, slugs, or `resp_…` response ids).

## Background mode

Force a Responses API run into background mode (create + retrieve) regardless of model defaults:

```bash
oracle --background --model gpt-5.5-pro -p "..." --file "src/**"
oracle --no-background --model gpt-5.5 -p "..." --file "src/**"
```

GPT-5.x Pro defaults to background; non-Pro models block by default. Override per-run when needed.

## Pruning

```bash
oracle status --clear --hours 168   # delete sessions older than a week
```

`--clear` is destructive — preview without it first. Time-based pruning skips
child sessions referenced by every Batch Oracle parent that has not published
`completed` or owner-accepted `partial`, including a resumable parent in
`error`. Batch state is separate under `~/.oracle/batches`; if any batch state
is unreadable, pruning fails closed rather than guessing that its children are
unprotected. Inspect a batch report and lineage before removing any
corresponding ordinary child session manually.

## Stale / zombie detection

`oracle status` flags stale sessions (process gone, no recent log activity). Tune with:

- `--zombie-timeout <ms|s|m|h>` — cutoff for "stale."
- `--zombie-last-activity` — use last log entry instead of session start.

## Slugs

Every run gets a default slug derived from the prompt. Override with `--slug "my-thing"` for stable names you can reference later (`oracle session my-thing`).

## Naming conventions

Pair `--slug` with conventional prefixes for browseability:

- `arch-…` — architecture / design review
- `bug-…` — debugging session
- `refactor-…` — refactor cross-check
- `plan-…` — planning consult
- `dr-…` — Deep Research run

Then `oracle status --hours 720 | grep arch-` shows your last month of architecture work.
