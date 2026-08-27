# Manual Test Suite (Browser Mode + Live API)

These checks validate the real Chrome automation path and the optional live
Responses API smoke suite. Run the browser steps whenever you touch Chrome
automation (lifecycle, cookie sync, prompt injection, Markdown capture, etc.),
and run the live API suite before shipping major transport changes.

## Prerequisites

- macOS with `oracle browser install` completed and Oracle's Chrome for Testing
  profile signed in to ChatGPT Pro.
- Node 24+ and `pnpm install` already completed.
- Headful display access (no `--browser-headless`).
- When debugging, add `--browser-keep-browser` so Chrome stays open after Oracle exits, then connect with `pnpm exec tsx scripts/browser-tools.ts ...` (screenshot, eval, DOM picker, etc.).
- Ensure no Chrome instances are force-terminated mid-run; let Oracle clean up once you’re done capturing state.
- Clipboard checks (`browser-tools.ts eval "navigator.clipboard.readText()"`) trigger a permission dialog in Chrome—approve it for debugging, but remember that we can’t rely on readText in unattended runs.

## Test Cases

### Quick browser port smoke

- `pnpm test:browser` — launches headful Chrome and checks the DevTools endpoint is reachable. Set `ORACLE_BROWSER_PORT` (or `ORACLE_BROWSER_DEBUG_PORT`) to reuse a fixed port when you’ve already opened a firewall rule.

### Dedicated-profile cold-start smoke

Run this before any live prompt test and whenever launcher/profile/CDP ownership
changes:

```bash
oracle browser install
oracle browser setup --use-mock-keychain
oracle browser smoke --json
```

Expect `coldStarts:2`, `transport:"direct-cdp"`, authenticated/ready receipts
for both cycles, and `promptSubmitted:false`. The profile and requested port
must be idle before the test. No debugging consent click and no ChatGPT
conversation should be created. After the next cold start, neither smoke-owned
ChatGPT page may return through Chrome session restore.

For macOS focus-sensitive launcher changes, leave a non-Chrome app frontmost and
sample the frontmost process throughout cold launch, target creation, navigation,
Send, capture, and cleanup. The probe must not activate or restore another app.
Expect no dedicated Chrome PID in the timeline. Confirm the launched command uses
`--no-startup-window`, and that the created page uses `focus:false`.

For owned-target lifecycle changes, run three tiny successful consultations and
then two concurrently. Inventory CDP page targets before and after each batch.
Every terminal run target must disappear while active/recoverable and pre-existing
control tabs survive. Also force a post-capture timing/admission rejection and
confirm it closes the terminal owned target without deleting the saved answer or
stopping a retained shared Chrome process.

### Multi-Model CLI fan-out

Run this whenever you touch the session store, CLI session views, or TUI wiring for multi-model runs.

1. Kick off an API multi-run:
   `pnpm run oracle -- --models "gpt-5.1-pro,grok-4.1" --prompt "Compare the moon & sun."`
   - Expect stdout to print sequential sections, one per model (`[gpt-5.1-pro] …` followed by `[grok-4.1] …`). No interleaved tokens.
2. Capture the session ID from the summary line. Run `oracle session --status --model gpt-5.1-pro`.
   - Table should collapse to sessions that include GPT-5.1 Pro and show status icons (✓/⌛/✖) per model.
3. Inspect detailed logs: `oracle session <id>`
   - The metadata header now includes a `Models:` block with one line per model plus token counts.
   - When prompted, pick `View grok-4.1 log` and confirm only that model’s stream renders. Refresh should keep completed models intact even if others still run.
4. Model filter path: `oracle session <id> --model grok-4.1`
   - Attach mode should error if that model is missing (double-check by filtering for a bogus model), otherwise it should render the prompt + single-model log only.

### Write-output export (API)

Run this when touching session serialization, file IO helpers, or CLI flag plumbing.

1. `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=<real key> pnpm vitest run tests/live/write-output-live.test.ts --runInBand`
   - Expect the test to create a temp `write-output-live.md` file containing `write-output e2e`.
2. Manual spot-check: `oracle --prompt "answer file smoke" --write-output /tmp/out.md --wait`
   - Confirm `/tmp/out.md` exists with the answer text and a trailing newline.
3. Multi-model spot-check: `oracle --models "gpt-5.1-pro,grok-4.1" --prompt "two files" --write-output /tmp/out.md --wait`
   - Confirm `/tmp/out.gpt-5.1-pro.md` and `/tmp/out.grok-4.1.md` exist with distinct content.

### CLI guardrails and perf traces

Run this when touching top-level CLI startup, option parsing, signal handling, or trace output.

1. Missing prompt:
   `pnpm run oracle -- --engine api`
   - Expect help plus a nonzero exit code.
2. Preview conflict:
   `pnpm run oracle -- --dry-run summary --render --prompt "conflict"`
   - Expect a clear conflict error and nonzero exit.
3. Perf trace:
   `pnpm run oracle -- --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary --prompt "trace smoke"`
   - Confirm the JSON contains `cli-module-ready`, `root-command-start`, `first-output`, and `exit`, and prompt/key-like argv values are redacted.

### Lightweight Browser CLI (manual exploration)

Before running any agent-driven debugging, you can rely on the TypeScript CLI in `scripts/browser-tools.ts`:

```bash
# Show help / available commands
pnpm tsx scripts/browser-tools.ts --help

# Launch Chrome with your normal profile so you stay logged in
pnpm tsx scripts/browser-tools.ts start --profile

# Drive the active tab
pnpm tsx scripts/browser-tools.ts nav https://example.com
pnpm tsx scripts/browser-tools.ts eval 'document.title'
pnpm tsx scripts/browser-tools.ts screenshot
pnpm tsx scripts/browser-tools.ts pick "Select checkout button"
pnpm tsx scripts/browser-tools.ts cookies
pnpm tsx scripts/browser-tools.ts inspect   # show DevTools-enabled Chrome PIDs/ports/tabs
pnpm tsx scripts/browser-tools.ts kill --all --force   # tear down straggler DevTools sessions
```

This mirrors Mario Zechner’s “What if you don’t need MCP?” technique and is handy when you just need a few quick interactions without spinning up additional tooling.

Debug note: when you have a live ChatGPT tab open under a DevTools port and need a quick DOM dump of the last assistant turn, run `pnpm tsx scripts/debug/extract-chatgpt-response.ts <port>`.

1. **Prompt Submission & Model Switching**
   - With Chrome signed in and cookie sync enabled, run
     ```bash
     pnpm run oracle -- --engine browser --model gpt-5.5 \
       --prompt "Line 1\nLine 2\nLine 3"
     ```
   - Observe logs for:
     - `Prompt textarea ready (xxx chars queued)` (twice: initial + after model switch).
     - `Model picker: ... Thinking ...` or the current GPT-5.5 picker label.
     - `Clicked send button` (or Enter fallback).
   - In the attached Chrome window, verify the multi-line prompt appears exactly as sent.

2. **Markdown Capture**
   - Prompt:
     ```bash
     pnpm run oracle -- --engine browser --model gpt-5.5 \
       --prompt "Produce a short bullet list with code fencing."
     ```
   - Expected CLI output:
     - `Answer:` section containing bullet list with Markdown preserved (e.g., `- item`, fenced code).
     - Session log (`oracle session <id>`) should show the assistant markdown (confirm via `grep -n '```' ~/.oracle/sessions/<id>/output.log`).

3. **Stop Button Handling**

- Start a long prompt (`"Write a detailed essay about browsers"`) and once ChatGPT responds, manually click “Stop generating” inside Chrome.
- Oracle should detect the assistant message (partial) and still store the markdown.

4. **Override Flag**

- Run with `--browser-allow-cookie-errors` while intentionally breaking bindings.
- Confirm log shows `Cookie sync failed (continuing with override)` and the run proceeds headless/logged-out.
- Remember: the browser composer now pastes only the user prompt (plus any inline file blocks). If you see the default “You are Oracle…” text or other system-prefixed content in the ChatGPT composer, something regressed in `assembleBrowserPrompt` and you should stop and file a bug.
- Heartbeats: Browser runs emit `--heartbeat` status while waiting. Long Thinking/Pro runs should show `[browser] ChatGPT thinking ...` or `[browser] Waiting for ChatGPT response ...`; the log must not include reasoning text from the side panel.

## Post-Run Validation

- `oracle session <id>` should replay the transcript with markdown.
- `~/.oracle/sessions/<id>/meta.json` must include `browser.config` metadata (model label, cookie settings) and `browser.runtime` (PID/port).

Document results (pass/fail, session IDs) in PR descriptions so reviewers can audit real-world behavior.

## Recent Smoke Runs

- 2025-11-18 — API gpt-5.1 (`api-smoke-give-two-words`): returned “blue sky” in 2.5s.
- 2025-11-18 — API gpt-5.1-pro (`api-smoke-pro-three-words`): completed in 3m08s with “Fast API verification”.
- 2025-11-18 — Browser gpt-5.1 Instant (`browser-smoke-instant-two-words`): completed in ~10s; replied with a clarification prompt.
- 2025-11-18 — Browser gpt-5.1-pro (`browser-smoke-pro-three-words`): completed in ~1m33s; response noted “Search tool used.”.
- 2025-11-18 (rerun) — API gpt-5.1 (`api-smoke-give-two-words`): reconfirmed OK; same answer + cost bracket.
- 2025-11-18 (rerun) — Browser gpt-5.1-pro (`browser-smoke-pro-three-words`): reconfirmed OK; included heartbeat progress and search tool note.
- 2025-11-20 — Browser gpt-5.1 via `oracle serve` (remote host on same Mac): fetched https://example.com; title “Example Domain”; first sentence “This domain is for use in documentation examples without needing permission.” (ran via tmux sessions `oracle-serve` and `oracle-client`).

## Browser Regression Checklist (manual)

Run these four smoke tests whenever we touch browser automation:

0. **Isolated transport receipt**
   `oracle browser smoke --json`
   Confirm two cold starts against the same dedicated profile and no submitted prompt before running any answer-producing test.

1. **GPT-5.5 simple prompt**
   `pnpm run oracle -- --engine browser --model gpt-5.5 --prompt "Give me two short markdown bullet points about tables"`
   Expect two markdown bullets, no files/search referenced. Note the session ID (e.g., `give-me-two-short-markdown`).

2. **GPT-5.5 simple prompt**
   `pnpm run oracle -- --engine browser --model gpt-5.5 --prompt "List two reasons Markdown is handy"`
   Confirm the answer arrives (and only once) even if it takes ~2–3 minutes.

2b. **GPT-5.5 Instant smoke**
`pnpm run oracle -- --engine browser --model gpt-5.5-instant --prompt "Give me two short markdown bullet points about tables"`
Expect a near-instant response (no Thinking spinner) and confirm the composer pill shows the "Instant" row, not "Thinking 5.5" or "Pro". Run after any change to the 5.5 picker tokens.

2c. **GPT-5.6 Pro effort through the unified picker**
`pnpm run oracle -- --engine browser --model gpt-5-pro --write-output response.txt --prompt "Say Hi!"`
Confirm the logs report model `GPT-5.6 Sol` followed by `Thinking time: Pro`, the tiny answer populates `response.txt`, and runtime metadata records dispatch-to-answer elapsed time even when it completes in under a minute. Then repeat with a bundle above 256 estimated input tokens and confirm a first stable answer below 60 seconds fails closed with `pro-fast-substantive-response-untrusted`. Exercise both a tab starting on another model and a retained tab where GPT-5.6 Sol is already selected. Never click ChatGPT's "Answer now" shortcut while the Pro response is thinking.

For direct-CDP follow-ups, also run a tiny initial prompt followed by a substantive prompt. Confirm the stored runtime advances `proTurnIndex`, preserves the accepted initial receipt in `proResponseTimingReceipts`, records the follow-up's own token estimate and dispatch, and rejects a sub-60-second substantive follow-up before writing a trusted multi-turn transcript. Every new completed receipt must include its own `promptSha256`, `committedUserTurnIndex`, and literal `commitVerification: "verified"`; the chain must report `proResponseTimingProvenance: "verified"`. Reverse the workloads once to confirm a tiny follow-up is classified by its own receipt rather than the initial prompt's workload. During an in-flight follow-up, confirm the active scalar may be exactly one turn beyond the latest completed receipt without being treated as corruption. For a committed follow-up that times out, reattach once and confirm the validator binds every new-format historical receipt plus the active/latest scalar to its exact DOM user turn. Replace the first receipt's digest with another valid 64-character digest, then separately replace its committed DOM index with another valid non-negative index; both real A/B reattach fixtures must fail closed. Also present valid prompt hashes with reversed `[4,2]` and duplicate `[2,2]` committed DOM indices, and place a committed active scalar one turn beyond the completed chain at or below the last verified historical index; each case must fail closed before DOM prompt acceptance. An uncommitted turn, non-contiguous chain, digest/index mismatch, missing active workload field, or indeterminate timing marker must be terminal rather than recovering an older answer. A legacy identity-less or mixed receipt chain remains readable but must report `legacy-partial` and must never be described as fully reverified.

3. **GPT-5.5 + attachment**
   Prepare `/tmp/browser-md.txt` with a short note, then run
   `pnpm run oracle -- --engine browser --model gpt-5.5 --prompt "Summarize the key idea from the attached note" --file /tmp/browser-md.txt`
   Ensure upload logs show “Attachment queued” and the answer references the file contents explicitly.

4. **GPT-5.5 + attachment (verbose)**
   Prepare `/tmp/browser-report.txt` with faux metrics, then run
   `pnpm run oracle -- --engine browser --model gpt-5.5 --prompt "Use the attachment to report current CPU and memory figures" --file /tmp/browser-report.txt --verbose`
   Verify verbose logs show attachment upload and the final answer matches the file data.

5. **Deep Research smoke**
   `pnpm run oracle -- --engine browser --browser-manual-login --browser-research deep --prompt "Research one current public source about WebGPU browser support and cite it"`
   Confirm the logs show Deep Research activation/progress and the final report includes citations or source links. Do not use connected apps or private data.

6. **Multi-turn browser consult smoke**
   `pnpm run oracle -- --engine browser --model gpt-5-pro --browser-thinking-time pro --prompt "Give one architectural recommendation for a tiny CLI cache." --browser-follow-up "Challenge your previous recommendation with one concrete failure mode." --browser-follow-up "Now return the final recommendation in one sentence, starting with CHECK_MULTI_TURN_OK."`
   Confirm the output contains all captured turns, includes `CHECK_MULTI_TURN_OK`, and the saved `transcript.md` records both follow-up prompts.

7. **Multi-turn value check**
   Run the same initial prompt once without follow-ups and once with the challenge/final-decision follow-ups above. In the PR notes, record concrete differences such as extra failure modes, sharper rollback steps, or test cases. Do not claim a fixed quality percentage.

Record session IDs and outcomes in the PR description (pass/fail, notable delays). This ensures reviewers can audit real runs.

### Remote Chrome smoke test (CDP)

Run this whenever you touch CDP connection logic (remote chrome lifecycle, attachment transfer) or before executing remote sessions in CI.

1. Launch a throwaway Chrome instance with remote debugging enabled (adjust the path per OS):
   ```bash
   REMOTE_PROFILE=/tmp/oracle-remote-test-profile
   rm -rf "$REMOTE_PROFILE"
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new \
     --disable-gpu \
     --remote-debugging-port=9333 \
     --remote-allow-origins=* \
     --user-data-dir="$REMOTE_PROFILE" \
     >/tmp/oracle-remote-chrome.log 2>&1 &
   export REMOTE_CHROME_PID=$!
   sleep 3
   ```
2. Run the helper to verify CDP connectivity:
   ```bash
   pnpm tsx scripts/test-remote-chrome.ts localhost 9333
   ```
   Expect ✓ logs for connection, protocol info, navigation to https://chatgpt.com/, and the final “POC successful!” line.
3. Tear down the temporary browser:
   ```bash
   kill "$REMOTE_CHROME_PID"
   rm -rf "$REMOTE_PROFILE"
   ```
   Use `pkill -f oracle-remote-test-profile` if Chrome refuses to exit cleanly.

Capture the pass/fail result (include the helper’s log snippet) in your PR description alongside other manual browser tests.

### Attach-running smoke test

Run this whenever you touch the local attach path (`--browser-attach-running`) or the direct browser websocket bootstrap.

1. Start or reuse a local signed-in Chrome with DevTools access available. If you want an explicit local endpoint, launch Chrome with `--remote-debugging-port=9222`.
2. Run Oracle against the running browser:
   ```bash
   pnpm run oracle -- --engine browser \
     --browser-attach-running \
     --model gpt-5.5 \
     --prompt "Give me two short markdown bullets about browser tabs"
   ```
   If the browser’s remote-debugging UI shows a different local port, rerun with `--remote-chrome <host:port>` in addition to `--browser-attach-running`.
3. Verify Oracle opens a fresh tab in the existing browser, returns the answer, and closes only that Oracle-owned tab afterward.
4. Reattach sanity check: repeat with a very short timeout if needed, then run `oracle session <id>` and confirm Oracle can reconnect to the saved tab/conversation.

## Chrome DevTools / MCP Debugging

Use this when you need to inspect the live ChatGPT composer (DOM state, markdown text, screenshots, etc.). For smaller ad‑hoc pokes, you can often rely on `pnpm tsx scripts/browser-tools.ts …` instead.

1. **Launch within tmux**

   ```bash
   tmux new -d -s oracle-browser \\
     "pnpm run oracle -- --engine browser --browser-keep-browser \\
      --model gpt-5.5 --browser-thinking-time pro --prompt 'Debug via DevTools.'"
   ```

   Keeping the run in tmux prevents your shell from blocking and ensures Chrome stays open afterward.

2. **Grab the DevTools port**
   - `tmux capture-pane -pt oracle-browser` to read the logs (`Launched Chrome … on port 56663`).
   - Verify the endpoint:
     ```bash
     curl http://127.0.0.1:<PORT>/json/version
     ```
     Note the `webSocketDebuggerUrl` for reference.

3. **Attach Chrome DevTools MCP**
   - One-off: `CHROME_DEVTOOLS_URL=http://127.0.0.1:<PORT> npx -y chrome-devtools-mcp@latest`
   - `mcporter` config snippet:
     ```json
     {
       "chrome-devtools": {
         "command": "npx",
         "args": ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:<PORT>"]
       }
     }
     ```
   - Once the server prints `chrome-devtools-mcp exposes…`, you can list/call tools via `mcporter`.
   - Oracle’s attach-running mode no longer depends on MCP at runtime; `mcporter` remains useful here for manual inspection only.

4. **Interact & capture**
   - Use MCP tools (`click`, `evaluate_js`, `screenshot`, etc.) to debug the composer contents.
   - Record any manual actions you take (e.g., “fired evaluate_js to dump #prompt-textarea.innerText”).

5. **Cleanup**
   - `tmux kill-session -t oracle-browser`
   - `pkill -f oracle-browser-<slug>` if Chrome is still running.

> **Tip:** Running `npx chrome-devtools-mcp@latest --help` lists additional switches (custom Chrome binary, headless, viewport, etc.).

## Responses API Live Smoke Tests

These Vitest cases hit the real OpenAI API to exercise both transports:

1. Export a real key and explicitly opt in (default runs stay fast):
   ```bash
   export OPENAI_API_KEY=sk-...
   export ORACLE_LIVE_TEST=1
   pnpm vitest run tests/live/openai-live.test.ts
   ```
2. The first two tests target the standard GPT-5 (`gpt-5.1` / `gpt-5.2`) foreground
   streaming paths. The later background tests send `gpt-5.5-pro` and GPT-5.6 Sol
   with Pro mode and max reasoning effort prompts and expect the CLI to stay in
   background mode until OpenAI finishes (up to 30 minutes).
3. Watch the console for `Reconnected to OpenAI background response...` if
   you're debugging transport flakiness; the test will fail if the response
   status isn't `completed` or if the text doesn't contain the hard-coded
   smoke strings.

Skip these unless you're intentionally validating the production API; they are
fully gated behind `ORACLE_LIVE_TEST=1` to avoid accidental CI runs.
