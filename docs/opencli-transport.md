---
title: Oracle × OpenCLI
description: "Why this fork keeps Oracle as the canonical session authority while OpenCLI owns only the authenticated browser boundary for unattended GPT-5.6 Pro consults."
---

# Why the OpenCLI transport lives inside Oracle

This fork exists for one practical reason: a long GPT-5.6 Pro consultation
should not be lost because nobody was at the Mac to approve Chrome debugging at
the right moment.

The architecture matters more than the convenience. Oracle already knows which
prompt and files were authorized, which model was requested, whether a turn may
have been submitted, which answer belongs to it, and how a later follow-up is
related. Putting OpenCLI in a shell wrapper around Oracle would split those
facts across two session engines. Instead, this fork adds a narrow browser
transport inside Oracle and leaves the rest of Oracle's authority intact.

## One authority, two responsibilities

| Oracle owns                               | OpenCLI owns                                   |
| ----------------------------------------- | ---------------------------------------------- |
| Prompt construction and file selection    | Authenticated Browser Bridge access            |
| Sealed payload and manifest identity      | An ephemeral, explicitly targeted tab lease    |
| Submission intent and operation reference | Selecting the UI-native `Pro` option           |
| Session state and conversation receipt    | Transferring the sealed files to the exact tab |
| Answer and transcript persistence         | Returning a structured submission receipt      |
| Resume and follow-up lineage              | Read-only `chatgpt detail` retrieval           |

The handoff is deliberately narrow:

```text
Oracle buildPrompt
  → write mode-0600 payload and manifest
  → journal authorization
  → preflight OpenCLI + Browser Bridge + adapter contract
  → acquire Oracle's ChatGPT transport lock
  → select and verify Pro
  → recheck sealed payload digest
  → journal dispatch intent
  → submit to new chat or the stored conversation
  → persist structured conversation receipt
  → release transport lock
  → poll read-only detail
  → persist answer and transcript
```

Model selection happens for every turn and shares a lock with submission.
Browser state is mutable: a previous tab saying `Pro` is not proof that the next
turn will be sent there.

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
current ChatGPT composer and OpenCLI command contract expose the shorter names
`Pro` and `pro`. Oracle therefore uses the stable browser alias `gpt-5-pro` and
stores the exact `Pro` receipt returned by the transport.

These names should not be collapsed:

- `gpt-5-pro` means “follow the current ChatGPT Pro picker target” in this
  browser lane.
- `Pro` is evidence copied from the actual web surface; rewriting it as a
  guessed version would weaken provenance.
- `gpt-5.5-pro` remains an upstream Oracle API model and default.
- GPT-5.6 API reasoning mode is a separate provider contract; this browser
  transport does not invent a new API model slug.

## Failure and recovery contract

Oracle distinguishes failures by whether the browser may have accepted the
turn:

| Point of failure                                               | Oracle behavior                | Safe next action                         |
| -------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| Preflight, auth, model verification, lock, or bundle integrity | Fails before dispatch          | Fix the reported condition and retry     |
| Handoff began but no durable receipt was captured              | Marks the attempt ambiguous    | Reconcile manually; do not auto-resubmit |
| Receipt exists but answer collection timed out                 | Keeps the conversation receipt | Resume detail only                       |
| Follow-up baseline cannot be established                       | Fails before dispatch          | Recover the stored conversation first    |
| Stored remote conversation is missing                          | Stops                          | Never open a replacement chat silently   |

The central invariant is simple:

> Once a durable ChatGPT conversation receipt exists, recovery reads that
> conversation. It does not submit the turn again.

Before each dispatch, Oracle journals the operation reference, payload digest,
target, attempt, and—on follow-ups—the prior assistant index and digest. The
adapter returns a versioned row containing the conversation id, conversation
URL, visible `Pro` evidence, and transferred file count. Unknown versions or
incomplete receipts fail closed.

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
receipts, detail-only answer recovery, and the normal Oracle transcript/session
store.

It rejects image generation, Deep Research, and same-invocation
`--browser-follow-up` before dispatch. Use a separate Oracle `--followup` turn
for multi-turn review. Select `--browser-transport cdp` explicitly for legacy
features that still require Oracle's direct browser automation. There is no
automatic OpenCLI-to-CDP fallback.

## Verification surface

The repository tests cover:

- mode-`0600` sealed artifacts and absence of private prompt text in subprocess
  arguments;
- manifest/payload digest verification and mutation rejection;
- explicit new-chat versus stored-conversation targets;
- follow-up baseline markers;
- detail-only reattach with no second model selection or dispatch;
- supported OpenCLI/adapter contract versions;
- strict ChatGPT receipt parsing.

Run the narrow suite with:

```bash
pnpm vitest run \
  tests/browser/opencliTransport.test.ts \
  tests/opencli-adapters/submit-file-core.test.ts
```

For setup and commands, continue to [Browser Mode](browser-mode.md). For the
documentation entrypoint, return to the [Oracle × OpenCLI home](index.md).
