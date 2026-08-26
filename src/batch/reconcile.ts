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
    if (!lane.sessionId) return lane;
    const metadata = await store.readSession(lane.sessionId);
    const derived = deriveLaneSessionState(metadata, lane);
    return {
      ...lane,
      status: derived.status,
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
    const candidates = sessions
      .filter(
        (session) =>
          session.batch?.batchId === state.batchId &&
          session.batch.laneId === lane.id &&
          session.batch.role === lane.role,
      )
      .sort(
        (left, right) =>
          (right.batch?.attempt ?? 0) - (left.batch?.attempt ?? 0) ||
          right.createdAt.localeCompare(left.createdAt),
      );
    const selected = candidates[0];
    if (!selected) return lane;
    const attempts = candidates
      .map((session) => ({
        attempt: session.batch?.attempt ?? 1,
        sessionId: session.id,
        createdAt: session.createdAt,
        ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      }))
      .sort((left, right) => left.attempt - right.attempt);
    return {
      ...lane,
      sessionId: selected.id,
      inputManifestSha256: selected.batch?.inputManifestSha256 ?? lane.inputManifestSha256,
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
    if (lane?.dispatchReservation && isProcessAlive(lane.dispatchReservation.pid)) {
      return { status: "running" };
    }
    return { status: "session-created", clearReservation: true };
  }
  if (metadata.status === "running") {
    const activeController =
      isProcessAlive(runtime?.controllerPid) || isProcessAlive(details?.runtime?.controllerPid);
    if (
      activeController ||
      (lane?.dispatchReservation && isProcessAlive(lane.dispatchReservation.pid))
    ) {
      return { status: "running" };
    }
    if (!runtime) {
      return { status: "session-created", clearReservation: true };
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
        lane.status === "session-created" ||
        lane.status === "sealed" ||
        lane.status === "pending",
    )
  ) {
    return "awaiting-recovery";
  }
  if (required.some((lane) => lane.status === "error")) {
    return "awaiting-owner";
  }
  if (required.every((lane) => lane.status === "completed")) {
    if (state.synthesis) {
      if (state.synthesis.status === "completed") {
        return state.ownerDecisions?.some((decision) => decision.type === "allow-partial")
          ? "partial"
          : "completed";
      }
      if (
        state.synthesis.status === "recoverable" ||
        state.synthesis.status === "running" ||
        state.synthesis.status === "session-created" ||
        state.synthesis.status === "sealed"
      ) {
        return "awaiting-recovery";
      }
      if (state.synthesis.status === "error") return "awaiting-owner";
      return "sealed";
    }
    return state.ownerDecisions?.some((decision) => decision.type === "allow-partial")
      ? "partial"
      : "completed";
  }
  return state.status;
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
