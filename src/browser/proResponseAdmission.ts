import { createHash } from "node:crypto";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { BrowserAutomationConfig } from "./types.js";

export const MIN_TRUSTED_PRO_RESPONSE_MS = 60_000;

type ProResponseAdmissionConfig = Pick<
  BrowserAutomationConfig,
  "desiredModel" | "modelStrategy" | "thinkingTime"
>;

export function requiresProResponseAdmission(config: ProResponseAdmissionConfig): boolean {
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

export function assertTrustedProResponse(
  answer: string,
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
      "Browser transport returned an answer without the dispatch timestamp required by Oracle's Pro response-quality gate.",
      {
        stage: "model-quality-gate",
        code: "dispatch-timestamp-missing",
        runtime: enrichedRuntime,
      },
    );
  }
  if (responseElapsedMs >= MIN_TRUSTED_PRO_RESPONSE_MS) return enrichedRuntime;

  const seconds = Math.max(0, Math.round(responseElapsedMs / 1000));
  throw new BrowserAutomationError(
    `Oracle rejected an assistant reply captured ${seconds}s after dispatch because sub-minute replies are not trusted as requested Pro output.`,
    {
      stage: "model-quality-gate",
      code: "pro-fast-response-untrusted",
      runtime: enrichedRuntime,
      responseElapsedMs,
      thresholdMs: MIN_TRUSTED_PRO_RESPONSE_MS,
      assistantSha256: createHash("sha256").update(answer).digest("hex"),
    },
  );
}
