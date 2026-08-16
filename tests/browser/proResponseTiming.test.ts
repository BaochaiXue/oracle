import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  assertProResponseWorkloadTiming,
  beginProResponseTimingTurn,
  completeProResponseTimingTurn,
  elapsedSinceDispatch,
  hashProPromptIdentity,
  markProPromptCommitted,
  markProPromptDispatched,
  recordProResponseTiming,
  resolveProAttachmentBytes,
  requiresProResponseTiming,
  verifyStoredProResponseWorkloadTiming,
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
        attachmentBytes: 0,
      }),
    ).not.toThrow();
  });

  test("rejects a fast substantive Pro workload without persisting answer text", () => {
    try {
      assertProResponseWorkloadTiming({
        answer: "private engineering review",
        runtime: { proResponseElapsedMs: 19_000 },
        inputTokens: 4_096,
        attachmentBytes: 0,
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
        attachmentBytes: 0,
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

  test("keeps a fast legacy workload-unknown response rejected during reattach", () => {
    expect(() =>
      verifyStoredProResponseWorkloadTiming({
        answer: "private legacy engineering review",
        runtime: {
          proDispatchAt: "2026-08-13T00:00:00.000Z",
          proResponseElapsedMs: 20_000,
        },
        capturedAt: new Date("2026-08-13T00:20:00.000Z"),
      }),
    ).toThrow(/legacy workload-unknown Pro reply/u);
  });

  test("allows a legacy workload-unknown response that met the old timing boundary", () => {
    expect(
      verifyStoredProResponseWorkloadTiming({
        answer: "legacy engineering review",
        runtime: {
          proDispatchAt: "2026-08-13T00:00:00.000Z",
          proResponseElapsedMs: 90_000,
        },
        capturedAt: new Date("2026-08-13T00:20:00.000Z"),
      }),
    ).toMatchObject({ proResponseElapsedMs: 90_000 });
  });

  test("preserves the legacy policy for a valid elapsed-only scalar", () => {
    expect(
      verifyStoredProResponseWorkloadTiming({
        answer: "legacy elapsed-only answer",
        runtime: { proResponseElapsedMs: 90_000 },
        capturedAt: new Date("2026-08-13T00:20:00.000Z"),
      }),
    ).toMatchObject({ proResponseElapsedMs: 90_000 });
  });

  test("rejects a partial new-format turn receipt without commit identity", () => {
    expect(() =>
      verifyStoredProResponseWorkloadTiming({
        answer: "must not recover",
        runtime: {
          proDispatchAt: "2026-08-13T00:00:00.000Z",
          proResponseElapsedMs: 90_000,
          proInputTokens: 4_096,
          proAttachmentBytes: 0,
          proTurnIndex: 0,
        },
        capturedAt: new Date("2026-08-13T00:20:00.000Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-turn-not-committed" }),
      }),
    );
  });

  test("applies the same workload-unknown migration rule to OpenCLI receipt fields", () => {
    expect(() =>
      verifyStoredProResponseWorkloadTiming({
        answer: "private legacy OpenCLI review",
        runtime: {
          opencliDispatchAt: "2026-08-13T00:00:00.000Z",
          opencliResponseElapsedMs: 20_000,
        },
        capturedAt: new Date("2026-08-13T00:20:00.000Z"),
      }),
    ).toThrow(/legacy workload-unknown Pro reply/u);
  });

  test("keeps stored sessions without any Pro timing receipt on the legacy read policy", () => {
    const runtime = { promptSubmitted: true };
    expect(
      verifyStoredProResponseWorkloadTiming({
        answer: "old answer",
        runtime,
        capturedAt: new Date("2026-08-13T00:20:00.000Z"),
      }),
    ).toBe(runtime);
  });

  test("binds direct-CDP timing and workload receipts to each submitted turn", () => {
    let runtime = beginProResponseTimingTurn(
      {},
      { inputTokens: 20, attachmentBytes: 0, prompt: "hello" },
    );
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:00:00.000Z"));
    runtime = markProPromptCommitted(runtime, 0);
    runtime = completeProResponseTimingTurn({
      answer: "hello",
      runtime,
      capturedAt: new Date("2026-08-13T00:00:10.000Z"),
    });

    runtime = beginProResponseTimingTurn(runtime, {
      inputTokens: 5_000,
      attachmentBytes: 0,
      prompt: "review the implementation",
    });
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:01:00.000Z"));
    runtime = markProPromptCommitted(runtime, 2);

    try {
      completeProResponseTimingTurn({
        answer: "private fast follow-up review",
        runtime,
        capturedAt: new Date("2026-08-13T00:01:20.000Z"),
      });
      throw new Error("expected substantive follow-up to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserAutomationError);
      expect((error as BrowserAutomationError).details).toMatchObject({
        code: "pro-fast-substantive-response-untrusted",
        inputTokens: 5_000,
        responseElapsedMs: 20_000,
        runtime: expect.objectContaining({
          proTurnIndex: 1,
          proDispatchAt: "2026-08-13T00:01:00.000Z",
          proInputTokens: 5_000,
          proResponseTimingReceipts: [
            expect.objectContaining({
              turnIndex: 0,
              dispatchAt: "2026-08-13T00:00:00.000Z",
              responseElapsedMs: 10_000,
              inputTokens: 20,
            }),
          ],
        }),
      });
      expect(JSON.stringify((error as BrowserAutomationError).details)).not.toContain(
        "private fast follow-up review",
      );
    }
  });

  test("classifies a tiny follow-up by its own turn workload and elapsed time", () => {
    let runtime = beginProResponseTimingTurn(
      {},
      { inputTokens: 4_096, attachmentBytes: 0, prompt: "initial review" },
    );
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:00:00.000Z"));
    runtime = markProPromptCommitted(runtime, 0);
    runtime = completeProResponseTimingTurn({
      answer: "substantive initial answer",
      runtime,
      capturedAt: new Date("2026-08-13T00:01:30.000Z"),
    });
    runtime = beginProResponseTimingTurn(runtime, {
      inputTokens: 12,
      attachmentBytes: 0,
      prompt: "tiny follow-up",
    });
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:02:00.000Z"));
    runtime = markProPromptCommitted(runtime, 2);
    runtime = completeProResponseTimingTurn({
      answer: "tiny follow-up answer",
      runtime,
      capturedAt: new Date("2026-08-13T00:02:08.000Z"),
    });

    expect(runtime.proResponseTimingReceipts).toEqual([
      expect.objectContaining({ turnIndex: 0, inputTokens: 4_096, responseElapsedMs: 90_000 }),
      expect.objectContaining({ turnIndex: 1, inputTokens: 12, responseElapsedMs: 8_000 }),
    ]);
  });

  test("keeps two substantive follow-ups on independent dispatch clocks", () => {
    let runtime = beginProResponseTimingTurn(
      {},
      { inputTokens: 8, attachmentBytes: 0, prompt: "initial" },
    );
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:00:00.000Z"));
    runtime = markProPromptCommitted(runtime, 0);
    runtime = completeProResponseTimingTurn({
      answer: "initial",
      runtime,
      capturedAt: new Date("2026-08-13T00:00:05.000Z"),
    });
    runtime = beginProResponseTimingTurn(runtime, {
      inputTokens: 4_000,
      attachmentBytes: 0,
      prompt: "first substantive follow-up",
    });
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:01:00.000Z"));
    runtime = markProPromptCommitted(runtime, 2);
    runtime = completeProResponseTimingTurn({
      answer: "first substantive follow-up",
      runtime,
      capturedAt: new Date("2026-08-13T00:02:05.000Z"),
    });
    runtime = beginProResponseTimingTurn(runtime, {
      inputTokens: 6_000,
      attachmentBytes: 0,
      prompt: "second substantive follow-up",
    });
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:03:00.000Z"));
    runtime = markProPromptCommitted(runtime, 4);
    runtime = completeProResponseTimingTurn({
      answer: "second substantive follow-up",
      runtime,
      capturedAt: new Date("2026-08-13T00:04:15.000Z"),
    });

    expect(runtime.proResponseTimingReceipts).toEqual([
      expect.objectContaining({ turnIndex: 0, responseElapsedMs: 5_000 }),
      expect.objectContaining({
        turnIndex: 1,
        dispatchAt: "2026-08-13T00:01:00.000Z",
        responseElapsedMs: 65_000,
        inputTokens: 4_000,
      }),
      expect.objectContaining({
        turnIndex: 2,
        dispatchAt: "2026-08-13T00:03:00.000Z",
        responseElapsedMs: 75_000,
        inputTokens: 6_000,
      }),
    ]);
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

  test("rejects a new direct answer whose active prompt never committed", () => {
    let runtime = beginProResponseTimingTurn(
      {},
      { inputTokens: 8, attachmentBytes: 0, prompt: "new prompt" },
    );
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:00:00.000Z"));

    expect(() =>
      completeProResponseTimingTurn({
        answer: "prior answer",
        runtime,
        capturedAt: new Date("2026-08-13T00:01:05.000Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-turn-not-committed" }),
      }),
    );
  });

  test("binds a committed direct turn to a privacy-safe prompt digest", () => {
    let runtime = beginProResponseTimingTurn(
      {},
      { inputTokens: 8, attachmentBytes: 0, prompt: "Review `this`   seam" },
    );
    expect(runtime.proPromptSha256).toBe(hashProPromptIdentity("review this seam"));
    runtime = markProPromptDispatched(runtime, new Date("2026-08-13T00:00:00.000Z"));
    runtime = markProPromptCommitted(runtime, 6);

    expect(runtime).toMatchObject({
      proTurnCommitted: true,
      proCommittedTurnIndex: 6,
    });
  });

  test("requires a valid dispatch marker even when a new run already carries elapsed telemetry", () => {
    expect(() =>
      recordProResponseTiming(
        { proResponseElapsedMs: 90_000 },
        new Date("2026-08-13T00:02:00.000Z"),
        { requireTimestamp: true },
      ),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "dispatch-timestamp-missing" }),
      }),
    );
  });

  test.each([
    { proDispatchAt: "not-a-date" },
    { proDispatchAt: "2026-08-13T00:00:01.000Z" },
    { proResponseElapsedMs: Number.NaN },
    { proResponseElapsedMs: -1 },
  ])("fails closed when a stored timing marker is indeterminate: %j", (marker) => {
    expect(() =>
      verifyStoredProResponseWorkloadTiming({
        answer: "answer",
        runtime: marker,
        capturedAt: new Date("2026-08-13T00:00:00.000Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-response-timing-indeterminate" }),
      }),
    );
  });

  test("stats an attachment when upstream omitted sizeBytes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-pro-size-"));
    const filePath = path.join(directory, "large.bin");
    try {
      await writeFile(filePath, Buffer.alloc(32 * 1024));
      await expect(
        resolveProAttachmentBytes([{ path: filePath, displayPath: "large.bin" }]),
      ).resolves.toBe(32 * 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
