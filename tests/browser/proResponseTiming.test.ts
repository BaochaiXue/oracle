import { describe, expect, test } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  assertProResponseWorkloadTiming,
  elapsedSinceDispatch,
  recordProResponseTiming,
  requiresProResponseTiming,
} from "../../src/browser/proResponseTiming.js";

describe("Pro response timing", () => {
  test("records timing only for a selected/current Pro reasoning tier", () => {
    expect(requiresProResponseTiming({ thinkingTime: "pro", modelStrategy: "select" })).toBe(true);
    expect(requiresProResponseTiming({ thinkingTime: "pro", modelStrategy: "current" })).toBe(true);
    expect(requiresProResponseTiming({ thinkingTime: "pro", modelStrategy: "ignore" })).toBe(false);
    expect(requiresProResponseTiming({ thinkingTime: "extended", modelStrategy: "select" })).toBe(
      false,
    );
  });

  test("records elapsed time without imposing a task-agnostic minimum", () => {
    const capturedAt = new Date("2026-08-13T00:01:00.000Z");
    const recorded = recordProResponseTiming(
      { proDispatchAt: "2026-08-13T00:00:00.000Z" },
      capturedAt,
      { requireTimestamp: true },
    );

    expect(recorded.proResponseElapsedMs).toBe(60_000);
  });

  test("accepts a sub-minute answer and keeps its timing telemetry", () => {
    const recorded = recordProResponseTiming(
      { proDispatchAt: "2026-08-13T00:00:00.000Z" },
      new Date("2026-08-13T00:00:18.854Z"),
      { requireTimestamp: true },
    );

    expect(recorded.proResponseElapsedMs).toBe(18_854);
  });

  test("accepts a fast tiny Pro workload", () => {
    expect(() =>
      assertProResponseWorkloadTiming({
        answer: "ORACLE_COMPOSER_ACCEPTED",
        runtime: { proResponseElapsedMs: 18_854 },
        inputTokens: 83,
      }),
    ).not.toThrow();
  });

  test("rejects a fast substantive Pro workload without persisting answer text", () => {
    try {
      assertProResponseWorkloadTiming({
        answer: "private engineering review",
        runtime: { proResponseElapsedMs: 19_000 },
        inputTokens: 4_096,
      });
      throw new Error("expected workload timing guard to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserAutomationError);
      expect((error as BrowserAutomationError).details).toMatchObject({
        stage: "response-timing",
        code: "pro-fast-substantive-response-untrusted",
        responseElapsedMs: 19_000,
        thresholdMs: 60_000,
        inputTokens: 4_096,
      });
      expect(JSON.stringify((error as BrowserAutomationError).details)).not.toContain(
        "private engineering review",
      );
    }
  });

  test("rejects a fast large binary attachment even when prompt tokens are tiny", () => {
    expect(() =>
      assertProResponseWorkloadTiming({
        answer: "review",
        runtime: { proResponseElapsedMs: 19_000 },
        inputTokens: 83,
        attachmentBytes: 256 * 1024,
      }),
    ).toThrow(/substantive Pro reply/u);
  });

  test("accepts a substantive Pro workload at the timing boundary", () => {
    expect(() =>
      assertProResponseWorkloadTiming({
        answer: "review",
        runtime: { proResponseElapsedMs: 60_000 },
        inputTokens: 4_096,
      }),
    ).not.toThrow();
  });

  test("preserves the first captured elapsed time across a later reattach", () => {
    expect(
      recordProResponseTiming(
        {
          proDispatchAt: "2026-08-13T00:00:00.000Z",
          proResponseElapsedMs: 12_000,
        },
        new Date("2026-08-13T00:20:00.000Z"),
      ),
    ).toMatchObject({ proResponseElapsedMs: 12_000 });
  });

  test("understands OpenCLI's legacy receipt fields during migration", () => {
    const recorded = recordProResponseTiming(
      { opencliDispatchAt: "2026-08-13T00:00:00.000Z", opencliResponseElapsedMs: 90_000 },
      new Date("2026-08-13T00:10:00.000Z"),
    );

    expect(recorded.proDispatchAt).toBe("2026-08-13T00:00:00.000Z");
    expect(recorded.proResponseElapsedMs).toBe(90_000);
  });

  test("requires a dispatch receipt for new runs but tolerates old stored sessions", () => {
    expect(recordProResponseTiming({}, new Date(), { requireTimestamp: false })).toMatchObject({
      proResponseElapsedMs: undefined,
    });
    expect(() => recordProResponseTiming({}, new Date(), { requireTimestamp: true })).toThrow(
      /without the dispatch timestamp/u,
    );
  });

  test("ignores invalid or future dispatch timestamps", () => {
    const capturedAt = new Date("2026-08-13T00:00:00.000Z");
    expect(elapsedSinceDispatch("not-a-date", capturedAt)).toBeUndefined();
    expect(elapsedSinceDispatch("2026-08-13T00:00:01.000Z", capturedAt)).toBeUndefined();
  });
});
