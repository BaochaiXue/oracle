import { describe, expect, test } from "vitest";
import { planOwnedTargetReconciliation } from "../../src/browser/lifecycleReconciler.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const profile = "/tmp/oracle-profile";

function session(
  id: string,
  status: string,
  runtime: NonNullable<NonNullable<SessionMetadata["browser"]>["runtime"]>,
  completedAt = "2026-08-22T00:00:00.000Z",
): SessionMetadata {
  return {
    id,
    createdAt: "2026-08-22T00:00:00.000Z",
    completedAt,
    status,
    options: {},
    browser: { runtime: { userDataDir: profile, ...runtime } },
  };
}

describe("planOwnedTargetReconciliation", () => {
  const targets = [
    { targetId: "done-target", type: "page", url: "https://chatgpt.com/c/done-conv" },
    { targetId: "recover-target", type: "page", url: "https://chatgpt.com/c/recover" },
    { targetId: "manual-target", type: "page", url: "https://example.com/notes" },
    { targetId: "blank-target", type: "page", url: "about:blank" },
  ];

  test("closes exact completed ownership while preserving recovery and unknown manual pages", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
      sessions: [
        session("done", "completed", {
          chromeTargetId: "done-target",
          conversationId: "done-conv",
          browserDisposition: "completed",
        }),
        session("recover", "error", {
          chromeTargetId: "recover-target",
          conversationId: "recover",
          browserDisposition: "recoverable",
          recoveryKind: "awaiting-response",
          recoveryExpiresAt: "2026-08-23T00:00:00.000Z",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual(["done-target"]);
    expect(plan.protectedTargetIds).toEqual(["recover-target"]);
    expect(plan.unknownTargetIds).toEqual(["manual-target", "blank-target"]);
    expect(plan.unknownBlockingTargetIds).toEqual(["manual-target"]);
  });

  test("matches completed legacy sessions by exact stable conversation id", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
      sessions: [
        session("legacy", "completed", {
          chromeTargetId: "stale-target-id",
          conversationId: "done-conv",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual(["done-target"]);
  });

  test("expires recovery holds and never uses a first-page fallback", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-24T00:00:00.000Z"),
      sessions: [
        session("expired", "error", {
          chromeTargetId: "missing-target",
          conversationId: "missing-conversation",
          browserDisposition: "recoverable",
          recoveryKind: "draft-retained",
          recoveryExpiresAt: "2026-08-22T02:00:00.000Z",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual([]);
    expect(plan.protectedTargetIds).toEqual([]);
    expect(plan.unknownTargetIds).toEqual([
      "done-target",
      "recover-target",
      "manual-target",
      "blank-target",
    ]);
    expect(plan.unknownBlockingTargetIds).toEqual([
      "done-target",
      "recover-target",
      "manual-target",
    ]);
  });

  test("a live recovery receipt overrides a completed receipt for the same exact target", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
      sessions: [
        session("done", "completed", {
          chromeTargetId: "done-target",
          browserDisposition: "completed",
        }),
        session("recover", "error", {
          chromeTargetId: "done-target",
          browserDisposition: "recoverable",
          recoveryExpiresAt: "2026-08-23T00:00:00.000Z",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual([]);
    expect(plan.protectedTargetIds).toEqual(["done-target"]);
  });
});
