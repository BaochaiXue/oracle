# Oracle Fork Agent Instructions

This file is the repository-local operating contract for agents working on
`IndelibleVivi/oracle`. Read `README.md` and the relevant focused document under
`docs/` before changing behavior. Global collaboration style lives outside this
repository; keep this file specific to Oracle's engineering and release truth.

## Fork Identity And Current Product Contract

This fork provides a recoverable browser path from coding agents to ChatGPT
GPT-5.6 Pro through an Oracle-owned Chrome for Testing installation, an isolated
persistent profile, and loopback CDP. OpenCLI Browser Bridge is an explicit
alternative/recovery transport. It is not the automatic fallback for direct CDP.

Keep the naming layers distinct:

| Layer                                     | Canonical name |
| ----------------------------------------- | -------------- |
| Human-facing browser product              | `GPT-5.6 Pro`  |
| Moving Oracle browser alias               | `gpt-5-pro`    |
| ChatGPT model selected in the UI          | `GPT-5.6 Sol`  |
| ChatGPT reasoning tier selected in the UI | `Pro`          |

The picker receipt proves the visible selection Oracle requested. It does not
prove hidden server-side routing. Timing and workload receipts are separate
admission evidence.

The published npm/Homebrew packages under upstream ownership do not contain this
fork's current dedicated-browser contract. The maintained installation path for
this fork is source installation from this repository unless a separately
reviewed fork-owned distribution is introduced.

## Authority Map

- `README.md`: present product identity, install/setup, supported transports,
  current capability matrix, ordinary user commands, and major trust limits.
- `docs/dedicated-chrome.md`: dedicated browser lifecycle and trust boundary.
- `docs/opencli-transport.md`: OpenCLI alternative transport.
- `docs/browser-mode.md`: broader browser modes and legacy/explicit paths.
- `docs/manual-tests.md`: manual smoke inventory; use only the items relevant to
  the changed surface.
- source and tests: executable truth. When docs disagree with current source,
  inspect the implementation and repair both in the same scoped change.
- private Faye/Cove handoffs: external local continuity only. Do not create or
  commit private session handoffs in this repository.

## Browser Safety Boundaries

- The canonical unattended browser is the Oracle-installed Chrome for Testing
  app with a separate application identity and a persistent Oracle-only profile.
- Bind CDP only to loopback. Do not expose the debugging endpoint on a LAN,
  tunnel, public interface, or caller-controlled host.
- Never launch `/Applications/Google Chrome.app` with automation, headless,
  remote-debugging, or temporary user-data flags for Oracle QA. Stable personal
  Chrome can claim the ordinary `com.google.Chrome` application identity and
  interfere with normal launches.
- Never point Oracle at the default personal Chrome data directory. A canonical
  macOS direct-CDP run must fail closed when the resolved executable is everyday
  `Google Chrome.app`.
- `oracle browser setup` is the human sign-in surface. It must remain visible,
  use the dedicated profile, and open no CDP endpoint.
- `oracle browser smoke` is the steady-state proof for the exact browser/profile
  configuration. Passing with one profile does not authorize a different path.
- Mock-keychain mode is explicit. Preserve its documented weaker at-rest cookie
  protection and do not silently switch an existing profile between keychain
  modes.
- Do not enable browser sync or copy personal extensions, cookies, or browsing
  state into the Oracle profile.
- Oracle owns and closes only its leased target. Never sweep unrelated tabs by
  URL or terminate an unrelated browser process.

## Transport And Dispatch Invariants

- Direct CDP and OpenCLI are separately selected transports. Never switch after
  dispatch and never resubmit a turn through another transport while diagnosing
  one session.
- Oracle owns prompt/file bundling, durable session state, dispatch receipts,
  conversation identity, captured answer, artifacts, and follow-up lineage
  across supported transports.
- A connection loss after a committed user turn enters recovery/reattach. It
  does not grant permission to click Send again or create a duplicate session.
- Before accepting a recovered answer, bind it to the stored conversation and
  the verified committed user turn. Preserve normalized prompt identity and
  turn lineage.
- In a multi-turn direct-CDP session, begin, dispatch, complete, and admit each
  accepted turn independently. Never fill a current follow-up's missing workload
  fields from the initial turn or a previous follow-up.
- Missing or partial current-turn workload is unknown. Apply the documented
  fail-closed compatibility behavior; do not classify unknown work as tiny.
- Preserve legacy receipt compatibility exactly as documented. A migration or
  stricter rule for old sessions requires explicit design and regression tests.
- ChatGPT request-frequency gates that occur before commit must remain
  retry-safe and must not trigger automatic resubmission.
- Never click or auto-click ChatGPT's `Answer now` control during Pro thinking.
  It changes the requested reasoning behavior.

## Pro Timing And Workload Receipts

- Timing admission is transport-independent and uses the actual submitted turn.
- Record dispatch time only when the prompt is genuinely dispatched.
- Record elapsed time from that dispatch to the first stable accepted capture.
- Estimate input tokens from the actual submitted prompt and attachment bytes
  from the actual selected files before dispatch.
- Tiny-workload thresholds and the substantive-workload timing guard are product
  contracts. Change them only with an explicit rationale, compatibility analysis,
  tests for initial and follow-up turns, and matching README updates.
- A later tiny follow-up must not retroactively admit an earlier rejected
  substantive turn. An earlier substantive turn must not force a later tiny turn
  through the substantive guard.
- Publish runtime hints only from the active/latest accepted turn receipt. Do
  not overwrite browser-provided current workload with initial-prompt scalars.
- Store content-safe evidence. Do not put prompt bodies, attachment contents,
  cookies, credentials, or raw private page data in timing logs.

## Concurrency And Recovery

- Preserve separate profile/startup and composer-mutation coordination. Parallel
  agents must not submit through the same target or race one profile startup.
- Keep target identity, ownership, dispatch state, and recoverability durable
  enough for `oracle status`, `oracle session <id> --render`, and follow-up
  lineage.
- A completed run cleans up its owned target according to policy. An incomplete
  recoverable run retains the required target/session evidence.
- Silence from a healthy Pro run is not a failure. Reuse the recorded session
  and waiter; do not launch duplicates merely because no new output appeared.
- OpenCLI owns its own window/tab mechanics. Oracle still owns the sealed
  payload, journal, session receipt, answer, and waiter-only recovery.

## Source And Configuration Discipline

- Treat CLI flags, config keys, environment variables, model aliases, session
  metadata, receipt schemas, and adapter payloads as compatibility surfaces.
- Keep defaults and examples aligned across source, schema/validation, README,
  focused docs, and tests.
- Do not hard-code personal project URLs, account email mappings, local developer
  paths, signing-key paths, credential locations, or maintainer-only release
  practices in tracked instructions.
- Never print or commit API keys, ChatGPT cookies, browser profile data, OAuth
  material, session prompt bodies, private attachments, or account data.
- Session data under `~/.oracle` is user state. Tests must use isolated temporary
  roots or explicit fixtures; never delete the user's real session tree as a
  test reset.
- Keep the dedicated browser profile owner-only where the platform supports it.

## Implementation Behavior

- Diagnose the active path before adding a compatibility branch. Prefer one
  canonical implementation per behavior and remove superseded callers, flags,
  tests, and docs in the same change when replacement is complete.
- Retain an alternate path only for an evidenced current caller, a documented
  version boundary, staged rollout, or operational rollback mechanism. Record
  its owner and retirement condition.
- Do not weaken fail-closed dispatch, identity, timing, browser-path, or recovery
  checks merely to make a smoke pass.
- Keep capture stable and Markdown-preserving. When output appears flattened,
  echoed, or bound to the wrong turn, inspect the actual assistant turn and
  session evidence before changing parsing heuristics.
- Do not cargo-cult HTTP/browser controls into stdio or API paths where the
  transport does not expose that boundary.

## Verification

Use the narrowest meaningful suite for the changed blast radius. The repository
currently exposes these canonical scripts:

```bash
pnpm run build
pnpm run typecheck
pnpm run check
pnpm test
pnpm run docs:check
pnpm run test:mcp
pnpm run test:browser
pnpm run test:packed-cli
```

Guidance:

- Run focused Vitest files while iterating, then the relevant aggregate gate.
- A docs-only edit normally needs `pnpm run docs:check` and formatting/link
  checks, not a live browser consultation.
- Browser/live tests can affect the account, profile, network, and Pro quota.
  They are opt-in and require explicit task relevance plus the exact safe profile.
- Never claim Docker, browser, live-account, cross-platform, signing, packaging,
  or publish evidence that was not actually run.
- For a browser regression, cover cold start, existing dedicated process,
  concurrency where relevant, committed/uncommitted dispatch, reattach without
  resubmission, and owned-target cleanup.
- For timing/recovery changes, include tiny initial → substantive follow-up,
  substantive initial → tiny follow-up, two follow-ups, partial/legacy receipt,
  and fallback/reattach cases where applicable.

## Documentation Closure

Before finalizing a meaningful change, perform a bounded documentation-impact
pass:

- update `README.md` for supported user behavior, setup, default, capability,
  privacy, or limitation changes;
- update this file for canonical path, authority, safety gate, verification, or
  agent-workflow changes;
- update the focused transport/lifecycle document for detailed architecture or
  operational changes;
- update changelog/release material only when behavior is actually shipped;
- keep exact branch, candidate, and live state out of the README unless it is a
  durable support contract.

Do not treat a private handoff as the only record of a user-facing or agent-facing
change. Use repo-relative links and public-safe placeholders in tracked docs.

## Git And Release Boundaries

- Before committing, inspect `git status --short`, the staged diff, and
  `git diff --cached --check`.
- Keep docs, focused fixes, and broad refactors in reviewable commits; do not mix
  unrelated behavior into a documentation reconciliation.
- Do not publish npm/Homebrew artifacts, tag a release, notarize/sign an app,
  change repository metadata, or alter upstream release channels without
  explicit authorization for that exact external action.
- Never request or handle OTPs, signing keys, or release credentials through
  repository instructions. Follow the current authorized secret-handling flow
  at execution time.
- A source commit, a passing suite, a packed artifact, and a published release
  are distinct facts. Report the exact state reached.
