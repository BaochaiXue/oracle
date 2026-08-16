import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { BrowserRuntimeMetadata, ProResponseTimingReceipt } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { BrowserAttachment, BrowserAutomationConfig } from "./types.js";

type ProResponseTimingConfig = Pick<BrowserAutomationConfig, "modelStrategy" | "thinkingTime">;

export const MAX_TINY_PRO_INPUT_TOKENS = 256;
export const MAX_TINY_PRO_ATTACHMENT_BYTES = 16 * 1024;
export const MIN_SUBSTANTIVE_PRO_RESPONSE_MS = 60_000;

const TERMINAL_CODES = new Set([
  "dispatch-timestamp-missing",
  "pro-attachment-size-invalid",
  "pro-attachment-size-unavailable",
  "pro-fast-substantive-response-untrusted",
  "pro-response-timing-indeterminate",
  "pro-turn-identity-mismatch",
  "pro-turn-identity-missing",
  "pro-turn-not-committed",
  "pro-workload-receipt-invalid",
  "pro-workload-receipt-missing",
]);

export function isTerminalProResponseTimingCode(code: unknown): boolean {
  return typeof code === "string" && TERMINAL_CODES.has(code);
}

export function requiresProResponseTiming(config: ProResponseTimingConfig): boolean {
  return (
    config.modelStrategy !== "ignore" && normalizeThinkingTimeLevel(config.thinkingTime) === "pro"
  );
}

function isValidElapsed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidWorkload(value: unknown): value is number {
  return isValidElapsed(value) && Number.isSafeInteger(value);
}

export function elapsedSinceDispatch(
  dispatchAt: string | undefined,
  capturedAt: Date,
): number | undefined {
  if (!dispatchAt) return undefined;
  const elapsedMs = capturedAt.getTime() - Date.parse(dispatchAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}

export function recordProResponseTiming(
  runtime: BrowserRuntimeMetadata,
  capturedAt: Date,
  options: { requireTimestamp?: boolean } = {},
): BrowserRuntimeMetadata {
  const elapsedFromDispatch = elapsedSinceDispatch(runtime.proDispatchAt, capturedAt);
  const responseElapsedMs =
    runtime.proResponseElapsedMs === undefined
      ? elapsedFromDispatch
      : isValidElapsed(runtime.proResponseElapsedMs)
        ? runtime.proResponseElapsedMs
        : undefined;
  const enrichedRuntime = { ...runtime, proResponseElapsedMs: responseElapsedMs };

  if (options.requireTimestamp && elapsedFromDispatch === undefined) {
    throw new BrowserAutomationError(
      "Browser returned an answer without a valid Pro dispatch timestamp.",
      {
        stage: "response-timing",
        code: "dispatch-timestamp-missing",
        runtime: enrichedRuntime,
      },
    );
  }
  return enrichedRuntime;
}

export function normalizeProPromptIdentity(prompt: string): string {
  let text = prompt.toLowerCase();
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/gu, " $1 ");
  text = text.replace(/```/gu, " ");
  text = text.replace(/`([^`]*)`/gu, "$1");
  return text.replace(/\s+/gu, " ").trim();
}

export function hashProPromptIdentity(prompt: string): string {
  return createHash("sha256").update(normalizeProPromptIdentity(prompt)).digest("hex");
}

export async function resolveProAttachmentBytes(attachments: BrowserAttachment[]): Promise<number> {
  let total = 0;
  for (const attachment of attachments) {
    let sizeBytes = attachment.sizeBytes;
    if (sizeBytes === undefined) {
      try {
        sizeBytes = (await stat(attachment.path)).size;
      } catch (error) {
        throw new BrowserAutomationError(
          "Oracle could not establish an attachment size before Pro dispatch.",
          {
            stage: "response-timing",
            code: "pro-attachment-size-unavailable",
            attachment: attachment.displayPath,
          },
          error,
        );
      }
    }
    if (!isValidWorkload(sizeBytes) || !Number.isSafeInteger(total + sizeBytes)) {
      throw new BrowserAutomationError(
        "Oracle received an invalid attachment size before Pro dispatch.",
        {
          stage: "response-timing",
          code: "pro-attachment-size-invalid",
          attachment: attachment.displayPath,
        },
      );
    }
    total += sizeBytes;
  }
  return total;
}

export function beginProResponseTimingTurn(
  runtime: BrowserRuntimeMetadata,
  workload: { inputTokens: number; attachmentBytes: number; prompt: string },
): BrowserRuntimeMetadata {
  if (!isValidWorkload(workload.inputTokens) || !isValidWorkload(workload.attachmentBytes)) {
    throw new BrowserAutomationError("Oracle could not establish the Pro turn workload.", {
      stage: "response-timing",
      code: "pro-workload-receipt-invalid",
      runtime,
    });
  }
  return {
    ...runtime,
    proDispatchAt: undefined,
    proResponseElapsedMs: undefined,
    proInputTokens: workload.inputTokens,
    proAttachmentBytes: workload.attachmentBytes,
    proTurnIndex: runtime.proResponseTimingReceipts?.length ?? 0,
    proTurnCommitted: false,
    proPromptSha256: hashProPromptIdentity(workload.prompt),
    proCommittedTurnIndex: undefined,
  };
}

export function markProPromptDispatched(
  runtime: BrowserRuntimeMetadata,
  dispatchedAt = new Date(),
): BrowserRuntimeMetadata {
  return runtime.proDispatchAt
    ? runtime
    : { ...runtime, proDispatchAt: dispatchedAt.toISOString() };
}

export function markProPromptCommitted(
  runtime: BrowserRuntimeMetadata,
  committedUserTurnIndex: number | null,
): BrowserRuntimeMetadata {
  const index =
    typeof committedUserTurnIndex === "number" &&
    Number.isSafeInteger(committedUserTurnIndex) &&
    committedUserTurnIndex >= 0
      ? committedUserTurnIndex
      : undefined;
  return { ...runtime, proTurnCommitted: true, proCommittedTurnIndex: index };
}

function hasTimingMarker(runtime: BrowserRuntimeMetadata): boolean {
  return runtime.proDispatchAt !== undefined || runtime.proResponseElapsedMs !== undefined;
}

function throwIndeterminate(runtime: BrowserRuntimeMetadata): never {
  throw new BrowserAutomationError(
    "Oracle found a Pro timing marker but could not establish a valid response elapsed time.",
    { stage: "response-timing", code: "pro-response-timing-indeterminate", runtime },
  );
}

function throwFast(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  responseElapsedMs: number;
  inputTokens?: number;
  attachmentBytes?: number;
  workloadMetadata: "complete" | "unknown";
}): never {
  throw new BrowserAutomationError(
    `Oracle rejected a ${args.workloadMetadata === "complete" ? "substantive" : "workload-unknown"} Pro reply captured ${Math.round(args.responseElapsedMs / 1000)}s after dispatch.`,
    {
      stage: "response-timing",
      code: "pro-fast-substantive-response-untrusted",
      runtime: args.runtime,
      responseElapsedMs: args.responseElapsedMs,
      thresholdMs: MIN_SUBSTANTIVE_PRO_RESPONSE_MS,
      inputTokens: args.inputTokens,
      attachmentBytes: args.attachmentBytes,
      workloadMetadata: args.workloadMetadata,
      assistantSha256: createHash("sha256").update(args.answer).digest("hex"),
    },
  );
}

export function assertProResponseTimingAdmission(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  inputTokens?: number;
  attachmentBytes?: number;
}): void {
  const elapsed = args.runtime.proResponseElapsedMs;
  if (!isValidElapsed(elapsed)) {
    if (hasTimingMarker(args.runtime)) throwIndeterminate(args.runtime);
    return;
  }
  const inputTokens = args.inputTokens;
  const attachmentBytes = args.attachmentBytes;
  if (!isValidWorkload(inputTokens) || !isValidWorkload(attachmentBytes)) {
    if (elapsed < MIN_SUBSTANTIVE_PRO_RESPONSE_MS) {
      throwFast({ ...args, responseElapsedMs: elapsed, workloadMetadata: "unknown" });
    }
    return;
  }
  if (
    inputTokens <= MAX_TINY_PRO_INPUT_TOKENS &&
    attachmentBytes <= MAX_TINY_PRO_ATTACHMENT_BYTES
  ) {
    return;
  }
  if (elapsed < MIN_SUBSTANTIVE_PRO_RESPONSE_MS) {
    throwFast({ ...args, responseElapsedMs: elapsed, workloadMetadata: "complete" });
  }
}

function appendReceipt(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const receipt: ProResponseTimingReceipt = {
    turnIndex: runtime.proTurnIndex as number,
    dispatchAt: runtime.proDispatchAt as string,
    responseElapsedMs: runtime.proResponseElapsedMs as number,
    inputTokens: runtime.proInputTokens as number,
    attachmentBytes: runtime.proAttachmentBytes as number,
  };
  const receipts = (runtime.proResponseTimingReceipts ?? []).filter(
    (entry) => entry.turnIndex !== receipt.turnIndex,
  );
  return {
    ...runtime,
    proResponseTimingReceipts: [...receipts, receipt].sort(
      (left, right) => left.turnIndex - right.turnIndex,
    ),
  };
}

export function completeProResponseTimingTurn(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  capturedAt?: Date;
}): BrowserRuntimeMetadata {
  const runtime = recordProResponseTiming(args.runtime, args.capturedAt ?? new Date(), {
    requireTimestamp: true,
  });
  if (runtime.proTurnCommitted !== true) {
    throw new BrowserAutomationError(
      "Browser captured a Pro answer before the prompt was verified as committed.",
      { stage: "response-timing", code: "pro-turn-not-committed", runtime },
    );
  }
  if (!runtime.proPromptSha256 || runtime.proCommittedTurnIndex === undefined) {
    throw new BrowserAutomationError(
      "Browser captured a Pro answer without the committed turn identity required for recovery.",
      { stage: "response-timing", code: "pro-turn-identity-missing", runtime },
    );
  }
  if (!isValidWorkload(runtime.proInputTokens) || !isValidWorkload(runtime.proAttachmentBytes)) {
    throw new BrowserAutomationError(
      "Browser captured a Pro answer without the workload receipt required for timing verification.",
      { stage: "response-timing", code: "pro-workload-receipt-missing", runtime },
    );
  }
  assertProResponseTimingAdmission({
    answer: args.answer,
    runtime,
    inputTokens: runtime.proInputTokens,
    attachmentBytes: runtime.proAttachmentBytes,
  });
  return appendReceipt(runtime);
}

export function verifyStoredProResponseWorkloadTiming(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  capturedAt: Date;
}): BrowserRuntimeMetadata {
  if (!hasTimingMarker(args.runtime)) return args.runtime;
  const runtime = recordProResponseTiming(args.runtime, args.capturedAt);
  if (!isValidElapsed(runtime.proResponseElapsedMs)) throwIndeterminate(runtime);
  assertProResponseTimingAdmission({
    answer: args.answer,
    runtime,
    inputTokens: runtime.proInputTokens,
    attachmentBytes: runtime.proAttachmentBytes,
  });
  const complete =
    runtime.proTurnIndex !== undefined &&
    runtime.proDispatchAt !== undefined &&
    isValidWorkload(runtime.proInputTokens) &&
    isValidWorkload(runtime.proAttachmentBytes);
  return complete ? appendReceipt(runtime) : runtime;
}
