# Windows compatibility notes

Keep this in sync as we learn more. Read this before doing browser runs on Windows.

- Browser engine is enabled on Windows now, but automation is flakier than macOS. If it fails, rerun with `--engine api --wait` or use `--remote-chrome` to point at a logged-in Chrome with remote debugging.
- Cookies: canonical direct CDP uses Oracle's persistent isolated profile on Windows too, so personal-cookie sync stays disabled. Inline cookies remain available only as an explicit compatibility path (`--browser-inline-cookies(-file)` / `ORACLE_BROWSER_COOKIES_JSON`).
- First sign-in: run `oracle browser install`, then `oracle browser setup`, sign
  into ChatGPT in Chrome for Testing, close the entire browser, and run
  `oracle browser smoke`. Setup has no CDP endpoint and sends no prompt; the
  smoke owns the profile for two cold-start attachments. The profile defaults
  to `~/.oracle/browser-profile` and can be overridden with
  `ORACLE_BROWSER_PROFILE_DIR` or `browser.manualLoginProfileDir` in
  `~/.oracle/config.json`.
- Cookie paths: preferred path is `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<Profile>\\Network\\Cookies`. If that errors, try the top-level `Cookies` file or supply the exact path via `--browser-cookie-path`.
- mcporter chrome-devtools: requires a valid `CHROME_DEVTOOLS_URL` from a live session; otherwise calls will fail.
- The agent-scripts `runner` helper is bash-based and may fail under PowerShell/CMD; run commands directly if it misbehaves.
