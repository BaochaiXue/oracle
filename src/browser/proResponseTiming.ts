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
  const provenance = assertProResponseTimingReceiptChain(runtime);
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
    proResponseTimingProvenance: provenance,
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
    runtime.opencliResponseElapsedMs !== undefined ||
    hasProResponseTimingReceiptMarker(runtime)
  );
}

export function hasProResponseTimingReceiptMarker(runtime: BrowserRuntimeMetadata): boolean {
  return (
    runtime.proTurnIndex !== undefined ||
    runtime.proTurnCommitted !== undefined ||
    runtime.proPromptSha256 !== undefined ||
    runtime.proCommittedTurnIndex !== undefined ||
    runtime.proResponseTimingReceipts !== undefined
  );
}

function receiptHasAnyCommitIdentity(receipt: ProResponseTimingReceipt): boolean {
  return (
    receipt.promptSha256 !== undefined ||
    receipt.committedUserTurnIndex !== undefined ||
    receipt.commitVerification !== undefined
  );
}

function isVerifiedProResponseTimingReceipt(receipt: ProResponseTimingReceipt): boolean {
  return (
    /^[a-f0-9]{64}$/u.test(receipt.promptSha256 ?? "") &&
    isValidWorkloadValue(receipt.committedUserTurnIndex) &&
    receipt.commitVerification === "verified"
  );
}

function throwInvalidReceiptChain(
  message: string,
  runtime: BrowserRuntimeMetadata,
  code: "pro-turn-identity-missing" | "pro-turn-identity-mismatch" | "pro-workload-receipt-invalid",
  details: Record<string, unknown> = {},
): never {
  throw new BrowserAutomationError(message, {
    stage: "response-timing",
    code,
    runtime,
    ...details,
  });
}

/**
 * Validates the durable completed-turn chain without upgrading legacy receipts.
 * A scalar may represent the latest completed receipt or one in-flight turn
 * exactly one index beyond the completed chain.
 */
export function assertProResponseTimingReceiptChain(
  runtime: BrowserRuntimeMetadata,
): NonNullable<BrowserRuntimeMetadata["proResponseTimingProvenance"]> {
  const receipts = runtime.proResponseTimingReceipts ?? [];
  let hasLegacyReceipt = false;
  let lastVerifiedCommittedUserTurnIndex: number | undefined;
  for (const [index, receipt] of receipts.entries()) {
    if (
      receipt.turnIndex !== index ||
      typeof receipt.dispatchAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.dispatchAt)) ||
      !isValidNonNegativeNumber(receipt.responseElapsedMs) ||
      !isValidWorkloadValue(receipt.inputTokens) ||
      !isValidWorkloadValue(receipt.attachmentBytes)
    ) {
      throwInvalidReceiptChain(
        "Oracle found a non-contiguous or invalid historical Pro response receipt chain.",
        runtime,
        "pro-workload-receipt-invalid",
        { receiptTurnIndex: receipt.turnIndex, expectedTurnIndex: index },
      );
    }
    if (receiptHasAnyCommitIdentity(receipt)) {
      if (!isVerifiedProResponseTimingReceipt(receipt)) {
        throwInvalidReceiptChain(
          "Oracle found a historical Pro response receipt with incomplete commit identity.",
          runtime,
          "pro-turn-identity-missing",
          { receiptTurnIndex: receipt.turnIndex },
        );
      }
      const committedUserTurnIndex = receipt.committedUserTurnIndex as number;
      if (
        lastVerifiedCommittedUserTurnIndex !== undefined &&
        committedUserTurnIndex <= lastVerifiedCommittedUserTurnIndex
      ) {
        throwInvalidReceiptChain(
          "Oracle found historical Pro receipts whose committed DOM user-turn indices did not strictly advance.",
          runtime,
          "pro-turn-identity-mismatch",
          {
            receiptTurnIndex: receipt.turnIndex,
            committedUserTurnIndex,
            previousCommittedUserTurnIndex: lastVerifiedCommittedUserTurnIndex,
          },
        );
      }
      lastVerifiedCommittedUserTurnIndex = committedUserTurnIndex;
    } else {
      hasLegacyReceipt = true;
    }
  }

  const provenance = hasLegacyReceipt ? "legacy-partial" : "verified";
  if (runtime.proResponseTimingProvenance === "verified" && provenance !== "verified") {
    throwInvalidReceiptChain(
      "Oracle refused a legacy or mixed Pro response receipt chain marked as fully verified.",
      runtime,
      "pro-turn-identity-missing",
    );
  }

  if (runtime.proTurnIndex === undefined) return provenance;
  if (!isValidWorkloadValue(runtime.proTurnIndex)) {
    throwInvalidReceiptChain(
      "Oracle found an invalid active Pro turn index.",
      runtime,
      "pro-workload-receipt-invalid",
    );
  }
  const activeTurnIndex = runtime.proTurnIndex;
  const latestCompletedIndex = receipts.length - 1;
  if (activeTurnIndex < latestCompletedIndex || activeTurnIndex > receipts.length) {
    throwInvalidReceiptChain(
      "Oracle found an active Pro turn that points behind or skips the completed receipt chain.",
      runtime,
      "pro-workload-receipt-invalid",
      { activeTurnIndex, latestCompletedIndex },
    );
  }

  const matchingReceipt = receipts[activeTurnIndex];
  if (!matchingReceipt) {
    if (runtime.proTurnCommitted === true && lastVerifiedCommittedUserTurnIndex !== undefined) {
      if (!isValidWorkloadValue(runtime.proCommittedTurnIndex)) {
        throwInvalidReceiptChain(
          "Oracle found a committed active Pro turn without a valid DOM user-turn index.",
          runtime,
          "pro-turn-identity-missing",
          { activeTurnIndex },
        );
      }
      if (runtime.proCommittedTurnIndex <= lastVerifiedCommittedUserTurnIndex) {
        throwInvalidReceiptChain(
          "Oracle found a committed active Pro turn whose DOM user-turn index did not advance beyond verified history.",
          runtime,
          "pro-turn-identity-mismatch",
          {
            activeTurnIndex,
            committedUserTurnIndex: runtime.proCommittedTurnIndex,
            previousCommittedUserTurnIndex: lastVerifiedCommittedUserTurnIndex,
          },
        );
      }
    }
    return provenance;
  }
  if (
    runtime.proDispatchAt !== matchingReceipt.dispatchAt ||
    runtime.proResponseElapsedMs !== matchingReceipt.responseElapsedMs ||
    runtime.proInputTokens !== matchingReceipt.inputTokens ||
    runtime.proAttachmentBytes !== matchingReceipt.attachmentBytes
  ) {
    throwInvalidReceiptChain(
      "Oracle found conflicting scalar and historical Pro timing/workload evidence for the same turn.",
      runtime,
      "pro-workload-receipt-invalid",
      { activeTurnIndex },
    );
  }
  if (
    isVerifiedProResponseTimingReceipt(matchingReceipt) &&
    (runtime.proTurnCommitted !== true ||
      runtime.proPromptSha256 !== matchingReceipt.promptSha256 ||
      runtime.proCommittedTurnIndex !== matchingReceipt.committedUserTurnIndex)
  ) {
    throwInvalidReceiptChain(
      "Oracle found conflicting scalar and historical Pro commit identity for the same turn.",
      runtime,
      "pro-turn-identity-mismatch",
      { activeTurnIndex },
    );
  }
  return provenance;
}

export function assertCompleteProResponseTimingReceipt(runtime: BrowserRuntimeMetadata): void {
  if (!hasProResponseTimingReceiptMarker(runtime)) return;
  if (runtime.proTurnCommitted !== true) {
    throw new BrowserAutomationError(
      "Oracle found a Pro turn receipt without a verified committed user turn.",
      { stage: "response-timing", code: "pro-turn-not-committed", runtime },
    );
  }
  if (
    !isValidWorkloadValue(runtime.proTurnIndex) ||
    !/^[a-f0-9]{64}$/u.test(runtime.proPromptSha256 ?? "") ||
    !isValidWorkloadValue(runtime.proCommittedTurnIndex)
  ) {
    throw new BrowserAutomationError(
      "Oracle found a Pro turn receipt without the committed turn identity required for recovery.",
      { stage: "response-timing", code: "pro-turn-identity-missing", runtime },
    );
  }
  if (
    !isValidWorkloadValue(runtime.proInputTokens) ||
    !isValidWorkloadValue(runtime.proAttachmentBytes)
  ) {
    throw new BrowserAutomationError(
      "Oracle found a Pro turn receipt without complete workload metadata.",
      { stage: "response-timing", code: "pro-workload-receipt-missing", runtime },
    );
  }
  if (
    typeof runtime.proDispatchAt !== "string" ||
    !Number.isFinite(Date.parse(runtime.proDispatchAt))
  ) {
    throw new BrowserAutomationError(
      "Oracle found a Pro turn receipt without a valid dispatch timestamp.",
      { stage: "response-timing", code: "dispatch-timestamp-missing", runtime },
    );
  }
  if (!isValidNonNegativeNumber(runtime.proResponseElapsedMs)) {
    throwIndeterminateProTiming(runtime);
  }
  assertProResponseTimingReceiptChain(runtime);
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
    promptSha256: runtime.proPromptSha256 as string,
    committedUserTurnIndex: runtime.proCommittedTurnIndex as number,
    commitVerification: "verified",
  };
  const receipts = runtime.proResponseTimingReceipts ?? [];
  const existing = receipts[receipt.turnIndex];
  if (existing) {
    if (!receiptHasAnyCommitIdentity(existing)) {
      return {
        ...runtime,
        proResponseTimingProvenance: "legacy-partial",
      };
    }
    if (
      !isVerifiedProResponseTimingReceipt(existing) ||
      existing.dispatchAt !== receipt.dispatchAt ||
      existing.responseElapsedMs !== receipt.responseElapsedMs ||
      existing.inputTokens !== receipt.inputTokens ||
      existing.attachmentBytes !== receipt.attachmentBytes ||
      existing.promptSha256 !== receipt.promptSha256 ||
      existing.committedUserTurnIndex !== receipt.committedUserTurnIndex
    ) {
      throwInvalidReceiptChain(
        "Oracle refused to overwrite conflicting historical Pro response evidence.",
        runtime,
        "pro-turn-identity-mismatch",
        { receiptTurnIndex: receipt.turnIndex },
      );
    }
    return {
      ...runtime,
      proResponseTimingProvenance: assertProResponseTimingReceiptChain(runtime),
    };
  }
  if (receipt.turnIndex !== receipts.length) {
    throwInvalidReceiptChain(
      "Oracle refused to append a Pro response receipt that skipped the completed chain.",
      runtime,
      "pro-workload-receipt-invalid",
      { receiptTurnIndex: receipt.turnIndex, expectedTurnIndex: receipts.length },
    );
  }
  const nextReceipts = [...receipts, receipt];
  return {
    ...runtime,
    proResponseTimingReceipts: nextReceipts,
    proResponseTimingProvenance: nextReceipts.some(
      (entry) => !isVerifiedProResponseTimingReceipt(entry),
    )
      ? "legacy-partial"
      : "verified",
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
  assertCompleteProResponseTimingReceipt(timedRuntime);
  assertProResponseTimingAdmission({
    answer: args.answer,
    runtime: timedRuntime,
    inputTokens: timedRuntime.proInputTokens,
    attachmentBytes: timedRuntime.proAttachmentBytes,
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
  assertCompleteProResponseTimingReceipt(timedRuntime);
  assertProResponseTimingAdmission({
    answer: args.answer,
    runtime: timedRuntime,
    inputTokens: timedRuntime.proInputTokens,
    attachmentBytes: timedRuntime.proAttachmentBytes,
  });
  return hasProResponseTimingReceiptMarker(timedRuntime)
    ? appendProResponseTimingReceipt(timedRuntime)
    : timedRuntime;
}
