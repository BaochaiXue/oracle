import { describe, expect, test } from "vitest";
import { shouldSuppressCliIntro } from "../../src/cli/introPolicy.js";

describe("CLI intro policy", () => {
  test.each([
    [["browser", "status"], true],
    [["browser", "status", "--json"], true],
    [["browser", "heal"], true],
    [["browser", "smoke", "--json"], true],
    [["browser", "reconcile-tabs", "--json"], true],
    [["doctor", "--json"], true],
    [["docs", "check"], true],
    [["bridge", "codex-config"], true],
    [["browser", "smoke"], false],
    [["--engine", "browser", "--prompt", "review"], false],
  ] as const)("maps %j to suppress=%s", (args, expected) => {
    expect(shouldSuppressCliIntro([...args])).toBe(expected);
  });
});
