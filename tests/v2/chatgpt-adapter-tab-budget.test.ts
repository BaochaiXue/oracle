import { describe, expect, test } from "vitest";
import {
  MAX_OWNED_CHATGPT_TABS,
  OwnedTabBudget,
} from "../../packages/chatgpt-adapter/src/index.js";

describe("Oracle v2 ChatGPT owned-tab budget", () => {
  test("admits at most three tabs and backpressures the fourth until a lease is released", async () => {
    const budget = new OwnedTabBudget();
    const releases = await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()]);
    let fourthGranted = false;
    const fourth = budget.acquire().then((release) => {
      fourthGranted = true;
      return release;
    });

    await Promise.resolve();
    expect(MAX_OWNED_CHATGPT_TABS).toBe(3);
    expect(budget.active).toBe(3);
    expect(budget.pending).toBe(1);
    expect(fourthGranted).toBe(false);

    releases[0]!();
    const releaseFourth = await fourth;
    expect(fourthGranted).toBe(true);
    expect(budget.active).toBe(3);
    expect(budget.pending).toBe(0);

    releases[1]!();
    releases[2]!();
    releaseFourth();
    expect(budget.active).toBe(0);
  });

  test("rejects configuration above the owner-approved three-tab ceiling", () => {
    expect(() => new OwnedTabBudget(4)).toThrow(/at most 3/i);
  });
});
