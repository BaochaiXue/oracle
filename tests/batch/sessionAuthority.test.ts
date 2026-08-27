import { describe, expect, test } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";
import {
  assertGenericSessionActionAllowed,
  resolveBatchSessionAuthority,
} from "../../src/batch/sessionAuthority.js";

const ordinary: SessionMetadata = {
  id: "ordinary-session",
  createdAt: "2026-08-27T00:00:00.000Z",
  status: "completed",
  options: {},
};

const batchChild: SessionMetadata = {
  ...ordinary,
  id: "batch-child",
  batch: {
    batchId: "batch-123",
    laneId: "adjudication",
    role: "synthesis",
    attempt: 1,
    inputManifestSha256: "a".repeat(64),
  },
};

describe("Batch session authority", () => {
  test("leaves ordinary sessions outside Batch authority", () => {
    expect(resolveBatchSessionAuthority(ordinary, "attach")).toBeNull();
    expect(() => assertGenericSessionActionAllowed(ordinary, "restart")).not.toThrow();
  });

  test.each(["attach", "status"] as const)("marks %s inspection read-only", (action) => {
    const authority = resolveBatchSessionAuthority(batchChild, action);
    expect(authority).toMatchObject({
      disposition: "read-only",
      batchId: "batch-123",
      laneId: "adjudication",
      role: "synthesis",
      resumeCommand: "oracle batch resume batch-123",
    });
    expect(authority?.guidance).toMatch(
      /batchId=batch-123, laneId=adjudication, role=synthesis.*read-only.*oracle batch resume batch-123/s,
    );
  });

  test.each(["live", "harvest", "followup", "restart", "execute"] as const)(
    "rejects generic %s mutation with complete Batch identity",
    (action) => {
      expect(() => assertGenericSessionActionAllowed(batchChild, action)).toThrow(
        /batchId=batch-123, laneId=adjudication, role=synthesis.*Batch parent.*oracle batch resume batch-123/s,
      );
    },
  );
});
