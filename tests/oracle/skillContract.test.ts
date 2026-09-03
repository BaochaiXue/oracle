import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

async function readSkill(): Promise<string> {
  return (await readFile(path.join(process.cwd(), "skills/oracle/SKILL.md"), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
}

describe("canonical Oracle skill contract", () => {
  test("pins the GPT-5.6 Pro direct-CDP browser lane without provider fallback", async () => {
    const skill = await readSkill();

    expect(skill).toContain("--engine browser --browser-transport cdp --model gpt-5-pro");
    expect(skill).toContain("--browser-thinking-time pro");
    expect(skill).toContain("Oracle never dispatches or\nfalls back to Gemini");
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
    // The identity must come from Git metadata, never from the local folder name.
    expect(skill).toContain("git -C <repo> remote -v");
    expect(skill).toMatch(/never by the local folder/i);
    expect(skill).toContain("This repository identity comes from Git metadata, not the\nlocal directory name.");
    // The only exemption is a project with no GitHub remote.
    expect(skill).toContain("The only exemption is a project with no GitHub remote at all.");
    // Secrets must never travel in the slug.
    expect(skill).toContain("Never place a raw remote URL, embedded credentials, access token, or private");
  });

  test("states that only Pro-tier aliases detach, so host timeouts are not failures", async () => {
    const skill = await readSkill();

    expect(skill).toContain("## Long runs and host timeouts");
    expect(skill).toContain("starts in a detached worker");
    expect(skill).toContain("Non-Pro aliases do not detach either.");
    expect(skill).toContain("oracle status --hours 72");
    // gpt-5-pro selects the Sol row and drives the Pro effort tier; there is no
    // separate Pro model row to select.
    expect(skill).toContain("There is no\n  separate `Pro` model row to select.");
    expect(skill).not.toContain("`gpt-5-pro` selects ChatGPT's `Pro` target");
    // Detachment switches must be named so an agent does not disable them.
    expect(skill).toContain("ORACLE_NO_DETACH=1");
    expect(skill).toContain("oracle session <id> --path");
  });

  test("supports only GPT-5.6 Sol Pro and never issues a GPT-5.5 alias", async () => {
    const skill = await readSkill();

    expect(skill).toContain("This skill supports exactly one target: GPT-5.6 Sol Pro.");
    expect(skill).toMatch(/GPT-5\.5 and GPT-5\.5\nPro are no longer supported here/);
    // No command line in the skill may select a GPT-5.5 model.
    expect(skill).not.toMatch(/--model\s+"?gpt-5\.5/i);
    // Base Sol does not run at Extra High unless the effort flag asks for it.
    expect(skill).toContain("Without a\n`--browser-thinking-time` value Oracle leaves ChatGPT's default tier untouched.");
    // Bundle format choices must match the CLI (auto|text|zip).
    expect(skill).toContain("--browser-bundle-format auto|text|zip");
  });

  test("lets the agent argue with the model and prefers one continued conversation", async () => {
    const skill = await readSkill();

    expect(skill).toContain("## Arguing with the model");
    expect(skill).toContain("Never accept an answer on trust.");
    expect(skill).toContain("A rebuttal is evidence, not opinion.");
    expect(skill).toContain("Continue the exchange until consensus");
    // Same-conversation continuation is the default; a new one needs a concrete blocker.
    expect(skill).toContain("### Stay in one conversation");
    expect(skill).toContain("oracle --followup <session-id-or-slug>");
    expect(skill).toContain("Open a new conversation only when the current one cannot continue");
    expect(skill).toMatch(/Preference for\nanother phrasing, a fresh start, or a cleaner transcript is not a reason\./);
    expect(skill).not.toContain("Oracle runs are\none-shot; the model does not remember prior runs.");
  });

  test("tells the agent to show GPT-5.6 Pro visual evidence and names the media traps", async () => {
    const skill = await readSkill();

    expect(skill).toContain("GPT-5.6 Pro is multimodal");
    expect(skill).toContain("## Showing the model visual evidence");
    // Media routing matches src/browser/prompt.ts MEDIA_EXTENSIONS.
    expect(skill).toContain("- Video: `.mp4`, `.mov`, `.webm`, `.mkv`, `.m4v`, `.avi`");
    expect(skill).toContain("never inlines it, and uploads the raw bytes");
    // The three constraints that silently break media attachments.
    expect(skill).toContain("The 1 MB default file cap applies to uploads too.");
    expect(skill).toContain("at most 10 attachments");
    expect(skill).toMatch(/`\.gitignore` filtering applies to every `--file` input, including a literal\npath\./);
    expect(skill).toContain("--dry-run summary --files-report");
  });
});
