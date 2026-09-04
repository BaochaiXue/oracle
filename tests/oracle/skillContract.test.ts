import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Whitespace is normalized so Markdown reflow (line wraps, list indentation)
// cannot break a lexical assertion; only the words are locked. Every expected
// string below is therefore written on one line with single spaces.
async function readSkill(): Promise<string> {
  const raw = await readFile(path.join(process.cwd(), "skills/oracle/SKILL.md"), "utf8");
  return raw.replace(/\r\n/g, "\n").replace(/\s+/g, " ");
}

describe("canonical Oracle skill contract", () => {
  test("advertises evidence-based debate in one same-task conversation", async () => {
    const skill = await readSkill();

    expect(skill).toContain("Challenge wrong or over-defensive answers");
    expect(skill).toContain("one same-task ChatGPT conversation until evidence-based consensus");
  });

  test("pins the GPT-5.6 Pro direct-CDP browser lane without provider fallback", async () => {
    const skill = await readSkill();

    expect(skill).toContain("--engine browser --browser-transport cdp --model gpt-5-pro");
    expect(skill).toContain("--browser-thinking-time pro");
    expect(skill).toContain("Oracle never dispatches or falls back to Gemini");
    expect(skill).toContain("fail closed; do not substitute another model");
    expect(skill).not.toMatch(/oracle[^\n]*--model\s+gemini/i);
  });

  test("mandates the GitHub connector directive for published repositories", async () => {
    const skill = await readSkill();

    expect(skill).toContain("## GitHub repository context (mandatory)");
    expect(skill).toContain(
      "Use the connected GitHub app/connector to inspect the exact repository",
    );
    expect(skill).toContain("`OWNER/REPOSITORY`");
    // The identity comes from Git metadata, never from the local folder name,
    // and the raw remote URL (which may carry a token) is never printed.
    expect(skill).toContain("never by the local folder");
    expect(skill).toContain(
      "This repository identity comes from Git metadata, not the local directory name.",
    );
    expect(skill).not.toContain("git -C <repo> remote -v");
    expect(skill).toContain("emits owner/repo only");
    expect(skill).toContain("The only exemption is a project with no GitHub remote at all.");
    // Branch and commit travel with the slug; the connector otherwise reads the default branch.
    expect(skill).toContain("`OWNER/REPOSITORY` on branch `BRANCH` at commit `COMMIT`");
    expect(skill).toContain("git -C <repo> rev-parse --abbrev-ref HEAD");
    expect(skill).toContain("Read that branch, not the default branch, wherever they differ.");
    expect(skill).toContain(
      "Never place a raw remote URL, embedded credentials, access token, or private",
    );
  });

  test("states detach semantics honestly so host timeouts are read correctly", async () => {
    const skill = await readSkill();

    expect(skill).toContain("## Long runs and host timeouts");
    expect(skill).toContain("requests a detached worker");
    expect(skill).toContain("`lifecycle.detached` in the session's `meta.json` must be `true`");
    expect(skill).toContain("Non-Pro aliases do not detach either.");
    expect(skill).toContain("oracle status --hours 72");
    // Recovery reads the artifact, not a CLI flag that the root parser shadows.
    expect(skill).toContain("~/.oracle/sessions/<id>/artifacts/transcript.md");
    expect(skill).toContain("Do not use `oracle session <id> --path`");
    expect(skill).toContain("ORACLE_NO_DETACH=1");
    expect(skill).toContain("reloading Claude Code has been observed to kill the worker");
    expect(skill).toContain("Run `oracle session <id> --live`");
    // gpt-5-pro selects the Sol row and drives the Pro effort tier.
    expect(skill).toContain("There is no separate `Pro` model row to select.");
    expect(skill).not.toContain("`gpt-5-pro` selects ChatGPT's `Pro` target");
  });

  test("supports only GPT-5.6 Sol Pro and never issues a GPT-5.5 alias", async () => {
    const skill = await readSkill();

    expect(skill).toContain("This skill supports exactly one target: GPT-5.6 Sol Pro.");
    expect(skill).toContain("GPT-5.5 and GPT-5.5 Pro are no longer supported here");
    expect(skill).not.toMatch(/--model\s+"?gpt-5\.5/i);
    expect(skill).toContain(
      "base aliases leave ChatGPT's current tier untouched, while the Pro alias `gpt-5-pro` defaults the tier to Pro",
    );
    expect(skill).toContain("--browser-bundle-format auto|text|zip");
    expect(skill).toContain("## API preflight (operator-only CLI reference)");
  });

  test("lets the agent argue with the model and prefers one continued conversation", async () => {
    const skill = await readSkill();

    expect(skill).toContain("## Arguing with the model");
    expect(skill).toContain("Never accept an answer on trust.");
    expect(skill).toContain("A rebuttal is evidence, not opinion.");
    expect(skill).toContain("Continue the exchange until consensus");
    expect(skill).toContain("### Stay in one conversation");
    expect(skill).toContain("oracle --followup <session-id-or-slug>");
    expect(skill).toContain("An Oracle _session_ is not a ChatGPT _conversation_.");
    expect(skill).toContain("Before creating any root session");
    expect(skill).toContain("running or recoverable, reattach and wait");
    expect(skill).toContain("follow up from the latest child");
    expect(skill).toContain("context compaction, or process restart is not a new investigation");
    expect(skill).toContain("Treat `-r2`, `-r3`, `-round2`, `-followup`, `-rebuttal`");
    expect(skill).toContain("a proposed command without `--followup` must");
    expect(skill).toContain("stop before Send and be rewritten against the latest child");
    expect(skill).toContain("Updating the file on disk cannot rewrite an");
    expect(skill).toContain("already-running agent's context");
    expect(skill).toContain("confirm that the child's conversation id equals the parent's");
    expect(skill).toContain("At the first Oracle action of every agent turn, reload the");
    expect(skill).toContain("Open a new conversation only when the current one cannot continue");
    expect(skill).toContain(
      "Preference for another phrasing, a fresh start, or a cleaner transcript is not a reason.",
    );
    expect(skill).not.toContain(
      "Oracle runs are one-shot; the model does not remember prior runs.",
    );
  });

  test("tells the agent to show GPT-5.6 Pro visual evidence and names the media traps", async () => {
    const skill = await readSkill();

    expect(skill).toContain("GPT-5.6 Pro is multimodal");
    expect(skill).toContain("## Showing the model visual evidence");
    // Media routing matches src/browser/prompt.ts MEDIA_EXTENSIONS, including .heif.
    expect(skill).toContain("`.heic`, `.heif`");
    expect(skill).toContain("- Video: `.mp4`, `.mov`, `.webm`, `.mkv`, `.m4v`, `.avi`");
    expect(skill).toContain("never inlines it, and uploads the raw bytes");
    // Interpretation is not guaranteed; PDF figures must be rendered to PNG.
    expect(skill).toContain("Oracle guarantees only the upload");
    // Raw uploads are uncapped by default (tests/browser/prompt.test.ts locks this).
    expect(skill).toContain(
      "Raw media and archive uploads are uncapped unless a limit is set explicitly",
    );
    // ZIP swallows media; only the text bundle keeps images as separate uploads.
    expect(skill).toContain("pass `--browser-bundle-files` with");
    expect(skill).toContain("`--browser-bundle-format text`");
    expect(skill).toContain("both pack the images into the archive");
    expect(skill).toContain("at most 10 attachments");
    // .gitignore applies to literals only in mixed expansion.
    expect(skill).toContain("`.gitignore` never drops a file you named literally.");
    expect(skill).toContain("an explicit `!` exclusion still wins over a literal");
    expect(skill).toContain("--dry-run summary --files-report");
  });

  test("forbids process-level action against the shared Chrome while others consult", async () => {
    const skill = await readSkill();

    expect(skill).toContain("## Sharing one Chrome across agents");
    expect(skill).toContain("Never `kill`, `pkill`, or signal the Chrome process");
    expect(skill).toContain(
      "Never run `smoke` or `setup` while any consultation is active or recoverable.",
    );
    expect(skill).toContain("`smoke` is a first-install validator, not a repair tool");
    expect(skill).toContain('browser.browserLifetime: "persistent"');
    // Setup is the one browser without a CDP endpoint; the human closes it whole.
    expect(skill).toContain("it exposes no CDP endpoint");
    expect(skill).not.toContain("close only the exact setup tab through its verified CDP target");
    // The three multi-agent invariants.
    expect(skill).toContain("**No preemption.**");
    expect(skill).toContain("**No deadlock.**");
    expect(skill).toContain("**No lost tracking.**");
    expect(skill).toContain("Never pass `--browser-tab <ref>` to reuse an existing ChatGPT tab");
    expect(skill).toContain("do not kill the pid named in the message");
    expect(skill).toContain("`--followup <latest own child>`");
  });
});
