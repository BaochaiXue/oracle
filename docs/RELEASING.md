---
title: Source publication
description: "Fork-owned gates for publishing Oracle source without package, signing, or release authority."
---

# Source publication contract

This fork is distributed from its source repository only. It has no npm,
Homebrew, binary-release, signing, notarization, or domain-publishing pipeline.
The package remains named `@steipete/oracle` for source compatibility and is
marked private so it cannot be published accidentally.

## Source launch gate

Before making a source revision public:

1. Confirm the intended commit contains no credentials, browser state, prompts,
   attachments, account identifiers, conversation URLs, session dumps, or
   machine-private paths.
2. Run the repository acceptance suite:

   ```bash
   pnpm check
   pnpm test
   pnpm build
   pnpm docs:check
   pnpm test:packed-cli
   pnpm public:check
   ```

3. Inspect the generated docs and packed CLI locally. A passing build proves a
   source candidate; it does not prove installation, activation, a live browser
   account, or platform authorization.
4. Inspect the exact staged diff and verify that `LICENSE` still preserves the
   upstream MIT license and attribution.
5. Publish only the reviewed source commit to the fork-owned repository.

## No inherited authority

Do not recreate or invoke upstream package, tap, release, domain, signing, or
notarization workflows from this repository. No contributor should supply a
personal signing identity or private key in an issue, pull request, fixture,
log, or tracked configuration.

If this fork later needs packaged distribution, the owner must first approve a
new fork-owned package name, signing identity, credentials boundary, release
workflow, rollback procedure, and public documentation. That future decision
is outside the current source-only contract.
