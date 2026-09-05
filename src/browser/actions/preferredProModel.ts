import type { ChromeClient, BrowserLogger, BrowserModelStrategy } from "../types.js";
import type { BrowserModelSelectionEvidence } from "../../sessionStore.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { ensureModelSelection } from "./modelSelection.js";
import { ensureThinkingTime } from "./thinkingTime.js";

// Called only on the pre-Send model-selection path. Recovery never enters here.
export async function ensurePreferredProModel(
  runtime: ChromeClient["Runtime"],
  desiredModel: string,
  logger: BrowserLogger,
  strategy: BrowserModelStrategy,
  thinkingTime?: ThinkingTimeLevel | null,
): Promise<BrowserModelSelectionEvidence> {
  if (desiredModel !== "GPT-6" || strategy !== "select" || thinkingTime !== "pro") {
    return ensureModelSelection(runtime, desiredModel, logger, strategy);
  }
  const selectPro = async (model: string) => {
    const evidence = await ensureModelSelection(runtime, model, logger, strategy);
    if (!evidence.verified) {
      throw new Error("Pro model family could not be verified before Send.");
    }
    await ensureThinkingTime(runtime, "pro", logger, model, evidence);
    return { ...evidence, selectedModel: model };
  };
  try {
    return await selectPro("GPT-6");
  } catch (error) {
    if (
      !(error instanceof BrowserAutomationError) ||
      error.details?.promptSubmitted !== false ||
      !["model-option-unavailable", "pro-effort-unavailable"].includes(String(error.details?.code))
    ) {
      throw error;
    }
    const fallbackReason = String(error.details?.code);
    logger(
      `[browser] GPT-6 Pro unavailable before Send (${fallbackReason}); selecting GPT-5.6 Sol Pro.`,
    );
    const fallback = await selectPro("GPT-5.6 Sol");
    return { ...fallback, requestedModel: "GPT-6", fallbackReason };
  }
}
