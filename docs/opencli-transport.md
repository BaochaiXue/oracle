---
title: OpenCLI alternative transport
description: "The optional Browser Bridge path: Oracle keeps canonical session authority while OpenCLI owns only the authenticated browser handoff."
---

# OpenCLI alternative transport

OpenCLI remains an explicit alternative transport in this fork. The canonical
path now uses Oracle's own persistent isolated Chrome profile and direct
loopback CDP; see [Dedicated Chrome transport](dedicated-chrome.md). Choose
OpenCLI when Browser Bridge is an intentional operator preference or the local
environment cannot launch direct CDP.

The integration architecture still matters. Oracle already knows which
prompt and files were authorized, which model was requested, whether a turn may
have been submitted, which answer belongs to it, and how a later follow-up is
related. Putting OpenCLI in a shell wrapper around Oracle would split those
facts across two session engines. Instead, this fork adds a narrow browser
transport inside Oracle and leaves the rest of Oracle's authority intact.

There is no automatic fallback between OpenCLI and CDP. A transport is selected
before dispatch and remains responsible for that operation; otherwise Oracle
could not know whether switching transports should submit the turn again.

## One authority, two responsibilities

| Oracle owns                            | OpenCLI owns                                           |
| -------------------------------------- | ------------------------------------------------------ |
| Prompt construction and file selection | Authenticated Browser Bridge access                    |
| Sealed payload and manifest identity   | Short-lived submission and waiter tab leases           |
| Model and reasoning picker semantics   | Executing Oracle's generated picker in the exact tab   |
| Session state and conversation receipt | Transferring the sealed files to the exact tab         |
| Answer and transcript persistence      | One isolated waiter lease for the whole answer harvest |
| Resume and follow-up lineage           | Structured submission and answer receipts              |

The handoff is deliberately narrow:

```text
Oracle buildPrompt
  → write mode-0600 payload and manifest
  → journal authorization
  → preflight OpenCLI + Browser Bridge + adapter contract
  → acquire Oracle's ChatGPT transport lock
  → recheck sealed payload digest
  → open the exact new chat or stored conversation
  → select and verify GPT-5.6 Sol + Pro in that tab
  → journal model evidence and dispatch intent
  → submit the sealed files
  → capture the follow-up baseline on that submission tab
  → persist the structured conversation receipt and baseline
  → release transport lock
  → start one read-only oracle-wait command and one isolated tab lease
  → observe the same page until the new assistant Markdown is stable
  → explicitly close the waiter tab
  → measure dispatch intent to stable answer
      ↳ record elapsed time as telemetry
      ↳ tiny workload: persist answer and transcript
      ↳ substantive + sub-minute: retain digest/timing and fail closed
```

Model selection happens for every turn and shares a lock with submission.
Browser state is mutable: a previous tab saying `Pro` is not proof that the next
turn will be sent there.

Oracle remains the model-selection authority. Its installer generates the same
native model and thinking expressions used by the direct browser path into the
companion submit adapter. OpenCLI executes those expressions in the exact tab
that will receive the sealed turn. The transport never runs a separate
`chatgpt model` command, so it cannot select one tab and submit through another.
It also avoids OpenCLI's preference endpoint, which can return `403` despite a
visibly authenticated ChatGPT page.

## Why not a sidecar orchestrator?

| Question                     | Transport inside Oracle        | Sidecar around Oracle                  |
| ---------------------------- | ------------------------------ | -------------------------------------- |
| Canonical session authority  | Oracle                         | Split                                  |
| Bundle-to-answer provenance  | Direct                         | Must be reconciled                     |
| Restart recovery             | Uses the stored Oracle session | Wrapper must recreate Oracle semantics |
| Follow-up conversation state | Oracle lineage                 | Hidden wrapper state                   |
| Long-term maintenance        | One workflow                   | Two coupled CLIs                       |

A sidecar is useful as a disposable integration spike. It is not the durable
shape: as soon as it owns retries, conversation identifiers, or response
retrieval, Oracle's stored session stops describing the workflow that actually
ran.

## GPT-5.6 Pro: product name versus wire name

This fork calls the browser target **GPT-5.6 Pro** in human-facing text. The
current ChatGPT UI exposes a model and reasoning tier separately. Oracle uses
the stable browser alias `gpt-5-pro` and stores all three facts in the receipt:
effective `GPT-5.6 Pro`, model `GPT-5.6 Sol`, and reasoning tier `Pro`.

These names should not be collapsed:

- `gpt-5-pro` means “select the current effective ChatGPT GPT-5.6 Pro target” in
  this browser lane.
- `GPT-5.6 Sol` and `Pro` are evidence copied from the actual model and
  reasoning controls.
- `gpt-5.5-pro` remains an upstream Oracle API model and default.
- GPT-5.6 API reasoning mode is a separate provider contract; this browser
  transport does not invent a new API model slug.

## Failure and recovery contract

Oracle distinguishes failures by whether the browser may have accepted the
turn:

| Point of failure                                               | Oracle behavior                 | Safe next action                          |
| -------------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Preflight, auth, model verification, lock, or bundle integrity | Fails before dispatch           | Fix the reported condition and retry      |
| Handoff began but no durable receipt was captured              | Marks the attempt ambiguous     | Reconcile manually; do not auto-resubmit  |
| Receipt exists but answer collection timed out                 | Keeps the conversation receipt  | Resume the waiter only                    |
| Tiny answer arrives quickly                                    | Accepts with timing telemetry   | Use normally                              |
| Substantive answer arrives below 60 seconds                    | Rejects with digest/timing only | Inspect route evidence; do not use answer |
| Follow-up baseline cannot be established                       | Fails before dispatch           | Recover the stored conversation first     |
| Stored remote conversation is missing                          | Stops                           | Never open a replacement chat silently    |

The central invariant is simple:

> Once a durable ChatGPT conversation receipt exists, recovery reads that
> conversation. It does not submit the turn again.

Before each dispatch, Oracle journals the operation reference, payload digest,
target, and attempt. For a follow-up, the submit adapter captures the prior
assistant index and Markdown digest on the exact submission tab before sending,
then returns them with the versioned conversation receipt. The answer adapter
returns a second versioned row containing the new assistant index, digest,
stable duration, and Markdown. Unknown versions or incomplete receipts fail
closed.

Model-picker evidence is request-side evidence, not server-routing proof. The
transport reads the durable `dispatch-intent` timestamp and records elapsed time
until the stable assistant answer is captured. Tiny workloads (at most 256
estimated input tokens and 16 KiB of uploaded payload) are duration-exempt
because a simple Pro request may legitimately complete in seconds. A substantive
workload captured below 60 seconds fails closed with only its digest and timing
evidence retained. The first captured elapsed time remains in session runtime
metadata; very large workloads that pass the guard but finish before 120 seconds
emit an additional warning.

The long wait has a separate lifecycle invariant: one Oracle operation starts
exactly one `chatgpt oracle-wait` process, and that process keeps exactly one
ephemeral conversation tab until completion or timeout. Generation detection
looks only at visible generation controls; it never scans answer prose for words
such as `Thinking`. Both companion commands explicitly close their exact tab;
they run with `--keep-tab true` so OpenCLI's executor does not perform a second
lease release after the adapter has closed the tab. The flag is intentionally
counterintuitive here: the adapter owns final cleanup, and skipping the executor's
fallback prevents a second close from racing the adapter. If cleanup discovers
that the exact page identity is already gone, `Page not found` / `stale page
identity` is treated as idempotent success; other close failures remain errors.
A retained OpenCLI failure trace is exported after adapter cleanup, so its final
screenshot/state may legitimately show `about:blank`. That placeholder is not a
conversation receipt. Oracle's transport journal and stored conversation URL are
the authoritative recovery evidence.

All submission and waiter leases use OpenCLI's `background` window mode. The
contract is **do not focus the automation window**, not “run headless” or “make
Chrome physically invisible.” Depending on macOS window stacking and the
existing Browser Bridge window, a Chrome window may be noticeable or may remain
behind other apps. Oracle records `opencliWindowMode: background` so every run
has one explicit policy.

## Private data boundary

Preflight, version checks, and model selection do not receive prompt or file
contents. Oracle writes the authorized turn inside its session directory with
mode `0600`; OpenCLI receives file paths rather than private text interpolated
into command arguments. The adapter rechecks the payload digest before it
touches the composer.

The session record may contain artifact paths, digests, an Oracle operation
reference, OpenCLI version, conversation id/URL, and follow-up baseline
evidence. It must not contain Browser Bridge credentials, cookies, extension
tokens, or account secrets.

The normal account boundary still applies. A person may be required to sign in,
resolve an authentication challenge, or restore model entitlement. This design
removes routine debugging approval from the steady-state workflow; it does not
bypass account controls.

## Supported surface

The OpenCLI transport is intentionally a GPT-5.6 Pro **text consultation** lane.
It supports sealed new turns, explicit stored-conversation follow-ups, durable
receipts, single-waiter answer recovery, and the normal Oracle transcript/session
store.

It rejects image generation, Deep Research, and same-invocation
`--browser-follow-up` before dispatch. Use a separate Oracle `--followup` turn
for multi-turn review. Select `--browser-transport cdp` for the canonical
dedicated-profile lane and its full direct-browser feature surface. There is no
automatic OpenCLI-to-CDP fallback.

## Verification surface

The repository tests cover:

- mode-`0600` sealed artifacts and absence of private prompt text in subprocess
  arguments;
- manifest/payload digest verification and mutation rejection;
- explicit new-chat versus stored-conversation targets;
- follow-up baseline markers;
- one waiter command per harvest, with no polling process/tab fan-out;
- fast tiny-workload acceptance and substantive-workload timing rejection from
  durable dispatch intent;
- waiter-only reattach with no second model selection or dispatch;
- generation-control detection that does not inspect answer prose;
- supported OpenCLI/adapter contract versions;
- same-tab `GPT-5.6 Sol` model plus `Pro` reasoning selection through Oracle's
  generated native picker;
- tab-free Browser Bridge preflight and exact target cleanup;
- idempotent cleanup when OpenCLI reports an already-closed stale page identity;
- sanitized OpenCLI failure stage, code, exit status, and trace-path persistence;
- strict ChatGPT receipt parsing.

Run the narrow suite with:

```bash
pnpm vitest run \
  tests/browser/opencliTransport.test.ts \
  tests/opencli-adapters/submit-file-core.test.ts
```

For setup and commands, continue to [Browser Mode](browser-mode.md). For the
canonical transport, read [Dedicated Chrome](dedicated-chrome.md). Return to the
[documentation home](index.md).
