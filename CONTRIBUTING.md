# Contributing

Oracle is currently a source-only fork. Keep changes inside its existing CLI,
MCP, dedicated-Chrome, exact-session recovery, explicit alternate transport,
and Batch Oracle contracts. A contribution must not silently add package,
release, signing, domain, account, or deployment authority.

Oracle v2 is being built beside the current direct-CDP implementation. Follow
[the v2 master plan](docs/oracle-v2-master-plan.md) and its explicit gate
boundaries. Do not grow or broadly refactor `src/browser/**` for v2 features,
import legacy browser code into `packages/*` or `apps/*`, or put ChatGPT
page-reading/automation knowledge outside `packages/chatgpt-adapter`. The
sanitized provider fixture may define simulated markup and scenarios only; do
not put a second adapter or production selector policy there.

## Protect private data

Issues and pull requests are public. Never upload, attach, paste, or commit:

- `.oracle/` or an `ORACLE_HOME_DIR` tree;
- cookies, browser profiles, browser storage, or keychain material;
- session dumps, raw logs, prompts, responses, or attachments;
- account identifiers, email addresses, tokens, API keys, or credentials;
- conversation IDs or URLs, signed download URLs, or private project URLs.

Use synthetic fixtures and redact screenshots. For a security issue, stop and
follow [SECURITY.md](SECURITY.md) instead of opening a public report.

## Work from source

Follow [docs/install.md](docs/install.md). The upstream npm and Homebrew
channels do not install this fork. Do not add an upstream package command to an
issue, example, test fixture, or generated document.

Before sending a pull request:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm docs:check
pnpm test:packed-cli
pnpm public:check
```

Run only live browser or account-side checks you personally authorize. A live
test must use a dedicated profile and must not expose its profile, session,
prompt, attachment, account, or conversation data in the pull request.

## Upstream changes

Do not merge upstream changes blindly. Update
[docs/upstream-parity.md](docs/upstream-parity.md) with the exact upstream
commit checked through and classify every unabsorbed commit as adopted,
independently implemented, not applicable, or pending. Independently
implemented claims need links to current local code and tests.

## License and attribution

The upstream MIT license and attribution in [LICENSE](LICENSE) must remain
intact. Do not replace upstream authorship with fork authorship. New
contributions are accepted under the repository's existing license unless a
separately identified third-party file says otherwise.
