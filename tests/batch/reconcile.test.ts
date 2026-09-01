import { describe, expect, test, vi } from "vitest";
import type { ClientJob } from "../../packages/oracle-client/src/index.js";
import type { JobState } from "../../packages/oracle-kernel/src/index.js";
import {
  batchAttemptIdempotencyKey,
  classifyParentStatus,
  deriveLaneJobState,
  reconcileBatchState,
} from "../../src/batch/reconcile.js";
import type { BatchStateV1 } from "../../src/batch/types.js";

const NOW = "2026-09-01T00:00:00.000Z";

describe("Batch v2 job reconciliation", () => {
  test("maps durable job states without granting a second Send", () => {
    expect(deriveLaneJobState(job({ kind: "queued" })).status).toBe("running");
    expect(
      deriveLaneJobState(
        job({
          kind: "failed-unsent",
          retrySafe: true,
          failure: failure("pre_send_gate", "none", "safe-new-attempt"),
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        status: "recoverable",
        lastError: expect.objectContaining({ retrySafe: true }),
      }),
    );
    expect(
      deriveLaneJobState(
        job({
          kind: "recoverable",
          basis: "committed-capture",
          preparation: {} as never,
          intent: {} as never,
          submission: {} as never,
          failure: failure("capture_failed", "committed", "capture-only"),
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        status: "recoverable",
        lastError: expect.objectContaining({ retrySafe: false }),
      }),
    );
    expect(
      deriveLaneJobState(
        job({
          kind: "ambiguous",
          preparation: {} as never,
          intent: {} as never,
          failure: failure("commit_unknown", "possible", "owner-required"),
        }),
      ).status,
    ).toBe("indeterminate");
  });

  test("reconciles only an exact Batch owner and idempotency mapping", async () => {
    const state = batchState();
    const client = {
      getJob: vi.fn(async () => job({ kind: "queued" })),
    };
    const reconciled = await reconcileBatchState(state, client);
    expect(reconciled.lanes[0]).toEqual(
      expect.objectContaining({
        status: "running",
        jobId: "job-one",
        attempts: [expect.objectContaining({ jobId: "job-one", phase: "started" })],
      }),
    );

    client.getJob.mockResolvedValueOnce(
      job(
        { kind: "queued" },
        {
          owner: { kind: "batch-lane", batchId: state.batchId, laneId: "other", attempt: 1 },
        },
      ),
    );
    const mismatched = await reconcileBatchState(state, client);
    expect(mismatched.lanes[0]).toEqual(
      expect.objectContaining({
        status: "indeterminate",
        lastError: expect.objectContaining({ code: "batch-job-identity-mismatch" }),
      }),
    );
  });

  test("keeps an admitted job recoverable when the worker cannot be observed", async () => {
    const state = batchState();
    const reconciled = await reconcileBatchState(state, {
      getJob: vi.fn(async () => {
        throw new Error("socket unavailable during restart");
      }),
    });
    expect(reconciled.lanes[0]).toEqual(
      expect.objectContaining({
        jobId: "job-one",
        status: "recoverable",
        lastError: expect.objectContaining({
          code: "batch-job-observation-failed",
          retrySafe: false,
        }),
      }),
    );
  });

  test("classifies the parent barrier and owner gates from durable lane states", () => {
    const running = batchState();
    expect(classifyParentStatus(running)).toBe("awaiting-recovery");
    const owner = {
      ...running,
      lanes: running.lanes.map((lane) => ({ ...lane, status: "indeterminate" as const })),
    };
    expect(classifyParentStatus(owner)).toBe("awaiting-owner");
    const completed = {
      ...running,
      lanes: running.lanes.map((lane) => ({ ...lane, status: "completed" as const })),
    };
    expect(classifyParentStatus(completed)).toBe("completed");
  });
});

function batchState(): BatchStateV1 {
  const batchId = "fixture-20260901T000000Z-abcd";
  const idempotencyKey = batchAttemptIdempotencyKey(batchId, "one", "lane", 1);
  return {
    schemaVersion: "oracle.batch.v1",
    batchId,
    slug: "fixture",
    project: "fixture",
    objective: "Reconcile a Batch-owned job.",
    status: "running",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/tmp",
    effectiveMaxParallel: 3,
    effectiveMaxChildSessions: 3,
    lanes: [
      {
        id: "one",
        role: "lane",
        status: "running",
        required: true,
        jobId: "job-one",
        attempts: [
          {
            attempt: 1,
            jobId: "job-one",
            idempotencyKey,
            createdAt: NOW,
            phase: "started",
          },
        ],
      },
    ],
  };
}

function job(
  state: JobState,
  overrides: {
    owner?: ClientJob["spec"]["owner"];
    idempotencyKey?: string;
  } = {},
): ClientJob {
  const batchId = "fixture-20260901T000000Z-abcd";
  return {
    id: "job-one",
    spec: {
      schemaVersion: "oracle.job.v2",
      requestId: "batch-job-one",
      idempotency: {
        scope: "oracle-batch",
        key: overrides.idempotencyKey ?? batchAttemptIdempotencyKey(batchId, "one", "lane", 1),
      },
      owner: overrides.owner ?? {
        kind: "batch-lane",
        batchId,
        laneId: "one",
        attempt: 1,
      },
      input: {
        prompt: {
          sha256: "1".repeat(64),
          sizeBytes: 1,
          mediaType: "text/plain",
          objectClass: "prompt",
        },
        promptSha256: "1".repeat(64),
      },
      route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
      policy: {
        maxCaptureMs: 60_000,
        allowAutomaticCaptureRecovery: true,
        allowAutomaticResend: false,
        requireCommittedBundleEvidence: false,
      },
    },
    specObjectSha256: "2".repeat(64),
    state,
    stateVersion: 1,
    projectionPending: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function failure(
  code: string,
  risk: "none" | "possible" | "committed",
  retryPolicy: "safe-new-attempt" | "capture-only" | "owner-required" | "forbidden",
) {
  return {
    code,
    phase: "fixture",
    message: code,
    occurredAt: NOW,
    externalEffectRisk: risk,
    retryPolicy,
  };
}
