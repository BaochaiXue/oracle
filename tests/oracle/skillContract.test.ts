import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("canonical Oracle skill contract", () => {
  test("pins the GPT-5.6 Pro direct-CDP browser lane without provider fallback", async () => {
    const skill = await readFile(path.join(process.cwd(), "skills/oracle/SKILL.md"), "utf8");

    expect(skill).toContain("--engine browser --browser-transport cdp --model gpt-5-pro");
    expect(skill).toContain("--browser-thinking-time pro");
    expect(skill).toContain("Oracle never dispatches or\nfalls back to Gemini");
    expect(skill).toContain("fail closed; do not substitute another model");
    expect(skill).not.toMatch(/oracle[^\n]*--model\s+gemini/i);
  });
});
