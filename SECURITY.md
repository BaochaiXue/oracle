# Security policy

## Report privately

Do not open a public issue for a suspected vulnerability. Use this repository's
[private vulnerability reporting form](https://github.com/IndelibleVivi/oracle/security/advisories/new)
so maintainers can investigate without exposing account, browser, or session
material. If that form is unavailable, open a redacted issue that contains no
technical exploit details and asks a maintainer to establish a private channel.

Report the smallest redacted description that establishes the affected source
revision, operating system, security boundary, expected behavior, and observed
behavior. Remove secrets and personal data from logs and screenshots before
sharing them.

Never upload or paste any of the following:

- `.oracle/` or an `ORACLE_HOME_DIR` tree;
- cookies, browser profiles, keychain material, or browser storage;
- session dumps, raw logs, prompts, responses, or attached files;
- account identifiers, email addresses, bearer tokens, API keys, or credentials;
- ChatGPT conversation IDs or URLs, signed download URLs, or private project URLs.

Use synthetic data in a minimal reproducer. If the vulnerability cannot be
explained without sensitive evidence, say what evidence exists and wait for a
maintainer to define an approved private transfer boundary.

## Security boundaries worth reporting

Examples include remote-service authentication bypass, non-loopback exposure
without explicit opt-in, request-size bypass, cross-session or cross-target
ownership violations, credential or prompt disclosure, unauthorized duplicate
submission, unsafe artifact extraction, and command execution outside the
documented host-owned boundary.

The project is an unofficial source fork and is not affiliated with, endorsed
by, or authorized by OpenAI. Changes to ChatGPT UI, account policy, or platform
terms are not by themselves vulnerabilities in this repository. Do not include
private account evidence when reporting UI drift.

## Supported source line

Security fixes target the current `main` source line. A commit, passing test,
or built artifact is not proof that a global install, browser profile, remote
host, or deployed site has been updated.
