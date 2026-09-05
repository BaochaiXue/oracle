import { describe, expect, test } from "vitest";
import { buildCanonicalBatchBrowserConfig } from "../../src/batch/browserConfig.js";

describe("canonical Batch Oracle browser config", () => {
  test("pins local direct CDP and the GPT-5.6 Pro target", async () => {
    const config = await buildCanonicalBatchBrowserConfig({
      browser: { transport: "cdp", manualLogin: true, maxConcurrentTabs: 3 },
    });
    expect(config).toEqual(
      expect.objectContaining({
        transport: "cdp",
        desiredModel: "GPT-6",
        modelStrategy: "select",
        thinkingTime: "pro",
        maxConcurrentTabs: 3,
      }),
    );
  });

  test.each([
    { transport: "opencli" as const },
    { manualLogin: false },
    { attachRunning: true },
    { remoteHost: "127.0.0.1:9473" },
  ])("rejects a noncanonical browser lane: %o", async (browser) => {
    await expect(buildCanonicalBatchBrowserConfig({ browser })).rejects.toThrow(
      /canonical local dedicated-profile direct-CDP lane/u,
    );
  });
});
