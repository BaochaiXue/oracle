import { describe, expect, test } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  assertTrustedProResponse,
  elapsedSinceDispatch,
  MIN_TRUSTED_PRO_RESPONSE_MS,
  requiresProResponseAdmission,
} from "../../src/browser/proResponseAdmission.js";

describe("Pro response admission", () => {
  test("activates only for a selected/current Pro reasoning tier", () => {
    expect(requiresProResponseAdmission({ thinkingTime: "pro", modelStrategy: "select" })).toBe(
      true,
    );
    expect(requiresProResponseAdmission({ thinkingTime: "pro", modelStrategy: "current" })).toBe(
      true,
    );
    expect(requiresProResponseAdmission({ thinkingTime: "pro", modelStrategy: "ignore" })).toBe(
      false,
    );
    expect(
      requiresProResponseAdmission({ thinkingTime: "extended", modelStrategy: "select" }),
    ).toBe(false);
  });

  test("admits an answer at the sixty-second boundary and records elapsed time", () => {
    const capturedAt = new Date("2026-08-13T00:01:00.000Z");
    const admitted = assertTrustedProResponse(
      "A substantive response",
      { proDispatchAt: "2026-08-13T00:00:00.000Z" },
      capturedAt,
      { requireTimestamp: true },
    );

    expect(admitted.proResponseElapsedMs).toBe(MIN_TRUSTED_PRO_RESPONSE_MS);
  });

  test("rejects a sub-minute answer while retaining only timing and a hash receipt", () => {
    let thrown: unknown;
    try {
      assertTrustedProResponse(
        "Do not trust or quote this fast answer",
        { proDispatchAt: "2026-08-13T00:00:00.000Z" },
        new Date("2026-08-13T00:00:59.999Z"),
        { requireTimestamp: true },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BrowserAutomationError);
    const details = (thrown as BrowserAutomationError).details;
    expect(details).toMatchObject({
      stage: "model-quality-gate",
      code: "pro-fast-response-untrusted",
      responseElapsedMs: 59_999,
      thresholdMs: 60_000,
    });
    expect(details?.assistantSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(details)).not.toContain("Do not trust or quote");
  });

  test("preserves the first captured elapsed time across a later reattach", () => {
    expect(() =>
      assertTrustedProResponse(
        "The same previously captured answer",
        {
          proDispatchAt: "2026-08-13T00:00:00.000Z",
          proResponseElapsedMs: 12_000,
        },
        new Date("2026-08-13T00:20:00.000Z"),
      ),
    ).toThrow(/captured 12s after dispatch/u);
  });

  test("understands OpenCLI's legacy receipt fields during migration", () => {
    const admitted = assertTrustedProResponse(
      "A substantive response",
      { opencliDispatchAt: "2026-08-13T00:00:00.000Z", opencliResponseElapsedMs: 90_000 },
      new Date("2026-08-13T00:10:00.000Z"),
    );

    expect(admitted.proDispatchAt).toBe("2026-08-13T00:00:00.000Z");
    expect(admitted.proResponseElapsedMs).toBe(90_000);
  });

  test("requires a dispatch receipt for new runs but tolerates old stored sessions", () => {
    expect(
      assertTrustedProResponse("old answer", {}, new Date(), { requireTimestamp: false }),
    ).toMatchObject({ proResponseElapsedMs: undefined });
    expect(() =>
      assertTrustedProResponse("new answer", {}, new Date(), { requireTimestamp: true }),
    ).toThrow(/without the dispatch timestamp/u);
  });

  test("ignores invalid or future dispatch timestamps", () => {
    const capturedAt = new Date("2026-08-13T00:00:00.000Z");
    expect(elapsedSinceDispatch("not-a-date", capturedAt)).toBeUndefined();
    expect(elapsedSinceDispatch("2026-08-13T00:00:01.000Z", capturedAt)).toBeUndefined();
  });
});
