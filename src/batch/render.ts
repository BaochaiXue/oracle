import { readVerifiedBatchAnswer } from "./answers.js";
import type { BatchManifestV1, BatchStateV1 } from "./types.js";

export interface RenderBatchOptions {
  laneId?: string;
  all?: boolean;
}

export async function renderBatch(
  manifest: BatchManifestV1,
  state: BatchStateV1,
  options: RenderBatchOptions = {},
): Promise<string> {
  const lines = [
    `# Batch Oracle: ${state.slug}`,
    "",
    `- Batch ID: ${state.batchId}`,
    `- Project: ${state.project}`,
    `- Status: ${state.status}`,
    `- Objective: ${state.objective}`,
    `- Barrier: ${state.barrierClosedAt ? `closed at ${state.barrierClosedAt}` : "open"}`,
    "",
    "## Lanes",
    "",
  ];
  for (const laneSpec of manifest.lanes) {
    const lane = state.lanes.find((entry) => entry.id === laneSpec.id);
    if (!lane) continue;
    lines.push(
      `- ${lane.id}: ${lane.status}; session=${lane.sessionId ?? "none"}; raw=${lane.outputPath ?? "unavailable"}`,
    );
    if (lane.lastError) lines.push(`  - error: ${lane.lastError.message}`);
  }
  const requestedLanes = options.laneId
    ? manifest.lanes.filter((lane) => lane.id === options.laneId)
    : options.all
      ? manifest.lanes
      : [];
  if (options.laneId && requestedLanes.length === 0) {
    throw new Error(`Unknown batch lane: ${options.laneId}`);
  }
  for (const laneSpec of requestedLanes) {
    const lane = state.lanes.find((entry) => entry.id === laneSpec.id);
    if (!lane?.outputPath) continue;
    const verified = await readVerifiedBatchAnswer(state.batchId, lane);
    lines.push("", `## Raw answer: ${lane.id}`, "", verified.answer.toString("utf8"));
  }
  if (state.synthesis) {
    lines.push(
      "",
      "## Synthesis",
      "",
      `- Status: ${state.synthesis.status}`,
      `- Session: ${state.synthesis.sessionId ?? "none"}`,
      `- Raw path: ${state.synthesis.outputPath ?? "unavailable"}`,
    );
    if (state.synthesis.outputPath && state.synthesis.status === "completed") {
      const verified = await readVerifiedBatchAnswer(state.batchId, state.synthesis);
      lines.push("", verified.answer.toString("utf8"));
    }
  }
  const missing = state.lanes.filter((lane) => lane.status !== "completed");
  if (missing.length > 0) {
    lines.push("", "## Missing or incomplete lanes", "");
    for (const lane of missing) lines.push(`- ${lane.id}: ${lane.status}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildBatchStatusProjection(state: BatchStateV1) {
  return {
    schemaVersion: state.schemaVersion,
    batchId: state.batchId,
    slug: state.slug,
    project: state.project,
    status: state.status,
    objective: state.objective,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    barrierClosedAt: state.barrierClosedAt,
    admittedSourceDrift: state.admittedSourceDrift ?? state.workspaceDrift ?? false,
    laneCompletion: {
      completed: state.lanes.filter((lane) => lane.status === "completed").length,
      total: state.lanes.length,
    },
    lanes: state.lanes.map((lane) => ({
      id: lane.id,
      status: lane.status,
      sessionId: lane.sessionId,
      attempt: lane.attempts.at(-1)?.attempt,
      inputManifestSha256: lane.inputManifestSha256,
      outputPath: lane.outputPath,
      acceptedMissing: lane.acceptedMissing ?? false,
      abandonedAt: lane.abandonedAt,
      recoverable: lane.status === "recoverable",
      error: lane.lastError,
    })),
    synthesis: state.synthesis
      ? {
          id: state.synthesis.id,
          status: state.synthesis.status,
          sessionId: state.synthesis.sessionId,
          outputPath: state.synthesis.outputPath,
          error: state.synthesis.lastError,
        }
      : null,
    ownerAction: ownerAction(state),
    resumeCommand: `oracle batch resume ${state.batchId}`,
  };
}

function ownerAction(state: BatchStateV1): string | null {
  if (state.status === "awaiting-recovery" || state.status === "interrupted") {
    return `Run: oracle batch resume ${state.batchId}`;
  }
  if (state.status === "awaiting-owner") {
    const unresolved = state.lanes.find(
      (lane) => lane.status !== "completed" && !lane.acceptedMissing,
    );
    return state.synthesis
      ? unresolved
        ? `Resolve ${unresolved.id}, or explicitly close it with: oracle batch accept-missing ${state.batchId} --lane ${unresolved.id} --reason <reason>`
        : `Continue accepted partial synthesis with: oracle batch resume ${state.batchId} --allow-partial`
      : "Resolve failed lanes; this batch has no synthesis stage.";
  }
  return null;
}
