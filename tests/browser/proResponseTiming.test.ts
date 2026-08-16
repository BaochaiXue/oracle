import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import {
  assertProResponseTimingAdmission,
  beginProResponseTimingTurn,
  completeProResponseTimingTurn,
  elapsedSinceDispatch,
  hashProPromptIdentity,
  markProPromptCommitted,
  markProPromptDispatched,
  requiresProResponseTiming,
  resolveProAttachmentBytes,
  verifyStoredProResponseWorkloadTiming,
} from "../../src/browser/proResponseTiming.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function errorCode(error: unknown): unknown {
  return error instanceof BrowserAutomationError ? error.details?.code : undefined;
}

function activeTurn(overrides: Partial<BrowserRuntimeMetadata> = {}): BrowserRuntimeMetadata {
  return {
    proDispatchAt: "2026-08-16T00:00:00.000Z",
    proInputTokens: 500,
    proAttachmentBytes: 0,
    proTurnIndex: 0,
    proTurnCommitted: true,
    proPromptSha256: hashProPromptIdentity("review this change"),
    proCommittedTurnIndex: 2,
    ...overrides,
  };
}

describe("Pro response timing", () => {
  test("activates only for an enforced Pro thinking tier", () => {
    expect(requiresProResponseTiming({ thinkingTime: "pro", modelStrategy: "select" })).toBe(true);
    expect(requiresProResponseTiming({ thinkingTime: "extended", modelStrategy: "select" })).toBe(
      false,
    );
    expect(requiresProResponseTiming({ thinkingTime: "pro", modelStrategy: "ignore" })).toBe(false);
  });

  test("computes elapsed time only from a valid earlier dispatch timestamp", () => {
    const capturedAt = new Date("2026-08-16T00:01:00.000Z");
    expect(elapsedSinceDispatch("2026-08-16T00:00:00.000Z", capturedAt)).toBe(60_000);
    expect(elapsedSinceDispatch("invalid", capturedAt)).toBeUndefined();
    expect(elapsedSinceDispatch("2026-08-16T00:02:00.000Z", capturedAt)).toBeUndefined();
  });

  test("stats attachments whose caller did not provide sizeBytes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-pro-timing-"));
    temporaryDirectories.push(directory);
    const attachmentPath = path.join(directory, "evidence.txt");
    await writeFile(attachmentPath, "1234567890", "utf8");
    await expect(
      resolveProAttachmentBytes([{ path: attachmentPath, displayPath: "evidence.txt" }]),
    ).resolves.toBe(10);
  });

  test("fails before dispatch when an attachment size cannot be established", async () => {
    await expect(
      resolveProAttachmentBytes([{ path: "/missing/oracle-evidence", displayPath: "evidence" }]),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "pro-attachment-size-unavailable");
  });

  test("rejects invalid explicit attachment sizes", async () => {
    await expect(
      resolveProAttachmentBytes([
        { path: "/unused", displayPath: "invalid", sizeBytes: Number.NaN },
      ]),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "pro-attachment-size-invalid");
  });

  test("begins each turn with workload and privacy-safe prompt identity", () => {
    const runtime = beginProResponseTimingTurn(
      {},
      {
        inputTokens: 501,
        attachmentBytes: 42,
        prompt: "Review `this` change",
      },
    );
    expect(runtime).toMatchObject({
      proInputTokens: 501,
      proAttachmentBytes: 42,
      proTurnIndex: 0,
      proTurnCommitted: false,
      proPromptSha256: hashProPromptIdentity("Review this change"),
    });
    expect(runtime).not.toHaveProperty("prompt");
  });

  test("records dispatch once and binds commit to an exact DOM turn", () => {
    const begun = beginProResponseTimingTurn(
      {},
      {
        inputTokens: 501,
        attachmentBytes: 0,
        prompt: "review this change",
      },
    );
    const dispatched = markProPromptDispatched(begun, new Date("2026-08-16T00:00:00Z"));
    const redispatched = markProPromptDispatched(dispatched, new Date("2026-08-16T00:00:30Z"));
    const committed = markProPromptCommitted(redispatched, 4);
    expect(committed.proDispatchAt).toBe("2026-08-16T00:00:00.000Z");
    expect(committed).toMatchObject({ proTurnCommitted: true, proCommittedTurnIndex: 4 });
  });

  test("allows tiny Pro prompts to complete quickly", () => {
    expect(() =>
      assertProResponseTimingAdmission({
        answer: "ok",
        runtime: { proResponseElapsedMs: 3_000 },
        inputTokens: 50,
        attachmentBytes: 0,
      }),
    ).not.toThrow();
  });

  test("rejects substantive Pro prompts completed in under 60 seconds", () => {
    expect(() =>
      assertProResponseTimingAdmission({
        answer: "implausibly quick",
        runtime: { proResponseElapsedMs: 59_999 },
        inputTokens: 500,
        attachmentBytes: 0,
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-fast-substantive-response-untrusted" }),
      }),
    );
  });

  test("does not treat missing active workload as a tiny prompt", () => {
    expect(() =>
      assertProResponseTimingAdmission({
        answer: "unknown workload",
        runtime: { proResponseElapsedMs: 10_000 },
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ workloadMetadata: "unknown" }),
      }),
    );
  });

  test("preserves legacy sessions without timing markers", () => {
    expect(() => assertProResponseTimingAdmission({ answer: "legacy", runtime: {} })).not.toThrow();
  });

  test("fails closed when a timing marker is invalid", () => {
    expect(() =>
      assertProResponseTimingAdmission({
        answer: "indeterminate",
        runtime: { proDispatchAt: "invalid" },
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-response-timing-indeterminate" }),
      }),
    );
  });

  test("requires a dispatch timestamp for a current direct turn", () => {
    expect(() =>
      completeProResponseTimingTurn({
        answer: "answer",
        runtime: activeTurn({ proDispatchAt: undefined }),
        capturedAt: new Date("2026-08-16T00:01:01Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "dispatch-timestamp-missing" }),
      }),
    );
  });

  test("requires durable commit evidence", () => {
    expect(() =>
      completeProResponseTimingTurn({
        answer: "answer",
        runtime: activeTurn({ proTurnCommitted: false }),
        capturedAt: new Date("2026-08-16T00:01:01Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-turn-not-committed" }),
      }),
    );
  });

  test("requires committed prompt identity", () => {
    expect(() =>
      completeProResponseTimingTurn({
        answer: "answer",
        runtime: activeTurn({ proPromptSha256: undefined }),
        capturedAt: new Date("2026-08-16T00:01:01Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-turn-identity-missing" }),
      }),
    );
  });

  test("requires workload receipt fields", () => {
    expect(() =>
      completeProResponseTimingTurn({
        answer: "answer",
        runtime: activeTurn({ proInputTokens: undefined }),
        capturedAt: new Date("2026-08-16T00:01:01Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ code: "pro-workload-receipt-missing" }),
      }),
    );
  });

  test("appends one accepted receipt per completed turn", () => {
    const first = completeProResponseTimingTurn({
      answer: "first answer",
      runtime: activeTurn(),
      capturedAt: new Date("2026-08-16T00:01:01Z"),
    });
    const secondBegun = beginProResponseTimingTurn(first, {
      inputTokens: 25,
      attachmentBytes: 0,
      prompt: "short follow-up",
    });
    const second = completeProResponseTimingTurn({
      answer: "second answer",
      runtime: markProPromptCommitted(
        markProPromptDispatched(secondBegun, new Date("2026-08-16T00:02:00Z")),
        4,
      ),
      capturedAt: new Date("2026-08-16T00:02:05Z"),
    });
    expect(second.proResponseTimingReceipts).toHaveLength(2);
    expect(second.proResponseTimingReceipts?.map((receipt) => receipt.turnIndex)).toEqual([0, 1]);
    expect(second.proResponseTimingReceipts?.[1]).toMatchObject({
      inputTokens: 25,
      responseElapsedMs: 5_000,
    });
  });

  test("recovery rejects fast workload-unknown timing instead of borrowing another turn", () => {
    expect(() =>
      verifyStoredProResponseWorkloadTiming({
        answer: "recovered",
        runtime: {
          proDispatchAt: "2026-08-16T00:00:00Z",
          proTurnIndex: 1,
          proInputTokens: undefined,
          proAttachmentBytes: undefined,
          proResponseTimingReceipts: [
            {
              turnIndex: 0,
              dispatchAt: "2026-08-15T23:50:00Z",
              responseElapsedMs: 600_000,
              inputTokens: 50_000,
              attachmentBytes: 0,
            },
          ],
        },
        capturedAt: new Date("2026-08-16T00:00:10Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ workloadMetadata: "unknown" }),
      }),
    );
  });

  test("recovery preserves valid slow elapsed-only legacy markers", () => {
    const runtime = verifyStoredProResponseWorkloadTiming({
      answer: "recovered",
      runtime: { proResponseElapsedMs: 61_000 },
      capturedAt: new Date("2026-08-16T00:10:00Z"),
    });
    expect(runtime.proResponseElapsedMs).toBe(61_000);
    expect(runtime.proResponseTimingReceipts).toBeUndefined();
  });
});
