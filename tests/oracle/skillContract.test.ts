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
    expect(skill).toContain("Non-Pro aliases do not detach.");
    expect(skill).toContain("oracle status --hours 72");
    // gpt-5-pro selects the Sol row and drives the Pro effort tier; there is no
    // separate Pro model row to select.
    expect(skill).toContain("There is no\n  separate `Pro` model row to select.");
    expect(skill).not.toContain("`gpt-5-pro` selects ChatGPT's `Pro` target");
  });
});
