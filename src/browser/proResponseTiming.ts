import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { BrowserRuntimeMetadata, ProResponseTimingReceipt } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { BrowserAttachment, BrowserAutomationConfig } from "./types.js";

type ProResponseTimingConfig = Pick<
  BrowserAutomationConfig,
  "desiredModel" | "modelStrategy" | "thinkingTime"
>;

export const MAX_TINY_PRO_INPUT_TOKENS = 256;
export const MAX_TINY_PRO_ATTACHMENT_BYTES = 16 * 1024;
export const MIN_SUBSTANTIVE_PRO_RESPONSE_MS = 60_000;

const TERMINAL_PRO_RESPONSE_TIMING_CODES = new Set([
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
  return typeof code === "string" && TERMINAL_PRO_RESPONSE_TIMING_CODES.has(code);
}

export function requiresProResponseTiming(config: ProResponseTimingConfig): boolean {
  if (config.modelStrategy === "ignore") return false;
  return normalizeThinkingTimeLevel(config.thinkingTime) === "pro";
}

function isValidNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidWorkloadValue(value: unknown): value is number {
  return isValidNonNegativeNumber(value) && Number.isSafeInteger(value);
}

export function elapsedSinceDispatch(
  dispatchAt: string | undefined,
  capturedAt: Date,
): number | undefined {
  if (!dispatchAt) return undefined;
  const dispatchMs = Date.parse(dispatchAt);
  const elapsedMs = capturedAt.getTime() - dispatchMs;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}

function resolveRecordedElapsed(
  runtime: BrowserRuntimeMetadata,
  capturedAt: Date,
): { dispatchAt: string | undefined; responseElapsedMs: number | undefined } {
  const dispatchAt = runtime.proDispatchAt ?? runtime.opencliDispatchAt;
  const storedElapsed = runtime.proResponseElapsedMs ?? runtime.opencliResponseElapsedMs;
  const hasStoredElapsedMarker =
    runtime.proResponseElapsedMs !== undefined || runtime.opencliResponseElapsedMs !== undefined;
  return {
    dispatchAt,
    responseElapsedMs: hasStoredElapsedMarker
      ? isValidNonNegativeNumber(storedElapsed)
        ? storedElapsed
        : undefined
      : elapsedSinceDispatch(dispatchAt, capturedAt),
  };
}

export function recordProResponseTiming(
  runtime: BrowserRuntimeMetadata,
  capturedAt: Date,
  options: { requireTimestamp?: boolean } = {},
): BrowserRuntimeMetadata {
  const { dispatchAt, responseElapsedMs } = resolveRecordedElapsed(runtime, capturedAt);
  const validDispatch = elapsedSinceDispatch(dispatchAt, capturedAt) !== undefined;
  const enrichedRuntime: BrowserRuntimeMetadata = {
    ...runtime,
    proDispatchAt: dispatchAt,
    proResponseElapsedMs: responseElapsedMs,
  };

  if (options.requireTimestamp && !validDispatch) {
    throw new BrowserAutomationError(
      "Browser transport returned an answer without the dispatch timestamp required for durable Pro response timing (the marker was missing or invalid).",
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
    if (!isValidWorkloadValue(sizeBytes) || !Number.isSafeInteger(total + sizeBytes)) {
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
  if (
    !isValidWorkloadValue(workload.inputTokens) ||
    !isValidWorkloadValue(workload.attachmentBytes)
  ) {
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
  if (runtime.proDispatchAt) return runtime;
  return { ...runtime, proDispatchAt: dispatchedAt.toISOString() };
}

export function markProPromptCommitted(
  runtime: BrowserRuntimeMetadata,
  committedUserTurnIndex: number | null,
): BrowserRuntimeMetadata {
  const committedTurnIndex =
    typeof committedUserTurnIndex === "number" &&
    Number.isSafeInteger(committedUserTurnIndex) &&
    committedUserTurnIndex >= 0
      ? committedUserTurnIndex
      : undefined;
  return {
    ...runtime,
    proTurnCommitted: true,
    proCommittedTurnIndex: committedTurnIndex,
  };
}

function throwFastProResponseUntrusted(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  responseElapsedMs: number;
  inputTokens?: number;
  attachmentBytes?: number;
  workloadMetadata: "complete" | "unknown";
}): never {
  const seconds = Math.max(0, Math.round(args.responseElapsedMs / 1000));
  const workloadLabel =
    args.workloadMetadata === "complete" ? "substantive" : "legacy workload-unknown";
  throw new BrowserAutomationError(
    `Oracle rejected a ${workloadLabel} Pro reply captured ${seconds}s after dispatch because the workload completed implausibly quickly.`,
    {
      stage: "response-timing",
      code: "pro-fast-substantive-response-untrusted",
      runtime: args.runtime,
      responseElapsedMs: args.responseElapsedMs,
      thresholdMs: MIN_SUBSTANTIVE_PRO_RESPONSE_MS,
      ...(args.inputTokens === undefined ? {} : { inputTokens: args.inputTokens }),
      ...(args.attachmentBytes === undefined ? {} : { attachmentBytes: args.attachmentBytes }),
      workloadMetadata: args.workloadMetadata,
      tinyInputTokenLimit: MAX_TINY_PRO_INPUT_TOKENS,
      tinyAttachmentByteLimit: MAX_TINY_PRO_ATTACHMENT_BYTES,
      assistantSha256: createHash("sha256").update(args.answer).digest("hex"),
    },
  );
}

function throwIndeterminateProTiming(runtime: BrowserRuntimeMetadata): never {
  throw new BrowserAutomationError(
    "Oracle found a Pro timing marker but could not establish a valid response elapsed time.",
    {
      stage: "response-timing",
      code: "pro-response-timing-indeterminate",
      runtime,
    },
  );
}

function hasProTimingMarker(runtime: BrowserRuntimeMetadata): boolean {
  return (
    runtime.proDispatchAt !== undefined ||
    runtime.proResponseElapsedMs !== undefined ||
    runtime.opencliDispatchAt !== undefined ||
    runtime.opencliResponseElapsedMs !== undefined
  );
}

export function assertProResponseTimingAdmission(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  inputTokens?: number;
  attachmentBytes?: number;
}): void {
  const storedElapsed = args.runtime.proResponseElapsedMs ?? args.runtime.opencliResponseElapsedMs;
  if (!isValidNonNegativeNumber(storedElapsed)) {
    if (hasProTimingMarker(args.runtime)) {
      throwIndeterminateProTiming(args.runtime);
    }
    return;
  }

  const workloadComplete =
    isValidWorkloadValue(args.inputTokens) && isValidWorkloadValue(args.attachmentBytes);
  if (!workloadComplete) {
    if (storedElapsed < MIN_SUBSTANTIVE_PRO_RESPONSE_MS) {
      throwFastProResponseUntrusted({
        answer: args.answer,
        runtime: args.runtime,
        responseElapsedMs: storedElapsed,
        workloadMetadata: "unknown",
      });
    }
    return;
  }

  if (
    (args.inputTokens as number) <= MAX_TINY_PRO_INPUT_TOKENS &&
    (args.attachmentBytes as number) <= MAX_TINY_PRO_ATTACHMENT_BYTES
  ) {
    return;
  }
  if (storedElapsed >= MIN_SUBSTANTIVE_PRO_RESPONSE_MS) return;

  throwFastProResponseUntrusted({
    answer: args.answer,
    runtime: args.runtime,
    responseElapsedMs: storedElapsed,
    inputTokens: args.inputTokens,
    attachmentBytes: args.attachmentBytes,
    workloadMetadata: "complete",
  });
}

export function assertProResponseWorkloadTiming(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  inputTokens: number;
  attachmentBytes: number;
}): void {
  assertProResponseTimingAdmission(args);
}

function appendProResponseTimingReceipt(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
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
  const timedRuntime = recordProResponseTiming(args.runtime, args.capturedAt ?? new Date(), {
    requireTimestamp: true,
  });
  if (timedRuntime.proTurnIndex !== undefined && timedRuntime.proTurnCommitted !== true) {
    throw new BrowserAutomationError(
      "Browser transport captured a Pro answer before the active prompt was verified as committed.",
      {
        stage: "response-timing",
        code: "pro-turn-not-committed",
        runtime: timedRuntime,
      },
    );
  }
  if (
    timedRuntime.proTurnIndex !== undefined &&
    (!timedRuntime.proPromptSha256 || timedRuntime.proCommittedTurnIndex === undefined)
  ) {
    throw new BrowserAutomationError(
      "Browser transport captured a Pro answer without the committed turn identity required for recovery.",
      {
        stage: "response-timing",
        code: "pro-turn-identity-missing",
        runtime: timedRuntime,
      },
    );
  }
  const inputTokens = timedRuntime.proInputTokens;
  const attachmentBytes = timedRuntime.proAttachmentBytes;
  if (!isValidWorkloadValue(inputTokens) || !isValidWorkloadValue(attachmentBytes)) {
    throw new BrowserAutomationError(
      "Browser transport captured a Pro answer without the turn workload receipt required for timing verification.",
      {
        stage: "response-timing",
        code: "pro-workload-receipt-missing",
        runtime: timedRuntime,
      },
    );
  }
  assertProResponseTimingAdmission({
    answer: args.answer,
    runtime: timedRuntime,
    inputTokens,
    attachmentBytes,
  });
  return appendProResponseTimingReceipt(timedRuntime);
}

export function verifyStoredProResponseWorkloadTiming(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  capturedAt: Date;
}): BrowserRuntimeMetadata {
  if (!hasProTimingMarker(args.runtime)) return args.runtime;

  const timedRuntime = recordProResponseTiming(args.runtime, args.capturedAt);
  if (!isValidNonNegativeNumber(timedRuntime.proResponseElapsedMs)) {
    throwIndeterminateProTiming(timedRuntime);
  }
  assertProResponseTimingAdmission({
    answer: args.answer,
    runtime: timedRuntime,
    inputTokens: timedRuntime.proInputTokens,
    attachmentBytes: timedRuntime.proAttachmentBytes,
  });
  const hasCompleteDirectReceipt =
    timedRuntime.proTurnIndex !== undefined &&
    timedRuntime.proDispatchAt !== undefined &&
    isValidNonNegativeNumber(timedRuntime.proResponseElapsedMs) &&
    isValidWorkloadValue(timedRuntime.proInputTokens) &&
    isValidWorkloadValue(timedRuntime.proAttachmentBytes);
  return hasCompleteDirectReceipt ? appendProResponseTimingReceipt(timedRuntime) : timedRuntime;
}
