import type { ClientJob, OracleClient } from "../../packages/oracle-client/src/index.js";
import type { BatchLaneState, BatchStateV1 } from "./types.js";

export type BatchJobObserver = Pick<OracleClient, "getJob">;

export interface DerivedLaneJobState {
  status: BatchLaneState["status"];
  lastError?: BatchLaneState["lastError"];
}

export async function reconcileBatchState(
  state: BatchStateV1,
  client: BatchJobObserver,
): Promise<BatchStateV1> {
  const reconcileLane = async (lane: BatchLaneState): Promise<BatchLaneState> => {
    if (
      lane.acceptedMissing ||
      lane.status === "abandoned" ||
      lane.status === "completed" ||
      !lane.jobId
    ) {
      return lane;
    }
    let job: ClientJob;
    try {
      job = await client.getJob(lane.jobId);
    } catch (error) {
      return {
        ...lane,
        status: "recoverable",
        dispatchReservation: undefined,
        lastError: {
          code: "batch-job-observation-failed",
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false,
        },
      };
    }
    const identityError = validateBatchJobIdentity(state, lane, job);
    if (identityError) {
      return {
        ...lane,
        status: "indeterminate",
        dispatchReservation: undefined,
        lastError: {
          code: "batch-job-identity-mismatch",
          message: identityError,
          retrySafe: false,
        },
      };
    }
    const derived = deriveLaneJobState(job);
    const completedAt =
      derived.status === "completed"
        ? (lane.completedAt ?? job.updatedAt ?? new Date().toISOString())
        : undefined;
    return {
      ...lane,
      status: derived.status,
      dispatchReservation: undefined,
      attempts: lane.attempts.map((attempt, index) =>
        index !== lane.attempts.length - 1 || attempt.jobId !== job.id
          ? attempt
          : derived.status === "completed"
            ? { ...attempt, phase: "completed" as const, completedAt }
            : ["recoverable", "error", "indeterminate", "abandoned"].includes(derived.status)
              ? { ...attempt, phase: "failed" as const }
              : { ...attempt, phase: "started" as const },
      ),
      ...(completedAt ? { completedAt } : {}),
      ...(derived.lastError ? { lastError: derived.lastError } : { lastError: undefined }),
    };
  };
  const lanes = await Promise.all(state.lanes.map(reconcileLane));
  const synthesis = state.synthesis ? await reconcileLane(state.synthesis) : undefined;
  return { ...state, lanes, ...(synthesis ? { synthesis } : {}) };
}

export function deriveLaneJobState(job: ClientJob): DerivedLaneJobState {
  switch (job.state.kind) {
    case "completed":
      return { status: "completed" };
    case "failed-unsent":
      return {
        status: "recoverable",
        lastError: {
          code: job.state.failure.code,
          message: job.state.failure.message,
          retrySafe: true,
        },
      };
    case "recoverable":
      return {
        status: "recoverable",
        lastError: {
          code: job.state.failure.code,
          message: job.state.failure.message,
          retrySafe: job.state.basis === "verified-unsent",
        },
      };
    case "ambiguous":
      return {
        status: "indeterminate",
        lastError: {
          code: job.state.failure.code,
          message: job.state.failure.message,
          retrySafe: false,
        },
      };
    case "abandoned":
    case "canceled-unsent":
      return {
        status: "abandoned",
        lastError: {
          code: `batch-job-${job.state.kind}`,
          message: job.state.ownerReason,
          retrySafe: false,
        },
      };
    default:
      return { status: "running" };
  }
}

export function classifyParentStatus(state: BatchStateV1): BatchStateV1["status"] {
  if (state.status === "error" && state.lanes.every((lane) => !lane.jobId && !lane.sessionId)) {
    return "error";
  }
  if (
    state.status === "interrupted" &&
    state.lanes.some((lane) => lane.status !== "completed" && !lane.acceptedMissing)
  ) {
    return "interrupted";
  }
  const required = state.lanes.filter((lane) => !lane.acceptedMissing);
  if (
    required.some((lane) =>
      ["recoverable", "running", "claimed", "session-created", "sealed", "pending"].includes(
        lane.status,
      ),
    )
  ) {
    return "awaiting-recovery";
  }
  if (required.some((lane) => lane.status === "error" || lane.status === "indeterminate")) {
    return "awaiting-owner";
  }
  if (required.every((lane) => lane.status === "completed")) {
    if (state.synthesis) {
      if (state.synthesis.acceptedMissing || state.synthesis.status === "abandoned")
        return "partial";
      if (state.synthesis.status === "completed") {
        return hasPartialDecision(state) ? "partial" : "completed";
      }
      if (
        ["recoverable", "running", "claimed", "session-created", "sealed", "pending"].includes(
          state.synthesis.status,
        )
      ) {
        return "awaiting-recovery";
      }
      if (state.synthesis.status === "error" || state.synthesis.status === "indeterminate") {
        return "awaiting-owner";
      }
      return "sealed";
    }
    return hasPartialDecision(state) ? "partial" : "completed";
  }
  return state.status;
}

function validateBatchJobIdentity(
  state: BatchStateV1,
  lane: BatchLaneState,
  job: ClientJob,
): string | undefined {
  const attempt = lane.attempts.find((entry) => entry.jobId === job.id) ?? lane.attempts.at(-1);
  if (!attempt) return `Lane ${lane.id} has no durable attempt for job ${job.id}.`;
  if (attempt.jobId && attempt.jobId !== job.id) {
    return `Lane ${lane.id} maps attempt ${attempt.attempt} to ${attempt.jobId}, not ${job.id}.`;
  }
  const expectedKey = batchAttemptIdempotencyKey(
    state.batchId,
    lane.id,
    lane.role,
    attempt.attempt,
  );
  if (
    job.spec.idempotency.scope !== "oracle-batch" ||
    job.spec.idempotency.key !== expectedKey ||
    (attempt.idempotencyKey && attempt.idempotencyKey !== expectedKey)
  ) {
    return `Job ${job.id} does not match the sealed Batch attempt idempotency identity.`;
  }
  const owner = job.spec.owner;
  if (lane.role === "lane") {
    if (
      owner.kind !== "batch-lane" ||
      owner.batchId !== state.batchId ||
      owner.laneId !== lane.id ||
      owner.attempt !== attempt.attempt
    ) {
      return `Job ${job.id} does not belong to Batch lane ${state.batchId}/${lane.id}/${attempt.attempt}.`;
    }
  } else if (
    owner.kind !== "batch-synthesis" ||
    owner.batchId !== state.batchId ||
    owner.attempt !== attempt.attempt
  ) {
    return `Job ${job.id} does not belong to Batch synthesis ${state.batchId}/${attempt.attempt}.`;
  }
  return undefined;
}

export function batchAttemptIdempotencyKey(
  batchId: string,
  laneId: string,
  role: "lane" | "synthesis",
  attempt: number,
): string {
  return role === "lane"
    ? `batch:${batchId}:lane:${laneId}:attempt:${attempt}`
    : `batch:${batchId}:synthesis:${laneId}:attempt:${attempt}`;
}

function hasPartialDecision(state: BatchStateV1): boolean {
  return Boolean(state.ownerDecisions?.some((decision) => decision.type === "allow-partial"));
}
