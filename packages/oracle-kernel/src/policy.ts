import type { JobState } from "./schema.js";

export type AutomaticJobAction =
  | "schedule"
  | "prepare"
  | "continue-reserved-dispatch"
  | "recover-commit"
  | "capture"
  | "none";

export type JobActionPolicy = {
  automaticAction: AutomaticJobAction;
  sendAuthority: "available-before-at-risk" | "forbidden";
  ownerAction: "none" | "create-new-attempt" | "abandon" | "abandon-only";
};

export function getJobActionPolicy(state: JobState): JobActionPolicy {
  switch (state.kind) {
    case "queued":
      return {
        automaticAction: state.blockedBy ? "none" : "schedule",
        sendAuthority: "available-before-at-risk",
        ownerAction: "none",
      };
    case "preparing":
    case "ready-to-dispatch":
      return {
        automaticAction: "prepare",
        sendAuthority: "available-before-at-risk",
        ownerAction: "none",
      };
    case "dispatch-reserved":
      return {
        automaticAction: "continue-reserved-dispatch",
        sendAuthority: "available-before-at-risk",
        ownerAction: "none",
      };
    case "dispatch-at-risk":
      return {
        automaticAction: "recover-commit",
        sendAuthority: "forbidden",
        ownerAction: "abandon-only",
      };
    case "committed":
    case "capturing":
      return {
        automaticAction: "capture",
        sendAuthority: "forbidden",
        ownerAction: "abandon",
      };
    case "recoverable":
      return state.basis === "committed-capture"
        ? { automaticAction: "capture", sendAuthority: "forbidden", ownerAction: "abandon" }
        : {
            automaticAction: "none",
            sendAuthority: "forbidden",
            ownerAction: "create-new-attempt",
          };
    case "ambiguous":
      return {
        automaticAction: "none",
        sendAuthority: "forbidden",
        ownerAction: "abandon-only",
      };
    case "completed":
    case "canceled-unsent":
    case "abandoned":
      return { automaticAction: "none", sendAuthority: "forbidden", ownerAction: "none" };
    case "failed-unsent":
      return {
        automaticAction: "none",
        sendAuthority: "forbidden",
        ownerAction: "create-new-attempt",
      };
  }
}
