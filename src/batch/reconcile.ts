import path from "node:path";
import type { SessionMetadata } from "../sessionStore.js";
import type { SessionStore } from "../sessionStore.js";
import { hasRecoverableChatGptConversation } from "../browser/reattachability.js";
import { isTerminalProResponseTimingCode } from "../browser/proResponseTiming.js";
import type { BatchLaneState, BatchStateV1 } from "./types.js";
import { getBatchPaths } from "./store.js";

export interface DerivedLaneSessionState {
  status: BatchLaneState["status"];
  lastError?: BatchLaneState["lastError"];
  clearReservation?: boolean;
}

export async function reconcileBatchState(
  state: BatchStateV1,
  store: SessionStore,
): Promise<BatchStateV1> {
  const discovered = await attachDiscoveredChildSessions(state, store);
  const reconcileLane = async (lane: BatchLaneState): Promise<BatchLaneState> => {
    if (lane.acceptedMissing || lane.status === "abandoned") return lane;
    if (!lane.sessionId) return lane;
    const metadata = await store.readSession(lane.sessionId);
    const derived = deriveLaneSessionState(metadata, lane);
    return {
      ...lane,
      status: derived.status,
      attempts: lane.attempts.map((attempt, index) =>
        index !== lane.attempts.length - 1
          ? attempt
          : derived.status === "completed"
            ? {
                ...attempt,
                phase: "completed" as const,
                completedAt:
                  metadata?.completedAt ?? attempt.completedAt ?? new Date().toISOString(),
              }
            : derived.status === "error" || derived.status === "recoverable"
              ? { ...attempt, phase: "failed" as const }
              : attempt,
      ),
      ...(derived.lastError ? { lastError: derived.lastError } : {}),
      ...(derived.status === "completed"
        ? { completedAt: metadata?.completedAt ?? lane.completedAt ?? new Date().toISOString() }
        : {}),
      ...(derived.clearReservation ? { dispatchReservation: undefined } : {}),
    };
  };
  const lanes = await Promise.all(discovered.lanes.map(reconcileLane));
  const synthesis = discovered.synthesis ? await reconcileLane(discovered.synthesis) : undefined;
  return { ...discovered, lanes, ...(synthesis ? { synthesis } : {}) };
}

async function attachDiscoveredChildSessions(
  state: BatchStateV1,
  store: SessionStore,
): Promise<BatchStateV1> {
  const missing = [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])].filter(
    (lane) => !lane.sessionId,
  );
  if (missing.length === 0) return state;
  const sessions = await store.listSessions();
  const attach = (lane: BatchLaneState): BatchLaneState => {
    if (lane.sessionId) return lane;
    const related = sessions.filter(
      (session) =>
        session.batch?.batchId === state.batchId &&
        session.batch.laneId === lane.id &&
        session.batch.role === lane.role,
    );
    if (related.length === 0) return lane;
    if (!lane.inputManifestSha256) {
      return orphanAmbiguity(
        lane,
        "Parent lane has no sealed input digest; discovered child identity cannot be proven.",
      );
    }
    const mismatched = related.filter(
      (session) => session.batch?.inputManifestSha256 !== lane.inputManifestSha256,
    );
    if (mismatched.length > 0) {
      return orphanAmbiguity(
        lane,
        `Discovered child input digest differs from the parent seal: ${mismatched.map((entry) => entry.id).join(", ")}.`,
      );
    }
    const candidates = related.sort(
      (left, right) =>
        (right.batch?.attempt ?? 0) - (left.batch?.attempt ?? 0) ||
        right.createdAt.localeCompare(left.createdAt),
    );
    const attemptsByNumber = new Map<number, SessionMetadata[]>();
    for (const candidate of candidates) {
      const attempt = candidate.batch?.attempt ?? 1;
      attemptsByNumber.set(attempt, [...(attemptsByNumber.get(attempt) ?? []), candidate]);
    }
    const duplicateAttempt = [...attemptsByNumber.entries()].find(
      ([, entries]) => entries.length > 1,
    );
    if (duplicateAttempt) {
      return orphanAmbiguity(
        lane,
        `Multiple children claim attempt ${duplicateAttempt[0]}: ${duplicateAttempt[1].map((entry) => entry.id).join(", ")}.`,
      );
    }
    const committed = candidates.filter(childMayHaveCommittedPrompt);
    if (committed.length > 1) {
      return orphanAmbiguity(
        lane,
        `Multiple discovered children may have committed a Pro turn: ${committed.map((entry) => entry.id).join(", ")}.`,
      );
    }
    const selected = candidates[0];
    const attempts = candidates
      .map((session) => ({
        attempt: session.batch?.attempt ?? 1,
        sessionId: session.id,
        createdAt: session.createdAt,
        phase: inferAttemptPhase(session),
        ...(childMayHaveStarted(session) ? { dispatchStartedAt: session.createdAt } : {}),
        ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      }))
      .sort((left, right) => left.attempt - right.attempt);
    return {
      ...lane,
      sessionId: selected!.id,
      inputManifestSha256: lane.inputManifestSha256,
      outputPath: lane.outputPath ?? childOutputPath(state.batchId, lane.id, lane.role),
      attempts,
    };
  };
  return {
    ...state,
    lanes: state.lanes.map(attach),
    ...(state.synthesis ? { synthesis: attach(state.synthesis) } : {}),
  };
}

export function deriveLaneSessionState(
  metadata: SessionMetadata | null,
  lane?: BatchLaneState,
  options: { actionSettled?: boolean } = {},
): DerivedLaneSessionState {
  if (!metadata) {
    return {
      status: "error",
      clearReservation: true,
      lastError: {
        code: "batch-child-session-missing",
        message: "Child session metadata is missing.",
      },
    };
  }
  if (metadata.status === "completed" || metadata.status === "partial") {
    return { status: "completed", clearReservation: true };
  }
  const details = metadata.error?.details as
    | {
        code?: string;
        stage?: string;
        retrySafe?: boolean;
        promptSubmitted?: boolean;
        submissionCommitted?: boolean;
        runtime?: {
          promptSubmitted?: boolean;
          proTurnCommitted?: boolean;
          controllerPid?: number;
        };
      }
    | undefined;
  const runtime = metadata.browser?.runtime;
  const promptSubmitted =
    details?.promptSubmitted ?? details?.runtime?.promptSubmitted ?? runtime?.promptSubmitted;
  const submissionCommitted =
    details?.submissionCommitted ?? details?.runtime?.proTurnCommitted ?? runtime?.proTurnCommitted;
  const retrySafePreSubmit =
    details?.retrySafe === true && promptSubmitted === false && submissionCommitted === false;
  if (retrySafePreSubmit) {
    return {
      status: "recoverable",
      clearReservation: true,
      lastError: {
        code: details.code ?? "chatgpt-submission-gate",
        message:
          metadata.errorMessage ??
          metadata.error?.message ??
          "ChatGPT blocked the prompt before commit.",
        retrySafe: true,
      },
    };
  }
  if (metadata.status === "pending") {
    if (
      !options.actionSettled &&
      lane?.dispatchReservation &&
      isProcessAlive(lane.dispatchReservation.pid)
    ) {
      return { status: lane.status === "claimed" ? "claimed" : "running" };
    }
    if (lane?.attempts.at(-1)?.dispatchStartedAt) {
      return indeterminateDispatch(metadata.id);
    }
    return { status: "session-created", clearReservation: true };
  }
  if (metadata.status === "running") {
    const activeController =
      isProcessAlive(runtime?.controllerPid) || isProcessAlive(details?.runtime?.controllerPid);
    if (
      !options.actionSettled &&
      (activeController ||
        (lane?.dispatchReservation && isProcessAlive(lane.dispatchReservation.pid)))
    ) {
      return { status: "running" };
    }
    if (!runtime) {
      return indeterminateDispatch(metadata.id);
    }
  }
  const terminalTiming = isTerminalProResponseTimingCode(details?.code);
  const recoverableConversation = hasRecoverableChatGptConversation(runtime);
  const recoverableTarget = runtime?.browserDisposition === "recoverable";
  if (!terminalTiming && (recoverableConversation || recoverableTarget)) {
    return {
      status: "recoverable",
      clearReservation: true,
      lastError: metadata.errorMessage
        ? { code: details?.code, message: metadata.errorMessage, retrySafe: false }
        : undefined,
    };
  }
  return {
    status: "error",
    clearReservation: true,
    lastError: {
      code: details?.code,
      message:
        metadata.errorMessage ??
        metadata.error?.message ??
        `Child session ended as ${metadata.status}.`,
      retrySafe: false,
    },
  };
}

export function classifyParentStatus(state: BatchStateV1): BatchStateV1["status"] {
  if (state.status === "error" && state.lanes.every((lane) => !lane.sessionId)) return "error";
  if (
    state.status === "interrupted" &&
    state.lanes.some((lane) => lane.status !== "completed" && !lane.acceptedMissing)
  ) {
    return "interrupted";
  }
  const required = state.lanes.filter((lane) => !lane.acceptedMissing);
  if (
    required.some(
      (lane) =>
        lane.status === "recoverable" ||
        lane.status === "running" ||
        lane.status === "claimed" ||
        lane.status === "session-created" ||
        lane.status === "sealed" ||
        lane.status === "pending",
    )
  ) {
    return "awaiting-recovery";
  }
  if (required.some((lane) => lane.status === "error" || lane.status === "indeterminate")) {
    return "awaiting-owner";
  }
  if (required.every((lane) => lane.status === "completed")) {
    if (state.synthesis) {
      if (state.synthesis.acceptedMissing || state.synthesis.status === "abandoned") {
        return "partial";
      }
      if (state.synthesis.status === "completed") {
        return state.ownerDecisions?.some((decision) => decision.type === "allow-partial")
          ? "partial"
          : "completed";
      }
      if (
        state.synthesis.status === "recoverable" ||
        state.synthesis.status === "running" ||
        state.synthesis.status === "claimed" ||
        state.synthesis.status === "session-created" ||
        state.synthesis.status === "sealed"
      ) {
        return "awaiting-recovery";
      }
      if (state.synthesis.status === "error" || state.synthesis.status === "indeterminate")
        return "awaiting-owner";
      return "sealed";
    }
    return state.ownerDecisions?.some((decision) => decision.type === "allow-partial")
      ? "partial"
      : "completed";
  }
  return state.status;
}

function indeterminateDispatch(sessionId: string): DerivedLaneSessionState {
  return {
    status: "indeterminate",
    clearReservation: true,
    lastError: {
      code: "batch-dispatch-outcome-indeterminate",
      message: `Worker entered dispatch for session ${sessionId}, but no explicit safe pre-submit receipt or reattachable runtime proves that a new send is safe.`,
      retrySafe: false,
    },
  };
}

function orphanAmbiguity(lane: BatchLaneState, message: string): BatchLaneState {
  return {
    ...lane,
    status: "indeterminate",
    lastError: {
      code: "batch-orphan-child-ambiguity",
      message,
      retrySafe: false,
    },
  };
}

function childMayHaveStarted(metadata: SessionMetadata): boolean {
  return metadata.status !== "pending" || childMayHaveCommittedPrompt(metadata);
}

function childMayHaveCommittedPrompt(metadata: SessionMetadata): boolean {
  const details = metadata.error?.details as
    | {
        promptSubmitted?: boolean;
        submissionCommitted?: boolean;
        runtime?: { promptSubmitted?: boolean; proTurnCommitted?: boolean };
      }
    | undefined;
  const runtime = metadata.browser?.runtime;
  return Boolean(
    details?.promptSubmitted ||
    details?.submissionCommitted ||
    details?.runtime?.promptSubmitted ||
    details?.runtime?.proTurnCommitted ||
    runtime?.promptSubmitted ||
    runtime?.proTurnCommitted,
  );
}

function inferAttemptPhase(metadata: SessionMetadata): BatchLaneState["attempts"][number]["phase"] {
  if (metadata.status === "completed" || metadata.status === "partial") return "completed";
  if (metadata.status === "error") return childMayHaveStarted(metadata) ? "failed" : "created";
  return childMayHaveStarted(metadata) ? "started" : "created";
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function childOutputPath(batchId: string, laneId: string, role: "lane" | "synthesis"): string {
  return role === "lane"
    ? path.join(getBatchPaths(batchId).outputs, "lanes", laneId, "answer.md")
    : path.join(getBatchPaths(batchId).outputs, "synthesis", "answer.md");
}
