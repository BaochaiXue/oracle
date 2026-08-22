# Windows browser cookies

Oracle reads Chrome cookies via `@steipete/sweet-cookie` (uses `node:sqlite` + PowerShell DPAPI on Windows).

Notes:

- ChatGPT cookies may be app-bound (`v20`) and can still fail to decrypt depending on the machine/account.
- Default recommendation on Windows remains `--browser-manual-login` (persistent profile) or inline cookies.
