import { createHash } from "node:crypto";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { BrowserAutomationConfig } from "./types.js";

type ProResponseTimingConfig = Pick<
  BrowserAutomationConfig,
  "desiredModel" | "modelStrategy" | "thinkingTime"
>;

export const MAX_TINY_PRO_INPUT_TOKENS = 256;
export const MAX_TINY_PRO_ATTACHMENT_BYTES = 16 * 1024;
export const MIN_SUBSTANTIVE_PRO_RESPONSE_MS = 60_000;

export function requiresProResponseTiming(config: ProResponseTimingConfig): boolean {
  if (config.modelStrategy === "ignore") return false;
  return normalizeThinkingTimeLevel(config.thinkingTime) === "pro";
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

export function recordProResponseTiming(
  runtime: BrowserRuntimeMetadata,
  capturedAt: Date,
  options: { requireTimestamp?: boolean } = {},
): BrowserRuntimeMetadata {
  const dispatchAt = runtime.proDispatchAt ?? runtime.opencliDispatchAt;
  const responseElapsedMs =
    runtime.proResponseElapsedMs ??
    runtime.opencliResponseElapsedMs ??
    elapsedSinceDispatch(dispatchAt, capturedAt);
  const enrichedRuntime: BrowserRuntimeMetadata = {
    ...runtime,
    proDispatchAt: dispatchAt,
    proResponseElapsedMs: responseElapsedMs,
  };

  if (responseElapsedMs === undefined) {
    if (!options.requireTimestamp) return enrichedRuntime;
    throw new BrowserAutomationError(
      "Browser transport returned an answer without the dispatch timestamp required for durable Pro response timing.",
      {
        stage: "response-timing",
        code: "dispatch-timestamp-missing",
        runtime: enrichedRuntime,
      },
    );
  }
  return enrichedRuntime;
}

export function assertProResponseWorkloadTiming(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  inputTokens: number;
  attachmentBytes?: number;
}): void {
  const responseElapsedMs =
    args.runtime.proResponseElapsedMs ?? args.runtime.opencliResponseElapsedMs;
  const attachmentBytes = args.attachmentBytes ?? 0;
  if (
    (args.inputTokens <= MAX_TINY_PRO_INPUT_TOKENS &&
      attachmentBytes <= MAX_TINY_PRO_ATTACHMENT_BYTES) ||
    responseElapsedMs === undefined ||
    responseElapsedMs >= MIN_SUBSTANTIVE_PRO_RESPONSE_MS
  ) {
    return;
  }

  const seconds = Math.max(0, Math.round(responseElapsedMs / 1000));
  throw new BrowserAutomationError(
    `Oracle rejected a substantive Pro reply captured ${seconds}s after dispatch because the workload completed implausibly quickly.`,
    {
      stage: "response-timing",
      code: "pro-fast-substantive-response-untrusted",
      runtime: args.runtime,
      responseElapsedMs,
      thresholdMs: MIN_SUBSTANTIVE_PRO_RESPONSE_MS,
      inputTokens: args.inputTokens,
      attachmentBytes,
      tinyInputTokenLimit: MAX_TINY_PRO_INPUT_TOKENS,
      tinyAttachmentByteLimit: MAX_TINY_PRO_ATTACHMENT_BYTES,
      assistantSha256: createHash("sha256").update(args.answer).digest("hex"),
    },
  );
}

export function verifyStoredProResponseWorkloadTiming(args: {
  answer: string;
  runtime: BrowserRuntimeMetadata;
  capturedAt: Date;
}): BrowserRuntimeMetadata {
  const hasProTimingReceipt =
    args.runtime.proDispatchAt !== undefined ||
    args.runtime.proResponseElapsedMs !== undefined ||
    args.runtime.opencliDispatchAt !== undefined ||
    args.runtime.opencliResponseElapsedMs !== undefined;
  if (!hasProTimingReceipt) return args.runtime;

  const timedRuntime = recordProResponseTiming(args.runtime, args.capturedAt);
  assertProResponseWorkloadTiming({
    answer: args.answer,
    runtime: timedRuntime,
    inputTokens: timedRuntime.proInputTokens ?? 0,
    attachmentBytes: timedRuntime.proAttachmentBytes ?? 0,
  });
  return timedRuntime;
}
