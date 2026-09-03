import { describe, expect, test } from "vitest";
import { __test__ } from "../../src/cli/dedicatedBrowser.js";
import type { DedicatedChromeInspection } from "../../src/browser/dedicatedChromeSupervisor.js";

const ambiguous = {
  state: "ambiguous",
  ownership: "foreign-or-ambiguous",
  configuredExecutablePath: "/opt/chrome",
} as unknown as DedicatedChromeInspection;

describe("dedicated browser status advice", () => {
  test("never tells a human to close a browser while consultations are active or recoverable", () => {
    expect(
      __test__.statusFromInspection(ambiguous, { active: 1, recoverable: 0 }, true).actionRequired,
    ).toBe("wait: consultations active");
    expect(
      __test__.statusFromInspection(ambiguous, { active: 0, recoverable: 2 }, true).actionRequired,
    ).toBe("wait: consultations active");
  });

  test("still asks for the unverified browser to be closed when nothing is running", () => {
    expect(
      __test__.statusFromInspection(ambiguous, { active: 0, recoverable: 0 }, true).actionRequired,
    ).toBe("close unverified browser");
  });
});
