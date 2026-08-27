import type { SessionMetadata } from "../sessionManager.js";

export type BatchSessionAction =
  | "attach"
  | "status"
  | "live"
  | "harvest"
  | "followup"
  | "restart"
  | "execute";

export interface BatchSessionAuthority {
  action: BatchSessionAction;
  batchId: string;
  laneId: string;
  role: "lane" | "synthesis";
  disposition: "read-only" | "reject";
  resumeCommand: string;
  guidance: string;
}

const READ_ONLY_ACTIONS = new Set<BatchSessionAction>(["attach", "status"]);

function actionGuidance(action: BatchSessionAction): string {
  switch (action) {
    case "attach":
      return "Generic session attach is read-only; inspect only current status, render, paths, and stored logs/artifacts.";
    case "status":
      return "Generic session status inspection is read-only.";
    case "live":
      return "Generic session --live is not allowed for a Batch child.";
    case "harvest":
      return "Generic session --harvest is not allowed for a Batch child.";
    case "followup":
      return "Generic browser follow-up is not allowed for a Batch child conversation.";
    case "restart":
      return "Generic session restart is not allowed for a Batch child. To start an independent consultation, create a new ordinary Oracle run instead of restarting this Batch lineage.";
    case "execute":
      return "Generic stored-session execution is not allowed for a Batch child.";
  }
}

export function resolveBatchSessionAuthority(
  metadata: SessionMetadata,
  action: BatchSessionAction,
): BatchSessionAuthority | null {
  const batch = metadata.batch;
  if (!batch) return null;
  const resumeCommand = `oracle batch resume ${batch.batchId}`;
  const identity = `batchId=${batch.batchId}, laneId=${batch.laneId}, role=${batch.role}`;
  return {
    action,
    batchId: batch.batchId,
    laneId: batch.laneId,
    role: batch.role,
    disposition: READ_ONLY_ACTIONS.has(action) ? "read-only" : "reject",
    resumeCommand,
    guidance: `Session ${metadata.id} is owned by Batch Oracle (${identity}). ${actionGuidance(action)} Recovery, retry, completion, and owner closure must go through the Batch parent. Resume with: ${resumeCommand}`,
  };
}

export function assertGenericSessionActionAllowed(
  metadata: SessionMetadata,
  action: Exclude<BatchSessionAction, "attach" | "status">,
): void {
  const authority = resolveBatchSessionAuthority(metadata, action);
  if (!authority) return;
  throw new Error(authority.guidance);
}
